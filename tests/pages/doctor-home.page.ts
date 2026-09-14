import { expect, type Locator, type Page } from '@playwright/test';
import { baseUrl } from '../config/test-env';
import { isVisibleWithin, pickRandom } from './selectize';

/**
 * /DoctorHome - what a doctor lands on after signing in: a Check In / Check Out control
 * and the queue of patients waiting for them, one row per prescription, each with a
 * radio in its first column. Selecting a row and pressing Edit opens that consultation's
 * prescription form.
 *
 * The recorded session does this as `#optradio` followed by `#Edit`, which works only
 * while the queue holds exactly one patient - `#optradio` is the id every row's radio
 * carries, so on a real queue it silently means "the first one". A run here reads the
 * queue, picks a row at random, and reports which patient it took, so two runs against
 * the same centre do not fight over the same consultation.
 */
export type QueuedPatient = {
    /** Row position in the queue, 0-based - only meaningful for the run that read it. */
    index: number;
    /** The centre-prefixed patient id off the row, where the row shows one. */
    displayId: string;
    /** The whole row, flattened, for the run log and the report annotation. */
    summary: string;
    /**
     * The consultation this row opens, as the row itself names it - the Attending
     * radio's value, or the View link's name. Empty only where the row named neither.
     */
    prescriptionId: string;
    /**
     * How this row gets opened, which is decided by the row itself:
     *
     *   'attending'    - not attended yet, so the row carries the Attending radio. Check
     *                    it, then Edit opens the consultation.
     *   'prescription' - already attended, so the radio is gone and the row carries a
     *                    View link in its Prescription column instead. That link is the
     *                    way back in.
     */
    via: 'attending' | 'prescription';
};

export class DoctorHomePage {
    constructor(private readonly page: Page) {}

    async open(): Promise<void> {
        await this.page.goto(`${baseUrl.replace(/\/$/, '')}/DoctorHome`);
        await this.page.waitForLoadState('load');
        await this.expectLoaded();
    }

    /**
     * DoctorHome's nav Home is an unnamed image link, so "Home" is not an accessible
     * name here. The greeting and the Check In / Check Out control are.
     */
    async expectLoaded(): Promise<void> {
        await expect(
            this.page
                .getByRole('heading', { name: /Hello Dr/i })
                .or(this.dutyButton())
                .first(),
            'DoctorHome did not load'
        ).toBeVisible({ timeout: 15000 });
    }

    /**
     * The duty control. There is one of these, not two:
     *
     *   <input id="Checkin" onclick="UpdateAvailability();" type="button" value="Check Out">
     *
     * and its label is the action it offers, flipped in place by the page itself
     * (`$("#Checkin").attr('value', isCheckedIn == 0 ? 'Check In' : 'Check Out')`). No
     * #Checkout element exists at any point. Matching on the id alone therefore finds the
     * control in either state, which is how a run meaning to come on duty clicked a button
     * reading "Check Out" and sent the doctor home instead.
     */
    private dutyButton(): Locator {
        return this.page.locator('#Checkin');
    }

    /**
     * The app's own record of the state, in a hidden field UpdateAvailability() keeps up
     * to date: 1 on duty, 0 off. Read that rather than the label, falling back to the
     * label when the field is not there.
     */
    private async isCheckedIn(): Promise<boolean> {
        const status = this.page.locator('#checkinstatus');

        if (await status.count()) {
            return (await status.inputValue()) === '1';
        }

        return /check\s*out/i.test((await this.dutyButton().getAttribute('value')) ?? '');
    }

    /**
     * A doctor who is not checked in cannot be handed a prescription: Doctor Selection's
     * availability call answers 0 and the pick is swallowed without a word (see
     * DoctorSelectionPage.selectDoctor). The label says which way the control will go, so
     * a doctor already on duty is left alone instead of being clicked off it.
     *
     * Reports whether it had to do anything, so a spec can say so rather than leaving the
     * doctor's state as an invisible side effect of the run.
     */
    async ensureCheckedIn(): Promise<boolean> {
        await expect(
            this.dutyButton(),
            'DoctorHome has no Check In / Check Out control'
        ).toBeVisible({ timeout: 15000 });

        if (await this.isCheckedIn()) {
            return false;
        }

        await this.dutyButton().click();

        // UpdateAvailability() posts SetCheckinStatus over AJAX and rewrites the label
        // in place, so there is no navigation to wait for - the label is the outcome.
        await expect(
            this.dutyButton(),
            'Check In did not take - the control still offers Check In, so the doctor is not on duty'
        ).toHaveValue(/check\s*out/i, { timeout: 15000 });

        return true;
    }

