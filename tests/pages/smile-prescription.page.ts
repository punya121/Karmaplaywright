import { expect, type Locator, type Page } from '@playwright/test';
import { baseUrl } from '../config/test-env';
import type { ConsultationData } from '../data/consultations';
import type { PatientRegistrationData } from '../data/patients';
import type {
    AncDetails,
    FemaleHealthData,
    HealthWorker,
    PncDetails,
    SmilePrescriptionData,
} from '../data/smile-patients';
import { moduleCase } from '../support/module-case';
import { CaseHistoryPage } from './case-history.page';
import { PrescriptionFormPage, type MedicineLine } from './prescription-form.page';
import { isVisibleWithin, openSelectize, pickRandomOption, randomInt } from './selectize';

export type SmilePrescriptionSummary = {
    village: string | null;
    doctor: string;
    assistingStaff: string;
    symptoms: string[];
    pocTests: string[];
    /** The main provisional diagnosis first, then each "Add Another Diagnosis" row. */
    provisionalDiagnoses: string[];
    classification: string | null;
    /** What the gynaecology and ANC / PNC sections were filled with, null for a man. */
    female: string | null;
    medicines: MedicineLine[];
    otcMedicine: string | null;
    diagnosticTests: string[];
    referral: string | null;
    reviewDate: string | null;
    comments: string | null;
};

/**
 * Registration > » Prescription on the SMILE centre: /PrescriptionForm with no id, which
 * registers a new patient and writes their whole prescription on one screen - patient
 * details, vitals, symptoms, point-of-care tests, diagnosis, medicines, OTC items,
 * diagnostic tests, referral, review date and comments - and saves to the patient's
 * PrescriptionView, where it is approved.
 *
 * Most of the form is the same markup the case history and the doctor's prescription
 * form are built from (the same #weight, #symptomsTable, PoC grid, #prescriptionTable,
 * #testTable, #referral and #ReviewAfterDatePicker), so those sections are filled by
 * CaseHistoryPage and PrescriptionFormPage rather than a third copy of the same code.
 * What only this screen has - the patient block at the top, the village, the
 * doctor/assisting staff pair and the disease classification - lives here.
 */
export class SmilePrescriptionPage {
    readonly caseHistory: CaseHistoryPage;
    readonly prescription: PrescriptionFormPage;

    constructor(private readonly page: Page) {
        this.caseHistory = new CaseHistoryPage(page);
        this.prescription = new PrescriptionFormPage(page);
    }

    /** See PrescriptionFormPage.captureDialogs(): alerts are recorded, confirms accepted. */
    captureDialogs(): string[] {
        return this.prescription.captureDialogs();
    }

    async openFromHome(): Promise<void> {
        const menuLink = this.page.getByRole('link', { name: '» Prescription' });

        // The link sits in a hover menu under "Registration"; opening the menu first is
        // what a user does, and going straight to the URL covers a menu that will not open.
        await this.page
            .locator('a, li')
            .filter({ hasText: /^Registration$/ })
            .first()
            .click()
            .catch(() => undefined);

        if (await isVisibleWithin(menuLink, 3000)) {
            await menuLink.click();
        } else {
            await this.page.goto(`${baseUrl.replace(/\/$/, '')}/PrescriptionForm`);
        }

        await this.expectLoaded();
    }

    async expectLoaded(): Promise<void> {
        await expect(this.page, 'Registration > Prescription did not open').toHaveURL(
            /PrescriptionForm/i,
            { timeout: 20000 }
        );
        await expect(this.page.locator('#patient_name')).toBeVisible({ timeout: 20000 });
        await expect(this.page.locator('#SavePrescription')).toBeVisible({ timeout: 20000 });

        // The form's document-ready handler sets its own defaults (Married: Unknown,
        // Ayushman: No) and fades #spinner out when it is done; a radio checked before
        // then can be reset under the run.
        await this.page.waitForLoadState('load');
        await expect(this.page.locator('div#spinner')).toBeHidden({ timeout: 20000 });
    }

