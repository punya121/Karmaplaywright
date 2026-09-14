import { expect, type Page } from '@playwright/test';
import { baseUrl } from '../config/test-env';

function loginUrl(): string {
    return `${baseUrl.replace(/\/$/, '')}/Login`;
}

export class LoginPage {
    constructor(private readonly page: Page) {}

    async goto(): Promise<void> {
        await this.page.goto(loginUrl());
    }

    async login(username: string, password: string): Promise<void> {
        await this.goto();
        await this.page.getByRole('textbox', { name: 'Username' }).fill(username);
        await this.page.getByPlaceholder('Enter your password').fill(password);
        await this.page.getByRole('button', { name: 'Login' }).click();
    }

    async expectHome(): Promise<void> {
        const activeSessionMessage = this.page.getByText(/already have \d+ active sessions/i);
        // A centre lands on a page with an accessible "Home" link. A doctor lands on
        // DoctorHome whose nav Home is an image with no name, so the greeting and the
        // Check In / Check Out control are what show the session took.
        const signedIn = this.page
            .getByRole('link', { name: 'Home' })
            .or(this.page.getByRole('heading', { name: /Hello Dr/i }))
            .or(this.page.locator('#Checkin'))
            .or(this.page.getByRole('button', { name: /^\s*Check In\s*$/i }))
            .or(this.page.locator('#Checkout'))
            .or(this.page.getByRole('button', { name: /^\s*Check Out\s*$/i }));

        await Promise.race([
            activeSessionMessage.waitFor({ state: 'visible', timeout: 15000 }),
            signedIn.first().waitFor({ state: 'visible', timeout: 15000 }),
        ]).catch(() => undefined);

        if (await activeSessionMessage.isVisible().catch(() => false)) {
            throw new Error(
                'Login blocked: the account has too many active sessions. Log out another session and retry.',
            );
        }

        await expect(
            signedIn.first(),
            'Login did not reach a centre or doctor home page'
        ).toBeVisible({ timeout: 5000 });
    }

    async loginExpectingHome(username: string, password: string): Promise<void> {
        await this.login(username, password);
        await this.expectHome();
    }

    /**
     * The account allows only a handful of concurrent sessions, so a run that just
     * closes the browser burns a slot until the server expires it. Always log out.
     */
    async logout(): Promise<void> {
        await this.page
            .goto(`${baseUrl.replace(/\/$/, '')}/Home/logout`)
            .catch(() => undefined);
    }
}
