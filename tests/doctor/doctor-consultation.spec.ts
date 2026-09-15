import { expect, test } from '@playwright/test';
import { doctorPassword, doctorUsername } from '../config/test-env';
import { createConsultation } from '../data/consultations';
import { DoctorHomePage, type QueuedPatient } from '../pages/doctor-home.page';
import { LoginPage } from '../pages/login.page';
import {
    PrescriptionFormPage,
    type ConsultationSummary,
    type MedicineLine,
} from '../pages/prescription-form.page';
import {
    isParallelConsultation,
    signalDoctorReady,
    waitForAssigned,
} from '../support/consultation-handshake';
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

// Paced to be watchable, the way full-consultation.spec.ts is. Raise it for a slower
// walkthrough (E2E_SLOW_MO=1500) or drop it to 0 for full speed. Pair with --headed, or
// there is nothing to watch.
test.use({
    launchOptions: {
        slowMo: Number(process.env.E2E_SLOW_MO ?? 800),
        args: [
            // Sit on the right when the centre worker is also headed, so both windows
            // are visible instead of stacked.
            '--window-position=1280,0',
            // Chrome's camera and microphone prompt is browser chrome, drawn outside the
            // page, so no locator can reach it and a run that waits for one hangs behind
            // it. These two settle it before it is ever asked: the first answers the
            // prompt itself, the second hands the call a synthetic camera and microphone
            // so a machine with neither - every CI box, and this one headless - still
            // gets a working media stream instead of a failed one.
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
        ],
    },
    // Granted through the context as well, so the page's own getUserMedia is answered
    // even where the flags above are ignored.
    permissions: ['camera', 'microphone'],
});

/**
 * The doctor's half of a consultation, end to end:
 *
 *   sign in as a doctor  ->  come on duty (Check In)
 *                        ->  take a patient at random off the waiting queue
 *                        ->  open their prescription form
 *                        ->  write a consultation whose every value is drawn from the
 *                            live dropdowns at random
 *                        ->  save it, and go back off duty
 *
 * This is the recorded session in tools/recorded/recording.spec.ts turned into something
 * that can be run twice. The recording hard-codes the doctor's own password, the patient
 * id DH3951887, the prescription id 7327978, the appointment date "30", and addresses
 * every field on the form either by the cell it sat in that afternoon
 * (`#prescriptionTable > tr:nth-child(3) > td:nth-child(3) > ...`) or by an index across
 * the whole page (`getByRole('textbox', { name: 'Dosage' }).nth(0)`, one of six matches).
 * None of that survives a second run, let alone a second environment.
 *
 * Here nothing is pinned. The credentials come from the environment, the patient is
 * whichever one is actually waiting, the prescription id is read off the page the queue
 * row opened, and every category, medicine, dosage, frequency, route, test, department
 * and appointment date is chosen at random from what the app itself offers at that
 * moment — so two runs write two different prescriptions, and a catalogue that differs
 * between UAT and production changes nothing about the test.
 *
 * How much of the form gets filled is random too (see tests/data/consultations.ts): one
 * to three medicines, one to three symptoms, one to three diagnostic tests, and the OTC
 * line on a coin flip. The Referred To department and the Review After date are written
 * every run - Review After is required on every consultation, and an empty one is a
 * readonly box the browser will not complain about, so the save dies without a word.
 *
 * The consultation is one Playwright test because it has to be - one doctor, one
 * session, one patient taken off the queue - but it is reported as one test case per
 * module it goes through: coming on duty, taking the patient, each section of the
 * prescription form, the save and the approval all get their own row, their own
 * timing and their own error. See tests/support/module-case.ts.
 *
 * The one thing it needs is a patient in the queue. Prescriptions reach a doctor by being
 * handed over on Doctor Selection, which tests/patient/full-consultation.spec.ts does end
 * to end — `npm run test:consultation-flow:headed` starts both workers together so this
 * window stays open on Doctor Home while the centre registers and assigns, then opens
 * that patient rather than a random leftover. Run this spec alone against a doctor who
 * already has a queue.
 */
