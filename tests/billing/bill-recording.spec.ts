import { expect, test } from '@playwright/test';
import { validPassword, validUsername } from '../config/test-env';
import { previousDay, previousDayToToday, today } from '../data/bills';
import { LoginPage } from '../pages/login.page';
import { PendingBillPage } from '../pages/pending-bill.page';

/**
 * Bill > View Pending Bills, end to end: find the prescriptions the pharmacy has not
 * billed yet, open one, record the batch and expiry of every medicine on it, and submit.
 *
 * The batch number and the expiry are drawn fresh every run (tests/data/bills.ts). They
 * are free text read off a strip, so there is no correct value for either, and a spec
 * that typed 'abcd' and 2027-03-01 every time proved only that the field accepts 'abcd'.
 * Random values cover the field's shape instead, and two runs against one centre never
 * write the same batch twice.
 *
 * Why this matters beyond billing: a centre with the previous day's bills still open is
 * blocked from starting a case history at all —
 *
 *   "Please complete all pending reconciliations and create bills for the previous day.
 *    If already done, kindly refresh the page"
 *
 * — so tests/live/full-consultation-with-doctor.spec.ts calls the same page object to
 * clear the backlog and carry on, rather than stopping until somebody tidies the centre
 * up by hand. The page object is tests/pages/pending-bill.page.ts; this spec is the one
 * that checks the screen itself works.
 *
 * Every test signs in first. The draft these came from opened /Home directly, which only
 * works while a session from some earlier run happens to still be alive - against a cold
 * browser it lands on /Login and the title assertion fails for a reason that has nothing
 * to do with billing.
 */
