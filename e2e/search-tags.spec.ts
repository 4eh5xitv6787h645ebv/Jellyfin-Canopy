// DisableTagsOnSearchPage must hide EVERY tag family on #searchPage, not just
// genre. MISC-1: the search-page exclusion was wired only into the genre
// renderer's searchPageIgnoreSelector, so quality / language / rating tags kept
// rendering on the search results even with the setting on. This spec sets the
// admin flag, reloads (the renderers memoize their ignore-selector list, so a
// live flip would not take effect), and proves NO family tags a search card —
// while the same pipeline still tags Home cards (so a zero on search means
// "correctly ignored", not "pipeline dead").
import { test, expect, loginAs, assertNoRuntimeErrors, USERS } from './fixtures/auth';
import { api, authenticate, PLUGIN_ID } from './fixtures/api';

/* eslint-disable @typescript-eslint/no-explicit-any */

const FAMILIES = [
    { setting: 'qualityTagsEnabled', attr: 'data-je-quality-tagged' },
    { setting: 'genreTagsEnabled', attr: 'data-je-genre-tagged' },
    { setting: 'languageTagsEnabled', attr: 'data-je-language-tagged' },
    { setting: 'ratingTagsEnabled', attr: 'data-je-rating-tagged' },
] as const;

const CONFIG_PATH = `/Plugins/${PLUGIN_ID}/Configuration`;

test.describe('search-page tag hiding', () => {
    test('DisableTagsOnSearchPage hides every enabled family on #searchPage', async ({ page, consoleErrors, baseURL }) => {
        await loginAs(page, 'admin', consoleErrors);

        // The families enabled for this user; those are the ones that must be
        // hidden on search. Nothing to hide → nothing to guard.
        const enabled: string[] = await page.evaluate((families) => {
            const settings = (window as any).JellyfinElevate?.currentSettings || {};
            return families.filter((f) => settings[f.setting] === true).map((f) => f.attr);
        }, FAMILIES.map((f) => ({ setting: f.setting, attr: f.attr })));
        test.skip(enabled.length === 0, 'no tag renderer enabled for this user');

        // A search term guaranteed to return library cards: the first word of an
        // actual movie title.
        const queryTerm: string | null = await page.evaluate(async () => {
            const apiClient = (window as any).ApiClient;
            const res = await apiClient.getItems(apiClient.getCurrentUserId(), {
                IncludeItemTypes: 'Movie', Recursive: true, Limit: 1, SortBy: 'SortName',
            });
            const name: string | undefined = res?.Items?.[0]?.Name;
            return name ? name.split(/\s+/)[0] : null;
        });
        test.skip(!queryTerm, 'no movie available to search for');

        const admin = await authenticate(baseURL!, USERS.admin.username, USERS.admin.password);
        const config = await api<Record<string, unknown>>(baseURL!, CONFIG_PATH, admin.token);
        expect(config, 'plugin configuration must be readable').toBeTruthy();

        try {
            // Turn the flag ON server-side, then reload so the renderers rebuild
            // their (memoized) ignore-selector list with the flag applied.
            await api(baseURL!, CONFIG_PATH, admin.token, {
                method: 'POST',
                body: JSON.stringify({ ...config, DisableTagsOnSearchPage: true }),
            });
            await page.reload({ waitUntil: 'domcontentloaded' });
            consoleErrors.reset();
            await page.waitForFunction(
                () => (window as any).JellyfinElevate?.initialized === true
                    && (window as any).JellyfinElevate?.pluginConfig?.DisableTagsOnSearchPage === true,
                undefined,
                { timeout: 60_000 }
            );

            // Control: the pipeline still tags Home cards (proves it is alive so a
            // zero on the search page is a deliberate ignore, not a dead pipeline).
            await page.waitForSelector('#indexPage .card', { timeout: 60_000 });
            await page.waitForFunction(
                (attrs) => attrs.some((attr) => document.querySelectorAll(`#indexPage [${attr}]`).length > 0),
                enabled,
                { timeout: 60_000 }
            );

            // Navigate to the search results for the term.
            await page.evaluate((term) => { window.location.hash = `#/search?query=${encodeURIComponent(term)}`; }, queryTerm!);
            await page.waitForSelector('#searchPage', { state: 'visible', timeout: 30_000 });
            await page.waitForSelector('#searchPage .cardImageContainer, #searchPage .card', { timeout: 30_000 });
            await page.waitForLoadState('networkidle');

            // Give the pipeline a bounded window to (wrongly) tag a search card.
            // This returns the instant the bug manifests and only waits out the
            // window when the fix is correct — so it is not a blind sleep.
            const tagAppeared = await page.waitForFunction(
                (attrs) => attrs.some((attr) => document.querySelectorAll(`#searchPage [${attr}]`).length > 0),
                enabled,
                { timeout: 8_000 }
            ).then(() => true, () => false);

            expect(
                tagAppeared,
                'no enabled tag family may render on #searchPage when DisableTagsOnSearchPage is on'
            ).toBe(false);

            assertNoRuntimeErrors(consoleErrors);
        } finally {
            // Restore the exact original configuration.
            await api(baseURL!, CONFIG_PATH, admin.token, {
                method: 'POST',
                body: JSON.stringify(config),
            });
        }
    });
});
