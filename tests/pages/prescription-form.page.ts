import { expect, type Locator, type Page } from '@playwright/test';
import type { ConsultationData } from '../data/consultations';
import { moduleCase } from '../support/module-case';
import {
    isVisibleWithin,
    type PickOptions,
    pickOrType,
    pickRandom,
    pickRandomOption,
    pickSmallestDoseOption,
    pickSmallestNumericOption,
    randomInt,
} from './selectize';

/**
 * E2E_HOLD_OPEN=1 (with --headed) parks the run at page.pause() once the prescription
 * has been saved, leaving the browser on the result instead of logging out and closing.
 */
const holdOpen = !!process.env.E2E_HOLD_OPEN;

/**
 * Starting the video call needs a camera and microphone the CI machine does not have, so
 * it is off unless E2E_VIDEO_CALL=1 asks for it. The save button carries the video call's
 * wording either way ("End the video call and save prescription") — it is the form's
 * submit whether or not a call was ever started.
 */
const startVideoCall = !!process.env.E2E_VIDEO_CALL;

export type MedicineLine = {
    category: string;
    medicine: string;
    dosage: string | null;
    frequency: string | null;
    duration: string | null;
    instruction: string | null;
    route: string | null;
};

/**
 * A prescription line the centre's shelves will not cover, as the form's own alert puts
 * it: "Note: <medicine> is not available for the quantity prescribed. || Available
 * Quantity in stock is 1 || Prescribed Quantity is 3."
 */
export type StockShortfall = {
    medicine: string;
    /** How many the centre holds. */
    available: number;
    /** How many the consultation asked for. */
    prescribed: number;
};

/**
 * A short line and what the run did about it — cut the quantity back, took the medicine
 * off the prescription, or (only ever for the last line standing, since a consultation
 * cannot be saved with nothing on it) prescribed another in its place.
 */
export type StockAdjustment = StockShortfall & {
    action: 'reduced' | 'removed' | 'replaced';
    /** What changed on the form, for the run's own record. */
    detail: string;
    /** The line now in its place, where one was written. */
    replacement?: MedicineLine;
};

export type ConsultationSummary = {
    prescriptionId: string;
    provisionalDiagnosis: string | null;
    symptoms: string[];
    medicines: MedicineLine[];
    otcMedicine: string | null;
    diagnosticTests: string[];
    referral: string | null;
    reviewDate: string | null;
};

/**
 * /PrescriptionForm?id=<prescription id> — the doctor's side of a consultation: the
 * provisional diagnosis, the symptoms, the medicines, any over-the-counter item, the
 * diagnostic tests to order, and an optional referral to another department, all saved
 * in one go by the button that also ends the video call.
 *
 * A recorded session of this form is almost entirely unusable as a test, and it is worth
 * saying why, because it is the same trap on every row:
 *
 *   - `#prescriptionTable > tr:nth-child(3) > td:nth-child(3) > div.selectize-control...`
 *     names a cell by where it sat that day. The grid renders spacer rows between the
 *     real ones (hence the odd child numbers) and re-renders as rows are added, so the
 *     third child is not reliably the second medicine.
 *   - `getByRole('textbox', { name: 'Dosage' }).nth(0)` matched six elements because the
 *     grid pre-renders six blank rows. An index across the whole page silently addresses
 *     the wrong row the moment the form is filled in a different order.
 *   - Once a selectize holds a value it drops its placeholder, so the name that found the
 *     field before it was filled will not find it again.
 *
 * So rows here are found by what they contain (the medicine control, the test dropdown)
 * and every field is looked up inside its own row, never by a page-wide index. Nothing
 * that goes into the form is written here either: the categories, medicines, tests,
 * departments and dosage entries are all read out of the live dropdowns and picked at
 * random, and only the boxes with no dropdown behind them fall back to generated text.
 */
export class PrescriptionFormPage {
    constructor(private readonly page: Page) {}

    /**
     * The run's own choices, kept from fill() so that a save the centre's stock refuses
     * can write a replacement line with the same fallbacks the first one was written
     * with. Null until the form has been filled.
     */
    private consultation: ConsultationData | null = null;

    /**
     * The columns of a medicine row, in the order they read on screen, for the ones a
     * short line has to be edited through afterwards. See filledRowField().
     */
    private static readonly MEDICINE_COLUMNS = {
        category: 0,
        medicine: 1,
        dosage: 2,
        howOften: 3,
        duration: 4,
    } as const;

    /**
     * The form talks through native dialogs and they need opposite answers: alert() is a
     * validation failure that cancels the submit, confirm() is the save asking to go
     * ahead. Playwright dismisses every dialog by default, which answers that confirm
     * with Cancel and kills the save in silence. Call before filling, so a blocked save
     * can name its own reason.
     */
    captureDialogs(): string[] {
        const messages: string[] = [];
        this.page.on('dialog', async (dialog) => {
            if (dialog.type() === 'alert') {
                messages.push(dialog.message().trim());
            }
            await dialog.accept().catch(() => undefined);
        });
        return messages;
    }

    /**
     * The doctor's form words its submit for the video call; the centre's own
     * Registration > Prescription form (the SMILE centre's) has no call and labels the
     * same submit plain "Save". Both are <input id="SavePrescription" name="Next">.
     */
    private saveButton(): Locator {
        return this.page
            .getByRole('button', { name: /end the video call and save prescription/i })
            .or(this.page.locator('#SavePrescription'))
            .first();
    }

    async expectLoaded(prescriptionId = ''): Promise<void> {
        await this.page.waitForLoadState('load');
        await expect(this.page, 'The prescription form did not open').toHaveURL(
            /PrescriptionForm/i,
            { timeout: 20000 }
        );

        if (prescriptionId) {
            await expect(
                this.page,
                `The prescription form opened a different consultation than the queue row (expected id ${prescriptionId})`
            ).toHaveURL(new RegExp(`[?&]id=${prescriptionId}(?:&|$)`, 'i'), { timeout: 15000 });
        }

        await expect(this.saveButton(), 'The prescription form has no save button').toBeVisible({
            timeout: 20000,
        });
    }

