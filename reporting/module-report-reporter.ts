import fs from 'fs';
import path from 'path';
import type {
    FullConfig,
    FullResult,
    Reporter,
    Suite,
    TestCase,
    TestResult,
    TestStep,
} from '@playwright/test/reporter';
import { MODULE_CASE_SEPARATOR, MODULE_PLAN_ANNOTATION } from './module-map';
import { resolveModule, resolveTestCaseName } from './module-resolver';
import { HISTORY_FILE, RUN_DIR, RUN_ID, relativeToCwd, runPath } from './run-context';
import { writeExcelReport } from './excel-writer';
import { sendExcelReportEmail } from './send-report-email';
import type {
    ModuleSummary,
    RawStatus,
    ReportPayload,
    RunTotals,
    SummaryStatus,
    TestRow,
} from './types';

/**
 * Playwright reporter that produces the module-wise reports for one run:
 *
 *   reports/runs/<run id>/test-results.json            enriched JSON (module, status, timings, errors)
 *   reports/runs/<run id>/Test-Execution-Report.xlsx   Summary + Test Details workbook
 *
 * Nothing is overwritten between runs — every run gets its own folder (see
 * run-context.ts) and every run is also appended to reports/runs/history.json,
 * so the full execution history is kept on disk. The built-in `html` reporter
 * writes its report into the same folder; `npm run report` opens the newest one.
 *
 * A journey spec reports as many rows, not one. Registration, consent, case history
 * and the handover to a doctor have to happen in one session against one patient, so
 * they are one Playwright test — but each stage runs inside a module case (see
 * tests/support/module-case.ts), and every module case becomes its own row here with
 * its own module, status, duration and error. Stages the journey declared but a
 * failure stopped from running are reported as "Not Executed" rather than dropped.
 * A test with no module cases in it is still one row, exactly as before.
 *
 * If anything in here fails, the error is printed and the test run's own result is
 * left untouched — a broken report never fails a green suite.
 */

interface ReporterOptions {
    /** Identifies the run folder. Default: the shared RUN_ID from run-context. */
    runId?: string;
    /** Where the enriched JSON goes. Default: <run folder>/test-results.json */
    jsonFile?: string;
    /** Where the workbook goes. Default: <run folder>/Test-Execution-Report.xlsx */
    excelFile?: string;
}

/** One line per run in reports/runs/history.json. */
interface HistoryEntry {
    runId: string;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    baseURL: string;
    playwrightStatus: string;
    totals: RunTotals;
    folder: string;
}

const STATUS_LABEL: Record<RawStatus, string> = {
    passed: 'Passed',
    failed: 'Failed',
    timedOut: 'Timed Out',
    skipped: 'Skipped',
    interrupted: 'Interrupted',
    notExecuted: 'Not Executed',
};

/**
 * Timed out and interrupted count as failures on the Summary sheet. A module case
 * that was never reached counts with the skipped: it did not fail, it never ran, and
 * folding it into the failures would report one broken step as several.
 */
function toSummaryStatus(status: RawStatus): SummaryStatus {
    if (status === 'passed') return 'Passed';
    if (status === 'skipped' || status === 'notExecuted') return 'Skipped';
    return 'Failed';
}

/** One stage of a journey, as declared up front by runModuleCases(). */
interface PlannedCase {
    module: string;
    title: string;
}

/**
 * A module case that actually ran, with any module cases nested inside it — a page
 * object is free to open finer ones of its own, and those are what get reported.
 */
interface ExecutedCase {
    title: string;
    step: TestStep;
    children: ExecutedCase[];
}

/** The step title a planned case was given when it ran. */
function moduleCaseTitle(planned: PlannedCase): string {
    return `${planned.module}${MODULE_CASE_SEPARATOR}${planned.title}`;
}

/** Splits `Patient Registration :: Register a new patient` into its two halves. */
function splitModuleCaseTitle(title: string): PlannedCase | undefined {
    const at = title.indexOf(MODULE_CASE_SEPARATOR);

    if (at <= 0) return undefined;

    const module = title.slice(0, at).trim();
    const caseTitle = title.slice(at + MODULE_CASE_SEPARATOR.length).trim();

    return module && caseTitle ? { module, title: caseTitle } : undefined;
}

