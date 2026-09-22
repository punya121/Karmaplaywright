import { expect, type Locator, type Page } from '@playwright/test';
import { baseUrl } from '../config/test-env';
import { lastDaysToToday, previousDayToToday, type BillingRange, type DateForms } from '../data/bills';

/**
 * Reconciliation > Reconciliation (/Reconciliation).
 *
 * The other half of the centre-wide block. The app refuses every case history with
 *
 *   "Please complete all pending reconciliations and create bills for the previous day.
 *    If already done, kindly refresh the page"
 *
 * and the bills are only part of that: each patient seen on the previous day also has to
 * be reconciled - the amount actually taken against the price charged - and saved, one row
 * at a time. This page object does that the way the centre staff do: open the screen from
 * the menu, pick From and To in the calendars, Search, and press Save on every patient row
 * still waiting on it.
 *
 * What the screen looks like, read off the live page (reports/inspect/reconciliation/):
 * From and To are #datepicker and #datepicker1, jQuery UI datepickers; Search is a form
 * POST; and every unreconciled row carries a Save link that calls
 * individualConcilitonSave(<id>), which posts the row and then reloads the page on the same
 * From and To. A row the app will not take (a discount a nurse is not allowed to sign off,
 * a comment it insists on) answers in an alert instead, and stays on the list.
 */
export type ReconciledRow = {
    /** The row's own id - the argument its Save link passes to individualConcilitonSave(). */
    rowId: string;
    patientName: string;
    /** The Date column as displayed. */
    date: string;
    /** The whole row, flattened, for the log and the report. */
    summary: string;
};

export type ReconciliationResult = {
    saved: ReconciledRow[];
    /** Rows the app refused to save, with its own reason. */
    refused: (ReconciledRow & { reason: string })[];
    /** The From - To the saves were made against, as the picker read it. */
    period: string;
};

export class ReconciliationPage {
    constructor(private readonly page: Page) {}

    /**
     * The alerts this screen answers in. Playwright dismisses dialogs by default, and an
     * unanswered alert leaves the page's own script stopped half way through a save.
     */
    captureDialogs(messages: string[] = []): string[] {
        this.page.on('dialog', async (dialog) => {
            if (dialog.type() === 'alert') {
                messages.push(dialog.message().trim());
            }
            await dialog.accept().catch(() => undefined);
        });
        return messages;
    }

    /**
     * Opens Reconciliation > Reconciliation through the menu. The top-level "Reconciliation"
     * has no href of its own - it only opens the submenu - so it is the submenu link, the one
     * pointing at /Reconciliation, that is clicked. The URL is the fallback.
     */
    async open(): Promise<void> {
        const menu = this.page
            .locator('#cssmenu li.has-sub > a')
            .filter({ hasText: /^\s*Reconciliation\s*$/i })
            .first();
        const reconciliation = this.page.locator('#cssmenu a[href$="/Reconciliation"]').first();

        if (await menu.isVisible({ timeout: 5000 }).catch(() => false)) {
            await menu.click().catch(() => undefined);

            if (await reconciliation.isVisible({ timeout: 5000 }).catch(() => false)) {
                await reconciliation.click().catch(() => undefined);
                await this.page.waitForLoadState('load').catch(() => undefined);
            }
        }

        if (!/\/Reconciliation\b/i.test(this.page.url())) {
            await this.page.goto(`${baseUrl.replace(/\/$/, '')}/Reconciliation`);
        }

        await this.expectLoaded();
    }

    async expectLoaded(): Promise<void> {
        await expect(this.page, 'Reconciliation did not open').toHaveURL(/\/Reconciliation\b/i, {
            timeout: 20000,
        });
        await expect(this.searchButton(), 'Reconciliation has no Search button').toBeVisible({
            timeout: 20000,
        });
    }

    private fromField(): Locator {
        return this.page.locator('#datepicker');
    }

    private toField(): Locator {
        return this.page.locator('#datepicker1');
    }

    private searchButton(): Locator {
        return this.page.locator('#Search');
    }