    /**
     * Fills the whole form and reports what it put in it. Sections the environment does
     * not render — a centre with no referral departments, a form with no OTC row — are
     * skipped rather than failed, so the same spec runs everywhere.
     *
     * Each section runs as its own module case, so the report has a row per section of
     * the form — medicines, diagnostics, referral, review — instead of one row saying
     * only that the form was filled. See tests/support/module-case.ts.
     */
    async fill(consultation: ConsultationData, prescriptionId = ''): Promise<ConsultationSummary> {
        const form = 'Prescription Form';

        this.consultation = consultation;

        const provisionalDiagnosis = await moduleCase(form, 'Record the provisional diagnosis', () =>
            this.setProvisionalDiagnosis(consultation)
        );
        const symptoms = await moduleCase(form, 'Add the symptoms', () =>
            this.addSymptoms(consultation.symptomCount)
        );
        const medicines = await moduleCase(form, 'Prescribe the medicines', () =>
            this.addMedicines(consultation)
        );
        const otcMedicine = await moduleCase(form, 'Add an over-the-counter item', async () =>
            consultation.includeOtc ? await this.addOtcMedicine() : null
        );
        const diagnosticTests = await moduleCase(form, 'Order the diagnostic tests', () =>
            this.addDiagnosticTests(consultation.diagnosticTestCount)
        );
        const referral = await moduleCase(form, 'Refer the patient on', () =>
            this.addReferral(consultation)
        );

        // Review After is the form's own required field — a red asterisk on the Review
        // fieldset, and the app refuses the submit without it — so it is set on every
        // run, not only on the ones that also refer the patient on.
        const reviewDate = await moduleCase(form, 'Set the review date', () => this.setReviewDate());

        // A blank symptom row anywhere on the grid fails the whole submit, so the form is
        // swept before it is handed back to be saved - a row this run could not fill, or
        // one the consultation came back with.
        await this.removeEmptySymptomRows();

        return {
            prescriptionId,
            provisionalDiagnosis,
            symptoms,
            medicines,
            otcMedicine,
            diagnosticTests,
            referral,
            reviewDate,
        };
    }

    /**
     * The provisional diagnosis box is a selectize that both offers the coded diagnoses
     * and accepts free text, and which of the two an environment gives depends on its
     * catalogue — so take a random coded entry where there is one and type otherwise.
     */
    async setProvisionalDiagnosis(consultation: ConsultationData): Promise<string | null> {
        const field = this.page.getByRole('textbox', { name: /provisional diagnosis/i }).first();

        if (!(await isVisibleWithin(field, 10000))) {
            return null;
        }

        return pickOrType(this.page, field, consultation.provisionalDiagnosis);
    }

    /** Symptom rows — the ones carrying a dropdown, so the header and spacers drop out. */
    private symptomRows(): Locator {
        return this.page
            .locator('#symptomsTable tr')
            .filter({ has: this.page.locator('.selectize-control') });
    }

    /**
     * What a grid already holds: the text of each row's first control, empty string for a
     * row nobody has filled. A consultation being re-opened brings its saved rows back
     * with it, and picking one of those again would either duplicate a line or quietly
     * replace it, so they are excluded from the run's own picks.
     */
    private async existingRowValues(rows: Locator): Promise<string[]> {
        return rows
            .evaluateAll((elements) =>
                elements.map((row) => {
                    const first = row.querySelector('.selectize-input');
                    return first ? (first.textContent ?? '').replace(/\s+/g, ' ').trim() : '';
                })
            )
            .catch(() => []);
    }

    /**
     * The row to write the next entry into: the first one still empty, or a freshly added
     * one once every row holds something.
     *
     * Counting from zero and expecting the grid to hold index+1 rows was only ever right
     * on a consultation nobody had written yet. A re-opened one comes back with its saved
     * rows on the grid - four symptoms from an earlier run, say - so the first "Add" left
     * it holding five rows where the run expected two, and the wait timed out on a grid
     * that was behaving perfectly.
     */
    private async nextEntryRow(rows: Locator, addButton: Locator): Promise<Locator | null> {
        const emptyIndex = await rows
            .evaluateAll((elements) =>
                elements.findIndex((row) => {
                    const first = row.querySelector('.selectize-input');
                    return !!first && !first.classList.contains('has-items');
                })
            )
            .catch(() => -1);

        if (emptyIndex >= 0) {
            return rows.nth(emptyIndex);
        }

        if (!(await isVisibleWithin(addButton, 5000))) {
            return null;
        }

        const before = await rows.count();
        await addButton.click();
        await expect(rows).toHaveCount(before + 1, { timeout: 10000 });

        return rows.nth(before);
    }

    /**
     * Drops a row that ended up with nothing in it, reporting whether it went.
     *
     * An empty row cannot just be left behind. The symptom select is a required one, so
     * the browser refuses the entire submit - "symptoms_list[] is invalid: Please select
     * an item in the list" - and the consultation is never written, however complete the
     * rest of the form is. Every row carries its own delete control for this:
     * <img id="deleteIcon" onclick="deleteCurrentRow($(this));add_removeSymptomsAlert(...)">.
     */
    private async removeRowIfEmpty(row: Locator): Promise<boolean> {
        const filled = await row
            .locator('.selectize-input.has-items')
            .count()
            .catch(() => 0);

        if (filled > 0) {
            return false;
        }

        // The id repeats on every row, so it is only ever used through the row itself.
        const remove = row.locator('#deleteIcon, [onclick*="deleteCurrentRow"]').first();

        if (!(await isVisibleWithin(remove, 3000))) {
            return false;
        }

        await remove.click().catch(() => undefined);
        return true;
    }