    /** Checks a radio and keeps at it until the page lets it stay checked. */
    private async checkRadio(radio: Locator): Promise<void> {
        await expect(async () => {
            await radio.check({ force: true, timeout: 2000 });
            await expect(radio).toBeChecked({ timeout: 1000 });
        }).toPass({ timeout: 15000 });
    }

    /**
     * Fills every section, top to bottom, each as its own module case so the report has
     * a row per section. See tests/support/module-case.ts.
     */
    async fill(
        data: SmilePrescriptionData,
        options: { skipAadhaar?: boolean } = {}
    ): Promise<SmilePrescriptionSummary> {
        const module = 'SMILE Prescription';
        const { patient, caseHistory, consultation, female } = data;

        await moduleCase(
            module,
            options.skipAadhaar ? 'Enter the patient details, leaving Aadhaar blank' : 'Enter the patient details',
            () => this.fillPatientDetails(patient, options)
        );
        const village = await moduleCase(module, 'Pick the village', () => this.selectVillage());

        // Only once the age is in does the form unlock the vitals (its change handler
        // lifts their readonly), which is why the patient block goes first.
        await moduleCase(module, 'Record the vitals and allergies', () =>
            this.caseHistory.recordVitals(caseHistory)
        );
        // A woman of 14-49 gets two more sections, straight under her details.
        const femaleSummary = female
            ? await moduleCase(module, 'Fill the gynaecology details', async () => {
                  await this.fillGynaecology(female);
                  return moduleCase(module, `Fill the ${female.visit.type} details`, () =>
                      this.fillMaternalVisit(female.visit)
                  );
              })
            : null;
        const { doctor, assistingStaff } = await moduleCase(
            module,
            'Confirm the doctor and assisting staff',
            () => this.ensureCareTeam()
        );
        const { symptoms } = await moduleCase(module, 'Add the symptoms', () =>
            this.caseHistory.addSymptoms(caseHistory.symptomCount)
        );
        const pocTests = await moduleCase(module, 'Record the point-of-care tests', () =>
            this.caseHistory.addTests(
                caseHistory.testCount,
                caseHistory.minTestValue,
                caseHistory.maxTestValue
            )
        );
        const provisionalDiagnoses = await moduleCase(
            module,
            `Record ${data.diagnosisCount} provisional diagnoses`,
            () => this.addDiagnoses(consultation, data.diagnosisCount)
        );
        const classification = await moduleCase(module, 'Classify the diagnosis', () =>
            this.selectClassification()
        );
        const medicines = await moduleCase(module, 'Prescribe the medicines', () =>
            this.prescription.addMedicines(consultation)
        );
        const otcMedicine = await moduleCase(module, 'Add an over-the-counter item', async () =>
            consultation.includeOtc ? await this.prescription.addOtcMedicine() : null
        );
        const diagnosticTests = await moduleCase(module, 'Order the SMILE diagnostic tests', () =>
            this.prescription.addDiagnosticTests(consultation.diagnosticTestCount, /\[SMILE\]/i)
        );
        const referral = await moduleCase(module, 'Refer the patient on', () =>
            this.prescription.addReferral(consultation)
        );
        const reviewDate = await moduleCase(module, 'Set the review date', () =>
            this.prescription.setReviewDate()
        );
        const comments = await moduleCase(module, 'Add the prescription comments', () =>
            this.addComments()
        );

        return {
            village,
            doctor,
            assistingStaff,
            symptoms,
            pocTests,
            provisionalDiagnoses,
            classification,
            female: femaleSummary,
            medicines,
            otcMedicine,
            diagnosticTests,
            referral,
            reviewDate,
            comments,
        };
    }

