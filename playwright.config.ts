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
  /* Clears leftover handshake files so a headed pair cannot open yesterday's patient. */
  globalSetup:
    process.env.E2E_PARALLEL_CONSULTATION === '1'
      ? './tests/support/consultation-handshake-setup.ts'
      : undefined,
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
     * The consultation flow as two workers at once when run via
     * `npm run test:consultation-flow:headed` (E2E_PARALLEL_CONSULTATION=1, --workers=2).
     * The centre half registers and assigns; the doctor half checks in and waits for that
     * patient. They coordinate through tests/support/consultation-handshake.ts — there is
     * no project `dependencies` list, because that would finish the centre window before
     * the doctor window ever opened.
     *
     * Run one half alone with --project=full-consultation or
     * `npm run test:doctor-consultation:only` (existing queue, no handshake).
     */
    {
      name: 'full-consultation',
      testMatch: /patient[\\/]full-consultation\.spec\.ts$/,
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: ['--window-position=0,0'],
        },
      },
    },
    {
      name: 'doctor-consultation',
      testMatch: /doctor[\\/]doctor-consultation\.spec\.ts$/,
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--window-position=1280,0',
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
          ],
        },
      },
    },

    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },

    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },

    {
      name: 'webkit',
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
