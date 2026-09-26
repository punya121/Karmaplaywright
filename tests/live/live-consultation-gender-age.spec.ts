import { test } from '@playwright/test';
import { createSavePatient, type PatientOptions } from '../data/patients';
import {
    closeLiveSessions,
    createDoctorSession,
    runLiveConsultation,
} from './live-consultation.journey';

/**
 * The live two-browser consultation three times in one run, one report covering all
 * three: a man, then a woman, then a child under five - the same split the SMILE matrix
 * makes (tests/smile/smile-gender-age-matrix.spec.ts).
 *
 *   1. Male    - gender pinned to Male, age drawn 5-80 years.
 *   2. Female  - gender pinned to Female, age drawn 5-80 years.
 *   3. Child   - under five, so the age goes in as months (6-59, drawn), the case history
 *                shows the under-5 checklist, and the gender is drawn rather than pinned.
 *
 * Each one is the whole live journey against a fresh patient - browser 1 registers,
 * consents and raises the case history, browser 2 signs the doctor in, joins, writes,
 * saves and approves. See full-consultation-with-doctor.spec.ts for how the two sessions
 * fit together; the journey itself is live-consultation.journey.ts, shared by both specs.
 *
 * `mode: 'default'` runs the three in the order they are written, in one worker, and -
 * unlike `serial` - lets the second and third run even when the first has failed, so the
 * report is never missing a patient because of an earlier failure. Every test signs both
 * sessions out in afterEach, so only two of the account's session slots are ever in use.
 *
 *   npm run test:live-gender-age
 *   npm run test:live-gender-age:headed
 */

test.use({
    launchOptions: { slowMo: Number(process.env.E2E_SLOW_MO ?? 800) },
});

test.describe('Live consultation: a man, a woman and a child under five', () => {
    // Written order, one worker, and a failure in one does not skip the others.
    test.describe.configure({ mode: 'default' });

    test.setTimeout(Number(process.env.E2E_LIVE_TEST_TIMEOUT ?? 1800000));

    /** Browser 2, kept here so teardown can close it even when a test fails. */
    const doctorSession = createDoctorSession();

    test.afterEach(async ({ page }) => {
        await closeLiveSessions(page, doctorSession);
    });

    const patients: { title: string; options: () => PatientOptions }[] = [
        { title: '1. Male', options: () => ({ gender: 'Male', underFive: false }) },
        { title: '2. Female', options: () => ({ gender: 'Female', underFive: false }) },
        {
            title: '3. Child under five',
            // Drawn per run, so over time the child is registered as both.
            options: () => ({
                gender: Math.random() < 0.5 ? 'Male' : 'Female',
                underFive: true,
            }),
        },
    ];

    for (const { title, options } of patients) {
        test(`${title}: register, hand over and consult with a live doctor`, {
            tag: ['@journey', '@live'],
        }, async ({ page }) => {
            const patient = createSavePatient(options());

            test.info().annotations.push({
                type: 'patient profile',
                description: `${patient.gender}, ${patient.age} ${patient.ageUnit}`,
            });

            await runLiveConsultation(page, patient, doctorSession);
        });
    }
});
