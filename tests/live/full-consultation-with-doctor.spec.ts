import {
    chromium,
    devices,
    expect,
    test,
    type Browser,
    type BrowserContext,
    type Page,
} from '@playwright/test';
import {
    doctorPassword,
    doctorUsername,
    validPassword,
    validUsername,
} from '../config/test-env';
import { createConsultation } from '../data/consultations';
import { createSavePatient } from '../data/patients';
import { CaseHistoryPage } from '../pages/case-history.page';
import { ConsentFormPage } from '../pages/consent-form.page';
import { DoctorCallPage, type AnsweredCall } from '../pages/doctor-call.page';
import { DoctorHomePage, type QueuedPatient } from '../pages/doctor-home.page';
import { DoctorSelectionPage } from '../pages/doctor-selection.page';
import { LoginPage } from '../pages/login.page';
import { PatientSearchPage, type IdentifiedPatient } from '../pages/patient-search.page';
import { PendingBillPage } from '../pages/pending-bill.page';
import {
    PrescriptionFormPage,
    type ConsultationSummary,
    type MedicineLine,
} from '../pages/prescription-form.page';
import { PrescriptionSearchPage } from '../pages/prescription-search.page';
import { RegistrationPage } from '../pages/registration.page';
import { runModuleCases } from '../support/module-case';

/** The prescription as one line, the way the report and the console show it. */
function describePrescription(lines: MedicineLine[]): string {
    return lines
        .map(
            (line) =>
                `${line.medicine} (${line.category})` +
                `${line.dosage ? ` ${line.dosage}` : ''}` +
                `${line.frequency ? ` ${line.frequency}` : ''}` +
                `${line.duration ? ` for ${line.duration}` : ''}` +
                `${line.instruction ? `, ${line.instruction}` : ''}` +
                `${line.route ? `, ${line.route}` : ''}`
        )
        .join(' | ');
}

/**
 * One consultation, two live browser sessions, opened one after the other.
 *
 *   BROWSER 1 (the patient)                      BROWSER 2 (the doctor)
 *   -----------------------                      ----------------------
 *   register -> consent -> case history
 *   Prescription (Centre): the visit
 *   opens Doctor Selection for it  ------------>  opened here, and not before:
 *                                                 doctor signs in, presses Check In
 *   reloads, picks the doctor, Saves
 *   the consultation is now ongoing              finds *that* patient in the queue,
 *   and this session stays signed in  <--------  takes them on, opens the consultation,
 *   is rung on CentreHome, clicks the             which rings the centre
 *   "Click here" notification and joins
 *   the doctor session it opens
 *   both sessions live at once, on the same consultation
 *
 * Why the second browser is opened at Doctor Selection rather than at the start: that
 * is the first moment the doctor is needed. Before it there is nothing for a doctor to
 * do - no patient, no visit, nothing in any queue - and a doctor session opened earlier
 * would just be sitting idle, burning one of the account's concurrent session slots
 * while the registration runs. The two are only required to be live *together* from the
 * handover onwards, and from that point they are.
 *
 * It is one Playwright test in one worker, so nothing has to be synchronised: browser 2
 * is opened by the test itself, at the exact line where it is wanted, and the test drives
 * both. There is no `--workers=2`, no second run and no waiting on the other half -
 * `await` is the synchronisation. What makes them genuinely independent sessions is that
 * browser 2 is its own chromium process with its own context, cookies and storage, so
 * the doctor's login cannot evict the centre's or vice versa; the `page` this test is
 * given is never handed to the doctor's page objects, and the doctor's page is never
 * handed to the centre's.
 *
 * Everything else is the existing suite: the same fixtures, page objects, .env, URLs and
 * module-case reporting. tests/patient/full-consultation.spec.ts and
 * tests/doctor/doctor-consultation.spec.ts are untouched and still run on their own.
 *
 * Run it with:  npm run test:live:headed   (both windows on screen, side by side)
 *               npm run test:live          (headless)
 */

test.use({
    launchOptions: { slowMo: Number(process.env.E2E_SLOW_MO ?? 800) },
});

