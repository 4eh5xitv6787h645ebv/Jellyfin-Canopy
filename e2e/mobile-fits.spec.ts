// Mobile-viewport fit checks for the plugin's injected surfaces (issues 31/32/33).
//
// On the Jellyfin 12 modern layout the html carries `layout-desktop` at every
// viewport (docs/v12-platform.md §1), so the plugin's old `.layout-mobile`-gated
// responsive CSS never fired on a real phone. These checks run at a phone
// viewport and assert the surfaces fit:
//   - the settings/help panel and its shortcuts columns fit the panel (no clip),
//   - the standalone pages (Hidden Content, Calendar, Requests) don't scroll
//     horizontally and the Hidden Content heading clears the header,
//   - the collection "Missing from …" cards are native-grid-sized (≈3 across),
//     not the vw-based giants (≈2 across) they used to be.
import { test, expect, loginAs, assertNoRuntimeErrors } from './fixtures/auth';

/* eslint-disable @typescript-eslint/no-explicit-any */

// Phone viewport. isMobile/hasTouch make the context behave like a touch device;
// the layout still resolves to the modern (layout-desktop) layout, which is
// exactly the case the old .layout-mobile rules missed.
test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
});

/** Horizontal overflow of the whole document (px). 0 = no horizontal scroll. */
async function docOverflow(page: any): Promise<number> {
    return page.evaluate(() => document.scrollingElement!.scrollWidth - window.innerWidth);
}

/** Navigate back to home so the next standalone page opens from a clean state. */
async function goHome(page: any): Promise<void> {
    await page.evaluate(() => { window.location.hash = '#/home'; });
    await page.waitForTimeout(500);
}

