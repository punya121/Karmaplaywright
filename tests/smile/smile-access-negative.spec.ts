import { test, expect, smilePace } from './smile.fixture';
import { baseUrl } from '../config/test-env';

/**
 * Who is allowed onto the SMILE centre's Registration > Prescription screen, and what
 * happens to someone who is not.
 *
 * Kept apart from smile-registration-negative.spec.ts because these need a browser with
 * no session at all, which the shared signed-in fixture is the opposite of. The
 * anonymous block overrides `storageState`, so the worker never signs in for it.
 *
 * The one case that has to sign in — asking for a prescription id that is not this
 * centre's — is safe to run on the shared session: it is turned away to /Home with the
 * session intact. The cross-role case is not, and lives in
 * smile-role-access-negative.spec.ts for the reason documented there.
 */

const origin = baseUrl.replace(/\/$/, '');

// 1000ms per action so a run can be followed; the :fast scripts turn it off. See smilePace.
test.use(smilePace);

test.describe('SMILE Registration > Prescription — unauthenticated access', () => {
    // No cookie at all: a browser that has never signed in.
    test.use({ storageState: { cookies: [], origins: [] } });

    test.setTimeout(90000);

    for (const { what, path } of [
        { what: 'the prescription form', path: '/PrescriptionForm' },
        { what: 'a saved prescription', path: '/PrescriptionView?id=1' },
        { what: 'the centre home page', path: '/Home' },
    ]) {
        test(`sends an unauthenticated browser asking for ${what} to the login page`, {
            tag: ['@smile', '@negative', '@auth'],
        }, async ({ page }) => {
            await page.goto(`${origin}${path}`, { waitUntil: 'commit' });
            await page.waitForLoadState('load').catch(() => undefined);

            await expect(page, `${path} was served without a session`).toHaveURL(/Login/i, {
                timeout: 20000,
            });

            // The redirect has to be a real one, not the form behind a login-shaped banner.
            await expect(page.locator('#patient_name'), `${path} still rendered the form`).toHaveCount(
                0
            );
            await expect(page.getByRole('textbox', { name: 'Username' })).toBeVisible({
                timeout: 10000,
            });
        });
    }

    test('offers no save button to an unauthenticated browser on the prescription form', {
        tag: ['@smile', '@negative', '@auth'],
    }, async ({ page }) => {
        await page.goto(`${origin}/PrescriptionForm`, { waitUntil: 'commit' });
        await page.waitForLoadState('load').catch(() => undefined);

        await expect(page.locator('#SavePrescription')).toHaveCount(0);
        await expect(page.locator('#patient_aadhaar')).toHaveCount(0);
    });
});

test.describe('SMILE Registration > Prescription — someone else\'s prescription', () => {
    test.setTimeout(90000);

    test('turns the centre away from a prescription id that is not its own', {
        tag: ['@smile', '@negative', '@access-control'],
    }, async ({ page }) => {
        // An id far outside anything this centre has written. The app answers by putting
        // the user back on /Home rather than by rendering somebody else's consultation.
        await page.goto(`${origin}/PrescriptionView?id=999999999`, { waitUntil: 'commit' });
        await page.waitForLoadState('load').catch(() => undefined);

        await expect(page, 'A foreign prescription id was rendered').not.toHaveURL(
            /PrescriptionView/i,
            { timeout: 20000 }
        );
        await expect(page).toHaveURL(/Home|Login/i);

        // Nothing approvable can be reached this way.
        await expect(
            page.locator('#Approve'),
            'A prescription that is not this centre\'s offered an Approve button'
        ).toHaveCount(0);
    });

    test('offers nothing to approve for a prescription id that does not parse', {
        tag: ['@smile', '@negative', '@access-control', '@data-type'],
    }, async ({ page }) => {
        await page.goto(`${origin}/PrescriptionView?id=not-a-number`, { waitUntil: 'commit' });
        await page.waitForLoadState('load').catch(() => undefined);

        await expect(page.locator('#Approve')).toHaveCount(0);

        // A non-numeric id must not reach an unhandled server error either.
        await expect(page.locator('body')).not.toContainText(
            /server error in|stack trace|yellow screen|System\.\w+Exception/i
        );
    });
});
