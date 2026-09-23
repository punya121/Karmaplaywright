import {
    test,
    expect,
    enterAge,
    fieldValidity,
    freshAadhaar,
    openBlankPrescriptionForm,
    saveAndReadRefusal,
    setGender,
    typeAadhaar,
    vitalsLocked,
    smilePace,
} from '../smile.fixture';
import { baseUrl } from '../../config/test-env';

/**
 * Regression tests for the SMILE Registration > Prescription form.
 *
 * Every case here pins a failure this form has actually produced — the ones the page
 * objects carry workarounds for, and the ones the negative sweep turned up. They are
 * separated from the negative sweep because they are not "what happens when a user does
 * something wrong": they are "this specific thing broke once, and here is the assertion
 * that catches it breaking again".
 *
 * Each carries a BUG-ID and says, in its own words, what went wrong and what the
 * assertion is guarding. Where a test pins behaviour that is itself the defect — an
 * attribute combination that does nothing, a control the user cannot see — it says so,
 * so that a fix which changes it is read as "update this test", not as a new failure.
 *
 *   npm run test:smile-regression
 */

// 1000ms per action so a run can be followed; the :fast scripts turn it off. See smilePace.
test.use(smilePace);

test.describe('SMILE Registration > Prescription — regression', () => {
    // See the note in smile-registration-negative.spec.ts: one worker, one session, but
    // no cascade — a regression that comes back should not hide the other nine.
    test.describe.configure({ mode: 'default' });
    test.setTimeout(120000);

    test.beforeEach(async ({ page, smilePage, dialogs }) => {
        void dialogs;
        await openBlankPrescriptionForm(page, smilePage);
    });

    /**
     * BUG-SMILE-001 — the vitals stayed read-only and the whole case history went in blank.
     *
     * The form unlocks the vitals from the age box's *change* handler, which fires on
     * blur and not on typing. A run that filled the age and went straight on to the
     * weight found every vitals box still readonly, wrote nothing into them, and only
     * failed much later at Save with no clue where it had gone wrong.
     * SmilePrescriptionPage.fillPatientDetails() presses Tab for exactly this reason.
     */
    test('BUG-SMILE-001: entering the age unlocks the vitals, and only on blur', {
        tag: ['@smile', '@regression'],
    }, async ({ page }) => {
        const weight = page.locator('input[name="weight"]');

        await expect(weight).toHaveAttribute('readonly', /.*/);

        // Typed but not committed: the change handler has not run, so nothing has unlocked.
        await page.locator('#patient_age').fill('30');
        expect(
            await vitalsLocked(page),
            'The vitals unlocked before the age was committed — the blur guard has moved'
        ).toBe(true);

        await page.locator('#patient_age').press('Tab');

        await expect(weight, 'Committing the age did not unlock the vitals').not.toHaveAttribute(
            'readonly',
            /.*/,
            { timeout: 10000 }
        );
        await weight.fill('62');
        await expect(weight).toHaveValue('62');
    });

    /**
     * BUG-SMILE-002 — the weight was typed into a hidden ANC/PNC box instead of the vitals.
     *
     * The page renders in quirks mode, where ids match case-blind, and the ANC and PNC
     * sections both carry a hidden id="Weight". So `#weight` matched three boxes and a
     * fill landed in whichever came first — the reading vanished from the case history
     * and turned up in a maternal section that was never meant to hold it.
     * CaseHistoryPage.recordVitals() addresses it by name for this reason.
     */
    test('BUG-SMILE-002: the vitals weight is addressed by name, not by an id that collides', {
        tag: ['@smile', '@regression'],
    }, async ({ page }) => {
        await enterAge(page, '30');

        // The collision itself: more than one box answers to the id, case-blind.
        const idMatches = await page.evaluate(
            () =>
                Array.from(document.querySelectorAll<HTMLInputElement>('input')).filter(
                    (input) => input.id.toLowerCase() === 'weight'
                ).length
        );
        expect(
            idMatches,
            'The duplicate "weight" ids are gone — recordVitals() can go back to #weight'
        ).toBeGreaterThan(1);

        // The name, though, is unique and is the visible vitals box.
        const byName = page.locator('input[name="weight"]');
        await expect(byName, 'input[name="weight"] no longer identifies one box').toHaveCount(1);
        await expect(byName).toBeVisible();

        await byName.fill('58');
        await expect(byName).toHaveValue('58');
    });

    /**
     * BUG-SMILE-003 — pressing Enter in the Comments box submitted the half-filled form.
     *
     * Comments > Prescription is a multi-select that takes no free text for a centre
     * user, so selectize does not consume Enter — it reached the form and submitted it.
     * A run that typed a comment and pressed Enter, the way it would in any other box,
     * lost the consultation it was half way through writing.
     */
    test('BUG-SMILE-003: pressing Enter in the prescription comments does not submit the form', {
        tag: ['@smile', '@regression'],
    }, async ({ page }) => {
        const comments = page.locator('#prescriptionComments + .selectize-control');
        await expect(comments, 'The prescription comments control is missing').toHaveCount(1);

        const before = page.url();
        await comments.click();
        await page.keyboard.press('Enter');
        await page.waitForTimeout(2000);

        expect(page.url(), 'Enter in the comments box navigated away').toBe(before);
        await expect(page).toHaveURL(/PrescriptionForm/i);
        await expect(page.locator('#SavePrescription')).toBeVisible();
    });

    /**
     * BUG-SMILE-004 — Save did nothing at all, and said nothing about why.
     *
     * Review After is marked required, but it is also readonly because its value comes
     * from a calendar. A readonly control is exempt from the browser's constraint
     * validation, so the required mark on it is inert: it raises no "please fill this
     * in", and the submit dies wherever the form's own script stops it, in silence.
     *
     * The assertion pins the inertness itself, because that is the thing that explains
     * every silent Save on this screen. If the field is ever fixed — the readonly
     * dropped, or the check moved into the form's own script — this test is the one to
     * update, and the message below says so.
     */
    test('BUG-SMILE-004: the required mark on the read-only Review After box is inert', {
        tag: ['@smile', '@regression'],
    }, async ({ page }) => {
        const picker = page.locator('#ReviewAfterDatePicker');

        await expect(picker).toHaveAttribute('required', /.*/);
        await expect(picker).toHaveAttribute('readonly', /.*/);
        await expect(picker).toHaveValue('');

        const validity = await fieldValidity(page, '#ReviewAfterDatePicker');
        expect(
            validity.valid,
            'Review After now reports its own emptiness — the silent-Save workaround can go'
        ).toBe(true);
    });

    /**
     * BUG-SMILE-005 — the last menstruation cycle would not stay filled.
     *
     * #lastMenstrual is a jQuery UI datepicker whose keyup handler rewrites the box, so
     * anything typed into it is wiped before it can be read back and the gynaecology
     * section went to the server empty. SmilePrescriptionPage.fillGynaecology() hands the
     * date to the picker instead — the same call the calendar makes on a click — and this
     * pins that route still working.
     */
    test('BUG-SMILE-005: a last menstruation date set through the datepicker sticks', {
        tag: ['@smile', '@regression'],
    }, async ({ page }) => {
        await setGender(page, 'Female');
        await enterAge(page, '30');
        await expect(page.locator('#gynaedetails')).toBeVisible({ timeout: 10000 });

        await page.evaluate(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const $ = (window as any).jQuery;
            const date = new Date();
            date.setDate(date.getDate() - 30);
            $('#lastMenstrual').datepicker('setDate', date).trigger('change');
        });

        await expect(
            page.locator('#lastMenstrual'),
            'The datepicker route no longer fills the last menstruation cycle'
        ).not.toHaveValue('', { timeout: 10000 });
    });

    /**
     * BUG-SMILE-006 — the comments dropdown looked empty and no comment was ever added.
     *
     * The centre's comment list is drawn by a custom selectize template that leaves off
     * the .option class every other dropdown on this form uses, so the usual
     * `.option` lookup found nothing and the step passed having picked nothing at all.
     * They are found by the data-selectable mark selectize puts on every pickable entry.
     */
    test('BUG-SMILE-006: the comments dropdown offers pickable options despite its custom template', {
        tag: ['@smile', '@regression'],
    }, async ({ page, smilePage }) => {
        const picked = await smilePage.addComments();

        expect(
            picked,
            'The comments dropdown offered nothing — its option markup has changed again'
        ).not.toBeNull();
        await expect(page.locator('#prescriptionComments + .selectize-control')).toContainText(
            (picked as string).slice(0, 15),
            { useInnerText: true }
        );
    });

    /**
     * BUG-SMILE-010 — the delivery type was never set on the PNC form.
     *
     * The gynaecology block spells it "Cesarean" and the PNC form spells it "Caesarean",
     * so a run that carried one spelling across both sections silently failed to check
     * the radio in the second. The data builder translates between them; this pins both
     * spellings still being what the form expects, which is what the translation is for.
     */
    test('BUG-SMILE-010: the gynaecology and PNC sections still spell caesarean differently', {
        tag: ['@smile', '@regression'],
    }, async ({ page }) => {
        const values = await page.evaluate(() => {
            const read = (name: string) =>
                Array.from(
                    document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)
                ).map((input) => input.value);

            return {
                gynae: read('lastDeliveryType'),
                pnc: read('TypeOfDelivery'),
            };
        });

        expect(
            values.gynae,
            'The gynaecology block no longer offers "Cesarean" — the translation may be stale'
        ).toContain('Cesarean');
        expect(
            values.pnc,
            'The PNC form no longer offers "Caesarean" — the translation may be stale'
        ).toContain('Caesarean');
    });

    /**
     * BUG-SMILE-011 — the Aadhaar box sat on "Checking for duplicate Aadhaar..." forever.
     *
     * The duplicate check runs on blur, and a run that moved on while it was still in
     * flight read the "Checking..." text as the field's verdict and either failed a clean
     * Aadhaar or carried on with an unverified one. The check has to settle, and a clean
     * number has to end with no complaint showing.
     */
    test('BUG-SMILE-011: the duplicate-Aadhaar check settles and clears for a fresh number', {
        tag: ['@smile', '@regression'],
    }, async ({ page }) => {
        await typeAadhaar(page, freshAadhaar());

        const error = page.locator('#aadhaar_error');

        await expect(
            error.filter({ visible: true, hasText: /checking/i }),
            'The duplicate check never settled'
        ).toHaveCount(0);
        await expect(
            error.filter({ visible: true, hasText: /already exists|invalid/i }),
            'A brand new Aadhaar was refused'
        ).toHaveCount(0);
    });

    /**
     * BUG-SMILE-012 — a selectize field could not be found once it had been filled.
     *
     * Picking a value drops the placeholder, and the placeholder is the field's whole
     * accessible name, so anything looked up by name after the pick resolved to nothing
     * and the next step filled some other control. The village is the one this bit on.
     * Anything read back after a pick has to be anchored on the control, not the name.
     */
    test('BUG-SMILE-012: the village field loses its accessible name once a village is picked', {
        tag: ['@smile', '@regression'],
    }, async ({ page, smilePage }) => {
        const byName = page.getByRole('textbox', { name: 'Select a village...' });
        await expect(byName, 'The village field no longer starts out named').toBeVisible({
            timeout: 15000,
        });

        const village = await smilePage.selectVillage();
        expect(village).not.toBeNull();

        // Gone as a name — which is why nothing downstream may look it up that way.
        await expect(
            byName,
            'The village kept its accessible name — the anchor-on-the-control rule can be relaxed'
        ).toHaveCount(0);

        // Still findable through the control, which is the rule that replaced it.
        await expect(
            page.locator('#patient_village + .selectize-control .item')
        ).toContainText(village as string, { useInnerText: true });
    });

    /**
     * BUG-SMILE-013 — the previous patient's details came back on the Back button.
     *
     * Found by the negative sweep. A form that is filled in and then navigated away from
     * is restored by the browser's back/forward cache with every box still populated, so
     * on a shared centre terminal the next user pressing Back is shown the last patient's
     * name, parent, mobile and age. Nothing was saved — the record is not in the system —
     * but the details are on screen, which is a disclosure all the same.
     *
     * A reload clears it; only Back restores it. The assertion pins the restore, because
     * that is the defect: if the form is ever given an autocomplete="off"/no-store fix,
     * this is the test to update.
     */
    test('BUG-SMILE-013: the back button restores an abandoned patient\'s details', {
        tag: ['@smile', '@regression'],
    }, async ({ page }) => {
        const name = `Regression Back ${Date.now().toString().slice(-5)}`;

        await page.locator('#patient_name').fill(name);
        await page.locator('#mobile').fill('9876543210');
        await enterAge(page, '41');

        await page.goto(`${baseUrl.replace(/\/$/, '')}/Home`);
        await page.goBack();
        await expect(page.locator('#patient_name')).toBeVisible({ timeout: 20000 });

        await expect(
            page.locator('#patient_name'),
            'The back button no longer restores an abandoned patient — BUG-SMILE-013 is fixed'
        ).toHaveValue(name);
        await expect(page.locator('#mobile')).toHaveValue('9876543210');

        // A reload is what actually clears it, which is the workaround to tell centres.
        await page.reload();
        await expect(page.locator('#patient_name'), 'A reload left the details behind').toHaveValue(
            ''
        );
    });

    /**
     * BUG-SMILE-009 — "Save does nothing", the most-reported fault on this screen.
     *
     * Three of the form's required controls — the symptoms list, the provisional
     * diagnosis and the disease classification — sit inside collapsed sections. The
     * browser blocks the submit on them, but it cannot scroll to or focus a hidden
     * control, so its "please select an item" bubble is never drawn. The user sees a
     * button that does nothing.
     *
     * The assertion pins that shape: a save refused on a control the user cannot see.
     * If the sections are ever opened on a failed submit, this is the test to update.
     */
    test('BUG-SMILE-009: a save blocked by a hidden required control gives the user nothing to see', {
        tag: ['@smile', '@regression'],
    }, async ({ page, dialogs }) => {
        await page.locator('#patient_name').fill('Regression Silent Save');
        await page.locator('#parent').fill('Regression Parent');
        await setGender(page, 'Male');
        await enterAge(page, '30');
        await page.locator('#mobile').fill('9876543210');
        await typeAadhaar(page, freshAadhaar());

        const refusal = await saveAndReadRefusal(page, dialogs);

        expect(refusal.outcome, 'The save was no longer refused by the browser').toBe('invalid');
        expect(
            ['symptoms_list[]', 'patient_diagnosis', 'classification'],
            `The save was refused on ${refusal.field}, which is not one of the known hidden three`
        ).toContain(refusal.field);

        // The control the browser is refusing on cannot be shown to the user.
        const offenderVisible = await page.evaluate(() => {
            const invalid = document.querySelector<HTMLElement>(
                'input:invalid, select:invalid, textarea:invalid'
            );
            return invalid ? invalid.offsetParent !== null : null;
        });
        expect(
            offenderVisible,
            'The blocking control is now visible — the silent-Save report can be closed'
        ).toBe(false);

        await expect(page).toHaveURL(/PrescriptionForm/i);
    });
});
