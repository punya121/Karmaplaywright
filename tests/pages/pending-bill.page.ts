import { expect, type Locator, type Page } from '@playwright/test';
import { baseUrl } from '../config/test-env';
import { pickRandom } from './selectize';
import {
    lastDaysToToday,
    previousDayToToday,
    randomBatchNumber,
    randomExpiryDate,
    type BillingRange,
    type DateForms,
    type ExpiryDate,
} from '../data/bills';

/**
 * Bill > View Pending Bills (/PendingBill) and the prescription view a pending bill is
 * created from.
 *
 * A prescription the doctor has saved is not finished with: the pharmacy still has to
 * bill it, naming the batch and expiry of every medicine actually handed over. Until
 * that is done for the previous day, the centre is blocked - the app refuses to start a
 * case history at all and says so:
 *
 *   "Please complete all pending reconciliations and create bills for the previous day.
 *    If already done, kindly refresh the page"
 *
 * which is why this page object exists outside its own spec: a consultation run that
 * walks into that refusal can clear the backlog and carry on, instead of stopping until
 * somebody tidies the centre up by hand. See clearPendingBills().
 *
 * The batch number and expiry are drawn fresh per medicine line (tests/data/bills.ts) -
 * they are free text off a strip, so there is no fixed right answer and a run that typed
 * the same value every time would prove only that the field accepts that value.
 */
export type BilledMedicine = {
    /** Which line on the bill, 0-based. */
    line: number;
    /** The medicine as the bill names it, e.g. "PANTOVENT D TAB (Pantoprazole 40 mg...)". */
    medicine: string;
    /** Generated — the batch is free text off a strip. */
    batchNumber: string;
    /** Chosen out of the Date of Expiry dropdown, so it is one the app actually offers. */
    expiry: string;
};

/** One row of View Pending Bills, read before its Create Bill is pressed. */
export type PendingBillRow = {
    /** The History ID column — the prescription being billed. */
    historyId: string;
    patientId: string;
    patientName: string;
    /** The Date column, as displayed, e.g. "14 Sep 2026". */
    date: string;
    /** The whole row, flattened, for the log and the report. */
    summary: string;
};

/**
 * The bill itself. Create Bill opens a window of its own, so this carries the page that
 * window belongs to — which is emphatically not the page the listing is on.
 */
export type BillWindow = {
    page: Page;
    /** False when the app navigated in this tab instead, in which case it is not closed. */
    isPopup: boolean;
    listing: PendingBillRow;
    prescriptionId: string;
    /**
     * Set when Create Bill answered "no patients" instead of opening the bill — see
     * NOTHING_TO_BILL. There is then no bill window and nothing to fill in.
     */
    nothingToBill?: string;
};

export type CreatedBill = {
    /** The prescription this bill was for — the row's History ID. */
    prescriptionId: string;
    patientId: string;
    patientName: string;
    /** The date the row carried, e.g. "14 Sep 2026". */
    billedFor: string;
    medicines: BilledMedicine[];
    /** What the app said if it refused the submit; empty when it took it. */
    complaint: string;
    /**
     * The app's own words when it said there was nobody to bill, whether that came back
     * on Create Bill or on the submit. Empty on a bill that was actually created. A run
     * that gets this has not failed — there is simply no billing to do — so it carries
     * on to the next step rather than reporting a refusal.
     */
    nothingToBill: string;
};

/**
 * How the app says there is nobody to bill.
 *
 * Two shapes of the same answer, and neither is a fault: the list can come back empty,
 * and a list with rows on it can still answer Create Bill with "no patients" — a row
 * somebody else billed in the meantime, or one the app no longer counts. Both mean the
 * same thing for a run that is only here to clear a backlog, so both let it move on
 * instead of stopping to report a refusal it cannot do anything about.
 *
 * Matched only against this screen's own words — the empty grid's row and the alerts
 * Fetch, Create Bill and Submit raise — so it is not at risk of catching a message about
 * something else.
 */
const NOTHING_TO_BILL =
    /\bno\s+(?:patient|patients|pending|data|record|records|prescription|prescriptions|result|results|bill|bills)\b|\bnothing\s+(?:to\s+bill|pending)\b|\bnot\s+found\b/i;

export class PendingBillPage {
    constructor(private readonly page: Page) {}

    /**
     * The alerts this screen talks through. Playwright dismisses dialogs by default,
     * which answers a "create this bill?" confirm with Cancel and kills the submit in
     * silence, so they are accepted and the alerts kept as the app's own words.
     */
    captureDialogs(page: Page = this.page, messages: string[] = []): string[] {
        page.on('dialog', async (dialog) => {
            if (dialog.type() === 'alert') {
                messages.push(dialog.message().trim());
            }
            await dialog.accept().catch(() => undefined);
        });
        return messages;
    }

    /**
     * Opens Bill > View Pending Bills.
     *
     * Through the menu, the way a user gets there, but not through the menu's position:
     * `#cssmenu > ul > li:nth-of-type(6) > a` is the sixth item of whatever that centre's
     * menu held that afternoon, and a centre with one module more or less has a different
     * sixth item. The menu is found by its name first, that selector is the fallback, and
     * the URL itself is the last resort - it is a plain GET either way.
     */
    async open(): Promise<void> {
        const menu = this.page
            .locator('#cssmenu')
            .getByRole('link', { name: /^\s*Bill(ing)?\s*$/i })
            .or(this.page.locator('#cssmenu > ul > li:nth-of-type(6) > a'))
            .first();

        const viewPendingBills = this.page
            .getByRole('link', { name: /view pending bills/i })
            .or(this.page.getByText(/view pending bills/i))
            .first();

        if (await menu.isVisible({ timeout: 5000 }).catch(() => false)) {
            await menu.click().catch(() => undefined);

            if (await viewPendingBills.isVisible({ timeout: 5000 }).catch(() => false)) {
                await viewPendingBills.click().catch(() => undefined);
                await this.page.waitForLoadState('load').catch(() => undefined);
            }
        }

        if (!/PendingBill/i.test(this.page.url())) {
            await this.page.goto(`${baseUrl.replace(/\/$/, '')}/PendingBill`);
        }

        await this.expectLoaded();
    }