    /**
     * Puts the doctor back the way the run found them. Left to a spec's teardown so a
     * shared UAT account is not left checked in by a run that has finished.
     */
    async checkOut(): Promise<void> {
        if (!(await this.dutyButton().count())) {
            return;
        }

        if (!(await this.isCheckedIn().catch(() => false))) {
            return;
        }

        await this.dutyButton().click().catch(() => undefined);
        await expect(this.dutyButton())
            .toHaveValue(/check\s*in/i, { timeout: 15000 })
            .catch(() => undefined);
    }

    /**
     * The queue rows. A row is in the queue if it offers a way in, and there are two of
     * those depending on how far along the patient is:
     *
     *   - the Attending column's radio, on the grid
     *     (Sr. No | Status | Patient Id | Attending | Patient Name | Allocation Date |
     *     Type), for a patient the doctor has not attended yet; checking it is what marks
     *     them as the one being attended before Edit opens the consultation, or
     *   - a View link in the Prescription column, which is what a row already attended
     *     carries in place of the radio.
     *
     * Filtering on the radio alone hid the attended rows completely, so a queue holding
     * only those read as empty.
     */
    private queueRows(): Locator {
        return this.page.getByRole('row').filter({
            has: this.page
                .locator('input[type="radio"]')
                .or(this.page.getByRole('link', { name: /^\s*View\s*$/i })),
        });
    }

    /** The Attending column's radio, addressed through its own row. */
    private attendingRadio(row: Locator): Locator {
        return row.locator('input[type="radio"]').first();
    }

    /** The Prescription column's View link, on a row that has already been attended. */
    private prescriptionViewLink(row: Locator): Locator {
        return row
            .getByRole('link', { name: /^\s*View\s*$/i })
            .or(row.getByRole('button', { name: /^\s*View\s*$/i }))
            .first();
    }

    async waitingCount(): Promise<number> {
        await this.queueRows()
            .first()
            .waitFor({ state: 'visible', timeout: 15000 })
            .catch(() => undefined);
        return this.queueRows().count();
    }

    /**
     * Selects one waiting patient at random and reports who it was. Fails with the queue's
     * actual state rather than a bare timeout, because an empty queue is the ordinary
     * reason this spec cannot run and is worth saying outright.
     *
     * Random, but not indifferent: a row still carrying its Attending radio is a
     * consultation nobody has written yet, and those are the ones that open. A row whose
     * radio has gone has been attended already, and once its prescription is saved and
     * approved the patient summary drops "Start video call and edit prescription"
     * altogether — there is no way back into the form, and a run that drew one of those
     * failed for a reason that had nothing to do with the form. So the draw is made from
     * the unattended rows whenever the queue has any, and only falls back to the attended
     * ones for a queue made entirely of them.
     */
    async selectRandomWaitingPatient(): Promise<QueuedPatient> {
        const count = await this.waitingCount();

        expect(
            count,
            'DoctorHome lists no waiting patients, so there is no consultation to open. ' +
                'Raise one first (tests/patient/full-consultation.spec.ts registers a patient ' +
                'and hands their prescription to a doctor), or sign in as a doctor who has a queue.'
        ).toBeGreaterThan(0);

        const rows = this.queueRows();
        const notYetAttended: number[] = [];
        const alreadyAttended: number[] = [];

        for (let row = 0; row < count; row += 1) {
            if (await this.attendingRadio(rows.nth(row)).count()) notYetAttended.push(row);
            else alreadyAttended.push(row);
        }

        const index = pickRandom(notYetAttended.length > 0 ? notYetAttended : alreadyAttended);
        const row = rows.nth(index);

        const summary = (await row.innerText()).replace(/\s+/g, ' ').trim();
        const displayId = /\b([A-Z]{2,4}\d{5,})\b/.exec(summary)?.[1] ?? '';

        // Not attended yet: the radios all answer to id="optradio", so they are addressed
        // through their own row instead. force: true because the label sits over the
        // control on this grid.
        if (notYetAttended.includes(index)) {
            const radio = this.attendingRadio(row);

            // <input type="radio" id="optradio" value="7327998"
            //        onclick="changeStatus('optradio',7327998,0)"> — the consultation this
            // row opens is named in the value, which is worth having before the click:
            // changeStatus() marks the patient as being attended and re-renders the grid,
            // so the radio the run just clicked may not exist to be read afterwards.
            const prescriptionId = ((await radio.getAttribute('value')) ?? '').trim();

            // click() rather than check(): check() clicks and then asserts the control is
            // checked, which fails on a control the app has replaced in the meantime even
            // though the click did exactly what it should.
            await radio.click({ force: true });
            await this.page.waitForLoadState('load').catch(() => undefined);

            return { index, displayId, summary, prescriptionId, via: 'attending' };
        }

        // Already attended: nothing to select, and the row's own View link is what opens
        // the consultation again. Its name attribute carries the same id.
        const viewLink = this.prescriptionViewLink(row);

        await expect(
            viewLink,
            `Queue row ${index + 1} offers neither the Attending radio nor a Prescription ` +
                `View link, so there is no way into that consultation: ${summary}`
        ).toBeVisible({ timeout: 10000 });

        const prescriptionId = ((await viewLink.getAttribute('name')) ?? '').trim();

        return { index, displayId, summary, prescriptionId, via: 'prescription' };
    }

