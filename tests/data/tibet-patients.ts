export type TibetPatientRegistrationData = {
    name: string;
    parent: string;
    age: string;
    ageUnit: 'Years' | 'Months';
    gender: 'Male' | 'Female' | 'Others';
    maritalStatus: 'Married' | 'NotMarried' | 'Others';
    occupation: string;
    landmark: string;
    nationality: string;
    mobile: string;
    aadhaar: string;
};

export function createSaveTibetPatient(): TibetPatientRegistrationData {
    const suffix = Date.now().toString().slice(-8);

    return {
        name: `Tibet Rec ${suffix}`,
        parent: 'Rec',
        age: '30',
        ageUnit: 'Years',
        gender: 'Male',
        maritalStatus: 'Married',
        occupation: 'Farming',
        landmark: `Landmark ${suffix}`,
        nationality: 'Tibetan',
        mobile: `9${suffix.padStart(9, '0').slice(-9)}`,
        aadhaar: `99999${suffix.slice(-7).padStart(7, '0')}`,
    };
}
