import { expect, type Locator, type Page } from '@playwright/test';
import { baseUrl } from '../config/test-env';
import { isVisibleWithin } from './selectize';

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
 * Which screens this centre keeps its patients on. Every centre's list is the same grid
 * — same columns, same filter boxes, same Name link carrying the id — but the Tibet
 * centre serves it from /TibetPatientSearch and its records from /TibetPatientForm, so
 * the two paths are the only thing a run has to say. See TibetRegistrationPage.
 */
export type PatientSearchPaths = {
    /** The list itself. Default: /PatientSearch. */
    searchPath?: string;
    /** A patient's own record, opened as <patientFormPath>?id=<numeric id>. */
    patientFormPath?: string;
};

/**
 * Patient Search — the list of patients already registered at this centre. Used to
 * add a case history to an existing record rather than registering a new one.
 */
export class PatientSearchPage {
    private readonly searchPath: string;
    private readonly patientFormPath: string;

    constructor(
        private readonly page: Page,
        paths: PatientSearchPaths = {}
    ) {
        this.searchPath = paths.searchPath ?? '/PatientSearch';
        this.patientFormPath = paths.patientFormPath ?? '/PatientForm';
    }

    async open(): Promise<void> {
        await this.page.goto(`${baseUrl.replace(/\/$/, '')}${this.searchPath}`);
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
        await this.page.goto(
            `${baseUrl.replace(/\/$/, '')}${this.patientFormPath}?id=${patient.numericId}`
        );
        await expect(this.page.locator('#patient_name')).toHaveValue(patient.name, {
            timeout: 15000,
        });
    }

    /**
     * Presses "Add Case History" on the patient's own record and does not come back until
     * the case history form is genuinely open.
     *
     * A bare click here is not enough, and the way it fails is silent. The button carries
     * no href and no submit behaviour — everything it does lives in a handler the page
     * binds when its own scripts run — so a click that lands before the binding, or that
     * the browser refuses because a field on the record will not validate, does nothing
     * at all. The page stays on /PatientForm, the button takes the focus ring, and
     * nothing anywhere says why. The run then walks on into the case history form's
     * fields and hangs on the first one, several minutes and one module case away from
     * the thing that actually went wrong.
     *
     * So the click is made against a page whose scripts have run, the outcome is waited
     * for as the form appearing rather than as the click returning, and a click that went
     * nowhere is tried again. What is still on /PatientForm after that is reported with
     * the page's own reasons attached: the fields the browser will not accept and what it
     * says about them, anything the app raised as an alert, and whether the click opened
     * a tab instead of navigating.
     */
    async openCaseHistoryFromPatientForm(
        dialogMessages: string[] = [],
        options: {
            /**
             * What to do about a refusal that is the centre's state rather than this
             * patient's - the previous day's bills and reconciliations. Called once, with
             * the app's own message, and expected to leave the run back on the patient's
             * record. Without one, the refusal is reported and the run stops.
             */
            onCentreBlocked?: (message: string) => Promise<void>;
        } = {}
    ): Promise<void> {
        const page = this.page;
        const patientForm = page.url();
        let recoveryUsed = false;

        const button = page
            .getByRole('button', { name: /add case history/i })
            .or(page.getByRole('link', { name: /add case history/i }))
            .first();

        await expect(
            button,
            `The patient's record at ${patientForm} offers no "Add Case History" control`
        ).toBeVisible({ timeout: 15000 });

        // The case history form's own field — the same anchor CaseHistoryPage checks for,
        // and the only thing that distinguishes the form from the record it was opened
        // from, both of which carry a Save button.
        const caseHistoryField = page
            .locator('#weight')
            .or(page.getByRole('textbox', { name: '--Select a Nursing Staff--' }))
            .first();

        for (let attempt = 1; attempt <= 4; attempt += 1) {
            const alertsBefore = dialogMessages.length;

            // The handler is bound while the page's own scripts run, which is after the
            // navigation the run waited for. Clicking into that gap is what gets swallowed.
            await page.waitForLoadState('load').catch(() => undefined);

            await button.click({ timeout: 15000 }).catch(() => undefined);

            const opened = await Promise.race([
                caseHistoryField
                    .waitFor({ state: 'visible', timeout: 15000 })
                    .then(() => true)
                    .catch(() => false),
                page
                    .waitForURL((url) => url.href !== patientForm, { timeout: 15000 })
                    .then(() => true)
                    .catch(() => false),
            ]);

            if (opened && (await isVisibleWithin(caseHistoryField, 15000))) {
                return;
            }

            const raised = dialogMessages.slice(alertsBefore).map((message) => message.trim());

            // The centre-wide block — the previous day's bills and reconciliations — is
            // not about this patient and never clears on its own. Where the caller knows
            // how to deal with it (tests/live/ creates the outstanding bills), it is given
            // the app's own message and one go at it, and the click is then tried again
            // against a centre that is no longer blocked. A second refusal after that is
            // reported rather than papered over: it means the backlog was not what was
            // standing in the way.
            const centreBlocked = raised.find((message) =>
                /reconciliation|create bills|previous day/i.test(message)
            );

            if (centreBlocked && options.onCentreBlocked && !recoveryUsed) {
                recoveryUsed = true;
                console.log(
                    `The app refused because the centre is blocked: ${centreBlocked}\n` +
                        'Clearing what it is waiting on, then opening the case history again.'
                );

                await options.onCentreBlocked(centreBlocked);
                continue;
            }

            if (attempt < 4) {
                // Some of the app's refusals end with "kindly refresh the page", and the
                // centre-wide ones - the previous day's reconciliation and billing - are
                // raised off state the page read when it loaded. Where the app asks for a
                // refresh, it gets one before the next attempt: a block that was cleared
                // while this run was in flight is answered by exactly that, and one that
                // was not comes back on the reload and is reported.
                if (raised.some((message) => /refresh the page/i.test(message))) {
                    console.log(
                        `The app refused and asked for a refresh: ${raised[0]}. Reloading the ` +
                            "patient's record and trying once more."
                    );
                    await page.reload({ waitUntil: 'load' }).catch(() => undefined);
                    await expect(
                        button,
                        'The patient record lost its "Add Case History" control on reload'
                    ).toBeVisible({ timeout: 15000 });
                } else {
                    console.log(
                        `"Add Case History" did not open the form (attempt ${attempt}); the run ` +
                            `is still on ${page.url()}. Trying again.`
                    );
                }
            }
        }

        throw new Error(
            `"Add Case History" did not open the case history form. The run is still on ` +
                `${page.url()}.\n${await this.describeWhyNothingHappened(dialogMessages)}`
        );
    }

