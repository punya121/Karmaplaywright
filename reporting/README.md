# Module-wise test reporting

Everything here runs automatically as part of `npx playwright test`. There is no
separate command to remember.

## What gets produced

```
reports/
├── test-results.json            enriched JSON (module, status, duration, error, retry)
├── Test-Execution-Report.xlsx   Summary + Test Details workbook
└── playwright-report/           the standard Playwright HTML report
```

Open the HTML report the usual way:

```bash
npx playwright show-report reports/playwright-report
# or
npm run report
```

## Files

| File | What it does |
| --- | --- |
| `module-report-reporter.ts` | The Playwright reporter. Collects results, writes the JSON, calls the Excel writer. |
| `module-resolver.ts` | Decides which module a test belongs to. |
| `excel-writer.ts` | Builds the workbook (styling, filters, freeze panes, data bars). |
| `module-map.ts` | The only file you may ever need to edit — folder → module name overrides. |
| `types.ts` | Shared shapes. |

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

Retries collapse into a single row showing the final attempt; the `Retry` column
says which attempt that was.

## If report generation breaks

The run's pass/fail result is never affected. The reporter catches its own
errors, prints a `MODULE REPORT FAILED` block in the terminal, and lets
Playwright's own exit code stand.