    async fillPatientDetails(
        patient: PatientRegistrationData,
        options: { skipAadhaar?: boolean } = {}
    ): Promise<void> {
        const page = this.page;

        await page.locator('#patient_name').fill(patient.name);
        await page.locator('#parent').fill(patient.parent);
        await this.checkRadio(page.locator(`input[name="sex"][value="${patient.gender}"]`));
        await this.checkRadio(
            page.locator(patient.ageUnit === 'months' ? '#age_unit_month' : '#age_unit_year')
        );

        // The vitals unlock on the age box's change event, which fires on blur.
        const age = page.locator('#patient_age');
        await age.fill(patient.age);
        await age.press('Tab');
        await expect(
            page.locator('input[name="weight"]'),
            'Entering the age did not unlock the vitals'
        ).not.toHaveAttribute('readonly', /.*/, { timeout: 5000 });

        await this.checkRadio(page.locator(patient.married ? '#marriedy' : '#marriedn'));
        await page.locator('#mobile').fill(patient.mobile);
        if (!options.skipAadhaar) {
            await this.fillAadhaar(patient.aadhaar);
        }
    }

    /**
     * The Aadhaar box is masked (XXXX-XXXX-1234) and keeps the real number in a hidden
     * field that only its input handler writes, so it has to be typed; on blur it asks
     * the server whether the number already belongs to someone else.
     */
    async fillAadhaar(aadhaar: string): Promise<void> {
        const field = this.page.locator('#patient_aadhaar');
        await field.click();
        await field.fill('');
        await field.pressSequentially(aadhaar, { delay: 20 });
        await field.blur();

        // A clean answer hides the message and leaves its "Checking..." text behind, so
        // the check is over once the message is hidden or says something else.
        const error = this.page.locator('#aadhaar_error');
        const stillChecking = error.filter({ visible: true, hasText: /checking/i });
        await expect(stillChecking, 'The duplicate Aadhaar check did not finish').toHaveCount(0, {
            timeout: 20000,
        });

        const refused = error.filter({
            visible: true,
            hasText: /already exists|invalid|please enter/i,
        });
        await expect(refused, 'The Aadhaar number was refused').toHaveCount(0);
    }

    /** A village out of this centre's own list, picked at random. */
    async selectVillage(): Promise<string | null> {
        const village = await pickRandomOption(
            this.page,
            this.page.getByRole('textbox', { name: 'Select a village...' }),
            { timeout: 10000 }
        );

        expect(village, "The village dropdown offered nothing to pick").not.toBeNull();

        return village;
    }

    /**
     * Doctor and Assisting Staff are required and the centre normally has them filled in
     * already. Whatever is there is kept; an empty one is picked at random.
     */
    async ensureCareTeam(): Promise<{ doctor: string; assistingStaff: string }> {
        const doctor = await this.keepOrPick('#doctorid');
        const assistingStaff = await this.keepOrPick('#nursingid');

        return { doctor, assistingStaff };
    }

    private async keepOrPick(selectId: string): Promise<string> {
        const control = this.page.locator(`${selectId} + .selectize-control`);
        const current = await this.selectedText(control);

        if (current) {
            return current;
        }

        const picked = await pickRandomOption(this.page, control, { timeout: 10000 });
        expect(picked, `${selectId} is required and offered nothing to pick`).not.toBeNull();

        return picked as string;
    }

    private async selectedText(control: Locator): Promise<string> {
        return control
            .locator('.selectize-input .item')
            .first()
            .innerText({ timeout: 3000 })
            .then((text) => text.trim())
            .catch(() => '');
    }

