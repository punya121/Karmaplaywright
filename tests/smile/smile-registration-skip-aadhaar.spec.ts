import { expect, test } from '@playwright/test';
import { smileCredentials } from '../config/test-env';
import { createSmilePrescription } from '../data/smile-patients';
import { LoginPage } from '../pages/login.page';
import { SmilePrescriptionPage } from '../pages/smile-prescription.page';
import { runModuleCases } from '../support/module-case';

/**
 * The SMILE centre's Registration > Prescription with the Aadhaar left out at first:
 *
 *   sign in as the SMILE centre  ->  Registration > » Prescription
 *                                ->  a new random patient and a full prescription, the
 *                                    same as smile-registration.spec.ts, but with the
 *                                    Aadhaar box left blank
 *                                ->  Save - and if the form refuses it (an alert, the
 *                                    red message under the Aadhaar box, or the browser's
 *                                    required-field check), type a random Aadhaar and
 *                                    Save again
 *                                ->  Approve
 *
 * A form that takes the save without an Aadhaar is not a failure here: the run notes it
 * and goes on to approve. Credentials come from E2E_SMILE_USERNAME / E2E_SMILE_PASSWORD.
 *
 *   npm run test:smile-skip-aadhaar
 *   npm run test:smile-skip-aadhaar:headed
 */
// Paced for a demo: every browser action waits 1000ms so each step can be followed on
// screen. E2E_SLOW_MO overrides it (0 = full speed, 1500 = slower still).
test.use({
    launchOptions: { slowMo: Number(process.env.E2E_SLOW_MO ?? 1000) },
});

test.describe('SMILE registration: skip Aadhaar, then add it when the form asks', () => {
    test.describe.configure({ mode: 'serial' });

    test.setTimeout(1200000);

    test.afterEach(async ({ page }) => {
        await new LoginPage(page).logout();
    });

    test('saves without Aadhaar, adds a random one when refused, and approves', {
        tag: ['@journey', '@smile'],
    }, async ({ page }) => {
        const { username, password } = smileCredentials();
        const loginPage = new LoginPage(page);
        const smilePage = new SmilePrescriptionPage(page);
        const data = createSmilePrescription();
        const dialogMessages = smilePage.captureDialogs();

        let prescriptionId = '';
        let refusal: string | null = null;

        await runModuleCases([
            {
                module: 'Login',
                title: 'Sign in as the SMILE centre',
                run: () => loginPage.loginExpectingHome(username, password),
            },
            {
                module: 'SMILE Prescription',
                title: 'Open Registration > Prescription',
                run: () => smilePage.openFromHome(),
            },
            {
                module: 'SMILE Prescription',
                title: 'Fill the patient and the prescription, skipping Aadhaar',
                run: async () => {
                    const summary = await smilePage.fill(data, { skipAadhaar: true });

                    await expect(page.locator('#patient_aadhaar')).toHaveValue('');
                    expect(summary.provisionalDiagnoses).toHaveLength(data.diagnosisCount);

                    console.log(
                        `patient ${data.patient.name}, ${data.patient.gender}, ` +
                            `mobile ${data.patient.mobile} - Aadhaar left blank`
                    );
                },
            },
            {
                module: 'SMILE Prescription',
                title: 'Save without Aadhaar',
                run: async () => {
                    refusal = await smilePage.saveWithoutAadhaar(dialogMessages);

                    test.info().annotations.push({
                        type: 'aadhaar skipped',
                        description: refusal
                            ? `form refused the save: ${refusal}`
                            : 'form saved without an Aadhaar',
                    });
                    console.log(
                        refusal
                            ? `Save without Aadhaar was refused: ${refusal}`
                            : 'Save without Aadhaar went through'
                    );
                },
            },
            {
                module: 'SMILE Prescription',
                title: 'Enter a random Aadhaar and save',
                run: async () => {
                    if (refusal) {
                        await smilePage.fillAadhaar(data.patient.aadhaar);
                        test.info().annotations.push({
                            type: 'aadhaar',
                            description: `entered ${data.patient.aadhaar} after the refusal`,
                        });

                        const adjustments = await smilePage.save(dialogMessages);
                        for (const adjustment of adjustments) {
                            test.info().annotations.push({
                                type: 'stock',
                                description:
                                    `${adjustment.medicine}: ${adjustment.available} in stock against ` +
                                    `${adjustment.prescribed} prescribed — ${adjustment.detail}`,
                            });
                        }
                    }

                    prescriptionId = smilePage.savedPrescriptionId();
                    console.log(`Saved prescription ${prescriptionId} — now on ${page.url()}`);
                },
            },
            {
                module: 'SMILE Approval',
                title: 'Approve the saved prescription',
                run: async () => {
                    await smilePage.approve();

                    test.info().annotations.push({
                        type: 'approval',
                        description: `prescription ${prescriptionId} for ${data.patient.name} approved`,
                    });
                    console.log(`Approved prescription ${prescriptionId}`);
                },
            },
        ]);
    });
});
