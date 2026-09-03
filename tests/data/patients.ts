const symptomOptions = [
    'Abdominal Bloating',
    'Abnormal eye movements (nystagmus)',
    'Anxiety',
    'Back Pain',
    'Chest Pain',
    'Cough with Expectoration',
    'Fever',
    'Headache',
    'Nausea',
    'Vomiting',
];

const testNameOptions = [
    '[PoC] 6 Lead Electro Cardio Gram (ECG)',
    '[PoC] HbA1c',
    '[PoC] Random Blood Sugar Strip Test',
];

function pickRandom<T>(items: T[]): T {
    return items[Math.floor(Math.random() * items.length)];
}

export type PatientCaseHistoryData = {
    weight: string;
    height: string;
    highBp: string;
    lowBp: string;
    pulse: string;
    temperature: string;
    respiratoryRate: string;
    spo2: string;
    symptom: string;
    symptomDurationValue: string;
    symptomDurationUnit: 'Days' | 'Months';
    symptomSeverity: string;
    secondSymptom: string;
    secondSymptomDurationValue: string;
    secondSymptomDurationUnit: 'Days' | 'Months';
    secondSymptomSeverity: string;
    testName: string;
    testValue: string;
    followUpTestName: string;
    followUpTestValue: string;
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
    const testName = pickRandom(testNameOptions);
    const followUpTestName = pickRandom(testNameOptions.filter((name) => name !== testName));
    const firstSymptom = pickRandom(symptomOptions);
    const secondSymptom = pickRandom(symptomOptions.filter((symptom) => symptom !== firstSymptom));

    return {
        name: `Abhinav Rec ${suffix}`,
        parent: 'Rec',
        age: '30',
        ageUnit: 'years',
        village: 'Dhaula',
        gender: 'Male',
        married: true,
        mobile: `9${suffix.padStart(9, '0').slice(-9)}`,
        aadhaar: `99999${suffix.slice(-7).padStart(7, '0')}`,
        caseHistory: {
            weight: '85',
            height: '176',
            highBp: '90',
            lowBp: '80',
            pulse: '72',
            temperature: '98',
            respiratoryRate: '17',
            spo2: '98',
            symptom: firstSymptom,
            symptomDurationValue: '1',
            symptomDurationUnit: 'Days',
            symptomSeverity: 'Mild',
            secondSymptom,
            secondSymptomDurationValue: '2',
            secondSymptomDurationUnit: 'Months',
            secondSymptomSeverity: 'Mild',
            testName,
            testValue: '0',
            followUpTestName,
            followUpTestValue: '7',
        },
    };
}
