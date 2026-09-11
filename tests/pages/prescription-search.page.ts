import { expect, type Locator, type Page } from '@playwright/test';
import { baseUrl } from '../config/test-env';
import type { IdentifiedPatient } from './patient-search.page';

/**
 * Search → Prescription (Centre) (/CentreHome): every prescription raised at this
 * centre, newest first, one row per visit. The row's Edit column opens that visit's
 * case history (PrescriptionHistoryForm?id=<prescription id>).
 *
 * A prescription only exists once a case history has been started, so a patient who
 * was registered a minute ago has no row here yet — see CaseHistoryEntry for how a
 * run reaches the form either way.
 */
export class PrescriptionSearchPage {
    constructor(private readonly page: Page) {}

    async open(): Promise<void> {
        await this.page.goto(`${baseUrl.replace(/\/$/, '')}/CentreHome`);
        await this.page.waitForLoadState('load');
        await expect(this.page.getByRole('link', { name: 'Home' })).toBeVisible({
            timeout: 15000,
        });
    }

    /**
     * Rows carrying this patient's centre-prefixed id. It is anchored on the Patient Id
     * cell rather than on the row's text: `hasText` matches the text content, where the
     * cells run together as "1DH3951880Abhinav Rec ...", so neither a word boundary nor
     * a plain substring can tell DH3951880 from a longer id that starts the same way.
     */
    rowsFor(patient: IdentifiedPatient): Locator {
        return this.page.getByRole('row').filter({
            has: this.page.getByRole('cell', { name: patient.displayId, exact: true }),
        });
    }

    async hasPrescriptionFor(patient: IdentifiedPatient): Promise<boolean> {
        return (await this.rowsFor(patient).count()) > 0;
    }

    /**
     * Opens the case history of this patient's most recent prescription. Rows are
     * listed newest first, so the first match is the visit to work on.
     */
    async openCaseHistoryFor(patient: IdentifiedPatient): Promise<void> {
        const row = this.rowsFor(patient).first();
        await expect(
            row,
            `Prescription (Centre) lists no visit for ${patient.displayId}`
        ).toHaveCount(1);

        const caseHistoryLink = row.getByRole('link', { name: /case history/i }).first();
        await expect(
            caseHistoryLink,
            `The prescription row for ${patient.displayId} offers no case history link`
        ).toBeVisible({ timeout: 10000 });

        await caseHistoryLink.click();
        await this.page.waitForLoadState('load');
    }

    /**
     * Opens Doctor Selection for this patient's most recent prescription and reports
     * the prescription id it opened - the row's own action, not a column index.
     *
     * A recorded session gives this as "#prescriptionGrid > table > tbody >
     * tr:nth-child(2) > td:nth-child(9) > font > div > a.button", which is the second
     * row of whatever the grid held that day. The grid is the whole centre's, newest
     * first, so by the next run that row belongs to someone else. The row is found by
     * the patient's own id instead, and the id is checked again on the row before
     * anything is clicked: a doctor assigned to the wrong visit is not something the
     * run would notice afterwards.
     */
    async openDoctorSelectionFor(patient: IdentifiedPatient): Promise<string> {
        const row = this.rowsFor(patient).first();
        await expect(
            row,
            `Prescription (Centre) lists no visit for ${patient.displayId}`
        ).toHaveCount(1, { timeout: 15000 });

        await expect(
            row.getByRole('cell', { name: patient.displayId, exact: true }),
            `The row about to be opened does not carry ${patient.displayId}`
        ).toHaveCount(1);

        const doctorLink = row.locator('a[href*="DoctorSelection" i]').first();
        await expect(
            doctorLink,
            `The prescription row for ${patient.displayId} offers no Doctor Selection link`
        ).toBeVisible({ timeout: 15000 });

        // /DoctorSelection?id=<prescription id>. Read before the click so the page it
        // lands on can be held to the visit this row was for.
        const href = (await doctorLink.getAttribute('href')) ?? '';
        const prescriptionId = /[?&]id=(\d+)/i.exec(href)?.[1] ?? '';
        const landed = new RegExp(`DoctorSelection\\?id=${prescriptionId || '\\d+'}`, 'i');

        // The doctor icon is not always clickable. The server sometimes renders it as
        // <a style="pointer-events: none"> inside a <div>, so a click falls through to
        // that div, and the page's Bootstrap 2 modals (#consentFormModal, #BillModel)
        // are transparent but still sit over the middle columns. Either way Playwright
        // just scrolls up and down retrying until the test times out. A trial click
        // tells whether a real click would reach the icon; if not, the icon's own href
        // is opened, which is the same GET the click would have made.
        const clickable = await doctorLink
            .click({ trial: true, timeout: 5000 })
            .then(() => true)
            .catch(() => false);

        if (clickable) {
            await Promise.all([
                this.page.waitForURL(landed, { timeout: 30000 }),
                doctorLink.click(),
            ]);
        } else {
            const disabledByApp = await doctorLink.evaluate(
                (link) => getComputedStyle(link).pointerEvents === 'none'
            );
            console.log(
                `Doctor icon for ${patient.displayId} is not clickable (${
                    disabledByApp ? 'the app rendered it with pointer-events: none' : 'covered by another element'
                }); opening ${href} directly`
            );
            await this.page.goto(href);
            await expect(this.page).toHaveURL(landed, { timeout: 30000 });
        }

        await this.page.waitForLoadState('load');

        return prescriptionId;
    }

    /**
     * Confirms the case history that was just saved shows up as this patient's
     * prescription — the list is where the centre picks the visit up from.
     */
    async expectPrescriptionFor(patient: IdentifiedPatient): Promise<string> {
        await this.open();

        const row = this.rowsFor(patient).first();
        await expect(
            row,
            `Prescription (Centre) still lists no visit for ${patient.displayId} after the case history was saved`
        ).toHaveCount(1, { timeout: 15000 });

        return (await row.innerText()).replace(/\s+/g, ' ').trim();
    }
}
