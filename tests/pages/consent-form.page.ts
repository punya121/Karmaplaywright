import { expect, type Locator, type Page } from '@playwright/test';
import { baseUrl } from '../config/test-env';

/**
 * Others → Assign Consent Form (/AssignConsentForm).
 *
 * A consent form is normally printed and uploaded from the Nipun mobile app, and
 * without one the case history form refuses to save — which is why a freshly
 * registered patient could never get a case history from a browser run. This screen
 * is the app's own developer shortcut: it writes a dummy consent record straight
 * into patient_consent for the patient id it is given, so a patient registered by a
 * test can go on to have a case history saved against them.
 *
 * The id it wants is the numeric one (3951875), not the centre-prefixed one the
 * lists display (DH3951875).
 */
export class ConsentFormPage {
    constructor(private readonly page: Page) {}

    private patientIdInput(): Locator {
        return this.page.locator('#patient_id');
    }

    async open(): Promise<void> {
        await this.page.goto(`${baseUrl.replace(/\/$/, '')}/AssignConsentForm`);
        await expect(this.patientIdInput()).toBeVisible({ timeout: 15000 });
    }

    /**
     * Walks in through the menu the way a user would. The submenu only renders once
     * "Others" is opened, so click that first; falling back to the URL keeps the run
     * going if the menu markup shifts.
     */
    async openFromHome(): Promise<void> {
        const others = this.page
            .locator('a')
            .filter({ hasText: /^\s*»?\s*Others\s*$/ })
            .first();

        if (await others.isVisible().catch(() => false)) {
            await others.click().catch(() => undefined);

            const link = this.page
                .getByRole('link', { name: /Assign Consent Form/i })
                .first();

            if (await link.count()) {
                await link.click({ force: true }).catch(() => undefined);
                if (await this.patientIdInput().isVisible({ timeout: 10000 }).catch(() => false)) {
                    return;
                }
            }
        }

        await this.open();
    }

    /**
     * Enters the patient id and submits. The form posts to /AssignConsentForm/save
     * and renders its outcome as page text, which is returned so a caller can report
     * what the app said. Whether the consent actually landed is confirmed against
     * Patient Search instead — that is where the app itself reads consent from.
     */
    async assign(numericPatientId: string): Promise<string> {
        await this.patientIdInput().fill(numericPatientId);

        await Promise.all([
            this.page
                .waitForURL(/AssignConsentForm/i, { timeout: 20000 })
                .catch(() => undefined),
            this.page.getByRole('button', { name: /^Submit$/i }).click(),
        ]);

        await this.page.waitForLoadState('load');

        // Whatever the save renders — a flash message, the form again — is reported
        // back stripped of the surrounding chrome, so a failed assignment can be read
        // from the run's log rather than guessed at.
        const message = (await this.page.innerText('body'))
            .replace(/\s+/g, ' ')
            .replace(/^.*?Assign Consent Form \(Developer\)/s, '')
            .replace(/Copyright ©.*$/s, '')
            .trim();

        return message;
    }
}
