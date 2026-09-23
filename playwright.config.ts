import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'path';
import { RUN_ID, relativeToCwd, runPath } from './reporting/run-context';

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
dotenv.config({ path: path.resolve(__dirname, '.env') });

/**
 * Pace every browser action so a run is watchable when it is being presented.
 * 250ms is deliberate without dragging; override with E2E_SLOW_MO (0 = full speed).
 * CI always runs at full speed. Pair with `--headed` to actually see it.
 */
const slowMo = process.env.E2E_SLOW_MO
  ? Number(process.env.E2E_SLOW_MO)
  : process.env.CI
    ? 0
    : 250;

/**
 * The specs that open a second browser of their own and drive two live sessions at once.
 * Each has a project below and nothing else picks them up: run by an ordinary browser
 * project they would launch a doctor browser per browser engine, three sessions deep into
 * an account that allows a handful.
 */
const liveSpecs = [
  /live[\\/]full-consultation-with-doctor\.spec\.ts$/,
  /tibet[\\/]tibet-full-consultation-with-doctor\.spec\.ts$/,
];

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './tests',
  testIgnore: [
    'auth/login.spec.ts',
    'patient/patient-registration.spec.ts',
    'patient/patient-case-history.spec.ts',
  ],
  /* Slowing every action down eats into the per-test budget, so grow it to match. */
  timeout: slowMo ? 120000 : 30000,
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 1 : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters
   *
   *  - list                  : the usual per-test lines in the terminal
   *  - html                  : the standard Playwright report
   *  - module-report-reporter: enriched JSON + module-wise Excel workbook
   *                            (see reporting/README.md)
   *
   * Every run writes into its own folder — reports/runs/<run id>/ — so previous
   * runs are kept instead of being overwritten. `npm run report` opens the newest
   * one. reports/ is gitignored, so the history never lands in the repo.
   */
  reporter: [
    ['list'],
    ['html', { outputFolder: relativeToCwd(runPath('playwright-report')), open: 'never' }],
    ['./reporting/module-report-reporter.ts', { runId: RUN_ID }],
  ],
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    baseURL: (process.env.E2E_BASE_URL || 'https://uat.karmaprimaryhealthcare.in').replace(/\/$/, ''),

    launchOptions: { slowMo },

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
  },

  /* Configure projects for major browsers */
  projects: [
    /*
     * The consultation flow, in the order it has to happen: a prescription only reaches
     * a doctor's queue once Full Consultation has registered the patient and handed it
     * over on Doctor Selection, so Doctor Consultation has nothing to open until that
     * has finished.
     *
     * `dependencies` is what orders them. Playwright runs a project's dependencies to
     * completion first, and skips the dependent project entirely if one of them fails —
     * so a failed Full Consultation stops Doctor Consultation from running at all,
     * without any waiting or polling in the specs themselves. Both reuse the same
     * fixtures, page objects, .env and `use` block as every other project here.
     *
     * Run the pair with --project=doctor-consultation: the dependency comes first on its
     * own. Add --no-deps to run the doctor half by itself against a queue that already
     * has someone in it.
     */
    {
      name: 'full-consultation',
      testMatch: /patient[\\/]full-consultation\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'doctor-consultation',
      testMatch: /doctor[\\/]doctor-consultation\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['full-consultation'],
    },

    /*
     * The same journey as the pair above, but as two live sessions instead of one after
     * the other: the patient's browser opens a second browser of its own when it reaches
     * Doctor Selection, signs the doctor in there, and holds its own consultation open
     * while that doctor finds it and joins it.
     *
     * It is one project running one test in one worker, deliberately — the second browser
     * is launched by the test itself (chromium.launch()), at the line where it is wanted,
     * so there is nothing to synchronise between workers and no --workers=2 to remember.
     *
     *   npm run test:live          (headless)
     *   npm run test:live:headed   (both windows on screen, side by side)
     */
    {
      name: 'live-consultation',
      testMatch: /live[\\/]full-consultation-with-doctor\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },

    /*
     * The same two-browser journey against the Tibet centre: browser 1 registers on
     * /TibetPatientForm and raises the case history, browser 2 is the doctor who joins the
     * consultation it hands over. It lives with the other Tibet specs but gets a project
     * of its own for the same reason as the one above — it launches a browser itself, so
     * it must not be run once per engine.
     *
     *   npm run test:tibet-live          (headless)
     *   npm run test:tibet-live:headed   (both windows on screen, side by side)
     */
    {
      name: 'tibet-live-consultation',
      testMatch: /tibet[\\/]tibet-full-consultation-with-doctor\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },

    /*
     * The two-browser specs are left to their own projects above. The browser projects run
     * everything else under tests/ — picking one of those up here as well would mean a
     * second doctor session against the same account, once per engine, from a run that
     * never asked for one. See liveSpecs.
     */
    {
      name: 'chromium',
      testIgnore: liveSpecs,
      use: { ...devices['Desktop Chrome'] },
    },

    {
      name: 'firefox',
      testIgnore: liveSpecs,
      use: { ...devices['Desktop Firefox'] },
    },

    {
      name: 'webkit',
      testIgnore: liveSpecs,
      use: { ...devices['Desktop Safari'] },
    },

    /* Test against mobile viewports. */
    // {
    //   name: 'Mobile Chrome',
    //   use: { ...devices['Pixel 5'] },
    // },
    // {
    //   name: 'Mobile Safari',
    //   use: { ...devices['iPhone 12'] },
    // },

    /* Test against branded browsers. */
    // {
    //   name: 'Microsoft Edge',
    //   use: { ...devices['Desktop Edge'], channel: 'msedge' },
    // },
    // {
    //   name: 'Google Chrome',
    //   use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    // },
  ],

  /* Run your local dev server before starting the tests */
  // webServer: {
  //   command: 'npm run start',
  //   url: 'http://localhost:3000',
  //   reuseExistingServer: !process.env.CI,
  // },
});
