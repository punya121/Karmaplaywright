import { expect, type Locator, type Page } from '@playwright/test';
import { baseUrl } from '../config/test-env';
import type { TibetPatientRegistrationData } from '../data/tibet-patients';

export type FillTibetPatientOptions = {
    fillAadhaar: boolean;
};

export class TibetRegistrationPage {
    constructor(private readonly page: Page) {}

    aadhaarInput(): Locator {
        return this.page.locator('#patient_aadhaar');
    }

    async openFromHome(): Promise<void> {
        await expect(this.page.getByRole('link', { name: 'Home' })).toBeVisible();

        const patientFormLink = this.page.locator('#main-content a[href*="TibetPatientForm"]').first();
        if (await patientFormLink.isVisible().catch(() => false)) {
            await patientFormLink.click();
        } else {
            await this.page.goto(`${baseUrl.replace(/\/$/, '')}/TibetPatientForm`);
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

        const star = this.page.locator('#addharSpanstar');
        const style = await star.getAttribute('style').catch(() => null);
        return style !== null && !/display:\s*none/i.test(style);
    }

    private async fillAge(age: string, ageUnit: TibetPatientRegistrationData['ageUnit']): Promise<void> {
        await this.page.locator('#age_years').check({ force: true });

        const unitControl =
            ageUnit === 'Months' ? this.page.locator('#age_unit_month') : this.page.locator('#age_unit_years');
        await unitControl.check({ force: true });

        await this.page.locator('#patient_age').fill(age);
    }

    private async fillGender(gender: TibetPatientRegistrationData['gender']): Promise<void> {
        await this.page.locator(`input[name="sex"][value="${gender}"]`).check({ force: true });
    }

    private async fillMaritalStatus(maritalStatus: TibetPatientRegistrationData['maritalStatus']): Promise<void> {
        const valueMap: Record<TibetPatientRegistrationData['maritalStatus'], string> = {
            Married: '1',
            NotMarried: '0',
            Others: '2',
        };

        await this.page
            .locator(`input[name="isMarried"][value="${valueMap[maritalStatus]}"]`)
            .check({ force: true });
    }

    private async fillOccupation(occupation: string): Promise<void> {
        await this.page.locator('#occupation').selectOption({ label: occupation });
    }

    private async fillNationality(nationality: string): Promise<void> {
        await this.page.locator('#nationalitySelect').selectOption({ label: nationality }).catch(async () => {
            await this.page.locator('#nationalitySelect').selectOption('Others');
            await this.page.locator('#nationality').fill(nationality);
        });
    }

    async fillPatient(data: TibetPatientRegistrationData, options: FillTibetPatientOptions): Promise<void> {
        await this.page.locator('#patient_name').fill(data.name);
        await this.page.locator('#parent').fill(data.parent);
        await this.fillAge(data.age, data.ageUnit);
        await this.fillGender(data.gender);
        await this.fillMaritalStatus(data.maritalStatus);
        await this.fillOccupation(data.occupation);
        await this.page.locator('#landmark').fill(data.landmark);
        await this.fillNationality(data.nationality);
        await this.page.locator('#mobile').fill(data.mobile);

        if (options.fillAadhaar) {
            await this.aadhaarInput().fill(data.aadhaar);
        } else {
            await this.aadhaarInput().fill('');
        }
    }

    async save(options: { waitForPatientSearch?: boolean } = {}): Promise<void> {
        const saveControl = this.page.locator('input[name="save"][type="submit"]').first();

        if (options.waitForPatientSearch === false) {
            await saveControl.click();
            return;
        }

        await saveControl.click();

        const confirmButton = this.page.locator('#confirmBox .buttonyes, input.buttonyes').first();
        if (await confirmButton.isVisible({ timeout: 5000 }).catch(() => false)) {
            await Promise.all([
                this.page.waitForURL(/PatientSearch/i, { timeout: 20000 }),
                confirmButton.click(),
            ]);
            return;
        }

        await this.page.waitForURL(/PatientSearch/i, { timeout: 20000 });
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
