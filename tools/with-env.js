#!/usr/bin/env node
/**
 * Runs a command with environment variables set, on every platform.
 *
 * npm runs scripts through cmd.exe on Windows, where the Unix idiom
 *
 *     "test:something:headed": "E2E_SLOW_MO=1000 playwright test --headed"
 *
 * is not a variable assignment at all — cmd reads it as the name of a program and
 * answers "'E2E_SLOW_MO' is not recognized as an internal or external command". So a
 * script that needs to hand a setting to the run has to do it through node, which is
 * what this is: a small stand-in for cross-env, using the same tools/ idiom as
 * show-latest-report.js and record.js rather than adding a dependency for it.
 *
 *     node tools/with-env.js KEY=value [KEY=value ...] -- <command> [args ...]
 *
 * Everything before the -- is an assignment, everything after it is the command. The
 * command's exit code is this process's exit code, so a failing run still fails the
 * script and CI still sees it.
 */

const { spawn } = require('child_process');
const path = require('path');

const separator = process.argv.indexOf('--');
const assignments = process.argv.slice(2, separator === -1 ? undefined : separator);
const command = separator === -1 ? [] : process.argv.slice(separator + 1);

if (separator === -1 || command.length === 0) {
    console.error('Usage: node tools/with-env.js KEY=value [...] -- <command> [args ...]');
    process.exit(2);
}

const env = { ...process.env };

for (const assignment of assignments) {
    const at = assignment.indexOf('=');

    if (at <= 0) {
        console.error(`Not a KEY=value assignment: ${assignment}`);
        process.exit(2);
    }

    env[assignment.slice(0, at)] = assignment.slice(at + 1);
}

// npm puts node_modules/.bin on PATH for the scripts it runs, so `playwright` resolves
// there. Nothing does that when this file is run by hand, so it is added here too and
// the same command line works either way.
const binDirectory = path.join(__dirname, '..', 'node_modules', '.bin');
const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
env[pathKey] = `${binDirectory}${path.delimiter}${env[pathKey] ?? ''}`;

/**
 * A shell is needed on Windows, where `playwright` is a .cmd shim that node refuses to
 * spawn directly. Passing an argv array *and* shell:true is deprecated (DEP0190) and
 * warns on every run, so the command is quoted back into one string instead.
 */
function quote(argument) {
    return /[\s"&|<>^()]/.test(argument) ? `"${argument.replace(/"/g, '\\"')}"` : argument;
}

const child = spawn(command.map(quote).join(' '), {
    env,
    stdio: 'inherit',
    shell: true,
});

child.on('error', (error) => {
    console.error(error.message);
    process.exit(1);
});

child.on('exit', (code, signal) => {
    process.exit(signal ? 1 : code ?? 0);
});
