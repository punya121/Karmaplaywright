import {
    chromium,
    devices,
    expect,
    test,
    type Browser,
    type BrowserContext,
    type Page,
} from '@playwright/test';
import { tibetCredentials, tibetDoctor } from '../config/test-env';
import { createConsultation } from '../data/consultations';
import { createSaveTibetPatient } from '../data/tibet-patients';
import { DoctorCallPage, type AnsweredCall } from '../pages/doctor-call.page';
import { DoctorHomePage, type QueuedPatient } from '../pages/doctor-home.page';
import { DoctorSelectionPage } from '../pages/doctor-selection.page';
import { LoginPage } from '../pages/login.page';
import { PatientSearchPage, type IdentifiedPatient } from '../pages/patient-search.page';
import {
    PrescriptionFormPage,
    type ConsultationSummary,
    type MedicineLine,
} from '../pages/prescription-form.page';
import { PrescriptionSearchPage } from '../pages/prescription-search.page';
import { TibetCaseHistoryPage } from '../pages/tibet-case-history.page';
import { TibetRegistrationPage } from '../pages/tibet-registration.page';
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
 * One Tibet consultation, two live browser sessions, opened one after the other.
 *
 *   BROWSER 1 (the Tibet centre)                 BROWSER 2 (the doctor)
 *   ----------------------------                 ----------------------
 *   register on /TibetPatientForm
 *   case history -> Save -> OK on the
 *   abnormal-readings popup
 *   /TibetCentreHome: the visit
 *   opens Doctor Selection for it  ------------>  opened here, and not before:
 *                                                 doctor signs in, presses Check In
 *   reloads, picks the doctor, Saves
 *   the consultation is now ongoing              finds *that* patient in the queue,
 *   and this session stays signed in  <--------  takes them on, opens the consultation,
 *   is rung on TibetCentreHome, clicks            which rings the centre
 *   the "Click here" notification and
 *   joins the doctor session it opens
 *   both sessions live at once, on the same consultation
 *
 * This is tests/live/full-consultation-with-doctor.spec.ts run against the Tibet centre:
 * the same two-browser shape, the same page objects, and the Tibet half of it taken from
 * tests/tibet/tibet-full-consultation.spec.ts. What is Tibet's own is the centre's
 * screens - /TibetPatientForm, /TibetPatientSearch, /TibetPrescriptionHistoryForm,
 * /TibetCentreHome - and the abnormal-readings confirm the case history save raises,
 * which captureDialogs() answers with OK.
 *
 * Why the second browser is opened at Doctor Selection rather than at the start: that is
 * the first moment the doctor is needed. Before it there is nothing for a doctor to do -
 * no patient, no visit, nothing in any queue - and a doctor session opened earlier would
 * sit idle burning one of the account's concurrent session slots. The two are only
 * required to be live *together* from the handover onwards, and from that point they are.
 *
 * It is one Playwright test in one worker, so nothing has to be synchronised: browser 2
 * is opened by the test itself, at the line where it is wanted, and the test drives both.
 * There is no `--workers=2` and no waiting on the other half - `await` is the
 * synchronisation. What makes them genuinely independent sessions is that browser 2 is
 * its own chromium process with its own context, cookies and storage, so the doctor's
 * login cannot evict the centre's or vice versa; the `page` this test is given is never
 * handed to the doctor's page objects, and the doctor's page is never handed to the
 * centre's.
 *
 * The doctor half - the queue, the prescription form, the approval - is the shared
 * doctor's form rather than a Tibet screen, so it is the same page objects the other
 * doctor specs use. The Tibet centre lists one doctor and on UAT it is the same account;
 * see tibetDoctor().
 *
 * Run it with:  npm run test:tibet-live:headed   (both windows on screen, side by side)
 *               npm run test:tibet-live          (headless)
 */

test.use({
    launchOptions: { slowMo: Number(process.env.E2E_SLOW_MO ?? 800) },
});

/** The doctor's window is put beside the centre's so a watched run shows both at once. */
const doctorWindowPosition = process.env.E2E_DOCTOR_WINDOW_POSITION || '960,0';
const doctorWindowSize = process.env.E2E_DOCTOR_WINDOW_SIZE || '960,1040';

