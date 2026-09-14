import { expect, type Locator, type Page } from '@playwright/test';
import { baseUrl } from '../config/test-env';

export type ExistingPatient = IdentifiedPatient & {
    /** Row text, for reporting which patient the run picked. */
    label: string;
};

/**
 * A patient as Patient Search lists them. The screens disagree about what "patient
 * id" means — the lists show the centre-prefixed id (DH3951875) while Assign Consent
 * Form and every /PatientForm?id= link use the bare number — so a run carries both.
 */
export type IdentifiedPatient = {
    /** As displayed: centre prefix and number, e.g. DH3951875. */
    displayId: string;
    /** The bare number, e.g. 3951875 — what Assign Consent Form expects. */
    numericId: string;
    name: string;
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
            const row = caseHistoryAction.locator('xpath=ancestor::tr[1]');
            const patient = await this.patientFromRow(row);
            await caseHistoryAction.click();
            return patient;
        }

        // No direct action in the list: open the first patient, then add from there.
        const rows = this.resultRows();
        const rowCount = await rows.count();
        expect(
            rowCount,
            'Patient Search returned no existing patients to add a case history to'
        ).toBeGreaterThan(0);

        const firstRow = rows.first();
        const patient = await this.patientFromRow(firstRow);

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
            `Opened "${patient.label}" but found no "Add Case History" control on their page`
        ).toBeVisible({ timeout: 15000 });
        await addCaseHistory.click();

        return patient;
    }


    /**
     * The filter panel above the results. Every field posts the form back, so set one
     * and apply rather than typing into a live-filtering box (there isn't one).
     */
    private filterField(name: 'Id' | 'PatientName' | 'Parent' | 'Phone' | 'Aadhaar'): Locator {
        return this.page.locator(`input[name="${name}"]`).first();
    }

    /**
     * The filter boxes keep whatever the last search put in them, so a second lookup
     * would silently search for both terms at once. Empty them all before setting one.
     */
    private async clearFilters(): Promise<void> {
        const boxes = this.page.locator(
            'input[name="Id"], input[name="PatientName"], input[name="Parent"], input[name="Phone"], input[name="Aadhaar"]'
        );

        for (let index = 0; index < (await boxes.count()); index += 1) {
            await boxes.nth(index).fill('').catch(() => undefined);
        }
    }

    async applyFilter(
        name: 'Id' | 'PatientName' | 'Parent' | 'Phone' | 'Aadhaar',
        value: string
    ): Promise<void> {
        const field = this.filterField(name);
        await expect(field).toBeVisible({ timeout: 15000 });
        await this.clearFilters();
        await field.fill(value);

        await Promise.all([
            this.page.waitForLoadState('load'),
            this.page.locator('input[name="Search"]').first().click(),
        ]);
    }

    /**
     * The result row for a patient, found by the link the Name column always carries.
     */
    private rowForName(name: string): Locator {
        return this.page
            .getByRole('row')
            .filter({ has: this.page.getByRole('link', { name, exact: true }) })
            .first();
    }

    /**
     * Reads back the id the app gave a patient that was just saved. Registration
     * lands here but never states the id, so it is looked up by the mobile number —
     * unique per run — and the name is checked against the row before its id is
     * trusted. Falls back to filtering by name in case the phone filter comes back
     * empty (an older record with the same number, a filter the centre disables).
     */
    async identifyPatient(patient: { name: string; mobile: string }): Promise<IdentifiedPatient> {
        if (!/PatientSearch/i.test(this.page.url())) {
            await this.open();
        }

        // Save lands on Patient Search with the newest registration at the top, so the
        // list as it stands is read first; the filters are only a fallback for when the
        // patient has been pushed off the first page.
        const lookups = [
            undefined,
            ['Phone', patient.mobile],
            ['PatientName', patient.name],
        ] as const;

        for (const lookup of lookups) {
            if (lookup) {
                await this.applyFilter(lookup[0], lookup[1]);
            }

            const row = this.rowForName(patient.name);
            if (!(await row.count())) {
                continue;
            }

            // Columns: No | Id | Name | ... — the id is the second cell.
            const displayId = (await row.getByRole('cell').nth(1).innerText()).trim();
            const href =
                (await row
                    .getByRole('link', { name: patient.name, exact: true })
                    .first()
                    .getAttribute('href')) ?? '';
            const numericId = /[?&]id=(\d+)/.exec(href)?.[1] ?? displayId.replace(/\D/g, '');

            expect(
                numericId,
                `Found "${patient.name}" as ${displayId} but could not read a numeric id out of "${href}"`
            ).toMatch(/^\d+$/);

            return { displayId, numericId, name: patient.name };
        }

        // Say what the list does hold, so a failure here separates "the save silently
        // did nothing" from "the lookup looked in the wrong place".
        const listed = await this.page
            .getByRole('row')
            .filter({ has: this.page.getByRole('link') })
            .first()
            .innerText()
            .then((text) => text.replace(/\s+/g, ' ').trim())
            .catch(() => '(no rows at all)');

        throw new Error(
            `Patient Search found no patient named "${patient.name}" (mobile ${patient.mobile}) — the registration may not have saved. The list currently starts with: ${listed}`
        );
    }

    /**
     * Filters the list down to one patient. The Id box is picky about which of the
     * two id shapes it takes, so the bare number, the displayed id and finally the
     * name are each tried until the row turns up.
     */
    private async locateRow(patient: IdentifiedPatient): Promise<Locator> {
        for (const [field, value] of [
            ['Id', patient.numericId],
            ['Id', patient.displayId],
            ['PatientName', patient.name],
        ] as const) {
            await this.applyFilter(field, value);

            const row = this.rowForName(patient.name);
            if (await row.count()) {
                return row;
            }
        }

        // A dropped session looks exactly like an empty search result: the app answers
        // every page with the login screen, so the grid has no rows on it. That is the
        // usual reason a patient found moments ago cannot be found again - the account
        // allows only a handful of concurrent sessions - and it is worth saying rather
        // than leaving as "no such patient".
        const loginForm = this.page
            .getByRole('button', { name: /^\s*Login\s*$/i })
            .or(this.page.getByPlaceholder('Enter your password'))
            .first();

        // Waited for rather than read off: the redirect to the login screen is usually
        // still in flight when the last search comes back empty, and an instant read
        // catches the page mid-navigation and says no.
        const bounced = await loginForm
            .waitFor({ state: 'visible', timeout: 5000 })
            .then(() => true)
            .catch(() => false);

        if (bounced) {
            throw new Error(
                `The app returned to the login page while looking for ${patient.displayId} ` +
                    '("' + patient.name + '"), so the session was dropped rather than the ' +
                    'patient missing. The account allows only a few concurrent sessions: ' +
                    'let the older ones expire, or run fewer at once.'
            );
        }

        throw new Error(
            `Patient Search lists no row for ${patient.displayId} ("${patient.name}")`
        );
    }

    /**
     * The View Consent column is the app's own read of whether a consent form is on
     * file: a patient without one is offered "Upload Consent", one with a consent
     * gets a "View" link to it.
     */
    async expectConsentOnFile(patient: IdentifiedPatient): Promise<void> {
        const row = await this.locateRow(patient);

        await expect(
            row.getByRole('link', { name: /^\s*View\s*$/i }),
            `${patient.displayId} still has no consent form on file — Patient Search offers "Upload Consent", so the case history save would be refused`
        ).toBeVisible({ timeout: 10000 });
    }

    /**
     * Opens the patient's own registration form (/PatientForm?id=), the screen that
     * carries "Add Case History" for a patient already on file.
     */
    async openPatientForm(patient: IdentifiedPatient): Promise<void> {
        await this.page.goto(`${baseUrl.replace(/\/$/, '')}/PatientForm?id=${patient.numericId}`);
        await expect(this.page.locator('#patient_name')).toHaveValue(patient.name, {
            timeout: 15000,
        });
    }

    /**
     * Columns are No | Id | Name | ... — the displayed id and the Name-column
     * /PatientForm?id= link are what Prescription (Centre) and Doctor Selection need
     * after the case history is saved.
     */
    private async patientFromRow(row: Locator): Promise<ExistingPatient> {
        const label = (await row.innerText()).replace(/\s+/g, ' ').trim();
        const displayId = (await row.getByRole('cell').nth(1).innerText()).trim();
        const name = (await row.getByRole('cell').nth(2).innerText()).trim();
        const href = (await row.getByRole('link').first().getAttribute('href')) ?? '';
        const numericId = /[?&]id=(\d+)/.exec(href)?.[1] ?? displayId.replace(/\D/g, '');

        expect(
            displayId,
            `Could not read a patient id from Patient Search row "${label}"`
        ).toMatch(/[A-Za-z]*\d+/);
        expect(
            numericId,
            `Could not read a numeric id from "${href}" on Patient Search row "${label}"`
        ).toMatch(/^\d+$/);

        return { label, displayId, numericId, name: name || displayId };
    }
}
