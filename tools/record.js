/**
 * A recorder that does not need the Playwright Inspector window.
 *
 * `npx playwright codegen` puts its recorder window on top of the browser, and on
 * Windows that can leave the browser occluded and painting nothing — a blank page
 * with a live DOM underneath. This does the same job with one window: it opens the
 * login page, watches every click and field change you make, and writes the matching
 * Playwright calls to the terminal and to a runnable spec file.
 *
 *   node tools/record.js                 # starts at /Login
 *   node tools/record.js /CentreHome     # starts somewhere else
 *   node tools/record.js --name consent  # names the output file
 *
 * Click through the app as a user would. Every action appears in the terminal as it
 * happens. Close the browser window to finish; the spec is written to
 * tools/recorded/<name>.spec.ts.
 *
 * Log out inside the app before closing the window — the account allows only two
 * concurrent sessions, and a window that is simply closed keeps holding one.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const args = process.argv.slice(2);
const startPath = args.find((a) => !a.startsWith('--')) || '/Login';
const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? undefined : args[i + 1];
};

const base = (process.env.E2E_BASE_URL || 'https://uat.karmaprimaryhealthcare.in').replace(/\/$/, '');
const outName = (flag('name') || 'recording').replace(/[^\w.-]+/g, '-');
const outDir = path.resolve(__dirname, 'recorded');
const outFile = path.join(outDir, `${outName}.spec.ts`);

/**
 * Injected into every document. Works out the locator Playwright would prefer for
 * whatever was just clicked or changed, and hands it back to node.
 *
 * Written as a string because it has to run in the page, and it needs the same
 * locator rules as tools/inspect-page.js — role plus accessible name first, then the
 * app's own id or name, then placeholder or text — with one addition: a candidate is
 * only accepted once it has been checked to match a single element on the page.
 */
