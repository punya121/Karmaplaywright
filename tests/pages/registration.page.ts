import { expect, type Locator, type Page } from '@playwright/test';
import { baseUrl } from '../config/test-env';
import type { PatientRegistrationData } from '../data/patients';

export type FillPatientOptions = {
    fillAadhaar: boolean;
};

export class RegistrationPage {
    constructor(private readonly page: Page) {}

    private patientForm(): Locator {
        return this.page.locator('form').filter({ has: this.page.locator('#patient_name') }).first();
    }

    aadhaarInput(): Locator {
        return this.page
            .locator(
                '#aadhar, #aadhaar, #uid, input[name*="aadhar" i], input[name*="aadhaar" i]',
            )
            .or(this.page.getByRole('textbox', { name: /aadhaa?r/i }))
            .first();
    }

    async openFromHome(): Promise<void> {
        await expect(this.page.getByRole('link', { name: 'Home' })).toBeVisible();

        const patientFormLink = this.page.locator('#main-content a[href*="PatientForm"]').first();
        if (await patientFormLink.isVisible().catch(() => false)) {
            await patientFormLink.click();
        } else {
            await this.page.goto(`${baseUrl.replace(/\/$/, '')}/PatientForm`);
        }

        await expect(this.page.locator('#patient_name')).toBeVisible({ timeout: 15000 });
    }

    async isAadhaarRequired(): Promise<boolean> {
        const field = this.aadhaarInput();
        await field.waitFor({ state: 'visible', timeout: 10000 });

        const requiredAttr = await field.getAttribute('required');
        if (requiredAttr !== null) {
            return true;
        }

        const ariaRequired = await field.getAttribute('aria-required');
        if (ariaRequired === 'true') {
            return true;
        }

        const className = (await field.getAttribute('class')) ?? '';
        if (/\brequired\b/i.test(className)) {
            return true;
        }

        const labelledBy = this.page.locator('label, th, td, span').filter({ hasText: /aadhaa?r/i });
        const count = await labelledBy.count();
        for (let i = 0; i < count; i += 1) {
            const text = (await labelledBy.nth(i).innerText()) ?? '';
            if (/\*/.test(text) || /required/i.test(text)) {
                return true;
            }
        }

        return false;
    }

    async fillAge(age: string, ageUnit: PatientRegistrationData['ageUnit']): Promise<void> {
        const unitControl =
            ageUnit === 'months'
                ? this.page.locator('#age_months')
                : this.page.locator('#age_years');
        await unitControl.click();

        const ageInput = this.page.locator('#patient_age');
        await this.assertAgeWithinMinMax(age, ageInput);

        const spinbutton = this.page.getByRole('spinbutton');

        if (await spinbutton.first().isVisible({ timeout: 2000 }).catch(() => false)) {
            await spinbutton.first().fill(age);
            return;
        }

        await ageInput
            .waitFor({ state: 'visible', timeout: 3000 })
            .catch(() => undefined);

        if (await ageInput.isVisible().catch(() => false)) {
            await ageInput.fill(age);
            return;
        }

        // Native input stays in the DOM with class "disable" (not visible).
        await ageInput.fill(age, { force: true });
    }

    async assertAgeWithinMinMax(age: string, ageInput = this.page.locator('#patient_age')): Promise<void> {
        const value = Number(age);
        if (Number.isNaN(value)) {
            throw new Error(`patient_age "${age}" is not a number`);
        }

        const minAttr = await ageInput.getAttribute('min');
        const maxAttr = await ageInput.getAttribute('max');
        const min = minAttr === null || minAttr === '' ? undefined : Number(minAttr);
        const max = maxAttr === null || maxAttr === '' ? undefined : Number(maxAttr);

        if (min !== undefined && !Number.isNaN(min) && value < min) {
            throw new Error(`patient_age ${value} is below min ${min}; cannot proceed`);
        }

        if (max !== undefined && !Number.isNaN(max) && value > max) {
            throw new Error(`patient_age ${value} is above max ${max}; cannot proceed`);
        }
    }

    async fillGender(gender: string): Promise<void> {
        const escaped = gender.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const candidates = [
            this.page.getByRole('radio', { name: new RegExp(`^${escaped}$`, 'i') }),
            this.page.locator(
                `input[id*="${gender}" i], input[value="${gender}" i], input[value="${gender.charAt(0)}" i]`,
            ),
            this.page
                .locator('tr')
                .filter({ hasText: /^Gender/i })
                .locator('input[type="radio"], input[type="checkbox"]')
                .filter({ hasText: new RegExp(escaped, 'i') }),
        ];

        for (const locator of candidates) {
            const target = locator.first();
            if (!(await target.count().catch(() => 0))) {
                continue;
            }

            await target.check({ force: true });
            return;
        }

        throw new Error(`Could not find a gender control for "${gender}" on PatientForm`);
    }

    async fillMaritalStatus(married: boolean): Promise<void> {
        const control = married
            ? this.page.locator('#MarriedChecked')
            : this.page.locator('#NotMarriedChecked');
        await control.check({ force: true });
    }

    async fillPatient(data: PatientRegistrationData, options: FillPatientOptions): Promise<void> {
        await this.page.locator('#patient_name').fill(data.name);
        await this.page.locator('#parent').fill(data.parent);
        await this.fillAge(data.age, data.ageUnit);
        await this.fillGender(data.gender);
        await this.fillMaritalStatus(data.married);

        await this.page.getByRole('textbox', { name: 'Select a village...' }).click();
        await this.page.locator('div').filter({ hasText: new RegExp(`^${data.village}$`) }).click();

        await this.page.locator('#mobile').fill(data.mobile);

        if (options.fillAadhaar) {
            await this.aadhaarInput().fill(data.aadhaar);
        } else {
            await this.aadhaarInput().fill('');
        }
    }

    async save(options: { waitForPatientSearch?: boolean } = {}): Promise<void> {
        const saveControl = this.page
            .locator('table.pf-actions-table input[value="Save"]')
            .or(this.page.locator('input[type="submit"][value="Save"]'))
            .or(this.page.getByRole('button', { name: /^Save$/i }))
            .first();

        if (options.waitForPatientSearch === false) {
            await saveControl.click();
            return;
        }

        await Promise.all([
            this.page.waitForURL(/PatientSearch/i, { timeout: 20000 }),
            saveControl.click(),
        ]);
    }

    async expectSaved(): Promise<void> {
        await expect(this.page).toHaveURL(/PatientSearch/i, { timeout: 15000 });
    }

    async expectAadhaarRequiredError(): Promise<void> {
        const field = this.aadhaarInput();
        const validationMessage = await field.evaluate((el) => {
            if (el instanceof HTMLInputElement) {
                return el.validationMessage;
            }
            return '';
        });

        const pageError = this.page.getByText(/aadhaa?r/i).filter({
            hasText: /required|mandatory|enter|invalid|empty/i,
        });

        const hasPageError = await pageError.first().isVisible({ timeout: 5000 }).catch(() => false);

        expect(
            Boolean(validationMessage) || hasPageError,
            'Expected Aadhaar required validation when Save is clicked with Aadhaar empty',
        ).toBeTruthy();

        await expect(this.page).not.toHaveURL(/PatientSearch/i);
    }
}
