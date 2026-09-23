import { expect, type Locator, type Page } from '@playwright/test';
import { baseUrl } from '../config/test-env';
import type { TibetPatientRegistrationData } from '../data/tibet-patients';
import { isVisibleWithin, pickRandomOption } from './selectize';

export type FillTibetPatientOptions = {
    fillAadhaar: boolean;
};

/**
 * /TibetPatientForm - the Tibetan Telemedicine Services registration form. It is this
 * centre's own screen rather than the shared /PatientForm: it asks for a Green Book and
 * a Destitute (Nyamthak) number, its occupation list is a selectize, and it saves to
 * /TibetPatientSearch.
 *
 * Its submit buttons go to different places. "Save" writes the patient and lands on the
 * search list; "Add Case History" opens that patient's case history
 * (/TibetPrescriptionHistoryForm) - but only for a patient who has already been saved.
 * Pressed on an unsaved form it does nothing but raise the app's own red banner, "Save
 * the patient details before adding a prescription", which is why a run saves first and
 * comes back to the record by id.
 */
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

        // The form binds its own handlers on document ready - the age rows stay hidden
        // until the Age Input Type radio is clicked - and a radio checked before that
        // binding runs is reset under the run. See checkRadio().
        await this.page.waitForLoadState('load');
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

    /**
     * Checks a radio and keeps at it until the page lets it stay checked.
     *
     * One check() is not enough on this form. The radios carry the page's own click
     * handlers - the Age Input Type pair shows and hides whole rows - and a click that
     * lands while those handlers are still being bound leaves the radio unchecked with
     * nothing on screen to say so. Playwright reports it as "Clicking the checkbox did
     * not change its state", which is true and says nothing about why.
     */
    private async checkRadio(radio: Locator): Promise<void> {
        await expect(async () => {
            await radio.check({ force: true, timeout: 2000 });
            await expect(radio).toBeChecked({ timeout: 1000 });
        }).toPass({ timeout: 15000 });
    }

    /**
     * Age is asked for either as a date of birth or as a number of years, and the row
     * holding the number is hidden until "Age in Years" is picked - so the input type
     * comes first, then the unit, then the figure itself.
     */
    private async fillAge(
        age: string,
        ageUnit: TibetPatientRegistrationData['ageUnit']
    ): Promise<void> {
        await this.checkRadio(this.page.locator('#age_years'));

        const unitControl =
            ageUnit === 'Months'
                ? this.page.locator('#age_unit_month')
                : this.page.locator('#age_unit_years');
        await this.checkRadio(unitControl);

        await this.page.locator('#patient_age').fill(age);
    }

    private async fillGender(gender: TibetPatientRegistrationData['gender']): Promise<void> {
        await this.checkRadio(this.page.locator(`input[name="sex"][value="${gender}"]`));
    }

    private async fillMaritalStatus(
        maritalStatus: TibetPatientRegistrationData['maritalStatus']
    ): Promise<void> {
        const valueMap: Record<TibetPatientRegistrationData['maritalStatus'], string> = {
            Married: '1',
            NotMarried: '0',
            Others: '2',
        };

        await this.checkRadio(
            this.page.locator(`input[name="isMarried"][value="${valueMap[maritalStatus]}"]`)
        );
    }

    /**
     * Occupation is a selectize on this centre's build - the <select> behind it is
     * display:none, so selectOption() has nothing to click. The wanted occupation is
     * taken where the centre offers it and any other where it does not, so a run is not
     * tied to a list that only exists in one environment.
     */
    private async fillOccupation(occupation: string): Promise<string> {
        const control = this.page.getByRole('textbox', { name: '--Select an Occupation--' });

        if (await isVisibleWithin(control, 3000)) {
            const picked =
                (await pickRandomOption(this.page, control, {
                    filter: new RegExp(`^\\s*${occupation}\\s*$`, 'i'),
                })) ?? (await pickRandomOption(this.page, control));

            expect(picked, 'The occupation list offered nothing to pick').not.toBeNull();
            return picked as string;
        }

        // A build that renders it as a plain <select>.
        await this.page.locator('#occupation').selectOption({ label: occupation });
        return occupation;
    }

    private async fillNationality(nationality: string): Promise<void> {
        await this.page
            .locator('#nationalitySelect')
            .selectOption({ label: nationality })
            .catch(async () => {
                await this.page.locator('#nationalitySelect').selectOption('Others');
                await this.page.locator('#nationality').fill(nationality);
            });
    }

    async fillPatient(
        data: TibetPatientRegistrationData,
        options: FillTibetPatientOptions
    ): Promise<void> {
        await this.page.locator('#patient_name').fill(data.name);
        await this.page.locator('#parent').fill(data.parent);
        await this.fillAge(data.age, data.ageUnit);
        await this.fillGender(data.gender);
        await this.fillMaritalStatus(data.maritalStatus);
        await this.page.locator('#gbn').fill(data.greenBookNumber);
        await this.page.locator('#nyamthak').fill(data.nyamthakNumber);
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

    /**
     * Presses "Add Case History" on a saved patient's record and does not come back
     * until /TibetPrescriptionHistoryForm is genuinely open.
     *
     * The button is the registration form's own submit, so a record the browser will not
     * validate - or one that was never saved - leaves the run on /TibetPatientForm with
     * only the app's red banner to say why. That banner is read back here rather than
     * left to surface minutes later as a timeout on a vitals box.
     */
    async openCaseHistory(): Promise<void> {
        const page = this.page;

        await page.getByRole('button', { name: 'Add Case History' }).click();

        const opened = await page
            .waitForURL(/TibetPrescriptionHistoryForm/i, { timeout: 30000 })
            .then(() => true)
            .catch(() => false);

        if (opened) {
            await page.waitForLoadState('load');
            return;
        }

        const complaint = await page.evaluate(() => {
            const banner = Array.from(
                document.querySelectorAll<HTMLElement>('.snackbar, #snackbar, [role="alert"]')
            ).find((element) => element.offsetParent !== null && element.innerText.trim());
            if (banner) {
                return banner.innerText.replace(/\s+/g, ' ').trim();
            }

            const invalid = document.querySelector<
                HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
            >('input:invalid, select:invalid, textarea:invalid');
            return invalid
                ? `${invalid.name || invalid.id || invalid.tagName} is invalid: ${invalid.validationMessage}`
                : null;
        });

        throw new Error(
            `"Add Case History" did not open the case history - the run is still on ${page.url()}. ` +
                (complaint ?? 'The page gave no reason for refusing.')
        );
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
