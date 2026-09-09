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
     * Opens Doctor Selection for this patient's most recent prescription - the row's
     * own action, not a column index. A recorded session gives this as
     * "#prescriptionGrid > table > tbody > tr:nth-child(2) > td:nth-child(9) > font >
     * div > a.button", which is the second row of whatever the grid held that day; the
     * link is found by where it goes instead, so it stays right when the grid reorders.
     */
    async openDoctorSelectionFor(patient: IdentifiedPatient): Promise<void> {
        const row = this.rowsFor(patient).first();
        await expect(
            row,
            `Prescription (Centre) lists no visit for ${patient.displayId}`
        ).toHaveCount(1, { timeout: 15000 });

        const doctorLink = row.locator('a[href*="DoctorSelection" i]').first();
        await expect(
            doctorLink,
            `The prescription row for ${patient.displayId} offers no Doctor Selection link`
        ).toBeVisible({ timeout: 15000 });

        await doctorLink.click();
        await this.page.waitForLoadState('load');
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
