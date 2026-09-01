import { test } from '@playwright/test';
import { validPassword, validUsername } from '../config/test-env';
import { LoginPage } from '../pages/login.page';

test('clinician with valid credentials reaches Home', async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.loginExpectingHome(validUsername, validPassword);
});
