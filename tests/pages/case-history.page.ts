import { expect, type Locator, type Page } from '@playwright/test';

import type { PatientCaseHistoryData } from '../data/patients';

/**
 * E2E_HOLD_OPEN=1 (with --headed) parks the run at page.pause() the moment Save's popup
 * has been OK'd, leaving the browser open on the result instead of moving on and closing.
 */
const holdOpen = !!process.env.E2E_HOLD_OPEN;

function pickRandom<T>(items: T[]): T {
    return items[Math.floor(Math.random() * items.length)];
}

/** The band a PoC test calls normal, as its row states it. */
type NormalRange = { min: number; max: number; decimals: number };

function decimalsIn(...numbers: string[]): number {
    return Math.min(2, Math.max(...numbers.map((value) => (value.split('.')[1] ?? '').length)));
}

/**
 * Picking a PoC test fills its Normal Value box with the band the app considers
 * normal for it, written as "12 - 16", " <= 5", a single value, or — for tests whose
 * result is not a number at all — something worded like "Sinus Rhythm". A result
 * outside the test's allowed range makes the form refuse to save ("Value of a POC
 * test is Out Of Range!"), and one merely outside the normal band raises an abnormal
 * alert, so a run reads the band and stays inside it.
 */
function parseNormalRange(text: string): NormalRange | null {
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (!cleaned) {
        return null;
    }

    const number = String.raw`-?\d+(?:\.\d+)?`;

    const band = new RegExp(String.raw`^(${number})\s*-\s*(${number})$`).exec(cleaned);
    if (band) {
        return { min: Number(band[1]), max: Number(band[2]), decimals: decimalsIn(band[1], band[2]) };
    }

    const atMost = new RegExp(String.raw`^<\s*=?\s*(${number})$`).exec(cleaned);
    if (atMost) {
        return { min: 0, max: Number(atMost[1]), decimals: decimalsIn(atMost[1]) };
    }

    const atLeast = new RegExp(String.raw`^>\s*=?\s*(${number})$`).exec(cleaned);
    if (atLeast) {
        const floor = Number(atLeast[1]);
        return { min: floor, max: floor + Math.max(1, Math.abs(floor) * 0.1), decimals: decimalsIn(atLeast[1]) };
    }

    const exact = new RegExp(`^(${number})$`).exec(cleaned);
    if (exact) {
        return { min: Number(exact[1]), max: Number(exact[1]), decimals: decimalsIn(exact[1]) };
    }

    return null;
}