    async expectLoaded(): Promise<void> {
        await expect(this.page, 'View Pending Bills did not open').toHaveURL(/PendingBill/i, {
            timeout: 20000,
        });
        await expect(
            this.fetchButton(),
            'View Pending Bills has no control to fetch orders with'
        ).toBeVisible({ timeout: 20000 });
    }

    private fetchButton(): Locator {
        return this.page
            .locator('#fetchOrderBtn')
            .or(this.page.getByRole('button', { name: /fetch|search/i }))
            .first();
    }

    private billTable(): Locator {
        return this.page.locator('#medicineRegisterTable');
    }

    private periodPicker(): Locator {
        return this.page.locator('#monthYearPicker').first();
    }

    /**
     * Opens the period picker and closes it again on whatever it already had. Only for
     * the spec that checks the control opens; a run after a backlog uses selectPeriod().
     */
    async openMonthYearPicker(): Promise<boolean> {
        const picker = this.periodPicker();

        if (!(await picker.isVisible({ timeout: 5000 }).catch(() => false))) {
            return false;
        }

        await picker.click().catch(() => undefined);
        await this.page.keyboard.press('Escape').catch(() => undefined);

        return true;
    }

    /**
     * Puts the list on a date range — "14 Sep 2026 - 15 Sep 2026" — before it is fetched.
     *
     * This is what the control on this screen actually is. "Select Month & Year" reads
     * like a month picker and is named like one (#monthYearPicker), but what it opens is
     * a two-month range calendar with Clear and Apply under it, and what it holds is two
     * dates: a from and a to. It comes up on today to today, which is why a run that
     * pressed Fetch on whatever was in the box saw an empty grid and concluded the centre
     * was up to date while the app went on refusing - yesterday's bills were simply not
     * in the period being asked for.
     *
     * So the from day is clicked, then the to day, then Apply - the same three actions a
     * person makes. Both are clicked in the calendar that is actually showing that month,
     * because the widget draws two side by side and the same number appears in both.
     */
    async selectDateRange(from: DateForms, to: DateForms): Promise<string> {
        const picker = this.periodPicker();

        if (!(await picker.isVisible({ timeout: 5000 }).catch(() => false))) {
            return '';
        }

        await picker.click({ timeout: 10000 }).catch(() => undefined);

        const panel = this.page.locator('.daterangepicker:visible').first();

        if (!(await panel.isVisible({ timeout: 5000 }).catch(() => false))) {
            // Not the range picker after all — fall back to the single-date handling,
            // which covers native inputs, selects and the other calendar libraries.
            await this.page.keyboard.press('Escape').catch(() => undefined);
            return this.selectPeriod(from);
        }

        await this.clickRangeDay(panel, from, 'from');
        await this.clickRangeDay(panel, to, 'to');

        // Nothing is applied to the list until Apply is pressed; the box shows the range
        // it is about to take, which is not the same as having taken it.
        const apply = panel
            .locator('.applyBtn')
            .or(panel.getByRole('button', { name: /^\s*apply\s*$/i }))
            .first();

        if (await apply.isVisible({ timeout: 3000 }).catch(() => false)) {
            await apply.click({ timeout: 5000 }).catch(() => undefined);
        }

        // The panel sits over the Fetch button until it closes.
        if (await panel.isVisible({ timeout: 1000 }).catch(() => false)) {
            await this.page.keyboard.press('Escape').catch(() => undefined);
        }

        const chosen = (await picker.inputValue().catch(() => '')).trim();

        // Worth checking rather than assuming: a day the widget had disabled takes the
        // click without doing anything, and the range then silently stays as it was.
        if (chosen && !chosen.includes(from.day)) {
            console.log(
                `The period picker was asked for ${from.label} to ${to.label} but reads ` +
                    `"${chosen}". The day may have been out of the range the widget allows.`
            );
        }

        return chosen;
    }