    /**
     * Every Save link still on the grid. Rows already reconciled have no Save, so this is
     * the list of what is left to do.
     */
    private saveLinks(): Locator {
        return this.page.locator(
            '#tablewrap a.individual_save, #tablewrap a[onclick*="individualConcilitonSave"]'
        );
    }

    /**
     * Picks one date in a jQuery UI datepicker by clicking it, the way a person does: open
     * the calendar, walk it to the month by its title, click the day. jQuery UI stamps each
     * day cell with data-month (0-based) and data-year, so the cell is found by those rather
     * than by its number alone - the greyed days of the neighbouring months carry the same
     * numbers.
     *
     * Falls back to typing the date in the picker's own format ("20 September 2026") if no
     * calendar opens.
     */
    private async pickDate(field: Locator, target: DateForms): Promise<string> {
        await field.click({ timeout: 10000 });

        const panel = this.page.locator('#ui-datepicker-div');

        if (!(await panel.isVisible({ timeout: 5000 }).catch(() => false))) {
            await field.fill(`${target.day.padStart(2, '0')} ${target.monthLong} ${target.year}`);
            await this.page.keyboard.press('Escape').catch(() => undefined);
            return (await field.inputValue()).trim();
        }

        const month = target.date.getMonth();
        const year = target.date.getFullYear();
        const wanted = year * 12 + month;

        for (let step = 0; step < 24; step += 1) {
            const title = (await panel.locator('.ui-datepicker-title').innerText()).replace(/\s+/g, ' ');
            const shown = new Date(`1 ${title}`);

            if (Number.isNaN(shown.getTime())) {
                break;
            }

            const shownIndex = shown.getFullYear() * 12 + shown.getMonth();

            if (shownIndex === wanted) {
                break;
            }

            await panel
                .locator(shownIndex > wanted ? '.ui-datepicker-prev' : '.ui-datepicker-next')
                .click({ timeout: 5000 });
        }

        const day = panel
            .locator(`td[data-month="${month}"][data-year="${year}"] a`)
            .filter({ hasText: new RegExp(`^\\s*${target.day}\\s*$`) })
            .first();

        await expect(
            day,
            `${target.label} is not selectable in the Reconciliation calendar`
        ).toBeVisible({ timeout: 5000 });
        await day.click({ timeout: 5000 });

        const value = (await field.inputValue()).trim();

        expect(
            value,
            `The Reconciliation calendar did not take ${target.label} - the box reads "${value}"`
        ).toContain(target.year);

        return value;
    }

    /** Sets From and To in the calendars and presses Search. Returns what the boxes read. */
    async search(range: BillingRange): Promise<string> {
        const from = await this.pickDate(this.fromField(), range.from);
        const to = await this.pickDate(this.toField(), range.to);

        // Search is a form POST back to /Reconciliation/, so the URL barely changes; the
        // page's load event is what says the grid has come back.
        const reloaded = this.page.waitForEvent('load', { timeout: 30000 });
        await this.searchButton().click();
        await reloaded;
        await this.expectLoaded();

        const period = `${from} - ${to}`;
        console.log(`Reconciliation searched ${period}: ${await this.saveLinks().count()} row(s) to save`);

        return period;
    }

    private async readRow(link: Locator, rowId: string): Promise<ReconciledRow> {
        const cells = (await link.locator('xpath=ancestor::tr[1]').locator('td').allInnerTexts()).map(
            (cell) => cell.replace(/\s+/g, ' ').trim()
        );

        // Cell layout per the page's own script: 1 Name, 2 Date.
        return {
            rowId,
            patientName: cells[1] ?? '',
            date: cells[2] ?? '',
            summary: cells.filter(Boolean).slice(0, 12).join(' | '),
        };
    }

