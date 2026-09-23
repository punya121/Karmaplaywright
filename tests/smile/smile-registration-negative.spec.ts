import {
    test,
    expect,
    checkRadio,
    enterAge,
    fieldValidity,
    fillPatientBlock,
    freshAadhaar,
    openBlankPrescriptionForm,
    saveAndReadRefusal,
    setGender,
    typeAadhaar,
    vitalsLocked,
    expectStillOnForm,
    prescriptionFormUrl,
    smilePace,
} from './smile.fixture';

/**
 * Negative cases for the SMILE centre's Registration > Prescription form — the screen
 * that registers a patient and writes their whole prescription in one go, covered
 * happily by smile-registration.spec.ts.
 *
 * What these are for: the happy path proves the form takes a good patient. These prove
 * it turns a bad one away, and says why. Each case puts exactly one thing wrong, leaves
 * everything else valid, and asserts the form's own refusal — the field the browser
 * named, the message it gave, or the red text under the box — rather than settling for
 * "the page did not crash".
 *
 * Three things about the form shape every test below, all of them verified against the
 * live screen rather than assumed:
 *
 *   - Age gates the vitals. #patient_age is min=5 max=110, and the form's change handler
 *     clears anything outside that and leaves the vitals readonly. So "the vitals are
 *     still locked" is how the form says it refused an age.
 *   - Most refusals are the browser's own constraint validation, not the app's. The
 *     controls it blocks on are in DOM order patient_name, patient_aadhaar_display,
 *     symptoms_list[], patient_diagnosis, classification — and the last three are
 *     hidden, so the browser cannot show the user where the problem is. That is the
 *     shape of nearly every "Save does nothing" report on this screen.
 *   - The form talks through alert(), and Playwright dismisses dialogs by default. The
 *     `dialogs` fixture puts a handler in before the form opens, so what it says is read
 *     rather than swallowed.
 *
 * Every test starts from a blank form and a session the worker signed in once, so they
 * are independent of one another and of the happy-path specs.
 *
 *   npm run test:smile-negative
 */

// 1000ms per action so a run can be followed; the :fast scripts turn it off. See smilePace.
test.use(smilePace);