test.describe('Doctor consultation: queue to saved prescription', () => {
    test.describe.configure({ mode: 'serial' });

    // Waiting for the centre worker to assign, then up to three medicines and three
    // tests at demo pace — well past the default.
    test.setTimeout(1500000);

    /**
     * Whether this run was the one that brought the doctor on duty. A doctor who was
     * already checked in was someone else's doing and is left that way - checking them
     * out would take the centre's own next handover down with it, since Doctor Selection
     * only offers a doctor who is on duty.
     */
    let cameOnDutyThisRun = false;

    test.afterEach(async ({ page }) => {
        if (cameOnDutyThisRun) {
            await new DoctorHomePage(page).checkOut().catch(() => undefined);
        }

        await new LoginPage(page).logout();
    });

    test('writes and saves a prescription for a waiting patient', async ({ page }) => {
        const loginPage = new LoginPage(page);
        const doctorHome = new DoctorHomePage(page);
        const prescriptionForm = new PrescriptionFormPage(page);

        const consultation = createConsultation();
        const dialogMessages = prescriptionForm.captureDialogs();

        // Carried from one module to the next: the queue row decides which patient the
        // rest of the run is about, and the prescription id read off it is what every
        // later module is held to.
        let waiting!: QueuedPatient;
        let prescriptionId = '';
        let summary!: ConsultationSummary;

        await runModuleCases([
            {
                module: 'Login',
                title: 'Sign in as the doctor',
                // The recording types Dr.Demo / Sandbox@1234 straight into the page; the
                // account lives in .env instead, so the password is not in the repo and
                // the spec runs against whichever doctor an environment has.
                run: () => loginPage.loginExpectingHome(doctorUsername, doctorPassword),
            },
            {
                module: 'Doctor Home',
                title: 'Come on duty with Check In',
                // A doctor who is checked out is not offered any consultation, and the
                // app says nothing about why — so this is done explicitly rather than
                // left to whatever state the previous run happened to leave behind.
                run: async () => {
                    await doctorHome.open();
                    const cameOnDuty = await doctorHome.ensureCheckedIn();
                    cameOnDutyThisRun = cameOnDuty;
                    test.info().annotations.push({
                        type: 'doctor',
                        description: `${doctorUsername}, ${
                            cameOnDuty ? 'checked in by this run' : 'already on duty'
                        }`,
                    });

                    if (isParallelConsultation()) {
                        signalDoctorReady();
                    }
                },
            },
            {
                module: 'Doctor Home',
                title: 'Take a waiting patient off the queue',
                // Paired with the centre worker, this is the patient that worker just
                // assigned. Alone, it is random: `#optradio` in the recording is the id
                // *every* row's radio carries, so it only ever meant "whoever is first",
                // and two runs against one centre would collide on them.
                run: async () => {
                    if (isParallelConsultation()) {
                        const assigned = await waitForAssigned();
                        waiting = await doctorHome.waitForPatient(assigned.displayId);
                    } else {
                        waiting = await doctorHome.selectRandomWaitingPatient();
                    }
                    test.info().annotations.push({
                        type: 'patient',
                        description:
                            `queue row ${waiting.index + 1}${
                                waiting.displayId ? ` — ${waiting.displayId}` : ''
                            }: ${waiting.summary} (opened by ${
                                waiting.via === 'attending'
                                    ? 'the Attending radio'
                                    : 'the Prescription View link, already attended'
                            })`,
                    });
                    console.log(
                        `Opening consultation for queue row ${waiting.index + 1}: ${waiting.summary}`
                    );
                },
            },
            {
                module: 'Prescription Form',
                title: 'Open the consultation for that patient',
                // The form is held to the id the queue row opened — the queue is the
                // doctor's whole list, so landing on the right screen for the wrong
                // patient is the failure worth catching.
                run: async () => {
                    prescriptionId = await doctorHome.openPrescriptionForm(waiting);
                    await prescriptionForm.expectLoaded(prescriptionId);
                    await prescriptionForm.startVideoCallIfRequested();
                },
            },
            {
                module: 'Prescription Form',
                title: 'Write the consultation',
                // Every value in it comes out of the page. fill() opens a module case per
                // section of the form — diagnosis, symptoms, medicines, OTC, diagnostics,
                // referral, review — and those finer cases are what the report shows, so a
                // run says which section of the form broke rather than just "the form".
                // This stage is their container, nothing more.
                run: async () => {
                    summary = await prescriptionForm.fill(consultation, prescriptionId);
                },
            },
            {
                module: 'Prescription Form',
                title: 'Check what was written',
                run: async () => {
                    expect(
                        summary.medicines.length,
                        'The prescription was saved with no medicine on it'
                    ).toBeGreaterThan(0);

                    for (const line of summary.medicines) {
                        expect(line.category, 'A prescription line has no category').not.toBe('');
                        expect(line.medicine, 'A prescription line has no medicine').not.toBe('');
                    }

                    // Distinct picks, not the same medicine three times over — the point of
                    // drawing at random is that the run covers different rows of the
                    // catalogue each time.
                    const prescribed = summary.medicines.map((line) => line.medicine);
                    expect(
                        new Set(prescribed).size,
                        `The same medicine was prescribed twice: ${prescribed.join(', ')}`
                    ).toBe(prescribed.length);

                    const written = describePrescription(summary.medicines);

                    test.info().annotations.push({ type: 'prescription', description: written });
                    console.log(`Prescription ${prescriptionId}: ${written}`);

                    if (summary.provisionalDiagnosis) {
                        test.info().annotations.push({
                            type: 'provisional diagnosis',
                            description: summary.provisionalDiagnosis,
                        });
                    }
                    if (summary.symptoms.length > 0) {
                        test.info().annotations.push({
                            type: 'symptoms',
                            description: summary.symptoms.join('; '),
                        });
                    }
                    if (summary.diagnosticTests.length > 0) {
                        test.info().annotations.push({
                            type: 'diagnostic tests',
                            description: summary.diagnosticTests.join('; '),
                        });
                    }
                    if (summary.otcMedicine) {
                        test.info().annotations.push({
                            type: 'OTC',
                            description: summary.otcMedicine,
                        });
                    }
                    if (summary.referral) {
                        test.info().annotations.push({
                            type: 'referral',
                            description: summary.referral,
                        });
                    }
                    if (summary.reviewDate) {
                        test.info().annotations.push({
                            type: 'review after',
                            description: summary.reviewDate,
                        });
                    }
                },
            },
            {
                module: 'Prescription Form',
                title: 'Save the prescription',
                // The button is the form's submit, so a save that worked leaves the page;
                // one that did not reports the app's own reason instead of being clicked
                // again.
                //
                // The exception is the stock check: a centre that holds one of a medicine
                // refuses the whole save over that line and says what to do about it, so
                // the run cuts the quantity back, takes the medicine off, or prescribes
                // another in its place and saves again. That is the app behaving
                // correctly, so it is reported as what was written rather than as a
                // failure - and the summary is brought in line with it, since what went
                // in is no longer quite what was filled in.
                run: async () => {
                    const adjustments = await prescriptionForm.saveAndExpectLeavingForm(
                        dialogMessages,
                        summary
                    );

                    for (const adjustment of adjustments) {
                        test.info().annotations.push({
                            type: 'stock',
                            description:
                                `${adjustment.medicine}: ${adjustment.available} in stock against ` +
                                `${adjustment.prescribed} prescribed — ${adjustment.detail}`,
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
                        `Saved prescription ${prescriptionId} — the run is now on ${page.url()}`
                    );
                },
            },
            {
                module: 'Doctor Approval',
                title: 'Approve the saved prescription',
                // The save comes back to the patient's summary, where the written
                // consultation waits on the doctor's own approval — until that is given
                // the queue row stays "Pending Doctor Approval" and the consultation is
                // not done.
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
                            ? `Approved prescription ${prescriptionId}`
                            : `Prescription ${prescriptionId} offered no Approve button`
                    );
                },
            },
        ]);
    });
});
