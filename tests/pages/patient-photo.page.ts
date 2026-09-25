import fs from 'fs';
import os from 'os';
import path from 'path';
import { expect, type Locator, type Page, type Request } from '@playwright/test';

/**
 * Where a face picture for the camera lives: a clear, front-facing, well-lit JPEG.
 * The app's TinyFaceDetector needs a score of 0.4; a dim or backlit shot can fall short.
 */
export const faceFixturePath = path.resolve(__dirname, '../fixtures/patient-face.jpg');

/**
 * A second face, kept for registering a new patient. A face can be registered only once, so
 * this one goes through the new-patient path on its first run and is a known face after it.
 */
export const newPatientFacePath = path.resolve(__dirname, '../fixtures/new-patient-face.jpg');

export function hasFaceFixture(imagePath = faceFixturePath): boolean {
    return fs.existsSync(imagePath);
}

/**
 * The launch options a spec needs before it can open the camera at all. Chrome's camera
 * prompt is drawn outside the page, so no locator reaches it; these flags answer it and
 * hand the page a synthetic camera (a moving green test pattern, with no face in it).
 */
export const fakeCameraArgs = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];

/**
 * The same fake camera, but showing the face fixture instead of the test pattern. Chrome
 * plays an MJPEG file as its camera, and MJPEG is only JPEG frames laid end to end, so the
 * fixture repeated is a valid one. Stubbing getUserMedia with a canvas stream was tried
 * first: headless Chrome handed the page black frames, so detection passed only by luck.
 */
export function faceCameraArgs(imagePath = faceFixturePath): string[] {
    if (!hasFaceFixture(imagePath)) {
        return fakeCameraArgs;
    }
    const mjpeg = path.join(os.tmpdir(), `playwright-${path.basename(imagePath, path.extname(imagePath))}.mjpeg`);
    const frame = fs.readFileSync(imagePath);
    fs.writeFileSync(mjpeg, Buffer.concat(Array(30).fill(frame)));
    return [...fakeCameraArgs, `--use-file-for-fake-video-capture=${mjpeg}`];
}

/**
 * Waits until a camera <video> is showing a real picture. Being visible is not proof of one:
 * the page hands the stream to the <video> while it is still display:none and relies on
 * autoplay, and headless Chrome leaves that paused on a black frame (the camera track itself
 * streams fine), so Capture draws black. A real browser resumes it once shown - do that
 * here, then wait until a frame has real content in it.
 */
export async function waitForLivePicture(video: Locator): Promise<void> {
    await expect
        .poll(
            () =>
                video.evaluate(async (v: HTMLVideoElement) => {
                    if (v.paused && v.srcObject) await v.play().catch(() => undefined);
                    if (v.readyState < 2 || !v.videoWidth) return false;
                    const c = document.createElement('canvas');
                    c.width = 64;
                    c.height = 36;
                    const ctx = c.getContext('2d')!;
                    ctx.drawImage(v, 0, 0, c.width, c.height);
                    const px = ctx.getImageData(0, 0, c.width, c.height).data;
                    let sum = 0;
                    for (let i = 0; i < px.length; i += 4) sum += px[i] + px[i + 1] + px[i + 2];
                    return sum / (px.length / 4) / 3 > 10;
                }),
            { timeout: 10000 },
        )
        .toBe(true);
}

export const PhotoStatus = {
    initial: 'Use Take Photo, capture a clear face, then Save form.',
    cameraReady: 'Camera is ready. Click Capture.',
    cameraDenied: 'Could not access camera. Please allow permission.',
    noFace: /No face detected/i,
    captured: 'Photo captured. Submit the form to save photo.',
    noMatch: 'No matching patient found. You can save this photo.',
    faceMatchFailed: 'Face match check failed. You can still save this photo.',
    duplicate: /You cannot save this as a new registration/i,
} as const;

/**
 * The Patient Photo block at the top of /PatientForm (and /TibetPatientForm):
 *
 *   Take Photo  ->  live <video> from getUserMedia
 *   Capture     ->  frame drawn to a canvas, checked by face-api.js (TinyFaceDetector)
 *               ->  accepted: #patientPhotoBase64 filled, preview shown, Retake offered
 *               ->  POST /CommanController/searchPatientByFace, which blocks Save when
 *                   the face already belongs to another registered patient
 */
