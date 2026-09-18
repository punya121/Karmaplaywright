import { expect, type Locator, type Page } from '@playwright/test';
import { isVisibleWithin } from './selectize';

/**
 * The centre's side of a doctor call.
 *
 * Once a visit has been handed over and the doctor opens it - "Start video call and edit
 * prescription" on the patient summary - the centre is rung. The call does not open
 * anything by itself: it arrives on whatever page the centre is sitting on (CentreHome,
 * after the handover) as a snackbar along the bottom of the screen, and the only way into
 * the call is the "Click here" inside it. Clicking it opens /DocCall/DoctorSession/<id>,
 * which is where the centre and the doctor are actually on the call together.
 *
 * Three things about that snackbar decide how it is driven here:
 *
 *   - It is pushed onto the open page, not rendered by a load. So it is waited for, and
 *     never waited for across a reload - reloading the page throws the notification away
 *     and the centre is left waiting for a call that has already been placed.
 *   - It is a bar of text with a link in it, so "Click here" is matched exactly rather
 *     than by role; the same words appear in other toasts the app raises, which is why
 *     the snackbar container is what is searched, with the DocCall link as the fallback.
 *   - The session sometimes opens in a window of its own rather than in the tab that was
 *     clicked, so both are accepted and whichever one carries the session is handed back.
 */
export type AnsweredCall = {
    /** The page the doctor session ended up on - the centre's own tab, or a popup. */
    page: Page;
    /** /DocCall/DoctorSession/<id> as opened. */
    url: string;
    /**
     * Everything the session URL carries past /DoctorSession - on UAT that is
     * `<doctor id>/<centre id>/<prescription id>/<call id>`, e.g. 362/13/7328015/8 -
     * so the consultation the centre was rung into can be read straight off it.
     * Empty only if the app left it out.
     */
    sessionId: string;
    /** True when the session opened in a window of its own. */
    inPopup: boolean;
    /** The call controls found on the session - "Mute", "End Call" - for the report. */
    controls: string[];
};

/** How long the centre waits to be rung before the run says it never was. */
const callTimeout = Number(process.env.E2E_CALL_NOTIFICATION_TIMEOUT ?? 120000);

export class DoctorCallPage {
    constructor(private readonly page: Page) {}

    /**
     * The "Click here" the centre is rung with. The snackbar is the app's own
     * `div.snackbar-container`; the link straight to /DocCall/DoctorSession is the same
     * notification read a different way, and covers a run against a build that renders
     * the toast through something else.
     */
    private notification(): Locator {
        const snackbar = this.page.locator('div.snackbar-container');

        return snackbar
            .getByText('Click here', { exact: true })
            .or(snackbar.getByRole('link', { name: /click here/i }))
            .or(this.page.locator('a[href*="DocCall/DoctorSession"]'))
            .first();
    }

    /**
     * Answers the call: clicks the notification and waits for the doctor session it
     * opens, in whichever page it opened in. The notification is what is waited on
     * first - `timeout` is how long the centre is willing to be left un-rung - and its
     * absence is reported as a call that was never placed rather than as a missing
     * element.
     */
    async answerCall(timeout = callTimeout): Promise<AnsweredCall> {
        const notification = this.notification();

        await expect(
            notification,
            `The centre was not rung within ${Math.round(timeout / 1000)}s of the doctor ` +
                'opening the consultation: no "Click here" notification came up on ' +
                `${this.page.url()}. The doctor places the call by opening the visit from ` +
                'their queue, so either that has not happened yet or this build does not ' +
                'notify the centre.'
        ).toBeVisible({ timeout });

        // The session all but always opens in the tab that was clicked, and just
        // occasionally in a window of its own, so the tab is what is watched and the
        // popup is only fallen back to when it never moved. Listening for the popup has
        // to start before the click either way - a window opened while nothing is
        // listening is missed.
        const popup = this.page.waitForEvent('popup', { timeout: 15000 }).catch(() => undefined);

        await notification.click();

        // toHaveURL and not waitForURL, which is what the first run of this stage failed
        // on: waitForURL waits for the page's load event as well as its URL, and the
        // doctor session never fires one - it comes up and then holds the connection
        // open for the call. The run sat on /DocCall/DoctorSession/362/13/7328015/8 being
        // told no session had opened. toHaveURL polls the URL and nothing else, which is
        // the whole of the question being asked here.
        const sessionUrl = /DocCall\/DoctorSession/i;
        const movedHere = await expect(this.page)
            .toHaveURL(sessionUrl, { timeout: 15000 })
            .then(() => true)
            .catch(() => false);

        const session = movedHere ? this.page : ((await popup) ?? this.page);

        if (!movedHere) {
            const arrived = await expect(session)
                .toHaveURL(sessionUrl, { timeout: 30000 })
                .then(() => true)
                .catch(() => false);

            if (!arrived) {
                throw new Error(
                    'The call notification was clicked but no doctor session opened - the ' +
                        `centre is still on ${session.url()}`
                );
            }
        }

        // The markup is there once the document is parsed; the load event is not waited
        // for, for the reason above, and its absence is not a failure either.
        await session
            .waitForLoadState('domcontentloaded', { timeout: 15000 })
            .catch(() => undefined);

        return {
            page: session,
            url: session.url(),
            sessionId: /DoctorSession\/([^?#]+)/i.exec(session.url())?.[1]?.replace(/\/$/, '') ?? '',
            inPopup: session !== this.page,
            controls: await this.callControls(session),
        };
    }

    /**
     * What the session is offering - Mute, End Call - read for the report rather than
     * asserted on. Being on /DocCall/DoctorSession is what says the centre answered; the
     * controls differ by build and by whether the camera came up, and a run that failed
     * over a missing Mute button would be reporting the hardware.
     */
    private async callControls(session: Page = this.page): Promise<string[]> {
        const controls: Array<[string, RegExp]> = [
            ['Mute', /^\s*Mute\s*$/i],
            ['Unmute', /^\s*Unmute\s*$/i],
            ['End Call', /^\s*End\s*Call\s*$/i],
            ['Video', /^\s*(Start|Stop)?\s*Video\s*$/i],
        ];
        const found: string[] = [];

        for (const [name, pattern] of controls) {
            const control = session.getByRole('button', { name: pattern }).first();

            if (await isVisibleWithin(control, 2000)) {
                found.push(name);
            }
        }

        return found;
    }
}
