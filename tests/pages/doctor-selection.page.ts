import { expect, type Locator, type Page } from '@playwright/test';

/**
 * E2E_HOLD_OPEN=1 (with --headed) parks the run at page.pause() once the prescription
 * has been handed to a doctor and Prescription (Centre) has come back, leaving the
 * browser on that page instead of logging out and closing.
 */
const holdOpen = !!process.env.E2E_HOLD_OPEN;

/**
 * /DoctorSelection?id=<prescription id> — the screen a prescription is sent to a
 * doctor from. The doctors on duty are shown as cards, each headed by the doctor's
 * name ("Dr. Demo") and carrying their own id as its element id; clicking the card
 * assigns them, and Save at the top of the page commits the handover and returns to
 * Search > Prescription (Centre).
 *
 * Two things about this screen bite a run that treats it as an ordinary form:
 *
 *   - The cards are id="362", id="418" and so on. `#362` is not a valid CSS
 *     identifier, so Playwright does not merely fail to match it — querySelectorAll
 *     throws. The card is picked by the name on it, and the id is only a fallback.
 *   - A first-time tour bubble ("Got it, thanks") covers the cards and comes back
 *     after the page reloads, which is why a recorded session shows the same doctor
 *     being clicked three times. dismissTour() is called on both sides of the pick.
 */
export class DoctorSelectionPage {
    constructor(private readonly page: Page) {}

    /** The doctor a run hands its prescription to, and their card id as a fallback. */
    static readonly defaultDoctor = process.env['E2E_DOCTOR_NAME'] || 'Dr. Demo';
    static readonly defaultDoctorId = process.env['E2E_DOCTOR_ID'] || '362';

    /** The card headed by this doctor's name — what a user actually clicks. */
    private doctorCard(name: string): Locator {
        return this.page.getByText(name, { exact: true }).first();
    }

    private doctorCardById(doctorId: string): Locator {
        return this.page.locator(`[id="${doctorId}"]`);
    }

    private saveButton(): Locator {
        return this.page.getByRole('button', { name: /^Save$/i }).first();
    }

    async expectLoaded(): Promise<void> {
        await this.page.waitForLoadState('load');
        await expect(
            this.page,
            'Doctor Selection did not open for this prescription'
        ).toHaveURL(/DoctorSelection/i, { timeout: 15000 });
    }

    /**
     * Clears the tour bubble if it is up. It is not always there — only the first
     * visit of a session gets it — so its absence is not a failure.
     */
    async dismissTour(): Promise<boolean> {
        const gotIt = this.page.getByRole('button', { name: /Got it,? thanks/i }).first();

        if (!(await gotIt.isVisible({ timeout: 2000 }).catch(() => false))) {
            return false;
        }

        await gotIt.click().catch(() => undefined);
        await this.page.waitForLoadState('load').catch(() => undefined);
        return true;
    }

    /**
     * Clicks the doctor's card and reports who was picked. The tour can steal the first
     * click, so the bubble is cleared first and the pick is repeated if it reappears.
     */
    async selectDoctor(name = DoctorSelectionPage.defaultDoctor): Promise<string> {
        await this.dismissTour();

        const card = (await this.doctorCard(name).isVisible({ timeout: 10000 }).catch(() => false))
            ? this.doctorCard(name)
            : this.doctorCardById(DoctorSelectionPage.defaultDoctorId);

        await expect(
            card,
            `Doctor Selection offers no card for ${name} — set E2E_DOCTOR_NAME to a doctor this centre lists`
        ).toBeVisible({ timeout: 15000 });

        await card.click();

        // The bubble comes back on the reload the pick triggers, and it sits over both
        // the cards and Save, so it has to go before the form can be submitted.
        if (await this.dismissTour()) {
            await card.click().catch(() => undefined);
        }

        return name;
    }

    /**
     * Save commits the handover and the app returns to Search > Prescription (Centre),
     * so the run waits for that page rather than for any navigation — waiting here also
     * stops a logout teardown from cutting the handover short.
     */
    async saveAndExpectPrescriptionCentre(): Promise<void> {
        await expect(this.saveButton(), 'Doctor Selection has no Save button').toBeVisible({
            timeout: 15000,
        });
        await this.saveButton().click();

        const arrived = await this.page
            .waitForURL(/CentreHome/i, { timeout: 30000 })
            .then(() => true)
            .catch(() => false);

        if (!arrived) {
            throw new Error(
                `Save did not return to Prescription (Centre) — the run is still on ${this.page.url()}, so the prescription may not have been handed over`
            );
        }

        await this.page.waitForLoadState('load');
        await expect(this.page.getByRole('link', { name: 'Home' })).toBeVisible({
            timeout: 15000,
        });

        if (holdOpen) {
            // The handover is done and Prescription (Centre) is up. Stop here so the
            // browser stays on it; resume to end the run.
            await this.page.pause();
        }
    }
}
