import { expect, test, type Locator, type Page } from '@playwright/test';
import { baseUrl, tibetCredentials } from '../config/test-env';
import { LoginPage } from '../pages/login.page';
import { TibetCaseHistoryPage } from '../pages/tibet-case-history.page';
import { guardAgainstStrayTabs } from '../pages/stray-tabs';
import { runModuleCases, type ModuleCase } from '../support/module-case';
import {
    describeProblems,
    serverErrorOnPage,
    watchPageHealth,
    type PageHealth,
} from '../support/page-health';

/**
 * The Tibet portal, every section of it, in a different order every run.
 *
 * The other Tibet specs each follow one journey: register a patient, raise a case
 * history, hand it to a doctor. They prove that path works and say nothing about the
 * rest of the portal - Patient Queue, Doctor Allocation, a patient's history, the search
 * filters. This is the other half. It visits every section the portal offers, checks
 * each one actually works rather than merely responds, and reports what it found on all
 * of them.
 *
 * Three things make it a bug finder rather than a click-through.
 *
 * It watches the browser, not just the DOM. The app is server-rendered with jQuery on
 * top, so its two usual failures leave a page that looks finished: a handler throws and
 * the rest of that script never runs, or a background request answers 500 and the grid it
 * was filling just stays empty. Every section is judged on its uncaught exceptions, its
 * failed responses and its rendered text as well as on what is visible. See
 * tests/support/page-health.ts.
 *
 * It checks each section against itself. A board that says "Prescriptions In Queue: 4"
 * and draws two rows is a bug no "did the page load" assertion catches, and the same goes
 * for a gender filter that returns the other gender, or a patient record whose name does
 * not match the row that opened it. Each section has a check of that kind.
 *
 * It keeps going. A sweep that stopped at the first broken screen would report one bug
 * per run when the point is to find them all in one pass, so a failed section is recorded
 * and the sweep moves on; the run fails at the end with every broken section named. Each
 * section is its own row in the Excel report either way - a module case per section - so
 * a reader sees "Tibet Patient Queue: Failed" beside "Tibet Doctor Allocation: Passed"
 * rather than one red line for the lot.
 *
 * ---------------------------------------------------------------------------
 * The random order
 * ---------------------------------------------------------------------------
 * The sections are shuffled. Screens in a server-rendered app share session state - a
 * filter kept in the session, an id left over from the last form - and a suite that
 * always walks them in the same order only ever proves that one order works. Shuffling
 * puts each section after a different neighbour on each run, which is how an order
 * dependence shows up at all.
 *
 * A shuffle nothing can reproduce is no use in a bug report, so the order comes from a
 * seed: printed at the start of the run, annotated on the test, and settable. A failed
 * run replays exactly by passing its seed back:
 *
 *     E2E_SWEEP_SEED=1745822391 npm run test:tibet-sweep
 *
 * ---------------------------------------------------------------------------
 * What it does not do
 * ---------------------------------------------------------------------------
 * Nothing here writes. It registers no patient, saves no case history and assigns no
 * doctor - every action is a page it opens, a filter it applies or a read-only popup it
 * raises - so it can be run against UAT as often as wanted without leaving records behind
 * or holding a doctor's queue. Creating a patient and taking them to a doctor is
 * tibet-full-consultation.spec.ts; this is what runs beside it.
 *
 * Doctor Selection is deliberately not swept. It is reachable only from a prescription
 * row nobody has been assigned to yet, and on a quiet day the grid has none - a sweep
 * that failed for that would be red for a reason that is not a bug. It is covered where
 * it belongs, in the consultation specs, which create such a row first.
 */

const origin = baseUrl.replace(/\/$/, '');

/* -------------------------------------------------------------------------- */
/* The seeded shuffle                                                          */
/* -------------------------------------------------------------------------- */

/** The seed for this run: E2E_SWEEP_SEED when given, otherwise a fresh one. */
function sweepSeed(): number {
    const given = process.env.E2E_SWEEP_SEED;

    if (given && /^\d+$/.test(given)) {
        return Number(given);
    }

    return Math.floor(Math.random() * 2 ** 31);
}

/**
 * mulberry32 - a small seeded generator. Math.random() cannot be seeded, and a shuffle
 * that cannot be replayed turns every intermittent failure into a ghost story.
 */
