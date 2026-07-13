// The shared pages-framework lifecycle contract, per page: opening lands on
// a real routed view, navigating away REMOVES the content from the document
// (the ghost-page bug: page content lingering over other views until a
// refresh), browser back re-opens it, deep links and refreshes render it,
// and switching directly between two pages tears the first one down.
import { test, expect, loginAs } from './fixtures/auth';

/* eslint-disable @typescript-eslint/no-explicit-any */

const PAGES = [
    { id: 'calendar', route: '#/calendar', facade: 'calendarPage', marker: '#jc-calendar-container' },
    { id: 'downloads', route: '#/downloads', facade: 'downloadsPage', marker: '#jc-downloads-container' },
    { id: 'bookmarks', route: '#/bookmarks', facade: 'bookmarksPage', marker: '#jc-bookmarks-container' },
    { id: 'hidden-content', route: '#/hidden-content', facade: 'hiddenContentPage', marker: '#jc-hidden-content-container' },
] as const;

async function openViaFacade(page: any, facade: string): Promise<void> {
    await page.evaluate((name: string) => {
        (window as any).JellyfinCanopy[name].showPage();
    }, facade);
}

async function expectGone(page: any, marker: string): Promise<void> {
    // The content must be OUT of the document (or emptied), not merely
    // covered — a hidden-but-present page is exactly the ghost bug.
    await page.waitForFunction(
        (sel: string) => {
            const el = document.querySelector(sel);
            return !el || !el.isConnected || el.childElementCount === 0;
        },
        marker,
        { timeout: 15_000 }
    );
}

test.describe('pages lifecycle (shared framework)', () => {
    for (const info of PAGES) {
        test(`${info.id}: open → away → gone; back reopens; direct URL works`, async ({ page, consoleErrors }) => {
            await loginAs(page, 'admin', consoleErrors);

            const enabled = await page.evaluate((id: string) => {
                const cfg = (window as any).JellyfinCanopy?.pluginConfig || {};
                const flags: Record<string, string> = {
                    'calendar': 'CalendarPageEnabled',
                    'downloads': 'DownloadsPageEnabled',
                    'bookmarks': 'BookmarksEnabled',
                    'hidden-content': 'HiddenContentEnabled',
                };
                return !!cfg[flags[id]];
            }, info.id);
            test.skip(!enabled, `${info.id} disabled on this server`);

            // Open via the facade (the entry points call the same path).
            await openViaFacade(page, info.facade);
            await page.waitForSelector(info.marker, { state: 'visible', timeout: 30_000 });
            expect(page.url()).toContain(info.route);

            // Navigate away through the app's own router — the page content
            // must leave the document. THE core regression test.
            await page.evaluate(() => { (window as any).Emby.Page.show('/home'); });
            await page.waitForSelector('#indexPage', { state: 'visible', timeout: 30_000 });
            await expectGone(page, info.marker);
            expect(page.url()).not.toContain(info.route);

            // Browser back re-enters the page (fresh adoption).
            await page.goBack();
            await page.waitForSelector(info.marker, { state: 'visible', timeout: 30_000 });

            // Browser back again returns home and the page is gone again.
            await page.goBack();
            await page.waitForSelector('#indexPage', { state: 'visible', timeout: 30_000 });
            await expectGone(page, info.marker);

            expect(consoleErrors.real()).toEqual([]);
        });
    }

    test('deep link and refresh render the page (no Page-not-found)', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);

        // Deep navigation to the URL from a running session.
        await page.evaluate(() => { (window as any).Emby.Page.show('/calendar'); });
        await page.waitForSelector('#jc-calendar-container', { state: 'visible', timeout: 30_000 });

        // Full reload ON the page URL: the router renders its fallback for
        // our route and the framework adopts it at boot.
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#jc-calendar-container', { state: 'visible', timeout: 60_000 });
        const notFoundVisible = await page.evaluate(() =>
            /page not found/i.test(document.body.innerText));
        expect(notFoundVisible, 'the 404 shell must not remain visible').toBe(false);

        expect(consoleErrors.real()).toEqual([]);
    });

    test('page → page direct switch tears the first page down', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);

        await openViaFacade(page, 'calendarPage');
        await page.waitForSelector('#jc-calendar-container', { state: 'visible', timeout: 30_000 });

        await openViaFacade(page, 'downloadsPage');
        await page.waitForSelector('#jc-downloads-container', { state: 'visible', timeout: 30_000 });
        expect(page.url()).toContain('#/downloads');
        await expectGone(page, '#jc-calendar-container');

        // And back out to home cleans up the second page too.
        await page.evaluate(() => { (window as any).Emby.Page.show('/home'); });
        await page.waitForSelector('#indexPage', { state: 'visible', timeout: 30_000 });
        await expectGone(page, '#jc-downloads-container');

        expect(consoleErrors.real()).toEqual([]);
    });

    test('non-admin: pages open and close cleanly too', async ({ page, consoleErrors }) => {
        await loginAs(page, 'user', consoleErrors);

        await openViaFacade(page, 'calendarPage');
        await page.waitForSelector('#jc-calendar-container', { state: 'visible', timeout: 30_000 });
        await page.evaluate(() => { (window as any).Emby.Page.show('/home'); });
        await page.waitForSelector('#indexPage', { state: 'visible', timeout: 30_000 });
        await expectGone(page, '#jc-calendar-container');

        expect(consoleErrors.real()).toEqual([]);
    });
});
