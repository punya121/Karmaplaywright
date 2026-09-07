import fs from 'fs';
import path from 'path';
import type {
    FullConfig,
    FullResult,
    Reporter,
    Suite,
    TestCase,
    TestResult,
} from '@playwright/test/reporter';
import { resolveModule, resolveTestCaseName } from './module-resolver';
import { HISTORY_FILE, RUN_DIR, RUN_ID, relativeToCwd, runPath } from './run-context';
import { writeExcelReport } from './excel-writer';
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
};

/** Timed out and interrupted count as failures on the Summary sheet. */
function toSummaryStatus(status: RawStatus): SummaryStatus {
    if (status === 'passed') return 'Passed';
    if (status === 'skipped') return 'Skipped';
    return 'Failed';
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

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

    /** Latest result per test id, so retries collapse into one row. */
    private readonly rows = new Map<string, TestRow>();

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
            const rawStatus = result.status as RawStatus;
            const previous = this.rows.get(test.id);

            this.rows.set(test.id, {
                module: resolveModule(test, this.testRootDir),
                testCase: resolveTestCaseName(test),
                testTitle: test.title,
                status: STATUS_LABEL[rawStatus] ?? rawStatus,
                rawStatus,
                summaryStatus: toSummaryStatus(rawStatus),
                durationMs: result.duration,
                testFile: path.basename(test.location.file),
                testFilePath: path
                    .relative(process.cwd(), test.location.file)
                    .split(path.sep)
                    .join('/'),
                project: test.parent.project()?.name ?? '',
                errorMessage: cleanError(result),
                startTime: result.startTime.toISOString(),
                retry: result.retry,
                attempts: (previous?.attempts ?? 0) + 1,
            });
        } catch (error) {
            console.error('[module-report] Could not record a test result:', error);
        }
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
        const tests = [...this.rows.values()].sort(
            (a, b) => a.module.localeCompare(b.module) || a.testCase.localeCompare(b.testCase),
        );

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