    /**
     * Clears any symptom row left blank before the form is submitted. Walked from the
     * bottom up so removing one does not shift the rows still to be checked.
     */
    private async removeEmptySymptomRows(): Promise<void> {
        const rows = this.symptomRows();

        for (let index = (await rows.count()) - 1; index >= 0; index -= 1) {
            await this.removeRowIfEmpty(rows.nth(index));
        }
    }

    /**
     * Records symptoms, each a distinct random pick, written into whichever rows are free
     * rather than into the first ones on the grid.
     */
    async addSymptoms(count: number): Promise<string[]> {
        const symptoms: string[] = [];

        if (!(await isVisibleWithin(this.symptomRows().first(), 5000))) {
            return symptoms;
        }

        const alreadyOnTheForm = await this.existingRowValues(this.symptomRows());

        for (let index = 0; index < count; index += 1) {
            const row = await this.nextEntryRow(
                this.symptomRows(),
                this.page.getByRole('button', { name: /add symptom/i }).first()
            );

            if (row === null) {
                break;
            }

            // The symptom itself is the row's first control; the columns after it are the
            // ones the form names, read left to right the way they are on screen.
            const symptom = await pickRandomOption(
                this.page,
                row.locator('.selectize-control').first(),
                { exclude: [...alreadyOnTheForm, ...symptoms], timeout: 10000 }
            );

            if (symptom === null) {
                // Nothing was written into it, and a blank symptom row blocks the save.
                await this.removeRowIfEmpty(row);
                break;
            }

            symptoms.push(symptom);
            await expect(row).toContainText(symptom, { useInnerText: true });

            await this.fillRowField(row, /^Duration$/i, String(randomInt(1, 14)));
            await this.fillRowField(row, /time duration/i, '');
            await this.fillRowField(row, /severity/i, '');
        }

        return symptoms;
    }

    /**
     * One column of one row. Where the column is a dropdown a random entry is taken;
     * where it is a plain box the generated fallback is typed. An empty fallback means
     * the column is a dropdown wherever it exists and there is nothing sensible to type,
     * so it is left alone rather than filled with something the form would reject.
     */
    private async fillRowField(
        row: Locator,
        name: RegExp,
        fallback: string
    ): Promise<string | null> {
        const field = row.getByRole('textbox', { name }).first();

        if (!(await isVisibleWithin(field, 3000))) {
            return null;
        }

        return fallback
            ? pickOrType(this.page, field, fallback)
            : pickRandomOption(this.page, field, { timeout: 3000 });
    }

    /**
     * A quantity column: the smallest entry its dropdown offers, or the generated
     * fallback typed in where the column is a plain box on this environment.
     */
    private async fillSmallestRowField(
        row: Locator,
        name: RegExp,
        fallback: string
    ): Promise<string | null> {
        const field = row.getByRole('textbox', { name }).first();

        if (!(await isVisibleWithin(field, 3000))) {
            return null;
        }

        const smallest = await pickSmallestNumericOption(this.page, field, { timeout: 5000 });

        return smallest ?? pickOrType(this.page, field, fallback);
    }

    /**
     * The medicine rows, minus the over-the-counter row — #OTCRow carries the same
     * medicine control, so it would otherwise be filled twice.
     */
    private medicineRows(): Locator {
        return this.page
            .locator('#prescriptionTable tr:not(#OTCRow)')
            .filter({ has: this.page.locator('.selectize-control.medicine_list') });
    }

    /**
     * Writes the prescription lines. The grid pre-renders its blank rows, so a run fills
     * the first `medicineCount` of them; where it holds fewer than that, it fills what is
     * there instead of failing over a row that does not exist.
     */
    async addMedicines(consultation: ConsultationData): Promise<MedicineLine[]> {
        const lines: MedicineLine[] = [];

        if (!(await isVisibleWithin(this.medicineRows().first(), 10000))) {
            return lines;
        }

        // "Add a drug" and "Add an OTC Item" are both id="AddDrug", so the button is taken
        // by its own wording rather than by that id.
        const addDrug = this.page.getByRole('button', { name: /^\s*Add a drug\s*$/i }).first();
        const alreadyPrescribed = await this.existingRowValues(this.medicineRows());

        for (let index = 0; index < consultation.medicineCount; index += 1) {
            const row = await this.nextEntryRow(this.medicineRows(), addDrug);

            if (row === null) {
                break;
            }

            const line = await this.fillMedicineRow(row, consultation, [
                ...alreadyPrescribed,
                ...lines.map((filled) => filled.medicine),
            ]);

            if (line === null) {
                break;
            }

            lines.push(line);
        }

        expect(
            lines.length,
            'No medicine could be written: the medicine dropdown offered nothing to pick, so ' +
                'this centre has an empty formulary'
        ).toBeGreaterThan(0);

        return lines;
    }

