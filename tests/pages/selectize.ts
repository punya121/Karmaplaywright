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

/**
 * Opens a selectize through its wrapper. Passing the inner input works too - the wrapper
 * is found from it - which is what lets a field be addressed by its accessible name.
 */
export async function openSelectize(field: Locator): Promise<void> {
    const opened = await field
        .evaluate((element) => {
            const wrapper = element.closest('.selectize-control');
            if (!wrapper) {
                return false;
            }
            (wrapper as HTMLElement).click();
            return true;
        })
        .catch(() => false);

    if (!opened) {
        await field.click();
    }
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

    await openSelectize(field);

    const items = page.locator('.selectize-dropdown:visible .option').filter({ hasText: filter });

    if (!(await isVisibleWithin(items.first(), timeout))) {
        await page.keyboard.press('Escape').catch(() => undefined);
        return null;
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