test.describe('Tibet live consultation: the centre holds it open while a doctor joins', () => {
    test.describe.configure({ mode: 'serial' });

    // The whole Tibet journey at demo pace in browser 1, plus the doctor's join and the
    // written consultation in browser 2.
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

        // Browser 1 last, so the centre session outlives the doctor's - the consultation
        // is held open for the whole of the doctor's visit to it, which is the point.
        await new LoginPage(page).logout().catch(() => undefined);
    });

    test('opens a second browser at Doctor Selection and joins the same Tibet consultation', {
        tag: ['@journey', '@tibet', '@live'],
    }, async ({ page }) => {
        const centre = tibetCredentials();
        const doctor = tibetDoctor();

        // --- browser 1: the Tibet centre's session --------------------------------
        const loginPage = new LoginPage(page);
        const registrationPage = new TibetRegistrationPage(page);
        const searchPage = new PatientSearchPage(page, {
            searchPath: '/TibetPatientSearch',
            patientFormPath: '/TibetPatientForm',
        });
        const prescriptionPage = new PrescriptionSearchPage(page, { path: '/TibetCentreHome' });
        const caseHistoryPage = new TibetCaseHistoryPage(page);
        const doctorSelection = new DoctorSelectionPage(page);
        const doctorCall = new DoctorCallPage(page);

        // --- browser 2: built at Doctor Selection, not before ----------------------
        let doctorLogin!: LoginPage;
        let doctorHome!: DoctorHomePage;
        let prescriptionForm!: PrescriptionFormPage;

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
        let prescriptionId = '';
        let assignedDoctor = '';
        let queued!: QueuedPatient;
        let joinedPrescriptionId = '';
        /** The call the centre answered in browser 1, once the doctor has placed it. */
        let answeredCall!: AnsweredCall;

        // What browser 2 writes into the form, and the alerts that session raises. The
        // dialogs are captured the moment the doctor's page exists, so a refused save
        // reports the app's own words instead of timing out.
        const consultation = createConsultation();
        let summary!: ConsultationSummary;
        let doctorDialogMessages: string[] = [];

        await runModuleCases([
            {
                module: 'Login',
                title: 'Sign in as the Tibet centre in browser 1',
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
                    const filled = await caseHistoryPage.fill(caseHistory);
                    expect(filled.symptoms).toHaveLength(caseHistory.symptomCount);
                    expect(filled.tests).toHaveLength(caseHistory.testCount);

                    test.info().annotations.push({
                        type: 'severity indicator',
                        description: filled.severity.join('; '),
                    });
                },
            },
            {
                module: 'Tibet Case History',
                title: 'Save the case history and confirm the abnormal readings popup',
                run: async () => {
                    await caseHistoryPage.saveAndExpectNextPage(dialogMessages);

                    const answered = caseHistoryPage.confirmations;
                    test.info().annotations.push({
                        type: 'popups answered OK',
                        description:
                            answered.length > 0
                                ? answered.join(' | ')
                                : 'none - nothing on the form was outside its normal band',
                    });
                },
            },
            {
                module: 'Tibet Centre Prescription',
                title: 'Find the visit the case history raised',
                run: async () => {
                    const listedRow = await prescriptionPage.expectPrescriptionFor(registered);
                    console.log(`Centre Prescription now lists: ${listedRow}`);
                },
            },
            {
                module: 'Doctor Selection',
                title: 'Open Doctor Selection for that visit',
                // This is the cue for the second browser. The screen opens either way: the
                // row's doctor icon takes the click once anyone at the centre is on duty,
                // and while nobody is, the app kills the icon with pointer-events: none
                // but leaves its href alone - the same plain GET - so the run lands on
                // Doctor Selection regardless and simply finds no doctor cards on it yet.
                // That is the state the doctor's browser is opened into, and the reload
                // two stages down is what fills the screen in.
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
                            // Chrome's camera and microphone prompt is browser chrome,
                            // drawn outside the page, so no locator can reach it and a run
                            // that waits for one hangs behind it. The first answers the
                            // prompt, the second hands the call a synthetic camera and
                            // microphone so a machine with neither still gets a working
                            // media stream.
                            '--use-fake-ui-for-media-stream',
                            '--use-fake-device-for-media-stream',
                            // Put the doctor's window beside the centre's rather than on
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

                    await doctorLogin.loginExpectingHome(doctor.username, doctor.password);

                    test.info().annotations.push({
                        type: 'doctor session',
                        description: `${doctor.username} signed in in a second browser context`,
                    });
                },
            },
            {
                module: 'Doctor Home',
                title: 'Bring the doctor on duty in browser 2',
                // A doctor who is not on duty cannot be handed anything: Doctor Selection
                // asks GetAvailability_of_Doctor about the one being picked and swallows
                // the click in silence when the answer is 0. In the single-browser Tibet
                // spec this is done by logging the centre out and back in; here the doctor
                // has their own browser, so the centre's session is never disturbed.
                run: async () => {
                    await doctorHome.open();
                    doctorCameOnDutyThisRun = await doctorHome.ensureCheckedIn();

                    test.info().annotations.push({
                        type: 'doctor check-in',
                        description: `${doctor.username} ${
                            doctorCameOnDutyThisRun ? 'checked in by this run' : 'was already on duty'
                        }`,
                    });
                    console.log(
                        `Browser 2: ${doctor.username} is on duty; browser 1 can make the handover`
                    );
                },
            },
            {
                module: 'Doctor Selection',
                title: 'Hand the visit to that doctor from browser 1',
                // Back in browser 1. The screen has to be loaded again either way: the
                // doctor cards are drawn when the page loads, and this page loaded before
                // the doctor came on duty, so a card clicked without reloading would be
                // one that was never drawn.
                //
                // It is not always still on that screen. Browser 1 sits here untouched
                // while browser 2 signs in and comes on duty, and runs have come back to
                // find it moved - still signed in, just elsewhere - so where it is gets
                // checked rather than assumed, and the screen is re-opened from the centre
                // grid when it has wandered.
                run: async () => {
                    if (/DoctorSelection/i.test(page.url())) {
                        await page.reload();
                    } else {
                        console.log(
                            `Browser 1 is on ${page.url()} rather than Doctor Selection; ` +
                                're-opening it from Centre Prescription'
                        );

                        await prescriptionPage.open();
                        prescriptionId = await prescriptionPage.openDoctorSelectionFor(registered, {
                            allowWhileNoDoctorOnDuty: true,
                        });
                    }

                    await doctorSelection.expectLoaded(prescriptionId);

                    assignedDoctor = await doctorSelection.selectDoctor(doctor.name);
                    await doctorSelection.saveAndExpectPrescriptionCentre();

                    test.info().annotations.push({
                        type: 'doctor',
                        description: `prescription ${prescriptionId || '(id not in the link)'} for ${
                            registered.displayId
                        } assigned to ${assignedDoctor}`,
                    });
                    console.log(
                        `Assigned ${registered.displayId}'s prescription ${prescriptionId} to ` +
                            `${assignedDoctor} - the consultation is now ongoing`
                    );
                },
            },
            {
                module: 'Doctor Home',
                title: 'Find that same patient in the doctor queue',
                // By id, never by position. The queue is this doctor's whole list and the
                // patient just handed over is simply the newest arrival in it; a run that
                // took the first row would pass against somebody else's consultation on
                // any centre with a queue. The grid does not push, so it is reloaded until
                // the row is there rather than waited on for a fixed length of time.
                run: async () => {
                    queued = await doctorHome.waitForQueuedPatient(
                        { displayId: registered.displayId, prescriptionId },
                        { timeout: Number(process.env.E2E_LIVE_QUEUE_TIMEOUT ?? 180000) }
                    );

                    test.info().annotations.push({
                        type: 'queue row',
                        description: `row ${queued.index + 1}: ${queued.summary}`,
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
                // Checking the Attending radio is what marks the patient as being
                // attended; a row already attended needs nothing selected and is
                // re-entered through its own View link instead. The row is read again and
                // checked against the patient before anything is clicked, because the grid
                // re-renders whenever anyone at the centre is attended.
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
                // The queue row opens the patient summary, whose "Start video call and
                // edit prescription" opens the form - the same route a doctor clicks,
                // through the same page object the standalone doctor spec uses.
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
                // Saving Doctor Selection does not put the centre into the consultation -
                // it only hands the visit over and drops browser 1 back on Centre
                // Prescription. What puts them in is the doctor: opening the visit from
                // their queue rings the centre, and the call arrives as a snackbar along
                // the bottom of whatever page browser 1 is sitting on, with a "Click here"
                // in it. Until somebody clicks that, the doctor is on the call alone.
                //
                // Nothing is reloaded before the wait on purpose: a reload throws the
                // snackbar away, and the app does not raise it again for a call already
                // placed.
                run: async () => {
                    answeredCall = await doctorCall.answerCall();

                    // The session URL carries the consultation it belongs to -
                    // /DoctorSession/<doctor>/<centre>/<prescription>/<call> - so the
                    // centre is checked to have been rung into *this* run's visit rather
                    // than into whichever call the centre was offered.
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
                // run registered, while the centre's own session is still signed in and
                // holding it. Checking only the doctor's half would pass just as well
                // against a consultation that had been closed and reopened.
                run: async () => {
                    const doctorSession = doctorPage as Page;

                    await expect(
                        doctorSession,
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

                    await expect(
                        answeredCall.page,
                        'Browser 1 left the doctor session it answered the call into'
                    ).toHaveURL(/DocCall\/DoctorSession/i);

                    // Browser 1 is asked to do something only a signed-in session can do,
                    // while browser 2 sits on the open consultation. Both being true at
                    // the same moment is what "two live sessions" means here. It is the
                    // centre leaving the call, which is why it comes after the check above.
                    await prescriptionPage.open();
                    const stillListed = await prescriptionPage.hasPrescriptionFor(registered);

                    expect(
                        stillListed,
                        'The centre session is no longer able to see its own visit on Centre ' +
                            "Prescription, so it did not stay signed in through the doctor's join"
                    ).toBe(true);

                    await expect(
                        doctorSession,
                        'Browser 2 left the consultation while browser 1 was being checked'
                    ).toHaveURL(/PrescriptionForm/i);

                    test.info().annotations.push({
                        type: 'live sessions',
                        description:
                            `browser 1 signed in as ${centre.username} on ${page.url()}, ` +
                            `after answering the call into session ` +
                            `${answeredCall.sessionId || '(id not in the link)'}; ` +
                            `browser 2 signed in as ${doctor.username} on ${doctorSession.url()}`,
                    });
                    console.log(
                        `Both sessions are live on consultation ${joinedPrescriptionId}: the ` +
                            `Tibet centre holds ${registered.displayId}'s visit open while ` +
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
                run: async () => {
                    summary = await prescriptionForm.fill(consultation, joinedPrescriptionId);

                    expect(
                        summary.medicines.length,
                        'The consultation was written with no medicine on it'
                    ).toBeGreaterThan(0);

                    const written = describePrescription(summary.medicines);

                    test.info().annotations.push({ type: 'prescription', description: written });

                    // The Tibet form's own required question, which the other centres'
                    // forms never ask. Reported so a run says it was answered rather than
                    // leaving a save that only worked because of it unexplained.
                    if (summary.callQuality) {
                        test.info().annotations.push({
                            type: 'audio / video quality',
                            description: `rated ${summary.callQuality}`,
                        });
                    }

                    console.log(`Prescription ${joinedPrescriptionId}: ${written}`);
                },
            },
            {
                module: 'Prescription Form',
                title: 'Save the prescription from browser 2',
                // The button is the form's submit, so a save that worked leaves the page;
                // one that did not reports the app's own reason instead of being clicked
                // again. The exception is the stock check: a centre holding fewer of a
                // medicine than was prescribed refuses the whole save and says what to do
                // about it, so the run cuts the quantity back, takes that medicine off, or
                // puts another in its place and saves again.
                run: async () => {
                    const doctorSession = doctorPage as Page;
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
                            `${doctorSession.url()}`
                    );
                },
            },
            {
                module: 'Doctor Approval',
                title: 'Approve the saved prescription in browser 2',
                // The save comes back to the patient's summary, where the written
                // consultation waits on the doctor's own approval - until that is given
                // the queue row stays "Pending Doctor Approval", the consultation is not
                // done, and the doctor is still busy with it, which is what stops the next
                // Tibet run from handing anything over.
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
