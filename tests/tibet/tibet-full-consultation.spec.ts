import { expect, test, type Page } from '@playwright/test';
import { tibetCredentials, tibetDoctor } from '../config/test-env';
import { createSaveTibetPatient } from '../data/tibet-patients';
import { DoctorHomePage } from '../pages/doctor-home.page';
import { DoctorSelectionPage } from '../pages/doctor-selection.page';
import { LoginPage } from '../pages/login.page';
import { PatientSearchPage, type IdentifiedPatient } from '../pages/patient-search.page';
import { PrescriptionSearchPage } from '../pages/prescription-search.page';
import { TibetCaseHistoryPage } from '../pages/tibet-case-history.page';
import { TibetRegistrationPage } from '../pages/tibet-registration.page';
import { runModuleCases } from '../support/module-case';

/**
 * Paced to be watchable: every browser action pauses long enough to follow on screen,
 * the way tests/patient/full-consultation.spec.ts is. Raise it for a slower walkthrough
 * (E2E_SLOW_MO=1500) or drop it to 0 to run at full speed. Pair with --headed, or there
 * is nothing to watch.
 */
test.use({
    launchOptions: { slowMo: Number(process.env.E2E_SLOW_MO ?? 800) },
});

/**
 * One Tibet consultation end to end, from a patient who does not exist yet to a
 * prescription sitting with a doctor:
 *
 *   register on /TibetPatientForm and Save  ->  read back the id the app assigned
 *       ->  open that patient's record and press "Add Case History"
 *       ->  fill the case history: assisting nurse, vitals, symptoms, the severity
 *           indicator, the point-of-care tests, the nurse's comment
 *       ->  Save, and answer the abnormal-readings popup with OK
 *       ->  Centre Prescription (/TibetCentreHome), find the visit that made
 *       ->  Doctor Selection for that visit, pick the doctor and save
 *
 * The Tibet centre runs its own screens rather than the shared ones - /TibetPatientForm,
 * /TibetPatientSearch, /TibetPrescriptionHistoryForm, /TibetCentreHome - but the grids
 * and the case history behind them are the same markup every other centre uses, so the
 * page objects are shared and only the paths differ. See TibetCaseHistoryPage.
 *
 * Two things this flow turns on.
 *
 * The first is that "Add Case History" is refused for a patient who has not been saved
 * ("Save the patient details before adding a prescription"), so registration and the
 * case history cannot be done in one pass of the form. The run saves, reads back the id
 * the app gave the patient, and comes back to the record by that id.
 *
 * The second is the popup in the screenshot this spec was written from: "Please check
 * the vitals/ symptoms/ POC Test Results. Do you want to save the abnormal vitals/
 * symptoms/ test results?" That is a confirm(), raised whenever anything on the form is
 * outside its normal band - which a run drawing random vitals hits often. Playwright
 * dismisses dialogs by default, and Cancel there drops the save without a word, so
 * captureDialogs() is armed before the form is filled and answers it with OK.
 *
 * The handover needs a doctor who is free, and this centre lists exactly one: Dr. Demo.
 * A visit left sitting in their queue keeps them busy - Doctor Selection asks
 * GetAvailability_of_Doctor about the doctor being picked and swallows the click when
 * the answer is 0 - so a second Tibet run in a row is refused until the first one's
 * visit has been attended. That is what tests/doctor/doctor-consultation.spec.ts does
 * (`npm run test:doctor-consultation`): it takes whatever is waiting off the queue,
 * writes the prescription and approves it, which frees the doctor for the next run. It
 * is the same pairing the main consultation flow uses.
 *
 * It is one Playwright test because it has to be - one session, one patient, in order -
 * but it is reported as one test case per module: registration, the search, each section
 * of the case history, the handover. Each gets its own row, timing and error in the
 * Excel report, and a module a failure stopped from running is reported as "Not
 * Executed" rather than disappearing. See tests/support/module-case.ts.
 */