test.describe('SMILE Registration > Prescription — negative cases', () => {
    // 'default', not 'parallel' and not 'serial'. Parallel would put these across several
    // workers, each signing in again, and the account's session cap would start refusing
    // logins half way down the file. Serial would be worse the other way: one failure
    // would skip every test after it, and these cases are independent — each opens its
    // own blank form and asserts one refusal. 'default' runs them in order in one worker,
    // on one session, and a failure costs only that test.
    test.describe.configure({ mode: 'default' });
    test.setTimeout(120000);

    test.beforeEach(async ({ page, smilePage, dialogs }) => {
        // Touching `dialogs` is what installs the handler, before anything can pop up.
        void dialogs;
        await openBlankPrescriptionForm(page, smilePage);
    });

    /* ------------------------------------------------------------------ *
     * 1. Required-field validation
     * ------------------------------------------------------------------ */

    test('refuses a save on an untouched form and names the patient name as the missing field', {
        tag: ['@smile', '@negative', '@validation'],
    }, async ({ page, dialogs }) => {
        const refusal = await saveAndReadRefusal(page, dialogs);

        expect(refusal.outcome, 'An empty form was not refused').toBe('invalid');
        expect(refusal.field).toBe('patient_name');
        expect(refusal.message).toMatch(/fill out this field/i);
        await expectStillOnForm(page);
    });

    test('refuses a save when the patient block is filled but Aadhaar is left blank', {
        tag: ['@smile', '@negative', '@validation'],
    }, async ({ page, dialogs }) => {
        await fillPatientBlock(page, { aadhaar: null });

        const refusal = await saveAndReadRefusal(page, dialogs);

        expect(refusal.outcome).toBe('invalid');
        // The masked box posts under its _display name, which is the one the browser names.
        expect(refusal.field).toBe('patient_aadhaar_display');
        expect(refusal.message).toMatch(/fill out this field/i);
        await expectStillOnForm(page);
    });

    test('refuses a save when no symptom has been recorded', {
        tag: ['@smile', '@negative', '@validation'],
    }, async ({ page, dialogs }) => {
        await fillPatientBlock(page, { aadhaar: freshAadhaar() });

        const refusal = await saveAndReadRefusal(page, dialogs);

        expect(refusal.outcome).toBe('invalid');
        expect(refusal.field).toBe('symptoms_list[]');
        expect(refusal.message).toMatch(/select an item in the list/i);
        await expectStillOnForm(page);
    });

    test('refuses a save when the provisional diagnosis is left blank', {
        tag: ['@smile', '@negative', '@validation'],
    }, async ({ page, smilePage, dialogs }) => {
        await fillPatientBlock(page, { aadhaar: freshAadhaar() });
        await smilePage.caseHistory.addSymptoms(1);

        const refusal = await saveAndReadRefusal(page, dialogs);

        expect(refusal.outcome).toBe('invalid');
        expect(refusal.field).toBe('patient_diagnosis');
        await expectStillOnForm(page);
    });

    test('refuses a save when an extra diagnosis row is added and left empty', {
        tag: ['@smile', '@negative', '@validation', '@ui-state'],
    }, async ({ page, dialogs }) => {
        const rows = page.locator('#diagnosisTable select[name="provisionalDiagnosis[]"]');
        await expect(rows).toHaveCount(0);

        await page.locator('#addAnotherDiagnosis').click();
        await expect(rows, 'Add Another Diagnosis did not add a row').toHaveCount(1);

        // The added row is required the moment it exists, so an empty one blocks the save.
        await expect(rows.first()).toHaveAttribute('required', /.*/);

        const refusal = await saveAndReadRefusal(page, dialogs);
        expect(refusal.outcome).toBe('invalid');
        await expectStillOnForm(page);
    });

    /* ------------------------------------------------------------------ *
     * 2. Invalid input
     * ------------------------------------------------------------------ */

    test('rejects letters typed into the mobile number', {
        tag: ['@smile', '@negative', '@invalid-input'],
    }, async ({ page }) => {
        const mobile = page.locator('#mobile');
        await mobile.fill('');
        await mobile.pressSequentially('abcdefghij', { delay: 10 });

        // The box carries onkeypress="return checkEntry(event)", which swallows non-digits.
        await expect(mobile, 'Letters were accepted into the mobile number').toHaveValue('');
    });

    test('refuses a mobile number that does not start with 6-9', {
        tag: ['@smile', '@negative', '@invalid-input'],
    }, async ({ page, dialogs }) => {
        await fillPatientBlock(page, { mobile: '5123456789', aadhaar: null });

        const validity = await fieldValidity(page, '#mobile');
        expect(validity.valid, 'A mobile starting with 5 was accepted').toBe(false);
        expect(validity.message).toMatch(/match the requested format/i);

        const refusal = await saveAndReadRefusal(page, dialogs);
        expect(refusal.outcome).toBe('invalid');
        await expectStillOnForm(page);
    });

    test('refuses a mobile number shorter than ten digits', {
        tag: ['@smile', '@negative', '@invalid-input'],
    }, async ({ page }) => {
        const mobile = page.locator('#mobile');
        await mobile.fill('');
        await mobile.pressSequentially('98765', { delay: 10 });
        await mobile.blur();

        const validity = await fieldValidity(page, '#mobile');
        expect(validity.valid, 'A five-digit mobile number was accepted').toBe(false);
        expect(validity.message).toMatch(/match the requested format/i);
    });

    test('rejects letters typed into the Aadhaar number', {
        tag: ['@smile', '@negative', '@invalid-input'],
    }, async ({ page }) => {
        const aadhaar = page.locator('#patient_aadhaar');
        await aadhaar.click();
        await aadhaar.pressSequentially('abcdefghijkl', { delay: 15 });
        await aadhaar.blur();

        await expect(aadhaar, 'Letters were accepted into the Aadhaar box').toHaveValue('');
    });

    test('shows "Invalid Aadhaar Number" for an Aadhaar shorter than twelve digits', {
        tag: ['@smile', '@negative', '@invalid-input'],
    }, async ({ page }) => {
        const aadhaar = page.locator('#patient_aadhaar');
        await aadhaar.click();
        await aadhaar.pressSequentially('1234', { delay: 20 });
        await aadhaar.blur();

        const error = page.locator('#aadhaar_error');
        await expect(error, 'A four-digit Aadhaar raised no error').toBeVisible({ timeout: 10000 });
        await expect(error).toContainText(/invalid aadhaar number/i);
    });

    /* ------------------------------------------------------------------ *
     * 3. Empty / null input
     * ------------------------------------------------------------------ */

    test('keeps the vitals locked while the age is blank', {
        tag: ['@smile', '@negative', '@empty-input'],
    }, async ({ page }) => {
        await expect(page.locator('#patient_age')).toHaveValue('');

        expect(await vitalsLocked(page), 'The vitals were editable before an age was entered').toBe(
            true
        );
        await expect(page.locator('input[name="weight"]')).toHaveAttribute('readonly', /.*/);
    });

    test('re-locks the vitals when a valid age is cleared again', {
        tag: ['@smile', '@negative', '@empty-input', '@ui-state'],
    }, async ({ page }) => {
        await enterAge(page, '30');
        expect(await vitalsLocked(page), 'A valid age did not unlock the vitals').toBe(false);

        await enterAge(page, '');
        expect(await vitalsLocked(page), 'Clearing the age left the vitals editable').toBe(true);
    });

    /* ------------------------------------------------------------------ *
     * 4. Boundary values
     * ------------------------------------------------------------------ */

    // #patient_age is min=5 max=110. The form clears anything outside that on change and
    // leaves the vitals locked, so both ends are checked the same way.
    for (const { age, accepted } of [
        { age: '4', accepted: false },
        { age: '5', accepted: true },
        { age: '110', accepted: true },
        { age: '111', accepted: false },
        { age: '0', accepted: false },
    ]) {
        test(`${accepted ? 'accepts' : 'refuses'} an age of ${age} at the ${
            accepted ? 'edge of' : 'edge just outside'
        } the allowed 5-110 range`, {
            tag: ['@smile', '@negative', '@boundary'],
        }, async ({ page }) => {
            await enterAge(page, age);

            const field = page.locator('#patient_age');

            if (accepted) {
                await expect(field, `An age of ${age} was cleared`).toHaveValue(age);
                expect(await vitalsLocked(page), `An age of ${age} did not unlock the vitals`).toBe(
                    false
                );
            } else {
                // Out of range is not flagged — it is wiped, which is why the vitals stay shut.
                await expect(field, `An out-of-range age of ${age} was kept`).toHaveValue('');
                expect(await vitalsLocked(page), `An age of ${age} unlocked the vitals`).toBe(true);
            }
        });
    }

    test('caps the mobile number at ten digits however many are typed', {
        tag: ['@smile', '@negative', '@boundary'],
    }, async ({ page }) => {
        const mobile = page.locator('#mobile');
        await expect(mobile).toHaveAttribute('maxlength', '10');

        await mobile.fill('');
        await mobile.pressSequentially('98765432109999', { delay: 5 });

        await expect(mobile, 'More than ten digits were kept').toHaveValue('9876543210');
    });

    test('caps the masked Aadhaar box at its fourteen displayed characters', {
        tag: ['@smile', '@negative', '@boundary'],
    }, async ({ page }) => {
        const aadhaar = page.locator('#patient_aadhaar');
        await expect(aadhaar).toHaveAttribute('maxlength', '14');

        await aadhaar.click();
        await aadhaar.pressSequentially('1234567890123456', { delay: 15 });

        const shown = await aadhaar.inputValue();
        expect(shown.length, `The Aadhaar box kept ${shown.length} characters`).toBeLessThanOrEqual(
            14
        );
    });

    // The gynaecology block belongs to a woman of 14-49 and to nobody else.
    for (const { age, shown } of [
        { age: '13', shown: false },
        { age: '14', shown: true },
        { age: '49', shown: true },
        { age: '50', shown: false },
    ]) {
        test(`${
            shown ? 'opens' : 'withholds'
        } the gynaecology section for a woman aged ${age}`, {
            tag: ['@smile', '@negative', '@boundary', '@ui-state'],
        }, async ({ page }) => {
            await setGender(page, 'Female');
            await enterAge(page, age);

            const gynae = page.locator('#gynaedetails');

            if (shown) {
                await expect(gynae, `No gynaecology section at ${age}`).toBeVisible({
                    timeout: 10000,
                });
            } else {
                await expect(gynae, `The gynaecology section opened at ${age}`).toBeHidden({
                    timeout: 10000,
                });
            }
        });
    }

    /* ------------------------------------------------------------------ *
     * 5. Incorrect data types
     * ------------------------------------------------------------------ */

    test('rejects letters typed into the age', {
        tag: ['@smile', '@negative', '@data-type'],
    }, async ({ page }) => {
        const age = page.locator('#patient_age');
        await expect(age).toHaveAttribute('type', 'number');

        await age.pressSequentially('abc', { delay: 10 });
        await age.press('Tab');

        await expect(age, 'Letters were accepted into a numeric age').toHaveValue('');
        expect(await vitalsLocked(page), 'A non-numeric age unlocked the vitals').toBe(true);
    });

    test('rejects letters typed into the weight', {
        tag: ['@smile', '@negative', '@data-type'],
    }, async ({ page }) => {
        await enterAge(page, '30');
        expect(await vitalsLocked(page)).toBe(false);

        const weight = page.locator('input[name="weight"]');
        await weight.pressSequentially('abc', { delay: 10 });
        await weight.blur();

        await expect(weight, 'Letters were accepted into the weight').toHaveValue('');
    });

    /*
     * The vitals carry their own min/max (temperature 95-105, SpO2 85-100, respiratory
     * rate 0-120), and a reading outside the band is refused in one of two ways: the
     * browser flags it, or the form's own handler wipes it the way it wipes a bad age.
     * Which of the two wins is a race, so both count as a refusal — what must never
     * happen is the box quietly keeping an impossible reading. An in-range value is
     * entered afterwards so the test cannot pass on a field that rejects everything.
     */
    for (const { field, selector, bad, good } of [
        { field: 'temperature', selector: '#temperature', bad: '150', good: '98' },
        { field: 'temperature', selector: '#temperature', bad: '50', good: '98' },
        { field: 'SpO2', selector: 'input[name="spo2"]', bad: '40', good: '97' },
        { field: 'respiratory rate', selector: '#respiratory_rate', bad: '500', good: '18' },
    ]) {
        test(`refuses an out-of-range ${field} reading of ${bad}`, {
            tag: ['@smile', '@negative', '@boundary', '@data-type'],
        }, async ({ page }) => {
            await enterAge(page, '30');
            expect(await vitalsLocked(page)).toBe(false);

            const box = page.locator(selector);
            await box.fill(bad);
            await box.blur();

            const kept = await box.inputValue();
            const validity = await fieldValidity(page, selector);
            const refused = kept === '' || !validity.valid;

            expect(
                refused,
                `${field} kept an out-of-range reading of ${bad} and raised no complaint`
            ).toBe(true);

            // ...and the band it does accept still goes in, so the check above means something.
            await box.fill(good);
            await box.blur();
            await expect(box, `${field} rejected an in-range reading of ${good}`).toHaveValue(good);
            expect((await fieldValidity(page, selector)).valid).toBe(true);
        });
    }

    /* ------------------------------------------------------------------ *
     * 6. Duplicate data
     * ------------------------------------------------------------------ */

    test('refuses an Aadhaar that already belongs to another patient', {
        tag: ['@smile', '@negative', '@duplicate'],
    }, async ({ page }) => {
        const existing = process.env['E2E_SMILE_DUPLICATE_AADHAAR'];

        // There is no cheap way to manufacture a duplicate: it takes a patient the centre
        // has already registered. Point the key at one and this runs; leave it unset and
        // the case is skipped rather than guessing at a number and failing on the guess.
        test.skip(
            !existing,
            'Set E2E_SMILE_DUPLICATE_AADHAAR to an Aadhaar this centre has already registered'
        );

        await typeAadhaar(page, existing as string);

        const error = page.locator('#aadhaar_error');
        await expect(error, 'A known Aadhaar raised no duplicate warning').toBeVisible({
            timeout: 20000,
        });
        await expect(error).toContainText(/already exists/i);
    });

    /* ------------------------------------------------------------------ *
     * 7. Invalid dates
     * ------------------------------------------------------------------ */

    test('will not let a review date be typed into the read-only Review After box', {
        tag: ['@smile', '@negative', '@dates'],
    }, async ({ page }) => {
        const picker = page.locator('#ReviewAfterDatePicker');

        await expect(picker).toHaveAttribute('readonly', /.*/);
        await expect(picker).toHaveAttribute('required', /.*/);

        // A readonly box refuses a fill outright; the calendar is the only way in.
        await expect(
            picker.fill('01-01-2020', { timeout: 3000 }),
            'The read-only Review After box accepted a typed date'
        ).rejects.toThrow();

        await expect(picker).toHaveValue('');
    });

    test('offers no past dates on the Review After calendar', {
        tag: ['@smile', '@negative', '@dates', '@boundary'],
    }, async ({ page }) => {
        // minDate 1 is the picker's own guard: the earliest review it offers is tomorrow.
        const minDate = await page.evaluate(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const $ = (window as any).jQuery;
            return $('#ReviewAfterDatePicker').datepicker('option', 'minDate');
        });

        expect(minDate, 'The Review After calendar no longer blocks past dates').toBe(1);
    });

    /* ------------------------------------------------------------------ *
     * 8. API failures
     * ------------------------------------------------------------------ */

    test('does not save when the duplicate-Aadhaar check cannot reach the server', {
        tag: ['@smile', '@negative', '@api-failure'],
    }, async ({ page, dialogs }) => {
        await page.route(
            (url) => /aadhaar/i.test(url.pathname + url.search),
            (route) => route.abort('failed')
        );

        await fillPatientBlock(page, { aadhaar: null });

        const field = page.locator('#patient_aadhaar');
        await field.click();
        await field.pressSequentially(freshAadhaar(), { delay: 20 });
        await field.blur();
        await page.waitForTimeout(3000);

        // Whatever it decides to show, an unverified Aadhaar must not become a prescription.
        const refusal = await saveAndReadRefusal(page, dialogs);
        expect(
            refusal.outcome,
            'An Aadhaar the server never verified was saved anyway'
        ).not.toBe('left');
        await expectStillOnForm(page);
    });

    test('keeps the run on the form when the save request fails outright', {
        tag: ['@smile', '@negative', '@api-failure'],
    }, async ({ page, dialogs }) => {
        await fillPatientBlock(page, { aadhaar: freshAadhaar() });

        await page.route('**/PrescriptionForm**', (route) =>
            route.request().method() === 'POST' ? route.abort('failed') : route.fallback()
        );

        const refusal = await saveAndReadRefusal(page, dialogs);

        expect(refusal.outcome, 'A failed save still navigated away').not.toBe('left');
        await expectStillOnForm(page);
        await expect(page, 'A failed save reported a saved prescription').not.toHaveURL(
            /PrescriptionView/i
        );
    });

    test('does not claim success when the server answers the save with a 500', {
        tag: ['@smile', '@negative', '@api-failure'],
    }, async ({ page, dialogs }) => {
        await fillPatientBlock(page, { aadhaar: freshAadhaar() });

        await page.route('**/PrescriptionForm**', (route) =>
            route.request().method() === 'POST'
                ? route.fulfill({ status: 500, contentType: 'text/html', body: 'Server error' })
                : route.fallback()
        );

        const refusal = await saveAndReadRefusal(page, dialogs);

        expect(refusal.outcome).not.toBe('left');
        await expect(page, 'A 500 on save was reported as a saved prescription').not.toHaveURL(
            /PrescriptionView/i
        );
    });

    /* ------------------------------------------------------------------ *
     * 9. Navigation and session
     * ------------------------------------------------------------------ */

    test('sends a half-filled form to the login page once the session has expired', {
        tag: ['@smile', '@negative', '@session'],
    }, async ({ page, context }) => {
        await fillPatientBlock(page, { name: 'Session Check', aadhaar: null });
        await expect(page.locator('#patient_name')).toHaveValue('Session Check');

        // The session expiring under a form that is being filled — what a long consultation
        // runs into. Pressing Save is not how to test it: the browser blocks the submit on
        // the form's own required fields before a single request leaves the page, so the
        // expiry would never be reached. The next round trip is what finds it.
        await context.clearCookies();
        await page.reload();

        await expect(page, 'An expired session still served the prescription form').toHaveURL(
            /Login/i,
            { timeout: 20000 }
        );
        await expect(page.locator('#patient_name'), 'The form survived the expiry').toHaveCount(0);
        await expect(page.getByRole('textbox', { name: 'Username' })).toBeVisible({
            timeout: 10000,
        });
    });

    test('loses a half-filled form on reload rather than restoring a draft', {
        tag: ['@smile', '@negative', '@session', '@ui-state'],
    }, async ({ page }) => {
        await fillPatientBlock(page, { name: 'Draft Check', aadhaar: null });
        await expect(page.locator('#patient_name')).toHaveValue('Draft Check');

        await page.reload();
        await expect(page.locator('#patient_name')).toBeVisible({ timeout: 20000 });

        // No draft is kept, so a reload mid-consultation costs the lot — worth pinning so
        // nobody assumes otherwise.
        await expect(page.locator('#patient_name'), 'A reload restored a stale draft').toHaveValue(
            ''
        );
        expect(await vitalsLocked(page), 'The vitals were left unlocked after a reload').toBe(true);
    });

    test('writes no prescription when a half-filled form is navigated away from and returned to', {
        tag: ['@smile', '@negative', '@session', '@ui-state'],
    }, async ({ page }) => {
        await fillPatientBlock(page, { name: 'Back Button', aadhaar: null });

        await page.goto(`${prescriptionFormUrl().replace('/PrescriptionForm', '')}/Home`);
        await page.goBack();
        await expect(page.locator('#patient_name')).toBeVisible({ timeout: 20000 });

        // Whatever the browser restores into the boxes, nothing was ever submitted: this is
        // still the blank form's own URL and no prescription was written.
        // (What it does restore is pinned separately — see BUG-SMILE-013.)
        await expect(page, 'Going back presented an abandoned form as a saved one').toHaveURL(
            /PrescriptionForm/i
        );
        await expect(page).not.toHaveURL(/PrescriptionView/i);
        await expect(page.locator('#SavePrescription')).toBeVisible();
    });

    /* ------------------------------------------------------------------ *
     * 10. UI and state
     * ------------------------------------------------------------------ */

    test('withholds the gynaecology section from a male patient', {
        tag: ['@smile', '@negative', '@ui-state'],
    }, async ({ page }) => {
        await setGender(page, 'Male');
        await enterAge(page, '30');

        await expect(
            page.locator('#gynaedetails'),
            'A male patient was shown the gynaecology section'
        ).toBeHidden({ timeout: 10000 });
        await expect(page.locator('#anc_form')).toBeHidden();
        await expect(page.locator('#pnc_form')).toBeHidden();
    });

    test('takes the gynaecology section away again when the gender is switched to male', {
        tag: ['@smile', '@negative', '@ui-state'],
    }, async ({ page }) => {
        await setGender(page, 'Female');
        await enterAge(page, '30');
        await expect(page.locator('#gynaedetails')).toBeVisible({ timeout: 10000 });

        await setGender(page, 'Male');

        await expect(
            page.locator('#gynaedetails'),
            'The gynaecology section stayed after switching to male'
        ).toBeHidden({ timeout: 10000 });
    });

    test('closes the gynaecology section when a woman is aged out of 14-49', {
        tag: ['@smile', '@negative', '@ui-state', '@boundary'],
    }, async ({ page }) => {
        await setGender(page, 'Female');
        await enterAge(page, '30');
        await expect(page.locator('#gynaedetails')).toBeVisible({ timeout: 10000 });

        await enterAge(page, '60');

        await expect(
            page.locator('#gynaedetails'),
            'The gynaecology section survived an age outside 14-49'
        ).toBeHidden({ timeout: 10000 });
    });

    test('leaves the married answer unset rather than guessing one', {
        tag: ['@smile', '@negative', '@ui-state'],
    }, async ({ page }) => {
        // The form's ready handler picks its own defaults; a test that sets a radio before
        // it has run finds its choice quietly undone, which is why checkRadio() retries.
        await checkRadio(page.locator('#marriedy'));
        await expect(page.locator('#marriedy')).toBeChecked();

        await checkRadio(page.locator('#marriedn'));
        await expect(page.locator('#marriedn')).toBeChecked();
        await expect(page.locator('#marriedy')).not.toBeChecked();
    });
});