    /**
     * One prescription line, filled in the order it reads on screen: what kind of medicine,
     * which one, then how much, how often, for how long, how to take it and by what route.
     *
     * Category comes first for a reason — it filters the medicine list, so picking the
     * medicine before its category leaves a row whose two halves disagree.
     */
    private async fillMedicineRow(
        row: Locator,
        consultation: ConsultationData,
        alreadyPrescribed: string[]
    ): Promise<MedicineLine | null> {
        // A category can be empty at a centre - nothing of that kind on its formulary - so
        // an empty medicine list sends the run back for another category rather than
        // ending the prescription there.
        const triedCategories: string[] = [];
        let category: string | null = null;
        let medicine: string | null = null;

        for (let attempt = 0; attempt < 5 && medicine === null; attempt += 1) {
            category = await pickRandomOption(
                this.page,
                this.rowControl(row, /category/i, '.selectize-control.single'),
                { exclude: triedCategories, timeout: 10000 }
            );

            if (category === null) {
                return null;
            }

            triedCategories.push(category);

            // The list the category just filtered needs a moment to come back before it opens.
            await this.page.waitForTimeout(500);

            medicine = await pickRandomOption(
                this.page,
                row.locator('.selectize-control.medicine_list').first(),
                { exclude: alreadyPrescribed, timeout: 10000 }
            );
        }

        if (category === null || medicine === null) {
            return null;
        }

        await expect(row).toContainText(medicine, { useInnerText: true });

        // How much and for how long are the two the form multiplies into a quantity and
        // checks against the centre's stock, refusing the save when it runs over - so they
        // are taken as low as the form allows rather than at random. Everything else on
        // the line is still whatever the live dropdowns happen to offer.
        const dosage = await this.fillSmallestRowField(row, /^Dosage$/i, consultation.dosage);
        const frequency = await this.fillRowField(row, /how often/i, consultation.frequency);
        const duration = await this.fillSmallestRowField(row, /^Duration$/i, consultation.duration);
        const instruction = await this.fillRowField(row, /how to take/i, consultation.instruction);
        const route = await pickRandomOption(
            this.page,
            this.rowControl(row, /^Route$/i, '.selectize-control.medicineRouteCls'),
            { timeout: 5000 }
        );

        return { category, medicine, dosage, frequency, duration, instruction, route };
    }

    /**
     * A field inside one row, by its accessible name where it still has one and by the
     * class its control carries where it does not. A selectize drops its placeholder as
     * soon as it holds a value, so on a row that has been filled before — a re-opened
     * consultation — the name lookup finds nothing and the class is what is left.
     */
    private rowControl(row: Locator, name: RegExp, controlClass: string): Locator {
        return row
            .getByRole('textbox', { name })
            .first()
            .or(row.locator(controlClass).first())
            .first();
    }

    /** The over-the-counter line, which sits in its own row outside the numbered grid. */
    async addOtcMedicine(): Promise<string | null> {
        const otcRow = this.page.locator('#OTCRow');

        if (!(await isVisibleWithin(otcRow, 5000))) {
            return null;
        }

        return pickRandomOption(
            this.page,
            otcRow.locator('.selectize-control.medicine_list').first(),
            { timeout: 5000 }
        );
    }

    /** Diagnostic test rows — the ones carrying a test dropdown. */
    private diagnosticRows(): Locator {
        return this.page
            .locator('#testTable tr')
            .filter({ has: this.page.locator('.selectize-control') });
    }

    /**
     * Orders diagnostic tests, each a distinct random pick, adding a row at a time with
     * #AddTest. The grid opens with one row on it, so the button is pressed between rows
     * rather than before the first — and only once the row count confirms the previous
     * one landed, since the grid re-renders as it grows.
     *
     * `filter` narrows the picks to part of the catalogue — the SMILE centre orders from
     * its own "[SMILE] ..." tests.
     */
    async addDiagnosticTests(count: number, filter?: RegExp): Promise<string[]> {
        const tests: string[] = [];

        if (!(await isVisibleWithin(this.diagnosticRows().first(), 5000))) {
            return tests;
        }

        const alreadyOrdered = await this.existingRowValues(this.diagnosticRows());

        for (let index = 0; index < count; index += 1) {
            const row = await this.nextEntryRow(
                this.diagnosticRows(),
                this.page.locator('#AddTest')
            );

            if (row === null) {
                break;
            }

            const test = await pickRandomOption(
                this.page,
                row.locator('.selectize-control').first(),
                { filter, exclude: [...alreadyOrdered, ...tests], timeout: 10000 }
            );

            if (test === null) {
                await this.removeRowIfEmpty(row);
                break;
            }

            tests.push(test);
        }

        return tests;
    }

    /**
     * The Referred To control — <select id="referral"> behind a selectize whose
     * placeholder reads "--Select a Department--". Addressed by the id rather than by
     * that placeholder alone, because a control that already holds a value drops its
     * placeholder and would stop being findable by name.
     */
    private referredToField(): Locator {
        return this.page
            .locator('#referral ~ .selectize-control')
            .or(this.page.getByRole('textbox', { name: /select a department/i }))
            .first();
    }

    /**
     * Refers the patient on, to a department picked at random from whatever this centre
     * offers. Choosing the department is the whole of this section: the appointment the
     * recording appears to set alongside it is the Review After date, which lives in its
     * own fieldset, is required on every consultation referral or not, and is set by
     * setReviewDate().
     *
     * Selecting a department reveals a comments row (the select's own
     * onchange="toggleReferredComments()"), so the run's advice line goes in there when
     * it appears.
     */
    async addReferral(consultation?: ConsultationData): Promise<string | null> {
        const department = this.referredToField();

        if (!(await isVisibleWithin(department, 5000))) {
            return null;
        }

        const picked = await pickRandomOption(this.page, department, { timeout: 5000 });

        if (picked === null) {
            return null;
        }

        const comments = this.page.locator('#ReferredToComments');

        if (consultation && (await isVisibleWithin(comments, 3000))) {
            await comments.fill(consultation.advice).catch(() => undefined);
        }

        return picked;
    }

