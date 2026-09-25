import { expect, test } from '@playwright/test';
import { baseUrl, validPassword, validUsername } from '../config/test-env';
import { createSavePatient } from '../data/patients';
import { LoginPage } from '../pages/login.page';
import {
    faceCameraArgs,
    hasFaceFixture,
    newPatientFacePath,
    PatientFaceSearch,
    PatientPhotoSection,
    photoSentWith,
    PhotoStatus,
} from '../pages/patient-photo.page';
import { RegistrationPage } from '../pages/registration.page';

// Paced to be watched: every action waits two seconds. Change it with E2E_SLOW_MO (0 = full
// speed) and pair with --headed. The camera is Chrome's fake one playing
// tests/fixtures/new-patient-face.jpg, for both the registration photo and the image search.
test.use({
    launchOptions: {
        slowMo: Number(process.env.E2E_SLOW_MO ?? 2000),
        args: faceCameraArgs(newPatientFacePath),
    },
    permissions: ['camera'],
});

/**
 * Patient registration with face recognition, end to end and with nothing mocked:
 *
 *   sign in  ->  open the registration form  ->  Take Photo  ->  Capture
 *            ->  face-api.js confirms a face is in the picture
 *            ->  the server searches registered patients for that face
 *
 *   new face          ->  fill the patient's details  ->  Save  ->  Patient Search
 *   registered face   ->  "Patient Already Exists"    ->  Use This Patient  ->  their record
 *
 *   then, either way  ->  Patient Search  ->  Search Patient by Image  ->  the same face
 *                     ->  the patient is found and the list filtered to them
 *
 * Which way it goes is decided by the real face search, not by the test: a face can only be
 * registered once, so the fixture face takes the first path on its first run and the second
 * on every run after that. The run's report says which path was taken.
 */
test.describe('Patient registration with face recognition', () => {
    test.skip(({ browserName }) => browserName !== 'chromium', 'Fake camera flags are Chromium-only');
    test.skip(!hasFaceFixture(newPatientFacePath), `Add a front-facing face photo at ${newPatientFacePath}`);

    test('registers a patient with a live photo, then finds them by image', {
        tag: ['@journey', '@patient', '@photo'],
    }, async ({ page, context }) => {
        test.setTimeout(600000);
        const loginPage = new LoginPage(page);
        const registrationPage = new RegistrationPage(page);
        const photo = new PatientPhotoSection(page);
        const faceSearch = new PatientFaceSearch(page);
        const patient = createSavePatient();
        let registered: { name: string; id?: string };

        try {
            await test.step('Sign in and open the registration form', async () => {
                await loginPage.loginExpectingHome(validUsername, validPassword);
                await registrationPage.openFromHome();
                const hasPhotoBlock = (await photo.takePhoto.count()) > 0;
                test.skip(!hasPhotoBlock, 'Patient photo capture is only enabled for the Dhaula centre');
                await photo.expectInitial();
            });

            await test.step('Take Photo: open the camera', async () => {
                await photo.openCamera();
            });

            await test.step('Capture: check a face is in the picture', async () => {
                await photo.captureFace();
                await photo.expectPhotoAccepted();
            });

            await test.step('Face recognition: search registered patients for this face', async () => {
                await photo.waitForFaceMatchCheck();
            });

            const knownFace = await photo.faceMatchModal.evaluate((el) => el.classList.contains('is-open'));

            if (knownFace) {
                const matchedName = (await page.locator('#fmPatientName').innerText()).trim();
                const recordUrl = (await photo.modalUsePatient.getAttribute('href')) ?? '';
                const matchedId = /[?&]id=(\d+)/.exec(recordUrl)?.[1];
                registered = { name: matchedName, id: matchedId };
                test.info().annotations.push({
                    type: 'face recognition',
                    description: `Face already registered: ${matchedName} (ID ${matchedId}). Opened that record instead of saving.`,
                });
                console.log(`Face recognised as ${matchedName} (ID ${matchedId})`);

                await test.step('Patient Already Exists: the match is shown', async () => {
                    await expect(photo.faceMatchModal).toContainText('Patient Already Exists');
                    await expect(photo.status).toHaveText(PhotoStatus.duplicate);
                    expect(matchedId, 'the modal must link to the matched record').toBeTruthy();
                });

                await test.step('Use This Patient: open the existing record', async () => {
                    const [record] = await Promise.all([
                        context.waitForEvent('page'),
                        photo.modalUsePatient.click(),
                    ]);
                    await record.waitForLoadState();
                    await expect(record).toHaveURL(new RegExp(`PatientForm\\?id=${matchedId}$`));
                    await expect(record.locator('#patient_name')).toHaveValue(matchedName, { timeout: 15000 });
                    await record.close();
                });

                await test.step('The new registration is not allowed through', async () => {
                    await expect(page).toHaveURL(/PatientForm$/i);
                    await expect(page).not.toHaveURL(/PatientSearch/i);
                });

                await test.step('Go to Patient Search', async () => {
                    await page.goto(`${baseUrl.replace(/\/$/, '')}/PatientSearch`);
                });
            } else {
                registered = { name: patient.name };
                test.info().annotations.push({
                    type: 'face recognition',
                    description: `New face. Registered ${patient.name} (mobile ${patient.mobile}) with the photo.`,
                });

                await test.step('No match: the photo can be saved', async () => {
                    await expect(photo.status).toHaveText(PhotoStatus.noMatch);
                });

                await test.step("Fill in the patient's details", async () => {
                    const aadhaarRequired = await registrationPage.isAadhaarRequired();
                    await registrationPage.fillPatient(patient, { fillAadhaar: aadhaarRequired });
                });

                await test.step('Save: the patient is registered with the photo', async () => {
                    console.log(`Saving patient with photo name=${patient.name} mobile=${patient.mobile}`);
                    const saveRequest = page.waitForRequest(
                        (req) => req.method() === 'POST' && /PatientForm\/save/i.test(req.url()),
                    );
                    await registrationPage.save();
                    expect(photoSentWith(await saveRequest), 'the saved form must carry the photo').toBe(true);
                    await registrationPage.expectSaved();
                });
            }

            await test.step('Search Patient by Image: open the image search', async () => {
                await expect(page).toHaveURL(/PatientSearch/i);
                await faceSearch.open();
            });

            await test.step('Search Patient by Image: open the camera', async () => {
                await faceSearch.openCamera();
            });

            await test.step('Search Patient by Image: capture the same face', async () => {
                await faceSearch.captureFace();
            });

            await test.step('The patient is found and the list is filtered to them', async () => {
                const foundId = await faceSearch.expectMatchApplied(registered);
                console.log(`Search by image found ${registered.name} (ID ${foundId})`);
                test.info().annotations.push({
                    type: 'search by image',
                    description: `Found ${registered.name} (ID ${foundId}).`,
                });
            });
        } finally {
            await loginPage.logout();
        }
    });
});
