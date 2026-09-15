import { expect, test, type Page } from '@playwright/test';
import {
    doctorPassword,
    doctorUsername,
    validPassword,
    validUsername,
} from '../config/test-env';
import { createSavePatient } from '../data/patients';
import { CaseHistoryPage } from '../pages/case-history.page';
import { ConsentFormPage } from '../pages/consent-form.page';
import { DoctorHomePage } from '../pages/doctor-home.page';
import { DoctorSelectionPage } from '../pages/doctor-selection.page';
import { LoginPage } from '../pages/login.page';
import { PatientSearchPage, type IdentifiedPatient } from '../pages/patient-search.page';
import { PrescriptionSearchPage } from '../pages/prescription-search.page';
import { RegistrationPage } from '../pages/registration.page';
import {
    isParallelConsultation,
    signalAssigned,
    waitForDoctorReady,
} from '../support/consultation-handshake';
import { runModuleCases } from '../support/module-case';

// Paced to be watchable: every browser action pauses long enough to follow on
// screen, the way existing-patient-case-history.spec.ts is. Raise it for a slower
// walkthrough (E2E_SLOW_MO=1500) or drop it to 0 to run at full speed. Pair with
// --headed, or there is nothing to watch.
test.use({
    launchOptions: {
        slowMo: Number(process.env.E2E_SLOW_MO ?? 800),
        // Sit on the left when the doctor worker is also headed, so both windows are
        // visible instead of stacked.
        args: ['--window-position=0,0'],
    },
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
 * It is one Playwright test because it has to be - one session, one patient, in order -
 * but it is reported as one test case per module it goes through: registration, the
 * consent form, each section of the case history, the handover. Each gets its own row,
 * timing and error in the Excel report, and a module a failure stopped from running is
 * reported as "Not Executed" rather than disappearing. See tests/support/module-case.ts.
 *
 * Runs a child instead of an adult with E2E_UNDER_FIVE=1, which is the only way to see
 * the childhood-illness screening checklist.
 *
 * A doctor who is not on duty cannot be handed anything: Prescription (Centre) greys
 * out the doctor icon (pointer-events: none) when nobody is checked in, and Doctor
 * Selection swallows the pick when the doctor chosen is not the one who is.
 *
 * Run alone, this spec signs in as the doctor, presses Check In on DoctorHome, signs
 * back in as the centre, and assigns from the same prescription row — only the doctor's
 * own home page can answer whether they are on duty.
 *
 * Run as the centre half of `npm run test:consultation-flow:headed`, it stays logged in
 * as the centre and waits for the doctor worker to Check In (see
 * tests/support/consultation-handshake.ts) instead of stealing this window.
 */
async function checkInDoctorAndReturnAsCentre(page: Page): Promise<boolean> {
    const loginPage = new LoginPage(page);
    const doctorHome = new DoctorHomePage(page);

    await loginPage.logout();
    await loginPage.loginExpectingHome(doctorUsername, doctorPassword);
    await doctorHome.expectLoaded();
    const cameOnDuty = await doctorHome.ensureCheckedIn();
    await loginPage.logout();
    await loginPage.loginExpectingHome(validUsername, validPassword);

    return cameOnDuty;
}

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

        // Carried from one module to the next. Every step after registration is tied to
        // the id the app handed back — the prescription grid belongs to the whole centre,
        // so a run that trusted row order would hand a stranger's visit to a doctor and
        // report success.
        let registered!: IdentifiedPatient;
        let hasPrescription = false;

        await runModuleCases([
            {
                module: 'Login',
                title: 'Sign in as the centre user',
                run: () => loginPage.loginExpectingHome(validUsername, validPassword),
            },
            {
                module: 'Patient Registration',
                title: 'Register a new patient and save',
                run: async () => {
                    await registrationPage.openFromHome();
                    const aadhaarRequired = await registrationPage.isAadhaarRequired();
                    await registrationPage.fillPatient(patient, { fillAadhaar: aadhaarRequired });
                    await registrationPage.save();
                    await registrationPage.expectSaved();
                },
            },
            {
                module: 'Patient Search',
                title: 'Read back the id the app gave the patient',
                // Save drops the run on Patient Search without ever naming the id, so it
                // is looked up by the mobile number this run registered.
                run: async () => {
                    registered = await searchPage.identifyPatient(patient);
                    test.info().annotations.push({
                        type: 'patient',
                        description:
                            `${registered.displayId} (${registered.numericId}) ${registered.name}, ` +
                            `aged ${patient.age} ${patient.ageUnit}`,
                    });
                    console.log(
                        `Registered ${patient.name} as ${registered.displayId} (numeric id ${registered.numericId})`
                    );
                },
            },
            {
                module: 'Consent Form',
                title: 'Assign a consent form to that patient',
                // The case history form refuses to save for a patient with no consent on
                // file, which is why registering and adding a case history in one go never
                // worked from a browser.
                run: async () => {
                    await consentPage.openFromHome();
                    const consentOutcome = await consentPage.assign(registered.numericId);
                    console.log(
                        `Assign Consent Form for ${registered.numericId}: ${consentOutcome}`
                    );
                    await searchPage.open();
                    await searchPage.expectConsentOnFile(registered);
                },
            },
            {
                module: 'Case History',
                title: 'Open the case history for that patient',
                // Prescription (Centre) is where a patient with a visit is picked up from;
                // a patient registered moments ago has no visit yet, so their first case
                // history is started from their own record instead. Either route lands on
                // the same form.
                run: async () => {
                    await prescriptionPage.open();
                    hasPrescription = await prescriptionPage.hasPrescriptionFor(registered);

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
                },
            },
            {
                module: 'Case History',
                title: 'Fill the case history',
                // fill() opens a module case per section — attendance, vitals, the under-5
                // checklist, symptoms, point-of-care tests — and those finer cases are what
                // the report shows. This stage is their container, nothing more.
                run: async () => {
                    const summary = await caseHistoryPage.fill(caseHistory);
                    expect(summary.symptoms).toHaveLength(caseHistory.symptomCount);
                    expect(summary.tests).toHaveLength(caseHistory.testCount);

                    // Under-fives get the childhood-illness screening checklist as well,
                    // and the form will not save until every question on it is answered.
                    // An adult's form has no such section, so an empty list is ordinary.
                    if (summary.underFiveChecklist.length > 0) {
                        test.info().annotations.push({
                            type: 'under-5 checklist',
                            description: summary.underFiveChecklist.join('; '),
                        });
                        console.log(
                            `Under-5 screening checklist answered: ${summary.underFiveChecklist.join('; ')}`
                        );
                    }
                },
            },
            {
                module: 'Case History',
                title: 'Save the case history',
                // With the consent form on file this save goes through instead of being
                // cancelled by the app's consent alert.
                run: () => caseHistoryPage.saveAndExpectNextPage(dialogMessages),
            },
            {
                module: 'Prescription (Centre)',
                title: 'Find the visit the case history raised',
                // The saved case history is the patient's prescription, so it is now
                // listed under Search > Prescription (Centre) against the same id.
                run: async () => {
                    const listedRow = await prescriptionPage.expectPrescriptionFor(registered);
                    console.log(`Prescription (Centre) now lists: ${listedRow}`);
                },
            },
            {
                module: 'Doctor Check-In',
                title: 'Bring the doctor on duty for the handover',
                // A doctor who is not on duty cannot be assigned, and the row's own icon
                // does not say whether *this* doctor is: it goes live as soon as any
                // doctor at the centre is checked in, while Doctor Selection asks
                // GetAvailability_of_Doctor about the one being picked and swallows the
                // click in silence when the answer is 0. The only way to know is to ask
                // as the doctor.
                //
                // Paired with the doctor worker, that worker is already on DoctorHome —
                // waiting on its handshake file is enough, and logging out of this
                // window would hide the centre session the headed run is meant to show.
                // Alone, this run still signs in as the doctor itself.
                run: async () => {
                    if (isParallelConsultation()) {
                        console.log(
                            `Waiting for ${doctorUsername} to Check In in the doctor worker`
                        );
                        await waitForDoctorReady();
                        test.info().annotations.push({
                            type: 'doctor check-in',
                            description: `${doctorUsername} checked in by the doctor worker`,
                        });
                        await prescriptionPage.expectPrescriptionFor(registered);
                        return;
                    }

                    const clickable = await prescriptionPage.isDoctorSelectionClickable(registered);
                    const noDoctorOnDuty =
                        !clickable &&
                        (await prescriptionPage.isDoctorSelectionDisabledByApp(registered));

                    console.log(
                        `Doctor icon for ${registered.displayId} is ${
                            clickable ? 'live' : 'not clickable'
                        }${noDoctorOnDuty ? ' (no doctor is checked in)' : ''}; ` +
                            `signing in as ${doctorUsername} to Check In, then returning as the centre`
                    );

                    const cameOnDuty = await checkInDoctorAndReturnAsCentre(page);
                    test.info().annotations.push({
                        type: 'doctor check-in',
                        description: `${doctorUsername} ${
                            cameOnDuty ? 'checked in by this run' : 'was already on duty'
                        }`,
                    });
                    await prescriptionPage.expectPrescriptionFor(registered);
                },
            },
            {
                module: 'Doctor Selection',
                title: 'Hand the visit to a doctor',
                // The row is found by this patient's id rather than by position — the grid
                // is the centre's, newest first — and the prescription id read off it is
                // checked again on the screen that opens, so the doctor cannot end up with
                // someone else's consultation.
                run: async () => {
                    const prescriptionId = await prescriptionPage.openDoctorSelectionFor(
                        registered
                    );
                    await doctorPage.expectLoaded(prescriptionId);

                    const doctor = await doctorPage.selectDoctor();
                    await doctorPage.saveAndExpectPrescriptionCentre();

                    if (isParallelConsultation()) {
                        signalAssigned({
                            displayId: registered.displayId,
                            prescriptionId,
                        });
                    }

                    test.info().annotations.push({
                        type: 'doctor',
                        description: `prescription ${prescriptionId || '(id not in the link)'} for ${
                            registered.displayId
                        } assigned to ${doctor}`,
                    });
                    console.log(
                        `Assigned ${registered.displayId}'s prescription ${prescriptionId} to ${doctor}`
                    );
                },
            },
        ]);
    });
});
