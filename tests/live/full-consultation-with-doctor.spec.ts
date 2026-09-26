import { test } from '@playwright/test';
import { createSavePatient } from '../data/patients';
import {
    closeLiveSessions,
    createDoctorSession,
    runLiveConsultation,
} from './live-consultation.journey';

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

test.describe('Live consultation: the patient holds it open while a doctor joins', () => {
    test.describe.configure({ mode: 'serial' });

    // The whole journey at demo pace in browser 1, plus the doctor's join in browser 2.
    test.setTimeout(Number(process.env.E2E_LIVE_TEST_TIMEOUT ?? 1800000));

    /** Browser 2, kept here so teardown can close it even when the test fails. */
    const doctorSession = createDoctorSession();

    test.afterEach(async ({ page }) => {
        await closeLiveSessions(page, doctorSession);
    });

    test('opens a second browser at Doctor Selection and joins the same consultation', async ({
        page,
    }) => {
        // The journey itself lives in live-consultation.journey.ts, shared with
        // live-consultation-gender-age.spec.ts.
        await runLiveConsultation(page, createSavePatient(), doctorSession);
    });
});