/**
 * The module cases in a step tree, outermost first, each carrying the ones nested
 * inside it. Steps that are not module cases — expects, hooks, page object internals
 * — are walked through rather than reported.
 */
function collectModuleCases(steps: readonly TestStep[]): ExecutedCase[] {
    const found: ExecutedCase[] = [];

    for (const step of steps) {
        const parsed = splitModuleCaseTitle(step.title);

        if (parsed) {
            found.push({
                title: step.title,
                step,
                children: collectModuleCases(step.steps ?? []),
            });
        } else {
            found.push(...collectModuleCases(step.steps ?? []));
        }
    }

    return found;
}

/** What a journey declared before it started, empty when it declared nothing. */
function plannedCases(test: TestCase, result: TestResult): PlannedCase[] {
    const annotations = [...(result.annotations ?? []), ...test.annotations];
    const plan = annotations.find((a) => a.type === MODULE_PLAN_ANNOTATION)?.description;

    if (!plan) return [];

    try {
        const parsed: unknown = JSON.parse(plan);
        if (!Array.isArray(parsed)) return [];

        return parsed
            .filter((entry): entry is PlannedCase => {
                const candidate = entry as PlannedCase;
                return !!candidate?.module && !!candidate?.title;
            })
            .map(({ module, title }) => ({ module, title }));
    } catch {
        console.warn('[module-report] A module plan could not be read — ignoring it.');
        return [];
    }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * The reason one module case failed, which is the step's own error rather than the
 * whole test's - a journey reports several rows and each has to carry its own.
 */
function cleanStepError(step: TestStep): string {
    const message = step.error?.message ?? (step.error ? String(step.error) : '');
    const text = message.replace(ANSI, '').trim();

    return text.length > 3000 ? `${text.slice(0, 3000)} ... (truncated, see HTML report)` : text;
}

function cleanError(result: TestResult): string {
    const messages = (result.errors ?? [])
        .map((error) => error.message ?? String(error))
        .filter(Boolean);

    if (messages.length === 0 && result.error?.message) messages.push(result.error.message);

    const text = messages.join('\n---\n').replace(ANSI, '').trim();

    // Excel caps a cell at 32767 characters; a stack trace that long helps nobody anyway.
    return text.length > 3000 ? `${text.slice(0, 3000)}\n... (truncated, see HTML report)` : text;
}

export default class ModuleReportReporter implements Reporter {
    private readonly runId: string;
    private readonly runDir: string;
    private readonly jsonFile: string;
    private readonly excelFile: string;

    /**
     * Latest rows per test id, so retries collapse into one set. A test contributes
     * one row, or one row per module case when it is a journey made of them.
     */
    private readonly rows = new Map<string, TestRow[]>();

    /** Attempts recorded per test id, retries included. */
    private readonly attemptsById = new Map<string, number>();

    private startedAt = new Date();
    private testRootDir = process.cwd();
    private baseURL = '';

    constructor(options: ReporterOptions = {}) {
        this.runId = options.runId ?? RUN_ID;
        this.runDir = RUN_DIR;
        this.jsonFile = path.resolve(options.jsonFile ?? runPath('test-results.json'));
        this.excelFile = path.resolve(options.excelFile ?? runPath('Test-Execution-Report.xlsx'));
    }

    /** Keeps the run summary Playwright prints at the end intact. */
    printsToStdout(): boolean {
        return false;
    }

    onBegin(config: FullConfig, suite: Suite): void {
        this.startedAt = new Date();
        this.testRootDir = config.rootDir;

        const firstProject = config.projects[0];
        this.baseURL = String((firstProject?.use as { baseURL?: string })?.baseURL ?? '-');

        // Nudge the resolver towards the project's testDir when it differs from rootDir.
        const testDir = suite.suites[0]?.project()?.testDir;
        if (testDir) this.testRootDir = testDir;
    }

    onTestEnd(test: TestCase, result: TestResult): void {
        try {
            const attempts = (this.attemptsById.get(test.id) ?? 0) + 1;
            this.attemptsById.set(test.id, attempts);

            this.rows.set(test.id, this.buildRows(test, result, attempts));
        } catch (error) {
            console.error('[module-report] Could not record a test result:', error);
        }
    }

    /**
     * The report rows one finished test produces.
     *
     * A test with no module cases in it is one row, the way every test used to be.
     * A journey that declared its stages is one row per stage: the ones that ran
     * carry their own module, status, duration and error, and the ones an earlier
     * failure stopped from running are reported as "Not Executed" rather than
     * vanishing - so the same suite always reports the same set of test cases, and a
     * run that broke at the case history still says that registration passed.
     */
    private buildRows(test: TestCase, result: TestResult, attempts: number): TestRow[] {
        const rawStatus = result.status as RawStatus;
        const scenario = resolveTestCaseName(test);

        const shared = {
            testTitle: test.title,
            testFile: path.basename(test.location.file),
            testFilePath: path
                .relative(process.cwd(), test.location.file)
                .split(path.sep)
                .join('/'),
            project: test.parent.project()?.name ?? '',
            retry: result.retry,
            attempts,
        };

        const wholeTest: TestRow = {
            ...shared,
            module: resolveModule(test, this.testRootDir),
            testCase: scenario,
            scenario: '',
            isModuleCase: false,
            status: STATUS_LABEL[rawStatus] ?? rawStatus,
            rawStatus,
            summaryStatus: toSummaryStatus(rawStatus),
            durationMs: result.duration,
            errorMessage: cleanError(result),
            startTime: result.startTime.toISOString(),
        };

        const plan = plannedCases(test, result);
        const executed = collectModuleCases(result.steps ?? []);

        // Nothing was split into modules - an ordinary test, reported as it always was.
        if (plan.length === 0 && executed.length === 0) return [wholeTest];

        const moduleRow = (entry: PlannedCase, step?: TestStep): TestRow => {
            const status: RawStatus = !step ? 'notExecuted' : step.error ? 'failed' : 'passed';

            return {
                ...shared,
                module: entry.module,
                testCase: entry.title,
                scenario,
                isModuleCase: true,
                status: STATUS_LABEL[status],
                rawStatus: status,
                summaryStatus: toSummaryStatus(status),
                durationMs: step && step.duration > 0 ? step.duration : 0,
                errorMessage: step ? cleanStepError(step) : '',
                startTime: step ? step.startTime.toISOString() : '',
            };
        };

        const rows: TestRow[] = [];

        // Only the innermost module case is reported, so a stage whose page object
        // opens finer ones of its own is counted once, as those. A stage that failed
        // on its own account - outside every case nested in it - still has to say so,
        // so it is added after them rather than dropped.
        const emit = (entry: ExecutedCase): void => {
            const parsed = splitModuleCaseTitle(entry.title);

            if (!parsed) return;

            if (entry.children.length === 0) {
                rows.push(moduleRow(parsed, entry.step));
                return;
            }

            entry.children.forEach(emit);

            const blamed = entry.children.some((child) => child.step.error);
            if (entry.step.error && !blamed) rows.push(moduleRow(parsed, entry.step));
        };

        // A run stops at its first failure, so what executed is a prefix of what was
        // planned: pair them off in order, and anything a journey ran without having
        // declared it - or ran without declaring anything at all - follows on the end.
        plan.forEach((planned, index) => {
            const entry = executed[index];

            if (entry && entry.title === moduleCaseTitle(planned)) emit(entry);
            else rows.push(moduleRow(planned));
        });

        executed.slice(plan.length).forEach(emit);

        // A test can also fail where no module case was running - a hook, a teardown,
        // a timeout that landed between stages. Nothing above would carry that error,
        // so the test's own row is kept alongside the module rows to hold it.
        const blamedOnAModule = rows.some((row) => row.summaryStatus === 'Failed');
        if (!blamedOnAModule && toSummaryStatus(rawStatus) === 'Failed') rows.push(wholeTest);

        return rows.length > 0 ? rows : [wholeTest];
    }

    async onEnd(result: FullResult): Promise<void> {
        try {
            const payload = this.buildPayload(result);

            fs.mkdirSync(path.dirname(this.jsonFile), { recursive: true });
            fs.writeFileSync(this.jsonFile, JSON.stringify(payload, null, 2), 'utf8');

            await writeExcelReport(payload, this.excelFile);
            this.appendToHistory(payload);

            console.log('');
            console.log(`  Module-wise reports (run ${this.runId})`);
            console.log(`    Folder: ${relativeToCwd(this.runDir)}`);
            console.log(`    JSON  : ${relativeToCwd(this.jsonFile)}`);
            console.log(`    Excel : ${relativeToCwd(this.excelFile)}`);
            console.log(`    HTML  : npm run report   (opens this run)`);

            try {
                await sendExcelReportEmail(payload, this.excelFile);
            } catch (error) {
                console.error(
                    '[report-email] Could not send the Excel report:',
                    error instanceof Error ? error.message : error,
                );
            }

            console.log('');
        } catch (error) {
            // Reporting problems must never turn a green run red — just say so loudly.
            console.error('');
            console.error('  ==============================================================');
            console.error('   MODULE REPORT FAILED — test results themselves are unaffected');
            console.error('  ==============================================================');
            console.error(error instanceof Error ? (error.stack ?? error.message) : error);
            console.error('');
        }
    }

    /**
     * Appends this run to reports/runs/history.json — the index of every run kept
     * on disk. A corrupt or hand-edited file is replaced rather than fatal, since
     * the run's own reports are already written by this point.
     */
    private appendToHistory(payload: ReportPayload): void {
        const entry: HistoryEntry = {
            runId: this.runId,
            startedAt: payload.startedAt,
            finishedAt: payload.generatedAt,
            durationMs: payload.durationMs,
            baseURL: payload.baseURL,
            playwrightStatus: payload.playwrightStatus,
            totals: payload.totals,
            folder: relativeToCwd(this.runDir),
        };

        let history: HistoryEntry[] = [];
        try {
            if (fs.existsSync(HISTORY_FILE)) {
                const parsed: unknown = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
                if (Array.isArray(parsed)) history = parsed as HistoryEntry[];
            }
        } catch {
            console.warn('[module-report] history.json was unreadable — starting a fresh one.');
        }

        // A re-run under the same E2E_RUN_ID replaces its own entry, never another's.
        history = history.filter((run) => run?.runId !== entry.runId);
        history.push(entry);
        history.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));

        fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
    }

    private buildPayload(result: FullResult): ReportPayload {
        // Kept in the order the run produced them, each test's module cases together
        // and in the order they were meant to happen. Sorting by module name instead
        // would shuffle a journey's stages out of the sequence that explains them -
        // and the Summary sheet groups by module anyway.
        const tests = [...this.rows.values()]
            .sort((a, b) => String(a[0]?.startTime).localeCompare(String(b[0]?.startTime)))
            .flat();

        const byModule = new Map<string, ModuleSummary>();

        for (const test of tests) {
            const summary = byModule.get(test.module) ?? {
                module: test.module,
                total: 0,
                passed: 0,
                failed: 0,
                skipped: 0,
                passRate: 0,
            };

            summary.total += 1;
            if (test.summaryStatus === 'Passed') summary.passed += 1;
            else if (test.summaryStatus === 'Failed') summary.failed += 1;
            else summary.skipped += 1;

            byModule.set(test.module, summary);
        }

        const modules = [...byModule.values()]
            .map((summary) => ({
                ...summary,
                // Skipped tests were never executed, so they are left out of the rate.
                passRate: summary.total ? summary.passed / summary.total : 0,
            }))
            .sort((a, b) => a.module.localeCompare(b.module));

        const totals: RunTotals = {
            total: tests.length,
            passed: tests.filter((t) => t.summaryStatus === 'Passed').length,
            failed: tests.filter((t) => t.summaryStatus === 'Failed').length,
            skipped: tests.filter((t) => t.summaryStatus === 'Skipped').length,
            passRate: 0,
        };
        totals.passRate = totals.total ? totals.passed / totals.total : 0;

        return {
            runId: this.runId,
            generatedAt: new Date().toISOString(),
            startedAt: this.startedAt.toISOString(),
            durationMs: Date.now() - this.startedAt.getTime(),
            baseURL: this.baseURL,
            playwrightStatus: result.status,
            totals,
            modules,
            tests,
        };
    }
}