test.describe('mobile viewport fits', () => {
    test('settings panel + shortcuts fit the phone (no clipping)', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);

        await page.evaluate(() => { void (window as any).JellyfinElevate.showEnhancedPanel(); });
        const panel = page.locator('#jellyfin-elevate-panel');
        await expect(panel).toBeVisible({ timeout: 15_000 });

        // Show the shortcuts tab if present (config may disable shortcuts).
        const shortcutsTab = panel.locator('.tab-button[data-tab="shortcuts"]');
        if (await shortcutsTab.count()) {
            await shortcutsTab.click();
            await page.waitForTimeout(200);
        }

        const geom = await page.evaluate(() => {
            const p = document.getElementById('jellyfin-elevate-panel')!;
            const pr = p.getBoundingClientRect();
            const cols = [...p.querySelectorAll('.shortcuts-container > div')].map(
                (c) => Math.round(c.getBoundingClientRect().width)
            );
            return {
                left: Math.round(pr.left),
                right: Math.round(pr.right),
                width: Math.round(pr.width),
                innerW: window.innerWidth,
                // widest shortcut column — must fit inside the panel (the old
                // 400px min-width made these overflow and clip).
                maxCol: cols.length ? Math.max(...cols) : 0,
            };
        });

        // Panel is within the viewport.
        expect(geom.left).toBeGreaterThanOrEqual(-1);
        expect(geom.right).toBeLessThanOrEqual(geom.innerW + 1);
        // Shortcut columns fit inside the panel (no clipped labels).
        expect(geom.maxCol).toBeLessThanOrEqual(geom.width + 1);
        // The panel does not force the page to scroll sideways.
        expect(await docOverflow(page)).toBeLessThanOrEqual(1);

        await page.keyboard.press('Escape');
        await expect(panel).toBeHidden({ timeout: 10_000 });
        assertNoRuntimeErrors(consoleErrors);
    });

    test('Hidden Content page: heading clears the header, no horizontal scroll', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);

        await page.evaluate(() => { (window as any).JellyfinElevate.hiddenContentPage.showPage(); });
        await page.waitForSelector('.je-hidden-content-title', { state: 'visible', timeout: 30_000 });

        const layout = await page.evaluate(() => {
            const header = document.querySelector('.MuiAppBar-root') || document.querySelector('.skinHeader');
            const headerBottom = header ? header.getBoundingClientRect().bottom : 0;
            const title = document.querySelector('.je-hidden-content-title')!;
            return {
                headerBottom: Math.round(headerBottom),
                titleTop: Math.round(title.getBoundingClientRect().top),
            };
        });

        // The heading sits fully below the fixed header (not clipped under it).
        expect(layout.titleTop).toBeGreaterThanOrEqual(layout.headerBottom - 1);
        expect(await docOverflow(page)).toBeLessThanOrEqual(1);
        assertNoRuntimeErrors(consoleErrors);
    });

    test('standalone pages do not scroll horizontally', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);

        await page.evaluate(() => { (window as any).JellyfinElevate.calendarPage.showPage(); });
        await page.waitForSelector('#je-calendar-container', { state: 'visible', timeout: 30_000 });
        await page.waitForTimeout(1000);
        expect(await docOverflow(page), 'calendar page horizontal overflow').toBeLessThanOrEqual(1);

        await goHome(page);
        await page.evaluate(() => { (window as any).JellyfinElevate.downloadsPage.showPage(); });
        await page.waitForSelector('#je-downloads-container', { state: 'visible', timeout: 30_000 });
        await page.waitForTimeout(1500);
        expect(await docOverflow(page), 'requests page horizontal overflow').toBeLessThanOrEqual(1);

        assertNoRuntimeErrors(consoleErrors);
    });

    test('collection Missing-from cards are native-grid-sized (≈3 across)', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);

        // Find a BoxSet to open. Skip if the library has none.
        const boxsetId = await page.evaluate(async () => {
            const uid = (window as any).ApiClient.getCurrentUserId();
            const res = await (window as any).ApiClient.getItems(uid, {
                IncludeItemTypes: 'BoxSet', Recursive: true, Limit: 1,
            });
            return res.Items?.[0]?.Id ?? null;
        });
        test.skip(!boxsetId, 'no BoxSet in the library');

        await page.evaluate((id) => { void (window as any).Emby.Page.show('/details?id=' + id); }, boxsetId);

        // The Missing-from section only renders when Seerr is active and the
        // collection has movies not yet in the library. If it never appears
        // (no Seerr / complete collection), there is nothing to assert here.
        const appeared = await page
            .waitForFunction(
                () => !!document.querySelector('.jellyseerr-collection-discovery-section .card'),
                undefined,
                { timeout: 20_000 }
            )
            .then(() => true, () => false);
        test.skip(!appeared, 'collection Missing-from section did not render (Seerr inactive or complete)');

        const m = await page.evaluate(() => {
            const section = document.querySelector('.jellyseerr-collection-discovery-section')!;
            const cards = [...section.querySelectorAll<HTMLElement>('.card')];
            let maxRight = 0;
            for (const c of cards) maxRight = Math.max(maxRight, c.getBoundingClientRect().right);
            return {
                cardW: Math.round(cards[0].getBoundingClientRect().width),
                sectionMaxRight: Math.round(maxRight),
                innerW: window.innerWidth,
                usesPortraitCard: cards[0].classList.contains('portraitCard'),
                usesOverflowCard: cards[0].classList.contains('overflowPortraitCard'),
            };
        });

        // Native portraitCard sizing: ~33% of the row → roughly 3 across, never
        // the old vw-based overflowPortraitCard (~40vw → 2 giant cards).
        expect(m.usesPortraitCard).toBe(true);
        expect(m.usesOverflowCard).toBe(false);
        expect(m.cardW).toBeGreaterThan(Math.round(m.innerW * 0.24));
        expect(m.cardW).toBeLessThan(Math.round(m.innerW * 0.37));
        // The section itself never scrolls the page sideways.
        expect(m.sectionMaxRight).toBeLessThanOrEqual(m.innerW + 1);

        assertNoRuntimeErrors(consoleErrors);
    });
});
