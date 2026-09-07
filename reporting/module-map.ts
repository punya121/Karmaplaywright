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