function randomFrom(seed: number): () => number {
    let state = seed >>> 0;

    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Fisher-Yates, on a copy - the declared list has to stay in the order it was written. */
function shuffled<T>(items: T[], random: () => number): T[] {
    const order = [...items];

    for (let i = order.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
    }

    return order;
}

function pickOne<T>(items: T[], random: () => number): T {
    return items[Math.floor(random() * items.length)];
}

/* -------------------------------------------------------------------------- */
/* Reading the app's grids                                                     */
/* -------------------------------------------------------------------------- */

type Grid = {
    /** The banner above the headers, e.g. "Count : 38" or "Prescriptions In Queue: 0". */
    caption: string;
    headers: string[];
    rows: string[][];
};

/**
 * Reads one of the app's `.gridtable` grids into plain text.
 *
 * Read in one evaluate() rather than through locators because the checks here are about
 * the data as a whole - does the count match the rows, does every row carry an id, did
 * the filter actually filter - and a locator per cell would be a round trip per cell on
 * a grid that can be a hundred of them.
 *
 * The grids are not consistently built: some put their header cells in a <thead>, some in
 * the first <tr>, and most carry a caption row above the headers with one cell spanning
 * the table. So the header row is found as the row with the most <th> in it, anything
 * above it is the caption, and the data is what follows.
 */
async function readGrid(page: Page, selector = 'table.gridtable'): Promise<Grid | null> {
    return page.evaluate((sel) => {
        const table = document.querySelector(sel);

        if (!table) {
            return null;
        }

        const text = (cell: Element): string =>
            ((cell as HTMLElement).innerText ?? cell.textContent ?? '').replace(/\s+/g, ' ').trim();

        const allRows = Array.from(table.querySelectorAll('tr'));

        let headerIndex = -1;
        let headers: string[] = [];

        allRows.forEach((row, index) => {
            const cells = Array.from(row.querySelectorAll('th'));

            if (cells.length > headers.length) {
                headers = cells.map(text);
                headerIndex = index;
            }
        });

        const caption = headerIndex > 0 ? text(allRows[0]) : '';

        const rows = allRows
            .slice(headerIndex + 1)
            .map((row) => Array.from(row.querySelectorAll('td')).map(text))
            .filter((cells) => cells.length > 1);

        return { caption, headers, rows };
    }, selector);
}

/** The index of a column by its header, or -1. Headers differ in case between screens. */
function columnIndex(grid: Grid, header: RegExp): number {
    return grid.headers.findIndex((name) => header.test(name));
}

/** The number a grid's caption claims it holds: "Count : 38" -> 38, "( 7 )" -> 7. */
function captionCount(caption: string): number | null {
    const match = /(\d+)\s*\)?\s*$/.exec(caption.replace(/\s+/g, ' ').trim());
    return match ? Number(match[1]) : null;
}

/* -------------------------------------------------------------------------- */
/* The sections                                                                */
/* -------------------------------------------------------------------------- */

type Section = {
    /** The module this section is reported under. */
    module: string;
    /** The reported case title. */
    title: string;
    path: string;
    documentTitle: RegExp;
    /** What has to be on screen for this section to count as rendered at all. */
    landmark(page: Page): Locator;
    /**
     * The section's own check: the thing that is true of this screen when it works and
     * false when it does not. Returns a line for the log saying what it found.
     */
    check(page: Page, random: () => number): Promise<string>;
};

/**
 * Every section the Tibet centre's menu and home tiles lead to. The discovery stage
 * holds the portal to this list, so a screen added to the menu tomorrow fails the sweep
 * rather than quietly going untested.
 */
