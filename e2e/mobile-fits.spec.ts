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

/** Outcome of {@link ensureRenderableBoxSet}. */
interface BoxSetFixture {
    /** Id of the BoxSet to open (null only when the library has < 2 movies). */
    boxsetId: string | null;
    /** Id to delete in teardown; null when we reused an existing BoxSet. */
    createdId: string | null;
    /** True when the BoxSet is anchored to a TMDB collection with missing parts. */
    anchored: boolean;
}

/**
 * Guarantee a BoxSet exists to open, and — whenever the environment allows —
 * one whose "Missing from …" section will actually render, so the flagship
 * card assertions run instead of silently skipping.
 *
 * Strategy (all admin-API, in the browser's authenticated ApiClient context):
 *  1. Reuse an existing BoxSet whose TMDB collection still has missing parts.
 *  2. Otherwise discover a TMDB collection with missing parts from the library's
 *     movies (via the plugin's Seerr proxy), CREATE a BoxSet from two library
 *     movies, and anchor it to that collection (ProviderIds.Tmdb) so the
 *     section renders. Tracked for teardown.
 *  3. If Seerr yields no incomplete collection, still create a plain BoxSet so
 *     the "no BoxSet in the library" skip can never fire; the section-render
 *     skip then covers only the genuinely-cannot-render case.
 */
async function ensureRenderableBoxSet(page: any): Promise<BoxSetFixture> {
    return page.evaluate(async () => {
        const api = (window as any).ApiClient;
        const uid = api.getCurrentUserId();

        /** A TMDB collection has "missing" parts when any part isn't available (status 5). */
        const collectionHasMissing = async (collectionId: string | number): Promise<boolean> => {
            try {
                const c = await api.getJSON(api.getUrl('JellyfinElevate/jellyseerr/collection/' + collectionId));
                const parts = (c && c.parts) || [];
                return parts.length > 0 && parts.some((p: any) => ((p.mediaInfo && p.mediaInfo.status) || 1) !== 5);
            } catch {
                return false;
            }
        };

        // 1) Reuse an existing renderable BoxSet.
        const existing = await api.getItems(uid, {
            IncludeItemTypes: 'BoxSet', Recursive: true, Fields: 'ProviderIds', Limit: 50,
        });
        for (const bs of (existing.Items || [])) {
            const tmdb = bs.ProviderIds && bs.ProviderIds.Tmdb;
            if (tmdb && await collectionHasMissing(tmdb)) {
                return { boxsetId: bs.Id, createdId: null, anchored: true };
            }
        }

        // Library movies (for both discovery and seeding the created BoxSet).
        const movies = await api.getItems(uid, {
            IncludeItemTypes: 'Movie', Recursive: true, Fields: 'ProviderIds', Limit: 200,
        });
        const movieItems = movies.Items || [];

        // 2) Discover a TMDB collection with missing parts from a library movie.
        let collectionId: string | null = null;
        for (const m of movieItems) {
            const tmdb = m.ProviderIds && m.ProviderIds.Tmdb;
            if (!tmdb) continue;
            let detail: any;
            try {
                detail = await api.getJSON(api.getUrl('JellyfinElevate/jellyseerr/movie/' + tmdb));
            } catch {
                continue;
            }
            const cid = detail && detail.collection && detail.collection.id;
            if (cid && await collectionHasMissing(cid)) {
                collectionId = String(cid);
                break;
            }
        }

        // Need two library movies to seed a BoxSet.
        const seedIds = movieItems.slice(0, 2).map((m: any) => m.Id);
        if (seedIds.length < 2) return { boxsetId: null, createdId: null, anchored: false };

        const created = await api.ajax({
            type: 'POST',
            url: api.getUrl('Collections', { Name: 'JE E2E Fixture Collection', Ids: seedIds.join(',') }),
            dataType: 'json',
        });
        const createdId = created && created.Id;
        if (!createdId) return { boxsetId: null, createdId: null, anchored: false };

        // 3) Anchor to the discovered collection so the section can render.
        if (collectionId) {
            const dto = await api.getJSON(api.getUrl('Users/' + uid + '/Items/' + createdId, { Fields: 'ProviderIds,Path' }));
            dto.ProviderIds = dto.ProviderIds || {};
            dto.ProviderIds.Tmdb = collectionId;
            await api.ajax({
                type: 'POST',
                url: api.getUrl('Items/' + createdId),
                data: JSON.stringify(dto),
                contentType: 'application/json',
            });
        }

        return { boxsetId: createdId, createdId, anchored: !!collectionId };
    });
}

/** Best-effort teardown of a BoxSet created by the fixture. */
async function deleteBoxSet(page: any, id: string): Promise<void> {
    await page.evaluate(async (bid: string) => {
        try {
            await (window as any).ApiClient.ajax({ type: 'DELETE', url: (window as any).ApiClient.getUrl('Items/' + bid) });
        } catch {
            // best-effort — a leaked fixture BoxSet is harmless in the dev library.
        }
    }, id);
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

        // Guarantee a BoxSet to open (creating one when the library has none),
        // anchored to a TMDB collection with missing parts whenever Seerr can
        // supply one — so the assertions below actually run.
        const fixture = await ensureRenderableBoxSet(page);
        expect(fixture.boxsetId, 'a BoxSet must exist or be creatable (library needs >= 2 movies)').toBeTruthy();

        try {
            // Fixture setup is admin-API infrastructure, not the surface under
            // test — drop any noise it produced so only the detail-page render
            // counts toward the runtime-error assertion.
            consoleErrors.reset();

            await page.evaluate((id: string) => { void (window as any).Emby.Page.show('/details?id=' + id); }, fixture.boxsetId!);

            // The Missing-from section only renders when Seerr is active AND the
            // collection has movies not yet in the library.
            const appeared = await page
                .waitForFunction(
                    () => !!document.querySelector('.jellyseerr-collection-discovery-section .card'),
                    undefined,
                    { timeout: 20_000 }
                )
                .then(() => true, () => false);

            if (!appeared) {
                // Loud, explicit — the ONLY remaining legitimate skip. Never the
                // old "no BoxSet in the library" skip, which can no longer occur.
                console.warn(
                    `[mobile-fits] collection Missing-from section did NOT render for BoxSet ${fixture.boxsetId} ` +
                    `(anchored=${fixture.anchored}) — Seerr inactive or collection complete; skipping card assertions.`
                );
                test.skip(true, 'collection Missing-from section did not render (Seerr inactive or collection complete)');
            }

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
        } finally {
            if (fixture.createdId) await deleteBoxSet(page, fixture.createdId);
        }
    });
});