    /**
     * Clicks one end of the range.
     *
     * The widget draws two months at once, so "14" is on screen twice over as often as
     * not - once in each calendar - and the cells belonging to the months either side are
     * drawn in too, greyed, under the class `off`. The right cell is therefore the one in
     * the calendar whose own heading says the month being asked for, and only among that
     * calendar's own days. Clicking a greyed neighbour picks a date in a different month
     * and moves the calendar under the next click.
     *
     * The months on screen are whatever the widget opened on, so it is walked to the one
     * wanted first - reading the heading each time rather than counting clicks, because
     * where it opens depends on the range it is already holding.
     */
    private async clickRangeDay(panel: Locator, target: DateForms, end: 'from' | 'to'): Promise<void> {
        const calendars = panel.locator('.drp-calendar, .calendar');
        const monthHeading = new RegExp(`${target.monthShort}\\w*\\s+${target.year}`, 'i');

        for (let step = 0; step < 24; step += 1) {
            const showing = await calendars.count();
            let landed: Locator | undefined;

            for (let index = 0; index < showing; index += 1) {
                const calendar = calendars.nth(index);
                const heading = (
                    (await calendar
                        .locator('th.month, .month')
                        .first()
                        .innerText()
                        .catch(() => '')) || ''
                ).replace(/\s+/g, ' ');

                if (monthHeading.test(heading)) {
                    landed = calendar;
                    break;
                }
            }

            if (landed) {
                // `off` is the previous or next month bleeding into this grid; `disabled`
                // is a day the widget will not take - a date in the future, here, since
                // the list cannot be asked for bills that have not happened yet.
                const cell = landed
                    .locator(
                        'td.available:not(.off):not(.disabled), ' +
                            'td:not(.off):not(.disabled):not(.week)'
                    )
                    .filter({ hasText: new RegExp(`^\\s*${target.day}\\s*$`) })
                    .first();

                await expect(
                    cell,
                    `The ${end} day ${target.label} is not selectable in the period picker - ` +
                        'the calendar is showing its month but the day is greyed out or missing'
                ).toBeVisible({ timeout: 5000 });

                await cell.click({ timeout: 5000 });
                return;
            }

            // Not on screen: walk towards it. The left calendar's arrows move both months.
            const targetIndex = target.date.getFullYear() * 12 + target.date.getMonth();
            const leftHeading = (
                (await calendars
                    .first()
                    .locator('th.month, .month')
                    .first()
                    .innerText()
                    .catch(() => '')) || ''
            ).replace(/\s+/g, ' ');

            const shownYear = Number(/\b(20\d{2})\b/.exec(leftHeading)?.[1] ?? target.year);
            const shownMonthName = /[A-Za-z]{3,}/.exec(leftHeading)?.[0] ?? '';
            const shownMonth = new Date(`${shownMonthName || 'Jan'} 1, 2000`);
            const shownIndex = Number.isNaN(shownMonth.getTime())
                ? targetIndex + 1
                : shownYear * 12 + shownMonth.getMonth();

            const arrow = panel.locator(shownIndex > targetIndex ? 'th.prev' : 'th.next').first();

            if (!(await arrow.isVisible({ timeout: 2000 }).catch(() => false))) {
                throw new Error(
                    `The period picker is showing ${leftHeading || '(an unreadable month)'} and ` +
                        `offers no way to reach ${target.monthLong} ${target.year}`
                );
            }

            await arrow.click({ timeout: 5000 }).catch(() => undefined);
        }

        throw new Error(
            `The period picker would not walk to ${target.monthLong} ${target.year} for the ` +
                `${end} end of the range`
        );
    }

    /**
     * Puts the list on a particular day before it is fetched.
     *
     * This is the difference between clearing the backlog and reporting that there isn't
     * one. The app's refusal names the day it is waiting on - "create bills for the
     * previous day" - and the screen does not come up on that day, it comes up on the
     * period it considers current. A run that pressed Fetch on whatever was already in
     * the box got an empty grid and concluded, wrongly, that the centre was up to date.
     *
     * How the date gets in depends on what the control turns out to be, so it is asked
     * rather than assumed. A native date or month input takes text and nothing else. A
     * <select> takes an option. A plain text box takes the format it declares. And a box
     * a calendar widget owns - which is what most of these are, and they are usually
     * readonly, so no amount of typing reaches them - takes a cell being clicked, which
     * means finding the calendar, walking it back to the right month, and clicking the
     * day. All four are covered below, in that order.
     */
    async selectPeriod(target: DateForms): Promise<string> {
        const picker = this.periodPicker();

        if (!(await picker.isVisible({ timeout: 5000 }).catch(() => false))) {
            return '';
        }

        const shape = await picker
            .evaluate((element) => ({
                tag: element.tagName.toLowerCase(),
                type: ((element as HTMLInputElement).type ?? '').toLowerCase(),
                readOnly: !!(element as HTMLInputElement).readOnly,
                format:
                    element.getAttribute('data-date-format') ||
                    element.getAttribute('placeholder') ||
                    '',
            }))
            .catch(() => ({ tag: 'input', type: 'text', readOnly: false, format: '' }));

        if (shape.tag === 'select') {
            // A month/year dropdown: the option is named, not formatted, so it is matched
            // on the month and the year appearing in its text.
            const option = this.page
                .locator('#monthYearPicker option')
                .filter({ hasText: new RegExp(`${target.monthShort}.*${target.year}`, 'i') })
                .first();

            if (await option.count()) {
                await picker.selectOption({ value: (await option.getAttribute('value')) ?? '' });
                return (await picker.inputValue().catch(() => '')) || target.label;
            }
        }

        if (shape.type === 'date' || shape.type === 'month') {
            const value = shape.type === 'date' ? target.iso : target.monthOnly;
            await picker.fill(value).catch(() => undefined);
            const written = await picker.inputValue().catch(() => '');
            if (written) {
                return written;
            }
        }

        // A text box nothing owns: the declared format first, then the usual shapes, each
        // read back because a widget that rejected the text leaves the box as it was.
        if (!shape.readOnly && shape.tag === 'input' && shape.type !== 'date') {
            const candidates = /m{2}.*d{2}.*y{4}/i.test(shape.format)
                ? [target.mmddyyyySlashed, target.ddmmyyyy, target.iso]
                : /y{4}.*m{2}.*d{2}/i.test(shape.format)
                  ? [target.iso, target.ddmmyyyy]
                  : [target.ddmmyyyy, target.ddmmyyyySlashed, target.iso, target.mmddyyyySlashed];

            for (const candidate of candidates) {
                await picker.fill('').catch(() => undefined);
                await picker.fill(candidate).catch(() => undefined);

                const written = (await picker.inputValue().catch(() => '')).trim();

                if (written && written !== '') {
                    await this.page.keyboard.press('Escape').catch(() => undefined);
                    return written;
                }
            }
        }

        // Whatever is left is a calendar, and a calendar is clicked.
        return this.pickFromCalendar(target);
    }

