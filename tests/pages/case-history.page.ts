import { expect, type Locator, type Page } from '@playwright/test';
import type { PatientCaseHistoryData } from '../data/patients';

function randomNumber(min: number, max: number): string {
    return String(Math.floor(Math.random() * (max - min + 1)) + min);
}

function pickRandom<T>(items: T[]): T {
    return items[Math.floor(Math.random() * items.length)];
}

async function isVisibleWithin(locator: Locator, timeout: number): Promise<boolean> {
    return locator
        .waitFor({ state: 'visible', timeout })
        .then(() => true)
        .catch(() => false);
}

/**
 * These grids are legacy jQuery widgets whose model only updates from real key
 * events, so `fill()` alone leaves the entry to be wiped on the next re-render:
 * type it, then blur so the change handler commits. Reports whether the value
 * actually stuck rather than failing the test, since some controls refuse input.
 */
async function tryTypeValue(field: Locator, value: string): Promise<boolean> {
    await field.click();
    await field.fill('');
    await field.pressSequentially(value, { delay: 30 });
    await field.blur();
    return expect(field)
        .toHaveValue(value, { timeout: 3000 })
        .then(() => true)
        .catch(() => false);
}

async function holdsText(locator: Locator, text: string): Promise<boolean> {
    return expect(locator)
        .toContainText(text, { useInnerText: true, timeout: 3000 })
        .then(() => true)
        .catch(() => false);
}

type TestResult = {
    value: string;
    /**
     * A selectize holds its value as the control's item text, not as the input's
     * `value`, so the two shapes have to be verified differently.
     */
    verifyAsText: boolean;
};

export type CaseHistorySummary = {
    nursingStaff: string;
    transportMode: string;
    symptoms: string[];
    durations: string[];
    tests: string[];
};

/**
 * The case history form, reached either straight after registering a patient or by
 * opening an existing one. Every control on it is a selectize, which drops its
 * placeholder — and with it the accessible name — the moment a value is picked, so
 * rows are anchored on things that survive selection (the delete icon, the Refused
 * checkbox) rather than on the field that was just filled.
 */
export class CaseHistoryPage {
    constructor(private readonly page: Page) {}

    /**
     * The form validates through native alert() dialogs, which Playwright dismisses
     * silently by default — the submit is cancelled and nothing on the page says so.
     * Call this before filling so a blocked Save can name its own reason.
     */
    captureDialogs(): string[] {
        const messages: string[] = [];
        this.page.on('dialog', async (dialog) => {
            messages.push(dialog.message().trim());
            await dialog.dismiss().catch(() => undefined);
        });
        return messages;
    }

    async expectLoaded(): Promise<void> {
        await expect(this.page.getByRole('button', { name: 'Save' })).toBeVisible({
            timeout: 15000,
        });
    }

    /**
     * Picks a random option out of the live dropdown, skipping anything already used
     * in this run so every symptom / test row gets a distinct value.
     */
    private async selectRandomOption(
        field: string | Locator,
        optionFilter: RegExp,
        alreadySelected: string[] = [],
        clickParent = false
    ): Promise<string> {
        const input =
            typeof field === 'string'
                ? this.page.getByRole('textbox', { name: field }).first()
                : field;

        if (clickParent) {
            await input.evaluate((element) => {
                (element.parentElement as HTMLElement).click();
            });
        } else {
            await input.click();
        }

        const options = this.page
            .locator('.selectize-dropdown:visible .option')
            .filter({ hasText: optionFilter });
        await expect(options.first()).toBeVisible({ timeout: 10000 });

        // Click by index rather than re-finding the option by its text: selectize
        // re-renders the list as it filters, and the second lookup can resolve to an
        // element that is already detached.
        const candidates = (await options.allInnerTexts())
            .map((text, index) => ({ text: text.trim(), index }))
            .filter(({ text }) => text.length > 0 && !alreadySelected.includes(text));

        expect(
            candidates.length,
            `No unused dropdown option left (already used: ${alreadySelected.join(', ')})`
        ).toBeGreaterThan(0);

        const selected = pickRandom(candidates);
        await options.nth(selected.index).click();

        return selected.text;
    }

