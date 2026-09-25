import type { Page } from '@playwright/test';
import { baseUrl } from '../config/test-env';

/**
 * What a page did wrong while the run was on it.
 *
 * A screen that renders is not the same as a screen that works. The app is server
 * rendered with jQuery on top, so the two ways it breaks in practice leave nothing on
 * the page for an assertion to find:
 *
 *   - a handler throws (`Cannot read properties of null`), the rest of that script never
 *     runs, and the screen sits there looking finished with half its behaviour missing;
 *   - a background request answers 500 and the grid it was filling simply stays empty,
 *     which is indistinguishable from a grid that is empty because there is nothing in it.
 *
 * So a sweep watches the browser as well as the DOM: every uncaught exception, every
 * response the server refused, every request that never arrived. That is what turns
 * "the page opened" into "the page worked".
 */
export type ProblemKind =
    | 'page-error'
    | 'server-error'
    | 'not-found'
    | 'request-failed'
    | 'console-error';

export type PageProblem = {
    kind: ProblemKind;
    /** The URL the problem is about — the request's, or the page's for a script error. */
    where: string;
    detail: string;
};

export type PageHealth = {
    /**
     * Problems worth failing a test over: an uncaught script error, a 5xx, a document
     * that 404s. Each one is a defect on its own, whatever the screen looks like.
     */
    faults(): PageProblem[];
    /**
     * Everything else that is worth a QA reader's attention but is not, by itself, proof
     * of a broken screen — a missing image, a console error the app carries on past.
     * Reported, never failed on: a run that failed on console noise would be red every
     * day and would stop being read.
     */
    findings(): PageProblem[];
    /** Drops everything seen so far, so the next section is judged on its own. */
    reset(): void;
    /** Stops watching. Call it before the page is closed. */
    stop(): void;
};

/** The app's own origin — a third party's failing beacon is not this portal's bug. */
const appOrigin = (() => {
    try {
        return new URL(baseUrl).origin;
    } catch {
        return '';
    }
})();

function isAppUrl(url: string): boolean {
    if (!appOrigin) {
        return true;
    }

    try {
        return new URL(url).origin === appOrigin;
    } catch {
        return false;
    }
}

/**
 * Text a server-side crash puts on the page. ASP.NET answers an unhandled exception
 * with a rendered page and, depending on customErrors, an HTTP 200 — so the status code
 * alone does not catch it and the body has to be read.
 */
const SERVER_ERROR_SIGNATURES =
    /(Server Error in '.*' Application|Runtime Error|Unhandled exception|Object reference not set to an instance|System\.(?:NullReference|InvalidOperation|Data\.SqlClient|Web\.HttpException)|Stack Trace:)/i;

/**
 * Reads the rendered page for a server-side crash. Returns the line that gave it away,
 * or an empty string when the page is clean.
 */
export async function serverErrorOnPage(page: Page): Promise<string> {
    const body = await page
        .evaluate(() => (document.body?.innerText ?? '').slice(0, 4000))
        .catch(() => '');

    const match = SERVER_ERROR_SIGNATURES.exec(body);
    if (!match) {
        return '';
    }

    // The matched phrase with a little of what surrounds it, so the report says which
    // exception rather than just "an exception".
    const at = body.indexOf(match[0]);
    return body.slice(at, at + 220).replace(/\s+/g, ' ').trim();
}

/**
 * Watches `page` for the failures that leave no mark on the DOM.
 *
 * Armed once for the whole run and reset between sections rather than re-armed each
 * time: a response that arrives just after a section has been judged still belongs to
 * that section's page, and a listener attached per section would miss it or blame the
 * next one.
 */
export function watchPageHealth(page: Page): PageHealth {
    let faults: PageProblem[] = [];
    let findings: PageProblem[] = [];

    const onPageError = (error: Error) => {
        faults.push({
            kind: 'page-error',
            where: page.url(),
            detail: `Uncaught in the page: ${error.message.split('\n')[0]}`,
        });
    };

    const onConsole = (message: { type(): string; text(): string }) => {
        if (message.type() !== 'error') {
            return;
        }

        findings.push({
            kind: 'console-error',
            where: page.url(),
            detail: message.text().replace(/\s+/g, ' ').slice(0, 300),
        });
    };

    const onResponse = (response: {
        url(): string;
        status(): number;
        request(): { resourceType(): string };
    }) => {
        const url = response.url();
        if (!isAppUrl(url)) {
            return;
        }

        const status = response.status();
        const isDocument = response.request().resourceType() === 'document';

        if (status >= 500) {
            faults.push({
                kind: 'server-error',
                where: url,
                detail: `The server answered ${status}`,
            });
            return;
        }

        if (status === 404) {
            // A page that does not exist is a broken section. A missing icon is not, so
            // it is reported without failing the run.
            (isDocument ? faults : findings).push({
                kind: 'not-found',
                where: url,
                detail: `404 on ${isDocument ? 'the page itself' : response.request().resourceType()}`,
            });
        }
    };

    const onRequestFailed = (request: {
        url(): string;
        failure(): { errorText: string } | null;
        resourceType(): string;
    }) => {
        const url = request.url();
        if (!isAppUrl(url)) {
            return;
        }

        const errorText = request.failure()?.errorText ?? 'the request failed';

        // Leaving a page cancels whatever it still had in flight. That is the run's own
        // doing, not the app's.
        if (/ERR_ABORTED/i.test(errorText)) {
            return;
        }

        const isDocument = request.resourceType() === 'document';
        (isDocument ? faults : findings).push({
            kind: 'request-failed',
            where: url,
            detail: `${errorText} (${request.resourceType()})`,
        });
    };

    page.on('pageerror', onPageError);
    page.on('console', onConsole);
    page.on('response', onResponse);
    page.on('requestfailed', onRequestFailed);

    return {
        faults: () => [...faults],
        findings: () => [...findings],
        reset: () => {
            faults = [];
            findings = [];
        },
        stop: () => {
            page.off('pageerror', onPageError);
            page.off('console', onConsole);
            page.off('response', onResponse);
            page.off('requestfailed', onRequestFailed);
        },
    };
}

/** One line per problem, for an assertion message or the terminal. */
export function describeProblems(problems: PageProblem[]): string {
    return problems.map((p) => `  - [${p.kind}] ${p.detail} — ${p.where}`).join('\n');
}