const RECORDER = `
(() => {
    if (window.__recorderAttached) return;
    window.__recorderAttached = true;

    const textOf = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80);

    const roleOf = (el) => {
        if (el.hasAttribute('role')) return el.getAttribute('role');
        const tag = el.tagName.toLowerCase();
        if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;
        if (tag === 'button') return 'button';
        if (tag === 'select') return 'combobox';
        if (tag === 'textarea') return 'textbox';
        if (tag !== 'input') return null;
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        const byType = { submit: 'button', button: 'button', reset: 'button', checkbox: 'checkbox', radio: 'radio' };
        return type === 'hidden' ? null : (byType[type] || 'textbox');
    };

    const accessibleName = (el) => {
        const aria = el.getAttribute('aria-label');
        if (aria) return aria;
        if (el.id) {
            const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
            if (label) return textOf(label);
        }
        const wrapping = el.closest('label');
        if (wrapping && wrapping !== el) return textOf(wrapping);
        if (el.tagName === 'INPUT') {
            const type = (el.getAttribute('type') || 'text').toLowerCase();
            if (type === 'submit' || type === 'button' || type === 'reset') return el.value || '';
            return el.getAttribute('placeholder') || '';
        }
        // A select's text content is the list of its options, which is not a name.
        if (el.tagName === 'SELECT') return '';
        return textOf(el);
    };

    /**
     * getByRole only ever sees what is on screen, so anything hidden has to be left out
     * of the count. A page that keeps a second copy of a button inside a collapsed panel
     * otherwise looks ambiguous, and the .nth() index written for it counts elements
     * Playwright cannot see - which is how a recorded locator ends up matching nothing.
     *
     * Disabled is not hidden: getByRole matches a disabled button, so it still counts.
     */
    const hiddenForRole = (el) => {
        if (el.hasAttribute('hidden') || el.closest('[aria-hidden="true"]')) return true;
        // visibility inherits, so the element's own computed value is the whole answer.
        if (getComputedStyle(el).visibility !== 'visible') return true;
        for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
            if (getComputedStyle(node).display === 'none') return true;
        }
        return false;
    };

    /** Every visible element this role + name pair matches, so ambiguity can be measured. */
    const matchingRole = (role, name) =>
        Array.from(document.querySelectorAll('a,button,input,select,textarea,[role]'))
            .filter((c) => roleOf(c) === role && accessibleName(c) === name && !hiddenForRole(c));

    const quote = (s) => "'" + String(s).replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'") + "'";

    /** The app's own id or name, but only when it singles the element out. */
    const uniqueAttribute = (el) => {
        if (el.id && document.querySelectorAll('[id="' + CSS.escape(el.id) + '"]').length === 1) {
            // #id is a selector only while the id is a valid CSS identifier. The
            // doctor tiles on Doctor Selection are id="362" and the like, and '#362'
            // makes querySelectorAll throw rather than simply not match, so anything
            // that does not start like an identifier goes through [id="..."].
            return /^[A-Za-z_][\\w-]*$/.test(el.id)
                ? 'page.locator(' + quote('#' + el.id) + ')'
                : 'page.locator(' + quote('[id="' + el.id + '"]') + ')';
        }
        const attrName = el.getAttribute('name');
        if (attrName && document.getElementsByName(attrName).length === 1) {
            return 'page.locator(' + quote('[name="' + attrName + '"]') + ')';
        }
        return null;
    };

    /**
     * Last resort for elements the app gives no id, name or text: a structural path,
     * anchored on the nearest ancestor that does have a unique id so the selector
     * stays as short and as stable as it can be.
     *
     * This is what the selectize widgets on the case history form need — clicking one
     * lands on an anonymous div inside a generated dropdown.
     */
    const cssPath = (el) => {
        const parts = [];
        let node = el;

        while (node && node.nodeType === 1 && node !== document.body) {
            const id = node.id;
            if (id && document.querySelectorAll('[id="' + CSS.escape(id) + '"]').length === 1) {
                parts.unshift('#' + CSS.escape(id));
                break;
            }

            // A class the app chose says more than a position ever will.
            const named = Array.from(node.classList).filter((c) => /^[a-z][\\w-]*$/i.test(c));
            let part = node.tagName.toLowerCase();
            if (named.length) part += '.' + named.slice(0, 2).join('.');

            const siblings = node.parentNode ? Array.from(node.parentNode.children) : [];
            const same = siblings.filter((s) => s.tagName === node.tagName);
            if (same.length > 1) part += ':nth-child(' + (siblings.indexOf(node) + 1) + ')';

            parts.unshift(part);
            node = node.parentElement;
        }

        const selector = parts.join(' > ');
        if (!selector) return null;
        return document.querySelectorAll(selector).length === 1 ? selector : null;
    };

    /** Returns { call, note } - the note is added as a trailing comment by node. */
    const locatorFor = (el) => {
        const role = roleOf(el);
        const name = accessibleName(el);
        const attribute = uniqueAttribute(el);

        if (role && name) {
            const matches = matchingRole(role, name);
            const call = 'page.getByRole(' + quote(role) + ', { name: ' + quote(name) + ' })';
            if (matches.length === 1) return { call: call };

            // Ambiguous. A unique id beats an index every time: eight vitals inputs
            // share the placeholder "0", but each has its own id.
            if (attribute) return { call: attribute };

            const index = matches.indexOf(el);
            if (index >= 0) {
                return {
                    call: call + '.nth(' + index + ')',
                    note: matches.length + ' elements match - filter by row instead of an index',
                };
            }
        }

        if (attribute) return { call: attribute };

        const placeholder = el.getAttribute('placeholder');
        if (placeholder) return { call: 'page.getByPlaceholder(' + quote(placeholder) + ')' };

        // Short text is a dropdown option or a cell and reads well in a test. A wall of
        // text is the whole panel the click bubbled through, which is worse than useless.
        if (name && name.length <= 40) {
            const matches = Array.from(document.querySelectorAll('*')).filter(
                (c) => c.children.length === 0 && textOf(c) === name
            );
            if (matches.length === 1) return { call: 'page.getByText(' + quote(name) + ', { exact: true })' };
        }

        const path = cssPath(el);
        if (path) {
            return {
                call: 'page.locator(' + quote(path) + ')',
                note: 'structural locator - rewrite it if the markup shifts',
            };
        }

        return {
            call: 'page.locator(' + quote(el.tagName.toLowerCase()) + ').first()',
            note: 'nothing identifies this element - needs a hand-written locator',
        };
    };

    /** A click lands on whatever is under the cursor; the test wants the control. */
    const controlFor = (el) =>
        (el && el.closest && el.closest('a,button,input,select,textarea,[role="button"],[onclick],label')) || el;

    const send = (kind, el, value) => {
        const resolved = locatorFor(el);
        window.__record({ kind: kind, locator: resolved.call, note: resolved.note, value: value });
    };

    document.addEventListener('click', (event) => {
        const el = controlFor(event.target);
        if (!el || el === document.documentElement) return;

        // A ticked checkbox fires click and change for the same act. check() is the
        // one that states the intent, so let the change handler record it. Clicking the
        // label is that same act, so it goes the same way - recording the label click
        // too would put one tick in the spec as two steps.
        const type = (el.getAttribute && (el.getAttribute('type') || '')).toLowerCase();
        if (type === 'checkbox' || type === 'radio') return;
        if (el.tagName === 'LABEL' && el.control) {
            const bound = (el.control.getAttribute('type') || '').toLowerCase();
            if (bound === 'checkbox' || bound === 'radio') return;
        }

        send('click', el);
    }, true);

    document.addEventListener('change', (event) => {
        const el = event.target;
        if (!el || !el.tagName) return;
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute('type') || '').toLowerCase();

        if (tag === 'select') {
            const option = el.options[el.selectedIndex];
            send('select', el, option ? option.text.trim() : '');
            return;
        }
        if (type === 'checkbox' || type === 'radio') {
            send(el.checked ? 'check' : 'uncheck', el);
            return;
        }
        if (tag === 'input' || tag === 'textarea') send('fill', el, el.value);
    }, true);
})();
`;

