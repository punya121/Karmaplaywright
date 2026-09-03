import { test, expect, Page } from '@playwright/test';
import {
    baseUrl,
    inactivePassword,
    inactiveUsername,
    validPassword,
    validUsername,
    wrongPassword,
} from '../config/test-env';

const LOGIN_URL = `${baseUrl.replace(/\/$/, '')}/Login`;

// Valid active user
// Common error message pattern
const loginErrorText = /invalid|inactive|already|active|error|failed|incorrect|wrong/i;

async function login(page: Page, username: string, password: string) {
    await page.goto(LOGIN_URL);

    await page.getByRole('textbox', { name: 'Username' })
        .fill(username);

    await page.getByPlaceholder('Enter your password')
        .fill(password);

    await page.getByRole('button', { name: 'Login' })
        .click();
}

test.describe('Login Negative Test Cases', () => {

    test('Wrong password should show error', async ({ page }) => {

        await login(page, validUsername, wrongPassword);

        await page.waitForTimeout(3000);

        console.log('Current URL:', page.url());

        const bodyText = await page.locator('body').textContent();
        console.log('Page Text:', bodyText);

        await expect(page.locator('body'))
            .toContainText(loginErrorText, { timeout: 10000 });
    });

    test('Inactive user should show error', async ({ page }) => {

        await login(page, inactiveUsername, inactivePassword);

        await page.waitForTimeout(3000);

        console.log('Current URL:', page.url());

        const bodyText = await page.locator('body').textContent();
        console.log('Page Text:', bodyText);

        await expect(page.locator('body'))
            .toContainText(loginErrorText, { timeout: 10000 });
    });

    test('More than 2 active logins should show error', async ({ browser }) => {

        // First browser session
        const context1 = await browser.newContext();
        const page1 = await context1.newPage();

        await login(page1, validUsername, validPassword);
        await page1.waitForTimeout(5000);

        console.log('First login URL:', page1.url());

        // Second browser session
        const context2 = await browser.newContext();
        const page2 = await context2.newPage();

        await login(page2, validUsername, validPassword);
        await page2.waitForTimeout(5000);

        console.log('Second login URL:', page2.url());

        // Third browser session
        const context3 = await browser.newContext();
        const page3 = await context3.newPage();

        await login(page3, validUsername, validPassword);
        await page3.waitForTimeout(5000);

        console.log('Third login URL:', page3.url());

        await page3.screenshot({
            path: 'third-login-result.png',
            fullPage: true
        });

        const thirdLoginText = await page3.locator('body').textContent();
        console.log('Third Login Page Text:', thirdLoginText);

        // Pause here so you can manually check the third login result
        //await page3.pause();

        await expect(page3.locator('body'))
            .toContainText(loginErrorText, { timeout: 10000 });

        await context1.close();
        await context2.close();
        await context3.close();
    });

});