    /**
     * The main provisional diagnosis, then "Add Another Diagnosis" for each one after it.
     * Every extra row is a selectize of the coded diagnoses (#provisionalDiagnosis<n>),
     * required once it is on the form, so a row is only added when it will be filled.
     */
    async addDiagnoses(consultation: ConsultationData, count: number): Promise<string[]> {
        const first = await this.prescription.setProvisionalDiagnosis(consultation);
        expect(first, 'The provisional diagnosis could not be filled').not.toBeNull();

        const diagnoses = [first as string];
        const extraRows = this.page.locator(
            '#diagnosisTable select[name="provisionalDiagnosis[]"] + .selectize-control'
        );

        for (let index = 1; index < count; index += 1) {
            const before = await extraRows.count();
            await this.page.locator('#addAnotherDiagnosis').click();
            await expect(extraRows, 'Add Another Diagnosis did not add a row').toHaveCount(
                before + 1,
                { timeout: 10000 }
            );

            const picked = await pickRandomOption(this.page, extraRows.nth(before), {
                exclude: diagnoses,
                timeout: 10000,
            });
            expect(picked, 'The added diagnosis row offered nothing to pick').not.toBeNull();

            diagnoses.push(picked as string);
        }

        return diagnoses;
    }

    /** A radio in one section of the form, by its group name and value. */
    private radio(scope: string, name: string, value: string): Locator {
        return this.page.locator(`${scope} input[type="radio"][name="${name}"][value="${value}"]`);
    }

    /** A text / number / date box in one section of the form, by name. */
    private box(scope: string, name: string): Locator {
        return this.page.locator(`${scope} input[name="${name}"]`);
    }

    /**
     * Gynaecology Details - shown only to a woman aged 14-49, once her gender and age are
     * in. Every answer is set, including the ones that only open up because of another:
     * the months an irregular cycle has lasted, and the last delivery's date and type
     * once she has children and the delivery is known.
     */
    async fillGynaecology(female: FemaleHealthData): Promise<void> {
        const page = this.page;
        const scope = '#gynaedetails';

        await expect(
            page.locator(scope),
            'The gynaecology section did not open for a woman of 14-49'
        ).toBeVisible({ timeout: 10000 });

        // A jQuery UI datepicker whose keyup handler wipes anything typed, so the date is
        // handed to the picker itself - the same call its calendar makes on a click.
        await page.evaluate((iso) => {
            const [year, month, day] = iso.split('-').map(Number);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const $ = (window as unknown as { jQuery: (selector: string) => any }).jQuery;
            $('#lastMenstrual')
                .datepicker('setDate', new Date(year, month - 1, day))
                .trigger('change');
        }, female.lastMenstrual);
        await expect(
            page.locator('#lastMenstrual'),
            'Last menstruation cycle stayed empty'
        ).not.toHaveValue('');

        await this.checkRadio(this.radio(scope, 'irregularPeriods', female.irregularPeriods));
        if (female.irregularPeriods === '1') {
            const cycle = this.box(scope, 'irregularPeriodsCycle');
            await expect(cycle).toBeVisible();
            await cycle.fill(female.irregularSinceMonths);
        }

        await this.checkRadio(this.radio(scope, 'isPregnant', female.isPregnant));

        // Children above 0 is what offers the last-delivery question, on its change event.
        const children = this.box(scope, 'children');
        await children.fill(String(female.children));
        await children.press('Tab');

        if (female.lastDelivery) {
            const known = page.locator('#ldd_available');
            await expect(
                known,
                'Children were entered but no last-delivery question came up'
            ).toBeVisible();
            await known.check();

            await expect(page.locator('#lastDeliveryDiv')).toBeVisible();
            await this.box(scope, 'lastDeliveryDate').fill(female.lastDelivery.date);
            await this.checkRadio(this.radio(scope, 'lastDeliveryType', female.lastDelivery.type));
        }

        await this.checkRadio(this.radio(scope, 'isMiscarriage', female.isMiscarriage));
        await this.checkRadio(this.radio(scope, 'isSerialization', female.isSterilised));
    }

