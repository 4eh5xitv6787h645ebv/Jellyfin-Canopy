// List-view tag suppression (issue 34).
//
// In library List view the native row thumbnail is a tiny ~4em (64px, min ~44px)
// `.listItemImage` (jellyfin-web components/listview/listview.scss). The tag
// pipeline used to scan `div.listItemImage` alongside `.cardImageContainer` and
// render the full-size genre/language/quality/rating overlays straight into that
// thumbnail, burying the artwork. The fix excludes every `.listItem` row at the
// single shared pipeline gate (src/enhanced/tag-pipeline.ts isListViewRow), so
// list rows carry NO JE tag overlays while poster/grid CARD views are untouched.
//
// This spec proves BOTH halves in one session, on the exact reported surface (a
// real library toggled to List view):
//   - positive control: in the default GRID view the same items DO get tagged,
//     so the pipeline is provably alive and fast this session;
//   - the assertion (real regression guard): after switching the same library to
//     List view, no `.listItem` row carries any `*-overlay-container`. THIS is what
//     the bug produced (card-sized overlays rendered into the tiny row thumbnail)
//     and what the fix removes.
//
// The spec also checks that no row carries a `.je-tag-host` or a `data-je-*-tagged`
// marker, but those are INVARIANT SANITY CHECKS, not proof of the fix: even with
// the bug present neither artifact ever landed on a list row — `.je-tag-host` is
// only ever created inside a `.cardScalable` (resolveRenderTarget) and the
// `data-je-*-tagged` markers stamp onto `.card`, neither of which exists on a
// `.listItem`. They guard against a future renderer regressing that invariant.
// It restores the library's original view-mode setting on the way out (try/finally).
import { test, expect, loginAs, showRoute, waitForHash } from './fixtures/auth';

/* eslint-disable @typescript-eslint/no-explicit-any */

// setting flag → the marker each family's renderer stamps when it renders.
const FAMILIES = [
    { setting: 'qualityTagsEnabled', attr: 'data-je-quality-tagged' },
    { setting: 'genreTagsEnabled', attr: 'data-je-genre-tagged' },
    { setting: 'languageTagsEnabled', attr: 'data-je-language-tagged' },
    { setting: 'ratingTagsEnabled', attr: 'data-je-rating-tagged' },
] as const;

// A full LibraryViewSettings object (jellyfin-web
// apps/modern/features/libraries/utils/settings.ts) with ViewMode:'list'.
// Written whole because the modern useLocalStorage hook stores the value as-is
// (no merge with defaults).
const LIST_VIEW_SETTINGS = {
    ShowTitle: true,
    ShowYear: true,
    ViewMode: 'list',
    ImageType: 'Primary',
    CardLayout: false,
    SortBy: 'SortName',
    SortOrder: 'Ascending',
    StartIndex: 0,
};

test.describe('list-view tags', () => {
    test('List view row thumbnails carry no tag overlays; grid cards still do', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);

        const enabled: string[] = await page.evaluate((families) => {
            const settings = (window as any).JellyfinElevate?.currentSettings || {};
            return families.filter((f) => settings[f.setting] === true).map((f) => f.attr);
        }, FAMILIES.map((f) => ({ setting: f.setting, attr: f.attr })));
        test.skip(enabled.length === 0, 'no tag renderer enabled for this user');

        // Pick a movies library (rich tag data in the seed: genres, community
        // rating, English audio, SD resolution — all four families apply).
        const libraryId: string | null = await page.evaluate(async () => {
            const apiClient = (window as any).ApiClient;
            const url = apiClient.getUrl(`/UserViews?userId=${apiClient.getCurrentUserId()}`);
            const views = await apiClient.ajax({ type: 'GET', url, dataType: 'json' });
            const movies = (views.Items || []).find((v: any) => v.CollectionType === 'movies');
            return (movies || (views.Items || [])[0])?.Id || null;
        });
        test.skip(!libraryId, 'no library available');

        const viewKey = `movies - ${libraryId}`;

        // ── Positive control: GRID view (default) tags the cards ────────────
        await showRoute(page, `/movies?topParentId=${libraryId}`);
        await waitForHash(page, libraryId!);
        // state:'attached' — the library ships a hidden `.cardImageContainer`
        // template that never becomes visible, so the default visibility wait
        // would hang on it; we only need the real cards present in the DOM.
        await page.waitForSelector('.cardImageContainer', { state: 'attached', timeout: 60_000 });
        // Snapshot the pre-existing view setting so we can restore it later.
        const originalSetting = await page.evaluate((k) => localStorage.getItem(k), viewKey);

        await page.waitForFunction(
            (attrs) => attrs.some((a) => document.querySelectorAll(`.card[${a}]`).length > 0),
            enabled,
            { timeout: 60_000 }
        );
        const gridTagged = await page.evaluate(
            (attrs) => attrs.reduce((n, a) => n + document.querySelectorAll(`.card[${a}]`).length, 0),
            enabled
        );
        expect(gridTagged, 'grid CARD view must still get tags (regression guard)').toBeGreaterThan(0);

        // ── Switch the same library to LIST view and remount it ─────────────
        // From here we've mutated the library's view-mode setting, so the restore
        // must run even if an assertion throws — otherwise a failure leaves the
        // library pinned to list view for the next run.
        try {
            await page.evaluate(({ k, v }) => localStorage.setItem(k, JSON.stringify(v)),
                { k: viewKey, v: LIST_VIEW_SETTINGS });
            // Navigate away and back so LibraryPage remounts and re-reads the setting.
            await showRoute(page, '/home');
            await waitForHash(page, '/home');
            await showRoute(page, `/movies?topParentId=${libraryId}`);
            await waitForHash(page, libraryId!);
            await page.waitForSelector('.listItem[data-id]', { state: 'attached', timeout: 60_000 });

            // Let the pipeline settle: the sync pass runs inside the mutation batch
            // and the idle scan within ~100ms, so any tagging it were going to do has
            // happened well before this. (The grid control above proved it is active.)
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(1500);

            const listState = await page.evaluate((attrs) => {
                const rows = [...document.querySelectorAll('.listItem[data-id]')];
                let overlays = 0, hosts = 0, marked = 0;
                for (const row of rows) {
                    overlays += row.querySelectorAll('[class*="-overlay-container"]').length;
                    hosts += row.querySelectorAll('.je-tag-host').length;
                    for (const a of attrs) {
                        if (row.matches(`[${a}]`) || row.querySelector(`[${a}]`)) { marked++; break; }
                    }
                }
                return { rows: rows.length, overlays, hosts, marked };
            }, enabled);

            expect(listState.rows, 'library should be showing list rows').toBeGreaterThan(0);
            // The real regression guard: the bug rendered card-sized overlay
            // containers into the tiny row thumbnail. The fix produces zero.
            expect(listState.overlays, 'list rows must carry NO JE tag overlay containers').toBe(0);
            // Invariant sanity checks (never landed on a list row even with the bug —
            // see header): guard against a future renderer breaking that invariant.
            expect(listState.hosts, 'list rows must carry NO je-tag-host (invariant)').toBe(0);
            expect(listState.marked, 'no list row may be stamped as tag-rendered (invariant)').toBe(0);
        } finally {
            // ── Restore the library's original view mode ────────────────────
            await page.evaluate(({ k, original }) => {
                if (original === null) localStorage.removeItem(k);
                else localStorage.setItem(k, original);
            }, { k: viewKey, original: originalSetting });
        }

        expect(consoleErrors.real()).toEqual([]);
    });
});