const SECTIONS: Section[] = [
    {
        module: 'Tibet Home',
        title: 'Open Home and check every tile leads somewhere',
        path: '/TibetHome',
        documentTitle: /Home \| Tibetan Telemedicine Services/i,
        landmark: (page) => page.locator('#main-content'),
        check: async (page) => {
            // The tiles are the portal's front door. A tile whose href is empty, "#" or
            // javascript:void(0) is a dead tile - it looks like every other one and does
            // nothing when a nurse presses it, which is exactly the kind of bug that a
            // "did the page load" check never sees.
            const tiles = await page
                .locator('#main-content a[href]')
                .evaluateAll((links) =>
                    links.map((link) => ({
                        href: link.getAttribute('href') ?? '',
                        label: (link as HTMLElement).innerText.replace(/\s+/g, ' ').trim(),
                    }))
                );

            expect(tiles.length, 'The home page offers no tiles at all').toBeGreaterThan(0);

            const dead = tiles.filter(
                (tile) => !tile.href || tile.href === '#' || /^javascript:/i.test(tile.href)
            );
            expect(
                dead.map((tile) => tile.label || '(unlabelled tile)'),
                'Home tiles that lead nowhere'
            ).toEqual([]);

            const labelled = tiles.filter((tile) => tile.label);
            return `${labelled.length} tiles, all with a destination: ${labelled
                .map((tile) => tile.label)
                .join(', ')}`;
        },
    },
    {
        module: 'Tibet Patient Registration',
        title: 'Open the registration form and check its controls are there',
        path: '/TibetPatientForm',
        documentTitle: /Patient Registration \| Tibetan Telemedicine Services/i,
        landmark: (page) => page.locator('#patient_name'),
        check: async (page) => {
            // The fields this centre's form is its own for - a Green Book number and a
            // Destitute (Nyamthak) number - and the submit that leads to a case history.
            // A build that served the shared /PatientForm here instead would still
            // render, still have a name field, and be the wrong screen.
            const required: Array<[string, Locator]> = [
                ['patient name', page.locator('#patient_name')],
                ['age', page.locator('#patient_age')],
                ['Green Book number', page.locator('#gbn')],
                ['Nyamthak (Destitute) number', page.locator('#nyamthak')],
                ['occupation', page.locator('#occupation')],
            ];

            for (const [what, field] of required) {
                await expect(field, `The registration form has no ${what} field`).toHaveCount(1);
            }

            await expect(
                page.getByRole('button', { name: 'Add Case History' }),
                'The registration form offers no way into a case history'
            ).toBeVisible();

            // A blank form must not be carrying somebody else's id. This field is what
            // decides whether a save updates or inserts, so a stray value here is an edit
            // of another patient wearing a new patient's clothes.
            await expect(
                page.locator('#id'),
                'A blank registration form arrived carrying a patient id'
            ).toHaveValue('');

            const aadhaarRequired = await page
                .locator('#patient_aadhaar')
                .getAttribute('required')
                .then((value) => value !== null)
                .catch(() => false);

            return `the form is blank and complete; Aadhaar is ${
                aadhaarRequired ? 'required' : 'optional'
            } on this build`;
        },
    },
    {
        module: 'Tibet Patient Search',
        title: 'Open Search Patient and check a filter actually filters',
        path: '/TibetPatientSearch',
        documentTitle: /Search Patient \| Tibetan Telemedicine Services/i,
        landmark: (page) => page.locator('table.gridtable').first(),
        check: async (page, random) => {
            const before = await readGrid(page);
            expect(before, 'Search Patient rendered no grid').not.toBeNull();

            const grid = before as Grid;
            const idColumn = columnIndex(grid, /^Patient ID$/i);

            expect(idColumn, 'The search grid has no Patient ID column').toBeGreaterThanOrEqual(0);
            expect(
                columnIndex(grid, /^Gender$/i),
                'The search grid has no Gender column'
            ).toBeGreaterThanOrEqual(0);

            // Every listed patient has to carry a centre-prefixed id. A blank one is a
            // row nothing else on the portal can be opened from.
            const idless = grid.rows.filter(
                (row) => !/^[A-Za-z]{2,8}\d{3,}$/.test(row[idColumn] ?? '')
            );
            expect(
                idless.map((row) => row.join(' | ')),
                'Patients listed with no usable patient id'
            ).toEqual([]);

            // Now the filter, which is what the screen is for. A gender is picked at
            // random and applied, and every row that comes back has to be that gender.
            const gender = pickOne(['Male', 'Female', 'Others'], random);
            await page.locator('#Gender').selectOption(gender);

            // waitForEvent('load') rather than waitForLoadState('load'): the filter is a
            // real form submit, and waitForLoadState resolves at once against the page
            // already on screen, so the grid would be read out of the old document while
            // the new one was still arriving - which reads as "the filter returned
            // nothing" on a screen that is working perfectly.
            await Promise.all([
                page.waitForEvent('load'),
                page.getByRole('button', { name: 'Apply Filters' }).click(),
            ]);

            const after = await readGrid(page);
            expect(after, `Applying the ${gender} filter left no grid on the page`).not.toBeNull();

            const filtered = after as Grid;
            const filteredGenderColumn = columnIndex(filtered, /^Gender$/i);
            const wrong = filtered.rows
                .map((row) => row[filteredGenderColumn] ?? '')
                .filter((value) => value && value.toLowerCase() !== gender.toLowerCase());

            expect(wrong, `The ${gender} filter returned patients of another gender`).toEqual([]);

            return (
                `${grid.rows.length} rows unfiltered (${grid.caption}); filtering on ${gender} ` +
                `left ${filtered.rows.length} rows, every one of them ${gender}`
            );
        },
    },
    {
        module: 'Tibet Centre Prescription',
        title: 'Open Centre Prescription and check every visit is complete',
        path: '/TibetCentreHome',
        documentTitle: /Tibet Centre Home \| Tibetan Telemedicine Services/i,
        landmark: (page) => page.locator('table.gridtable').first(),
        check: async (page) => {
            const grid = await readGrid(page);
            expect(grid, 'Centre Prescription rendered no grid').not.toBeNull();

            const prescriptions = grid as Grid;
            const patientColumn = columnIndex(prescriptions, /^Patient Id$/i);
            const prescriptionColumn = columnIndex(prescriptions, /^Prescription ID$/i);
            const statusColumn = columnIndex(prescriptions, /^Status$/i);

            expect(
                patientColumn,
                'The prescription grid has no Patient Id column'
            ).toBeGreaterThanOrEqual(0);
            expect(
                prescriptionColumn,
                'The prescription grid has no Prescription ID column'
            ).toBeGreaterThanOrEqual(0);

            // A visit with no patient id or no prescription id cannot be opened, handed
            // to a doctor or billed. It is a row that exists and can do nothing.
            const broken = prescriptions.rows.filter(
                (row) =>
                    !/^[A-Za-z]{2,8}\d{3,}$/.test(row[patientColumn] ?? '') ||
                    !/^\d+$/.test(row[prescriptionColumn] ?? '')
            );
            expect(
                broken.map((row) => row.join(' | ')),
                'Prescription rows missing a patient id or a prescription id'
            ).toEqual([]);

            // Two visits sharing a prescription id is a duplicate the doctor screens
            // would resolve to whichever they happened to see first.
            const ids = prescriptions.rows.map((row) => row[prescriptionColumn]);
            const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
            expect(duplicates, 'The same prescription id is listed on more than one row').toEqual(
                []
            );

            const counted = captionCount(prescriptions.caption);
            if (counted !== null) {
                expect(
                    prescriptions.rows.length,
                    `The grid says "${prescriptions.caption}" and draws ${prescriptions.rows.length} rows`
                ).toBe(counted);
            }

            const statuses =
                statusColumn >= 0
                    ? [
                          ...new Set(
                              prescriptions.rows.map((row) => row[statusColumn]).filter(Boolean)
                          ),
                      ]
                    : [];

            return `${prescriptions.rows.length} visits (${prescriptions.caption})${
                statuses.length > 0 ? `; statuses seen: ${statuses.join(', ')}` : ''
            }`;
        },
    },
    {
        module: 'Tibet Doctor Allocation',
        title: 'Open Doctor Allocation and check the roster and a fee popup',
        path: '/TibetDoctorAllocationView',
        documentTitle: /Doctor Allocation \| Tibetan Telemedicine Services/i,
        landmark: (page) => page.locator('#docTable'),
        check: async (page, random) => {
            const grid = await readGrid(page, '#docTable');
            expect(grid, 'Doctor Allocation rendered no roster').not.toBeNull();

            const roster = grid as Grid;
            const doctorColumn = columnIndex(roster, /^DOCTOR$/i);
            expect(doctorColumn, 'The roster has no DOCTOR column').toBeGreaterThanOrEqual(0);

            // A centre with nobody on the roster cannot hand a consultation over at all,
            // so an empty roster is the bug rather than an empty result.
            expect(
                roster.rows.length,
                'Doctor Allocation lists no doctors, so no visit could be handed over today'
            ).toBeGreaterThan(0);

            const nameless = roster.rows.filter((row) => !(row[doctorColumn] ?? '').trim());
            expect(
                nameless.map((row) => row.join(' | ')),
                'Roster rows with no doctor name'
            ).toEqual([]);

            // The roster is the day's, and its banner says which day - a screen still
            // showing yesterday's allocation is a stale cache, and a real bug.
            //
            // The months are spelled out rather than taken from toLocaleString, which
            // gives "Sept" for September on a current ICU and would fail this against an
            // app that writes "SEP" - a date check that breaks one month in twelve is
            // worse than no date check at all.
            const MONTHS = [
                'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
                'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
            ];
            const today = new Date();
            const dated = new RegExp(
                `${String(today.getDate()).padStart(2, '0')}-${MONTHS[today.getMonth()]}-${today.getFullYear()}`,
                'i'
            );
            expect(
                roster.caption,
                `The roster banner is not today's date (expected ${dated.source})`
            ).toMatch(dated);

            // One read-only popup, on a row picked at random: the fee view. It writes
            // nothing, and it is the only interactive thing on the screen.
            const viewButtons = page.locator('#docTable button.view-fees-btn');
            const buttons = await viewButtons.count();

            if (buttons > 0) {
                await viewButtons.nth(Math.floor(random() * buttons)).click();
                await page.waitForTimeout(500);
            }

            return (
                `${roster.rows.length} doctors on "${roster.caption}"; ` +
                (buttons > 0
                    ? 'opened one of their fee popups at random'
                    : 'the roster offers no fee popups today')
            );
        },
    },
    {
        module: 'Tibet Patient Queue',
        title: 'Open Patient Queue and check the board agrees with itself',
        path: '/TibetQueueView',
        documentTitle: /Patient Queue \| Tibetan Telemedicine Services/i,
        landmark: (page) => page.locator('table.gridtable').first(),
        check: async (page) => {
            const grid = await readGrid(page);
            expect(grid, 'Patient Queue rendered no board').not.toBeNull();

            const queue = grid as Grid;

            // An empty queue is normal - nobody is waiting - so the check is not that it
            // holds anyone. It is that the number it announces is the number it draws: a
            // board saying four are waiting while showing two is what sends a centre
            // looking for a patient who is not there.
            const waiting = captionCount(queue.caption);
            expect(
                waiting,
                `The queue banner carries no count: "${queue.caption}"`
            ).not.toBeNull();
            expect(
                queue.rows.length,
                `The board says "${queue.caption}" and draws ${queue.rows.length} rows`
            ).toBe(waiting);

            expect(
                columnIndex(queue, /^Doctor$/i),
                'The queue board has no Doctor column'
            ).toBeGreaterThanOrEqual(0);

            return `"${queue.caption}", drawn as ${queue.rows.length} rows`;
        },
    },
];

