/**
 * Checks that the recorder injected by tools/record.js still produces the locators it
 * should, without needing a login or a person clicking things.
 *
 * It builds a throwaway page shaped like the screens this suite drives — a login form,
 * a grid whose rows all offer the same link, and the vitals inputs that share a
 * placeholder — then fires real events at it and prints what would have been recorded.
 *
 *   node tools/record.selftest.js
 */
const { chromium } = require('@playwright/test');
const { RECORDER, record, lines } = require('./record');

const PAGE = `
<form>
  <input type="text" name="username" placeholder="Username">
  <input type="password" name="password" placeholder="Enter your password">
  <button type="button" id="loginBtn">Login</button>
</form>
<table>
  <!-- Same-page hrefs: a real one would navigate and wipe the page mid-test, but the
       role and the accessible name are identical either way. -->
  <tr><td><a href="#row1" class="button">Edit Case History</a></td></tr>
  <tr><td><a href="#row2" class="button">Edit Case History</a></td></tr>
</table>
<!-- Collapsed panels keep copies of controls that Playwright's getByRole will never
     see. They must not make the visible one look ambiguous. -->
<div style="display:none"><button id="ghostSave">Save</button></div>
<button id="save">Save</button>

<button id="addRow">Add Row</button>

<input type="number" id="weight" placeholder="0">
<input type="number" id="pulse" placeholder="0">
<select id="mode"><option>Tele</option><option>Physical</option></select>
<label for="allergy">Allergy</label><input type="checkbox" id="allergy">

<!-- Shaped like the selectize widgets on the case history form: a click lands on an
     anonymous div inside a generated dropdown. -->
<div id="symptomRow">
  <div class="selectize-control">
    <div class="selectize-input"><input type="text" placeholder="Symptom"></div>
    <div class="selectize-dropdown">
      <div class="selectize-dropdown-content">
        <div class="option" data-value="1">Fever</div>
        <div class="option" data-value="2">Cough</div>
      </div>
    </div>
  </div>
</div>
`;

const expectations = [
    { on: '#loginBtn', do: 'click', want: "page.getByRole('button', { name: 'Login' }).click()" },
    // A placeholder is an accessible name, so role wins here and that is the better
    // locator of the two.
    { on: '[name="username"]', do: 'fill', value: 'dhaula', want: "page.getByRole('textbox', { name: 'Username' }).fill('dhaula')" },
    { on: '#weight', do: 'fill', value: '62', want: "page.locator('#weight').fill('62')" },
    { on: '#pulse', do: 'fill', value: '78', want: "page.locator('#pulse').fill('78')" },
    { on: '#mode', do: 'select', value: 'Physical', want: "page.locator('#mode').selectOption" },
    // The <label for> gives this one a real accessible name, so role beats the id.
    { on: '#allergy', do: 'check', want: "page.getByRole('checkbox', { name: 'Allergy' }).check()" },
    { on: 'table a >> nth=1', do: 'click', want: '.nth(1)' },
    // The hidden twin is invisible to getByRole, so the visible button is not ambiguous
    // and must not fall back to an id or, worse, to an index that matches nothing.
    { on: '#save', do: 'click', want: "page.getByRole('button', { name: 'Save' }).click()" },
    // The dropdown option must not come back as page.locator('div').first().
    { on: '.option[data-value="2"]', do: 'click', want: "page.getByText('Cough', { exact: true }).click()" },
    // The widget's own input area has no text at all, so only a structural path is left.
    { on: '.selectize-input', do: 'click', want: 'selectize' },
];

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();

    const recorded = [];
    await page.exposeBinding('__record', (_s, step) => recorded.push(step), {});
    await page.setContent(PAGE);
    await page.evaluate(RECORDER);

    for (const step of expectations) {
        const locator = page.locator(step.on);
        if (step.do === 'click') await locator.click();
        if (step.do === 'fill') await locator.fill(step.value);
        if (step.do === 'select') await locator.selectOption({ label: step.value });
        if (step.do === 'check') await locator.check();
    }

    // Three clicks on one button are three acts, not an echo of one.
    const repeats = page.locator('#addRow');
    await repeats.click();
    await repeats.click();
    await repeats.click();

    await page.waitForTimeout(300);

    // Every locator has to resolve on the page it was recorded from. Producing the right
    // text is not the same as producing something Playwright can find.
    const unresolved = [];
    for (const step of recorded) {
        const built = step.locator.replace(/^page[.]/, '');
        let count;
        try {
            count = await eval('page.' + built).count();
        } catch (error) {
            count = 'threw: ' + error.message.split(String.fromCharCode(10))[0];
        }
        if (count !== 1) unresolved.push(count + '  <-  ' + step.locator);
    }

    await browser.close();

    // Rebuild the code line the recorder would have written for each captured step.
    const render = (s) => {
        if (s.kind === 'click') return s.locator + '.click()';
        if (s.kind === 'fill') return s.locator + ".fill('" + s.value + "')";
        if (s.kind === 'select') return s.locator + '.selectOption';
        if (s.kind === 'check') return s.locator + '.check()';
        return s.kind + ' ' + s.locator;
    };

    const produced = recorded.map(render);
    console.log('recorded ' + produced.length + ' actions:');
    for (const line of produced) console.log('  ' + line);

    const missing = expectations.filter((e) => !produced.some((p) => p.includes(e.want)));
    console.log('');
    if (missing.length) {
        console.log('FAILED - these were expected but not produced:');
        for (const m of missing) console.log('  ' + m.want);
        process.exit(1);
    }

    if (unresolved.length) {
        console.log('FAILED - these locators do not match exactly one element:');
        for (const u of unresolved) console.log('  ' + u);
        process.exit(1);
    }

    // record() is what writes the spec, so the repeat check has to go through it.
    for (const step of recorded) record(step);
    const addRow = lines.filter((l) => l.includes("'Add Row'")).length;
    if (addRow !== 3) {
        console.log('FAILED - three clicks on "Add Row" became ' + addRow + ' line(s) in the spec');
        process.exit(1);
    }

    console.log('OK - every expected locator was produced, resolves to one element,');
    console.log('     and repeated clicks survive into the spec');
})();
