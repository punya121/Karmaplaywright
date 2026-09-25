import { expect, test, type Page } from '@playwright/test';
import { validPassword, validUsername } from '../config/test-env';
import { LoginPage } from '../pages/login.page';
import { fakeCameraArgs, PatientPhotoSection, PhotoStatus } from '../pages/patient-photo.page';
import { RegistrationPage } from '../pages/registration.page';

// Chrome's fake camera: a moving green test pattern with no face in it. The flags are
// Chromium's own; Firefox and WebKit ignore them. Tests with a face are in
// patient-photo-face.spec.ts.
test.use({
    launchOptions: { args: fakeCameraArgs },
    permissions: ['camera'],
});

test.describe('Patient registration - live photo capture', () => {
    // One worker for the file: each test signs in, and the account allows only a few sessions.
    test.describe.configure({ mode: 'default' });
    test.skip(({ browserName }) => browserName !== 'chromium', 'Fake camera flags are Chromium-only');

    test.afterEach(async ({ page }) => {
        await new LoginPage(page).logout();
    });

    async function openForm(page: Page) {
        await new LoginPage(page).loginExpectingHome(validUsername, validPassword);
        const registrationPage = new RegistrationPage(page);
        await registrationPage.openFromHome();
        // Face capture is only switched on for the Dhaula centre; other centres' forms have no photo block.
        const hasPhotoBlock = (await page.locator('#openCameraBtn').count()) > 0;
        test.skip(!hasPhotoBlock, 'Patient photo capture is only enabled for the Dhaula centre');
        return registrationPage;
    }

    test('shows the empty photo block before the camera is opened', {
        tag: ['@patient', '@photo'],
    }, async ({ page }) => {
        const photo = new PatientPhotoSection(page);
        await openForm(page);

        await photo.expectInitial();
    });

    test('opens a live camera preview on Take Photo', {
        tag: ['@patient', '@photo'],
    }, async ({ page }) => {
        const photo = new PatientPhotoSection(page);
        await openForm(page);

        await photo.openCamera();
    });

    test('tells the user to allow permission when the camera is blocked', {
        tag: ['@negative', '@patient', '@photo'],
    }, async ({ page }) => {
        const photo = new PatientPhotoSection(page);
        await photo.denyCamera();
        await openForm(page);

        await photo.takePhoto.click();

        await expect(photo.status).toHaveText(PhotoStatus.cameraDenied);
        await expect(photo.takePhoto).toBeVisible();
        await expect(photo.capture).toBeHidden();
        await expect(photo.base64).toHaveValue('');
    });

    test('rejects a capture that has no face in it', {
        tag: ['@negative', '@patient', '@photo'],
    }, async ({ page }) => {
        // Chrome's own fake camera: a green test pattern, no face.
        const photo = new PatientPhotoSection(page);
        await openForm(page);
        await photo.openCamera();

        await photo.captureAndWaitForVerdict();

        await photo.expectPhotoRejected(PhotoStatus.noFace);
    });
});
