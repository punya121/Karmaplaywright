import { expect, test, type Page } from '@playwright/test';
import { validPassword, validUsername } from '../config/test-env';
import { createSavePatient } from '../data/patients';
import { LoginPage } from '../pages/login.page';
import { faceCameraArgs, faceFixturePath, hasFaceFixture, PatientPhotoSection, photoSentWith, PhotoStatus } from '../pages/patient-photo.page';
import { RegistrationPage } from '../pages/registration.page';

// Chrome's fake camera, playing tests/fixtures/patient-face.jpg instead of its test pattern.
// A launch option, so it has to sit at the top of its own file; the no-face cases live in
// patient-photo-capture.spec.ts.
test.use({
    launchOptions: { args: faceCameraArgs() },
    permissions: ['camera'],
});

test.describe('Patient registration - live photo capture with a face', () => {
    // One worker for the file: each test signs in, and the account allows only a few sessions.
    test.describe.configure({ mode: 'default' });
    test.skip(({ browserName }) => browserName !== 'chromium', 'Fake camera flags are Chromium-only');
    test.skip(!hasFaceFixture(), `Add a front-facing face photo at ${faceFixturePath}`);

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

    test('captures the face, shows the preview and offers Retake', {
        tag: ['@smoke', '@patient', '@photo'],
    }, async ({ page }) => {
        const photo = new PatientPhotoSection(page);
        await photo.mockFaceMatch('no-match');
        await openForm(page);
        await photo.openCamera();

        await photo.captureFace();

        await photo.expectPhotoAccepted();
        await expect(photo.status).toHaveText(PhotoStatus.noMatch);
    });

    test('Retake clears the captured photo and reopens the camera', {
        tag: ['@patient', '@photo'],
    }, async ({ page }) => {
        const photo = new PatientPhotoSection(page);
        await photo.mockFaceMatch('no-match');
        await openForm(page);
        await photo.openCamera();
        await photo.captureFace();
        await photo.expectPhotoAccepted();

        await photo.retake.click();

        await expect(photo.status).toHaveText(PhotoStatus.cameraReady);
        await expect(photo.preview).toBeHidden();
        await expect(photo.retake).toBeHidden();
        await photo.expectLiveStream();
    });

    test('Retake drops the old photo so it cannot be saved by mistake', {
        tag: ['@patient', '@photo'],
        annotation: {
            type: 'issue',
            description:
                'Retake reopens the camera but leaves #patientPhotoBase64 holding the previous capture, '
                + 'so Save without a new capture still submits the old photo. Remove test.fail() once fixed.',
        },
    }, async ({ page }) => {
        test.fail();
        const photo = new PatientPhotoSection(page);
        await photo.mockFaceMatch('no-match');
        await openForm(page);
        await photo.openCamera();
        await photo.captureFace();
        await photo.expectPhotoAccepted();

        await photo.retake.click();

        await expect(photo.base64).toHaveValue('');
    });

    // A face can be registered once: the save itself is checked against every patient on
    // the server, so after one successful run the fixture face is a duplicate for good.
    // Opt in with E2E_PHOTO_SAVE=1 and a fixture face that has never been saved.
    test('saves a new patient with the captured photo', {
        tag: ['@patient', '@photo'],
    }, async ({ page }) => {
        test.skip(!process.env.E2E_PHOTO_SAVE, 'Needs a never-registered face; set E2E_PHOTO_SAVE=1 to run');
        const photo = new PatientPhotoSection(page);
        await photo.mockFaceMatch('no-match');
        const registrationPage = await openForm(page);
        const patient = createSavePatient();

        await photo.openCamera();
        await photo.captureFace();
        await photo.expectPhotoAccepted();
        await photo.waitForFaceMatchCheck();

        const aadhaarRequired = await registrationPage.isAadhaarRequired();
        await registrationPage.fillPatient(patient, { fillAadhaar: aadhaarRequired });

        console.log(`Saving patient with photo name=${patient.name} mobile=${patient.mobile}`);

        // The photo has to travel with the form, not just sit in the preview.
        const saveRequest = page.waitForRequest(
            (req) => req.method() === 'POST' && /PatientForm\/save/i.test(req.url()),
        );
        await registrationPage.save();
        expect(photoSentWith(await saveRequest), 'the saved form must carry the photo').toBe(true);
        await registrationPage.expectSaved();
    });

    test.describe('when the face belongs to an already registered patient', () => {
        const existing = { patientId: '999999', patientName: 'Existing Test Patient' };

        test('shows the Patient Already Exists modal with a link to that record', {
            tag: ['@negative', '@patient', '@photo'],
        }, async ({ page }) => {
            const photo = new PatientPhotoSection(page);
            await photo.mockFaceMatch(existing);
            await openForm(page);
            await photo.openCamera();

            await photo.captureFace();

            await expect(photo.faceMatchModal).toHaveClass(/is-open/);
            await expect(photo.faceMatchModal).toContainText('Patient Already Exists');
            await expect(page.locator('#fmPatientName')).toHaveText(existing.patientName);
            await expect(photo.modalUsePatient).toHaveAttribute('href', new RegExp(`PatientForm\\?id=${existing.patientId}$`));
            await expect(photo.status).toHaveText(PhotoStatus.duplicate);
        });

        // No mocks: the real face search. Relies on the fixture face already being
        // registered on UAT (it is, from the first photo save).
        test('the page blocks Save for an already registered face, even with the modal closed', {
            tag: ['@negative', '@patient', '@photo'],
        }, async ({ page }) => {
            test.slow();
            const photo = new PatientPhotoSection(page);
            const registrationPage = await openForm(page);
            await photo.openCamera();
            await photo.captureFace();
            await photo.waitForFaceMatchCheck();

            await expect(photo.status).toHaveText(/This photo belongs to/i, { timeout: 15000 });
            await expect(photo.faceMatchModal).toHaveClass(/is-open/);

            await photo.modalClose.click();
            await expect(photo.faceMatchModal).not.toHaveClass(/is-open/);
            const aadhaarRequired = await registrationPage.isAadhaarRequired();
            await registrationPage.fillPatient(createSavePatient(), { fillAadhaar: aadhaarRequired });

            let saveSent = false;
            page.on('request', (req) => {
                if (req.method() === 'POST' && /PatientForm\/save/i.test(req.url())) saveSent = true;
            });
            await registrationPage.save({ waitForPatientSearch: false });

            await expect(photo.faceMatchModal).toHaveClass(/is-open/);
            await expect(photo.status).toHaveText(PhotoStatus.duplicate);
            await expect(page).toHaveURL(/PatientForm$/i);
            expect(saveSent, 'the form must not be submitted').toBe(false);
        });

        // The second line of defence: even when the page's face search is made to say
        // "no match", the save itself is checked on the server and refused.
        test('the server refuses to save an already registered face if the page check is bypassed', {
            tag: ['@negative', '@patient', '@photo'],
        }, async ({ page }) => {
            test.slow();
            const photo = new PatientPhotoSection(page);
            await photo.mockFaceMatch('no-match');
            const registrationPage = await openForm(page);
            await photo.openCamera();
            await photo.captureFace();
            await photo.expectPhotoAccepted();
            await photo.waitForFaceMatchCheck();
            const aadhaarRequired = await registrationPage.isAadhaarRequired();
            await registrationPage.fillPatient(createSavePatient(), { fillAadhaar: aadhaarRequired });

            const refusal = page.waitForEvent('dialog', { timeout: 30000 });
            await registrationPage.save({ waitForPatientSearch: false });
            const dialog = await refusal;
            expect(dialog.message()).toMatch(/You cannot save this as a new registration/i);
            await dialog.accept();

            await expect(page).toHaveURL(/PatientForm$/i);
        });

        test('Retake Photo in the modal discards the photo and reopens the camera', {
            tag: ['@negative', '@patient', '@photo'],
        }, async ({ page }) => {
            const photo = new PatientPhotoSection(page);
            await photo.mockFaceMatch(existing);
            await openForm(page);
            await photo.openCamera();
            await photo.captureFace();
            await expect(photo.faceMatchModal).toHaveClass(/is-open/);

            await photo.modalRetake.click();

            await expect(photo.faceMatchModal).not.toHaveClass(/is-open/);
            await expect(photo.base64).toHaveValue('');
            await expect(photo.preview).toBeHidden();
            await expect(photo.status).toHaveText(PhotoStatus.cameraReady);
            await photo.expectLiveStream();
        });
    });
});