    /**
     * The calendar overlay a period picker opens, whichever library drew it.
     *
     * These widgets all work the same way and disagree only about class names: a header
     * saying which month is on screen, an arrow either side of it, and a grid of cells.
     * So the panel is found by any of the names the common ones use, and everything after
     * that is done by what the panel says rather than by how it was built.
     */
    private calendarPanel(): Locator {
        return this.page
            .locator(
                [
                    '.datepicker:visible',
                    '.datepicker-dropdown:visible',
                    '.ui-datepicker:visible',
                    '.flatpickr-calendar.open',
                    '.daterangepicker:visible',
                    '.bootstrap-datetimepicker-widget:visible',
                    '.xdsoft_datetimepicker:visible',
                    '.air-datepicker:visible',
                    '[class*="calendar"]:visible',
                    '[class*="datepicker"]:visible',
                ].join(', ')
            )
            .first();
    }

    /**
     * Walks the open calendar to the target month and clicks the day.
     *
     * The header is read each time rather than counted on: "click prev twice" is right
     * only from the month the calendar happened to open on, and these open on today, on
     * the last value chosen, or on the first of a range depending on the widget. So the
     * run reads where it is, decides which way to go, and stops when the header says the
     * month it wants - bounded, because a calendar whose arrow does nothing would
     * otherwise be clicked forever.
     *
     * A picker that only offers months and years - which is what an id like
     * #monthYearPicker suggests - has no day cells at all. That is not a failure: the
     * month is the period the list wants, and the month cell is clicked instead.
     */
    private async pickFromCalendar(target: DateForms): Promise<string> {
        const picker = this.periodPicker();

        await picker.click({ timeout: 10000 }).catch(() => undefined);

        const panel = this.calendarPanel();

        if (!(await panel.isVisible({ timeout: 5000 }).catch(() => false))) {
            console.log(
                'The period picker opened no calendar this run could recognise, so the list ' +
                    'is being fetched on whatever period the page came up with.'
            );
            return '';
        }

        const header = panel
            .locator(
                '.datepicker-switch, .ui-datepicker-title, .flatpickr-current-month, ' +
                    'th.switch, .picker-switch, [class*="header"], [class*="title"]'
            )
            .first();
        const previous = panel
            .locator('.prev, .ui-datepicker-prev, .flatpickr-prev-month, [class*="prev"]')
            .first();
        const next = panel
            .locator('.next, .ui-datepicker-next, .flatpickr-next-month, [class*="next"]')
            .first();

        const wantedMonth = new RegExp(`${target.monthLong}|${target.monthShort}`, 'i');
        const targetMonthIndex = target.date.getFullYear() * 12 + target.date.getMonth();

        for (let step = 0; step < 24; step += 1) {
            const heading = ((await header.innerText().catch(() => '')) || '').replace(/\s+/g, ' ');

            if (wantedMonth.test(heading) && heading.includes(target.year)) {
                break;
            }

            // Which way to walk, from what the header says. A header this run cannot parse
            // is walked backwards, because the day being looked for is in the past.
            const shownYear = Number(/\b(20\d{2})\b/.exec(heading)?.[1] ?? target.year);
            const shownMonth = new Date(`${/[A-Za-z]{3,}/.exec(heading)?.[0] ?? 'Jan'} 1, 2000`);
            const shownIndex = Number.isNaN(shownMonth.getTime())
                ? targetMonthIndex + 1
                : shownYear * 12 + shownMonth.getMonth();

            const arrow = shownIndex > targetMonthIndex ? previous : next;

            if (!(await arrow.isVisible({ timeout: 2000 }).catch(() => false))) {
                break;
            }

            await arrow.click({ timeout: 5000 }).catch(() => undefined);
        }

        // Day cells, with the greyed-out neighbours of the month either side left out -
        // clicking one of those jumps the calendar to a different month and picks a date
        // nobody asked for.
        const dayCell = panel
            .locator(
                'td.day:not(.old):not(.new):not(.disabled), ' +
                    '.flatpickr-day:not(.prevMonthDay):not(.nextMonthDay):not(.flatpickr-disabled), ' +
                    'a.ui-state-default, td[data-day], .datepicker-days td:not(.old):not(.new)'
            )
            .filter({ hasText: new RegExp(`^\\s*${target.day}\\s*$`) })
            .first();

        if (await dayCell.isVisible({ timeout: 3000 }).catch(() => false)) {
            await dayCell.click({ timeout: 5000 }).catch(() => undefined);
        } else {
            // No day grid: a month/year picker, so the month itself is the period.
            const monthCell = panel
                .locator('span.month, .datepicker-months span, td span[class*="month"]')
                .filter({ hasText: new RegExp(`^\\s*${target.monthShort}`, 'i') })
                .first();

            if (await monthCell.isVisible({ timeout: 3000 }).catch(() => false)) {
                await monthCell.click({ timeout: 5000 }).catch(() => undefined);
            }
        }

        // Some of these need the choice confirming, and all of them sit over the Fetch
        // button until they are shut.
        const apply = panel.getByRole('button', { name: /apply|ok|done/i }).first();
        if (await apply.isVisible({ timeout: 1500 }).catch(() => false)) {
            await apply.click().catch(() => undefined);
        }

        if (await panel.isVisible({ timeout: 1000 }).catch(() => false)) {
            await this.page.keyboard.press('Escape').catch(() => undefined);
            await this.page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => undefined);
        }

