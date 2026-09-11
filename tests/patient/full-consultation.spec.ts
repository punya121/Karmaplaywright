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
 * One consultation end to end, from a patient who does not exist yet to a
 * prescription sitting with a doctor:
 *
 *   register and Save  ->  read back the patient id the app assigned
 *                      ->  Others > Assign Consent Form for that id
 *                      ->  open the case history for that patient
 *                      ->  fill it (with the under-5 checklist if the patient is a
 *                          child) and save it
 *                      ->  Search > Prescription (Centre), find the visit that made
 *                      ->  Doctor Selection for that visit, pick the doctor and save
 *
 * Two things make this run at all. The consent form is one: the case history form
 * refuses to save for a patient with no consent on file, which is why registering and
 * adding a case history in one go never worked from a browser. The other is that every
 * step is tied to the id the app handed back at registration — the prescription grid
 * belongs to the whole centre, so a run that trusted row order would hand a stranger's
 * visit to a doctor and report success.
 *
 * Runs a child instead of an adult with E2E_UNDER_FIVE=1, which is the only way to see
 * the childhood-illness screening checklist.
 */
test.describe('Full consultation: register, consent, case history, doctor', () => {
    test.describe.configure({ mode: 'serial' });

    // Registration, a consent assignment, 3-4 symptoms plus 3-4 PoC tests each a
    // selectize round trip, and then the handover — well past the default, more so at
    // demo pace.
    test.setTimeout(900000);

    test.afterEach(async ({ page }) => {
        await new LoginPage(page).logout();
    });

    test('takes a new patient from registration through to a doctor', async ({ page }) => {
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
            description: `${registered.displayId} (${registered.numericId}) ${registered.name}, aged ${patient.age} ${patient.ageUnit}`,
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

        // Under-fives get the childhood-illness screening checklist as well, and the
        // form will not save until every question on it is answered. An adult's form
        // has no such section, so an empty list here is the ordinary case.
        if (summary.underFiveChecklist.length > 0) {
            test.info().annotations.push({
                type: 'under-5 checklist',
                description: summary.underFiveChecklist.join('; '),
            });
            console.log(
                `Under-5 screening checklist answered: ${summary.underFiveChecklist.join('; ')}`
            );
        }

        await caseHistoryPage.saveAndExpectNextPage(dialogMessages);

        // 6. The saved case history is the patient's prescription, so it is now listed
        //    under Search > Prescription (Centre) against the same id.
        const listedRow = await prescriptionPage.expectPrescriptionFor(registered);
        console.log(`Prescription (Centre) now lists: ${listedRow}`);

        // 7. Hand that visit to a doctor. The row is found by this patient's id rather
        //    than by position — the grid is the centre's, newest first — and the
        //    prescription id read off it is checked again on the screen that opens, so
        //    the doctor cannot end up with someone else's consultation.
        const prescriptionId = await prescriptionPage.openDoctorSelectionFor(registered);
        await doctorPage.expectLoaded(prescriptionId);

        const doctor = await doctorPage.selectDoctor();
        await doctorPage.saveAndExpectPrescriptionCentre();

        test.info().annotations.push({
            type: 'doctor',
            description: `prescription ${prescriptionId || '(id not in the link)'} for ${
                registered.displayId
            } assigned to ${doctor}`,
        });
        console.log(
            `Assigned ${registered.displayId}'s prescription ${prescriptionId} to ${doctor}`
        );
    });
});
