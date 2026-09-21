import { createConsultation, type ConsultationData } from './consultations';
import {
    createSavePatient,
    vitalsForAge,
    type PatientCaseHistoryData,
    type PatientRegistrationData,
} from './patients';

function randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickRandom<T>(items: readonly T[]): T {
    return items[Math.floor(Math.random() * items.length)];
}

function chance(probability = 0.5): boolean {
    return Math.random() < probability;
}

/** A date `days` before today, as the yyyy-mm-dd a date input takes. */
function isoDaysAgo(days: number): string {
    const date = new Date();
    date.setDate(date.getDate() - days);
    return date.toISOString().slice(0, 10);
}

function isoDaysAfter(iso: string, days: number): string {
    const date = new Date(`${iso}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

function randomMobile(): string {
    return `${randomInt(6, 9)}${String(randomInt(0, 999999999)).padStart(9, '0')}`;
}

const firstNames = ['Lakshmi', 'Priya', 'Kavitha', 'Meena', 'Anjali', 'Revathi', 'Sunita', 'Deepa'];
const lastNames = ['Devi', 'Kumari', 'R', 'S', 'Bai', 'M'];

function randomWorkerName(role: string): string {
    return `${pickRandom(firstNames)} ${pickRandom(lastNames)} (${role})`;
}

/** The Yes / No / Not Applicable-Unknown radios of the gynaecology block, by value. */
export type GynaeAnswer = '1' | '0' | '2';

/** A community health worker the ANC / PNC forms ask for, by name and phone. */
export type HealthWorker = { name: string; phone: string };

type CommonMaternalVisit = {
    /** Today's readings, as free-text boxes. */
    hb: string;
    rbs: string;
    bp: string;
    weight: string;
    pulseRate: string;
    takingIfa: boolean;
    ifaReason: string;
    aww: HealthWorker;
    asha: HealthWorker;
    anm: HealthWorker;
};

export type AncDetails = CommonMaternalVisit & {
    type: 'ANC';
    /** yyyy-mm-dd. The same day as the gynaecology block's last menstruation cycle. */
    lmp: string;
    /** yyyy-mm-dd, LMP + 280 days. */
    edd: string;
    /** 1-3, worked out from the weeks since LMP. Required when the type is ANC. */
    trimester: '1' | '2' | '3';
    tt1: boolean;
    tt2: boolean;
    usg: string;
    noOfPregnancies: string;
    /** Only asked about when she has had a child before. */
    lastDeliveryConducted: 'Home' | 'Institution' | null;
    placeOfLastDelivery: 'Govt Hospital' | 'Private Hospital';
    previousBirthHistory: 'Live Birth' | 'Still Birth' | 'MTP' | null;
    anyAbortion: 'Yes' | 'No';
    currentDeliveryPlanned: 'Home' | 'Institution';
    placeOfCurrentDelivery: 'Govt Hospital' | 'Private Hospital';
    complications: string;
};

export type PncDetails = CommonMaternalVisit & {
    type: 'PNC';
    /** yyyy-mm-dd, within the last six weeks. */
    dateOfDelivery: string;
    trimester: '1' | '2' | '3';
    birthStatus: 'Live Birth';
    newbornGender: 'Male' | 'Female' | 'Others';
    placeOfDelivery: 'Home' | 'Institution';
    placeOfDeliveryInstitution: 'Govt Hospital' | 'Private Hospital';
    typeOfDelivery: 'Normal' | 'Caesarean';
    criedImmediately: 'Yes' | 'No';
    breastFedWithinAnHour: 'Yes' | 'No';
    childWeight: string;
    immunization: string;
};

/**
 * Everything the form asks a woman of 14-49 that it asks nobody else: the gynaecology
 * block (cycle, pregnancy, children, last delivery, miscarriage, sterilisation) and then
 * either an antenatal (ANC) or a postnatal (PNC) visit.
 *
 * The answers are random but have to agree with each other, the way a real history
 * would: a woman on an ANC visit is pregnant and not sterilised, her LMP decides her EDD
 * and her trimester; a woman on a PNC visit has just delivered, so she has at least one
 * child and her last delivery is that one.
 */
export type FemaleHealthData = {
    /** yyyy-mm-dd. */
    lastMenstrual: string;
    irregularPeriods: GynaeAnswer;
    /** Months, when the cycle is irregular. */
    irregularSinceMonths: string;
    isPregnant: GynaeAnswer;
    children: number;
    /** Where she has children, whether the last delivery's details are known. */
    lastDelivery: { date: string; type: 'Normal' | 'Cesarean' | 'Not Applicable/Unknown' } | null;
    isMiscarriage: GynaeAnswer;
    isSterilised: GynaeAnswer;
    visit: AncDetails | PncDetails;
};

function maternalReadings(caseHistory: PatientCaseHistoryData): CommonMaternalVisit {
    const takingIfa = chance(0.7);

    return {
        hb: (randomInt(100, 135) / 10).toFixed(1),
        rbs: String(randomInt(80, 140)),
        bp: `${caseHistory.highBp}/${caseHistory.lowBp}`,
        weight: caseHistory.weight,
        pulseRate: caseHistory.pulse,
        takingIfa,
        ifaReason: takingIfa ? '' : pickRandom(['Nausea', 'Not available', 'Forgot to take']),
        aww: { name: randomWorkerName('AWW'), phone: randomMobile() },
        asha: { name: randomWorkerName('ASHA'), phone: randomMobile() },
        anm: { name: randomWorkerName('ANM'), phone: randomMobile() },
    };
}

function createFemaleHealth(caseHistory: PatientCaseHistoryData): FemaleHealthData {
    const irregularPeriods = pickRandom<GynaeAnswer>(['1', '0', '2']);
    const irregularSinceMonths = irregularPeriods === '1' ? String(randomInt(1, 6)) : '0';
    const isMiscarriage = pickRandom<GynaeAnswer>(['1', '0', '2']);

    // E2E_SMILE_VISIT=ANC|PNC pins which visit a female run is on; otherwise it is drawn.
    const pinnedVisit = process.env['E2E_SMILE_VISIT'];
    const antenatal = pinnedVisit === 'ANC' || pinnedVisit === 'PNC' ? pinnedVisit === 'ANC' : chance();

    if (antenatal) {
        // Antenatal: 6 to 38 weeks along.
        const daysSinceLmp = randomInt(6 * 7, 38 * 7);
        const weeks = Math.floor(daysSinceLmp / 7);
        const lmp = isoDaysAgo(daysSinceLmp);
        const children = randomInt(0, 3);
        const lastDelivery =
            children > 0
                ? {
                      date: isoDaysAgo(randomInt(2 * 365, 8 * 365)),
                      type: pickRandom(['Normal', 'Cesarean'] as const),
                  }
                : null;

        return {
            lastMenstrual: lmp,
            irregularPeriods,
            irregularSinceMonths,
            isPregnant: '1',
            children,
            lastDelivery,
            isMiscarriage,
            // Sterilisation and a current pregnancy do not go together.
            isSterilised: '0',
            visit: {
                type: 'ANC',
                ...maternalReadings(caseHistory),
                lmp,
                edd: isoDaysAfter(lmp, 280),
                trimester: weeks <= 12 ? '1' : weeks <= 27 ? '2' : '3',
                tt1: chance(0.8),
                tt2: chance(0.5),
                usg: pickRandom(['Normal', 'Single live intrauterine foetus', 'Not done']),
                noOfPregnancies: String(children + 1),
                lastDeliveryConducted:
                    children > 0 ? pickRandom(['Home', 'Institution'] as const) : null,
                placeOfLastDelivery: pickRandom(['Govt Hospital', 'Private Hospital'] as const),
                previousBirthHistory:
                    children > 0 ? pickRandom(['Live Birth', 'Still Birth', 'MTP'] as const) : null,
                anyAbortion: isMiscarriage === '1' ? 'Yes' : 'No',
                currentDeliveryPlanned: pickRandom(['Home', 'Institution'] as const),
                placeOfCurrentDelivery: pickRandom(['Govt Hospital', 'Private Hospital'] as const),
                complications: pickRandom(['None', 'Mild anaemia', 'Nausea and vomiting']),
            },
        };
    }

    // Postnatal: delivered within the last six weeks.
    const dateOfDelivery = isoDaysAgo(randomInt(2, 42));
    const typeOfDelivery = pickRandom(['Normal', 'Caesarean'] as const);

    return {
        lastMenstrual: isoDaysAgo(randomInt(280, 330)),
        irregularPeriods,
        irregularSinceMonths,
        isPregnant: '0',
        children: randomInt(1, 4),
        lastDelivery: {
            date: dateOfDelivery,
            // The gynaecology block spells it "Cesarean", the PNC form "Caesarean".
            type: typeOfDelivery === 'Caesarean' ? 'Cesarean' : 'Normal',
        },
        isMiscarriage,
        isSterilised: pickRandom<GynaeAnswer>(['1', '0']),
        visit: {
            type: 'PNC',
            ...maternalReadings(caseHistory),
            dateOfDelivery,
            trimester: '3',
            birthStatus: 'Live Birth',
            newbornGender: pickRandom(['Male', 'Female'] as const),
            placeOfDelivery: pickRandom(['Home', 'Institution'] as const),
            placeOfDeliveryInstitution: pickRandom(['Govt Hospital', 'Private Hospital'] as const),
            typeOfDelivery,
            criedImmediately: chance(0.9) ? 'Yes' : 'No',
            breastFedWithinAnHour: chance(0.8) ? 'Yes' : 'No',
            childWeight: (randomInt(25, 40) / 10).toFixed(1),
            immunization: pickRandom(['BCG, OPV-0, Hep-B', 'BCG', 'OPV-0, Hep-B', 'Pending']),
        },
    };
}

/**
 * Everything the SMILE centre's Registration > Prescription form takes in one go: the
 * patient, the vitals / symptoms / PoC tests a case history would hold, the doctor's
 * half - diagnoses, medicines, diagnostic tests, referral, review - and, for a woman, the
 * gynaecology and ANC / PNC sections.
 *
 * It is the same data the separate screens are filled from elsewhere (createSavePatient()
 * and createConsultation()), so a run here is as random as a run of those: a fresh
 * patient, vitals drawn from the band their age falls in, and every symptom, test,
 * medicine and department picked out of the live dropdowns while the form is filled.
 */
export type SmilePrescriptionData = {
    patient: PatientRegistrationData;
    caseHistory: PatientCaseHistoryData;
    consultation: ConsultationData;
    /** How many provisional diagnoses this run records (2-3). */
    diagnosisCount: number;
    /** Set for a female patient, null for a male one. */
    female: FemaleHealthData | null;
};

export type SmilePrescriptionOptions = {
    /** Pin the gender instead of drawing it. E2E_SMILE_GENDER=Female|Male does the same. */
    gender?: 'Male' | 'Female';
};

export function createSmilePrescription(
    options: SmilePrescriptionOptions = {}
): SmilePrescriptionData {
    // Adults only. Under-fives are registered in months and bring a MUAC reading and a
    // screening checklist onto this form that the SMILE flow does not cover.
    const base = createSavePatient({ underFive: false });
    const suffix = Date.now().toString().slice(-8);

    const pinned = options.gender ?? process.env['E2E_SMILE_GENDER'];
    const gender: 'Male' | 'Female' =
        pinned === 'Female' || pinned === 'Male' ? pinned : chance() ? 'Female' : 'Male';

    if (!base.caseHistory) {
        throw new Error('createSavePatient() returned no case history data');
    }

    let caseHistory = base.caseHistory;
    let age = base.age;
    let married = base.married;

    if (gender === 'Female') {
        // The form only shows the gynaecology and ANC / PNC sections to a woman of 14-49,
        // so a female patient is drawn from inside that range - and as someone on an ANC
        // or PNC visit, married. Her vitals are redrawn for the new age.
        const ageYears = randomInt(21, 45);
        age = String(ageYears);
        married = true;
        caseHistory = { ...caseHistory, ...vitalsForAge(ageYears) };
    }

    return {
        patient: {
            ...base,
            name: `Smile Rec ${suffix}`,
            parent: `Smile Parent ${suffix.slice(-4)}`,
            gender,
            age,
            married,
            // The village list is the centre's own, so it is picked from the dropdown on
            // the form rather than named here. See SmilePrescriptionPage.selectVillage().
            village: '',
            // The form checks Aadhaar for duplicates as soon as it is entered, so it has
            // to be new every run: 12 digits, led by a 2-9 the way a real one is.
            aadhaar: `${2 + (Number(suffix.slice(-1)) % 8)}${suffix.padStart(11, '0').slice(-11)}`,
        },
        caseHistory,
        consultation: createConsultation(),
        diagnosisCount: randomInt(2, 3),
        female: gender === 'Female' ? createFemaleHealth(caseHistory) : null,
    };
}
