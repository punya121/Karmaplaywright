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
    private readonly path: string;

    /**
     * `path` is the centre's own prescription list. It is the same grid everywhere - the
     * same Patient Id column, the same doctor icon carrying a DoctorSelection link - but
     * the Tibet centre serves it from /TibetCentreHome, so that is the one thing a run
     * against it has to say.
     */
    constructor(
        private readonly page: Page,
        options: { path?: string } = {}
    ) {
        this.path = options.path ?? '/CentreHome';
    }

    async open(): Promise<void> {
        await this.page.goto(`${baseUrl.replace(/\/$/, '')}${this.path}`);
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
    async openDoctorSelectionFor(
        patient: IdentifiedPatient,
        options: { allowWhileNoDoctorOnDuty?: boolean } = {}
    ): Promise<string> {
        const row = this.rowsFor(patient).first();
        await expect(
            row,
            `Prescription (Centre) lists no visit for ${patient.displayId}`
        ).toHaveCount(1, { timeout: 15000 });

        await expect(
            row.getByRole('cell', { name: patient.displayId, exact: true }),
            `The row about to be opened does not carry ${patient.displayId}`
        ).toHaveCount(1);

        const doctorLink = this.doctorSelectionLink(row);
        await expect(
            doctorLink,
            `The prescription row for ${patient.displayId} offers no Doctor Selection link`
        ).toBeVisible({ timeout: 15000 });

        // /DoctorSelection?id=<prescription id>. Read before the click so the page it
        // lands on can be held to the visit this row was for.
        const href = (await doctorLink.getAttribute('href')) ?? '';
        const prescriptionId = /[?&]id=(\d+)/i.exec(href)?.[1] ?? '';
        const landed = new RegExp(`DoctorSelection\\?id=${prescriptionId || '\\d+'}`, 'i');

        // The doctor icon is not always clickable. When no doctor is checked in, the
        // app renders it as <a style="pointer-events: none">, and a click never reaches
        // Doctor Selection. The spec must check that doctor in first rather than skip
        // past the icon. Overlaying Bootstrap 2 modals (#consentFormModal, #BillModel)
        // can also intercept a click; in that case the icon's own href is opened, which
        // is the same GET a real click would have made.
        const clickable = await this.isDoctorLinkClickable(doctorLink);

        if (clickable) {
            await Promise.all([
                this.page.waitForURL(landed, { timeout: 30000 }),
                doctorLink.click(),
            ]);
        } else {
            const disabledByApp = await this.isDoctorLinkDisabledByApp(doctorLink);

            // Opening the screen and assigning from it are two different things. The icon
            // is dead while nobody is on duty, but its href is the same plain GET it
            // always was, so the screen itself can still be opened - it simply has no
            // doctor cards on it yet. A run that brings the doctor on duty *after*
            // landing here (tests/live/) asks for exactly that and reloads once the
            // doctor is in; every other caller still wants the failure, because for them
            // an empty Doctor Selection is a dead end.
            if (!options.allowWhileNoDoctorOnDuty) {
                expect(
                    disabledByApp,
                    `The doctor icon for ${patient.displayId} is not clickable because no ` +
                        `doctor is checked in (pointer-events: none). Log in as the doctor, ` +
                        `press Check In, then come back as the centre to assign them.`
                ).toBe(false);
            }

            console.log(
                `Doctor icon for ${patient.displayId} is ${
                    disabledByApp
                        ? 'disabled by the app (no doctor on duty yet)'
                        : 'covered by another element'
                }; opening ${href} directly`
            );
            await this.page.goto(href);
            await expect(this.page).toHaveURL(landed, { timeout: 30000 });
        }

        await this.page.waitForLoadState('load');

        return prescriptionId;
    }

    /**
     * Whether this patient's doctor icon would take a click. When no doctor is on duty
     * the app disables the link with pointer-events: none, so the centre cannot assign
     * anyone until that doctor has checked in.
     */
    async isDoctorSelectionClickable(patient: IdentifiedPatient): Promise<boolean> {
        const row = this.rowsFor(patient).first();
        await expect(
            row,
            `Prescription (Centre) lists no visit for ${patient.displayId}`
        ).toHaveCount(1, { timeout: 15000 });

        const doctorLink = this.doctorSelectionLink(row);
        await expect(
            doctorLink,
            `The prescription row for ${patient.displayId} offers no Doctor Selection link`
        ).toBeVisible({ timeout: 15000 });

        return this.isDoctorLinkClickable(doctorLink);
    }

    async isDoctorSelectionDisabledByApp(patient: IdentifiedPatient): Promise<boolean> {
        const row = this.rowsFor(patient).first();
        const doctorLink = this.doctorSelectionLink(row);
        return this.isDoctorLinkDisabledByApp(doctorLink);
    }

    private doctorSelectionLink(row: Locator): Locator {
        return row.locator('a[href*="DoctorSelection" i]').first();
    }

    private async isDoctorLinkClickable(doctorLink: Locator): Promise<boolean> {
        return doctorLink
            .click({ trial: true, timeout: 5000 })
            .then(() => true)
            .catch(() => false);
    }

    private async isDoctorLinkDisabledByApp(doctorLink: Locator): Promise<boolean> {
        return doctorLink.evaluate((link) => getComputedStyle(link).pointerEvents === 'none');
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
