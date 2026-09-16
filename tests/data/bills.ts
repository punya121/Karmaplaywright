/**
 * What a run writes onto a pending bill, and the dates it goes looking for one on.
 *
 * The batch number and the expiry are drawn fresh every time. Both are free text the
 * pharmacy reads off the strip in front of them, so there is no "correct" value for
 * either - which means a spec that types the same 'abcd' every run proves only that the
 * field accepts 'abcd'. Random values cover the field's actual shape instead, and two
 * runs against one centre never collide on a batch.
 */

function randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * A plausible batch number: two letters, four digits, e.g. "KJ4821". Shaped like the
 * ones printed on a strip rather than random noise, so a human reading the bill
 * afterwards sees something that belongs there.
 */
export function randomBatchNumber(): string {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O - they read as 1 and 0
    const first = letters[randomInt(0, letters.length - 1)];
    const second = letters[randomInt(0, letters.length - 1)];

    return `${first}${second}${randomInt(1000, 9999)}`;
}

/**
 * One date in every shape a field or a calendar might want it in.
 *
 * A date field takes one format and silently ignores every other, and a calendar widget
 * does not take text at all - it wants a cell clicked, found by the day number and by
 * the month and year written across its header. So a run carries all of them rather than
 * guessing which the app is using, and picks the one the control in front of it asks for.
 */
export type DateForms = {
    /** 2027-03-14 — what <input type="date"> wants. */
    iso: string;
    /** 14-03-2027 */
    ddmmyyyy: string;
    /** 14/03/2027 */
    ddmmyyyySlashed: string;
    /** 03/14/2027 */
    mmddyyyySlashed: string;
    /** 2027-03 — for a field that only takes a month. */
    monthOnly: string;
    /** "14" — the cell a calendar wants clicked. */
    day: string;
    /** "March" and "Mar" — what a calendar writes across its header. */
    monthLong: string;
    monthShort: string;
    /** "2027" */
    year: string;
    /** How the run says it in a log line and in the report. */
    label: string;
    date: Date;
};

export function dateForms(date: Date): DateForms {
    const pad = (value: number) => String(value).padStart(2, '0');
    const year = date.getFullYear();
    const month = pad(date.getMonth() + 1);
    const day = pad(date.getDate());

    return {
        iso: `${year}-${month}-${day}`,
        ddmmyyyy: `${day}-${month}-${year}`,
        ddmmyyyySlashed: `${day}/${month}/${year}`,
        mmddyyyySlashed: `${month}/${day}/${year}`,
        monthOnly: `${year}-${month}`,
        day: String(date.getDate()),
        monthLong: date.toLocaleString('en-US', { month: 'long' }),
        monthShort: date.toLocaleString('en-US', { month: 'short' }),
        year: String(year),
        label: `${day}-${month}-${year}`,
        date,
    };
}

export type ExpiryDate = DateForms;

/**
 * An expiry date, always in the future - six months to three years out, on a day between
 * the 1st and the 28th so no month is short of it. A date in the past would be the
 * pharmacy dispensing expired stock, which the app is entitled to refuse, and a run that
 * hit that refusal would be reporting its own test data rather than the software.
 */
export function randomExpiryDate(): ExpiryDate {
    const today = new Date();
    const expiry = new Date(today.getFullYear(), today.getMonth(), 1);

    expiry.setMonth(expiry.getMonth() + randomInt(6, 36));
    expiry.setDate(randomInt(1, 28));

    return dateForms(expiry);
}

/** Midnight, so a date is a date rather than a moment in one. */
function dayOffsetFromToday(days: number): Date {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - days);
    return date;
}

/** Today, as a date. */
export function today(): DateForms {
    return dateForms(dayOffsetFromToday(0));
}

/** Yesterday — the day the app's refusal is about. */
export function previousDay(): DateForms {
    return dateForms(dayOffsetFromToday(1));
}

export function daysAgo(days: number): DateForms {
    return dateForms(dayOffsetFromToday(days));
}

/**
 * The period a run asks the pending list for, as a range.
 *
 * "Select Month & Year" is a date *range* picker — the box reads "15 Sep 2026 - 15 Sep
 * 2026", two dates, not one — so the period is a from and a to. The app's refusal names
 * the previous day, and the range runs from there to today rather than sitting on the
 * one day: a bill raised earlier today is as capable of blocking the centre as
 * yesterday's, and one fetch over both days finds either.
 */
export type BillingRange = { from: DateForms; to: DateForms };

export function previousDayToToday(): BillingRange {
    return { from: previousDay(), to: today() };
}

/**
 * A wider net for a centre that was closed yesterday. A weekend or a holiday leaves the
 * block sitting on the last day the centre actually worked, which is not the day before,
 * and nothing is listed against the days in between.
 */
export function lastDaysToToday(lookbackDays = 7): BillingRange {
    return { from: daysAgo(lookbackDays), to: today() };
}