    /**
     * Opens the selected consultation's prescription form.
     *
     * The queue gives three different ways in and which one is there depends on the app
     * version and on how far along the patient is, so all three are tried in turn rather
     * than one being assumed:
     *
     *   - the row's own View link, which is what a row carries once it is being attended
     *     - and checking the Attending radio is what puts a row into that state, so this
     *     is the ordinary route for a patient the doctor has just taken on;
     *   - DoctorHome's Edit button, which older centres put under the grid for the
     *     selected row;
     *   - failing both, the id the row named (the radio's value, the link's name), opened
     *     as the plain GET the app's own handlers end up making.
     *
     * Either of the first two lands on /PrescriptionView?id=<id>, the patient's summary,
     * whose "Start video call and edit prescription" opens the form itself - see
     * openFormFromPatientSummary().
     *
     * Reports the prescription id out of the URL so the form can be held to the row it
     * was opened from.
     */
    async openPrescriptionForm(patient?: QueuedPatient): Promise<string> {
        // The id the queue row named, which is the same one the app's own handlers use.
        // It is what makes a consultation openable when the screen in front of the run
        // offers no way in - a View link whose handler never answered, a summary with no
        // video call button on it.
        const queuedId = /^\d+$/.test(patient?.prescriptionId ?? '')
            ? (patient as QueuedPatient).prescriptionId
            : '';

        const row = patient ? this.queueRows().nth(patient.index) : undefined;
        const viewLink = row ? this.prescriptionViewLink(row) : undefined;
        const edit = this.page.locator('#Edit');

        const entry = viewLink && (await isVisibleWithin(viewLink, 10000))
            ? viewLink
            : (await isVisibleWithin(edit, 10000))
              ? edit
              : undefined;

        if (entry) {
            await entry.click();
        } else if (!queuedId) {
            throw new Error(
                'The queue row offers neither a Prescription View link nor an Edit ' +
                    'button, and named no prescription id, so there is no way into that ' +
                    'consultation'
            );
        }

        // Both controls navigate from inside a lookup's callback rather than on the click
        // itself, so the run waits for that navigation rather than for the click - going
        // anywhere itself in the meantime only aborts the one the click started. A click
        // the handler never answered leaves the page on DoctorHome without a word, and
        // the id off the row is then the way in.
        const opened = entry
            ? await this.page
                  .waitForURL(/PrescriptionView|PrescriptionForm/i, { timeout: 15000 })
                  .then(() => true)
                  .catch(() => false)
            : false;

        if (!opened) {
            if (!queuedId) {
                throw new Error(
                    `The queue row for ${patient?.displayId || 'the selected patient'} did ` +
                        `not open: the run is still on ${this.page.url()} and the row named ` +
                        'no prescription id to open directly'
                );
            }

            console.log(
                `The queue did not open prescription ${queuedId} on its own; ` +
                    'opening the form directly'
            );
            await this.page.goto(
                `${baseUrl.replace(/\/$/, '')}/PrescriptionForm?id=${queuedId}`
            );
        }

        await this.page.waitForLoadState('load').catch(() => undefined);

        await expect(
            this.page,
            'The queue opened neither the patient summary nor the prescription form - the ' +
                'run is still on DoctorHome, which happens when no queue row was selected'
        ).toHaveURL(/PrescriptionView|PrescriptionForm/i, { timeout: 20000 });

        if (/PrescriptionView/i.test(this.page.url())) {
            await this.openFormFromPatientSummary();
        }

        await expect(
            this.page,
            '"Start video call and edit prescription" did not open the prescription form'
        ).toHaveURL(/PrescriptionForm/i, { timeout: 20000 });

        return /[?&]id=(\d+)/i.exec(this.page.url())?.[1] ?? '';
    }

