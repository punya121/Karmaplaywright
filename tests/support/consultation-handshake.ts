import fs from 'fs';
import path from 'path';

/**
 * How the centre and doctor workers talk when they run at the same time.
 *
 * Playwright workers do not share memory, so the pair writes two small files under
 * test-results/consultation-handshake/:
 *
 *   doctor-ready.json  — the doctor is on duty; the centre can assign
 *   assigned.json      — the centre has handed this patient over; the doctor can open them
 *
 * Gated on E2E_PARALLEL_CONSULTATION=1 so a standalone full-consultation or
 * doctor-consultation:only run does not wait on a worker that is not there.
 *
 * The path is fixed on purpose. reporting/run-context.ts's RUN_ID is minted per process
 * unless E2E_RUN_ID is set, so two workers would never see the same folder.
 */

export function isParallelConsultation(): boolean {
    return process.env.E2E_PARALLEL_CONSULTATION === '1';
}

export const HANDSHAKE_DIR = path.resolve(
    process.cwd(),
    'test-results',
    'consultation-handshake'
);

const DOCTOR_READY_FILE = path.join(HANDSHAKE_DIR, 'doctor-ready.json');
const ASSIGNED_FILE = path.join(HANDSHAKE_DIR, 'assigned.json');

/** Matches the paced full-consultation timeout: registration at slowMo 800 is slow. */
const DEFAULT_TIMEOUT_MS = 900000;
const POLL_MS = 1000;

export type AssignedConsultation = {
    displayId: string;
    prescriptionId: string;
};

export function clearConsultationHandshake(): void {
    fs.rmSync(HANDSHAKE_DIR, { recursive: true, force: true });
}

function ensureDir(): void {
    fs.mkdirSync(HANDSHAKE_DIR, { recursive: true });
}

export function signalDoctorReady(): void {
    ensureDir();
    fs.writeFileSync(
        DOCTOR_READY_FILE,
        JSON.stringify({ at: new Date().toISOString() }),
        'utf8'
    );
}

export function signalAssigned(assigned: AssignedConsultation): void {
    ensureDir();
    fs.writeFileSync(
        ASSIGNED_FILE,
        JSON.stringify({ ...assigned, at: new Date().toISOString() }),
        'utf8'
    );
}

async function waitForFile(file: string, timeoutMs: number, message: string): Promise<string> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (fs.existsSync(file)) {
            return fs.readFileSync(file, 'utf8');
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }

    throw new Error(message);
}

export async function waitForDoctorReady(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
    await waitForFile(
        DOCTOR_READY_FILE,
        timeoutMs,
        `The doctor worker did not signal ready within ${timeoutMs}ms ` +
            `(no ${path.relative(process.cwd(), DOCTOR_READY_FILE)}). ` +
            'Run both projects together with --workers=2 and E2E_PARALLEL_CONSULTATION=1.'
    );
}

export async function waitForAssigned(
    timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<AssignedConsultation> {
    const raw = await waitForFile(
        ASSIGNED_FILE,
        timeoutMs,
        `The centre worker did not signal an assignment within ${timeoutMs}ms ` +
            `(no ${path.relative(process.cwd(), ASSIGNED_FILE)}). ` +
            'Run both projects together with --workers=2 and E2E_PARALLEL_CONSULTATION=1.'
    );

    const parsed = JSON.parse(raw) as AssignedConsultation;

    if (!parsed.displayId) {
        throw new Error(
            `${path.relative(process.cwd(), ASSIGNED_FILE)} has no displayId, so the ` +
                'doctor worker does not know which queue row to open'
        );
    }

    return parsed;
}
