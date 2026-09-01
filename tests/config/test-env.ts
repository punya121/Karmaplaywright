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
