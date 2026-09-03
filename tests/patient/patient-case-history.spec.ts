import { expect, test } from '@playwright/test';
import { validPassword, validUsername } from '../config/test-env';
import { createSavePatient } from '../data/patients';
import { CaseHistoryPage } from '../pages/case-history.page';
import { LoginPage } from '../pages/login.page';
import { RegistrationPage } from '../pages/registration.page';

test.describe('Patient registration case history', () => {
    test.describe.configure({ mode: 'serial' });

    // Registration plus 3-4 symptoms and 3-4 PoC tests, each a selectize round trip,
    // runs well past the default — more so with slowMo on for a demo.
    test.setTimeout(300000);

    test.afterEach(async ({ page }) => {
        await new LoginPage(page).logout();
    });

    test('adds a case history for a dynamically created patient', async ({ page }) => {
        const loginPage = new LoginPage(page);
        const registrationPage = new RegistrationPage(page);
        const caseHistoryPage = new CaseHistoryPage(page);
        const patient = createSavePatient();
        const caseHistory = patient.caseHistory;

        if (!caseHistory) {
            throw new Error('Patient case history data is missing from createSavePatient()');
        }

        const dialogMessages = caseHistoryPage.captureDialogs();

        await loginPage.loginExpectingHome(validUsername, validPassword);
        await registrationPage.openFromHome();

        const aadhaarRequired = await registrationPage.isAadhaarRequired();
        await registrationPage.fillPatient(patient, { fillAadhaar: aadhaarRequired });

        await page.getByRole('button', { name: 'Add Case History' }).click();
        await caseHistoryPage.expectLoaded();

        const summary = await caseHistoryPage.fill(caseHistory);
        expect(summary.symptoms).toHaveLength(caseHistory.symptomCount);
        expect(summary.tests).toHaveLength(caseHistory.testCount);

        await caseHistoryPage.saveAndExpectNextPage(dialogMessages);
    });
});