/* -------------------------------------------------------------------------- */
/* Defects already raised                                                      */
/* -------------------------------------------------------------------------- */

type KnownDefect = {
    /** Where it shows up, matched against the screen the problem was seen on. */
    where: RegExp;
    /** What it looks like, matched against the problem itself. */
    signature: RegExp;
    /** What is actually wrong, for whoever reads the run. */
    note: string;
};

/**
 * Bugs in the portal that are already known, so the sweep reports them by name instead
 * of failing on them again every day.
 *
 * This list exists so the suite stays worth reading. A sweep that is red every morning
 * for a defect somebody already raised stops being looked at, and the day it goes red
 * for a new reason nobody notices. A defect in here is still printed, loudly and with
 * its description, on every run that meets it - it is not suppressed, it is attributed.
 * Anything not in here fails the run.
 *
 * Remove an entry the moment the fix ships. The sweep prints the ones it did NOT meet at
 * the end of the run, which is the prompt to do exactly that.
 */
const KNOWN_DEFECTS: KnownDefect[] = [
    {
        where: /TibetPatientSearch/i,
        signature: /load is not defined/i,
        note:
            'Search Patient: the Apply Filters button is <input type="submit" onclick="load()"> ' +
            'and the page defines no load(), so every filter throws ReferenceError: load is not ' +
            'defined. The form submits anyway - it is a submit button - so the filtering itself ' +
            'works and whatever load() was meant to do (a spinner, most likely) never runs. ' +
            'First seen by this sweep on 24 Sep 2026.',
    },
];