const lines = [];
let lastActionAt = 0;

function quote(value) {
    return "'" + String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

function record(step) {
    let code;
    switch (step.kind) {
        case 'click':
            code = `await ${step.locator}.click();`;
            break;
        case 'fill':
            code = `await ${step.locator}.fill(${quote(step.value)});`;
            break;
        case 'select':
            code = `await ${step.locator}.selectOption({ label: ${quote(step.value)} });`;
            break;
        case 'check':
            code = `await ${step.locator}.check();`;
            break;
        case 'uncheck':
            code = `await ${step.locator}.uncheck();`;
            break;
        case 'goto':
            code = `await page.goto(${quote(step.value)});`;
            break;
        default:
            return;
    }

    if (step.note) code += '  // ' + step.note;

    // A field that changes on the way out of the page reports the same value twice, so
    // an exact repeat of the previous line is an echo - unless it is a click. Clicking
    // "Add Row" three times is three separate acts and has to stay three lines.
    if (step.kind !== 'click' && lines[lines.length - 1] === code) return;

    lastActionAt = Date.now();
    lines.push(code);
    console.log(String(lines.length).padStart(3, ' ') + '  ' + code);
}

function writeSpec() {
    fs.mkdirSync(outDir, { recursive: true });

    const body = lines.length
        ? lines.map((l) => '    ' + l).join('\n')
        : '    // nothing was recorded';

    fs.writeFileSync(
        outFile,
        [
            "import { test } from '@playwright/test';",
            '',
            '/**',
            ' * Recorded with tools/record.js on ' + new Date().toISOString() + '.',
            ' *',
            ' * Raw actions, in the order they happened. Before keeping any of this, move the',
            ' * steps into the page objects under tests/pages and replace the passwords and',
            ' * generated ids with data from tests/data.',
            ' */',
            "test('recorded flow', async ({ page }) => {",
            body,
            '});',
            '',
        ].join('\n')
    );
}

// Exported so tools/record.selftest.js can inject the recorder into a throwaway page
// and check it still produces the locators it should. Requiring this file must not
// open a browser, hence the main-module guard on the run below.
module.exports = { RECORDER, record, lines };

if (require.main !== module) return;

(async () => {
    const browser = await chromium.launch({
        headless: false,
        // Windows can mark a window occluded when another sits on top of it, and the
        // browser then stops painting while the page keeps running. That is what makes
        // codegen look blank here, so turn the detection off.
        args: ['--disable-features=CalculateNativeWinOcclusion'],
    });

    const context = await browser.newContext({ viewport: null });
    await context.exposeBinding('__record', (_source, step) => record(step), {});
    await context.addInitScript(RECORDER);

    const page = await context.newPage();

    page.on('framenavigated', (frame) => {
        if (frame !== page.mainFrame()) return;
        const url = frame.url();
        if (!url || url === 'about:blank') return;
        // Only worth recording when the page was reached by typing a URL; a navigation
        // caused by the click just recorded is already implied by that click. Actions
        // come back from the page asynchronously and a navigation can beat the click
        // that caused it, so go by when the last action happened rather than by what it
        // was - reading lines[] here used to see the click land a moment too late and
        // write a goto on top of it.
        if (Date.now() - lastActionAt > 2000) record({ kind: 'goto', value: url });
    });

    console.log('Recording. Every click and field change appears below.\n');
    console.log('  window   : the browser that just opened');
    console.log('  finish   : log out in the app, then close the browser window');
    console.log('  output   : tools/recorded/' + outName + '.spec.ts\n');

    await page.goto(base + (startPath.startsWith('/') ? startPath : '/' + startPath));

    await new Promise((resolve) => browser.on('disconnected', resolve));

    writeSpec();
    console.log('\n' + lines.length + ' actions written to tools/recorded/' + outName + '.spec.ts');
})();