test.describe('Bill Recording', () => {
    let billPage: PendingBillPage;

    test.beforeEach(async ({ page }) => {
        billPage = new PendingBillPage(page);

        await new LoginPage(page).loginExpectingHome(validUsername, validPassword);
        await expect(page).toHaveTitle(/Karma Healthcare/i);
    });

    test.afterEach(async ({ page }) => {
        // The account allows only a handful of concurrent sessions, so a run that just
        // closes the browser burns a slot until the server expires it.
        await new LoginPage(page).logout().catch(() => undefined);
    });

    test('TC01 - Navigate to View Pending Bills', async ({ page }) => {
        await billPage.open();

        await expect(page).toHaveURL(/\/PendingBill/i);
        await expect(page).toHaveTitle(/View Pending Bills/i);
    });

    test('TC02 - Search pending bills for the previous day', async ({ page }) => {
        await billPage.open();

        // The previous day, not the period the screen comes up on. That is the day the
        // app's own refusal names — "create bills for the previous day" — and a search on
        // today's date comes back empty and reads as a centre with nothing outstanding.
        const yesterday = previousDay();
        const shown = await billPage.selectDateRange(yesterday, today());

        test.info().annotations.push({
            type: 'period',
            description:
                `asked for ${yesterday.label} to ${today().label}; ` +
                `the picker reads "${shown || '(nothing)'}"`,
        });

        // The picker holds a range, so both ends have to be in it — a box still reading
        // "15 Sep 2026 - 15 Sep 2026" means the previous day was never selected and the
        // grid below is answering a different question than the one this test asked.
        expect(shown, 'The period picker did not take the previous day').toContain(yesterday.day);

        const pending = await billPage.fetchPendingBills();

        await expect(
            page.locator('#medicineRegisterTable_wrapper').or(page.locator('#medicineRegisterTable')).first()
        ).toBeVisible();

        // An empty list is a valid state - it means the centre is up to date - so it is
        // reported rather than failed.
        test.info().annotations.push({
            type: 'pending bills',
            description: pending === 0 ? 'none pending' : `${pending} pending`,
        });
        console.log(`View Pending Bills lists ${pending} pending bill(s)`);
    });

    test('TC03 - Open pending prescription and create bill', async ({ page }) => {
        test.setTimeout(180000);

        // Kept so a Create Bill the app refuses ("no patients") is read as that rather than
        // as the bill window failing to open.
        const dialogMessages = billPage.captureDialogs();

        await billPage.open();
        // The previous day is where the backlog the app complains about lives.
        const pending = await billPage.fetchPendingBills({ range: previousDayToToday() });

        test.skip(
            pending === 0,
            'The centre has no pending bill to open, so there is nothing for this test to ' +
                'act on. Run a consultation first (npm run test:full-consultation), or pick a ' +
                'centre with a backlog.'
        );

        const bill = await billPage.openFirstPendingBill(dialogMessages);

        test.skip(
            Boolean(bill.nothingToBill),
            `The app answered Create Bill with "${bill.nothingToBill}", so no bill window ` +
                'was opened'
        );

        // Create Bill opens a window of its own, so the assertions are about that window
        // and not about `page`, which is still sitting on the list behind it.
        await expect(
            bill.page.getByText(/Enter Batch No\. and Expiry Date/i),
            'The bill window did not open on the batch and expiry screen'
        ).toBeVisible({ timeout: 20000 });

        expect(bill.listing.historyId, 'The pending row named no History ID').not.toBe('');

        test.info().annotations.push({
            type: 'bill window',
            description:
                `${bill.isPopup ? 'opened in a new window' : 'opened in the same tab'} for ` +
                `history ${bill.listing.historyId}, patient ${bill.listing.patientId} ` +
                `(${bill.listing.patientName}), dated ${bill.listing.date}`,
        });

        await billPage.returnToList(bill);

        // Back on the list, ready for the next row — which is what a run working through
        // a backlog does between every bill.
        await expect(page).toHaveURL(/PendingBill/i);
    });

    test('TC04 - Enter a random batch number and submit', async ({ page }) => {
        test.setTimeout(180000);

        const dialogMessages = billPage.captureDialogs();

        await billPage.open();
        const pending = await billPage.fetchPendingBills({ range: previousDayToToday() });

        test.skip(pending === 0, 'The centre has no pending bill for the previous day');

        // One call does the lot: opens the window, fills every medicine line with a
        // generated batch and an expiry chosen from the dropdown, submits, and closes the
        // window again so the list is in front for the next row.
        const bill = await billPage.createBillForFirstPending(dialogMessages);

        // A row the app will not bill — it answers Create Bill with "no patients" — leaves
        // nothing for this test to assert against. That is the centre's state, not a
        // defect, so it is skipped the same way an empty list is.
        test.skip(
            Boolean(bill.nothingToBill),
            `The app answered Create Bill with "${bill.nothingToBill}", so there is no bill ` +
                'to record a batch on'
        );

        expect(
            bill.medicines.length,
            'The bill had no medicine line to record a batch against'
        ).toBeGreaterThan(0);

        // Every line, not just the first. `#medicines[0][batch_no]` is one medicine of
        // however many the prescription carries, and the bill is refused while any of them
        // is blank - so a run that filled only line 0 was testing the refusal.
        for (const line of bill.medicines) {
            expect(
                line.batchNumber,
                `${line.medicine || `Line ${line.line + 1}`} was left without a batch number`
            ).toMatch(/^[A-Z]{2}\d{4}$/);
        }

        test.info().annotations.push({
            type: 'bill',
            description:
                `prescription ${bill.prescriptionId} for ${bill.patientName}: ` +
                bill.medicines
                    .map((line) => `${line.medicine} — ${line.batchNumber} exp ${line.expiry}`)
                    .join(' | '),
        });

        expect(bill.complaint, `The bill was refused: ${bill.complaint}`).toBe('');
        await expect(page, 'The run did not come back to the pending list').toHaveURL(
            /PendingBill/i
        );
    });

    test('TC05 - Set a random Date of Expiry and submit', async ({ page }) => {
        test.setTimeout(180000);

        const dialogMessages = billPage.captureDialogs();

        await billPage.open();
        const pending = await billPage.fetchPendingBills({ range: previousDayToToday() });

        test.skip(pending === 0, 'The centre has no pending bill for the previous day');

        const bill = await billPage.createBillForFirstPending(dialogMessages);

        test.skip(
            Boolean(bill.nothingToBill),
            `The app answered Create Bill with "${bill.nothingToBill}", so there is no bill ` +
                'to set an expiry on'
        );

        // The expiry is what this test is about, so it is checked rather than assumed. It
        // is a dropdown of the batches the centre holds, so an empty one here means the
        // run left the "Select" placeholder in place — which is exactly what makes the
        // submit fail, silently, a step later.
        for (const line of bill.medicines) {
            expect(
                line.expiry,
                `${line.medicine || `Line ${line.line + 1}`} has no date of expiry — the ` +
                    'dropdown was left on its placeholder'
            ).not.toBe('');
            expect(
                line.expiry,
                `${line.medicine || `Line ${line.line + 1}`} kept the placeholder as its expiry`
            ).not.toMatch(/^-*\s*select/i);
        }

        test.info().annotations.push({
            type: 'expiry dates',
            description: bill.medicines
                .map((line) => `${line.medicine || `line ${line.line + 1}`}: ${line.expiry}`)
                .join('; '),
        });

        expect(
            bill.complaint,
            `The bill for ${bill.prescriptionId} was refused: ${bill.complaint}`
        ).toBe('');
        await expect(page).toHaveURL(/PendingBill/i);
    });
});
