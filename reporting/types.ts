/** Shapes shared by the reporter, the JSON file and the Excel writer. */

/** Raw Playwright outcome, kept as-is so nothing is lost in the JSON. */
export type RawStatus = 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';

/** What the Summary sheet counts. Timed out / interrupted roll up into "Failed". */
export type SummaryStatus = 'Passed' | 'Failed' | 'Skipped';

export interface TestRow {
    module: string;
    /** Describe titles + test title. */
    testCase: string;
    /** Just the `test()` title. */
    testTitle: string;
    /** Raw Playwright status, prettified: Passed / Failed / Timed Out / Skipped / Interrupted. */
    status: string;
    rawStatus: RawStatus;
    /** How the Summary sheet buckets this row. */
    summaryStatus: SummaryStatus;
    durationMs: number;
    /** Spec file name, e.g. `create-patient.spec.ts`. */
    testFile: string;
    /** Spec path relative to the project root, e.g. `tests/patient/create-patient.spec.ts`. */
    testFilePath: string;
    project: string;
    errorMessage: string;
    /** ISO timestamp of when the test started. */
    startTime: string;
    /** 0 = first attempt. */
    retry: number;
    /** Total attempts recorded for this test. */
    attempts: number;
}

export interface ModuleSummary {
    module: string;
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    /** 0..1, formatted as a percentage in Excel. */
    passRate: number;
}

export interface RunTotals {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    passRate: number;
}

export interface ReportPayload {
    /** Folder name of this run under reports/runs/, e.g. `2026-09-07_14-32-05`. */
    runId: string;
    generatedAt: string;
    startedAt: string;
    durationMs: number;
    baseURL: string;
    playwrightStatus: string;
    totals: RunTotals;
    modules: ModuleSummary[];
    tests: TestRow[];
}
