/**
 * Codegen replacement: opens a page as a logged-in user and writes down everything a
 * test needs to drive it — the accessibility tree, a ready-to-paste locator for every
 * control, the served HTML and a screenshot.
 *
 * Use it when `npx playwright codegen` will not show you the page: a headed window
 * that fails to paint, a screen only reachable after a long flow, or a modal that
 * disappears the moment the recorder takes focus.
 *
 *   node tools/inspect-page.js /CentreHome
 *   node tools/inspect-page.js /CentreHome --click "Edit Case History"
 *   node tools/inspect-page.js /PatientSearch --name patient-search
 *
 * Output lands in reports/inspect/<name>/: locators.md, aria.txt, page.html, page.png
 *
 * It logs out at the end. The account allows only 2 concurrent sessions, so a run
 * that simply exits burns a slot until the server expires it.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const args = process.argv.slice(2);
const targetPath = args.find((a) => !a.startsWith('--')) || '/Home';
const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? undefined : args[i + 1];
};

const base = (process.env.E2E_BASE_URL || 'https://uat.karmaprimaryhealthcare.in').replace(/\/$/, '');
const clickAfter = flag('click');
const savedHtml = flag('html');
const outName = flag('name') || targetPath.replace(/^\//, '').replace(/[^\w.-]+/g, '-') || 'home';
const outDir = path.resolve(__dirname, '..', 'reports', 'inspect', outName);

/**
 * Runs inside the page. Walks every control a test could touch and works out the
 * locator Playwright would prefer for it, in the order the docs recommend: role plus
 * accessible name first, then the app's own id/name attributes, then placeholder or
 * text.
 */
