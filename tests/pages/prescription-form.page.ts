import { expect, type Locator, type Page } from '@playwright/test';
import type { ConsultationData } from '../data/consultations';
import {
    isVisibleWithin,
    pickOrType,
    pickRandom,
    pickRandomOption,
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

export type ConsultationSummary = {
    prescriptionId: string;
    provisionalDiagnosis: string | null;
    symptoms: string[];
    medicines: MedicineLine[];
    otcMedicine: string | null;
    diagnosticTests: string[];
    referral: string | null;
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

    private saveButton(): Locator {
        return this.page
            .getByRole('button', { name: /end the video call and save prescription/i })
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
     */
    async fill(consultation: ConsultationData, prescriptionId = ''): Promise<ConsultationSummary> {
        const provisionalDiagnosis = await this.setProvisionalDiagnosis(consultation);
        const symptoms = await this.addSymptoms(consultation.symptomCount);
        const medicines = await this.addMedicines(consultation);
        const otcMedicine = consultation.includeOtc ? await this.addOtcMedicine() : null;
        const diagnosticTests = await this.addDiagnosticTests(consultation.diagnosticTestCount);
        const referral = consultation.includeReferral ? await this.addReferral() : null;

        return {
            prescriptionId,
            provisionalDiagnosis,
            symptoms,
            medicines,
            otcMedicine,
            diagnosticTests,
            referral,
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
     * Records symptoms, each a distinct random pick. "Add Symptom" is pressed between
     * rows rather than before the first, because the grid opens with one row already on it.
     */
    async addSymptoms(count: number): Promise<string[]> {
        const symptoms: string[] = [];

        if (!(await isVisibleWithin(this.symptomRows().first(), 5000))) {
            return symptoms;
        }

        for (let index = 0; index < count; index += 1) {
            if (index > 0) {
                const addSymptom = this.page.getByRole('button', { name: /add symptom/i }).first();
                if (!(await isVisibleWithin(addSymptom, 5000))) {
                    break;
                }
                await addSymptom.click();
                await expect(this.symptomRows()).toHaveCount(index + 1, { timeout: 10000 });
            }

            const row = this.symptomRows().nth(index);

            // The symptom itself is the row's first control; the columns after it are the
            // ones the form names, read left to right the way they are on screen.
            const symptom = await pickRandomOption(
                this.page,
                row.locator('.selectize-control').first(),
                { exclude: symptoms, timeout: 10000 }
            );

            if (symptom === null) {
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

        const available = await this.medicineRows().count();
        const rowsToFill = Math.min(consultation.medicineCount, available);

        for (let index = 0; index < rowsToFill; index += 1) {
            const line = await this.fillMedicineRow(
                this.medicineRows().nth(index),
                consultation,
                lines.map((filled) => filled.medicine)
            );

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
        const category = await pickRandomOption(
            this.page,
            this.rowControl(row, /category/i, '.selectize-control.single'),
            { timeout: 10000 }
        );

        if (category === null) {
            return null;
        }

        // The list the category just filtered needs a moment to come back before it opens.
        await this.page.waitForTimeout(500);

        const medicine = await pickRandomOption(
            this.page,
            row.locator('.selectize-control.medicine_list').first(),
            { exclude: alreadyPrescribed, timeout: 10000 }
        );

        if (medicine === null) {
            return null;
        }

        await expect(row).toContainText(medicine, { useInnerText: true });

        const dosage = await this.fillRowField(row, /^Dosage$/i, consultation.dosage);
        const frequency = await this.fillRowField(row, /how often/i, consultation.frequency);
        const duration = await this.fillRowField(row, /^Duration$/i, consultation.duration);
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
     */
    async addDiagnosticTests(count: number): Promise<string[]> {
        const tests: string[] = [];

        if (!(await isVisibleWithin(this.diagnosticRows().first(), 5000))) {
            return tests;
        }

        for (let index = 0; index < count; index += 1) {
            if (index > 0) {
                const addTest = this.page.locator('#AddTest');
                if (!(await isVisibleWithin(addTest, 5000))) {
                    break;
                }
                await addTest.click();
                await expect(this.diagnosticRows()).toHaveCount(index + 1, { timeout: 10000 });
            }

            const test = await pickRandomOption(
                this.page,
                this.diagnosticRows().nth(index).locator('.selectize-control').first(),
                { exclude: tests, timeout: 10000 }
            );

            if (test === null) {
                break;
            }

            tests.push(test);
        }

        return tests;
    }

    /**
     * Refers the patient on: a department picked at random from whatever this centre
     * offers, and an appointment on a random day the calendar will actually accept.
     */
    async addReferral(): Promise<string | null> {
        const department = this.page.getByRole('textbox', { name: /select a department/i }).first();

        if (!(await isVisibleWithin(department, 5000))) {
            return null;
        }

        const picked = await pickRandomOption(this.page, department, { timeout: 5000 });

        if (picked === null) {
            return null;
        }

        const date = await this.pickRandomAppointmentDate();

        return date ? `${picked} on ${date}` : picked;
    }

    /**
     * The appointment date, out of the jQuery UI calendar the box opens.
     *
     * The recording pins this as `getByRole('link', { name: '30' })`, which is the day the
     * session happened to be recorded on and is not even a valid day in every month. The
     * calendar renders selectable days as links and everything it will not accept — past
     * days, days outside the booking window — as plain spans, so the links *are* the
     * allowed days and one is taken at random from them.
     */
    private async pickRandomAppointmentDate(): Promise<string | null> {
        const dateBox = this.page.getByRole('textbox', { name: /select a date/i }).first();

        if (!(await isVisibleWithin(dateBox, 5000))) {
            return null;
        }

        await dateBox.click();

        const calendar = this.page.locator('#ui-datepicker-div, .ui-datepicker').first();
        const days = calendar.locator('a.ui-state-default');

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
     */
    async saveAndExpectLeavingForm(dialogMessages: string[] = []): Promise<void> {
        const page = this.page;
        const formUrl = page.url();
        const alertsBefore = dialogMessages.length;

        // A required tickbox the form will not submit without — the browser blocks the
        // submit on it before the app ever sees the click.
        const declaration = page.locator('input[type="checkbox"]:required').first();
        if (await declaration.isVisible({ timeout: 2000 }).catch(() => false)) {
            await declaration.check({ force: true }).catch(() => undefined);
        }

        await this.saveButton().click();

        this.throwIfAlerted(dialogMessages, alertsBefore, formUrl);

        if (holdOpen) {
            // Saved, and whatever the app popped up has been answered. Stop here so the
            // browser stays on the result; resume to end the run.
            await page.pause();
            return;
        }

        const movedOn = await page
            .waitForURL((url) => url.toString() !== formUrl, { timeout: 30000 })
            .then(() => true)
            .catch(() => false);

        this.throwIfAlerted(dialogMessages, alertsBefore, formUrl);

        if (!movedOn) {
            const complaint = await page.evaluate(() => {
                const invalid = document.querySelector<
                    HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
                >('input:invalid, select:invalid, textarea:invalid');
                if (invalid) {
                    return `${invalid.name || invalid.id || invalid.tagName} is invalid: ${invalid.validationMessage}`;
                }

                const shown = Array.from(
                    document.querySelectorAll<HTMLElement>(
                        '[role="alert"], .error, .alert, .validation-summary-errors, .field-validation-error'
                    )
                ).find((element) => element.offsetParent !== null && element.innerText.trim());

                return shown ? shown.innerText.trim() : null;
            });

            throw new Error(
                `Save did not leave the prescription form (${page.url()}), so the consultation ` +
                    `was not written — ${complaint ?? 'no validation message was shown'}`
            );
        }

        await page.waitForLoadState('load');
        await expect(page.getByRole('link', { name: 'Home' })).toBeVisible({ timeout: 15000 });
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
