import type { Locator, Page } from '@playwright/test';

/**
 * Every control on the doctor's prescription form is a selectize widget, and they all
 * behave the same awkward way, so the handling lives here once instead of being
 * repeated per field.
 *
 * Three things about selectize shape everything below:
 *
 *   - The real <input> is collapsed to zero width once a value is picked, so a plain
 *     .click() on it can miss. Clicking the wrapper (.selectize-control) is what a user
 *     actually hits.
 *   - Picking a value drops the placeholder, and with it the accessible name, so a field
 *     can only be found by name *before* it is filled. Anything looked up afterwards has
 *     to be anchored on something that survives - the row, or the control's own class.
 *   - The dropdown re-renders as it filters, so an option found by text and then clicked
 *     by text can resolve to a detached element. Options are picked by index instead.
 */

export function randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function pickRandom<T>(items: T[]): T {
    return items[Math.floor(Math.random() * items.length)];
}

/** Anything that is not the "--Select a ...--" placeholder row. */
export const notAPlaceholder = /^(?!\s*--)\S/;

export async function isVisibleWithin(locator: Locator, timeout: number): Promise<boolean> {
    return locator
        .waitFor({ state: 'visible', timeout })
        .then(() => true)
        .catch(() => false);
}

/** Marks the dropdown belonging to the control a run has just opened. */
const OPEN_DROPDOWN_ATTRIBUTE = 'data-pw-selectize-open';

/**
 * The .selectize-control wrapper for a field, whether the wrapper itself or the inner
 * input was passed - which is what lets a field be addressed by its accessible name.
 */
function controlWrapper(field: Locator): Locator {
    return field
        .locator('xpath=ancestor-or-self::div[contains(@class,"selectize-control")][1]')
        .first();
}

/**
 * Opens a selectize and hands back its own dropdown.
 *
 * Two things here were getting fields filled with another control's values:
 *
 *   - Selectize opens on mousedown, and a JS element.click() fires no mousedown at all,
 *     so opening a control that way does nothing. The control stays shut while some
 *     other list - the diagnosis picker is open from the moment the prescription form
 *     loads - is left showing, and options read off the page then belong to that one.
 *     A real click is what opens the control a run means to open.
 *   - Selectize hangs its dropdown off <body> rather than off the control, so there is
 *     no way down to it through the DOM. The control's own selectize instance knows
 *     which element is its dropdown, so it is tagged here and the options are read back
 *     from that rather than from whatever happens to be open.
 */
export async function openSelectize(field: Locator): Promise<Locator> {
    const wrapper = controlWrapper(field);

    await wrapper.click({ timeout: 10000 }).catch(async () => {
        await field.click({ force: true }).catch(() => undefined);
    });

    await wrapper
        .evaluate((element, attribute) => {
            document
                .querySelectorAll(`[${attribute}]`)
                .forEach((node) => node.removeAttribute(attribute));

            const select = element.previousElementSibling as
                | (Element & { selectize?: { $dropdown?: HTMLElement[] } })
                | null;
            select?.selectize?.$dropdown?.[0]?.setAttribute(attribute, '1');
        }, OPEN_DROPDOWN_ATTRIBUTE)
        .catch(() => undefined);

    return field.page().locator(`[${OPEN_DROPDOWN_ATTRIBUTE}]`);
}

export type PickOptions = {
    /** Which options are eligible. Defaults to "anything but the placeholder". */
    filter?: RegExp;
    /** Options already used elsewhere, so a run never picks the same one twice. */
    exclude?: string[];
    /** How long to wait for the dropdown before giving up. */
    timeout?: number;
};

/**
 * Opens the control and picks one of its options at random, reporting what was picked.
 * Returns null when the control offers nothing to pick - a dropdown that never opened,
 * or one whose only entries are the placeholder - so a caller can type into it or move
 * on instead of failing over an empty list.
 */
export async function pickRandomOption(
    page: Page,
    field: Locator,
    options: PickOptions = {}
): Promise<string | null> {
    const { filter = notAPlaceholder, exclude = [], timeout = 5000 } = options;

    const dropdown = await openSelectize(field);

    let items = dropdown.locator('.option').filter({ hasText: filter });

    if (!(await isVisibleWithin(items.first(), timeout))) {
        // This control's own list never came up. Fall back to whatever is open, which is
        // how this read before, rather than giving up on a control whose selectize
        // instance could not be read back - but only after its own list has been waited
        // for, so another control's options are never mistaken for this one's.
        items = page.locator('.selectize-dropdown:visible .option').filter({ hasText: filter });

        if (!(await isVisibleWithin(items.first(), 1000))) {
            await page.keyboard.press('Escape').catch(() => undefined);
            return null;
        }
    }

    const candidates = (await items.allInnerTexts())
        .map((text, index) => ({ text: text.replace(/\s+/g, ' ').trim(), index }))
        .filter(({ text }) => text.length > 0 && !exclude.includes(text));

    if (candidates.length === 0) {
        await page.keyboard.press('Escape').catch(() => undefined);
        return null;
    }

    const chosen = pickRandom(candidates);
    await items.nth(chosen.index).click();
    await page.keyboard.press('Escape').catch(() => undefined);

    return chosen.text;
}

