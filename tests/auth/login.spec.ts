import { test } from '@playwright/test';
import { validPassword, validUsername } from '../config/test-env';

test('User Login', async ({ page }) => {

    await page.goto('https://uat.karmaprimaryhealthcare.in/Login');

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