/** Known defects this run actually met, so the ones that did not can be chased. */
const knownDefectsSeen = new Set<KnownDefect>();

function knownDefectFor(where: string, detail: string): KnownDefect | undefined {
    return KNOWN_DEFECTS.find(
        (defect) => defect.where.test(where) && defect.signature.test(detail)
    );
}

/** The paths the sweep covers, for the discovery stage to hold the portal to. */
const SWEPT_PATHS = new Set(SECTIONS.map((section) => section.path.toLowerCase()));

/** Menu entries that are not sections: the one that ends the session, and the dead ones. */
const NOT_A_SECTION = /\/Home\/logout|^#|^javascript:/i;

/* -------------------------------------------------------------------------- */
/* Checking one section                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Opens a section and holds it to everything that is true of a working screen in this
 * portal, before that section's own check runs:
 *
 *   - the server served it, rather than answering 4xx or 5xx;
 *   - it is still the section that was asked for rather than /Login - a session the app
 *     has dropped shows up as a redirect, and a sweep that followed it would then report
 *     every later section as broken for a reason that is not theirs;
 *   - it is the right screen, by document title and by a landmark only that screen has;
 *   - the layout rendered around it, with this centre's own name in the banner;
 *   - the body carries no server-side crash - ASP.NET renders those and can still answer
 *     200, so the status code alone does not find them;
 *   - nothing threw and nothing failed in the background while it loaded.
 */
async function openSection(page: Page, section: Section, health: PageHealth): Promise<void> {
    health.reset();

    const response = await page.goto(`${origin}${section.path}`, { waitUntil: 'load' });

    expect(
        response?.status() ?? 0,
        `${section.path} was served with HTTP ${response?.status()}`
    ).toBeLessThan(400);

    await expect(
        page,
        `${section.path} bounced to the login page - the session was dropped, or this ` +
            'centre is not allowed the screen'
    ).not.toHaveURL(/\/Login/i);

    await expect(page, `${section.path} did not stay on its own URL`).toHaveURL(
        new RegExp(`${section.path.replace(/\//g, '\\/')}(\\?|#|$)`, 'i')
    );

    await expect(page, `${section.path} is not the screen it should be`).toHaveTitle(
        section.documentTitle,
        { timeout: 15000 }
    );

    await expect(
        section.landmark(page).first(),
        `${section.path} opened without the one thing that screen is for`
    ).toBeVisible({ timeout: 20000 });

    await expect(
        page.getByRole('link', { name: 'Home' }).first(),
        `${section.path} rendered without the portal's navigation`
    ).toBeVisible({ timeout: 10000 });

    const crash = await serverErrorOnPage(page);
    expect(crash, `${section.path} rendered a server-side error`).toBe('');

    expectHealthy(section.path, health, 'while it loaded');
}

/**
 * Fails with every new fault named, rather than with whichever one an assertion reached
 * first - a screen with three things wrong with it should say so in one run.
 *
 * A fault matching a defect that has already been raised is printed with its
 * description and does not fail the run. See KNOWN_DEFECTS.
 */