    /**
     * ANC or PNC, chosen on "Select ANC or PNC Type" - which opens that visit's own form,
     * filled here in full. Summarises what went in, for the run's record.
     */
    async fillMaternalVisit(visit: AncDetails | PncDetails): Promise<string> {
        const type = await pickRandomOption(
            this.page,
            this.page.locator('#f_type + .selectize-control'),
            { filter: new RegExp(`^\\s*${visit.type}\\s*$`), timeout: 10000 }
        );
        expect(type, `"${visit.type}" is not offered on Select ANC or PNC Type`).not.toBeNull();

        return visit.type === 'ANC' ? this.fillAnc(visit) : this.fillPnc(visit);
    }

    /**
     * The trimester dropdown. ANC shows it and requires it; the PNC form carries one too
     * but keeps it hidden, so there it is left alone rather than forced.
     */
    private async pickTrimester(selectId: string, trimester: string): Promise<boolean> {
        const control = this.page.locator(`${selectId} + .selectize-control`);

        if (!(await isVisibleWithin(control, 3000))) {
            return false;
        }

        const picked = await pickRandomOption(this.page, control, {
            filter: new RegExp(`^\\s*${trimester}\\s*$`),
            timeout: 10000,
        });
        expect(picked, `Trimester ${trimester} is not offered`).not.toBeNull();

        return true;
    }

    private async fillWorkers(
        scope: string,
        prefix: 'ANC' | 'PNC',
        workers: Record<'AWW' | 'ASHA' | 'ANM', HealthWorker>
    ): Promise<void> {
        for (const [role, worker] of Object.entries(workers)) {
            await this.box(scope, `${prefix}_NameOf${role}`).fill(worker.name);
            await this.box(scope, `${prefix}_PhoneNumberOf${role}`).fill(worker.phone);
        }
    }

    /** Today's readings and the IFA question, which both visit forms ask the same way. */
    private async fillReadings(
        scope: string,
        prefix: 'ANC' | 'PNC',
        visit: AncDetails | PncDetails
    ): Promise<void> {
        await this.box(scope, `${prefix}_HB`).fill(visit.hb);
        await this.box(scope, `${prefix}_RBS`).fill(visit.rbs);
        await this.box(scope, `${prefix}_BP`).fill(visit.bp);
        await this.box(scope, `${prefix}_Weight`).fill(visit.weight);
        await this.box(scope, `${prefix}_PulseRate`).fill(visit.pulseRate);

        await this.checkRadio(this.radio(scope, `${prefix}_IFA`, visit.takingIfa ? 'Yes' : 'No'));
        if (!visit.takingIfa) {
            // The reason box is shared by name between the two forms, so it goes by id.
            await this.page.locator(`#${prefix}_IFAReason`).fill(visit.ifaReason);
        }
    }

    private async fillAnc(visit: AncDetails): Promise<string> {
        const page = this.page;
        const scope = '#anc_form';

        await expect(page.locator(scope), 'Choosing ANC did not open the ANC form').toBeVisible({
            timeout: 10000,
        });

        await this.box(scope, 'LMP').fill(visit.lmp);
        await this.box(scope, 'EDD').fill(visit.edd);
        expect(
            await this.pickTrimester('#anc_trimester', visit.trimester),
            'The ANC form has no Trimester dropdown to fill'
        ).toBe(true);
        await this.box(scope, 'tt1').setChecked(visit.tt1);
        await this.box(scope, 'tt2').setChecked(visit.tt2);
        await this.box(scope, 'USG').fill(visit.usg);

        await this.fillReadings(scope, 'ANC', visit);
        await this.box(scope, 'NoOfPregnancies').fill(visit.noOfPregnancies);

        // Asked of a woman who has delivered before; an institution then asks which kind.
        if (visit.lastDeliveryConducted) {
            await this.checkRadio(
                this.radio(scope, 'LastDeliveryConducted', visit.lastDeliveryConducted)
            );
            if (visit.lastDeliveryConducted === 'Institution') {
                await expect(page.locator('#anc_pold')).toBeVisible();
                await this.checkRadio(
                    this.radio(scope, 'PlaceOfLastDelivery', visit.placeOfLastDelivery)
                );
            }
        }
        if (visit.previousBirthHistory) {
            await this.checkRadio(
                this.radio(scope, 'PreviousBirthHistory', visit.previousBirthHistory)
            );
        }

        await this.checkRadio(this.radio(scope, 'AnyAbortion', visit.anyAbortion));
        await this.checkRadio(
            this.radio(scope, 'CurrentDeliveryPlanned', visit.currentDeliveryPlanned)
        );
        if (visit.currentDeliveryPlanned === 'Institution') {
            await expect(page.locator('#anc_ppcd')).toBeVisible();
            await this.checkRadio(
                this.radio(scope, 'PlaceOfCurrentDelivery', visit.placeOfCurrentDelivery)
            );
        }

        await this.fillWorkers(scope, 'ANC', { AWW: visit.aww, ASHA: visit.asha, ANM: visit.anm });
        await this.box(scope, 'ComplicationsIfAny').fill(visit.complications);

        return `ANC: LMP ${visit.lmp}, EDD ${visit.edd}, trimester ${visit.trimester}, HB ${visit.hb}`;
    }

