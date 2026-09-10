import { expect, test } from '@playwright/test';
import { validPassword, validUsername } from '../config/test-env';
import { createSavePatient } from '../data/patients';
import { CaseHistoryPage } from '../pages/case-history.page';
import { DoctorSelectionPage } from '../pages/doctor-selection.page';
import { LoginPage } from '../pages/login.page';
import { PatientSearchPage } from '../pages/patient-search.page';
import { PrescriptionSearchPage } from '../pages/prescription-search.page';

// This is the spec that gets presented, so it runs slower than the rest of the suite:
// every action pauses long enough to follow on screen. E2E_SLOW_MO still overrides.
// Pair with `--headed`, or there is nothing to watch.
test.use({
    launchOptions: { slowMo: Number(process.env.E2E_SLOW_MO ?? 800) },
});

// Set E2E_HOLD_OPEN=1 (with --headed) to keep the browser open. Case history Save
// parks first; resume to continue to Doctor Selection. That step then parks on
// Prescription (Centre). Resume again to end the run.
const holdOpen = !!process.env.E2E_HOLD_OPEN;

test.describe('Existing patient case history', () => {
    test.describe.configure({ mode: 'serial' });

    // 3-4 symptoms and 3-4 PoC tests, each a selectize round trip, run well past the
    // default — and at demo pace each one takes several seconds. Holding the browser
    // open waits on a person, so nothing can be allowed to time out.
    test.setTimeout(holdOpen ? 0 : 600000);

    test.afterEach(async ({ page }) => {
        // Logging out would navigate away from what the hold is there to show.
        if (holdOpen) {
            return;
        }

        await new LoginPage(page).logout();
    });

    test('adds a case history and assigns the prescription to a doctor', {
        tag: ['@journey', '@patient'],
    }, async ({ page }) => {
        const loginPage = new LoginPage(page);
        const searchPage = new PatientSearchPage(page);
        const caseHistoryPage = new CaseHistoryPage(page);
        const prescriptionPage = new PrescriptionSearchPage(page);
        const doctorPage = new DoctorSelectionPage(page);

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

        // After Save the visit is listed under Search > Prescription (Centre). Hand it
        // to a doctor: the row's action opens Doctor Selection, the doctor's card (or
        // photo) is picked, Save commits the handover, and the app returns here.
        const listedRow = await prescriptionPage.expectPrescriptionFor(patient);
        console.log(`Prescription (Centre) now lists: ${listedRow}`);

        await prescriptionPage.openDoctorSelectionFor(patient);
        await doctorPage.expectLoaded();

        const doctor = await doctorPage.selectDoctor();
        await doctorPage.saveAndExpectPrescriptionCentre();

        test.info().annotations.push({
            type: 'doctor',
            description: `prescription for ${patient.displayId} assigned to ${doctor}`,
        });
        console.log(`Assigned ${patient.displayId} to ${doctor}`);
    });
});
