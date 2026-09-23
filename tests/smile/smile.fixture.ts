import { test as base, expect, type Browser, type Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { baseUrl, smileCredentials } from '../config/test-env';
import { LoginPage } from '../pages/login.page';
import { SmilePrescriptionPage } from '../pages/smile-prescription.page';

/**
 * The fixtures the SMILE negative and regression specs are built on.
 *
 * The one thing that shapes all of this: the centre account only allows a handful of
 * concurrent sessions, and the login page refuses the next one with "you already have N
 * active sessions". A file of thirty negative tests that each sign in would burn through
 * that cap before it got a quarter of the way down, and the failures would all be about
 * the cap rather than about the form.
 *
 * So the sign-in happens once per worker: `smileState` signs in in a context of its own,
 * writes the session cookie out to a storage-state file, and logs that session out when
 * the worker is finished. Every test then starts from that cookie instead of from the
 * login form, which is both the reason a whole file costs one session and the reason
 * these specs run in a couple of minutes rather than half an hour.
 *
 * `smilePage` hands a test a SmilePrescriptionPage already sitting on a loaded, empty
 * Registration > Prescription form, with the dialog handler in place (the form says most
 * of what it refuses through alert(), and Playwright dismisses dialogs by default, which
 * would otherwise swallow exactly the message a negative test is there to read).
 */

export type SmileFixtures = {
    smilePage: SmilePrescriptionPage;
    /** Alerts the form raised, newest last. See PrescriptionFormPage.captureDialogs(). */
    dialogs: string[];
};

export type SmileWorkerFixtures = {
    /** Path to the storage state holding this worker's signed-in SMILE session. */
    smileState: string;
};

export const test = base.extend<SmileFixtures, SmileWorkerFixtures>({
    smileState: [
        async ({ browser }: { browser: Browser }, use, workerInfo) => {
            const { username, password } = smileCredentials();
            const context = await browser.newContext();
            const page = await context.newPage();
            const statePath = path.join(
                os.tmpdir(),
                `smile-state-${process.pid}-${workerInfo.workerIndex}.json`
            );

            try {
                await new LoginPage(page).loginExpectingHome(username, password);
                await context.storageState({ path: statePath });
                await use(statePath);
            } finally {
                // Always give the session slot back, whatever the run did with it.
                await new LoginPage(page).logout();
                await context.close();
                await fs.promises.rm(statePath, { force: true });
            }
        },
        { scope: 'worker' },
    ],

    // Every test in a spec that uses this `test` starts already signed in. A spec that
    // wants an anonymous browser overrides it with test.use({ storageState: ... }).
    storageState: async ({ smileState }, use) => {
        await use(smileState);
    },

    smilePage: async ({ page }, use) => {
        const smilePage = new SmilePrescriptionPage(page);
        await use(smilePage);
    },

    dialogs: async ({ page, smilePage }, use) => {
        // Registered before the form is opened, so nothing the form says is missed.
        const messages = smilePage.captureDialogs();
        await use(messages);
    },
});

export { expect };

/**
 * How fast the browser is driven, shared by every spec in this folder.
 *
 * A watchable pace is the default on purpose. These cases are mostly read rather than
 * merely run — the point of one is what the form does when it refuses something, and at
 * full speed the refusal is on and off the screen before it can be seen. So every action
 * waits WATCHED_SLOW_MO, headed or not, the same way the happy-path SMILE specs pace
 * themselves (smile-registration.spec.ts uses 500, skip-aadhaar 1000).
 *
 * It cannot be decided from inside the run instead: `launchOptions` is not allowed to
 * depend on the `headless` option — Playwright calls that a fixture cycle — and a worker
 * process is not given the `--headed` flag in its argv, so there is no way to ask which
 * way this run was started. It is handed in from outside or not at all.
 *
 * E2E_SLOW_MO is the one knob, and the `:fast` scripts are it set to 0 for a run nobody
 * is watching — CI, or a re-run after a locator change, where sixty paced tests is half
 * an hour that buys nothing.
 *
 *   npm run test:smile-negative                 1000ms per action, watchable
 *   npm run test:smile-negative:headed          the same, with the browser on screen
 *   npm run test:smile-negative:fast            full speed, for CI
 *   E2E_SLOW_MO=2000 npm run test:smile-negative    slower still, for a recording
 */
export const WATCHED_SLOW_MO = 1000;

export const smilePace = {
    launchOptions: {
        slowMo: Number(
            process.env['E2E_SLOW_MO'] !== undefined && process.env['E2E_SLOW_MO'] !== ''
                ? process.env['E2E_SLOW_MO']
                : WATCHED_SLOW_MO
        ),
    },
};

/** Registration > Prescription, opened straight at its URL. */
export function prescriptionFormUrl(): string {
    return `${baseUrl.replace(/\/$/, '')}/PrescriptionForm`;
}

/**
 * Opens a blank Registration > Prescription form and waits for the page's own ready
 * handler to finish, which is what `expectLoaded()` does by waiting out the spinner.
 * Tests call this rather than `openFromHome()` because they start from a restored
 * cookie rather than from the home page the hover menu lives on.
 */
export async function openBlankPrescriptionForm(
    page: Page,
    smilePage: SmilePrescriptionPage
): Promise<void> {
    await page.goto(prescriptionFormUrl());
    await smilePage.expectLoaded();
}

/**
 * Ticks the declaration checkbox and presses Save, then reports how the form answered,
 * without any of the stock-shortfall editing `saveAndExpectLeavingForm()` does — a
 * negative test wants the refusal itself, not a form edited until it is accepted.
 *
 *   'alerted' — the form cancelled the submit through an alert()
 *   'invalid' — the browser's own constraint validation blocked it
 *   'inline'  — the form showed a validation message next to a field
 *   'left'    — the save went through and the app navigated away
 *   'silent'  — still on the form, with nothing said
 */
export type SaveRefusal = {
    outcome: 'alerted' | 'invalid' | 'inline' | 'left' | 'silent';
    /** Whatever the form said, joined into one string. Empty for 'left' and 'silent'. */
    message: string;
    /** The field the browser refused, where it was constraint validation. */
    field: string;
};

export async function saveAndReadRefusal(
    page: Page,
    dialogs: string[],
    timeout = 15000
): Promise<SaveRefusal> {
    const formUrl = page.url();
    const alertsBefore = dialogs.length;

    const declaration = page.locator('input[type="checkbox"]:required').first();
    if (await declaration.isVisible({ timeout: 2000 }).catch(() => false)) {
        await declaration.check({ force: true }).catch(() => undefined);
    }

    await page.locator('#SavePrescription').click();

    const deadline = Date.now() + timeout;
    for (;;) {
        if (dialogs.length > alertsBefore) {
            return {
                outcome: 'alerted',
                message: dialogs.slice(alertsBefore).join(' / '),
                field: '',
            };
        }

        if (page.url() !== formUrl) {
            await page.waitForLoadState('load').catch(() => undefined);
            return { outcome: 'left', message: '', field: '' };
        }

        const invalid = await firstInvalidField(page);
        if (invalid) {
            return { outcome: 'invalid', message: invalid.message, field: invalid.field };
        }

        const inline = await visibleValidationMessage(page);
        if (inline) {
            return { outcome: 'inline', message: inline, field: '' };
        }

        if (Date.now() >= deadline) {
            return { outcome: 'silent', message: '', field: '' };
        }

        await page.waitForTimeout(200);
    }
}

/**
 * Checks a radio and keeps at it until the page lets it stay checked.
 *
 * The form's own document-ready handler sets defaults (Married: Unknown, Ayushman: No)
 * and re-renders parts of the patient block as the gender and age change, so a radio
 * checked at the wrong moment is quietly reset — `check()` on its own then fails with
 * "Clicking the checkbox did not change its state". This is the same retry
 * SmilePrescriptionPage uses internally.
 */
export async function checkRadio(radio: import('@playwright/test').Locator): Promise<void> {
    await expect(async () => {
        await radio.check({ force: true, timeout: 2000 });
        await expect(radio).toBeChecked({ timeout: 1000 });
    }).toPass({ timeout: 15000 });
}

/** Sets the patient's gender, waiting out the re-render it triggers. */
export async function setGender(page: Page, gender: 'Male' | 'Female'): Promise<void> {
    await checkRadio(page.locator(`input[name="sex"][value="${gender}"]`));
}

/**
 * Types an age and lets the form's change handler run. The handler is what unlocks the
 * vitals, so anything that reads them has to wait for it — it fires on blur, not on
 * every keystroke.
 */
export async function enterAge(page: Page, age: string): Promise<void> {
    const field = page.locator('#patient_age');
    await field.fill(age);
    await field.press('Tab');
}

/** Whether the vitals block is still locked, which is how the form gates a bad age. */
export async function vitalsLocked(page: Page): Promise<boolean> {
    return page
        .locator('input[name="weight"]')
        .evaluate((element) => element.hasAttribute('readonly'));
}

/** One named field's own constraint-validation state, rather than the form's first. */
export async function fieldValidity(
    page: Page,
    selector: string
): Promise<{ valid: boolean; message: string }> {
    return page.locator(selector).evaluate((element) => {
        const field = element as HTMLInputElement;
        return { valid: field.validity.valid, message: field.validationMessage };
    });
}

/**
 * A 12-digit Aadhaar that has not been used before, led by a 2-9 the way a real one is.
 * The form asks the server about every Aadhaar it is given, so a number reused between
 * runs comes back as a duplicate and fails a test that was about something else.
 */
export function freshAadhaar(): string {
    const suffix = Date.now().toString().slice(-8) + String(randomDigits(3));
    return `${2 + (Number(suffix.slice(-1)) % 8)}${suffix.padStart(11, '0').slice(-11)}`;
}

function randomDigits(count: number): string {
    return String(Math.floor(Math.random() * 10 ** count)).padStart(count, '0');
}

export type PatientBlock = {
    name?: string;
    parent?: string;
    gender?: 'Male' | 'Female';
    age?: string;
    married?: boolean;
    mobile?: string;
    /** Left out entirely when null — which is what most of the negative cases want. */
    aadhaar?: string | null;
};

/**
 * Fills the patient block at the top of the form with values that are valid unless a
 * test overrides them, so each negative case can put exactly one thing wrong and be sure
 * the refusal it reads back belongs to that one thing.
 *
 * Aadhaar is left blank by default: it is the slowest field on the form (every entry is
 * checked against the server) and most cases are refused long before the form gets to it.
 */
export async function fillPatientBlock(page: Page, block: PatientBlock = {}): Promise<void> {
    const {
        name = `Neg ${Date.now().toString().slice(-6)}`,
        parent = 'Neg Parent',
        gender = 'Male',
        age = '30',
        married = false,
        mobile = '9876543210',
        aadhaar = null,
    } = block;

    await page.locator('#patient_name').fill(name);
    await page.locator('#parent').fill(parent);
    await setGender(page, gender);
    await enterAge(page, age);
    await checkRadio(page.locator(married ? '#marriedy' : '#marriedn'));
    await page.locator('#mobile').fill(mobile);

    if (aadhaar !== null) {
        await typeAadhaar(page, aadhaar);
    }
}

/**
 * Types into the masked Aadhaar box the way a person does. The box shows XXXX-XXXX-1234
 * and keeps the real number in a hidden field that only its own input handler writes, so
 * a `fill()` puts the form in a state it never reaches on its own; every digit has to be
 * pressed. Returns once the duplicate check the blur kicks off has settled.
 */
export async function typeAadhaar(page: Page, aadhaar: string): Promise<void> {
    const field = page.locator('#patient_aadhaar');
    await field.click();
    await field.fill('');
    await field.pressSequentially(aadhaar, { delay: 20 });
    await field.blur();

    const stillChecking = page
        .locator('#aadhaar_error')
        .filter({ visible: true, hasText: /checking/i });
    await expect(stillChecking, 'The duplicate Aadhaar check never finished').toHaveCount(0, {
        timeout: 20000,
    });
}

/** The first control the browser's own constraint validation is refusing, if any. */
export async function firstInvalidField(
    page: Page
): Promise<{ field: string; message: string } | null> {
    return page
        .evaluate(() => {
            const invalid = document.querySelector<
                HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
            >('input:invalid, select:invalid, textarea:invalid');

            return invalid
                ? {
                      field: invalid.name || invalid.id || invalid.tagName.toLowerCase(),
                      message: invalid.validationMessage,
                  }
                : null;
        })
        .catch(() => null);
}

/** The form's own visible complaint about a submit, where it made one. */
export async function visibleValidationMessage(page: Page): Promise<string | null> {
    return page
        .evaluate(() => {
            const shown = Array.from(
                document.querySelectorAll<HTMLElement>(
                    '[role="alert"], .error, .alert, .validation-summary-errors, ' +
                        '.field-validation-error, .validateSpanClass, #aadhaar_error'
                )
            ).find((element) => element.offsetParent !== null && element.innerText.trim());

            return shown ? shown.innerText.trim() : null;
        })
        .catch(() => null);
}

/** Whether the run is still on the form rather than on a saved prescription. */
export async function expectStillOnForm(page: Page): Promise<void> {
    await expect(page, 'The form left Registration > Prescription').toHaveURL(
        /PrescriptionForm/i
    );
    await expect(page, 'A refused save still wrote a prescription').not.toHaveURL(
        /PrescriptionView/i
    );
}
