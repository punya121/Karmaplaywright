import path from 'path';

/**
 * One identity for the whole test run, shared by every reporter.
 *
 * Each run writes into its own folder under `reports/runs/`, so a new run never
 * overwrites the previous one and the full history stays on disk:
 *
 *   reports/runs/2026-09-07_14-32-05/playwright-report/
 *   reports/runs/2026-09-07_14-32-05/test-results.json
 *   reports/runs/2026-09-07_14-32-05/Test-Execution-Report.xlsx
 *
 * `reports/` is gitignored, so none of it is ever committed.
 *
 * This module is imported by `playwright.config.ts` and by the module reporter.
 * Node caches modules, so both see the same RUN_ID within the reporter process.
 * Set `E2E_RUN_ID` to name a run yourself (useful in CI: `E2E_RUN_ID=$BUILD_ID`).
 */

/** `2026-09-07_14-32-05` — sorts chronologically and is safe on Windows. */
function timestampId(date = new Date()): string {
    const pad = (value: number) => String(value).padStart(2, '0');
    return (
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
        `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
    );
}

/**
 * Anything that would escape the runs folder is stripped from a custom id.
 * A dots-only id such as `..` is rejected outright — it would resolve to the
 * reports folder itself, which the HTML reporter clears before it writes.
 */
function sanitiseId(id: string): string {
    const cleaned = id.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
    return /[A-Za-z0-9]/.test(cleaned) ? cleaned : '';
}

export const REPORTS_DIR = path.resolve(process.cwd(), 'reports');

/** All runs live here; one sub-folder each. */
export const RUNS_DIR = path.join(REPORTS_DIR, 'runs');

export const RUN_ID = sanitiseId(process.env.E2E_RUN_ID || '') || timestampId();

/** This run's folder, e.g. `reports/runs/2026-09-07_14-32-05`. */
export const RUN_DIR = path.join(RUNS_DIR, RUN_ID);

/** Appended after every run so the whole history is browsable from one file. */
export const HISTORY_FILE = path.join(RUNS_DIR, 'history.json');

/** Path inside this run's folder. */
export function runPath(...segments: string[]): string {
    return path.join(RUN_DIR, ...segments);
}

/** Same path, relative to the project root — nicer to print. */
export function relativeToCwd(target: string): string {
    return path.relative(process.cwd(), target).split(path.sep).join('/');
}
