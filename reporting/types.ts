/** Shapes shared by the reporter, the JSON file and the Excel writer. */

/**
 * Raw Playwright outcome, kept as-is so nothing is lost in the JSON.
 *
 * `notExecuted` is the one status Playwright never produces: it belongs to a module
 * case a journey declared but never reached, because an earlier one failed. Those
 * are reported rather than dropped, so the row count of a report does not shrink on
 * the runs that went worst.
 */
export type RawStatus =
    | 'passed'
    | 'failed'
    | 'timedOut'
    | 'skipped'
    | 'interrupted'
    | 'notExecuted';

/** What the Summary sheet counts. Timed out / interrupted roll up into "Failed". */
export type SummaryStatus = 'Passed' | 'Failed' | 'Skipped';

export interface TestRow {
    module: string;
    /**
     * The test case name. For a module case this is what that stage does ("Record
     * the vitals and allergies"); for a plain test it is the describe titles plus
     * the test title.
     */
    testCase: string;
    /** Just the `test()` title. */
    testTitle: string;
    /**
     * The journey this row came out of, when the row is one module case of a longer
     * test — e.g. 'Full consultation: register, consent, case history, doctor'.
     * Empty when the row is the whole test.
     */
    scenario: string;
    /** True when this row is one module case rather than a whole Playwright test. */
    isModuleCase: boolean;
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