function expectHealthy(where: string, health: PageHealth, when: string): void {
    const faults = health.faults();
    const fresh = [];

    for (const fault of faults) {
        const known = knownDefectFor(`${where} ${fault.where}`, fault.detail);

        if (known) {
            knownDefectsSeen.add(known);
            console.log(`  KNOWN DEFECT on ${where}: ${fault.detail}\n    ${known.note}`);
            continue;
        }

        fresh.push(fault);
    }

    expect(fresh.length, `${where} broke ${when}:\n${describeProblems(fresh)}`).toBe(0);
}

/** Findings are reported, never failed on. See PageHealth. */
function reportFindings(where: string, health: PageHealth): void {
    const findings = health.findings();

    if (findings.length === 0) {
        return;
    }

    test.info().annotations.push({
        type: 'findings',
        description: `${where}: ${findings
            .map((finding) => `[${finding.kind}] ${finding.detail}`)
            .join(' | ')}`,
    });
    console.log(`  findings on ${where} (reported, not failed on):\n${describeProblems(findings)}`);
}

/* -------------------------------------------------------------------------- */
/* The record-level screens                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The screens that exist only for a patient or a visit, reached the way a nurse reaches
 * them - off a grid row - rather than by a hardcoded id. Ids on UAT belong to whatever
 * was registered last; a spec that pinned one would pass until somebody cleaned the
 * environment and then fail for a reason that has nothing to do with the screen.
 */
function recordLevelCases(page: Page, health: PageHealth, random: () => number): ModuleCase[] {
    return [
        {
            module: 'Tibet Patient Record',
            title: "Open a patient's record from the search grid",
            run: async () => {
                health.reset();
                await page.goto(`${origin}/TibetPatientSearch`, { waitUntil: 'load' });

                const links = page.locator('a[href*="TibetPatientForm?id=" i]');
                const count = await links.count();
                expect(
                    count,
                    'The search grid listed no patient whose record could be opened'
                ).toBeGreaterThan(0);

                // A row at random rather than the newest: the first row is the one the
                // other Tibet specs have just created, so it is the single row already
                // known to be well formed.
                const link = links.nth(Math.floor(random() * count));
                const listedName = (await link.innerText()).replace(/\s+/g, ' ').trim();
                const href = (await link.getAttribute('href')) ?? '';
                const id = /[?&]id=(\d+)/i.exec(href)?.[1] ?? '';

                await link.click();
                await page.waitForLoadState('load');

                await expect(page, 'The patient record did not open').toHaveURL(
                    /TibetPatientForm\?id=\d+/i
                );
                await expect(page).toHaveTitle(/Patient Registration \| Tibetan/i);

                // The record has to be the row's. One that opened blank, or on somebody
                // else, is the failure worth catching here: this is an edit screen, and
                // whatever is saved from it lands on whoever it is showing.
                await expect(
                    page.locator('#id'),
                    'The record opened without the id it was asked for'
                ).toHaveValue(id);
                await expect(
                    page.locator('#patient_name'),
                    `The record opened from ${listedName}'s row is showing someone else`
                ).toHaveValue(listedName);

                const crash = await serverErrorOnPage(page);
                expect(crash, 'The patient record rendered a server-side error').toBe('');
                expectHealthy(`TibetPatientForm?id=${id}`, health, 'when a record was opened');
                reportFindings(`TibetPatientForm?id=${id}`, health);

                console.log(`  opened ${listedName} (id ${id}) from the search grid`);
            },
        },
        {
            module: 'Tibet Patient History',
            title: "Open a patient's history from the search grid",
            run: async () => {
                health.reset();
                await page.goto(`${origin}/TibetPatientSearch`, { waitUntil: 'load' });

                const links = page.locator('a[href*="TibetPatientHistory?id=" i]');
                const count = await links.count();
                expect(count, 'The search grid offers no patient history to open').toBeGreaterThan(
                    0
                );

                const href =
                    (await links.nth(Math.floor(random() * count)).getAttribute('href')) ?? '';
                const id = /[?&]id=(\d+)/i.exec(href)?.[1] ?? '';

                const response = await page.goto(href, { waitUntil: 'load' });
                expect(
                    response?.status() ?? 0,
                    `The patient history was served with HTTP ${response?.status()}`
                ).toBeLessThan(400);

                await expect(page).toHaveTitle(/Patient History \| Tibetan/i);
                await expect(
                    page.getByText(/Patient Details/i).first(),
                    'The patient history opened without the record it is about'
                ).toBeVisible({ timeout: 15000 });

                // The history is a summary of one patient, and the id on it is what says
                // it is the right one.
                await expect(
                    page.locator('body'),
                    'The patient history names no patient id'
                ).toContainText(/Id:\s*[A-Za-z]{2,8}\d{3,}/, { useInnerText: true });

                const crash = await serverErrorOnPage(page);
                expect(crash, 'The patient history rendered a server-side error').toBe('');
                expectHealthy(`TibetPatientHistory?id=${id}`, health, 'when a history was opened');
                reportFindings(`TibetPatientHistory?id=${id}`, health);

                console.log(`  opened the history of patient ${id}`);
            },
        },
        {
            module: 'Tibet Case History',
            title: 'Open the case history behind a visit that is still editable',
            run: async () => {
                health.reset();
                await page.goto(`${origin}/TibetCentreHome`, { waitUntil: 'load' });

                const links = page.locator('a[href*="TibetPrescriptionHistoryForm?id=" i]');
                const count = await links.count();

                // Only a visit the doctor has not finished with carries an Edit Case
                // History link. On a quiet day every visit is approved and there is none -
                // which is the app behaving, not failing, so the sweep says so and moves
                // on rather than going red for it.
                if (count === 0) {
                    const note =
                        'No visit on Centre Prescription is still editable, so there was no case ' +
                        'history to open. The consultation specs cover this screen on a visit ' +
                        'they raise themselves.';
                    test.info().annotations.push({ type: 'not swept', description: note });
                    console.log(`  ${note}`);
                    return;
                }

                const href =
                    (await links.nth(Math.floor(random() * count)).getAttribute('href')) ?? '';
                const id = /[?&]id=(\d+)/i.exec(href)?.[1] ?? '';

                await page.goto(href, { waitUntil: 'load' });

                // The form's own page object decides what "open" means here, so the sweep
                // and the consultation specs cannot drift apart on it.
                await new TibetCaseHistoryPage(page).expectLoaded();

                const crash = await serverErrorOnPage(page);
                expect(crash, 'The case history rendered a server-side error').toBe('');
                expectHealthy(
                    `TibetPrescriptionHistoryForm?id=${id}`,
                    health,
                    'when a case history was opened'
                );
                reportFindings(`TibetPrescriptionHistoryForm?id=${id}`, health);

                console.log(`  opened the case history of prescription ${id}, and saved nothing`);
            },
        },
    ];
}

