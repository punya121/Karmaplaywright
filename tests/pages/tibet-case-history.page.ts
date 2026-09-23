import { expect, type Locator, type Page } from '@playwright/test';
import type { TibetCaseHistoryData } from '../data/tibet-patients';
import { moduleCase } from '../support/module-case';
import { CaseHistoryPage } from './case-history.page';
import { isVisibleWithin, pickRandomOption } from './selectize';

export type TibetCaseHistorySummary = {
    nursingStaff: string;
    symptoms: string[];
    durations: string[];
    tests: string[];
    severity: string[];
    comment: string | null;
};

/**
 * /TibetPrescriptionHistoryForm - the case history the Tibet centre raises for a patient
 * already on file, reached with "Add Case History" on their record.
 *
 * Most of it is the markup every other centre's case history is built from - the same
 * #weight vitals block, the same #symptomsTable, the same point-of-care grid, the same
 * Save that is really name="Next" - so those sections are filled by CaseHistoryPage
 * rather than a second copy of the same code. What differs is small and all of it is
 * here:
 *
 *   - Attendance is the assisting nurse alone. There is no transport mode on this form,
 *     so CaseHistoryPage.recordAttendance() cannot be used as it stands.
 *   - A severity indicator the other centres do not have: injection, drip, test and high
 *     priority, four required Yes/No answers that the browser blocks the submit over.
 *   - Comments is a selectize the nurse picks canned phrases from, not a text box.
 *
 * Save then asks "Please check the vitals/ symptoms/ POC Test Results. Do you want to
 * save the abnormal vitals/ symptoms/ test results?" whenever anything on the form is
 * outside its normal band. That is a confirm(), and Playwright dismisses dialogs by
 * default - which answers it with Cancel and silently drops the save. captureDialogs()
 * is what answers it with OK, so it is called before the form is filled.
 */
export class TibetCaseHistoryPage {
    readonly caseHistory: CaseHistoryPage;

    constructor(private readonly page: Page) {
        this.caseHistory = new CaseHistoryPage(page);
    }

    /**
     * Every confirm() the form raised and this run answered with OK, newest last.
     * "Please check the vitals/ symptoms/ POC Test Results. Do you want to save the
     * abnormal vitals/ symptoms/ test results?" is the one that matters, and it only
     * comes up when something on the form is outside its normal band - so a run reports
     * what it was actually asked rather than assuming.
     */
    readonly confirmations: string[] = [];

    /**
     * See CaseHistoryPage.captureDialogs(): alerts are recorded as blockers, confirms
     * answered OK. This listener only reads the confirms on their way past - the one
     * CaseHistoryPage registers is what answers them.
     */
    captureDialogs(): string[] {
        this.page.on('dialog', (dialog) => {
            if (dialog.type() === 'confirm') {
                this.confirmations.push(dialog.message().replace(/\s+/g, ' ').trim());
            }
        });

        return this.caseHistory.captureDialogs();
    }

    async expectLoaded(): Promise<void> {
        await expect(this.page, 'The Tibet case history did not open').toHaveURL(
            /TibetPrescriptionHistoryForm/i,
            { timeout: 20000 }
        );
        await this.caseHistory.expectLoaded();
    }

    /**
     * Who assisted. The Tibet form asks for the nurse and nothing else - no transport
     * mode - and the field is required, so the save is refused without it.
     */
    async recordAssistingStaff(): Promise<string> {
        const control = this.page.getByRole('textbox', { name: '--Select a Nursing Staff--' });
        const nursingStaff = await pickRandomOption(this.page, control);

        expect(
            nursingStaff,
            'Assisting Staff offered no nursing staff to pick, and the form will not save without one'
        ).not.toBeNull();

        await expect(
            this.page.getByRole('row').filter({ hasText: 'Assisting Staff' }).last()
        ).toContainText(nursingStaff as string, { useInnerText: true });

        return nursingStaff as string;
    }

    /**
     * The severity indicator the nursing staff give the doctor as a steer. All four are
     * required: an unanswered one is left to the browser, which blocks the submit with
     * its own "Please select one of these options" bubble and no navigation.
     */
    async recordSeverityIndicators(caseHistory: TibetCaseHistoryData): Promise<string[]> {
        const answers: { name: string; label: string; yes: boolean }[] = [
            { name: 'injection', label: 'Injection required', yes: caseHistory.injectionRequired },
            { name: 'drip', label: 'Drip required', yes: caseHistory.dripRequired },
            { name: 'test', label: 'Test required', yes: caseHistory.testRequired },
            { name: 'highPriority', label: 'High Priority', yes: caseHistory.highPriority },
        ];

        const recorded: string[] = [];

        for (const { name, label, yes } of answers) {
            // Yes is value 1, No is value 2 - the ids are injectiony / injectionn and so
            // on, but the value is what the form posts and what does not change between
            // builds.
            const radio = this.page.locator(`input[name="${name}"][value="${yes ? '1' : '2'}"]`);
            await this.checkRadio(radio);
            recorded.push(`${label}: ${yes ? 'Yes' : 'No'}`);
        }

        return recorded;
    }

    /**
     * The nurse's comment. It is a multi-select of canned phrases rather than free text,
     * and it is not required, so a centre whose list is empty is not a failure.
     */
    async addComment(): Promise<string | null> {
        const control = this.page
            .getByRole('group', { name: 'Comments' })
            .locator('.selectize-control')
            .first();

        if (!(await isVisibleWithin(control, 3000))) {
            return null;
        }

        return pickRandomOption(this.page, control);
    }

    /** Checks a radio and keeps at it until the page lets it stay checked. */
    private async checkRadio(radio: Locator): Promise<void> {
        await expect(async () => {
            await radio.check({ force: true, timeout: 2000 });
            await expect(radio).toBeChecked({ timeout: 1000 });
        }).toPass({ timeout: 15000 });
    }

    /**
     * Fills the whole form, top to bottom, each section as its own module case so the
     * report carries a row per section rather than one row saying a case history was
     * filled. See tests/support/module-case.ts.
     */
    async fill(caseHistory: TibetCaseHistoryData): Promise<TibetCaseHistorySummary> {
        const form = 'Tibet Case History';

        const nursingStaff = await moduleCase(form, 'Record the assisting staff', () =>
            this.recordAssistingStaff()
        );

        await moduleCase(form, 'Record the vitals and allergies', () =>
            this.caseHistory.recordVitals(caseHistory)
        );

        const { symptoms, durations } = await moduleCase(form, 'Add the symptoms', () =>
            this.caseHistory.addSymptoms(caseHistory.symptomCount)
        );

        const severity = await moduleCase(form, 'Answer the severity indicator', () =>
            this.recordSeverityIndicators(caseHistory)
        );

        const tests = await moduleCase(form, 'Record the point-of-care tests', () =>
            this.caseHistory.addTests(
                caseHistory.testCount,
                caseHistory.minTestValue,
                caseHistory.maxTestValue
            )
        );

        const comment = await moduleCase(form, "Add the nurse's comment", () => this.addComment());

        return { nursingStaff, symptoms, durations, tests, severity, comment };
    }

    /**
     * Saves, answering the abnormal-readings confirm with OK, and does not come back
     * until the form has been left.
     *
     * Save is the form's submit (name="Next"), so a successful save loads the next page
     * and anything else means nothing was written - which is what CaseHistoryPage reports
     * on, with the app's own alert or the browser's own validation message attached.
     */
    async saveAndExpectNextPage(dialogMessages: string[] = []): Promise<void> {
        await this.caseHistory.saveAndExpectNextPage(dialogMessages);
    }
}