/** The doctor's window is put beside the patient's so a watched run shows both at once. */
const doctorWindowPosition = process.env.E2E_DOCTOR_WINDOW_POSITION || '960,0';
const doctorWindowSize = process.env.E2E_DOCTOR_WINDOW_SIZE || '960,1040';

/**
 * A centre with the previous day's bills still open is refused every case history until
 * they are created, so the run creates them rather than stopping. Set
 * E2E_AUTO_CLEAR_PENDING_BILLS=0 to have the refusal reported instead - which is what a
 * run investigating the block itself wants.
 */
const autoClearPendingBills = process.env.E2E_AUTO_CLEAR_PENDING_BILLS !== '0';

test.describe('Live consultation: the patient holds it open while a doctor joins', () => {
    test.describe.configure({ mode: 'serial' });

    // The whole journey at demo pace in browser 1, plus the doctor's join in browser 2.
    test.setTimeout(Number(process.env.E2E_LIVE_TEST_TIMEOUT ?? 1800000));

    /**
     * Browser 2. Kept at describe scope so teardown can close it even when the test fails
     * half way through the consultation - an orphaned chromium holding a doctor session
     * open is the one piece of damage a crashed run here could otherwise do.
     */
    let doctorBrowser: Browser | undefined;
    let doctorContext: BrowserContext | undefined;
    let doctorPage: Page | undefined;
    /** Only the run that brought the doctor on duty puts them back off it. */
    let doctorCameOnDutyThisRun = false;

    test.afterEach(async ({ page }) => {
        // Browser 2 first: it is the one holding the doctor's session, and the account
        // allows only a handful of concurrent ones, so it is checked out and logged out
        // rather than just closed.
        if (doctorPage) {
            if (doctorCameOnDutyThisRun) {
                await new DoctorHomePage(doctorPage).checkOut().catch(() => undefined);
            }
            await new LoginPage(doctorPage).logout().catch(() => undefined);
        }

        await doctorContext?.close().catch(() => undefined);
        await doctorBrowser?.close().catch(() => undefined);

        doctorPage = undefined;
        doctorContext = undefined;
        doctorBrowser = undefined;
        doctorCameOnDutyThisRun = false;

        // Browser 1 last, so the patient session outlives the doctor's - the consultation
        // is held open for the whole of the doctor's visit to it, which is the point.
        await new LoginPage(page).logout().catch(() => undefined);
    });

    test('opens a second browser at Doctor Selection and joins the same consultation', async ({
        page,
    }) => {
        // --- browser 1: the patient's session -------------------------------------
        const loginPage = new LoginPage(page);
        const registrationPage = new RegistrationPage(page);
        const searchPage = new PatientSearchPage(page);
        const consentPage = new ConsentFormPage(page);
        const prescriptionPage = new PrescriptionSearchPage(page);
        const caseHistoryPage = new CaseHistoryPage(page);
        const doctorSelection = new DoctorSelectionPage(page);
        const pendingBills = new PendingBillPage(page);
        const doctorCall = new DoctorCallPage(page);

        // --- browser 2: built at Doctor Selection, not before ----------------------
        let doctorLogin!: LoginPage;
        let doctorHome!: DoctorHomePage;
        let prescriptionForm!: PrescriptionFormPage;

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
        let prescriptionId = '';
        let assignedDoctor = '';
        let queued!: QueuedPatient;
        let joinedPrescriptionId = '';
        /** The call the centre answered in browser 1, once the doctor has placed it. */
        let answeredCall!: AnsweredCall;

        // What browser 2 writes into the form, and the alerts that session raises.
        // The dialogs are captured the moment the doctor's page exists, so a refused
        // save reports the app's own words instead of timing out.
        const consultation = createConsultation();
        let summary!: ConsultationSummary;
        let doctorDialogMessages: string[] = [];

        await runModuleCases([
            {
                module: 'Login',
                title: 'Sign in as the centre user in browser 1',
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
                // A patient registered moments ago has no visit yet, so their first case
                // history is started from their own record; either route lands on the same
                // form.
                run: async () => {
                    await prescriptionPage.open();
                    hasPrescription = await prescriptionPage.hasPrescriptionFor(registered);

                    if (hasPrescription) {
                        await prescriptionPage.openCaseHistoryFor(registered);
                    } else {
                        await searchPage.open();
                        await searchPage.openPatientForm(registered);
                        // Not a bare click: this button does its work in a handler bound
                        // when the record's own scripts run, so a click made too early is
                        // swallowed and the run walks on into a form that never opened.
                        // See openCaseHistoryFromPatientForm().
                        await searchPage.openCaseHistoryFromPatientForm(dialogMessages, {
                            // The app refuses to start any case history while the centre
                            // has the previous day's bills outstanding, and says so. That
                            // is a real backlog, not a glitch, so the run clears it the way
                            // the pharmacy would — Bill > View Pending Bills, batch and
                            // expiry per medicine — and comes back. E2E_AUTO_CLEAR_
                            // PENDING_BILLS=0 turns that off and leaves the refusal to be
                            // reported instead.
                            onCentreBlocked: async (message) => {
                                if (!autoClearPendingBills) {
                                    throw new Error(
                                        `The centre is blocked and this run was told not to ` +
                                            `clear it (E2E_AUTO_CLEAR_PENDING_BILLS=0): ${message}`
                                    );
                                }

                                const bills = await pendingBills.clearPendingBills();

                                test.info().annotations.push({
                                    type: 'pending bills cleared',
                                    description:
                                        bills.length === 0
                                            ? 'the centre was blocked but there was nothing to ' +
                                              'bill — either nothing was listed, or Create Bill ' +
                                              'answered that there are no patients; the run ' +
                                              'carried on either way'
                                            : bills
                                                  .map(
                                                      (bill) =>
                                                          `${bill.prescriptionId}: ` +
                                                          bill.medicines
                                                              .map(
                                                                  (line) =>
                                                                      `${line.batchNumber} exp ${
                                                                          line.expiry || '(not set)'
                                                                      }`
                                                              )
                                                              .join(', ')
                                                  )
                                                  .join(' | '),
                                });

                                // The bills were created on other screens, so the run has
                                // to come back to this patient before the click is retried.
                                await searchPage.openPatientForm(registered);
                            },
                        });
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

                    if (summary.underFiveChecklist.length > 0) {
                        test.info().annotations.push({
                            type: 'under-5 checklist',
                            description: summary.underFiveChecklist.join('; '),
                        });
                    }
                },
            },
            {
                module: 'Case History',
                title: 'Save the case history',
                run: () => caseHistoryPage.saveAndExpectNextPage(dialogMessages),
            },
            {
                module: 'Prescription (Centre)',
                title: 'Find the visit the case history raised',
                run: async () => {
                    const listedRow = await prescriptionPage.expectPrescriptionFor(registered);
                    console.log(`Prescription (Centre) now lists: ${listedRow}`);
                },
            },
            {
                module: 'Doctor Selection',
                title: 'Open Doctor Selection for that visit',
                // This is the cue for the second browser. The screen opens either way: the
                // row's doctor icon takes the click once anyone at the centre is on duty,
                // and while nobody is, the app kills the icon with pointer-events: none but
                // leaves its href alone - the same plain GET - so the run lands on Doctor
                // Selection regardless and simply finds no doctor cards on it yet. That is
                // the state the doctor's browser is opened into, and the reload two stages
                // down is what fills the screen in.
                run: async () => {
                    const iconLive = await prescriptionPage.isDoctorSelectionClickable(registered);

                    prescriptionId = await prescriptionPage.openDoctorSelectionFor(registered, {
                        allowWhileNoDoctorOnDuty: true,
                    });
                    await doctorSelection.expectLoaded(prescriptionId);

                    test.info().annotations.push({
                        type: 'doctor selection',
                        description:
                            `prescription ${prescriptionId || '(id not in the link)'} for ` +
                            `${registered.displayId}, opened with the doctor icon ` +
                            `${iconLive ? 'live' : 'still disabled (nobody on duty yet)'}`,
                    });
                    console.log(
                        `Browser 1 is on Doctor Selection for prescription ${prescriptionId}; ` +
                            'opening the doctor browser now'
                    );
                },
            },
            {
                module: 'Doctor Session',
                title: 'Open browser 2 and sign the doctor in',
                // The second session starts here, with browser 1 sitting on Doctor
                // Selection and still signed in as the centre. Its own chromium process
                // and its own context: separate cookies and storage, so the doctor's login
                // and the centre's coexist instead of evicting one another. Nothing below
                // is given browser 1's `page`, and browser 1 is never given this one.
                run: async () => {
                    const headless = test.info().project.use.headless ?? true;

                    doctorBrowser = await chromium.launch({
                        headless,
                        slowMo: Number(process.env.E2E_SLOW_MO ?? 800),
                        args: [
                            // Chrome's camera and microphone prompt is browser chrome, drawn
                            // outside the page, so no locator can reach it and a run that
                            // waits for one hangs behind it. The first answers the prompt,
                            // the second hands the call a synthetic camera and microphone so
                            // a machine with neither still gets a working media stream.
                            '--use-fake-ui-for-media-stream',
                            '--use-fake-device-for-media-stream',
                            // Put the doctor's window beside the patient's rather than on
                            // top of it, so a watched run shows both sessions at once.
                            `--window-position=${doctorWindowPosition}`,
                            `--window-size=${doctorWindowSize}`,
                        ],
                    });

                    doctorContext = await doctorBrowser.newContext({
                        ...devices['Desktop Chrome'],
                        // Granted through the context as well, so the page's own
                        // getUserMedia is answered even where the flags above are ignored.
                        permissions: ['camera', 'microphone'],
                        baseURL: test.info().project.use.baseURL,
                    });

                    doctorPage = await doctorContext.newPage();
                    doctorLogin = new LoginPage(doctorPage);
                    doctorHome = new DoctorHomePage(doctorPage);
                    prescriptionForm = new PrescriptionFormPage(doctorPage);

                    // Captured before anything is opened, so a join the app objects to
                    // reports the app's own words rather than a timeout.
                    doctorDialogMessages = prescriptionForm.captureDialogs();

                    await doctorLogin.loginExpectingHome(doctorUsername, doctorPassword);

                    test.info().annotations.push({
                        type: 'doctor session',
                        description: `${doctorUsername} signed in in a second browser context`,
                    });
                },
            },
            {
                module: 'Doctor Home',
                title: 'Bring the doctor on duty in browser 2',
                // A doctor who is not on duty cannot be handed anything: Doctor Selection
                // asks GetAvailability_of_Doctor about the one being picked and swallows
                // the click in silence when the answer is 0. In the single-browser spec
                // this is done by logging the centre out and back in; here the doctor has
                // their own browser, so the centre's session is never disturbed.
                run: async () => {
                    await doctorHome.open();
                    doctorCameOnDutyThisRun = await doctorHome.ensureCheckedIn();

                    test.info().annotations.push({
                        type: 'doctor check-in',
                        description: `${doctorUsername} ${
                            doctorCameOnDutyThisRun ? 'checked in by this run' : 'was already on duty'
                        }`,
                    });
                    console.log(
                        `Browser 2: ${doctorUsername} is on duty; browser 1 can make the handover`
                    );
                },
            },
            {
                module: 'Doctor Selection',
                title: 'Hand the visit to that doctor from browser 1',
                // Back in browser 1. The screen has to be loaded again either way: the
                // doctor cards are drawn when the page loads, and this page loaded before
                // the doctor came on duty, so a card clicked without reloading would be one
                // that was never drawn.
                //
                // It is not always still on that screen. Browser 1 sits here untouched
                // while browser 2 signs in and comes on duty, and runs have come back to
                // find it on /Home - still signed in, just moved. Reloading then only
                // reloads Home, and the handover fails with "Doctor Selection did not
                // open" two stages before anything is actually wrong. So where it is gets
                // checked rather than assumed, and the screen is re-opened from the centre
                // grid when it has wandered.
                run: async () => {
                    if (/DoctorSelection/i.test(page.url())) {
                        await page.reload();
                    } else {
                        console.log(
                            `Browser 1 is on ${page.url()} rather than Doctor Selection; ` +
                                're-opening it from Prescription (Centre)'
                        );

                        await prescriptionPage.open();
                        prescriptionId = await prescriptionPage.openDoctorSelectionFor(registered, {
                            allowWhileNoDoctorOnDuty: true,
                        });
                    }

                    await doctorSelection.expectLoaded(prescriptionId);

                    assignedDoctor = await doctorSelection.selectDoctor();
                    await doctorSelection.saveAndExpectPrescriptionCentre();

                    test.info().annotations.push({
                        type: 'doctor',
                        description: `prescription ${prescriptionId || '(id not in the link)'} for ${
                            registered.displayId
                        } assigned to ${assignedDoctor}`,
                    });
                    console.log(
                        `Assigned ${registered.displayId}'s prescription ${prescriptionId} to ` +
                            `${assignedDoctor} — the consultation is now ongoing`
                    );
                },
            },
            {
                module: 'Doctor Home',
                title: 'Find that same patient in the doctor queue',
                // By id, never by position. The queue is this doctor's whole list and the
                // patient just handed over is simply the newest arrival in it; a run that
                // took the first row would pass against somebody else's consultation on any
                // centre with a queue. The grid does not push, so it is reloaded until the
                // row is there rather than waited on for a fixed length of time.
                run: async () => {
                    queued = await doctorHome.waitForQueuedPatient(
                        { displayId: registered.displayId, prescriptionId },
                        { timeout: Number(process.env.E2E_LIVE_QUEUE_TIMEOUT ?? 180000) }
                    );

                    test.info().annotations.push({
                        type: 'queue row',
                        description:
                            `row ${queued.index + 1}: ${queued.summary} (opened by ` +
                            `${
                                queued.via === 'attending'
                                    ? 'the Attending radio'
                                    : 'the Prescription View link, already attended'
                            })`,
                    });
                    console.log(
                        `Browser 2: ${registered.displayId} is waiting in queue row ` +
                            `${queued.index + 1}: ${queued.summary}`
                    );
                },
            },
            {
                module: 'Doctor Home',
                title: 'Take that patient on',
                // Checking the Attending radio is what marks the patient as being attended;
                // a row already attended needs nothing selected and is re-entered through
                // its own View link instead. The row is read again and checked against the
                // patient before anything is clicked, because the grid re-renders whenever
                // anyone at the centre is attended.
                run: async () => {
                    queued = await doctorHome.selectQueuedPatient(queued, {
                        displayId: registered.displayId,
                        prescriptionId,
                    });
                },
            },
            {
                module: 'Prescription Form',
                title: 'Join the ongoing consultation in browser 2',
                // The queue row opens the patient summary, whose "Start video call and edit
                // prescription" opens the form — the same route a doctor clicks, through
                // the same page object the standalone doctor spec uses.
                run: async () => {
                    joinedPrescriptionId = await doctorHome.openPrescriptionForm(queued);
                    await prescriptionForm.expectLoaded(joinedPrescriptionId);

                    // Off unless E2E_VIDEO_CALL=1 asks for it; the fake camera and
                    // microphone above are what make it work when it is asked for.
                    const onCall = await prescriptionForm.startVideoCallIfRequested();

                    test.info().annotations.push({
                        type: 'joined',
                        description:
                            `prescription form ${joinedPrescriptionId} opened for ` +
                            `${registered.displayId}${onCall ? ', video call started' : ''}`,
                    });
                },
            },
            {
                module: 'Doctor Call',
                title: 'Answer the doctor call notification in browser 1',
                // The centre's half of the handover, and the half the spec used to skip.
                // Saving Doctor Selection does not put the centre into the consultation -
                // it only hands the visit over and drops browser 1 back on CentreHome.
                // What puts them in is the doctor: opening the visit from their queue
                // rings the centre, and the call arrives as a snackbar along the bottom of
                // whatever page browser 1 is sitting on, with a "Click here" in it. Until
                // somebody clicks that, the doctor is on the call alone.
                //
                // Which is why this runs here rather than straight after the Save. The
                // notification is pushed to the open page by the doctor's own click, so a
                // centre that started waiting at the Save would sit there through the
                // doctor's sign-in, check-in and queue - browser 1 is untouched across all
                // of it, so a call that did arrive early is still on screen now and is
                // answered just the same.
                //
                // Nothing is reloaded before the wait on purpose: a reload throws the
                // snackbar away, and the app does not raise it again for a call already
                // placed.
                run: async () => {
                    answeredCall = await doctorCall.answerCall();

                    // The session URL carries the consultation it belongs to -
                    // /DoctorSession/<doctor>/<centre>/<prescription>/<call> - so the
                    // centre is checked to have been rung into *this* run's visit rather
                    // than into whichever call the centre was offered. Two runs against
                    // the same centre at once is exactly when that matters.
                    if (prescriptionId) {
                        expect(
                            answeredCall.sessionId,
                            `The centre was rung into session ${answeredCall.sessionId}, which ` +
                                `is not the prescription ${prescriptionId} it handed over`
                        ).toContain(prescriptionId);
                    }

                    test.info().annotations.push({
                        type: 'doctor call',
                        description:
                            `answered from the centre notification: session ` +
                            `${answeredCall.sessionId || '(id not in the link)'}` +
                            `${answeredCall.inPopup ? ', opened in its own window' : ''}` +
                            `${
                                answeredCall.controls.length > 0
                                    ? `, offering ${answeredCall.controls.join(', ')}`
                                    : ', with no call controls on screen'
                            }`,
                    });
                    console.log(
                        `Browser 1 answered ${assignedDoctor}'s call for ` +
                            `${registered.displayId} and is on ${answeredCall.url}`
                    );
                },
            },
            {
                module: 'Live Consultation',
                title: 'Verify both sessions are live on the same consultation',
                // The point of the whole spec, so it is checked rather than assumed: the
                // doctor is in the consultation this run handed over, for the patient this
                // run registered, while the patient's own session is still signed in and
                // holding it. Checking only the doctor's half would pass just as well
                // against a consultation that had been closed and reopened.
                run: async () => {
                    const doctor = doctorPage as Page;

                    await expect(
                        doctor,
                        'Browser 2 is not on a prescription form, so no consultation was joined'
                    ).toHaveURL(/PrescriptionForm/i);

                    expect(
                        joinedPrescriptionId,
                        'The prescription form opened without an id in its URL, so there is no ' +
                            'saying which consultation the doctor is in'
                    ).not.toBe('');

                    if (prescriptionId) {
                        expect(
                            joinedPrescriptionId,
                            `Browser 2 opened prescription ${joinedPrescriptionId}, but browser 1 ` +
                                `handed over ${prescriptionId}`
                        ).toBe(prescriptionId);
                    }

                    expect(
                        `${queued.displayId} ${queued.summary}`.toUpperCase(),
                        `Queue row ${queued.index + 1} is not ${registered.displayId}`
                    ).toContain(registered.displayId.toUpperCase());

                    // The centre is in the call the doctor placed, on the session it was
                    // rung into, while browser 2 has the consultation open - the two are
                    // on it together rather than merely both signed in.
                    await expect(
                        answeredCall.page,
                        'Browser 1 left the doctor session it answered the call into'
                    ).toHaveURL(/DocCall\/DoctorSession/i);

                    // Browser 1 is asked to do something only a signed-in session can do,
                    // while browser 2 sits on the open consultation. Both being true at the
                    // same moment is what "two live sessions" means here. It is the centre
                    // leaving the call, which is why it comes after the check above.
                    await prescriptionPage.open();
                    const stillListed = await prescriptionPage.hasPrescriptionFor(registered);

                    expect(
                        stillListed,
                        'The patient session is no longer able to see its own visit on ' +
                            'Prescription (Centre), so it did not stay signed in through the ' +
                            "doctor's join"
                    ).toBe(true);

                    await expect(
                        doctor,
                        'Browser 2 left the consultation while browser 1 was being checked'
                    ).toHaveURL(/PrescriptionForm/i);

                    test.info().annotations.push({
                        type: 'live sessions',
                        description:
                            `browser 1 signed in as ${validUsername} on ${page.url()}, ` +
                            `after answering the call into session ` +
                            `${answeredCall.sessionId || '(id not in the link)'}; ` +
                            `browser 2 signed in as ${doctorUsername} on ${doctor.url()}`,
                    });
                    console.log(
                        `Both sessions are live on consultation ${joinedPrescriptionId}: the ` +
                            `centre holds ${registered.displayId}'s visit open while ` +
                            `${assignedDoctor} has the prescription form open in browser 2`
                    );
                },
            },
            {
                module: 'Prescription Form',
                title: 'Write the consultation in browser 2',
                // Every value in it comes out of the page. fill() opens a module case per
                // section of the form - diagnosis, symptoms, medicines, OTC, diagnostics,
                // referral, review - and those finer cases are what the report shows, so a
                // run says which section of the form broke rather than just "the form".
                // This stage is their container, nothing more.
                run: async () => {
                    summary = await prescriptionForm.fill(consultation, joinedPrescriptionId);

                    expect(
                        summary.medicines.length,
                        'The consultation was written with no medicine on it'
                    ).toBeGreaterThan(0);

                    const written = describePrescription(summary.medicines);

                    test.info().annotations.push({ type: 'prescription', description: written });
                    console.log(`Prescription ${joinedPrescriptionId}: ${written}`);
                },
            },
            {
                module: 'Prescription Form',
                title: 'Save the prescription from browser 2',
                // The button is the form's submit, so a save that worked leaves the page;
                // one that did not reports the app's own reason instead of being clicked
                // again.
                //
                // The exception is the stock check: a centre holding fewer of a medicine
                // than was prescribed refuses the whole save and says what to do about it,
                // so the run cuts the quantity back, takes that medicine off, or puts
                // another in its place and saves again. That is the app behaving
                // correctly, so it is reported as what was written rather than as a
                // failure.
                run: async () => {
                    const doctor = doctorPage as Page;
                    const adjustments = await prescriptionForm.saveAndExpectLeavingForm(
                        doctorDialogMessages,
                        summary
                    );

                    for (const adjustment of adjustments) {
                        test.info().annotations.push({
                            type: 'stock',
                            description:
                                `${adjustment.medicine}: ${adjustment.available} in stock against ` +
                                `${adjustment.prescribed} prescribed - ${adjustment.detail}`,
                        });
                    }

                    // What went in is no longer what was filled in, so the run says both
                    // rather than leaving the earlier annotation to be read as the truth.
                    if (adjustments.length > 0) {
                        test.info().annotations.push({
                            type: 'prescription as saved',
                            description: describePrescription(summary.medicines),
                        });
                    }

                    console.log(
                        `Saved prescription ${joinedPrescriptionId} - browser 2 is now on ` +
                            `${doctor.url()}`
                    );
                },
            },
            {
                module: 'Doctor Approval',
                title: 'Approve the saved prescription in browser 2',
                // The save comes back to the patient's summary, where the written
                // consultation waits on the doctor's own approval - until that is given the
                // queue row stays "Pending Doctor Approval" and the consultation is not
                // done. This is the step the live spec was missing: it left every
                // consultation it opened unwritten and unapproved.
                run: async () => {
                    const approved = await prescriptionForm.approveIfOffered();

                    test.info().annotations.push({
                        type: 'approval',
                        description: approved
                            ? 'approved on the patient summary after saving'
                            : 'no Approve button was offered, so nothing was left to approve',
                    });
                    console.log(
                        approved
                            ? `Approved prescription ${joinedPrescriptionId}`
                            : `Prescription ${joinedPrescriptionId} offered no Approve button`
                    );
                },
            },
        ]);
    });
});
