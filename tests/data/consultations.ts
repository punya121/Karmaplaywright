/**
 * Test data keeps its own dice, the way tests/data/patients.ts does, so the data layer
 * never has to reach into a page object for them.
 */
function randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickRandom<T>(items: T[]): T {
    return items[Math.floor(Math.random() * items.length)];
}

/**
 * What a doctor's consultation is made of, in the shape the prescription form wants it.
 *
 * Nothing here names a medicine, a test, a department or a diagnosis. Those come out of
 * the live dropdowns at random while the form is being filled, because the catalogue
 * differs per environment and per centre - a medicine pinned here would pass on UAT and
 * fail everywhere else. What this file decides is only how *much* of the form a run
 * fills and what to type into the boxes that have no dropdown behind them.
 */
export type ConsultationData = {
    /** How many symptoms this run records (1-3). */
    symptomCount: number;
    /** How many prescription rows it writes (1-3). */
    medicineCount: number;
    /** How many diagnostic tests it orders (1-3). */
    diagnosticTestCount: number;
    /** Whether it also adds an over-the-counter medicine. */
    includeOtc: boolean;
    /** Whether it refers the patient on to another department. */
    includeReferral: boolean;
    /** Free text for the provisional diagnosis box when it takes typed input. */
    provisionalDiagnosis: string;
    /** Fallbacks for the dosage columns, used only where the column is not a picklist. */
    dosage: string;
    frequency: string;
    duration: string;
    instruction: string;
    /** Advice / remarks, where the form has such a box. */
    advice: string;
};

const complaints = [
    'Fever',
    'Cough',
    'Headache',
    'Body ache',
    'Sore throat',
    'Abdominal pain',
    'Fatigue',
    'Dizziness',
    'Loose motion',
    'Cold',
];

const qualifiers = ['acute', 'mild', 'moderate', 'suspected', 'recurrent', 'resolving'];

const adviceLines = [
    'Plenty of oral fluids and rest',
    'Review after the course is completed',
    'Return immediately if symptoms worsen',
    'Light diet, avoid outside food',
    'Continue routine medication alongside',
];

const frequencies = ['1-0-1', '1-1-1', '0-0-1', '1-0-0', '0-1-0', '1-1-0'];
const instructions = ['After food', 'Before food', 'With water', 'At bedtime', 'Empty stomach'];

/**
 * A fresh set of choices for one run. Called per test, so two runs of the same spec
 * fill the form differently: different counts of rows, different typed text, and - once
 * the page objects get hold of it - different picks out of every dropdown.
 */
export function createConsultation(): ConsultationData {
    const stamp = Date.now().toString().slice(-6);

    return {
        symptomCount: randomInt(1, 3),
        medicineCount: randomInt(1, 3),
        diagnosticTestCount: randomInt(1, 3),
        includeOtc: Math.random() < 0.5,
        includeReferral: Math.random() < 0.5,
        // The stamp keeps a run's own diagnosis identifiable in the record afterwards,
        // and stops a free-text selectize from offering back the previous run's entry as
        // an existing option.
        provisionalDiagnosis: `${pickRandom(qualifiers)} ${pickRandom(complaints).toLowerCase()} ${stamp}`,
        dosage: `${randomInt(1, 2)}`,
        frequency: pickRandom(frequencies),
        duration: `${randomInt(3, 10)}`,
        instruction: pickRandom(instructions),
        advice: `${pickRandom(adviceLines)} (run ${stamp})`,
    };
}