function valueWithin(range: NormalRange): string {
    const raw = range.min + Math.random() * (range.max - range.min);
    const rounded = Number(raw.toFixed(range.decimals));
    const clamped = Math.min(range.max, Math.max(range.min, rounded));
    return clamped.toFixed(range.decimals);
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
    /** What the under-5 screening checklist was answered with, empty for an adult. */
    underFiveChecklist: string[];
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
     * The form talks through two kinds of native dialog, and they need opposite answers:
     * alert() reports a validation failure and cancels the submit, while confirm()
     * ("Do you want to save ...?") is the save asking to go ahead. Playwright dismisses
     * every dialog by default, which answers that confirm with Cancel and silently kills
     * the save — so accept confirms, and record only the alerts as blockers.
     * Call this before filling so a blocked Save can name its own reason.
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
        testRow: Locator,
        resultCell: Locator,
        min: number,
        max: number
    ): Promise<TestResult | null> {
        // Fall back on the spec's own range only for a test that states no numeric
        // band of its own (its normal value is worded, or it never renders one).
        const band =
            (await this.normalRangeFor(testRow)) ??
            ({ min, max, decimals: 0 } satisfies NormalRange);
        const numericValue = () => valueWithin(band);

        const numericResult = resultCell.getByRole('spinbutton').first();
        if (await isVisibleWithin(numericResult, 10000)) {
            const value = numericValue();
            if (!(await tryTypeValue(numericResult, value))) {
                return null;
            }
            return (await this.isOutOfRange(testRow)) ? null : { value, verifyAsText: false };
        }

        const resultField = resultCell.locator('input:not([disabled])').first();
        if (!(await isVisibleWithin(resultField, 5000))) {
            return null;
        }

        const isSelectize = await resultField.evaluate(
            (element) => element.closest('.selectize-control') !== null
        );

        if (!isSelectize) {
            const value = numericValue();
            if (!(await tryTypeValue(resultField, value))) {
                return null;
            }
            return (await this.isOutOfRange(testRow)) ? null : { value, verifyAsText: false };
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
        const value = numericValue();
        await resultField.fill('');
        await resultField.pressSequentially(value, { delay: 30 });
        await resultField.press('Enter');
        await this.page.keyboard.press('Escape');
        if (!(await holdsText(resultCell, value)) || (await this.isOutOfRange(testRow))) {
            return null;
        }
        return { value, verifyAsText: true };
    }

    /**
     * The Normal Value box the row fills in once its test is chosen. It is populated
     * asynchronously, so give it a moment before reading it.
     */
    private async normalRangeFor(testRow: Locator): Promise<NormalRange | null> {
        const normalValue = testRow.locator('[id^="inputTestNormalValue"]').first();

        if (!(await normalValue.count())) {
            return null;
        }

        for (let attempt = 0; attempt < 5; attempt += 1) {
            const stated = (await normalValue.inputValue().catch(() => '')) ?? '';
            const range = parseNormalRange(stated);
            if (range) {
                return range;
            }
            if (stated.trim()) {
                // The test states a worded normal ("Sinus Rhythm"): nothing to stay inside.
                return null;
            }
            await this.page.waitForTimeout(500);
        }

        return null;
    }

    /**
     * The form marks a result it will not accept with an "incorrect" note in the row,
     * and refuses to save while one is on screen. Catching it here lets the caller
     * swap the test out instead of finding out at Save.
     */
    private async isOutOfRange(testRow: Locator): Promise<boolean> {
        return testRow
            .locator('.abnormalRange')
            .first()
            .isVisible({ timeout: 1000 })
            .catch(() => false);
    }

    /**
     * The under-5 screening checklist ("Checklist for screening of under-5 children for
     * major childhood illnesses") is part of the case history form only when the patient
     * is a child; for anyone older it is not rendered at all. Its questions are required
     * radio groups, so a run that ignores the section gets no further than the browser's
     * own "Please select one of these options" bubble on Save.
     *
     * The groups are discovered from the page rather than pinned here: the section is
     * found by its heading, narrowed to the nearest ancestor that holds the first
     * question, and every radio group inside it is read off by name.
     */
    private async underFiveRadioGroups(): Promise<{ name: string; label: string }[]> {
        return this.page.evaluate(() => {
            const heading = Array.from(document.querySelectorAll<HTMLElement>('*')).find(
                (element) =>
                    element.children.length === 0 &&
                    /Checklist for screening of under-?\s*5 children/i.test(element.textContent || '')
            );

            if (!heading) {
                return [];
            }

            let section: HTMLElement | null = heading.parentElement;
            while (section && !/General Health/i.test(section.textContent || '')) {
                section = section.parentElement;
            }

            if (!section) {
                return [];
            }

            const groups: { name: string; label: string }[] = [];
            const seen = new Set<string>();

            for (const radio of Array.from(
                section.querySelectorAll<HTMLInputElement>('input[type="radio"]')
            )) {
                if (!radio.name || seen.has(radio.name)) {
                    continue;
                }
                seen.add(radio.name);

                // The question is whatever the row says before its options: the row for
                // "General Health: Good Fair Sick Very Sick" is reported as General Health.
                const row = radio.closest('tr, li, p, div');
                const rowText = (row?.textContent || radio.name).replace(/\s+/g, ' ').trim();
                groups.push({ name: radio.name, label: rowText.split(':')[0].trim().slice(0, 40) });
            }

            return groups;
        });
    }

    /** Whether this patient's form carries the under-5 checklist at all. */
    async hasUnderFiveChecklist(): Promise<boolean> {
        return (await this.underFiveRadioGroups()).length > 0;
    }

    /**
     * Answers the checklist and reports what it was answered with. Every question is
     * left at its first option — Good for general health, Absent for dehydration — which
     * is the healthy end of each scale and matches the well child the rest of the run
     * generates.
     *
     * The complaint checkboxes (Cough, Fever, Diarrhea ...) are deliberately left
     * unticked: ticking one enables its Type, Day and Duration controls, and each of
     * those then has to be answered too. A child with no complaints is the shortest
     * valid form, and a run that wants a sick child should say so in its data rather
     * than have this method invent symptoms.
     */
    async fillUnderFiveChecklist(): Promise<string[]> {
        const page = this.page;
        const groups = await this.underFiveRadioGroups();

        if (groups.length === 0) {
            return [];
        }

        const answered: string[] = [];

        for (const group of groups) {
            const options = page.locator(`input[type="radio"][name="${group.name}"]`);
            const chosen = page.locator(`input[type="radio"][name="${group.name}"]:checked`);

            // A group that already has an answer is left as it is. The section is found
            // by walking up from the heading, so on a form whose markup puts the heading
            // alongside the rest of the fields the walk can reach far enough to include
            // Allergies - which was answered above and must stay as it was set.
            if ((await chosen.count()) > 0) {
                continue;
            }

            // The radios carry no accessible name of their own and some sit under a
            // label that covers them, so they are checked by position and by force.
            await options.first().check({ force: true });

            const value = await chosen.first().getAttribute('value');
            answered.push(`${group.label}: ${value ?? 'first option'}`);
        }

        // Whatever the browser would still refuse to submit, named here rather than left
        // to surface as a bare timeout after Save.
        const unanswered = await page.evaluate(() => {
            const heading = Array.from(document.querySelectorAll<HTMLElement>('*')).find(
                (element) =>
                    element.children.length === 0 &&
                    /Checklist for screening of under-?\s*5 children/i.test(element.textContent || '')
            );

            let section: HTMLElement | null = heading ? heading.parentElement : null;
            while (section && !/General Health/i.test(section.textContent || '')) {
                section = section.parentElement;
            }

            if (!section) {
                return [];
            }

            const blocking = new Set<string>();
            for (const control of Array.from(
                section.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
                    'input:invalid, select:invalid, textarea:invalid'
                )
            )) {
                blocking.add(control.name || control.id || control.type);
            }

            return Array.from(blocking);
        });

        if (unanswered.length > 0) {
            throw new Error(
                `The under-5 checklist still has required answers the browser will block Save on: ${unanswered.join(', ')}`
            );
        }

        return answered;
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

        // Under-fives get an extra screening section that older patients never see, so
        // its absence is the normal case rather than a failure.
        const underFiveChecklist = await this.fillUnderFiveChecklist();

        const symptoms = await this.addSymptoms(caseHistory.symptomCount);
        const tests = await this.addTests(
            caseHistory.testCount,
            caseHistory.minTestValue,
            caseHistory.maxTestValue
        );

        return { nursingStaff, transportMode, ...symptoms, tests, underFiveChecklist };
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

            // The rest of the row is filled left to right, the order it is read and
            // entered on screen: how long the symptom has lasted, the unit that number
            // is counted in, then how bad it is.

            // "Duration" is a selectize control too, not a free-text box: typing only
            // fills its search query, which is thrown away on blur. Pick an option.
            const duration = await this.selectRandomOption(
                symptomRow.getByRole('textbox', { name: 'Duration', exact: true }),
                /^\d/
            );
            durations.push(duration);
            await expect(symptomRow).toContainText(duration, { useInnerText: true });

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

                result = await this.enterTestResult(testRow, resultCell, min, max);

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

        if (holdOpen) {
            // Save is clicked and its "Do you want to save ...?" popup has been answered
            // with OK. Stop right here so the browser stays on what the save produced —
            // no next-page wait, and the spec skips its logout. Resume to end the run.
            await page.pause();
            return;
        }

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