        return (await picker.inputValue().catch(() => '')) || (await picker.innerText().catch(() => ''));
    }

    /**
     * Presses Fetch and waits for the grid to come back. Given a range, the period picker
     * is set to it first — see selectDateRange().
     */
    async fetchPendingBills(
        options: { range?: BillingRange; date?: DateForms; dialogMessages?: string[] } = {}
    ): Promise<number> {
        const range = options.range ?? (options.date ? { from: options.date, to: options.date } : undefined);
        const dialogMessages = options.dialogMessages ?? [];
        const alertsBefore = dialogMessages.length;

        if (range) {
            const shown = await this.selectDateRange(range.from, range.to);
            console.log(
                `View Pending Bills asked for ${range.from.label} to ${range.to.label}` +
                    `${shown ? ` (the picker reads "${shown}")` : ' (the picker took no value)'}`
            );
        }

        await this.fetchButton().click().catch(() => undefined);

        // DataTables redraws in place, so there is no navigation to wait for - the table
        // itself is the outcome. An empty period renders the grid with its "no data" row
        // rather than not rendering it, so this waits for the wrapper either way.
        await this.page
            .locator('#medicineRegisterTable_wrapper')
            .or(this.billTable())
            .first()
            .waitFor({ state: 'visible', timeout: 30000 })
            .catch(() => undefined);

        // Some centres answer an empty period in a dialog rather than by drawing an empty
        // grid. Either way the period holds nothing to bill, so it reads as zero pending
        // rather than as something having gone wrong.
        const said = dialogMessages
            .slice(alertsBefore)
            .find((message) => NOTHING_TO_BILL.test(message));

        if (said) {
            console.log(`Fetch answered "${said}", so this period has nothing to bill.`);
            return 0;
        }

        return this.pendingCount();
    }

    /**
     * The rows that are actually bills. DataTables fills an empty grid with a single
     * "No data available in table" row, which carries no Create Bill button and must not
     * be counted as work to do.
     */
    private pendingRows(): Locator {
        return this.billTable()
            .locator('tbody tr')
            .filter({
                has: this.page.locator('button, input[type="button"], input[type="submit"], a'),
            });
    }

    async pendingCount(): Promise<number> {
        if (!(await this.billTable().isVisible({ timeout: 10000 }).catch(() => false))) {
            return 0;
        }

        return this.pendingRows().count();
    }

    /**
     * What the first row of the list says, read before anything is clicked.
     *
     * Worth taking on the way in rather than afterwards: the bill opens in a window of its
     * own, and that window names neither the patient nor the prescription anywhere a run
     * can read them - its heading is "Enter Batch No. and Expiry Date for Prescribed
     * Medicines" and nothing else. The list row is where the ids are, so this is the only
     * chance to have them.
     *
     * The columns are read by what is in them rather than by position: History ID and
     * Patient ID are both long numbers, in that order, and a centre whose grid carries an
     * extra column would shift any index this relied on.
     */
    async readFirstPendingRow(): Promise<PendingBillRow> {
        const row = this.pendingRows().first();

        await expect(row, 'View Pending Bills lists no pending bill to create').toBeVisible({
            timeout: 15000,
        });

        const cells = await row.getByRole('cell').allInnerTexts();
        const values = cells.map((cell) => cell.replace(/\s+/g, ' ').trim());
        const numbers = values.filter((value) => /^\d{5,}$/.test(value));

        // The Date column reads "14 Sep 2026", which is letters and digits and therefore
        // looks exactly like a name to anything scanning for one. It is identified first
        // so the name can be everything that is not it - along with the Type column
        // ("Prescription") and the action ("Create Bill"), which are the grid's own words
        // rather than this patient's.
        const date = values.find((value) => /^\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}$/.test(value)) ?? '';

        return {
            historyId: numbers[0] ?? '',
            patientId: numbers[1] ?? '',
            date,
            patientName:
                values.find(
                    (value) =>
                        value !== date &&
                        /[A-Za-z]{3,}/.test(value) &&
                        !/^\d+$/.test(value) &&
                        !/^(prescription|create bill|view|bill)$/i.test(value)
                ) ?? '',
            summary: values.join(' | '),
        };
    }

    /**
     * Presses Create Bill on the first row and hands back the window it opens.
     *
     * That button opens the bill in a window of its own, which is the thing worth being
     * careful about: `page` goes on pointing at the list, so a run that carried on
     * addressing it would be typing a batch number into a page that has no batch number
     * field on it, and would report that the field never appeared. The new window is taken
     * off the browser context as it opens, and everything about the bill happens there.
     *
     * A centre whose app navigates in place instead is handled too - the list's own page
     * is then the bill's page, and the only difference afterwards is that it must not be
     * closed.
     *
     * The third answer is neither: a row that is listed but that the app will not bill,
     * which it says in an alert — "no patients" — and then does nothing. Given the
     * messages, that is recognised and handed back as nothingToBill instead of waiting out
     * a navigation that is never coming. See NOTHING_TO_BILL.
     */
    async openFirstPendingBill(dialogMessages: string[] = []): Promise<BillWindow> {
        const listing = await this.readFirstPendingRow();
        const alertsBefore = dialogMessages.length;
        const row = this.pendingRows().first();

        const createBill = row
            .getByRole('button', { name: /create bill/i })
            .or(row.getByRole('link', { name: /create bill/i }))
            .or(row.getByRole('button'))
            .or(row.getByRole('link'))
            .first();

        await expect(
            createBill,
            `The pending row for ${listing.historyId || 'this bill'} offers no Create Bill control`
        ).toBeVisible({ timeout: 15000 });

        // Armed before the click: a window that opens faster than the click returns would
        // otherwise be missed altogether.
        const opening = this.page
            .context()
            .waitForEvent('page', { timeout: 20000 })
            .catch(() => null);

        await createBill.click();

        const popup = await opening;

        if (popup) {
            await popup.waitForLoadState('load').catch(() => undefined);
            await popup.bringToFront().catch(() => undefined);

            console.log(
                `Create Bill opened a new window for history ${listing.historyId} ` +
                    `(patient ${listing.patientId}${listing.patientName ? `, ${listing.patientName}` : ''})`
            );

            return {
                page: popup,
                isPopup: true,
                listing,
                prescriptionId: /[?&]id=(\d+)/i.exec(popup.url())?.[1] || listing.historyId,
            };
        }

        // No window. Either the app went somewhere in this tab, or it refused - and a
        // refusal is read off the alerts before anything is waited for, because the wait
        // would only time out.
        const said = dialogMessages
            .slice(alertsBefore)
            .find((message) => NOTHING_TO_BILL.test(message));

        if (said) {
            console.log(
                `Create Bill for history ${listing.historyId || '(unnamed row)'} answered ` +
                    `"${said}", so there is nothing to bill on that row.`
            );

            return { page: this.page, isPopup: false, listing, prescriptionId: listing.historyId, nothingToBill: said };
        }

        await this.page.waitForURL(/PrescriptionView|Bill/i, { timeout: 20000 }).catch(() => undefined);
        await this.page.waitForLoadState('load').catch(() => undefined);

        return {
            page: this.page,
            isPopup: false,
            listing,
            prescriptionId: /[?&]id=(\d+)/i.exec(this.page.url())?.[1] || listing.historyId,
        };
    }

    /**
     * Every medicine line's batch number box on the bill.
     *
     * The recorded selector is `#medicines\[0\][batch_no\]` — the first line and only the
     * first, and an id with brackets in it that has to be escaped before CSS will parse it
     * at all. A prescription with three medicines has three of these and the bill is
     * refused while any one of them is blank, so they are matched as a set on the
     * attribute, with the table's own Batch Number column as the fallback for a centre
     * whose fields are named differently.
     */
    private batchFields(billPage: Page): Locator {
        return billPage
            .locator('input[name*="batch_no"], input[id*="batch_no"], input[name*="batch" i]')
            .or(billPage.locator('table tbody tr td:nth-child(3) input[type="text"]'));
    }

    /**
     * Date of Expiry, per medicine line. On this screen it is a dropdown - the app offers
     * the expiries it actually holds stock against rather than a box to type one into - so
     * the select is matched first and an input second, and whichever the centre renders,
     * the set comes back in row order.
     */
    private expiryFields(billPage: Page): Locator {
        return billPage
            .locator('select[name*="doe"], select[id*="doe"], select[name*="expiry" i]')
            .or(billPage.locator('input[name*="doe"], input[id*="doe"], input[name*="expiry" i]'))
            .or(
                billPage.locator(
                    'table tbody tr td:nth-child(4) select, table tbody tr td:nth-child(4) input'
                )
            );
    }

    /**
     * Writes a fresh batch number and an expiry onto every medicine line of the open bill.
     *
     * Both are drawn at random, in the two different senses the two fields call for: the
     * batch is free text, so one is generated, while the expiry is a dropdown of what the
     * app itself offers, so one of those is chosen. Making up an expiry a dropdown does
     * not contain would fail for a reason that has nothing to do with the software.
     */
    async fillBatchesAndExpiries(billPage: Page): Promise<BilledMedicine[]> {
        const batches = this.batchFields(billPage);
        const expiries = this.expiryFields(billPage);

        await batches
            .first()
            .waitFor({ state: 'visible', timeout: 20000 })
            .catch(() => undefined);

        const lines = await batches.count();

        expect(
            lines,
            'The bill window has no medicine batch field on it, so there is nothing to ' +
                'record — the bill may already have been created, or this prescription has ' +
                'no medicine on it'
        ).toBeGreaterThan(0);

        const expiryCount = await expiries.count();
        const filled: BilledMedicine[] = [];

        for (let line = 0; line < lines; line += 1) {
            const batchField = batches.nth(line);

            if (!(await batchField.isVisible({ timeout: 5000 }).catch(() => false))) {
                continue;
            }

            const medicine = await this.medicineNameFor(batchField);
            const batchNumber = randomBatchNumber();
            await batchField.fill(batchNumber);

            const expiry = line < expiryCount ? await this.chooseExpiry(expiries.nth(line)) : '';

            filled.push({ line, medicine, batchNumber, expiry });
        }

        return filled;
    }

    /** The medicine this row is about, for the log line and the report. */
    private async medicineNameFor(batchField: Locator): Promise<string> {
        const name = await batchField
            .locator('xpath=ancestor::tr[1]')
            .getByRole('cell')
            .nth(1)
            .innerText()
            .catch(() => '');

        return name.replace(/\s+/g, ' ').trim();
    }

    /**
     * Picks an expiry for one medicine line.
     *
     * A dropdown is what this screen renders, and what it holds is the app's own list of
     * the batches in stock - so a value is chosen out of it at random rather than
     * invented. Every run bills a different batch that way, and a catalogue that differs
     * between UAT and production changes nothing about the test. The placeholder is
     * skipped: "Select" is not an expiry, and leaving it there is what makes the submit
     * fail.
     *
     * A text box or a native date input is handled too, for a centre that renders one.
     * There the date has to be made up, so a random future one is, in whatever format the
     * field asks for.
     */
    private async chooseExpiry(field: Locator): Promise<string> {
        const isSelect = await field
            .evaluate((element) => element.tagName.toLowerCase() === 'select')
            .catch(() => false);

        if (!isSelect) {
            return this.setExpiry(field, randomExpiryDate());
        }

        const options = await field.locator('option').all();
        const choices: { value: string; label: string }[] = [];

        for (const option of options) {
            const value = (await option.getAttribute('value')) ?? '';
            const label = ((await option.innerText()) ?? '').replace(/\s+/g, ' ').trim();

            // "Select", "--Select--", a blank value: the placeholder in its various
            // spellings. Anything else is a real expiry the centre holds stock against.
            if (!value.trim() || !label || /^-*\s*select/i.test(label)) {
                continue;
            }

            choices.push({ value, label });
        }

        expect(
            choices.length,
            'The Date of Expiry dropdown offers nothing but its placeholder, so this ' +
                'medicine has no batch in stock to bill against'
        ).toBeGreaterThan(0);

        const chosen = pickRandom(choices);
        await field.selectOption({ value: chosen.value });

        // Read back rather than trusting the click: a dropdown the page rebuilds under the
        // selection leaves the placeholder in place, and reporting the label this run
        // *meant* to pick would hide that until the submit failed a step later.
        const held = await field.inputValue().catch(() => '');

        expect(
            held,
            `The Date of Expiry dropdown did not keep ${chosen.label} — it still holds ` +
                `"${held || '(nothing)'}"`
        ).toBe(chosen.value);

        return chosen.label;
    }

    /**
     * Puts a made-up date into an expiry field that is a box rather than a dropdown, and
     * confirms it took. Only reached on a centre that renders one — this screen's Date of
     * Expiry is a select, and chooseExpiry() picks from it instead.
     *
     * Returns what the field actually holds afterwards, which is the only thing worth
     * reporting: a datepicker that rejected the typed text leaves the box empty without a
     * word, and the submit then fails a step later for a reason nothing would have named.
     */
    private async setExpiry(field: Locator, expiry: ExpiryDate): Promise<string> {
        const type = ((await field.getAttribute('type')) ?? '').toLowerCase();

        if (type === 'date') {
            await field.fill(expiry.iso);
            return (await field.inputValue().catch(() => '')) || expiry.iso;
        }

        if (type === 'month') {
            await field.fill(expiry.monthOnly);
            return (await field.inputValue().catch(() => '')) || expiry.monthOnly;
        }

        const declared =
            (await field.getAttribute('data-date-format')) ||
            (await field.getAttribute('placeholder')) ||
            '';

        const preferred = /y{4}.*m{2}.*d{2}/i.test(declared)
            ? [expiry.iso]
            : /m{2}.*d{2}.*y{4}/i.test(declared)
              ? [expiry.mmddyyyySlashed]
              : /d{2}.*m{2}.*y{4}/i.test(declared)
                ? [expiry.ddmmyyyy, expiry.ddmmyyyySlashed]
                : [];

        const candidates = [
            ...preferred,
            expiry.iso,
            expiry.ddmmyyyy,
            expiry.ddmmyyyySlashed,
            expiry.mmddyyyySlashed,
        ];

        for (const candidate of candidates) {
            await field.fill('').catch(() => undefined);
            await field.fill(candidate).catch(() => undefined);

            // A datepicker opens over the page on focus and would otherwise cover the next
            // field and the Submit button.
            await field.page().keyboard.press('Escape').catch(() => undefined);
            await field.blur().catch(() => undefined);

            const written = (await field.inputValue().catch(() => '')).trim();

            if (written) {
                return written;
            }
        }

        // Typing is the last resort: some datepickers listen for keystrokes and ignore a
        // value set any other way.
        await field.click().catch(() => undefined);
        await field.pressSequentially(expiry.ddmmyyyy, { delay: 40 }).catch(() => undefined);
        await field.page().keyboard.press('Escape').catch(() => undefined);

        return (await field.inputValue().catch(() => '')).trim();
    }

    private submitButton(billPage: Page): Locator {
        return billPage
            .getByRole('button', { name: /^\s*Submit\s*$/i })
            .or(billPage.locator('input[type="submit"]'))
            .first();
    }

    /**
     * Submits the bill and waits for the app to have done something with it.
     *
     * The window either closes itself, navigates, or answers in a dialog, and all three
     * count as the submit having been taken. What does not count is the run pressing the
     * button again because nothing visibly happened, which is how a recorded session ends
     * up with eight clicks in a row. Anything the app objected to comes back as the
     * message it raised.
     */
    async submit(billPage: Page, dialogMessages: string[] = []): Promise<string> {
        const before = billPage.url();
        const alertsBefore = dialogMessages.length;

        await expect(this.submitButton(billPage), 'The bill has no Submit button').toBeVisible({
            timeout: 15000,
        });
        await this.submitButton(billPage).click({ timeout: 20000 }).catch(() => undefined);

        await Promise.race([
            billPage.waitForEvent('close', { timeout: 20000 }).catch(() => undefined),
            billPage
                .waitForURL((url) => url.href !== before, { timeout: 20000 })
                .catch(() => undefined),
        ]);

        if (!billPage.isClosed()) {
            await billPage.waitForLoadState('load').catch(() => undefined);
        }

        return dialogMessages
            .slice(alertsBefore)
            .map((message) => message.trim())
            .join(' | ');
    }

    /**
     * Shuts the bill window and puts the run back on the pending list, which is where the
     * next Create Bill is. A window left open is not harmless: they stack up one per bill,
     * and the list sits behind them for the rest of the run.
     */
    async returnToList(bill: BillWindow): Promise<void> {
        if (bill.isPopup && !bill.page.isClosed()) {
            await bill.page.close().catch(() => undefined);
        }

        await this.page.bringToFront().catch(() => undefined);
    }

    /**
     * One whole bill, from the row on the list to the window being closed again: press
     * Create Bill, fill in every medicine's batch and expiry in the window that opens,
     * submit, and come back to the list ready for the next one.
     */
    async createBillForFirstPending(dialogMessages: string[] = []): Promise<CreatedBill> {
        const bill = await this.openFirstPendingBill(dialogMessages);

        const asListed = {
            prescriptionId: bill.prescriptionId,
            patientId: bill.listing.patientId,
            patientName: bill.listing.patientName,
            billedFor: bill.listing.date,
        };

        // The row was listed but the app will not bill it and said so. Nothing was filled
        // in and nothing was submitted, and that is reported as such rather than as a
        // refusal - there is no bill to create here.
        if (bill.nothingToBill) {
            await this.returnToList(bill);

            return { ...asListed, medicines: [], complaint: '', nothingToBill: bill.nothingToBill };
        }

        // The window has dialogs of its own, and the listing page's handler does not hear
        // them - they belong to a different page object's page.
        if (bill.isPopup) {
            this.captureDialogs(bill.page, dialogMessages);
        }

        try {
            const medicines = await this.fillBatchesAndExpiries(bill.page);
            const complaint = await this.submit(bill.page, dialogMessages);

            // A submit answered with "no patients" is the same answer arriving a step
            // later - the row is not billable, rather than the bill having been rejected
            // over something this run got wrong.
            const nothingToBill = NOTHING_TO_BILL.test(complaint) ? complaint : '';

            return {
                ...asListed,
                medicines,
                complaint: nothingToBill ? '' : complaint,
                nothingToBill,
            };
        } finally {
            await this.returnToList(bill);
        }
    }

    /**
     * Creates every bill the centre still has pending, and reports what it wrote.
     *
     * This is the routine a blocked consultation run calls. It works the list from the top
     * each time rather than by index - creating a bill takes that row out of the list, so
     * the next one to do is the first one again - and stops the moment the list is empty.
     * Two guards keep a list that will not go down from spinning: a cap on how many bills
     * one call will create, and a check that the prescription it just billed is not the
     * one it is handed again, which is what a submit the app quietly refused looks like
     * from out here.
     */
    async clearPendingBills(
        options: { maxBills?: number; lookbackDays?: number } = {}
    ): Promise<CreatedBill[]> {
        const maxBills = options.maxBills ?? Number(process.env.E2E_MAX_BILLS ?? 25);
        const lookbackDays =
            options.lookbackDays ?? Number(process.env.E2E_BILL_LOOKBACK_DAYS ?? 7);

        const dialogMessages = this.captureDialogs();
        const created: CreatedBill[] = [];

        // The previous day through to today first — that is the period the app's refusal
        // names, and it is one fetch rather than two. Only if that turns up nothing is the
        // net widened: a centre closed yesterday is blocked by the last day it worked,
        // which a weekend or a holiday puts further back.
        const periods: BillingRange[] = [previousDayToToday(), lastDaysToToday(lookbackDays)];

        // Set once the app itself has said there is nobody to bill. Widening the period
        // after that answer would only ask the same screen the same question.
        let appSaysNobody = '';

        for (const period of periods) {
            let previousPrescriptionId = '';

            for (;;) {
                if (created.length >= maxBills) {
                    throw new Error(
                        `Stopped after creating ${maxBills} bills and the centre still has more ` +
                            'pending. Raise E2E_MAX_BILLS if that is genuinely the size of the ' +
                            'backlog.'
                    );
                }

                await this.open();
                const pending = await this.fetchPendingBills({ range: period, dialogMessages });

                if (pending === 0) {
                    break;
                }

                console.log(
                    `${period.from.label} to ${period.to.label}: ${pending} pending bill(s) — ` +
                        'creating the first of them'
                );

                const bill = await this.createBillForFirstPending(dialogMessages);

                // The list had a row on it, but the app answered Create Bill with "no
                // patients". There is nothing here to clear, and pressing the same button
                // on the same row again would get the same answer, so the run leaves the
                // screen and carries on with what it came to do.
                if (bill.nothingToBill) {
                    appSaysNobody = bill.nothingToBill;
                    break;
                }

                if (bill.complaint) {
                    throw new Error(
                        `The bill for prescription ${bill.prescriptionId} was refused: ` +
                            bill.complaint
                    );
                }

                // The same prescription coming back after being billed means the submit did
                // not take, and billing it again forever would not help.
                if (bill.prescriptionId && bill.prescriptionId === previousPrescriptionId) {
                    throw new Error(
                        `Prescription ${bill.prescriptionId} is still pending after being ` +
                            'billed, so creating bills is not clearing the list. The app said: ' +
                            `${dialogMessages.slice(-3).join(' | ') || '(nothing)'}`
                    );
                }
                previousPrescriptionId = bill.prescriptionId;

                created.push(bill);
                console.log(
                    `Billed prescription ${bill.prescriptionId} for ` +
                        `${bill.patientName || 'the patient'}` +
                        `${bill.billedFor ? ` (${bill.billedFor})` : ''}: ` +
                        bill.medicines
                            .map(
                                (line) =>
                                    `${line.medicine || `line ${line.line + 1}`} ` +
                                    `${line.batchNumber} exp ${line.expiry || '(not set)'}`
                            )
                            .join(', ')
                );
            }

            // The wider window is a fallback, not a second sweep: a period that produced
            // bills was the right one, and the days before it are somebody else's backlog.
            if (created.length > 0 || appSaysNobody) {
                break;
            }
        }

        if (appSaysNobody && created.length === 0) {
            console.log(
                `View Pending Bills listed something, but Create Bill answered ` +
                    `"${appSaysNobody}" — there is no bill to create here, so the run carries ` +
                    'on to the next step.'
            );
            return created;
        }

        console.log(
            created.length === 0
                ? 'Nothing was pending from the previous day through to today, nor in the ' +
                      `${lookbackDays} day(s) before it, so there was no backlog to clear. If ` +
                      'the app is still refusing, what it is waiting on is not a bill this ' +
                      'screen lists — a reconciliation, or a day further back (raise ' +
                      'E2E_BILL_LOOKBACK_DAYS).'
                : `${created.length} bill(s) created; nothing is pending in the last ` +
                      `${lookbackDays} day(s)`
        );

        return created;
    }
}
