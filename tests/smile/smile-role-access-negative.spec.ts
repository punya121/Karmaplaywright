import { test, expect } from '@playwright/test';
import { baseUrl, smileCredentials } from '../config/test-env';
import { LoginPage } from '../pages/login.page';
import { smilePace } from './smile.fixture';

/**
 * What the SMILE centre account is allowed to reach outside its own screens.
 *
 * This spec signs in for itself instead of using the shared worker session in
 * smile.fixture.ts, and that is deliberate: asking for /DoctorHome as a centre user does
 * not just refuse the page, it ends the session — every request after it goes to /Login.
 * Run on the shared session it would take every later test in the worker down with it,
 * and the failures would all point at the wrong thing.
 *
 * So it gets a context and a login of its own, and logs out at the end whatever happened.
 * That is also why it is its own file rather than a describe block: nothing else here
 * should ever share a session with it.
 */

const origin = baseUrl.replace(/\/$/, '');

// 1000ms per action so a run can be followed; the :fast scripts turn it off. See smilePace.
test.use(smilePace);

test.describe('SMILE centre — pages belonging to another role', () => {
    test.setTimeout(120000);

    test('refuses the SMILE centre the doctor home page and ends the session', {
        tag: ['@smile', '@negative', '@access-control'],
    }, async ({ browser }) => {
        const { username, password } = smileCredentials();
        const context = await browser.newContext();
        const page = await context.newPage();
        const loginPage = new LoginPage(page);

        try {
            await loginPage.loginExpectingHome(username, password);

            // The centre's own screen opens, so the session is good before the attempt.
            await page.goto(`${origin}/PrescriptionForm`, { waitUntil: 'commit' });
            await page.waitForLoadState('load').catch(() => undefined);
            await expect(
                page.locator('#patient_name'),
                'The SMILE session could not open its own form to begin with'
            ).toBeVisible({ timeout: 20000 });

            await page.goto(`${origin}/DoctorHome`, { waitUntil: 'commit' });
            await page.waitForLoadState('load').catch(() => undefined);

            await expect(page, 'A centre account was served the doctor home page').toHaveURL(
                /Login/i,
                { timeout: 20000 }
            );
            await expect(page.getByRole('textbox', { name: 'Username' })).toBeVisible({
                timeout: 10000,
            });

            // And the refusal is total: the session it was holding is gone with it, so the
            // centre's own screen no longer opens either.
            await page.goto(`${origin}/PrescriptionForm`, { waitUntil: 'commit' });
            await page.waitForLoadState('load').catch(() => undefined);

            await expect(
                page,
                'The session survived a request for another role\'s page'
            ).toHaveURL(/Login/i, { timeout: 20000 });
            await expect(page.locator('#patient_name')).toHaveCount(0);
        } finally {
            await loginPage.logout();
            await context.close();
        }
    });
});
