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

/**
 * The SMILE centre, whose Registration > Prescription screen registers a patient and
 * writes their prescription on one form, then approves it on the summary it saves to.
 * It is its own centre login - a different user to E2E_USERNAME - so it has keys of its
 * own. Read lazily, so a .env without them only fails the SMILE spec, not every spec
 * that imports this file.
 */
/**
 * The Tibet centre (Tibetan Telemedicine Services), whose screens are its own -
 * /TibetPatientForm, /TibetPrescriptionHistoryForm, /TibetCentreHome - rather than the
 * shared ones. It is a different login to E2E_USERNAME, so it has keys of its own, read
 * lazily so a .env without them only fails the Tibet specs.
 */
export function tibetCredentials(): { username: string; password: string } {
    return {
        username: requiredEnvironmentVariable('E2E_TIBET_USERNAME'),
        password: requiredEnvironmentVariable('E2E_TIBET_PASSWORD'),
    };
}

/**
 * The doctor the Tibet handover is made to, and the account that brings them on duty.
 *
 * A doctor who is not checked in cannot be assigned: Doctor Selection asks
 * GetAvailability_of_Doctor about the doctor being picked and swallows the click when
 * the answer is 0, so the Tibet runs check their doctor in the way the main consultation
 * flow does.
 *
 * The Tibet centre's Doctor Selection lists one doctor, and on UAT it is the same
 * account the other centres use - which is why these fall back to the doctor keys rather
 * than being required. Set the E2E_TIBET_DOCTOR_* keys where that stops being true.
 */
export function tibetDoctor(): { name: string; username: string; password: string } {
    return {
        name: process.env['E2E_TIBET_DOCTOR_NAME'] || process.env['E2E_DOCTOR_NAME'] || 'Dr. Demo',
        username: process.env['E2E_TIBET_DOCTOR_USERNAME'] || doctorUsername,
        password: process.env['E2E_TIBET_DOCTOR_PASSWORD'] || doctorPassword,
    };
}

export function smileCredentials(): { username: string; password: string } {
    return {
        username: requiredEnvironmentVariable('E2E_SMILE_USERNAME'),
        password: requiredEnvironmentVariable('E2E_SMILE_PASSWORD'),
    };
}