    /**
     * Why a click on the patient's record went nowhere, in the page's own words. Every
     * part of this is read off the live page rather than guessed at, so the run reports
     * the app's reason instead of a bare timeout.
     */
    private async describeWhyNothingHappened(dialogMessages: string[]): Promise<string> {
        const reasons: string[] = [];

        // A control the browser will not accept blocks a submit outright and says nothing
        // to the page. Disabled and hidden controls are exempt from validation, so
        // anything listed here is genuinely in the way.
        const invalid = await this.page
            .evaluate(() =>
                Array.from(
                    document.querySelectorAll<
                        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
                    >('input, select, textarea')
                )
                    .filter((field) => typeof field.checkValidity === 'function')
                    .filter((field) => !field.checkValidity())
                    .map((field) => {
                        const name =
                            field.getAttribute('name') ||
                            field.id ||
                            field.getAttribute('placeholder') ||
                            field.tagName.toLowerCase();
                        return `${name}: ${field.validationMessage || 'will not validate'}`;
                    })
            )
            .catch(() => [] as string[]);

        if (invalid.length > 0) {
            reasons.push(
                'The browser will not submit this form until these are put right:\n' +
                    invalid.map((field) => `  - ${field}`).join('\n')
            );
        }

        // The same refusal once per attempt is one refusal, not three.
        const raised = [...new Set(dialogMessages.map((message) => message.trim()))].filter(Boolean);

        if (raised.length > 0) {
            reasons.push(`The app raised: ${raised.join(' | ')}`);
        }

        // A centre with the previous day's billing still open is refused every clinical
        // action until that is closed, and no amount of retrying changes it. It is worth
        // saying outright that this is the environment's state and not the run's doing —
        // it is the difference between a bug to chase and a centre to tidy up.
        if (raised.some((message) => /reconciliation|create bills/i.test(message))) {
            reasons.push(
                'That is the app blocking the centre, not the automation: this account has ' +
                    "the previous day's reconciliation and billing still open, and it refuses " +
                    'to start a case history until they are closed. Sign in as ' +
                    `${process.env.E2E_USERNAME || 'the centre user'} and complete the pending ` +
                    'reconciliation and billing, or point the run at a centre that has none ' +
                    '(E2E_USERNAME / E2E_PASSWORD). The run reloaded the page and tried again ' +
                    'first, which is what the message itself asks for, so the block was still ' +
                    'in place.'
            );
        }

        // A handler that opens a tab rather than navigating leaves the run's own page
        // exactly where it was, which looks identical to a click that did nothing.
        const otherTabs = this.page
            .context()
            .pages()
            .filter((open) => open !== this.page)
            .map((open) => open.url());

        if (otherTabs.length > 0) {
            reasons.push(`The click opened another tab instead: ${otherTabs.join(', ')}`);
        }

        if (reasons.length === 0) {
            reasons.push(
                'The page reported nothing: no field failed validation, the app raised no ' +
                    'alert, and no tab was opened. That is what a click landing before the ' +
                    "button's handler was bound looks like, or a handler whose own lookup " +
                    'failed silently.'
            );
        }

        return reasons.join('\n');
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
