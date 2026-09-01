import { test, expect } from '@playwright/test';
import { validUsername, validPassword } from './auth.config';

test('User Login', async ({ page }) => {

    await page.goto('https://sandbox.karmaprimaryhealthcare.in/Login');

    // Enter Username
    await page.getByRole('textbox', { name: 'Username' })
    .fill(validUsername);

    // Enter Password
    await page.getByPlaceholder('Enter your password')
        .fill(validPassword);

    // Pause
    //await page.pause();

    // Click Login
    console.log('Clicking login button');
  
    await page.getByRole('button', { name: 'Login' }).click();
   
    console.log('Login button clicked');

    // Wait for navigation
    await page.waitForTimeout(5000);
});