async function checkInDoctorAndReturnAsCentre(
    page: Page,
    doctor: { username: string; password: string },
    centre: { username: string; password: string }
): Promise<boolean> {
    const loginPage = new LoginPage(page);
    const doctorHome = new DoctorHomePage(page);

    await loginPage.logout();
    await loginPage.loginExpectingHome(doctor.username, doctor.password);
    await doctorHome.expectLoaded();
    const cameOnDuty = await doctorHome.ensureCheckedIn();
    await loginPage.logout();
    await loginPage.loginExpectingHome(centre.username, centre.password);

    return cameOnDuty;
}

test.describe('Tibet full consultation: register, case history, doctor', () => {
    test.describe.configure({ mode: 'serial' });

    // Registration, 3-4 symptoms and 3-4 point-of-care tests - each a selectize round
    // trip - and then the handover: well past the default, more so at demo pace.
    test.setTimeout(900000);

    test.afterEach(async ({ page }) => {
        await new LoginPage(page).logout();
    });

    test('takes a new Tibet patient from registration through to a doctor', {
        tag: ['@journey', '@tibet'],
    }, async ({ page }) => {
        const centre = tibetCredentials();
        const doctor = tibetDoctor();

        const loginPage = new LoginPage(page);
        const registrationPage = new TibetRegistrationPage(page);
        const searchPage = new PatientSearchPage(page, {
            searchPath: '/TibetPatientSearch',
            patientFormPath: '/TibetPatientForm',
        });
        const prescriptionPage = new PrescriptionSearchPage(page, { path: '/TibetCentreHome' });
        const caseHistoryPage = new TibetCaseHistoryPage(page);
        const doctorPage = new DoctorSelectionPage(page);

        const patient = createSaveTibetPatient();
        const caseHistory = patient.caseHistory;

        // Armed before anything is filled: the abnormal-readings confirm is answered with
        // OK, and an alert - which cancels the save outright - is kept so a blocked save
        // can name its own reason.
        const dialogMessages = caseHistoryPage.captureDialogs();

        // Carried from one module to the next. Every step after registration is tied to
        // the id the app handed back - the prescription grid belongs to the whole centre,
        // so a run that trusted row order would hand a stranger's visit to a doctor and
        // report success.
        let registered!: IdentifiedPatient;

        await runModuleCases([
            {
                module: 'Login',
                title: 'Sign in as the Tibet centre',
                run: () => loginPage.loginExpectingHome(centre.username, centre.password),
            },
            {
                module: 'Tibet Patient Registration',
                title: 'Register a new Tibet patient and save',
                run: async () => {
                    await registrationPage.openFromHome();
                    const aadhaarRequired = await registrationPage.isAadhaarRequired();
                    await registrationPage.fillPatient(patient, { fillAadhaar: aadhaarRequired });
                    console.log(
                        `Registering ${patient.name} (${patient.age} ${patient.ageUnit}, ` +
                            `${patient.gender}) on mobile ${patient.mobile}`
                    );
                    await registrationPage.save();
                    await registrationPage.expectSaved();
                },
            },
            {
                module: 'Tibet Patient Search',
                title: 'Read back the id the app gave the patient',
                // Save drops the run on /TibetPatientSearch without ever naming the id,
                // so it is looked up by the mobile number this run registered.
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
                module: 'Tibet Case History',
                title: 'Open the case history for that patient',
                // "Add Case History" lives on the patient's own record and is refused
                // until that record has been saved, so the run opens the record by id
                // rather than pressing the button on the form it just filled.
                run: async () => {
                    await searchPage.openPatientForm(registered);
                    await registrationPage.openCaseHistory();
                    await caseHistoryPage.expectLoaded();
                },
            },
            {
                module: 'Tibet Case History',
                title: 'Fill the case history',
                // fill() opens a module case per section - the assisting nurse, the
                // vitals, the symptoms, the severity indicator, the point-of-care tests,
                // the comment - and those finer cases are what the report shows. This
                // stage is their container, nothing more.
                run: async () => {
                    const summary = await caseHistoryPage.fill(caseHistory);
                    expect(summary.symptoms).toHaveLength(caseHistory.symptomCount);
                    expect(summary.tests).toHaveLength(caseHistory.testCount);

                    test.info().annotations.push({
                        type: 'severity indicator',
                        description: summary.severity.join('; '),
                    });
                    console.log(
                        `Assisting staff ${summary.nursingStaff}; symptoms ${summary.symptoms.join(', ')}; ` +
                            `tests ${summary.tests.join(', ')}; ${summary.severity.join('; ')}`
                    );
                },
            },
            {
                module: 'Tibet Case History',
                title: 'Save the case history and confirm the abnormal readings popup',
                // The popup this flow was written for: "Please check the vitals/
                // symptoms/ POC Test Results. Do you want to save the abnormal vitals/
                // symptoms/ test results?" - answered OK by captureDialogs(), without
                // which the save is silently cancelled.
                run: async () => {
                    await caseHistoryPage.saveAndExpectNextPage(dialogMessages);

                    // What the form actually asked on the way out. The abnormal-readings
                    // confirm only comes up when a reading is outside its normal band, so
                    // a run says which popups it answered rather than claiming one.
                    const answered = caseHistoryPage.confirmations;
                    test.info().annotations.push({
                        type: 'popups answered OK',
                        description:
                            answered.length > 0
                                ? answered.join(' | ')
                                : 'none - nothing on the form was outside its normal band',
                    });
                    console.log(
                        `Save left the form for ${page.url()}` +
                            (answered.length > 0
                                ? `; answered OK to: ${answered.join(' | ')}`
                                : '; the form raised no confirmation popup')
                    );
                },
            },
            {
                module: 'Tibet Centre Prescription',
                title: 'Find the visit the case history raised',
                // The saved case history is the patient's prescription, so it is now
                // listed under Centre Prescription against the same id.
                run: async () => {
                    const listedRow = await prescriptionPage.expectPrescriptionFor(registered);
                    console.log(`Centre Prescription now lists: ${listedRow}`);
                },
            },
            {
                module: 'Doctor Check-In',
                title: 'Bring the doctor on duty for the handover',
                // A doctor who is not on duty cannot be assigned: Doctor Selection asks
                // GetAvailability_of_Doctor about the doctor being picked and swallows
                // the click in silence when the answer is 0, and the row's own icon does
                // not answer that question - it goes live as soon as any doctor at the
                // centre is checked in. The only way to know is to ask as the doctor, so
                // the run signs in as them, presses Check In and comes back as the
                // centre, every time. ensureCheckedIn() is a no-op for a doctor already
                // on duty. See tibetDoctor() for which account that is.
                run: async () => {
                    const clickable = await prescriptionPage.isDoctorSelectionClickable(registered);
                    console.log(
                        `Doctor icon for ${registered.displayId} is ${
                            clickable ? 'live' : 'not clickable'
                        }; signing in as ${doctor.username} to Check In, then returning as the centre`
                    );

                    const cameOnDuty = await checkInDoctorAndReturnAsCentre(page, doctor, centre);
                    test.info().annotations.push({
                        type: 'doctor check-in',
                        description: `${doctor.username} ${
                            cameOnDuty ? 'checked in by this run' : 'was already on duty'
                        }`,
                    });
                    await prescriptionPage.expectPrescriptionFor(registered);
                },
            },
            {
                module: 'Doctor Selection',
                title: 'Hand the visit to a doctor',
                // The row is found by this patient's id rather than by position - the
                // grid is the centre's, newest first - and the prescription id read off
                // it is checked again on the screen that opens, so the doctor cannot end
                // up with someone else's consultation.
                run: async () => {
                    const prescriptionId = await prescriptionPage.openDoctorSelectionFor(registered);
                    await doctorPage.expectLoaded(prescriptionId);

                    const assigned = await doctorPage.selectDoctor(doctor.name);
                    await doctorPage.saveAndExpectPrescriptionCentre();

                    test.info().annotations.push({
                        type: 'doctor',
                        description: `prescription ${prescriptionId || '(id not in the link)'} for ${
                            registered.displayId
                        } assigned to ${assigned}`,
                    });
                    console.log(
                        `Assigned ${registered.displayId}'s prescription ${prescriptionId} to ${assigned}`
                    );
                },
            },
        ]);
    });
});