    /**
     * Choosing a PoC test re-renders its Result cell asynchronously into whatever that
     * test needs — a number box, a selectize of preset outcomes, or a free-text
     * selectize — so enter the result against whatever actually turns up rather than
     * assuming a shape. Some tests render a Result control the form never activates
     * (an empty selectize that will not take a typed value); those return null so the
     * caller can pick a different test instead of failing over the app's own gap.
     */
    private async enterTestResult(
        resultCell: Locator,
        min: number,
        max: number
    ): Promise<TestResult | null> {
        const numericResult = resultCell.getByRole('spinbutton').first();
        if (await isVisibleWithin(numericResult, 10000)) {
            const value = randomNumber(min, max);
            return (await tryTypeValue(numericResult, value))
                ? { value, verifyAsText: false }
                : null;
        }

        const resultField = resultCell.locator('input:not([disabled])').first();
        if (!(await isVisibleWithin(resultField, 5000))) {
            return null;
        }

        const isSelectize = await resultField.evaluate(
            (element) => element.closest('.selectize-control') !== null
        );

        if (!isSelectize) {
            const value = randomNumber(min, max);
            return (await tryTypeValue(resultField, value)) ? { value, verifyAsText: false } : null;
        }

        // A selectize collapses its input to zero width, so open it through the wrapper
        // the way the symptom row's dropdowns are opened.
        await resultField.evaluate((element) => {
            (element.parentElement as HTMLElement).click();
        });

        const options = this.page
            .locator('.selectize-dropdown:visible .option')
            .filter({ hasText: /\S/ });
        if (await isVisibleWithin(options.first(), 5000)) {
            const usable = (await options.allInnerTexts())
                .map((text, index) => ({ text: text.trim(), index }))
                .filter(({ text }) => text.length > 0);
            const selected = pickRandom(usable);
            await options.nth(selected.index).click();
            await this.page.keyboard.press('Escape');
            return (await holdsText(resultCell, selected.text))
                ? { value: selected.text, verifyAsText: true }
                : null;
        }

        // No preset outcomes: a free-text selectize only turns the typed query into a
        // value once Enter commits it as an item. Where the control refuses even that,
        // the test has no usable Result field.
        const value = randomNumber(min, max);
        await resultField.fill('');
        await resultField.pressSequentially(value, { delay: 30 });
        await resultField.press('Enter');
        await this.page.keyboard.press('Escape');
        return (await holdsText(resultCell, value)) ? { value, verifyAsText: true } : null;
    }

    async fill(caseHistory: PatientCaseHistoryData): Promise<CaseHistorySummary> {
        const page = this.page;

        // Take whoever/whatever the app actually offers instead of a pinned name, so the
        // run is not tied to one staff member or vehicle. `--` skips the placeholder row.
        const nursingStaff = await this.selectRandomOption(
            '--Select a Nursing Staff--',
            /^(?!--)\S/
        );
        const transportMode = await this.selectRandomOption(
            '--Select a Transport Mode--',
            /^(?!--)\S/
        );

        await expect(
            page.getByRole('row').filter({ hasText: 'Assisting Nurse' }).last()
        ).toContainText(nursingStaff, { useInnerText: true });
        await expect(
            page.getByRole('row').filter({ hasText: 'Transport Mode' }).last()
        ).toContainText(transportMode, { useInnerText: true });

        await page.locator('#weight').fill(caseHistory.weight);
        await page.locator('#height').fill(caseHistory.height);
        await page.locator('#high_bp').fill(caseHistory.highBp);
        await page.locator('#low_bp').fill(caseHistory.lowBp);
        await page.locator('#pulse').fill(caseHistory.pulse);
        await page.locator('#temperature').fill(caseHistory.temperature);
        await page.locator('#respiratory_rate').fill(caseHistory.respiratoryRate);
        await page.locator('input[name="spo2"]').fill(caseHistory.spo2);

        // Allergies is required (its label carries a *); leaving the radio unset makes
        // the form fail validation on Save. The radios carry no accessible name, so they
        // are addressed by position: Known first, Not Known second.
        await page
            .getByRole('row')
            .filter({ hasText: 'Allergies : Known Not Known' })
            .last()
            .getByRole('radio')
            .nth(caseHistory.allergies === 'Known' ? 0 : 1)
            .check({ force: true });

        const symptoms = await this.addSymptoms(caseHistory.symptomCount);
        const tests = await this.addTests(
            caseHistory.testCount,
            caseHistory.minTestValue,
            caseHistory.maxTestValue
        );

        return { nursingStaff, transportMode, ...symptoms, tests };
    }