export class PatientPhotoSection {
    readonly takePhoto: Locator;
    readonly capture: Locator;
    readonly retake: Locator;
    readonly video: Locator;
    readonly preview: Locator;
    readonly placeholder: Locator;
    readonly status: Locator;
    readonly base64: Locator;
    /** "Patient Already Exists" - opened when the face matches another registered patient. */
    readonly faceMatchModal: Locator;
    readonly modalClose: Locator;
    readonly modalRetake: Locator;
    readonly modalUsePatient: Locator;

    constructor(private readonly page: Page) {
        this.takePhoto = page.locator('#openCameraBtn');
        this.capture = page.locator('#capturePatientPhotoBtn');
        this.retake = page.locator('#retakePatientPhotoBtn');
        this.video = page.locator('#patientCamera');
        this.preview = page.locator('#patientPhotoPreview');
        this.placeholder = page.locator('#patientCameraPlaceholder');
        this.status = page.locator('#patientPhotoStatus');
        this.base64 = page.locator('#patientPhotoBase64');
        this.faceMatchModal = page.locator('#faceMatchModal');
        this.modalClose = this.faceMatchModal.locator('button.fm-close');
        this.modalRetake = this.faceMatchModal.getByRole('button', { name: 'Retake Photo' });
        this.modalUsePatient = page.locator('#fmUsePatientBtn');
    }

    /** Waits for the duplicate-face lookup to answer; Save is refused while it is running. */
    async waitForFaceMatchCheck(): Promise<void> {
        await expect(this.status).not.toHaveText(/Checking face match/i, { timeout: 20000 });
    }

    /** Makes the camera refuse, the way a user clicking "Block" on the prompt would. */
    async denyCamera(): Promise<void> {
        await this.page.addInitScript(() => {
            navigator.mediaDevices.getUserMedia = () =>
                Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
        });
    }

    /**
     * Answers the duplicate-face lookup without touching the server, so a run does not
     * depend on whether the fixture face was registered by an earlier run.
     */
    async mockFaceMatch(result: 'no-match' | { patientId: string; patientName: string }): Promise<void> {
        await this.page.route('**/CommanController/searchPatientByFace', (route) =>
            route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify(
                    result === 'no-match'
                        ? { status: false, message: 'Patient not found' }
                        : { status: true, data: { PatientId: result.patientId, PatientName: result.patientName } },
                ),
            }),
        );
    }

    async expectInitial(): Promise<void> {
        await expect(this.takePhoto).toBeVisible();
        await expect(this.placeholder).toBeVisible();
        await expect(this.capture).toBeHidden();
        await expect(this.retake).toBeHidden();
        await expect(this.status).toHaveText(PhotoStatus.initial);
        await expect(this.base64).toHaveValue('');
    }

    async openCamera(): Promise<void> {
        await this.takePhoto.click();
        await expect(this.status).toHaveText(PhotoStatus.cameraReady, { timeout: 10000 });
        await this.expectLiveStream();
    }

    async expectLiveStream(): Promise<void> {
        await expect(this.video).toBeVisible();
        await expect(this.capture).toBeVisible();
        await expect(this.takePhoto).toBeHidden();
        await expect(this.placeholder).toBeHidden();
        await waitForLivePicture(this.video);
    }

    /** Captures, then waits for the face check to reach a verdict (the model loads on first use). */
    async captureAndWaitForVerdict(): Promise<void> {
        await this.capture.click();
        await expect(this.status).not.toHaveText(/Checking that a face is visible/i, { timeout: 30000 });
    }

    /**
     * Captures with a face in front of the camera, trying again on "No face detected" the way
     * a user would. What is under test is the form, not face-api.js's confidence on one frame.
     */
    async captureFace(attempts = 3): Promise<void> {
        for (let i = 1; i <= attempts; i++) {
            await this.captureAndWaitForVerdict();
            const status = await this.status.innerText();
            if (!PhotoStatus.noFace.test(status) || i === attempts) return;
            console.log(`Face capture attempt ${i}: "${status}" - capturing again`);
            await expect(this.capture).toBeEnabled();
        }
    }

    async expectPhotoAccepted(): Promise<void> {
        // Retake only appears once the photo is accepted; if it is missing, the status says why.
        await expect(this.retake, `Photo not accepted - status: "${await this.status.innerText()}"`).toBeVisible();
        await expect(this.preview).toBeVisible();
        await expect(this.preview).toHaveAttribute('src', /^(data:image|blob:)/);
        await expect(this.retake).toBeVisible();
        await expect(this.capture).toBeHidden();
        await expect(this.base64).toHaveValue(/^data:image\/jpeg;base64,.{1000,}/);
    }

    async expectPhotoRejected(message: string | RegExp): Promise<void> {
        await expect(this.status).toHaveText(message);
        await expect(this.base64).toHaveValue('');
        await expect(this.preview).toBeHidden();
        await expect(this.retake).toBeHidden();
        // The camera stays open so the user can try again.
        await expect(this.capture).toBeVisible();
        await expect(this.capture).toBeEnabled();
    }
}

