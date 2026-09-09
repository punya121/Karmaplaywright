import { expect, test } from '@playwright/test';
import { validPassword, validUsername } from '../config/test-env';
import { createSavePatient } from '../data/patients';
import { CaseHistoryPage } from '../pages/case-history.page';
import { ConsentFormPage } from '../pages/consent-form.page';
import { DoctorSelectionPage } from '../pages/doctor-selection.page';
import { LoginPage } from '../pages/login.page';
import { PatientSearchPage, type IdentifiedPatient } from '../pages/patient-search.page';
import { PrescriptionSearchPage } from '../pages/prescription-search.page';
import { RegistrationPage } from '../pages/registration.page';

// Paced to be watchable: every browser action pauses long enough to follow on
// screen, the way existing-patient-case-history.spec.ts is. Raise it for a slower
// walkthrough (E2E_SLOW_MO=1500) or drop it to 0 to run at full speed. Pair with
// --headed, or there is nothing to watch.
test.use({
    launchOptions: { slowMo: Number(process.env.E2E_SLOW_MO ?? 800) },
});

/**
 * The whole chain a new patient goes through, in one run:
 *
 *   register and Save  ->  read back the patient id the app assigned
 *                      ->  Others > Assign Consent Form for that id
 *                      ->  Search > Prescription (Centre), find that id
 *                      ->  add the case history and save it
 *                      ->  assign the prescription to a doctor and save
 *
 * The consent step is what makes the last one possible: the case history form
 * refuses to save for a patient with no consent form on file, which is why
 * registering and adding a case history in one go has never worked from a browser.
 */
test.describe('New patient: register, assign consent, add case history', () => {
    test.describe.configure({ mode: 'serial' });

    // Registration, a consent assignment and 3-4 symptoms plus 3-4 PoC tests, each
    // one a selectize round trip, runs well past the default — more so at demo pace.
    test.setTimeout(600000);

    test.afterEach(async ({ page }) => {
        await new LoginPage(page).logout();
    });

    test('registers a patient, assigns their consent form and saves a case history', async ({
        page,
    }) => {
        const loginPage = new LoginPage(page);
        const registrationPage = new RegistrationPage(page);
        const searchPage = new PatientSearchPage(page);
        const consentPage = new ConsentFormPage(page);
        const prescriptionPage = new PrescriptionSearchPage(page);
        const caseHistoryPage = new CaseHistoryPage(page);
        const doctorPage = new DoctorSelectionPage(page);

        const patient = createSavePatient();
        const caseHistory = patient.caseHistory;

        if (!caseHistory) {
            throw new Error('Patient case history data is missing from createSavePatient()');
        }

        const dialogMessages = caseHistoryPage.captureDialogs();

        await loginPage.loginExpectingHome(validUsername, validPassword);

        // 1. Register the patient and save them.
        await registrationPage.openFromHome();
        const aadhaarRequired = await registrationPage.isAadhaarRequired();
        await registrationPage.fillPatient(patient, { fillAadhaar: aadhaarRequired });
        await registrationPage.save();
        await registrationPage.expectSaved();

        // 2. Find out which patient that was. Save drops the run on Patient Search
        //    without ever naming the id, so it is looked up by the mobile number this
        //    run registered.
        const registered: IdentifiedPatient = await searchPage.identifyPatient(patient);
        test.info().annotations.push({
            type: 'patient',
            description: `${registered.displayId} (${registered.numericId}) ${registered.name}`,
        });
        console.log(
            `Registered ${patient.name} as ${registered.displayId} (numeric id ${registered.numericId})`
        );

        // 3. Assign a consent form to exactly that patient id.
        await consentPage.openFromHome();
        const consentOutcome = await consentPage.assign(registered.numericId);
        console.log(`Assign Consent Form for ${registered.numericId}: ${consentOutcome}`);
        await searchPage.open();
        await searchPage.expectConsentOnFile(registered);

        // 4. Open the case history for that patient. Prescription (Centre) is where a
        //    patient with a visit is picked up from; a patient registered moments ago
        //    has no visit yet, so their first case history is started from their own
        //    record instead. Either route lands on the same form.
        await prescriptionPage.open();
        const hasPrescription = await prescriptionPage.hasPrescriptionFor(registered);

        if (hasPrescription) {
            await prescriptionPage.openCaseHistoryFor(registered);
        } else {
            await searchPage.open();
            await searchPage.openPatientForm(registered);
            await page.getByRole('button', { name: 'Add Case History' }).click();
        }

        test.info().annotations.push({
            type: 'case history opened from',
            description: hasPrescription
                ? 'Prescription (Centre) row'
                : "the patient's own record (no prescription raised yet)",
        });

        await caseHistoryPage.expectLoaded();

        // 5. Fill it and save. With the consent form on file this save goes through
        //    instead of being cancelled by the app's consent alert.
        const summary = await caseHistoryPage.fill(caseHistory);
        expect(summary.symptoms).toHaveLength(caseHistory.symptomCount);
        expect(summary.tests).toHaveLength(caseHistory.testCount);

        await caseHistoryPage.saveAndExpectNextPage(dialogMessages);

        // 6. The saved case history is the patient's prescription, so it is now listed
        //    under Search > Prescription (Centre) against the same id.
        const listedRow = await prescriptionPage.expectPrescriptionFor(registered);
        console.log(`Prescription (Centre) now lists: ${listedRow}`);

        // 7. Hand that prescription to a doctor. The row's own action opens Doctor
        //    Selection for it; clicking the doctor's card and saving is what puts the
        //    visit in front of them, and the app comes back to Prescription (Centre).
        await prescriptionPage.openDoctorSelectionFor(registered);
        await doctorPage.expectLoaded();

        const doctor = await doctorPage.selectDoctor();
        await doctorPage.saveAndExpectPrescriptionCentre();

        test.info().annotations.push({
            type: 'doctor',
            description: `prescription for ${registered.displayId} assigned to ${doctor}`,
        });
        console.log(`Assigned ${registered.displayId} to ${doctor}`);
    });
});
