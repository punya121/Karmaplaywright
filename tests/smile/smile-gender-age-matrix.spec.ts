import type { Page } from '@playwright/test';
import { createSmilePrescription, type SmilePrescriptionOptions } from '../data/smile-patients';
import type { SmilePrescriptionPage } from '../pages/smile-prescription.page';
import { runModuleCases } from '../support/module-case';
import { expect, openBlankPrescriptionForm, test } from './smile.fixture';

/** The fixtures one pass of the journey needs. See tests/smile/smile.fixture.ts. */
type SmileRun = { page: Page; smilePage: SmilePrescriptionPage; dialogs: string[] };

/**
 * Three SMILE registrations in one run, one after another, and one report covering all
 * three: a man, then a woman, then a child under five.
 *
 *   1. Male    - gender pinned to Male, so no gynaecology and no ANC / PNC section.
 *   2. Female  - gender pinned to Female, drawn inside the 14-49 band the form opens the
 *                gynaecology block for, and put on a random ANC or PNC visit.
 *   3. Child   - under five, so the age goes in as months (6-59, drawn) and the gender is
 *                drawn rather than pinned. The MUAC reading and the under-5 screening
 *                checklist are the form's to offer and it withholds both from this
 *                centre's division, so the child's run records that rather than filling
 *                them. See SmilePrescriptionPage.underFiveScreeningApplies().
 *
 * Each one is the whole journey - register the patient, fill the prescription, Save,
 * Approve - against a fresh random patient, with every symptom, test, medicine, village
 * and department picked out of the centre's own live dropdowns. Nothing is shared between
 * the three but the sign-in.
 *
 * WHY THESE THREE, IN THIS ORDER
 *
 * The form is three different forms depending on who is in front of it, and the
 * difference is what this file is for. The male run is the plain form; the female run
 * adds the two maternal sections; the child run swaps years for months, which changes the
 * age limits, the vitals bands and the Aadhaar label. Run together they say in one report
 * whether all three shapes of the form still save and approve.
 *
 * ONE SIGN-IN, NOT THREE
 *
 * The centre account only allows a handful of concurrent sessions, so this file uses the
 * SMILE fixture: the worker signs in once, and each test starts from that session's
 * cookie on a blank Registration > Prescription form. Three separate sign-ins would spend
 * three session slots on one run. See tests/smile/smile.fixture.ts.
 *
 * ONE REPORT, IN THAT ORDER
 *
 * `mode: 'default'` runs the three in the order they are written, in one worker, and -
 * unlike `serial` - lets the second and third run even when the first has failed, so the
 * report is never missing a row because of an earlier failure. Each one fills the form
 * under its own module name (SMILE Male / SMILE Female / SMILE Child), so one run writes
 * one workbook with the three blocks of rows in that order:
 *
 *     reports/runs/<run id>/Test-Execution-Report.xlsx
 *
 *   npm run test:smile-matrix
 *   npm run test:smile-matrix:headed
 *   npm run report                      opens the newest run's report
 */

// Paced so a run can be followed on screen, the same 500ms the happy-path SMILE spec
// uses. E2E_SLOW_MO overrides it (0 = full speed, for CI).
test.use({
    launchOptions: { slowMo: Number(process.env['E2E_SLOW_MO'] ?? 500) },
});