function collectControls() {
    const SELECTOR = 'a,button,input,select,textarea,[role],[onclick]';

    const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    };

    const textOf = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);

    const roleOf = (el) => {
        if (el.hasAttribute('role')) return el.getAttribute('role');
        const tag = el.tagName.toLowerCase();
        if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;
        if (tag === 'button') return 'button';
        if (tag === 'select') return 'combobox';
        if (tag === 'textarea') return 'textbox';
        if (tag !== 'input') return null;
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        const byType = {
            submit: 'button',
            button: 'button',
            reset: 'button',
            checkbox: 'checkbox',
            radio: 'radio',
        };
        return type === 'hidden' ? null : byType[type] || 'textbox';
    };

    /** What a screen reader would announce, which is what getByRole matches on. */
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

        return textOf(el);
    };

    const quote = (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";

    /**
     * The app's own id or name attribute. Kept separate from the role-based suggestion
     * because it is the escape hatch when role + accessible name is ambiguous: this
     * form gives eight vitals inputs the same placeholder ("0"), so getByRole matches
     * all of them while #weight, #pulse and friends each match one.
     */
    const byAttribute = (el) => {
        // CSS reads [] as an attribute selector, and this app names inputs
        // inputTestUnit[]0, so those have to go through the attribute form.
        if (el.id && !/^\d/.test(el.id) && !/[[\]().:#\s]/.test(el.id)) {
            return 'page.locator(' + quote('#' + el.id) + ')';
        }
        if (el.id) return 'page.locator(' + quote('[id="' + el.id + '"]') + ')';

        const attrName = el.getAttribute('name');
        if (attrName) return 'page.locator(' + quote('[name="' + attrName + '"]') + ')';

        return null;
    };

    const suggest = (el, role, name) => {
        if (role && name) return 'page.getByRole(' + quote(role) + ', { name: ' + quote(name) + ' })';

        const attribute = byAttribute(el);
        if (attribute) return attribute;

        const placeholder = el.getAttribute('placeholder');
        if (placeholder) return 'page.getByPlaceholder(' + quote(placeholder) + ')';
        if (name) return 'page.getByText(' + quote(name) + ')';

        return 'page.locator(' + quote(el.tagName.toLowerCase()) + ')';
    };

    const rows = [];
    for (const el of document.querySelectorAll(SELECTOR)) {
        const type = (el.getAttribute('type') || '').toLowerCase();
        if (type === 'hidden') continue;

        const role = roleOf(el);
        const name = accessibleName(el);

        rows.push({
            tag: el.tagName.toLowerCase() + (type ? '[' + type + ']' : ''),
            role: role || '',
            name: name,
            id: el.id || '',
            attrName: el.getAttribute('name') || '',
            visible: isVisible(el),
            locator: suggest(el, role, name),
            byAttribute: byAttribute(el),
            options:
                el.tagName === 'SELECT'
                    ? Array.from(el.options).map((o) => o.text.trim()).filter(Boolean).slice(0, 15)
                    : [],
        });
    }

    // The same locator twice means .first() or a filter will be needed, so flag it here
    // rather than letting the test fail on a strict-mode violation later.
    const counts = new Map();
    for (const row of rows) counts.set(row.locator, (counts.get(row.locator) || 0) + 1);

    // An ambiguous role locator is worth trading for a unique id, but only if the id
    // really is unique — repeated ids (this form reuses deleteIcon_symptoms per row)
    // are no better, so those keep the flag and are left for the caller to filter.
    for (const row of rows) {
        if (counts.get(row.locator) > 1 && row.byAttribute && counts.get(row.byAttribute) === undefined) {
            const unique = rows.filter((r) => r.byAttribute === row.byAttribute).length === 1;
            if (unique) {
                row.locator = row.byAttribute;
                continue;
            }
        }
        row.duplicate = counts.get(row.locator) > 1;
    }

    return {
        title: document.title,
        url: location.href,
        rows: rows,
        tables: Array.from(document.querySelectorAll('table')).map((t) => ({
            id: t.id || t.className || '(unnamed)',
            headers: Array.from(t.querySelectorAll('th')).map((h) => h.innerText.replace(/\s+/g, ' ').trim()),
            rowCount: t.querySelectorAll('tr').length,
        })),
    };
}

function toMarkdown(info, capturedAt) {
    const cell = (s) => String(s).replace(/\|/g, '\\|');
    const line = (r) =>
        '| ' +
        [
            cell(r.tag),
            cell(r.role),
            cell(r.name),
            cell(r.id || r.attrName),
            '`' + cell(r.locator) + '`' + (r.duplicate ? ' [dup]' : ''),
        ].join(' | ') +
        ' |';

    const header = '| tag | role | accessible name | id / name | suggested locator |\n|---|---|---|---|---|';
    const visible = info.rows.filter((r) => r.visible);
    const hidden = info.rows.filter((r) => !r.visible);
    const selects = info.rows.filter((r) => r.options.length);

    const out = [
        '# ' + info.title,
        '',
        '- URL: ' + info.url,
        '- captured: ' + capturedAt,
        '- controls: ' + visible.length + ' visible, ' + hidden.length + ' not visible',
        '- [dup] marks a locator matching more than one element: add .first() or filter it.',
        '',
        '## Visible controls',
        '',
        header,
    ];

    out.push.apply(out, visible.map(line));
    out.push('', '## Tables', '');
    out.push.apply(
        out,
        info.tables.map((t) => '- **' + t.id + '** - ' + t.rowCount + ' rows - columns: ' + t.headers.join(', '))
    );

    if (selects.length) {
        out.push('', '## Dropdown options', '');
        out.push.apply(out, selects.map((s) => '- `' + (s.id || s.attrName) + '`: ' + s.options.join(', ')));
    }

    out.push(
        '',
        '## Not visible right now',
        '',
        'In the DOM but not painted. Modals and conditional panels live here.',
        '',
        header
    );
    out.push.apply(out, hidden.map(line));
    out.push('');

    return out.join('\n');
}

async function report(page, problems) {
    // Grids and selectize widgets finish populating after load, and a locator read
    // before that misses them.
    await page.waitForTimeout(2500);

    const info = await page.evaluate(collectControls);
    const aria = await page.locator('body').ariaSnapshot();

    fs.writeFileSync(path.join(outDir, 'locators.md'), toMarkdown(info, new Date().toISOString()));
    fs.writeFileSync(path.join(outDir, 'aria.txt'), aria);
    fs.writeFileSync(path.join(outDir, 'page.html'), await page.content());
    await page.screenshot({ path: path.join(outDir, 'page.png'), fullPage: true });

    console.log(info.title);
    console.log(info.url);
    console.log(
        info.rows.filter((r) => r.visible).length +
            ' visible controls, ' +
            info.rows.filter((r) => !r.visible).length +
            ' hidden, ' +
            info.tables.length +
            ' tables'
    );
    if (problems.length) console.log('problems:\n  ' + problems.slice(0, 10).join('\n  '));

    console.log('\nwritten to reports/inspect/' + outName + '/');
    console.log('  locators.md  ready-to-paste locator for every control');
    console.log('  aria.txt     accessibility tree, what getByRole matches on');
    console.log('  page.html    served HTML');
    console.log('  page.png     full-page screenshot');
}

(async () => {
    fs.mkdirSync(outDir, { recursive: true });

    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

    const problems = [];
    page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
    page.on('response', (r) => {
        if (r.status() >= 400) problems.push('HTTP ' + r.status() + ' ' + r.url());
    });

    // --html re-reads a page.html captured earlier instead of logging in. Useful when
    // the account is at its session limit, or to re-read a screen without walking the
    // whole flow again.
    if (savedHtml) {
        await page.setContent(fs.readFileSync(savedHtml, 'utf8'), { waitUntil: 'load' });
        await page.waitForTimeout(1500);
        await report(page, problems);
        await browser.close();
        return;
    }

    await page.goto(base + '/Login');
    await page.getByRole('textbox', { name: 'Username' }).fill(process.env.E2E_USERNAME);
    await page.getByPlaceholder('Enter your password').fill(process.env.E2E_PASSWORD);
    await page.getByRole('button', { name: 'Login' }).click();
    await page.waitForLoadState('load');

    if (/active sessions/i.test(await page.innerText('body'))) {
        console.error('Login refused: the account is at its 2 active-session limit.');
        console.error('Close another logged-in window and run this again.');
        await browser.close();
        process.exit(1);
    }

    try {
    await page.goto(base + (targetPath.startsWith('/') ? targetPath : '/' + targetPath));
    await page.waitForLoadState('load');

    if (clickAfter) {
        // The grid is swapped in by CentreHome's own refresh call moments after load,
        // so a click fired the instant load resolves can miss a row that is about to
        // be replaced.
        await page.waitForTimeout(2500);

        const pattern = new RegExp(clickAfter, 'i');
        const target = page
            .getByRole('link', { name: pattern })
            .or(page.getByRole('button', { name: pattern }))
            .first();

        await target.click();
        await page.waitForLoadState('load');
    }

    // Grids and selectize widgets finish populating after load, and a locator taken
    // before that misses them.
    await page.waitForTimeout(2500);

    await report(page, problems);
    } finally {
        // Whatever happened above, hand the session slot back — there are only two,
        // and a crashed run that skips this locks the account out until it expires.
        await page.goto(base + '/Home/logout').catch(() => {});
        await browser.close();
    }
})();
