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
};

export function createSavePatient(): PatientRegistrationData {
    const suffix = Date.now().toString().slice(-8);

    return {
        name: `Abhinav Rec ${suffix}`,
        parent: 'Rec',
        age: '4',
        ageUnit: 'years',
        village: 'Dhaula',
        gender: 'Male',
        married: true,
        mobile: `9${suffix.padStart(9, '0').slice(-9)}`,
        aadhaar: `99999${suffix.slice(-7).padStart(7, '0')}`,
    };
}