test.describe('SMILE registration: a man, a woman and a child under five', () => {
    // Written order, one worker, and a failure in one does not skip the others.
    test.describe.configure({ mode: 'default' });

    // One long form each - several selectize round trips per row, at a demo pace.
    test.setTimeout(1200000);

    /**
     * One patient end to end: open a blank form, fill it, save it, approve it. `module`
     * is the name this pass's rows carry in the report; `options` is what makes the
     * patient a man, a woman or a child.
     */
    async function registerPrescribeAndApprove(
        module: string,
        options: SmilePrescriptionOptions,
        { page, smilePage, dialogs }: SmileRun
    ): Promise<void> {
        const data = createSmilePrescription(options);
        let prescriptionId = '';

        await runModuleCases([
            {
                module,
                title: 'Open Registration > Prescription',
                run: () => openBlankPrescriptionForm(page, smilePage),
            },
            {
                module,
                title: 'Fill the patient and the prescription',
                // fill() opens a module case per section, and those are the rows the
                // report shows. This stage is their container.
                run: async () => {
                    const summary = await smilePage.fill(data, { module });

                    expect(summary.symptoms).toHaveLength(data.caseHistory.symptomCount);
                    expect(summary.pocTests).toHaveLength(data.caseHistory.testCount);
                    expect(summary.provisionalDiagnoses).toHaveLength(data.diagnosisCount);

                    // The point of the three runs: each shape of the form has to have
                    // shown the sections that belong to it, and none of the others.
                    if (data.underFive) {
                        // The under-5 screening is the form's to offer: it withholds the
                        // MUAC row and the checklist from division 5, which SMILE is, so
                        // on this centre a child has neither and that is not a failure.
                        // Where the form does offer them, an empty section is one. See
                        // SmilePrescriptionPage.underFiveScreeningApplies().
                        if (summary.underFiveScreeningOffered) {
                            expect(
                                summary.underFiveScreening,
                                'A child under five got no under-5 screening section'
                            ).not.toHaveLength(0);
                        } else {
                            test.info().annotations.push({
                                type: 'under-5',
                                description:
                                    'the division this centre belongs to is not offered the MUAC ' +
                                    'reading or the under-5 screening checklist on Registration > Prescription',
                            });
                        }
                        expect(
                            summary.female,
                            'A child under five was shown the gynaecology section'
                        ).toBeNull();
                    } else if (data.patient.gender === 'Female') {
                        expect(
                            summary.female,
                            'A woman of 14-49 got no gynaecology / ANC / PNC section'
                        ).not.toBeNull();
                    } else {
                        expect(
                            summary.female,
                            'A male patient was shown the gynaecology section'
                        ).toBeNull();
                    }

                    const described = [
                        `patient ${data.patient.name}, ${data.patient.age} ${data.patient.ageUnit}, ` +
                            `${data.patient.gender}, mobile ${data.patient.mobile}, village ${summary.village}`,
                        `doctor ${summary.doctor}, staff ${summary.assistingStaff}`,
                        `symptoms: ${summary.symptoms.join(', ')}`,
                        `PoC tests: ${summary.pocTests.join(', ')}`,
                        ...(data.underFive
                            ? [
                                  `under-5: ${
                                      summary.underFiveScreening.join('; ') ||
                                      'not offered to this division'
                                  }`,
                              ]
                            : []),
                        ...(summary.female ? [`female: ${summary.female}`] : []),
                        `diagnoses: ${summary.provisionalDiagnoses.join(', ')} (${summary.classification})`,
                        `medicines: ${summary.medicines.map((line) => line.medicine).join(', ')}`,
                        `OTC: ${summary.otcMedicine ?? 'none'}`,
                        `diagnostics: ${summary.diagnosticTests.join(', ') || 'none'}`,
                        `referral: ${summary.referral ?? 'none'}, review: ${summary.reviewDate}`,
                    ];

                    test.info().annotations.push({
                        type: module.toLowerCase(),
                        description: described.join(' | '),
                    });
                    console.log(`${module}\n${described.join('\n')}`);
                },
            },
            {
                module,
                title: 'Save the prescription',
                // A save the centre's stock refuses is edited and saved again - see
                // PrescriptionFormPage.saveAndExpectLeavingForm().
                run: async () => {
                    const adjustments = await smilePage.save(dialogs);

                    for (const adjustment of adjustments) {
                        test.info().annotations.push({
                            type: 'stock',
                            description:
                                `${adjustment.medicine}: ${adjustment.available} in stock against ` +
                                `${adjustment.prescribed} prescribed — ${adjustment.detail}`,
                        });
                    }

                    prescriptionId = smilePage.savedPrescriptionId();
                    console.log(`${module}: saved prescription ${prescriptionId} — now on ${page.url()}`);
                },
            },
            {
                module: `${module} Approval`,
                title: 'Approve the saved prescription',
                run: async () => {
                    await smilePage.approve();

                    test.info().annotations.push({
                        type: 'approval',
                        description: `prescription ${prescriptionId} for ${data.patient.name} approved`,
                    });
                    console.log(`${module}: approved prescription ${prescriptionId}`);
                },
            },
        ]);
    }

    test('1. Male: register, prescribe, save and approve', {
        tag: ['@journey', '@smile'],
    }, async ({ page, smilePage, dialogs }) => {
        await registerPrescribeAndApprove('SMILE Male', { gender: 'Male' }, {
            page,
            smilePage,
            dialogs,
        });
    });

    test('2. Female: register, prescribe, save and approve', {
        tag: ['@journey', '@smile'],
    }, async ({ page, smilePage, dialogs }) => {
        await registerPrescribeAndApprove('SMILE Female', { gender: 'Female' }, {
            page,
            smilePage,
            dialogs,
        });
    });

    test('3. Child under five: register, prescribe, save and approve', {
        tag: ['@journey', '@smile'],
    }, async ({ page, smilePage, dialogs }) => {
        // The child's gender is drawn here rather than left to the factory so that it
        // stays random even on a run where E2E_SMILE_GENDER is pinning the other two.
        // The age is drawn too - 6 to 59 months - inside createSmilePrescription().
        const gender = Math.random() < 0.5 ? 'Male' : 'Female';

        await registerPrescribeAndApprove('SMILE Child', { underFive: true, gender }, {
            page,
            smilePage,
            dialogs,
        });
    });
});
