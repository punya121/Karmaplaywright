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
        if (await activeSessionMessage.isVisible({ timeout: 5000 }).catch(() => false)) {
            throw new Error(
                'Login blocked: the account has too many active sessions. Log out another session and retry.',
            );
        }

        await expect(this.page.getByRole('link', { name: 'Home' })).toBeVisible({
            timeout: 10000,
        });
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
