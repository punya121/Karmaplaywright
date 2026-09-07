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
 * Playwright reporter that produces the module-wise reports:
 *
 *   reports/test-results.json            enriched JSON (module, status, timings, errors)
 *   reports/Test-Execution-Report.xlsx   Summary + Test Details workbook
 *
 * It runs alongside the built-in `html` reporter, so `npx playwright show-report`
 * keeps working exactly as before.
 *
 * If anything in here fails, the error is printed and the test run's own result is
 * left untouched — a broken report never fails a green suite.
 */

interface ReporterOptions {
    /** Where the enriched JSON goes. Default: reports/test-results.json */
    jsonFile?: string;
    /** Where the workbook goes. Default: reports/Test-Execution-Report.xlsx */
    excelFile?: string;
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
    private readonly jsonFile: string;
    private readonly excelFile: string;

    /** Latest result per test id, so retries collapse into one row. */
    private readonly rows = new Map<string, TestRow>();

    private startedAt = new Date();
    private testRootDir = process.cwd();
    private baseURL = '';

    constructor(options: ReporterOptions = {}) {
        const reportsDir = path.resolve(process.cwd(), 'reports');
        this.jsonFile = path.resolve(options.jsonFile ?? path.join(reportsDir, 'test-results.json'));
        this.excelFile = path.resolve(
            options.excelFile ?? path.join(reportsDir, 'Test-Execution-Report.xlsx'),
        );
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

            console.log('');
            console.log('  Module-wise reports');
            console.log(`    JSON  : ${this.jsonFile}`);
            console.log(`    Excel : ${this.excelFile}`);
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
