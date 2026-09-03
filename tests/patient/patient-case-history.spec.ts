import { expect, test, Locator } from '@playwright/test';
import { validPassword, validUsername } from '../config/test-env';
import { createSavePatient } from '../data/patients';
import { LoginPage } from '../pages/login.page';
import { RegistrationPage } from '../pages/registration.page';

function matchExactText(value: string) {
    return new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
}

async function selectDropdownOption(
    page: any,
    field: string | Locator,
    optionText: string
) {
    const input =
        typeof field === 'string'
            ? page.getByRole('textbox', { name: field }).first()
            : field;

    await input.click();

    const option = page
        .locator('.selectize-dropdown:visible .option')
        .filter({ hasText: matchExactText(optionText) })
        .first();

    await expect(option).toBeVisible({ timeout: 10000 });
    await option.click();
}

test.describe('Patient registration case history', () => {
    test.describe.configure({ mode: 'serial' });

    test('adds a case history for a dynamically created patient', async ({ page }) => {
        const loginPage = new LoginPage(page);
        const registrationPage = new RegistrationPage(page);
        const patient = createSavePatient();
        const caseHistory = patient.caseHistory;

        if (!caseHistory) {
            throw new Error('Patient case history data is missing from createSavePatient()');
        }

        await loginPage.loginExpectingHome(validUsername, validPassword);
        await registrationPage.openFromHome();

        const aadhaarRequired = await registrationPage.isAadhaarRequired();
        await registrationPage.fillPatient(patient, { fillAadhaar: aadhaarRequired });

        await page.getByRole('button', { name: 'Add Case History' }).click();
        await expect(page.getByRole('button', { name: 'Save' })).toBeVisible({ timeout: 15000 });

        await selectDropdownOption(page, '--Select a Nursing Staff--', caseHistory.nursingStaff);
        await selectDropdownOption(page, '--Select a Transport Mode--', caseHistory.transportMode);

        await page.locator('#weight').fill(caseHistory.weight);
        await page.locator('#height').fill(caseHistory.height);
        await page.locator('#high_bp').fill(caseHistory.highBp);
        await page.locator('#low_bp').fill(caseHistory.lowBp);
        await page.locator('#pulse').fill(caseHistory.pulse);
        await page.locator('#temperature').fill(caseHistory.temperature);
        await page.locator('#respiratory_rate').fill(caseHistory.respiratoryRate);
        await page.locator('input[name="spo2"]').fill(caseHistory.spo2);

        await page.locator('.selectize-input.items.required.not-full').first().click();
        await page.getByText(caseHistory.symptom, { exact: true }).click();

        await page.getByRole('table').filter({ hasText: 'Allergies : Known Not Known *' }).click();
        await selectDropdownOption(
            page,
            page.getByRole('textbox', { name: 'Time Duration' }).first(),
            caseHistory.symptomDurationUnit
        );
        await selectDropdownOption(
            page,
            page.getByRole('textbox', { name: 'Severity' }).first(),
            caseHistory.symptomSeverity
        );
        await page.getByRole('button', { name: 'Add Symptom' }).click();

        await selectDropdownOption(
            page,
            page.getByRole('textbox', { name: 'Test' }).first(),
            caseHistory.testName
        );

        const firstTestResultField = page.locator('.selectize-control.test_result_value input').first();
        await expect(firstTestResultField).toBeVisible({ timeout: 10000 });
        await firstTestResultField.fill(caseHistory.testValue);

        await page.getByRole('button', { name: 'Add a test' }).click();

        await selectDropdownOption(
            page,
            page.getByRole('textbox', { name: 'Test' }).last(),
            caseHistory.followUpTestName
        );

        const followUpValueInput = page.locator('input[name="1"]').first();
        if (await followUpValueInput.isVisible({ timeout: 2000 }).catch(() => false)) {
            await followUpValueInput.fill(caseHistory.followUpTestValue);
        }

        page.once('dialog', async (dialog) => {
            console.log(`Dialog message: ${dialog.message()}`);
            await dialog.dismiss().catch(() => undefined);
        });

        await page.getByRole('button', { name: 'Save' }).click();
    });
});