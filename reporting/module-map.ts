/**
 * Module naming for the Excel report.
 *
 * ---------------------------------------------------------------------------
 * QA NOTE — adding a new module
 * ---------------------------------------------------------------------------
 * You normally do NOT need to touch this file. A new folder under `tests/`
 * automatically becomes a new module:
 *
 *     tests/appointment/create-appointment.spec.ts   ->  "Appointment"
 *     tests/prescription/refill.spec.ts              ->  "Prescription"
 *     tests/lab-reports/upload.spec.ts               ->  "Lab Reports"
 *
 * Only add an entry below when the folder name and the name you want to see in
 * the report differ (for example `auth/` should read as "Login").
 * ---------------------------------------------------------------------------
 */

/** Folder name (lower case, as it appears under `tests/`) -> module name in the report. */
export const FOLDER_TO_MODULE: Record<string, string> = {
    auth: 'Login',
    login: 'Login',
    patient: 'Patient',
    appointment: 'Appointment',
    prescription: 'Prescription',
    reports: 'Reports',
};

/** Used when a test file sits directly in `tests/` with no module folder around it. */
export const UNCATEGORISED_MODULE = 'General';

/**
 * ---------------------------------------------------------------------------
 * QA NOTE — one report row per module, inside a long journey
 * ---------------------------------------------------------------------------
 * A journey spec ("register a patient, consent, case history, hand to a doctor")
 * is one Playwright test, and on its own it would be one line in the report — so
 * a run that got as far as the doctor would say nothing about registration.
 *
 * tests/support/module-case.ts splits that up: each stage runs as a Playwright
 * step titled `<Module> :: <what it does>`, and the reporter turns every one of
 * those into its own row — its own module, status, duration and error. The
 * separator below is the whole of that contract, so keep the two sides in step.
 * ---------------------------------------------------------------------------
 */

/** Divides the module name from the case title inside a module-case step. */
export const MODULE_CASE_SEPARATOR = ' :: ';

/**
 * Annotation a journey uses to declare its stages up front, so the modules a
 * failure stopped from ever running are still reported — as "Not Executed"
 * rather than as silence. Its description is the JSON list of those stages.
 */
export const MODULE_PLAN_ANNOTATION = 'module-plan';