    /**
     * Gets from the patient summary through to the prescription form.
     *
     * "Start video call and edit prescription" is a bare <input type="button"> - no href,
     * no submit behind it. Everything it does lives in a jQuery handler the page binds
     * when its own scripts run, which asks PrescriptionView/GetCallReceivedStatus and
     * only then sets window.location to /PrescriptionForm?id=<id>.
     *
     * Two things follow, and both look identical from the outside - a click that appears
     * to do nothing:
     *
     *   - The URL reads /PrescriptionView the moment the navigation commits, long before
     *     that page's scripts have run. A click landing in the gap hits a button with no
     *     handler on it yet and is swallowed without a word, so the click is held back
     *     until the handler is actually there.
     *   - The navigation sits inside the lookup's callback, and the handler answers only
     *     to 1 and 0. Anything else - an error, an empty body - falls through it, logging
     *     to the console and going nowhere. The fallback below covers that by going to
     *     the URL the handler would have gone to, which is the same GET.
     */
    private async openFormFromPatientSummary(): Promise<void> {
        // A consultation that has already been written comes back as "Pending Doctor
        // Approval", and the summary then carries an Approve button as well as the video
        // call one - approving is what that state is waiting for. In every other state
        // there is no such button and this step passes straight over it.
        const approve = this.approveButton();

        if (await approve.isVisible({ timeout: 3000 }).catch(() => false)) {
            await approve.click().catch(() => undefined);
            await this.page.waitForLoadState('load').catch(() => undefined);
        }

        const startCall = this.startVideoCallButton();
        const summaryId = /[?&]id=(\d+)/i.exec(this.page.url())?.[1] ?? '';

        // A summary with no video call button on it is a consultation this screen offers
        // no way back into - one left mid-attending by a run that stopped, among others.
        // The form itself is still a plain GET on the same id, so it is opened directly
        // rather than reported as a dead end; without an id there is genuinely nowhere
        // to go, and that is what the message says.
        if (!(await startCall.isVisible({ timeout: 10000 }).catch(() => false))) {
            if (!summaryId) {
                throw new Error(
                    'The patient summary has no "Start video call and edit prescription" ' +
                        'button and no prescription id in its URL, so there is no way ' +
                        'through to the prescription form'
                );
            }

            console.log(
                `The patient summary for prescription ${summaryId} offers no video call ` +
                    'button; opening the form directly'
            );
            await this.page.goto(
                `${baseUrl.replace(/\/$/, '')}/PrescriptionForm?id=${summaryId}`
            );
            return;
        }

        await this.page.waitForLoadState('load');

        // jQuery keeps its handlers in its own store rather than on the element, so the
        // binding can only be read back through jQuery. Not being able to read it is not
        // a failure - the click is still worth making, and the fallback catches the rest.
        await this.page
            .waitForFunction(
                () => {
                    const jq = (window as unknown as { jQuery?: any }).jQuery;
                    const button = document.querySelector('#Edit');
                    return !!jq && !!button && !!jq._data(button, 'events')?.click;
                },
                undefined,
                { timeout: 10000 }
            )
            .catch(() => undefined);

        // Bounded, and its failure left to the fallback below: the button is there and
        // visible but not always clickable - the summary re-renders under it, and a
        // click that waits for actionability with no limit waits out the whole test
        // rather than falling through to the URL it would have gone to.
        await startCall.click({ timeout: 15000 }).catch(() => undefined);

        const opened = await this.page
            .waitForURL(/PrescriptionForm/i, { timeout: 15000 })
            .then(() => true)
            .catch(() => false);

        if (opened) {
            return;
        }

        const prescriptionId = /[?&]id=(\d+)/i.exec(this.page.url())?.[1] ?? '';

        console.log(
            '"Start video call and edit prescription" did not navigate for prescription ' +
                `${prescriptionId || '(no id in the summary URL)'}; opening the form directly`
        );

        await this.page.goto(
            `${baseUrl.replace(/\/$/, '')}/PrescriptionForm?id=${prescriptionId}`
        );
    }

    /**
     * The summary's Approve button, which the app puts up only while a prescription is
     * "Pending Doctor Approval".
     */
    private approveButton(): Locator {
        return this.page
            .getByRole('button', { name: /^\s*Approve\s*$/i })
            .or(this.page.locator('#Approve'))
            .first();
    }

    /**
     * The patient summary's own #Edit. Named by its label as well, because #Edit is the
     * id DoctorHome's own button carries too and the two screens are one click apart.
     */
    private startVideoCallButton(): Locator {
        return this.page
            .locator('#Edit')
            .or(
                this.page.getByRole('button', {
                    name: /start video call and edit prescription/i,
                })
            )
            .first();
    }
}