    /**
     * Review After — a required, readonly box backed by a jQuery UI calendar, and the
     * reason a save can die in silence: readonly controls are exempt from the browser's
     * own constraint validation, so an empty one raises no bubble and the app cancels
     * the submit through a red span of its own instead.
     *
     * The recording pins the day as `getByRole('link', { name: '30' })`, which is the day
     * that session happened to be recorded on and is not even a valid day in every month.
     * The calendar renders every day it will accept as a link inside a cell carrying
     * data-handler="selectDay", and everything it will not — today and every day before
     * it — as a plain span, so the links are exactly the future days and one of them is
     * taken at random. A run also walks a month or two forward first where the calendar
     * allows it, so the date picked is not always inside the current month.
     */
    async setReviewDate(): Promise<string | null> {
        const dateBox = this.page
            .locator('#ReviewAfterDatePicker')
            .or(this.page.getByRole('textbox', { name: /select a date/i }))
            .first();

        if (!(await isVisibleWithin(dateBox, 5000))) {
            return null;
        }

        await dateBox.click();

        const calendar = this.page.locator('#ui-datepicker-div, .ui-datepicker').first();

        if (!(await isVisibleWithin(calendar, 5000))) {
            return null;
        }

        // Enabled days only: a cell the calendar will act on, never one it has marked
        // unselectable. Past days are spans and so are excluded by the link anyway.
        const days = calendar.locator(
            'td[data-handler="selectDay"]:not(.ui-datepicker-unselectable) a'
        );

        for (let step = randomInt(0, 2); step > 0; step -= 1) {
            const next = calendar.locator('a.ui-datepicker-next:not(.ui-state-disabled)');

            if (!(await next.isVisible().catch(() => false))) {
                break;
            }

            await next.click();
            await isVisibleWithin(days.first(), 3000);
        }

        if (!(await isVisibleWithin(days.first(), 5000))) {
            await this.page.keyboard.press('Escape').catch(() => undefined);
            return null;
        }

        const selectable = (await days.allInnerTexts())
            .map((text, index) => ({ text: text.trim(), index }))
            .filter(({ text }) => /^\d+$/.test(text));

        if (selectable.length === 0) {
            await this.page.keyboard.press('Escape').catch(() => undefined);
            return null;
        }

        const chosen = pickRandom(selectable);
        await days.nth(chosen.index).click();

        // The box is readonly and filled by the calendar, so what it now holds is the
        // date the form will actually submit - report that rather than the day number.
        await expect(
            dateBox,
            'The review calendar was clicked but no date was written into Review After'
        ).not.toHaveValue('', { timeout: 5000 });

        return (await dateBox.inputValue().catch(() => '')) || chosen.text;
    }

    /**
     * Starts the video call, when a run asks for it. Off by default: the call wants a
     * camera and a microphone, and a headless machine has neither, so the button is left
     * alone and the consultation is saved through the same control regardless.
     */
    async startVideoCallIfRequested(): Promise<boolean> {
        if (!startVideoCall) {
            return false;
        }

        const videoCall = this.page.locator('#VideoCall');

        if (!(await isVisibleWithin(videoCall, 5000))) {
            return false;
        }

        await videoCall.click().catch(() => undefined);
        return true;
    }

    /**
     * Saves the consultation. The button is the form's submit, so a save that worked
     * leaves the page; one that did not leaves the run sitting on the form, and the
     * reason — an alert the app raised, a control the browser marked invalid, or an error
     * rendered inline — is read off the page and reported rather than left as a timeout.
     *
     * The recorded session presses this button eight times in a row. That is what a
     * cancelled submit looks like from the outside, and it is exactly the thing worth
     * turning into a message instead of a retry.
     *
     * The one refusal that is answered rather than reported is the stock check. The form
     * weighs what was prescribed against what the centre actually holds and cancels the
     * whole save over a single line — "Available Quantity in stock is 1 || Prescribed
     * Quantity is 3" — naming the medicine and telling the doctor what to do about it:
     * prescribe another medicine, or reduce the quantity. A run does exactly that, in
     * that order of least damage — cut the line back to the smallest the form will take,
     * take it off the prescription where even that is more than the stock, and only where
     * it was the consultation's one and only medicine put another in its place — and
     * saves again. Nothing about the form is broken when a centre is short of a drug, so
     * a run that failed over it was reporting the pharmacy, not the software.
     *
     * What it had to change is handed back, and folded into `summary` when one is passed,
     * so the run says what was written rather than what it set out to write.
     */
    async saveAndExpectLeavingForm(
        dialogMessages: string[] = [],
        summary?: ConsultationSummary
    ): Promise<StockAdjustment[]> {
        const page = this.page;
        const formUrl = page.url();
        const adjustments: StockAdjustment[] = [];

        // One pass to cut a line back and one to take it off, per line, plus the save that
        // finally goes through. Past that the run is pressing the button the way the
        // recording did, so it stops and says what the form said.
        const attempts = 2 * ((summary?.medicines.length ?? 1) + 1) + 1;

        for (let attempt = 1; ; attempt += 1) {
            const alertsBefore = dialogMessages.length;

            // A required tickbox the form will not submit without — the browser blocks the
            // submit on it before the app ever sees the click.
            const declaration = page.locator('input[type="checkbox"]:required').first();
            if (await declaration.isVisible({ timeout: 2000 }).catch(() => false)) {
                await declaration.check({ force: true }).catch(() => undefined);
            }

            await this.saveButton().click();

            const outcome = await this.waitForSaveOutcome(dialogMessages, alertsBefore, formUrl);

            if (outcome === 'left') {
                break;
            }

            if (outcome === 'alerted') {
                const alerts = dialogMessages.slice(alertsBefore);
                const eased =
                    attempt < attempts &&
                    (await this.easeStockShortfalls(alerts, adjustments, summary));

                if (eased) {
                    continue;
                }

                this.throwIfAlerted(dialogMessages, alertsBefore, formUrl);
            }

            throw new Error(
                `Save did not leave the prescription form (${page.url()}), so the consultation ` +
                    `was not written — ${
                        (await this.saveComplaint()) ?? 'no validation message was shown'
                    }`
            );
        }

        if (holdOpen) {
            // Saved, and whatever the app popped up has been answered. Stop here so the
            // browser stays on the result; resume to end the run.
            await page.pause();
            return adjustments;
        }

        await page.waitForLoadState('load');

        // A saved consultation comes back to the patient's summary. On the doctor's side
        // the nav Home is an image link with no accessible name at all, so "Home" is a
        // centre-page landmark that never matches here - it failed a save that had in fact
        // gone through, with the prescription written and the app already back on the
        // summary. What the app returned to is what gets checked instead.
        await expect(
            page,
            'The prescription was saved but the app did not come back to the patient summary'
        ).toHaveURL(/PrescriptionView|DoctorHome/i, { timeout: 20000 });

        return adjustments;
    }

