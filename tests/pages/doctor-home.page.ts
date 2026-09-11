import { expect, type Locator, type Page } from '@playwright/test';
import { baseUrl } from '../config/test-env';
import { pickRandom } from './selectize';

/**
 * /DoctorHome - what a doctor lands on after signing in: a Check In / Check Out control
 * and the queue of patients waiting for them, one row per prescription, each with a
 * radio in its first column. Selecting a row and pressing Edit opens that consultation's
 * prescription form.
 *
 * The recorded session does this as `#optradio` followed by `#Edit`, which works only
 * while the queue holds exactly one patient - `#optradio` is the id every row's radio
 * carries, so on a real queue it silently means "the first one". A run here reads the
 * queue, picks a row at random, and reports which patient it took, so two runs against
 * the same centre do not fight over the same consultation.
 */
export type QueuedPatient = {
    /** Row position in the queue, 0-based - only meaningful for the run that read it. */
    index: number;
    /** The centre-prefixed patient id off the row, where the row shows one. */
    displayId: string;
    /** The whole row, flattened, for the run log and the report annotation. */
    summary: string;
};

export class DoctorHomePage {
    constructor(private readonly page: Page) {}

    async open(): Promise<void> {
        await this.page.goto(`${baseUrl.replace(/\/$/, '')}/DoctorHome`);
        await this.page.waitForLoadState('load');
        await expect(this.page.getByRole('link', { name: 'Home' })).toBeVisible({ timeout: 15000 });
    }

    private checkInButton(): Locator {
        return this.page.getByRole('button', { name: /^\s*Check In\s*$/i }).first();
    }

    private checkOutButton(): Locator {
        return this.page.getByRole('button', { name: /^\s*Check Out\s*$/i }).first();
    }

    /**
     * A doctor who is not checked in cannot be handed a prescription: Doctor Selection's
     * availability call answers 0 and the pick is swallowed without a word (see
     * DoctorSelectionPage.selectDoctor). The page shows whichever of the two buttons is
     * the action available, so Check In being on screen means the doctor is currently out.
     *
     * Reports whether it had to do anything, so a spec can say so rather than leaving the
     * doctor's state as an invisible side effect of the run.
     */
    async ensureCheckedIn(): Promise<boolean> {
        const checkIn = this.checkInButton();

        if (!(await checkIn.isVisible({ timeout: 5000 }).catch(() => false))) {
            return false;
        }

        await checkIn.click();
        await this.page.waitForLoadState('load').catch(() => undefined);

        await expect(
            this.checkOutButton(),
            'Check In did not take - DoctorHome still offers Check In, so the doctor is not on duty'
        ).toBeVisible({ timeout: 15000 });

        return true;
    }

    /**
     * Puts the doctor back the way the run found them. Left to a spec's teardown so a
     * shared UAT account is not left checked in by a run that has finished.
     */
    async checkOut(): Promise<void> {
        const checkOut = this.checkOutButton();

        if (await checkOut.isVisible({ timeout: 5000 }).catch(() => false)) {
            await checkOut.click().catch(() => undefined);
            await this.page.waitForLoadState('load').catch(() => undefined);
        }
    }

    /** The queue rows - anything carrying the row-select radio. */
    private queueRows(): Locator {
        return this.page
            .getByRole('row')
            .filter({ has: this.page.locator('input[type="radio"]') });
    }

    async waitingCount(): Promise<number> {
        await this.queueRows()
            .first()
            .waitFor({ state: 'visible', timeout: 15000 })
            .catch(() => undefined);
        return this.queueRows().count();
    }

    /**
     * Selects one waiting patient at random and reports who it was. Fails with the queue's
     * actual state rather than a bare timeout, because an empty queue is the ordinary
     * reason this spec cannot run and is worth saying outright.
     */
    async selectRandomWaitingPatient(): Promise<QueuedPatient> {
        const count = await this.waitingCount();

        expect(
            count,
            'DoctorHome lists no waiting patients, so there is no consultation to open. ' +
                'Raise one first (tests/patient/full-consultation.spec.ts registers a patient ' +
                'and hands their prescription to a doctor), or sign in as a doctor who has a queue.'
        ).toBeGreaterThan(0);

        const index = pickRandom([...Array(count).keys()]);
        const row = this.queueRows().nth(index);

        const summary = (await row.innerText()).replace(/\s+/g, ' ').trim();
        const displayId = /\b([A-Z]{2,4}\d{5,})\b/.exec(summary)?.[1] ?? '';

        // The radios all answer to id="optradio", so they are addressed through their own
        // row instead. force: true because the label sits over the control on this grid.
        await row.locator('input[type="radio"]').first().check({ force: true });

        return { index, displayId, summary };
    }

    /**
     * Edit opens the selected consultation's prescription form. Reports the prescription
     * id out of the URL so the form can be held to the row it was opened from.
     */
    async openPrescriptionForm(): Promise<string> {
        const edit = this.page.locator('#Edit');

        await expect(
            edit,
            'DoctorHome has no Edit button to open the selected consultation with'
        ).toBeVisible({ timeout: 15000 });

        await edit.click();
        await this.page.waitForLoadState('load');

        await expect(
            this.page,
            'Edit did not open a prescription form - the run is still on DoctorHome, which ' +
                'happens when no queue row was selected'
        ).toHaveURL(/PrescriptionForm/i, { timeout: 20000 });

        return /[?&]id=(\d+)/i.exec(this.page.url())?.[1] ?? '';
    }
}
