import { test } from '@playwright/test';
import { validPassword, validUsername } from '../config/test-env';
import { createSaveTibetPatient } from '../data/tibet-patients';
import { LoginPage } from '../pages/login.page';
import { TibetRegistrationPage } from '../pages/tibet-registration.page';

test.describe('Tibet Patient registration Save', () => {
    test.describe.configure({ mode: 'serial' });

    test('saves a new Tibet patient and fills Aadhaar only when required', async ({ page }) => {
        const loginPage = new LoginPage(page);
        const registrationPage = new TibetRegistrationPage(page);
        const patient = createSaveTibetPatient();

        await loginPage.loginExpectingHome(validUsername, validPassword);
        await registrationPage.openFromHome();

        const aadhaarRequired = await registrationPage.isAadhaarRequired();
        await registrationPage.fillPatient(patient, { fillAadhaar: aadhaarRequired });

        console.log(`Saving Tibet patient name=${patient.name} mobile=${patient.mobile}`);

        await registrationPage.save();
        await registrationPage.expectSaved();
    });

    test('shows an error when Aadhaar is required and left empty', async ({ page }) => {
        const loginPage = new LoginPage(page);
        const registrationPage = new TibetRegistrationPage(page);
        const patient = createSaveTibetPatient();

        await loginPage.loginExpectingHome(validUsername, validPassword);
        await registrationPage.openFromHome();

        const aadhaarRequired = await registrationPage.isAadhaarRequired();
        test.skip(!aadhaarRequired, 'Aadhaar is not required for this login role');

        await registrationPage.fillPatient(patient, { fillAadhaar: false });
        await registrationPage.save({ waitForPatientSearch: false });
        await registrationPage.expectAadhaarRequiredError();
    });
});