/**
 * Picks whichever option a scoring function rates lowest, skipping the ones it cannot
 * score at all.
 *
 * Quantities are chosen this way rather than at random because the form checks what is
 * prescribed against the centre's stock and refuses the save when it runs over: "Available
 * Quantity in stock is 52 || Prescribed Quantity is 120". A random 8 a day for 15 days is
 * exactly that refusal, and it says nothing about whether the form itself works.
 */
async function pickLowestOption(
    page: Page,
    field: Locator,
    score: (text: string) => number,
    options: PickOptions = {}
): Promise<string | null> {
    const { filter = notAPlaceholder, exclude = [], timeout = 5000 } = options;

    const dropdown = await openSelectize(field);

    let items = dropdown.locator('.option').filter({ hasText: filter });

    if (!(await isVisibleWithin(items.first(), timeout))) {
        items = page.locator('.selectize-dropdown:visible .option').filter({ hasText: filter });

        if (!(await isVisibleWithin(items.first(), 1000))) {
            await page.keyboard.press('Escape').catch(() => undefined);
            return null;
        }
    }

    const scored = (await items.allInnerTexts())
        .map((text, index) => ({ text: text.replace(/\s+/g, ' ').trim(), index }))
        .filter(({ text }) => text.length > 0 && !exclude.includes(text))
        .map((option) => ({ ...option, value: score(option.text) }))
        .filter((option) => Number.isFinite(option.value) && option.value > 0);

    if (scored.length === 0) {
        await page.keyboard.press('Escape').catch(() => undefined);
        return null;
    }

    const lowest = scored.reduce((best, next) => (next.value < best.value ? next : best));

    await items.nth(lowest.index).click();
    await page.keyboard.press('Escape').catch(() => undefined);

    return lowest.text;
}

/** Every number an option carries, in the order they read. */
function numbersIn(text: string): number[] {
    return (text.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
}

/**
 * Picks the lowest number a control offers, reading the first number out of each option
 * so "2", "2 Days" and "0.5 ml" all count, and ignoring entries with no number in them.
 */
export async function pickSmallestNumericOption(
    page: Page,
    field: Locator,
    options: PickOptions = {}
): Promise<string | null> {
    return pickLowestOption(page, field, (text) => numbersIn(text)[0] ?? Number.NaN, options);
}

/** How the frequency column spells a dose count when it spells it in words. */
const doseWords: [RegExp, number][] = [
    [/\bonce\b|\bo\.?d\.?\b|\bdaily\b|\bhs\b|\bbedtime\b/i, 1],
    [/\btwice\b|\bb\.?d\.?\b|\bbid\b/i, 2],
    [/\bthrice\b|\bthree times\b|\btds\b|\btid\b/i, 3],
    [/\bfour times\b|\bqid\b|\bqds\b/i, 4],
];

/**
 * How many doses a day an option works out to, which is not the same question as the
 * smallest number in it: How Often reads "1-0-1" - morning, afternoon, night - so what
 * counts is the three added together (two doses a day), not the one it starts with.
 * Where an option carries no digits at all ("Once a day", "BD") the wording is read
 * instead, and anything that answers to neither is passed over rather than guessed at.
 */
function dosesPerDay(text: string): number {
    const numbers = numbersIn(text);

    if (numbers.length > 0) {
        return numbers.reduce((total, next) => total + next, 0);
    }

    const word = doseWords.find(([pattern]) => pattern.test(text));

    return word ? word[1] : Number.NaN;
}

/**
 * Picks the How Often entry that comes to the fewest doses a day - the lever with the
 * most give in it when the centre's stock will not cover what was prescribed, since the
 * form multiplies this by the dosage and the duration to get the quantity it checks.
 */
export async function pickSmallestDoseOption(
    page: Page,
    field: Locator,
    options: PickOptions = {}
): Promise<string | null> {
    return pickLowestOption(page, field, dosesPerDay, options);
}

/**
 * A field that may be a dropdown of preset entries or a free-text box, depending on how
 * the environment is configured - Dosage is a picklist on one centre and typed on
 * another. Try the dropdown first, fall back to typing, and report what ended up in it.
 *
 * Typing into a free-text selectize needs Enter: the query is only turned into a value
 * when it is committed as an item, and is otherwise thrown away on blur.
 */
export async function pickOrType(
    page: Page,
    field: Locator,
    fallbackValue: string,
    options: PickOptions = {}
): Promise<string | null> {
    const picked = await pickRandomOption(page, field, options);
    if (picked !== null) {
        return picked;
    }

    const input = (await field.evaluate((element) => element.tagName).catch(() => '')) === 'INPUT'
        ? field
        : field.locator('input').first();

    if (!(await isVisibleWithin(input, 2000))) {
        return null;
    }

    const isSelectize = await input
        .evaluate((element) => element.closest('.selectize-control') !== null)
        .catch(() => false);

    await input.click({ force: true }).catch(() => undefined);
    await input.fill('').catch(() => undefined);
    await input.pressSequentially(fallbackValue, { delay: 25 });

    if (isSelectize) {
        await input.press('Enter').catch(() => undefined);
        await page.keyboard.press('Escape').catch(() => undefined);
    } else {
        await input.blur().catch(() => undefined);
    }

    return fallbackValue;
}
