import { expect, test } from '@playwright/test';
import { smileCredentials } from '../config/test-env';
import { createSmilePrescription } from '../data/smile-patients';
import { LoginPage } from '../pages/login.page';
import { SmilePrescriptionPage } from '../pages/smile-prescription.page';
import { runModuleCases } from '../support/module-case';

/**
 * The SMILE centre's Registration > Prescription, end to end:
 *
 *   sign in as the SMILE centre  ->  Registration > » Prescription
 *                                ->  a new random patient (male or female - a woman
 *                                    also gets the gynaecology and ANC / PNC sections),
 *                                    their vitals, symptoms and PoC tests, 2-3
 *                                    provisional diagnoses, medicines, an OTC item,
 *                                    [SMILE] diagnostic tests, a referral, a review date
 *                                    and comments - all picked from the live dropdowns
 *                                ->  Save, which lands on PrescriptionView?id=<id>
 *                                ->  Approve
 *
 * Nothing is pinned: the patient is new every run (name, mobile and Aadhaar - the form
 * refuses an Aadhaar it has seen before), the vitals are drawn from the band their age
 * falls in, and every symptom, test, medicine, village and department is whatever the
 * centre's own dropdowns offer. Credentials come from E2E_SMILE_USERNAME /
 * E2E_SMILE_PASSWORD in .env. E2E_SMILE_GENDER=Female (or Male) pins the gender.
 *
 *   npm run test:smile-registration
 *   npm run test:smile-registration:headed
 */
// Paced slightly slower than the default so a run can be followed on screen: every
// browser action waits 500ms. E2E_SLOW_MO overrides it (0 = full speed, 1000 = slower).
test.use({
    launchOptions: { slowMo: Number(process.env.E2E_SLOW_MO ?? 500) },
});

test.describe('SMILE registration: register, prescribe, save and approve', () => {
    test.describe.configure({ mode: 'serial' });

    // One long form, several selectize round trips per row, and a demo-paced slowMo.
    test.setTimeout(1200000);

    test.afterEach(async ({ page }) => {
        await new LoginPage(page).logout();
    });

    test('registers a random patient with a full prescription and approves it', {
        tag: ['@journey', '@smile'],
    }, async ({ page }) => {
        const { username, password } = smileCredentials();
        const loginPage = new LoginPage(page);
        const smilePage = new SmilePrescriptionPage(page);
        const data = createSmilePrescription();
        const dialogMessages = smilePage.captureDialogs();

        let prescriptionId = '';

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
                title: 'Fill the patient and the prescription',
                // fill() opens a module case per section, and those are the rows the
                // report shows. This stage is their container.
                run: async () => {
                    const summary = await smilePage.fill(data);

                    expect(summary.symptoms).toHaveLength(data.caseHistory.symptomCount);
                    expect(summary.pocTests).toHaveLength(data.caseHistory.testCount);
                    expect(summary.provisionalDiagnoses).toHaveLength(data.diagnosisCount);

                    const described = [
                        `patient ${data.patient.name}, ${data.patient.age} ${data.patient.ageUnit}, ` +
                            `${data.patient.gender}, mobile ${data.patient.mobile}, village ${summary.village}`,
                        `doctor ${summary.doctor}, staff ${summary.assistingStaff}`,
                        `symptoms: ${summary.symptoms.join(', ')}`,
                        `PoC tests: ${summary.pocTests.join(', ')}`,
                        ...(summary.female ? [`female: ${summary.female}`] : []),
                        `diagnoses: ${summary.provisionalDiagnoses.join(', ')} (${summary.classification})`,
                        `medicines: ${summary.medicines.map((line) => line.medicine).join(', ')}`,
                        `OTC: ${summary.otcMedicine ?? 'none'}`,
                        `diagnostics: ${summary.diagnosticTests.join(', ') || 'none'}`,
                        `referral: ${summary.referral ?? 'none'}, review: ${summary.reviewDate}`,
                    ];

                    test.info().annotations.push({
                        type: 'smile prescription',
                        description: described.join(' | '),
                    });
                    console.log(described.join('\n'));
                },
            },
            {
                module: 'SMILE Prescription',
                title: 'Save the prescription',
                // A save the centre's stock refuses is edited and saved again - see
                // PrescriptionFormPage.saveAndExpectLeavingForm().
                run: async () => {
                    const adjustments = await smilePage.save(dialogMessages);

                    for (const adjustment of adjustments) {
                        test.info().annotations.push({
                            type: 'stock',
                            description:
                                `${adjustment.medicine}: ${adjustment.available} in stock against ` +
                                `${adjustment.prescribed} prescribed — ${adjustment.detail}`,
                        });
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
