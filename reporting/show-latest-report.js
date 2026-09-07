/**
 * Opens an archived HTML report from reports/runs/.
 *
 *   npm run report                  newest run
 *   npm run report -- 2026-09-07_14-32-05    that run
 *   npm run report:list             every run kept on disk
 *
 * Plain JS on purpose: it runs under bare `node`, with no TypeScript step.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const RUNS_DIR = path.resolve(process.cwd(), 'reports', 'runs');

/** Run folders that actually contain an HTML report, newest last. */
function findRuns() {
    if (!fs.existsSync(RUNS_DIR)) return [];

    return fs
        .readdirSync(RUNS_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => fs.existsSync(path.join(RUNS_DIR, name, 'playwright-report', 'index.html')))
        .sort();
}

function readHistory() {
    const file = path.join(RUNS_DIR, 'history.json');
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function list() {
    const runs = findRuns();
    if (runs.length === 0) {
        console.log('No runs yet — run `npm test` first.');
        return;
    }

    const history = new Map(readHistory().map((run) => [run.runId, run]));

    console.log(`\n  ${runs.length} run(s) in reports/runs\n`);
    for (const runId of runs) {
        const totals = history.get(runId) && history.get(runId).totals;
        const summary = totals
            ? `${totals.total} tests — ${totals.passed} passed, ${totals.failed} failed, ${totals.skipped} skipped`
            : '(no summary recorded)';
        console.log(`    ${runId}   ${summary}`);
    }
    console.log('');
}

function show(requested) {
    const runs = findRuns();

    if (runs.length === 0) {
        console.error('No HTML report found under reports/runs — run `npm test` first.');
        process.exit(1);
    }

    const runId = requested || runs[runs.length - 1];
    if (!runs.includes(runId)) {
        console.error(`No report for run "${runId}". Known runs:\n  ${runs.join('\n  ')}`);
        process.exit(1);
    }

    const reportDir = path.join(RUNS_DIR, runId, 'playwright-report');
    console.log(`Opening report for run ${runId}`);

    // shell:true so this works with npx.cmd on Windows as well as npx on POSIX.
    const child = spawn('npx', ['playwright', 'show-report', reportDir], {
        stdio: 'inherit',
        shell: true,
    });
    child.on('exit', (code) => process.exit(code ?? 0));
}

const [command] = process.argv.slice(2);

if (command === '--list' || command === 'list') list();
else show(command);
