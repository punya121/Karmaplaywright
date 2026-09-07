import path from 'path';
import type { Suite, TestCase } from '@playwright/test/reporter';
import { FOLDER_TO_MODULE, UNCATEGORISED_MODULE } from './module-map';

/**
 * Works out which application module a test belongs to.
 *
 * Priority (first match wins):
 *   1. An explicit annotation:  test('...', { annotation: { type: 'module', description: 'Billing' } }, ...)
 *   2. A describe title ending in "Module":  test.describe('Patient Module', ...)  -> "Patient"
 *   3. The folder the spec lives in:  tests/patient/foo.spec.ts                    -> "Patient"
 *   4. Fallback: "General"
 *
 * Nothing here has to change when a new module folder is added — see module-map.ts.
 */

/** `create-patient` / `lab_reports` -> `Create Patient` / `Lab Reports`. */
function toTitleCase(raw: string): string {
    return raw
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

/** The `test.describe()` titles wrapping a test, outermost first. */
function describeTitles(test: TestCase): string[] {
    const titles: string[] = [];

    for (let suite: Suite | undefined = test.parent; suite; suite = suite.parent) {
        // Stop at the file suite — above it are only the project and root suites.
        if (suite.type !== 'describe') break;
        if (suite.title) titles.unshift(suite.title);
    }
    return titles;
}

/** 1. An explicit `module` annotation on the test or one of its parent suites. */
function fromAnnotation(test: TestCase): string | undefined {
    const hit = test.annotations.find(
        (a) => a.type.toLowerCase() === 'module' && a.description?.trim(),
    );
    return hit?.description?.trim();
}

/** 2. A `test.describe()` title that names the module, e.g. 'Patient Module'. */
function fromDescribeTitle(test: TestCase): string | undefined {
    for (const title of describeTitles(test)) {
        const match = title.match(/^\s*(.+?)\s+module\s*$/i);
        if (match) return toTitleCase(match[1]);
    }
    return undefined;
}

/** 3. The first folder under the test root, e.g. tests/patient/... -> 'Patient'. */
function fromFolder(test: TestCase, testRootDir: string): string | undefined {
    const relative = path.relative(testRootDir, test.location.file);
    const segments = relative.split(/[\\/]/).filter(Boolean);

    // Last segment is the file itself; anything before it is a folder.
    if (segments.length < 2 || segments[0] === '..') return undefined;

    const folder = segments[0];
    return FOLDER_TO_MODULE[folder.toLowerCase()] ?? toTitleCase(folder);
}

export function resolveModule(test: TestCase, testRootDir: string): string {
    return (
        fromAnnotation(test) ??
        fromDescribeTitle(test) ??
        fromFolder(test, testRootDir) ??
        UNCATEGORISED_MODULE
    );
}

/**
 * The readable name of the test case: the describe titles plus the test title,
 * e.g. 'Patient registration Save > Fills and saves the form'.
 */
export function resolveTestCaseName(test: TestCase): string {
    return [...describeTitles(test), test.title].join(' > ');
}
