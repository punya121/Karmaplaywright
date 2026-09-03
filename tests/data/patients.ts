function randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomValue(min: number, max: number): string {
    return String(randomInt(min, max));
}

type Range = [number, number];

type VitalBand = {
    /** Upper bound of the band, in years. */
    upTo: number;
    weight: Range;
    height: Range;
    pulse: Range;
    respiratoryRate: Range;
    highBp: Range;
    lowBp: Range;
};

/**
 * Vitals only mean anything against the patient's age — a six-year-old does not
 * weigh 85kg, and an adult's resting pulse would be bradycardia in an infant — so
 * every run draws them from the band its randomly generated age falls into rather
 * than from one adult-shaped range.
 */
const vitalBands: VitalBand[] = [
    {
        upTo: 1,
        weight: [3, 10],
        height: [50, 76],
        pulse: [100, 160],
        respiratoryRate: [30, 53],
        highBp: [72, 104],
        lowBp: [50, 65],
    },
    {
        upTo: 4,
        weight: [10, 18],
        height: [76, 105],
        pulse: [90, 140],
        respiratoryRate: [22, 37],
        highBp: [86, 106],
        lowBp: [50, 70],
    },
    {
        upTo: 12,
        weight: [18, 45],
        height: [105, 150],
        pulse: [70, 120],
        respiratoryRate: [18, 30],
        highBp: [95, 115],
        lowBp: [55, 75],
    },
    {
        upTo: 17,
        weight: [45, 70],
        height: [150, 178],
        pulse: [60, 100],
        respiratoryRate: [12, 20],
        highBp: [105, 125],
        lowBp: [60, 80],
    },
    {
        upTo: Number.POSITIVE_INFINITY,
        weight: [45, 110],
        height: [150, 190],
        pulse: [60, 100],
        respiratoryRate: [12, 20],
        highBp: [100, 140],
        lowBp: [60, 90],
    },
];

function vitalsForAge(ageYears: number) {
    const band =
        vitalBands.find((candidate) => ageYears <= candidate.upTo) ??
        vitalBands[vitalBands.length - 1];

    return {
        weight: randomValue(...band.weight),
        height: randomValue(...band.height),
        pulse: randomValue(...band.pulse),
        respiratoryRate: randomValue(...band.respiratoryRate),
        highBp: randomValue(...band.highBp),
        lowBp: randomValue(...band.lowBp),
    };
}

export type PatientCaseHistoryData = {
    // Nursing staff, transport mode, symptoms, duration, severity and the PoC tests are
    // all picked at random from the live dropdowns rather than pinned here, so a run is
    // never tied to a value that only exists in one environment.
    /** Required on the form (the label carries a *), so the save fails without it. */
    allergies: 'Known' | 'Not Known';
    weight: string;
    height: string;
    highBp: string;
    lowBp: string;
    pulse: string;
    temperature: string;
    respiratoryRate: string;
    spo2: string;
    /** How many distinct symptoms this run adds (3-4). */
    symptomCount: number;
    /** How many distinct [PoC] tests this run adds (3-4). */
    testCount: number;
    minTestValue: number;
    maxTestValue: number;
};

export type PatientRegistrationData = {
    name: string;
    parent: string;
    age: string;
    ageUnit: 'years' | 'months';
    village: string;
    gender: string;
    married: boolean;
    mobile: string;
    aadhaar: string;
    caseHistory?: PatientCaseHistoryData;
};

export function createSavePatient(): PatientRegistrationData {
    const suffix = Date.now().toString().slice(-8);
    const ageYears = randomInt(1, 80);

    return {
        name: `Abhinav Rec ${suffix}`,
        parent: 'Rec',
        age: String(ageYears),
        ageUnit: 'years',
        village: 'Dhaula',
        gender: 'Male',
        // Marital status has to follow the age too, or a child gets registered married.
        married: ageYears >= 21,
        mobile: `9${suffix.padStart(9, '0').slice(-9)}`,
        aadhaar: `99999${suffix.slice(-7).padStart(7, '0')}`,
        caseHistory: {
            allergies: 'Not Known',
            ...vitalsForAge(ageYears),
            // Temperature and oxygen saturation do not shift with age.
            temperature: randomValue(97, 104),
            spo2: randomValue(90, 100),
            symptomCount: randomInt(3, 4),
            testCount: randomInt(3, 4),
            minTestValue: 0,
            maxTestValue: 100,
        },
    };
}