/* -------------------------------------------------------------------------- */
/* The sweep                                                                   */
/* -------------------------------------------------------------------------- */

// Paced so a headed run can be followed on screen: every click, fill and navigation waits
// 1000ms. E2E_SLOW_MO overrides it (0 = full speed, 1500 = slower still).
test.use({
    launchOptions: { slowMo: Number(process.env.E2E_SLOW_MO ?? 1000) },
});

test.describe('Tibet portal sweep: every section, in a random order', () => {
    test.describe.configure({ mode: 'serial' });

    // Nine screens, each loaded, read and checked, at whatever pace E2E_SLOW_MO sets.
    test.setTimeout(900000);

    test.afterEach(async ({ page }) => {
        await new LoginPage(page).logout();
    });

    test('opens every section of the Tibet portal and reports everything broken', {
        tag: ['@tibet', '@sweep', '@smoke'],
    }, async ({ page }) => {
        const centre = tibetCredentials();
        const loginPage = new LoginPage(page);

        const seed = sweepSeed();
        const random = randomFrom(seed);

        knownDefectsSeen.clear();

        const health = watchPageHealth(page);

        // Armed for the whole sweep: the app opens tabs of its own from some of these
        // screens, and a run that carried on against one of those would report that the
        // portal's controls had all disappeared. See stray-tabs.ts.
        const releaseTabs = guardAgainstStrayTabs(page);

        // A section can raise a native dialog. Nothing here means to answer one, and
        // Playwright's default is to dismiss - the safe answer for a sweep that writes
        // nothing - but a dialog nobody recorded is a bug report nobody can act on, so
        // they are dismissed and named.
        const dialogs: string[] = [];
        page.on('dialog', (dialog) => {
            dialogs.push(`${dialog.type()}: ${dialog.message().replace(/\s+/g, ' ').trim()}`);
            dialog.dismiss().catch(() => undefined);
        });

        // Every section, menu and record-level alike, in this seed's order. The
        // record-level ones are shuffled in with the rest because each reaches its screen
        // off a grid of its own and so depends on nothing that ran before it.
        const swept = shuffled(
            [
                ...SECTIONS.map<ModuleCase>((section) => ({
                    module: section.module,
                    title: section.title,
                    run: async () => {
                        await openSection(page, section, health);

                        const found = await section.check(page, random);

                        // The check itself can break the page - a filter that 500s, a
                        // popup whose handler throws - and that is the more interesting
                        // half, so the browser is asked again afterwards.
                        expectHealthy(section.path, health, 'while it was being used');
                        reportFindings(section.path, health);

                        console.log(`  ${section.path}: ${found}`);
                    },
                })),
                ...recordLevelCases(page, health, random),
            ],
            random
        );

        test.info().annotations.push({
            type: 'sweep seed',
            description: `${seed} - replay this exact order with E2E_SWEEP_SEED=${seed}`,
        });
        test.info().annotations.push({
            type: 'sweep order',
            description: swept.map((section) => section.module).join(' -> '),
        });
        console.log(
            `Sweeping the Tibet portal with seed ${seed}. Replay this order with ` +
                `E2E_SWEEP_SEED=${seed}.\n  ${swept.map((section) => section.module).join(' -> ')}`
        );

        // Declared in the order they will run, which is the order the report pairs them
        // off in. See runModuleCases.
        const cases: ModuleCase[] = [
            {
                module: 'Login',
                title: 'Sign in as the Tibet centre',
                run: async () => {
                    await loginPage.loginExpectingHome(centre.username, centre.password);
                    await expect(
                        page.getByText(new RegExp(`Welcome\\s+${centre.username}`, 'i')).first(),
                        "The session that opened is not the Tibet centre's"
                    ).toBeVisible({ timeout: 15000 });
                },
            },
            {
                module: 'Tibet Portal',
                title: 'List every section the portal offers and check none is unswept',
                run: async () => {
                    // Read off the portal rather than assumed. A section added to the menu
                    // tomorrow is noticed here instead of silently going untested, so the
                    // sweep cannot quietly cover less than it claims to.
                    const offered = await page.locator('a[href]').evaluateAll((links) =>
                        links
                            .map((link) => ({
                                href: link.getAttribute('href') ?? '',
                                label: (link as HTMLElement).innerText.replace(/\s+/g, ' ').trim(),
                            }))
                            .filter((link) => link.href)
                    );

                    const appOrigin = new URL(origin).origin;
                    const sections = new Map<string, string>();

                    for (const { href, label } of offered) {
                        if (NOT_A_SECTION.test(href)) {
                            continue;
                        }

                        let url: URL;
                        try {
                            url = new URL(href, origin);
                        } catch {
                            continue;
                        }

                        // A link off the app - the template author's, the footer's - is
                        // not a section of this portal.
                        if (url.origin !== appOrigin) {
                            continue;
                        }

                        const path = url.pathname.toLowerCase();
                        if (!sections.has(path)) {
                            sections.set(path, label || url.pathname);
                        }
                    }

                    test.info().annotations.push({
                        type: 'sections offered',
                        description: [...sections.entries()]
                            .map(([path, label]) => `${label} (${path})`)
                            .join(', '),
                    });

                    const unswept = [...sections.keys()].filter((path) => !SWEPT_PATHS.has(path));
                    expect(
                        unswept,
                        'The portal offers a section this sweep does not cover. Add it to ' +
                            'SECTIONS in this spec so it is checked like the rest.'
                    ).toEqual([]);

                    console.log(
                        `  the portal offers ${sections.size} sections, all of them swept: ` +
                            `${[...sections.values()].join(', ')}`
                    );
                },
            },
            ...swept,
        ];

        // continueOnFailure is the whole point of a sweep: a broken section is recorded,
        // reported as its own failed row, and the run carries on to the rest of the
        // portal. See tests/support/module-case.ts.
        const failures = await runModuleCases(cases, { continueOnFailure: true });

        const strayTabs = await releaseTabs();
        health.stop();

        if (dialogs.length > 0) {
            test.info().annotations.push({
                type: 'dialogs raised',
                description: dialogs.join(' | '),
            });
            console.log(`Dialogs raised and dismissed during the sweep: ${dialogs.join(' | ')}`);
        }

        if (strayTabs.length > 0) {
            test.info().annotations.push({
                type: 'stray tabs',
                description: strayTabs.join(', '),
            });
        }

        // Which already-raised defects this run met, and - more usefully - which it did
        // not. A known defect that has stopped happening is either fixed or has moved,
        // and either way its entry should not stay in the list unexamined.
        if (knownDefectsSeen.size > 0) {
            test.info().annotations.push({
                type: 'known defects met',
                description: [...knownDefectsSeen].map((defect) => defect.note).join(' | '),
            });
            console.log(
                `${knownDefectsSeen.size} already-raised defect(s) met again on this run; they ` +
                    'did not fail it. See KNOWN_DEFECTS in this spec.'
            );
        }

        const goneQuiet = KNOWN_DEFECTS.filter((defect) => !knownDefectsSeen.has(defect));
        if (goneQuiet.length > 0) {
            const note =
                'These known defects did not happen on this run - check whether they are fixed ' +
                `and drop them from KNOWN_DEFECTS: ${goneQuiet.map((d) => d.note).join(' | ')}`;
            test.info().annotations.push({ type: 'known defects not seen', description: note });
            console.log(note);
        }

        // One failure carrying every broken section, so the terminal says as much as the
        // workbook does. Each of them has already been reported as its own failed row.
        expect(
            failures.map((failure) => failure.message),
            `${failures.length} of ${cases.length} sections of the Tibet portal are broken ` +
                `(seed ${seed})`
        ).toEqual([]);

        console.log(`All ${cases.length} sections of the Tibet portal passed (seed ${seed}).`);
    });
});