    private async fillPnc(visit: PncDetails): Promise<string> {
        const page = this.page;
        const scope = '#pnc_form';

        await expect(page.locator(scope), 'Choosing PNC did not open the PNC form').toBeVisible({
            timeout: 10000,
        });

        await this.box(scope, 'DateOfDelivery').fill(visit.dateOfDelivery);
        await this.pickTrimester('#pnc_trimester', visit.trimester);
        await this.checkRadio(this.radio(scope, 'PreviousBirthHistory', visit.birthStatus));
        await this.checkRadio(this.radio(scope, 'gender_new_birth_child', visit.newbornGender));

        await this.checkRadio(this.radio(scope, 'PlaceOfDelivery', visit.placeOfDelivery));
        if (visit.placeOfDelivery === 'Institution') {
            const institution = this.radio(
                scope,
                'PlaceOfDeliveryInst',
                visit.placeOfDeliveryInstitution
            );
            await expect(institution).toBeVisible();
            await this.checkRadio(institution);
        }

        await this.checkRadio(this.radio(scope, 'TypeOfDelivery', visit.typeOfDelivery));
        await this.checkRadio(
            this.radio(scope, 'CriedImmediatelyAfterBirth', visit.criedImmediately)
        );
        await this.checkRadio(
            this.radio(
                scope,
                'ExclusiveBreastFeedingWithin1HourOfBirth',
                visit.breastFedWithinAnHour
            )
        );

        await this.fillReadings(scope, 'PNC', visit);
        await this.box(scope, 'ChildWeight').fill(visit.childWeight);
        await this.box(scope, 'Immunization').fill(visit.immunization);
        await this.fillWorkers(scope, 'PNC', { AWW: visit.aww, ASHA: visit.asha, ANM: visit.anm });

        return (
            `PNC: delivered ${visit.dateOfDelivery} (${visit.typeOfDelivery}, ` +
            `${visit.placeOfDelivery}), newborn ${visit.newbornGender} ${visit.childWeight} kg`
        );
    }

    /** Disease Classification is required alongside the provisional diagnosis. */
    async selectClassification(): Promise<string | null> {
        const control = this.page.locator('#classification + .selectize-control');

        if (!(await isVisibleWithin(control, 5000))) {
            return null;
        }

        const picked = await pickRandomOption(this.page, control, { timeout: 10000 });
        expect(picked, 'Disease Classification offered nothing to pick').not.toBeNull();

        return picked;
    }

