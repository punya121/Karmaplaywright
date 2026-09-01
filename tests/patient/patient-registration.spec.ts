import { test, expect } from '@playwright/test';
import {
    validPassword,
    validUsername,
} from '../config/test-env';

test('Patient Registration', async ({ page }) => {

    await page.goto('https://sandbox.karmaprimaryhealthcare.in/Login');

    // Enter Username
    await page.getByRole('textbox', { name: 'Username' })
        .fill(validUsername);

    // Enter Password
    await page.getByPlaceholder('Enter your password')
        .fill(validPassword);

    // Click Login
    await page.getByRole('button', { name: 'Login' }).click();

    // Wait for dashboard
    await page.waitForTimeout(5000);

    // Click Registration
    await page.locator('a')
        .filter({ hasText: /^Registration$/ })
        .click();

    // Click Patient
    await page.getByRole('link', { name: '» Patient' })
        .click();

    // Wait for form
    await page.waitForTimeout(2000);

    // Patient Name
    await page.locator('#patient_name')
        .fill('Test Patient');

    // Parent Name
    await page.locator('#parent')
        .fill('Test Father');

    // Age Type
    await page.locator('#age_years')
        .check();

    // Age
    await page.locator('#patient_age')
        .fill('35');

    // Gender
    await page.getByRole('radio')
        .nth(4)
        .check();

    // Marital Status
    await page.locator('#NotMarriedChecked')
        .check();

    // Village
    await page.getByRole('textbox', { name: 'Select a village...' })
        .click();

    await page.locator('div')
        .filter({ hasText: /^Bhondsi$/ })
        .click();

    // Outreach
    await page.locator('#outreach_drop')
        .selectOption('52');

    // Mobile Number
    await page.getByRole('textbox', {
        name: 'Enter a valid 10-digit mobile'
    }).fill('9876543210');

    // Stop here for inspection
    //await page.pause();

    // Click Login
    await page.getByRole('button', { name: 'Add Case History' }).click();
});