/**
 * "Search Patient by Image" on /PatientSearch - the violet button beside Apply Filters. It
 * opens its own camera modal; a capture goes to the same face search as registration, and a
 * match fills the Patient Id and Patient Name filters, closes the modal and runs the search.
 */
export class PatientFaceSearch {
    readonly openButton: Locator;
    readonly modal: Locator;
    readonly takePhoto: Locator;
    readonly capture: Locator;
    readonly video: Locator;
    readonly status: Locator;
    readonly patientIdFilter: Locator;
    readonly patientNameFilter: Locator;

    constructor(private readonly page: Page) {
        this.openButton = page.locator('#rxFaceSearchBtn');
        this.modal = page.locator('#rxFaceSearchModal');
        this.takePhoto = page.locator('#rxFaceOpenCameraBtn');
        this.capture = page.locator('#rxFaceCaptureBtn');
        this.video = page.locator('#rxFaceCamera');
        this.status = page.locator('#rxFaceSearchStatus');
        const filters = page.locator('.rx-search form[name="search"]').first();
        this.patientIdFilter = filters.locator('[name="Id"], [name="PatientId"]').first();
        this.patientNameFilter = filters.locator('[name="PatientName"]').first();
    }

    async open(): Promise<void> {
        await this.openButton.click();
        await expect(this.modal).toHaveClass(/is-open/);
    }

    async openCamera(): Promise<void> {
        await this.takePhoto.click();
        await expect(this.status).toHaveText(PhotoStatus.cameraReady, { timeout: 10000 });
        await expect(this.capture).toBeVisible();
        await waitForLivePicture(this.video);
    }

    /** Captures, retrying on "No face detected" the way a user would. */
    async captureFace(attempts = 3): Promise<void> {
        for (let i = 1; i <= attempts; i++) {
            await this.capture.click();
            await expect(this.status).not.toHaveText(/Checking that a face is visible/i, { timeout: 30000 });
            const status = await this.status.innerText();
            if (!PhotoStatus.noFace.test(status) || i === attempts) return;
            console.log(`Face search capture attempt ${i}: "${status}" - capturing again`);
            await expect(this.capture).toBeEnabled();
        }
    }

    /**
     * A match closes the modal and applies it to the filters; the list then reloads showing
     * that patient. Returns the patient ID the face search found.
     */
    async expectMatchApplied(expected: { name: string; id?: string }): Promise<string> {
        await expect(this.modal, `Face search did not match - status: "${await this.status.innerText()}"`)
            .not.toHaveClass(/is-open/, { timeout: 20000 });
        await this.page.waitForLoadState();
        await expect(this.patientNameFilter).toHaveValue(expected.name, { timeout: 15000 });
        if (expected.id) {
            await expect(this.patientIdFilter).toHaveValue(expected.id);
        }
        await expect(this.page.locator('table').getByText(expected.name).first()).toBeVisible({ timeout: 15000 });
        return this.patientIdFilter.inputValue();
    }
}

/**
 * Whether a form submission carried the captured photo. The registration form holds a file
 * input, so it is posted as multipart - which Playwright's postData() returns as null - and
 * the photo travels as the patientPhotoBase64 field.
 */
export function photoSentWith(request: Request): boolean {
    const body = request.postDataBuffer()?.toString('latin1') ?? '';
    return (
        /name="patientPhotoBase64"\r\n\r\ndata:image\/jpeg;base64,/.test(body)
        || /patientPhotoBase64=data%3Aimage%2Fjpeg%3Bbase64/.test(body)
    );
}
