import { test, expect } from '@playwright/test';
import {
    inactivePassword,
    inactiveUsername,
    validPassword,
    validUsername,
    wrongPassword,
} from '../config/test-env';
import { LoginPage } from '../pages/login.page';

const loginErrorText = /invalid|inactive|already|active|error|failed|incorrect|wrong/i;

test.describe('Login Negative Test Cases', () => {
    test('Wrong password should show error', async ({ page }) => {
        const loginPage = new LoginPage(page);
        await loginPage.login(validUsername, wrongPassword);

        await expect(page.locator('body')).toContainText(loginErrorText, {
            timeout: 10000,
        });
    });

    test('Inactive user should show error', async ({ page }) => {
        const loginPage = new LoginPage(page);
        await loginPage.login(inactiveUsername, inactivePassword);

        await expect(page.locator('body')).toContainText(loginErrorText, {
            timeout: 10000,
        });
    });

    test('More than 2 active logins should show error', async ({ browser }) => {
        const context1 = await browser.newContext();
        const page1 = await context1.newPage();
        await new LoginPage(page1).login(validUsername, validPassword);

        const context2 = await browser.newContext();
        const page2 = await context2.newPage();
        await new LoginPage(page2).login(validUsername, validPassword);

        const context3 = await browser.newContext();
        const page3 = await context3.newPage();
        await new LoginPage(page3).login(validUsername, validPassword);

        await expect(page3.locator('body')).toContainText(loginErrorText, {
            timeout: 10000,
        });

        await context1.close();
        await context2.close();
        await context3.close();
    });
});
