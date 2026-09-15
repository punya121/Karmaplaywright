import { clearConsultationHandshake } from './consultation-handshake';

/**
 * Runs once before the workers start, so a leftover assigned.json from the last
 * headed run cannot make the doctor open yesterday's patient.
 */
export default async function globalSetup(): Promise<void> {
    clearConsultationHandshake();
}