    /**
     * What became of a save: the form submitted and the app moved on, the form cancelled
     * it through an alert, or neither happened and the run is still sitting on it.
     *
     * Waiting on the navigation alone would cost the full timeout on every refused save,
     * and a refused save is the case this has to be quick about, since it is the one the
     * run now edits and retries. The alert has already been answered by the dialog
     * handler by the time it reaches `dialogMessages`, so whichever of the two happens
     * first ends the wait.
     */
    private async waitForSaveOutcome(
        dialogMessages: string[],
        alertsBefore: number,
        formUrl: string,
        timeout = 30000
    ): Promise<'left' | 'alerted' | 'stuck'> {
        const deadline = Date.now() + timeout;

        for (;;) {
            if (dialogMessages.length > alertsBefore) {
                return 'alerted';
            }

            if (this.page.url() !== formUrl) {
                return 'left';
            }

            if (Date.now() >= deadline) {
                return 'stuck';
            }

            await this.page.waitForTimeout(250);
        }
    }

    /** The form's own reason for refusing a submit, where it gave one. */
    private async saveComplaint(): Promise<string | null> {
        return this.page
            .evaluate(() => {
                const invalid = document.querySelector<
                    HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
                >('input:invalid, select:invalid, textarea:invalid');
                if (invalid) {
                    return `${invalid.name || invalid.id || invalid.tagName} is invalid: ${invalid.validationMessage}`;
                }

                // .validateSpanClass is the form's own way of refusing a submit - the
                // red span next to Review After is one - and it is the only thing said
                // when the offending control is readonly, which exempts it from the
                // browser's constraint validation above.
                const shown = Array.from(
                    document.querySelectorAll<HTMLElement>(
                        '[role="alert"], .error, .alert, .validation-summary-errors, ' +
                            '.field-validation-error, .validateSpanClass'
                    )
                ).find((element) => element.offsetParent !== null && element.innerText.trim());

                return shown ? shown.innerText.trim() : null;
            })
            .catch(() => null);
    }

    /**
     * Reads a stock refusal back out of the app's own words:
     *
     *   Note: Duolin Respules 2.5 ml (...) is not available for the quantity prescribed.
     *   || Available Quantity in stock is 1 || Prescribed Quantity is 3. You are requested
     *   to prescribe another medicine, or reduce the prescribed quantity of the medicine.
     *
     * Anything that is not that — a missing field, a blank symptom row — is not something
     * to edit around, so it comes back null and is reported the way it always was.
     */
    private static readStockShortfall(message: string): StockShortfall | null {
        const named = /(?:Note\s*:\s*)?(.+?)\s+is not available for the quantity prescribed/i.exec(
            message
        );
        const available = /Available Quantity in stock is\s*([\d.]+)/i.exec(message);
        const prescribed = /Prescribed Quantity is\s*([\d.]+)/i.exec(message);

        if (!named || !available || !prescribed) {
            return null;
        }

        return {
            medicine: named[1].replace(/\s+/g, ' ').trim(),
            available: Number(available[1]),
            prescribed: Number(prescribed[1]),
        };
    }

    /**
     * Answers the alerts a refused save raised and reports whether the form was changed
     * enough to be worth pressing Save again. One alert that is not about stock is enough
     * to stop: the run has no business editing around a refusal it cannot read.
     */
    private async easeStockShortfalls(
        alerts: string[],
        adjustments: StockAdjustment[],
        summary?: ConsultationSummary
    ): Promise<boolean> {
        const shortfalls = alerts.map((alert) => PrescriptionFormPage.readStockShortfall(alert));

        if (shortfalls.length === 0 || shortfalls.some((shortfall) => shortfall === null)) {
            return false;
        }

        let changed = false;

        for (const shortfall of shortfalls as StockShortfall[]) {
            const adjustment = await this.easeStockShortfall(shortfall, adjustments);

            if (adjustment === null) {
                continue;
            }

            adjustments.push(adjustment);
            this.applyAdjustment(adjustment, summary);
            console.log(
                `Stock: ${adjustment.available} of ${adjustment.medicine} against ` +
                    `${adjustment.prescribed} prescribed — ${adjustment.detail}`
            );
            changed = true;
        }

        return changed;
    }

    /**
     * One short line, dealt with the way the alert asks. A line is only cut back once: if
     * the form comes back complaining about the same medicine after that, the smallest the
     * dropdowns offer is still more than the centre holds and no further editing will save
     * it — so it comes off, or is swapped for another medicine where it was the only one
     * on the consultation.
     */
    private async easeStockShortfall(
        shortfall: StockShortfall,
        adjustments: StockAdjustment[]
    ): Promise<StockAdjustment | null> {
        // The over-the-counter line is a medicine like any other as far as the stock check
        // goes, but it is the one line a consultation does not need and it has no dosage
        // or duration to cut back, so a short one is simply dropped.
        const otcRow = this.page.locator('#OTCRow');

        if (await this.rowHolds(otcRow, shortfall.medicine)) {
            if (!(await this.clearRow(otcRow))) {
                return null;
            }

            return {
                ...shortfall,
                action: 'removed',
                detail: 'the over-the-counter line was dropped',
            };
        }

        const row = await this.medicineRowFor(shortfall.medicine);

        if (row === null) {
            return null;
        }

        const cutBackAlready = adjustments.some(
            (adjustment) =>
                adjustment.medicine === shortfall.medicine && adjustment.action === 'reduced'
        );

        if (!cutBackAlready) {
            const detail = await this.minimiseRowQuantity(row);

            if (detail !== null) {
                return { ...shortfall, action: 'reduced', detail };
            }
        }

        // A consultation cannot be saved with nothing on it, so the last line standing is
        // replaced rather than taken off - the other half of what the alert itself
        // suggests, and what keeps the run testing the form instead of reporting the
        // pharmacy's shelves.
        if ((await this.filledMedicineRowCount()) <= 1) {
            const replacement = await this.replaceMedicine(
                row,
                adjustments.map((adjustment) => adjustment.medicine)
            );

            if (replacement === null) {
                throw new Error(
                    `The centre holds ${shortfall.available} of ${shortfall.medicine} against the ` +
                        `${shortfall.prescribed} this consultation prescribes, it is the only ` +
                        `medicine on the form, and nothing else could be prescribed in its place ` +
                        `— so there is no prescription left to save`
                );
            }

            return {
                ...shortfall,
                action: 'replaced',
                detail: `replaced with ${replacement.medicine} (${replacement.category})`,
                replacement,
            };
        }

        if (!(await this.removeMedicineRow(row))) {
            return null;
        }

        return { ...shortfall, action: 'removed', detail: 'taken off the prescription' };
    }