    /**
     * Presses Save on every row still waiting, one at a time. Each successful Save reloads
     * the page on the same period, so the grid is re-read after every one rather than
     * walked by index. A row the app refuses stays on the grid; it is remembered and
     * stepped over, so one row the nurse cannot sign off does not stop the rest being saved.
     */
    async saveAll(dialogMessages: string[], maxSaves: number): Promise<Omit<ReconciliationResult, 'period'>> {
        const saved: ReconciledRow[] = [];
        const refused: ReconciliationResult['refused'] = [];
        const skipped = new Set<string>();
        const attempts = new Map<string, number>();

        for (;;) {
            const links = this.saveLinks();
            const count = await links.count();
            let next: { link: Locator; rowId: string } | undefined;

            for (let index = 0; index < count; index += 1) {
                const link = links.nth(index);
                const onclick = (await link.getAttribute('onclick')) ?? '';
                const rowId = /individualConcilitonSave\(\s*['"]?(\d+)/.exec(onclick)?.[1] ?? `row-${index}`;

                if (!skipped.has(rowId) && (await link.isVisible().catch(() => false))) {
                    next = { link, rowId };
                    break;
                }
            }

            if (!next) {
                break;
            }

            if (saved.length >= maxSaves) {
                throw new Error(
                    `Stopped after saving ${maxSaves} reconciliations and more are still waiting. ` +
                        'Raise E2E_MAX_RECONCILIATIONS if that is genuinely the size of the backlog.'
                );
            }

            const row = await this.readRow(next.link, next.rowId);
            const tries = (attempts.get(row.rowId) ?? 0) + 1;
            attempts.set(row.rowId, tries);

            // A row that is back on the grid after a save that raised no alert did not take;
            // saving it forever would not help.
            if (tries > 2) {
                throw new Error(
                    `Reconciliation row ${row.rowId} (${row.patientName}) is still waiting after ` +
                        `being saved twice. The app said: ${dialogMessages.slice(-3).join(' | ') || '(nothing)'}`
                );
            }

            const alertsBefore = dialogMessages.length;
            const reloaded = this.page
                .waitForEvent('load', { timeout: 30000 })
                .then(() => true)
                .catch(() => false);

            await next.link.click({ timeout: 10000 });

            // Either the save posts and the page reloads, or the app refuses in an alert and
            // stays put. Whichever comes first decides it.
            const alerted = (async () => {
                for (let tick = 0; tick < 120; tick += 1) {
                    if (dialogMessages.length > alertsBefore) {
                        return true;
                    }
                    await this.page.waitForTimeout(250);
                }
                return false;
            })();

            await Promise.race([reloaded, alerted]);
            const said = dialogMessages.slice(alertsBefore).join(' | ');

            if (said) {
                console.log(`Reconciliation row ${row.rowId} (${row.patientName}) was refused: ${said}`);
                refused.push({ ...row, reason: said });
                skipped.add(row.rowId);
                continue;
            }

            await this.page.waitForLoadState('load').catch(() => undefined);
            await this.expectLoaded();

            saved.push(row);
            console.log(`Reconciled ${row.patientName || 'row'} ${row.rowId}${row.date ? ` (${row.date})` : ''}`);
        }

        return { saved, refused };
    }

    /**
     * The routine a blocked consultation run calls: open Reconciliation, search the previous
     * day through today, and save every patient on it. If that period holds nothing, the net
     * is widened once - a centre closed yesterday is blocked by the last day it worked.
     */
    async reconcilePending(
        options: { maxSaves?: number; lookbackDays?: number; dialogMessages?: string[] } = {}
    ): Promise<ReconciliationResult> {
        const maxSaves = options.maxSaves ?? Number(process.env.E2E_MAX_RECONCILIATIONS ?? 50);
        const lookbackDays = options.lookbackDays ?? Number(process.env.E2E_BILL_LOOKBACK_DAYS ?? 7);
        const dialogMessages = options.dialogMessages ?? this.captureDialogs();

        let result: ReconciliationResult = { saved: [], refused: [], period: '' };

        for (const range of [previousDayToToday(), lastDaysToToday(lookbackDays)]) {
            await this.open();
            const period = await this.search(range);
            const { saved, refused } = await this.saveAll(dialogMessages, maxSaves);

            result = { saved, refused, period };

            if (saved.length > 0 || refused.length > 0) {
                break;
            }
        }

        console.log(
            result.saved.length === 0 && result.refused.length === 0
                ? `Nothing was waiting on Reconciliation (last searched ${result.period}).`
                : `Reconciliation ${result.period}: ${result.saved.length} saved` +
                      (result.refused.length ? `, ${result.refused.length} refused by the app` : '')
        );

        return result;
    }
}
