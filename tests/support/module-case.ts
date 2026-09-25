import { test } from '@playwright/test';
import { MODULE_CASE_SEPARATOR, MODULE_PLAN_ANNOTATION } from '../../reporting/module-map';

/**
 * Module cases — how one long journey becomes many test cases in the report.
 *
 * A journey spec is a single Playwright test on purpose: registration, consent,
 * case history and the handover to a doctor all have to happen in one session,
 * against one patient, in order. Reported as a single test it tells a QA reader
 * almost nothing — "Full consultation: failed" says neither how far it got nor
 * which screen broke.
 *
 * So each stage of the journey runs inside `moduleCase()`, which is a Playwright
 * step titled `<Module> :: <what the stage does>`. The module reporter turns every
 * one of those into its own row in test-results.json and in the Excel workbook,
 * with its own module, status, duration and error — so the workbook reads
 *
 *     Patient Registration | Register a new patient and save | Passed  | 21.4 sec
 *     Consent Form         | Assign a consent form           | Passed  |  6.1 sec
 *     Case History         | Record the vitals               | Failed  |  4.8 sec
 *     Doctor Selection     | Hand the visit to a doctor      | Not Executed
 *
 * while the run itself is still the one uninterrupted session it has to be.
 *
 * Two rules the reporter follows, both of which matter when writing a stage:
 *
 *   - Only the innermost module case becomes a row. A stage that calls a page
 *     object which opens module cases of its own (PrescriptionFormPage.fill()
 *     does) is reported as those finer rows instead of as itself, so nothing is
 *     counted twice.
 *   - Stages a failure stopped from running are reported as "Not Executed",
 *     which is what runModuleCases() declares the list up front for.
 */
export type ModuleCase = {
    /** The application module this stage exercises, e.g. 'Patient Registration'. */
    module: string;
    /** What this stage does, as the report's test case name. */
    title: string;
    /** The stage itself. */
    run: () => Promise<void>;
};

/** The step title the reporter parses back into a module and a case name. */
export function moduleCaseTitle(module: string, title: string): string {
    return `${module}${MODULE_CASE_SEPARATOR}${title}`;
}

/**
 * Runs one stage as its own reported test case. Returns whatever the stage
 * returns, so it can be used inline around a step that produces a value:
 *
 *     const registered = await moduleCase('Patient Search', 'Read back the id',
 *         () => searchPage.identifyPatient(patient));
 */
export async function moduleCase<T>(
    module: string,
    title: string,
    body: () => Promise<T>,
): Promise<T> {
    return test.step(moduleCaseTitle(module, title), body);
}

export type RunModuleCasesOptions = {
    /**
     * Keep going after a stage fails, instead of stopping the journey there.
     *
     * Off by default, which is what a journey wants: a consultation whose
     * registration failed has no patient for the case history to be about, so
     * every stage after it would fail for a reason that is not its own.
     *
     * A sweep is the opposite. Its stages are independent screens, and a run
     * that stopped at the first broken one would report that screen and say
     * nothing about the twelve behind it — one bug per run, when the whole
     * point is to find them all in one pass. A stage that throws is still
     * reported as Failed (the step carries its own error whether or not the
     * caller catches it), so the report is the same either way; only the stages
     * after it differ, and they run.
     */
    continueOnFailure?: boolean;
};

/**
 * Runs a journey's stages in order and declares the whole list before the first
 * one starts, so a stage that never ran is still reported. The declaration is an
 * annotation rather than anything clever, because it has to survive the test that
 * fails half way through it.
 *
 * Returns the errors it swallowed, which is empty unless `continueOnFailure` is
 * on. The caller decides what to do with them — a sweep fails at the end with all
 * of them named, rather than at the first one.
 */
export async function runModuleCases(
    cases: ModuleCase[],
    options: RunModuleCasesOptions = {},
): Promise<Error[]> {
    test.info().annotations.push({
        type: MODULE_PLAN_ANNOTATION,
        description: JSON.stringify(
            cases.map(({ module, title }) => ({ module, title })),
        ),
    });

    const failures: Error[] = [];

    for (const { module, title, run } of cases) {
        if (!options.continueOnFailure) {
            await moduleCase(module, title, run);
            continue;
        }

        try {
            await moduleCase(module, title, run);
        } catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error));
            failure.message = `${module} :: ${title}
${failure.message}`;
            failures.push(failure);
        }
    }

    return failures;
}