    private symptomRows(): Locator {
        // Anchored on the row's delete icon, which is there before and after a pick.
        return this.page
            .getByRole('group', { name: 'Case History' })
            .locator('table table')
            .getByRole('row')
            .filter({ has: this.page.getByRole('img') });
    }

    private async addSymptoms(count: number): Promise<{ symptoms: string[]; durations: string[] }> {
        const page = this.page;
        const symptomRows = this.symptomRows();
        const symptoms: string[] = [];
        const durations: string[] = [];

        for (let index = 0; index < count; index += 1) {
            await expect(symptomRows).toHaveCount(index + 1, { timeout: 10000 });
            const symptomRow = symptomRows.nth(index);

            const symptom = await this.selectRandomOption(
                symptomRow.getByRole('cell').first().getByRole('textbox').first(),
                /^(?!\[PoC\])\S/,
                symptoms
            );
            symptoms.push(symptom);
            await page.keyboard.press('Escape');
            await expect(symptomRow).toContainText(symptom, { useInnerText: true });

            const durationUnit = await this.selectRandomOption(
                symptomRow.getByRole('textbox', { name: 'Time Duration' }),
                /^(?!--)\S/,
                [],
                true
            );
            await expect(symptomRow).toContainText(durationUnit, { useInnerText: true });

            const severity = await this.selectRandomOption(
                symptomRow.getByRole('textbox', { name: 'Severity' }),
                /^(?!--)\S/,
                [],
                true
            );
            await expect(symptomRow).toContainText(severity, { useInnerText: true });

            // "Duration" is a selectize control too, not a free-text box: typing only
            // fills its search query, which is thrown away on blur. Pick an option.
            const duration = await this.selectRandomOption(
                symptomRow.getByRole('textbox', { name: 'Duration', exact: true }),
                /^\d/
            );
            durations.push(duration);
            await expect(symptomRow).toContainText(duration, { useInnerText: true });

            if (index < count - 1) {
                await page.getByRole('button', { name: 'Add Symptom' }).click();
            }
        }

        await expect(symptomRows).toHaveCount(count);

        // Adding a row re-renders the grid, so re-check every symptom still holds what
        // was entered rather than trusting the assertion made right after each edit.
        for (const [index, duration] of durations.entries()) {
            const symptomRow = symptomRows.nth(index);
            await expect(symptomRow).toContainText(symptoms[index], { useInnerText: true });
            // Duration lives in the 4th cell; a selectize keeps its value as text, not as
            // the input's value, so read the cell rather than the input.
            await expect(symptomRow.getByRole('cell').nth(3)).toContainText(duration, {
                useInnerText: true,
            });
        }

        return { symptoms, durations };
    }

    private testRows(): Locator {
        return this.page
            .getByRole('group', { name: 'Point of care test' })
            .getByRole('row')
            .filter({ has: this.page.getByRole('checkbox') });
    }