    /**
     * The row a medicine was written into. The alert spells it the way the dropdown does,
     * so the row is found by what it holds; where that does not match word for word — a
     * centre that trims the strength off, a stray bracket — the opening of the name is
     * enough to tell the three lines of a prescription apart.
     */
    private async medicineRowFor(medicine: string): Promise<Locator | null> {
        const rows = this.medicineRows();
        const held = await rows
            .evaluateAll((elements) =>
                elements.map((row) =>
                    ((row as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
                )
            )
            .catch(() => [] as string[]);

        const index = held.findIndex((text) =>
            PrescriptionFormPage.namesTheMedicine(text, medicine)
        );

        return index >= 0 ? rows.nth(index) : null;
    }

    /**
     * Whether what a row is showing names a given medicine — the whole of it, or enough of
     * the opening to tell one prescription line from the two next to it.
     */
    private static namesTheMedicine(shown: string, medicine: string): boolean {
        const held = shown.replace(/\s+/g, ' ').trim().toLowerCase();
        const wanted = medicine.replace(/\s+/g, ' ').trim().toLowerCase();
        const opening = wanted.split(' ').slice(0, 2).join(' ');

        return (
            wanted.length > 0 &&
            (held.includes(wanted) || (opening.length > 2 && held.includes(opening)))
        );
    }

    /** The same question asked of one row, for the rows that are not part of the grid. */
    private async rowHolds(row: Locator, medicine: string): Promise<boolean> {
        if (!(await row.isVisible().catch(() => false))) {
            return false;
        }

        return PrescriptionFormPage.namesTheMedicine(await this.controlValue(row), medicine);
    }

    /**
     * A column of a row that has already been filled — which is not something the
     * accessible name can find, since a selectize drops its placeholder, and with it its
     * name, the moment it holds a value.
     *
     * So where the name finds nothing the control is taken by the field behind it: every
     * selectize is drawn next to the original <select> it replaced, and that one still
     * carries the name the form submits ("dosage[]", "duration[]"). Only if that comes to
     * nothing does it fall back to the control's position within its own row — right on
     * this form, but the sort of thing that is right until a column is added.
     */
    private async filledRowField(
        row: Locator,
        name: RegExp,
        submitted: RegExp,
        column: number
    ): Promise<Locator> {
        const named = row.getByRole('textbox', { name }).first();

        if (await named.isVisible().catch(() => false)) {
            return named;
        }

        const controls = row.locator('.selectize-control');
        const index = await controls
            .evaluateAll((elements, pattern) => {
                const matches = new RegExp(pattern, 'i');

                return elements.findIndex((element) => {
                    const original = element.previousElementSibling;
                    const submits = original
                        ? `${original.getAttribute('name') ?? ''} ${original.id}`
                        : '';

                    return matches.test(submits);
                });
            }, submitted.source)
            .catch(() => -1);

        return controls.nth(index >= 0 ? index : column);
    }

    /**
     * Cuts a prescription line down to the least the form will accept, in the order that
     * costs the consultation the least: how often first — it is the one of the three still
     * picked at random, so "1-1-1" three times a day against "0-0-1" once is where the
     * give is — then the duration, then the dosage.
     *
     * Reports what it changed, or null when every column was already at its lowest and the
     * line has nothing left to give.
     */
    private async minimiseRowQuantity(row: Locator): Promise<string | null> {
        const columns = PrescriptionFormPage.MEDICINE_COLUMNS;
        const changes: string[] = [];

        const howOften = await this.lowerColumn(
            row,
            /how often/i,
            /freq|often/,
            columns.howOften,
            pickSmallestDoseOption
        );
        if (howOften) {
            changes.push(`how often ${howOften}`);
        }

        const duration = await this.lowerColumn(
            row,
            /^Duration$/i,
            /durat/,
            columns.duration,
            pickSmallestNumericOption
        );
        if (duration) {
            changes.push(`duration ${duration}`);
        }

        const dosage = await this.lowerColumn(
            row,
            /^Dosage$/i,
            /dosage|dose/,
            columns.dosage,
            pickSmallestNumericOption
        );
        if (dosage) {
            changes.push(`dosage ${dosage}`);
        }

        return changes.length > 0 ? changes.join(', ') : null;
    }

    /**
     * Takes one column as low as its dropdown goes, reporting the move as "was → now", and
     * null where it did not move: the column was already at its lowest, or it is a typed
     * box on this centre with no lower entry to pick.
     */
    private async lowerColumn(
        row: Locator,
        name: RegExp,
        submitted: RegExp,
        column: number,
        pick: (page: Page, field: Locator, options?: PickOptions) => Promise<string | null>
    ): Promise<string | null> {
        const field = await this.filledRowField(row, name, submitted, column);

        if (!(await isVisibleWithin(field, 3000))) {
            return null;
        }

        const before = await this.controlValue(field);
        const picked = await pick(this.page, field, { timeout: 5000 });

        if (picked === null || picked === before) {
            return null;
        }

        return `${before || 'blank'} → ${picked}`;
    }

    /** What a selectize is showing at the moment, value or placeholder. */
    private async controlValue(field: Locator): Promise<string> {
        return field
            .innerText()
            .then((text) => text.replace(/\s+/g, ' ').trim())
            .catch(() => '');
    }

    /** How many rows of the medicine grid actually hold a medicine. */
    private async filledMedicineRowCount(): Promise<number> {
        return this.medicineRows()
            .evaluateAll(
                (elements) =>
                    elements.filter(
                        (row) =>
                            row.querySelector(
                                '.selectize-control.medicine_list .selectize-input.has-items'
                            ) !== null
                    ).length
            )
            .catch(() => 0);
    }

    /**
     * Empties a row so the form treats it as one of the blank ones it pre-renders — used
     * where the row has no delete control to click, and to clear a line before a different
     * medicine is written into it.
     *
     * Selectize hangs its instance off the original control, and clearing through that is
     * the only thing the widget believes: blanking the input it draws leaves the value
     * that actually gets submitted exactly where it was.
     */
    private async clearRow(row: Locator): Promise<boolean> {
        return row
            .evaluate((element) => {
                let cleared = false;

                element.querySelectorAll('select, input').forEach((node) => {
                    const instance = (
                        node as Element & { selectize?: { clear: (silent?: boolean) => void } }
                    ).selectize;

                    if (instance) {
                        instance.clear(true);
                        cleared = true;
                    } else if (node instanceof HTMLInputElement && node.type === 'text') {
                        node.value = '';
                    }
                });

                return cleared;
            })
            .catch(() => false);
    }

    /**
     * Takes a prescription line off the form, through the row's own delete control where
     * it has one and by emptying it where it does not.
     */
    private async removeMedicineRow(row: Locator): Promise<boolean> {
        const rows = this.medicineRows();
        const remove = row.locator('#deleteIcon, [onclick*="deleteCurrentRow"]').first();

        if (await isVisibleWithin(remove, 3000)) {
            const before = await rows.count();
            await remove.click().catch(() => undefined);

            const went = await expect(rows)
                .toHaveCount(before - 1, { timeout: 5000 })
                .then(() => true)
                .catch(() => false);

            if (went) {
                return true;
            }
        }

        return this.clearRow(row);
    }

    /**
     * Writes a different medicine into a row, at the smallest quantity the form offers —
     * the alert's own first suggestion, and the only way a consultation whose single
     * medicine the centre has run out of still gets saved.
     */
    private async replaceMedicine(row: Locator, avoid: string[]): Promise<MedicineLine | null> {
        if (this.consultation === null) {
            return null;
        }

        await this.clearRow(row);

        const alreadyPrescribed = [...avoid, ...(await this.existingRowValues(this.medicineRows()))];
        const line = await this.fillMedicineRow(row, this.consultation, alreadyPrescribed);

        if (line === null) {
            return null;
        }

        await this.minimiseRowQuantity(row);

        return line;
    }

    /** Keeps what the form now holds and what the run reports about it in step. */
    private applyAdjustment(adjustment: StockAdjustment, summary?: ConsultationSummary): void {
        if (!summary) {
            return;
        }

        const index = summary.medicines.findIndex(
            (line) =>
                line.medicine !== '' &&
                PrescriptionFormPage.namesTheMedicine(adjustment.medicine, line.medicine)
        );

        if (index < 0) {
            if (
                adjustment.action === 'removed' &&
                summary.otcMedicine !== null &&
                PrescriptionFormPage.namesTheMedicine(adjustment.medicine, summary.otcMedicine)
            ) {
                summary.otcMedicine = null;
            }

            return;
        }

        if (adjustment.action === 'removed') {
            summary.medicines.splice(index, 1);
        } else if (adjustment.action === 'replaced' && adjustment.replacement) {
            summary.medicines.splice(index, 1, adjustment.replacement);
        }
    }


    /**
     * Approves the consultation that was just written, which is what the summary the save
     * returns to is waiting for - until then the queue row reads "Pending Doctor Approval".
     *
     * The control is <input id="Approve" name="Approve" value="Approve" onclick="load()">,
     * and the page asks confirm("Are you sure you want to approve?") before it goes
     * through; that is answered by the handler captureDialogs() puts in place, which
     * accepts. Where a centre wants batch and expiry details first, a modal comes up in
     * front of it carrying "Save & Continue Approve", so that is submitted when it appears.
     *
     * Reports whether there was anything to approve, so a run can say so rather than
     * leaving it as a silent no-op.
     */
    async approveIfOffered(): Promise<boolean> {
        const approve = this.page
            .getByRole('button', { name: /^\s*Approve\s*$/i })
            .or(this.page.locator('#Approve'))
            .first();

        if (!(await isVisibleWithin(approve, 5000))) {
            return false;
        }

        await approve.click();

        const batchThenApprove = this.page.locator('#submitBatchBeforeApprove');

        if (await isVisibleWithin(batchThenApprove, 3000)) {
            await batchThenApprove.click().catch(() => undefined);
        }

        await this.page.waitForLoadState('load').catch(() => undefined);

        return true;
    }

    /**
     * The form cancels its own submit through alert(), so an alert means nothing was
     * written and the run should stop with the app's own words rather than a timeout.
     */
    private throwIfAlerted(dialogMessages: string[], alertsBefore: number, formUrl: string): void {
        const alerts = dialogMessages.slice(alertsBefore);

        if (alerts.length === 0) {
            return;
        }

        const quoted = alerts.map((message) => `"${message}"`).join(' / ');
        throw new Error(`Save was cancelled by the form (${formUrl}) — the app alerted ${quoted}`);
    }
}
