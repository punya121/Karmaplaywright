import { expect, type Locator, type Page } from '@playwright/test';
import { baseUrl } from '../config/test-env';

export type ExistingPatient = {
    /** Row text, for reporting which patient the run picked. */
    label: string;
};

/**
 * Patient Search — the list of patients already registered at this centre. Used to
 * add a case history to an existing record rather than registering a new one.
 */
export class PatientSearchPage {
    constructor(private readonly page: Page) {}

    async open(): Promise<void> {
        await this.page.goto(`${baseUrl.replace(/\/$/, '')}/PatientSearch`);
        await this.page.waitForLoadState('load');
        await expect(this.page.getByRole('link', { name: 'Home' })).toBeVisible({
            timeout: 15000,
        });
    }

    /**
     * Rows carrying a patient. The header row is excluded by requiring a link or
     * button in the row — every result row offers an action, the header does not.
     */
    private resultRows(): Locator {
        return this.page
            .getByRole('row')
            .filter({ has: this.page.getByRole('link').or(this.page.getByRole('button')) })
            .filter({ hasNotText: /^\s*$/ });
    }

    /**
     * Opens the case history form for a patient already on file. Prefers a row whose
     * action is explicitly about case history; otherwise takes the first result and
     * opens it, then uses the case history control on the patient's own page.
     */
    async openCaseHistoryForExistingPatient(searchTerm?: string): Promise<ExistingPatient> {
        const page = this.page;

        if (searchTerm) {
            const searchBox = page
                .getByRole('textbox')
                .filter({ visible: true })
                .first();
            await searchBox.fill(searchTerm);
            await searchBox.press('Enter');
            await page.waitForLoadState('networkidle');
        }

        const caseHistoryAction = page
            .getByRole('link', { name: /case history/i })
            .or(page.getByRole('button', { name: /case history/i }))
            .first();

        if (await caseHistoryAction.isVisible().catch(() => false)) {
            const label = (await this.rowTextFor(caseHistoryAction)) ?? 'first listed patient';
            await caseHistoryAction.click();
            return { label };
        }

        // No direct action in the list: open the first patient, then add from there.
        const rows = this.resultRows();
        const rowCount = await rows.count();
        expect(
            rowCount,
            'Patient Search returned no existing patients to add a case history to'
        ).toBeGreaterThan(0);

        const firstRow = rows.first();
        const label = (await firstRow.innerText()).replace(/\s+/g, ' ').trim();

        await firstRow
            .getByRole('link')
            .or(firstRow.getByRole('button'))
            .first()
            .click();
        await page.waitForLoadState('load');

        const addCaseHistory = page
            .getByRole('button', { name: /add case history/i })
            .or(page.getByRole('link', { name: /add case history/i }))
            .first();

        await expect(
            addCaseHistory,
            `Opened "${label}" but found no "Add Case History" control on their page`
        ).toBeVisible({ timeout: 15000 });
        await addCaseHistory.click();

        return { label };
    }

    private async rowTextFor(action: Locator): Promise<string | null> {
        return action
            .evaluate((element) => element.closest('tr')?.innerText ?? null)
            .then((text) => (text ? text.replace(/\s+/g, ' ').trim() : null))
            .catch(() => null);
    }
}
