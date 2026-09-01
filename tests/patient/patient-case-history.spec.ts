import { test } from '@playwright/test';
import {
  validPassword,
  validUsername,
} from '../config/test-env';

test('Patient registration then case history', async ({ page }) => {
  await page.goto('https://sandbox.karmaprimaryhealthcare.in/Login');

  await page.getByRole('textbox', { name: 'Username' }).fill(validUsername);
  await page.getByPlaceholder('Enter your password').fill(validPassword);
  await page.getByRole('button', { name: 'Login' }).click();

  const activeSessionMessage = page.getByText(/already have \d+ active sessions/i);
  if (await activeSessionMessage.isVisible({ timeout: 5000 }).catch(() => false)) {
    throw new Error('Login blocked: the account has too many active sessions. Log out another session and retry.');
  }

  await page.getByRole('link', { name: 'Home' }).waitFor({ state: 'visible', timeout: 10000 });

  await page.locator('a').filter({ hasText: /^Registration$/ }).click();
  await page.getByRole('link', { name: '» Patient' }).click();
  await page.waitForTimeout(2000);

  await page.locator('#patient_name').fill('Test Patient');
  await page.locator('#parent').fill('Test Father');
  await page.locator('#age_years').check();
  await page.locator('#patient_age').fill('35'); 
  await page.getByRole('radio').nth(4).check();
  await page.locator('#NotMarriedChecked').check();
  await page.getByRole('textbox', { name: 'Select a village...' }).click();
  await page.locator('div').filter({ hasText: /^Bhondsi$/ }).click();
  await page.locator('#outreach_drop').selectOption('52');
  await page.getByRole('textbox', {
    name: 'Enter a valid 10-digit mobile'
  }).fill('9876543210');
  await page.getByRole('button', { name: 'Add Case History' }).click();
  await page.getByRole('textbox', { name: '--Select a Nursing Staff--' }).click();
  await page.getByText('Amita').click();
  await page.getByRole('textbox', { name: '--Select a Transport Mode--' }).click();
  await page.getByText('Car', { exact: true }).click();
  await page.locator('#weight').click();
  await page.locator('#weight').fill('85');
  await page.locator('#height').click();
  await page.locator('#height').fill('176');
  await page.locator('#high_bp').click();
  await page.locator('#high_bp').fill('90');
  await page.locator('#low_bp').click();
  await page.locator('#low_bp').fill('80');
  await page.locator('#pulse').click();
  await page.locator('#pulse').fill('72');
  await page.locator('#temperature').click();
  await page.locator('#temperature').fill('98');
  await page.locator('#respiratory_rate').click();
  await page.locator('#respiratory_rate').fill('17');
  await page.locator('input[name="spo2"]').fill('98');
  await page.locator('.selectize-input.items.required.not-full').first().click();
  await page.getByText('Abdominal Bloating').click();
  await page.locator('.selectize-input.items.required.not-full').first().click();
  await page.getByRole('table').filter({ hasText: 'Allergies : Known Not Known *' }).click();
  await page.getByRole('textbox', { name: 'Time Duration' }).click();
  await page.getByText('Days', { exact: true }).click();
  await page.locator('td:nth-child(9) > .selectize-control > .selectize-input').click();
  await page.getByText('Mild', { exact: true }).click();
  await page.getByRole('button', { name: 'Add Symptom' }).click();
  await page.locator('#symptomsTable > tr:nth-child(3) > td > .selectize-control > .selectize-input').first().click();
  await page.getByText('Abnormal eye movements (').nth(1).click();
  await page.getByRole('textbox', { name: 'Duration' }).nth(1).click();
  await page.getByText('2', { exact: true }).nth(1).click();
  await page.getByRole('textbox', { name: 'Time Duration' }).click();
  await page.getByText('Months').nth(1).click();
  await page.locator('tr:nth-child(3) > td:nth-child(9) > .selectize-control > .selectize-input').click();
  await page.getByText('Mild').nth(4).click();
  await page.getByRole('textbox', { name: 'Test' }).click();
  await page.getByText('[PoC] 6 Lead Electro Cardio').click();
  await page.locator('.selectize-control.test_result_value > .selectize-input > input').click();
  await page.getByRole('button', { name: 'Add a test' }).click();
  await page.getByRole('textbox', { name: 'Test' }).click();
  await page.getByText('[PoC] HbA1c').nth(1).click();
  await page.locator('input[name="1"]').click();
  await page.locator('input[name="1"]').fill('7');
  await page.getByRole('group', { name: 'Point of care test (to be' }).click();
  await page.getByText('Non- Sinus Rhythm').click();
  page.once('dialog', dialog => {
    console.log(`Dialog message: ${dialog.message()}`);
    dialog.dismiss().catch(() => {});
  });
  await page.getByRole('button', { name: 'Save' }).click();
});