import { expect, test } from '@playwright/test';
import { validPassword, validUsername } from '../config/test-env';
import { createSavePatient } from '../data/patients';
import { CaseHistoryPage } from '../pages/case-history.page';
import { LoginPage } from '../pages/login.page';
import { PatientSearchPage } from '../pages/patient-search.page';

// This is the spec that gets presented, so it runs slower than the rest of the suite:
// every action pauses long enough to follow on screen. E2E_SLOW_MO still overrides.
// Pair with `--headed`, or there is nothing to watch.
test.use({
    launchOptions: { slowMo: Number(process.env.E2E_SLOW_MO ?? 800) },
});

test.describe('Existing patient case history', () => {
    test.describe.configure({ mode: 'serial' });

    // 3-4 symptoms and 3-4 PoC tests, each a selectize round trip, run well past the
    // default — and at demo pace each one takes several seconds.
    test.setTimeout(600000);

    test.afterEach(async ({ page }) => {
        await new LoginPage(page).logout();
    });

    test('adds a case history to a patient already on file', async ({ page }) => {
        const loginPage = new LoginPage(page);
        const searchPage = new PatientSearchPage(page);
        const caseHistoryPage = new CaseHistoryPage(page);

        // No patient is registered here: the vitals still come from createSavePatient()
        // so every run enters different, age-appropriate readings.
        const caseHistory = createSavePatient().caseHistory;

        if (!caseHistory) {
            throw new Error('Patient case history data is missing from createSavePatient()');
        }

        const dialogMessages = caseHistoryPage.captureDialogs();

        await loginPage.loginExpectingHome(validUsername, validPassword);

        await searchPage.open();
        const patient = await searchPage.openCaseHistoryForExistingPatient();
        test.info().annotations.push({ type: 'patient', description: patient.label });

        await caseHistoryPage.expectLoaded();

        const summary = await caseHistoryPage.fill(caseHistory);
        expect(summary.symptoms).toHaveLength(caseHistory.symptomCount);
        expect(summary.tests).toHaveLength(caseHistory.testCount);

        await caseHistoryPage.saveAndExpectNextPage(dialogMessages);
    });
});