    /**
     * Comments > Prescription is a multi-select of the centre's preset remarks, grouped by
     * specialty. For a centre user it takes no free text, and its options are drawn by a
     * custom template that leaves off selectize's usual .option class, so they are found
     * by the data-selectable mark selectize puts on every pickable entry instead.
     *
     * Nothing is ever typed and entered here: with no free text allowed, Enter is not
     * taken by the control and submits the whole form.
     */
    async addComments(): Promise<string | null> {
        const control = this.page.locator('#prescriptionComments + .selectize-control');

        if (!(await isVisibleWithin(control, 5000))) {
            return null;
        }

        const dropdown = await openSelectize(control);
        const options = dropdown.locator('[data-selectable]').filter({ hasText: /\S/ });

        if (!(await isVisibleWithin(options.first(), 5000))) {
            await this.page.keyboard.press('Escape').catch(() => undefined);
            return null;
        }

        const texts = (await options.allInnerTexts()).map((text) => text.replace(/\s+/g, ' ').trim());
        const index = randomInt(0, texts.length - 1);
        await options.nth(index).click();
        await this.page.keyboard.press('Escape').catch(() => undefined);

        await expect(control, 'The picked comment did not stay on the form').toContainText(
            texts[index].slice(0, 20),
            { useInnerText: true }
        );

        return texts[index];
    }

    /** See PrescriptionFormPage.saveAndExpectLeavingForm(). Lands on PrescriptionView. */
    async save(dialogMessages: string[]) {
        return this.prescription.saveAndExpectLeavingForm(dialogMessages);
    }

    /**
     * Presses Save with the Aadhaar box left blank and reports what the form made of it.
     * The form can refuse in three ways - an alert() (answered by captureDialogs()), the
     * red #aadhaar_error message under the box, or the browser's own required-field check
     * - and any of them comes back as the refusal's text. A form that takes the save
     * without an Aadhaar comes back as null, already on PrescriptionView.
     */
    async saveWithoutAadhaar(dialogMessages: string[]): Promise<string | null> {
        const page = this.page;
        const formUrl = page.url();
        const alertsBefore = dialogMessages.length;
        const aadhaar = page.locator('#patient_aadhaar');
        const inlineError = page.locator('#aadhaar_error').filter({ visible: true, hasText: /\S/ });

        // Same required tickbox saveAndExpectLeavingForm() ticks before its own submit.
        const declaration = page.locator('input[type="checkbox"]:required').first();
        if (await declaration.isVisible({ timeout: 2000 }).catch(() => false)) {
            await declaration.check({ force: true }).catch(() => undefined);
        }

        await page.locator('#SavePrescription').click();

        const deadline = Date.now() + 20000;
        for (;;) {
            if (dialogMessages.length > alertsBefore) {
                return dialogMessages.slice(alertsBefore).join(' / ');
            }
            if (page.url() !== formUrl) {
                await page.waitForLoadState('load');
                return null;
            }
            if (await inlineError.count()) {
                return (await inlineError.first().innerText()).trim();
            }
            const invalid = await aadhaar
                .evaluate((field: HTMLInputElement) => (field.validity.valid ? '' : field.validationMessage))
                .catch(() => '');
            if (invalid) {
                return invalid;
            }
            if (Date.now() >= deadline) {
                // Still on the form with nothing said: the submit was cancelled quietly.
                return 'Save stayed on the form with no message';
            }
            await page.waitForTimeout(250);
        }
    }

    /** The prescription id the save landed on, from PrescriptionView?id=<id>. */
    savedPrescriptionId(): string {
        return new URL(this.page.url()).searchParams.get('id') ?? '';
    }

    /**
     * Approves the saved prescription on PrescriptionView. See
     * PrescriptionFormPage.approveIfOffered(); here the button has to be there, since
     * approving is the point of the run.
     */
    async approve(): Promise<void> {
        await expect(this.page, 'Save did not land on the prescription summary').toHaveURL(
            /PrescriptionView/i,
            { timeout: 20000 }
        );

        const approved = await this.prescription.approveIfOffered();
        expect(approved, 'PrescriptionView offered no Approve button').toBe(true);

        // An approval that went through takes the button away with it.
        await expect(
            this.page.locator('#Approve'),
            'Approve was clicked but the prescription still offers it'
        ).toBeHidden({ timeout: 20000 });
    }
}
