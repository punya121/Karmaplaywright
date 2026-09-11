function requiredEnvironmentVariable(name: string): string {
    const value = process.env[name];

    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }

    return value;
}

export const validUsername = requiredEnvironmentVariable('E2E_USERNAME');
export const validPassword = requiredEnvironmentVariable('E2E_PASSWORD');
export const inactiveUsername = requiredEnvironmentVariable('E2E_INACTIVE_USERNAME');
export const inactivePassword = requiredEnvironmentVariable('E2E_INACTIVE_PASSWORD');
export const wrongPassword = requiredEnvironmentVariable('E2E_WRONG_PASSWORD');
export const baseUrl = process.env['E2E_BASE_URL'] || 'https://uat.karmaprimaryhealthcare.in';

/**
 * The doctor the consultation specs sign in as. A doctor sees a different home page to
 * a centre user - their own queue of waiting patients, and a Check In / Check Out state
 * that decides whether prescriptions can be handed to them at all - so those runs need
 * an account with the doctor role rather than the general E2E_USERNAME.
 *
 * Falls back to E2E_USERNAME / E2E_PASSWORD so a .env that predates these keys still
 * works; set E2E_DOCTOR_USERNAME and E2E_DOCTOR_PASSWORD when the two differ.
 */
export const doctorUsername = process.env['E2E_DOCTOR_USERNAME'] || validUsername;
export const doctorPassword = process.env['E2E_DOCTOR_PASSWORD'] || validPassword;
