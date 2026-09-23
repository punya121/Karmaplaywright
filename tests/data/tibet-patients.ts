import { randomInt } from '../pages/selectize';
import { type PatientCaseHistoryData, vitalsForAge } from './patients';

/**
 * The severity indicator the Tibet case history carries and the other centres do not:
 * four required Yes/No answers the nursing staff give the doctor as a steer.
 */
export type TibetSeverityIndicator = {
    injectionRequired: boolean;
    dripRequired: boolean;
    testRequired: boolean;
    highPriority: boolean;
};

/**
 * The Tibet case history is the same form as every other centre's - the same vitals,
 * symptoms and point-of-care grid - plus the severity indicator, and minus the transport
 * mode. See TibetCaseHistoryPage.
 */
export type TibetCaseHistoryData = PatientCaseHistoryData & TibetSeverityIndicator;

export type TibetPatientRegistrationData = {
    name: string;
    parent: string;
    age: string;
    ageUnit: 'Years' | 'Months';
    gender: 'Male' | 'Female' | 'Others';
    maritalStatus: 'Married' | 'NotMarried' | 'Others';
    occupation: string;
    /** Green Book Number — a Tibetan settlement record only this centre's form asks for. */
    greenBookNumber: string;
    /** Destitute (Nyamthak) Number. The field's pattern rejects spaces and punctuation. */
    nyamthakNumber: string;
    landmark: string;
    nationality: string;
    mobile: string;
    aadhaar: string;
    caseHistory: TibetCaseHistoryData;
};

function coin(): boolean {
    return Math.random() < 0.5;
}

export function createSaveTibetPatient(): TibetPatientRegistrationData {
    const suffix = Date.now().toString().slice(-8);

    // TibetPatientForm carries min=5 on the age box when the unit is years, and the
    // vitals the case history will be filled with are drawn from the age that comes out
    // of here - an adult's resting pulse would be bradycardia in a child.
    const age = randomInt(18, 70);
    const gender = (['Male', 'Female', 'Others'] as const)[randomInt(0, 2)];

    return {
        name: `Tibet Rec ${suffix}`,
        parent: 'Rec',
        age: String(age),
        ageUnit: 'Years',
        gender,
        // Marital status has to follow the age, or a child is registered married.
        maritalStatus: age >= 21 ? 'Married' : 'NotMarried',
        // A preference rather than a requirement: the occupation list is the centre's
        // own, so TibetRegistrationPage takes this when it is offered and picks whatever
        // the control does offer when it is not.
        occupation: 'Farming',
        // Alphanumeric, no spaces — the Nyamthak box carries pattern="[a-zA-Z0-9]*" and
        // the browser blocks the submit over anything else.
        greenBookNumber: `GBN${suffix}`,
        nyamthakNumber: `NYT${suffix}`,
        landmark: `Landmark ${suffix}`,
        nationality: 'Tibetan',
        mobile: `9${suffix.padStart(9, '0').slice(-9)}`,
        aadhaar: `99999${suffix.slice(-7).padStart(7, '0')}`,
        caseHistory: {
            allergies: 'Not Known',
            ...vitalsForAge(age),
            // Temperature and oxygen saturation do not shift with age. Both are drawn
            // wide enough to land outside the normal band often enough to matter: an
            // abnormal reading is what raises the "Do you want to save the abnormal
            // vitals/ symptoms/ test results?" confirm this flow has to answer with OK.
            temperature: String(randomInt(97, 104)),
            spo2: String(randomInt(90, 100)),
            symptomCount: randomInt(3, 4),
            testCount: randomInt(3, 4),
            minTestValue: 0,
            maxTestValue: 100,
            injectionRequired: coin(),
            dripRequired: coin(),
            testRequired: coin(),
            highPriority: coin(),
        },
    };
}
