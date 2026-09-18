import type { Page } from '@playwright/test';
import { baseUrl } from './../config/test-env';

/**
 * Tabs the app opens that the run has no business being on.
 *
 * Some of the app's buttons open a second tab that is not part of the flow at all - the
 * Google Drive page the Doctor Selection Save raises, which comes up as Drive's own error
 * page and just sits there. It is not a failure and there is nothing on it to act on, but
 * it takes the focus, and a run that treated whatever tab is frontmost as "the page" would
 * carry on against a tab that has none of the app on it and then report that the app's
 * controls have all disappeared.
 *
 * So the rule is: a tab that is not on the app's own origin is not the run's tab. It is
 * closed and the run goes back to the one it was testing on.
 */

/** The app's own origin, so a tab can be told apart from a tab belonging to anything else. */
const appOrigin = (() => {
    try {
        return new URL(baseUrl).origin;
    } catch {
        return '';
    }
})();

/**
 * True for a tab the run should stay away from: anything that is not the app, plus the
 * blank and error pages a popup blocked or failed navigation leaves behind.
 *
 * `about:blank` is deliberately included. A tab the app opened and never navigated is
 * indistinguishable from one it opened for a URL that failed, and neither has anything on
 * it - but a tab still on about:blank a moment after opening may yet be navigating, which
 * is why the URL is read again after a beat rather than once.
 */
function isStray(url: string): boolean {
    if (!url || url === 'about:blank') {
        return true;
    }

    if (/^(chrome-error|chrome|edge|about|data):/i.test(url)) {
        return true;
    }

    if (!appOrigin) {
        return false;
    }

    try {
        return new URL(url).origin !== appOrigin;
    } catch {
        return true;
    }
}

/**
 * Watches `page`'s context for stray tabs until the returned function is called, closing
 * each one and putting `page` back in front.
 *
 * Armed before the click rather than checked after it: a tab that opens and takes the
 * focus does so while the click is still returning, and the app's own page is the one the
 * run must be on when it looks for what the click did.
 *
 * Returns what it closed, for the log - a run that quietly closed a tab the app meant to
 * show would otherwise look like a run whose step simply vanished.
 */
export function guardAgainstStrayTabs(page: Page): () => Promise<string[]> {
    const closed: string[] = [];
    const settling: Promise<void>[] = [];

    const onPage = (opened: Page) => {
        if (opened === page) {
            return;
        }

        settling.push(
            (async () => {
                // A tab opens on about:blank and navigates a moment later, so its first URL
                // says nothing about where it is going. This gives it that moment before
                // judging it, and settles for whatever it holds if it never gets there.
                await opened.waitForLoadState('domcontentloaded').catch(() => undefined);
                await opened
                    .waitForURL((url) => url.href !== 'about:blank', { timeout: 3000 })
                    .catch(() => undefined);

                const url = opened.url();

                if (!isStray(url)) {
                    return;
                }

                // A tab still on about:blank may be one the app wrote into directly rather
                // than one it failed to navigate, and that one has something on it and is
                // the app's. Anything with content is left alone.
                if (url === 'about:blank') {
                    const hasContent = await opened
                        .evaluate(() => (document.body?.innerText ?? '').trim().length > 0)
                        .catch(() => false);

                    if (hasContent) {
                        return;
                    }
                }

                closed.push(url);
                await opened.close().catch(() => undefined);
                await page.bringToFront().catch(() => undefined);
            })()
        );
    };

    page.context().on('page', onPage);

    return async () => {
        page.context().off('page', onPage);

        // Any tab that opened during the window but has not been dealt with yet is waited
        // for here, so the caller is not left racing a tab that is still being closed.
        await Promise.all(settling);

        // Tabs that were already open before the watch was armed - a previous step's
        // leftovers - are swept too, for the same reason.
        for (const other of page.context().pages()) {
            if (other === page || other.isClosed()) {
                continue;
            }

            if (isStray(other.url())) {
                closed.push(other.url());
                await other.close().catch(() => undefined);
            }
        }

        if (closed.length > 0) {
            console.log(
                `Closed ${closed.length} tab(s) the app opened that are not part of the run ` +
                    `(${closed.join(', ')}) and went back to ${page.url()}`
            );
        }

        await page.bringToFront().catch(() => undefined);

        return closed;
    };
}
