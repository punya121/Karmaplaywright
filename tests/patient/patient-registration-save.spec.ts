import { test } from '@playwright/test';
import { validPassword, validUsername } from '../config/test-env';
import { createSavePatient } from '../data/patients';
import { LoginPage } from '../pages/login.page';
import { RegistrationPage } from '../pages/registration.page';

test.describe('Patient registration Save', () => {
    test.describe.configure({ mode: 'serial' });

    test('saves a new patient and fills Aadhaar only when required', async ({ page }) => {
        const loginPage = new LoginPage(page);
        const registrationPage = new RegistrationPage(page);
        const patient = createSavePatient();

        await loginPage.loginExpectingHome(validUsername, validPassword);
        await registrationPage.openFromHome();

        const aadhaarRequired = await registrationPage.isAadhaarRequired();
        await registrationPage.fillPatient(patient, { fillAadhaar: aadhaarRequired });

        console.log(`Saving patient name=${patient.name} mobile=${patient.mobile}`);

        await registrationPage.save();
        await registrationPage.expectSaved();
    });

    test('shows an error when Aadhaar is required and left empty', async ({ page }) => {
        const loginPage = new LoginPage(page);
        const registrationPage = new RegistrationPage(page);
        const patient = createSavePatient();

        await loginPage.loginExpectingHome(validUsername, validPassword);
        await registrationPage.openFromHome();

        const aadhaarRequired = await registrationPage.isAadhaarRequired();
        test.skip(!aadhaarRequired, 'Aadhaar is not required for this login role');

        await registrationPage.fillPatient(patient, { fillAadhaar: false });
        await registrationPage.save({ waitForPatientSearch: false });
        await registrationPage.expectAadhaarRequiredError();
    });
});
