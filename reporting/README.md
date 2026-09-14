# Module-wise test reporting

Everything here runs automatically as part of `npx playwright test`. There is no
separate command to remember.

## What gets produced

Every run is archived in its own folder, so a new run never overwrites an older
one — the full history stays on disk:

```
reports/
└── runs/
    ├── history.json                          one entry per run (totals, duration, status)
    ├── 2026-09-07_14-32-05/
    │   ├── test-results.json                 enriched JSON (module, status, duration, error, retry)
    │   ├── Test-Execution-Report.xlsx        Summary + Test Details workbook
    │   └── playwright-report/                the standard Playwright HTML report
    └── 2026-09-07_16-04-11/
        └── ...
```

`reports/` is gitignored, so none of this is ever committed.

Open a report:

```bash
npm run report                              # newest run
npm run report -- 2026-09-07_14-32-05       # a specific run
npm run report:list                         # every run kept on disk
```

`npx playwright show-report reports/runs/<run id>/playwright-report` works too.

## Email the Excel report (Amazon SES)

After the workbook is written, the reporter can send it as an attachment through
Amazon SES. Put the keys in `.env` (never commit them):

```bash
E2E_REPORT_EMAIL_FROM=reports@your-verified-domain.com
E2E_REPORT_EMAIL_TO=qa@example.com,lead@example.com
AWS_SES_REGION=ap-south-1
AWS_SES_ACCESS_KEY_ID=...
AWS_SES_SECRET_ACCESS_KEY=...
```

`E2E_REPORT_EMAIL_FROM` must be a verified SES identity. If the account is still
in the SES sandbox, every address in `E2E_REPORT_EMAIL_TO` (and `E2E_REPORT_EMAIL_CC`)
must be verified too.

Leave From/To unset to skip mail. Set `E2E_REPORT_EMAIL=false` to skip even when
they are set. A send failure is printed in the terminal and does not fail the suite.

## Naming a run yourself

The folder name is a timestamp by default. Set `E2E_RUN_ID` to name it instead —
handy in CI, where the build number is more meaningful than the clock:

```bash
E2E_RUN_ID=build-482 npx playwright test
```

Re-running with an id that already exists overwrites just that run's folder and
replaces its entry in `history.json`; every other run is left alone.

## Housekeeping

Nothing is deleted automatically — that is the point. When the folder gets large,
delete old run folders (and their `history.json` entries) by hand, or drop the
whole `reports/runs/` folder to start fresh.

## Files

| File | What it does |
| --- | --- |
| `module-report-reporter.ts` | The Playwright reporter. Collects results, writes the JSON, calls the Excel writer, emails the workbook, appends to `history.json`. |
| `send-report-email.ts` | Sends the Excel workbook through Amazon SES. |
| `run-context.ts` | The per-run id and folder paths, shared with `playwright.config.ts`. |
| `show-latest-report.js` | Backs `npm run report` / `npm run report:list`. |
| `module-resolver.ts` | Decides which module a test belongs to. |
| `excel-writer.ts` | Builds the workbook (styling, filters, freeze panes, data bars). |
| `module-map.ts` | The only file you may ever need to edit — folder → module name overrides. |
| `types.ts` | Shared shapes. |
| `../tests/support/module-case.ts` | `runModuleCases()` / `moduleCase()` — how a journey spec reports one row per module. |

## One row per module, inside a long journey

A journey spec — `tests/patient/full-consultation.spec.ts`, `tests/doctor/doctor-consultation.spec.ts` —
has to be a single Playwright test: one session, one patient, in order. Reported as
a single test it said almost nothing, because "Full consultation: failed" names
neither how far the run got nor which screen broke.

So each stage of a journey runs as a **module case**, and the reporter gives every
one of them its own row:

| Module | Test Case | Status | Duration |
| --- | --- | --- | --- |
| Patient Registration | Register a new patient and save | Passed | 3.7 sec |
| Consent Form | Assign a consent form to that patient | Passed | 1.5 sec |
| Case History | Record the vitals and allergies | Failed | 4.8 sec |
| Doctor Selection | Hand the visit to a doctor | Not Executed | |

The Summary sheet then gives a pass rate per module, and the Test Details sheet
carries a **Scenario** column saying which journey each row came out of.

Writing one is `runModuleCases()` from `tests/support/module-case.ts`:

```ts
await runModuleCases([
    {
        module: 'Patient Registration',
        title: 'Register a new patient and save',
        run: async () => { /* ... */ },
    },
    {
        module: 'Consent Form',
        title: 'Assign a consent form to that patient',
        run: async () => { /* ... */ },
    },
]);
```

Three things follow from how the reporter reads them:

- **Declared up front.** `runModuleCases()` records the whole list before the first
  stage starts, so the modules a failure stopped from running are reported as
  **Not Executed** instead of vanishing. The same suite then reports the same set
  of test cases whether it passed or broke half way.
- **Innermost wins.** A page object may open module cases of its own —
  `CaseHistoryPage.fill()` and `PrescriptionFormPage.fill()` both do, with
  `moduleCase(module, title, body)` — and those finer cases are what get reported,
  in place of the stage that contains them. Nothing is counted twice.
- **Nothing else changes.** A test with no module cases in it is one row, exactly
  as before.

## Module naming

## Adding a new module

Just create the folder and drop specs in it:

```
tests/appointment/create-appointment.spec.ts
```

That test shows up under module **Appointment** on the next run. No reporting
code changes.

`tests/lab-reports/` becomes **Lab Reports** (hyphens and underscores become
spaces, words are capitalised).

Only edit `module-map.ts` when the folder name and the report name should differ
— that is why `auth/` is reported as **Login**.

## Overriding the module for one file or one test

The resolver checks, in order:

1. An explicit annotation:

   ```ts
   test('Books a slot', { annotation: { type: 'module', description: 'Appointment' } }, async ({ page }) => {
       // ...
   });
   ```

2. A `test.describe()` title ending in the word "Module":

   ```ts
   test.describe('Prescription Module', () => {
       test('Creates a prescription', async ({ page }) => { /* ... */ });
   });
   ```

3. The folder the spec lives in (the normal case).

## Status handling

| Playwright status | Test Details sheet | Summary sheet |
| --- | --- | --- |
| `passed` | Passed | Passed |
| `failed` | Failed | Failed |
| `timedOut` | Timed Out | Failed |
| `interrupted` | Interrupted | Failed |
| `skipped` | Skipped | Skipped |
| (a module case an earlier failure stopped) | Not Executed | counted with Skipped |

Retries collapse into a single row showing the final attempt; the `Retry` column
says which attempt that was.

## If report generation breaks

The run's pass/fail result is never affected. The reporter catches its own
errors, prints a `MODULE REPORT FAILED` block in the terminal, and lets
Playwright's own exit code stand.