    private async addTests(count: number, min: number, max: number): Promise<string[]> {
        const page = this.page;
        const testRows = this.testRows();
        const tests: string[] = [];
        const results: TestResult[] = [];

        for (let index = 0; index < count; index += 1) {
            await expect(testRows).toHaveCount(index + 1, { timeout: 10000 });
            const testRow = testRows.nth(index);

            // Cells come from the accessibility tree, not td positions — the DOM carries
            // cells that never render.
            const testNameField = testRow.getByRole('cell').first().getByRole('textbox').first();
            const resultCell = testRow.getByRole('cell').nth(1);

            // Not every PoC test exposes a Result control the form will accept a value
            // in. Swap that row's test for another one rather than failing the run.
            const rejected: string[] = [];
            let selectedTest = '';
            let result: TestResult | null = null;

            for (let attempt = 0; attempt < 4 && result === null; attempt += 1) {
                selectedTest = await this.selectRandomOption(
                    testNameField,
                    /^\[PoC\]/,
                    [...tests, ...rejected],
                    attempt > 0
                );
                await page.keyboard.press('Escape');
                await expect(testRow).toContainText(selectedTest, { useInnerText: true });

                result = await this.enterTestResult(resultCell, min, max);

                if (result === null) {
                    rejected.push(selectedTest);
                }
            }

            if (result === null) {
                throw new Error(
                    `No PoC test offered a Result field that accepts a value (tried: ${rejected.join(', ')})`
                );
            }

            tests.push(selectedTest);
            results.push(result);

            if (index < count - 1) {
                await page.getByRole('button', { name: 'Add a test' }).click();
            }
        }

        await expect(testRows).toHaveCount(count);

        for (const [index, result] of results.entries()) {
            const testRow = testRows.nth(index);
            await expect(testRow).toContainText(tests[index], { useInnerText: true });

            const resultCell = testRow.getByRole('cell').nth(1);
            if (result.verifyAsText) {
                await expect(resultCell).toContainText(result.value, { useInnerText: true });
            } else {
                await expect(resultCell.locator('input:not([disabled])').first()).toHaveValue(
                    result.value
                );
            }
        }

        return tests;
    }

    /**
     * Save is the form's submit control (it is literally name="Next"), so a successful
     * save leaves the form and loads the next page. Waiting for that also stops a
     * logout teardown from cutting the post short.
     */
    async saveAndExpectNextPage(dialogMessages: string[] = []): Promise<void> {
        const page = this.page;
        const formUrl = page.url();
        const alertsBefore = dialogMessages.length;

        await page.getByRole('button', { name: 'Save' }).click();

        // An alert fires synchronously on submit, so if one already arrived the save was
        // cancelled — fail on its message now rather than waiting out a navigation that
        // is never coming.
        this.throwIfAlerted(dialogMessages, alertsBefore, formUrl);

        const movedOn = await page
            .waitForURL((url) => url.toString() !== formUrl, { timeout: 30000 })
            .then(() => true)
            .catch(() => false);

        this.throwIfAlerted(dialogMessages, alertsBefore, formUrl);

        if (!movedOn) {
            // Still sitting on the form, so the submit was cancelled. Report why rather
            // than a bare timeout: an alert the app raised, a control the browser marked
            // invalid, or an error the page rendered inline.
            const pageComplaint = await page.evaluate(() => {
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
                `Save did not leave the case history form (${page.url()}), so nothing was written — ${
                    pageComplaint ?? 'no validation message was shown'
                }`
            );
        }

        await page.waitForLoadState('load');
        await expect(page.getByRole('link', { name: 'Home' })).toBeVisible({ timeout: 15000 });
    }

    /**
     * The form cancels its own submit through `alert()`, so an alert means nothing was
     * written. A missing consent form is the one cause the test cannot do anything
     * about — it is uploaded from the mobile app — so name it for what it is.
     */
    private throwIfAlerted(dialogMessages: string[], alertsBefore: number, formUrl: string): void {
        const alerts = dialogMessages.slice(alertsBefore);
        if (alerts.length === 0) {
            return;
        }

        const quoted = alerts.map((message) => `"${message}"`).join(' / ');

        if (alerts.some((message) => /consent form/i.test(message))) {
            throw new Error(
                `Save was refused because this patient has no valid consent form — ${quoted}. ` +
                    'A consent form can only be uploaded from the mobile app, so a freshly ' +
                    'registered patient can never save a case history here. Run ' +
                    'existing-patient-case-history.spec.ts against a patient whose consent ' +
                    'form is already on file.'
            );
        }

        throw new Error(`Save was cancelled by the form (${formUrl}) — the app alerted ${quoted}`);
    }
}
