// Jellyfin TAG-based parental controls (Block items with tags) must apply to
// Seerr surfaces server-side: a user whose policy blocks "zombie" must not be
// sent zombie-keyword titles in search results, must get a bare 403 on their
// detail pages, and must not be able to request them. Genre names count too
// (the documented intent extension): blocking "horror" hides Horror-genre
// titles even when their community keywords are sparse.
//
// Mirrors seerr-parental.spec.ts: drives the REAL proxy through the browser's
// authenticated ApiClient as both the restricted non-admin and an admin, and
// asserts the server filtered the JSON — not the DOM. All policy changes are
// restored in finally blocks.
import { test, expect, loginAs } from './fixtures/auth';
import { seerrReady, findRestrictedUserId, setParentalTags } from './fixtures/seerr';
import { USERS } from './fixtures/auth';

/* eslint-disable @typescript-eslint/no-explicit-any */

// Night of the Living Dead (1968) — stable TMDB id whose keywords include
// "zombie" and whose genre is Horror (verified against seerr-dev). The query
// also returns several parody/remake titles WITHOUT the zombie keyword, which
// must survive a "zombie" block (keyword precision) but not a "horror" block
// (genre coverage).
const NOTLD_1968 = 10331;
const QUERY = 'night of the living dead';

async function searchMovieIds(page: any): Promise<number[]> {
    return page.evaluate(async (query: string) => {
        const api = (window as any).ApiClient;
        const url = api.getUrl(`/JellyfinCanopy/jellyseerr/search?query=${encodeURIComponent(query)}&page=1&language=en`);
        const res = await api.getJSON(url);
        return ((res.results || []) as any[]).filter((r) => r.mediaType === 'movie').map((r) => r.id);
    }, QUERY);
}

async function getStatus(page: any, path: string): Promise<number> {
    return page.evaluate(async (p: string) => {
        const api = (window as any).ApiClient;
        try {
            await api.ajax({ type: 'GET', url: api.getUrl(p), dataType: 'json' });
            return 200;
        } catch (e: any) {
            return e?.status || 0;
        }
    }, path);
}

async function postRequestStatus(page: any, tmdbId: number): Promise<number> {
    return page.evaluate(async (id: number) => {
        const api = (window as any).ApiClient;
        try {
            await api.ajax({
                type: 'POST',
                url: api.getUrl('/JellyfinCanopy/jellyseerr/request'),
                data: JSON.stringify({ mediaType: 'movie', mediaId: id }),
                contentType: 'application/json',
                dataType: 'json',
            });
            return 200;
        } catch (e: any) {
            return e?.status || 0;
        }
    }, tmdbId);
}

test.describe('Seerr parental tag blocking', () => {
    test('blocked keyword tag gates search, detail, and request for the restricted user only', async ({ browser }) => {
        const adminCtx = await browser.newContext();
        const adminPage = await adminCtx.newPage();
        await loginAs(adminPage, 'admin');
        test.skip(!(await seerrReady(adminPage)), 'Seerr not configured on this server');

        const userId = await findRestrictedUserId(adminPage, USERS.user.username);
        await setParentalTags(adminPage, userId, ['zombie']);
        try {
            const userCtx = await browser.newContext();
            const userPage = await userCtx.newPage();
            await loginAs(userPage, 'user');

            // Search: the zombie-keyword original is dropped; sparse-keyword
            // remakes/parodies survive (keyword precision, not title match).
            const ids = await searchMovieIds(userPage);
            expect(ids, 'zombie-keyword title must be filtered from search').not.toContain(NOTLD_1968);
            expect(ids.length, 'non-matching titles must survive a keyword block').toBeGreaterThan(0);

            // Detail: bare 403 for the blocked title.
            expect(await getStatus(userPage, `/JellyfinCanopy/jellyseerr/movie/${NOTLD_1968}`)).toBe(403);

            // Request creation: blocked pre-proxy.
            expect(await postRequestStatus(userPage, NOTLD_1968)).toBe(403);

            // The admin's own view stays unfiltered (bypass, matching core).
            expect(await getStatus(adminPage, `/JellyfinCanopy/jellyseerr/movie/${NOTLD_1968}`)).toBe(200);

            await userCtx.close();
        } finally {
            await setParentalTags(adminPage, userId, []);
            await adminCtx.close();
        }
    });

    test('blocked genre tag hides whole-genre titles the keyword block would miss', async ({ browser }) => {
        const adminCtx = await browser.newContext();
        const adminPage = await adminCtx.newPage();
        await loginAs(adminPage, 'admin');
        test.skip(!(await seerrReady(adminPage)), 'Seerr not configured on this server');

        const userId = await findRestrictedUserId(adminPage, USERS.user.username);

        // Baseline (no tags): capture how many titles the query returns.
        await setParentalTags(adminPage, userId, []);
        const userCtx = await browser.newContext();
        const userPage = await userCtx.newPage();
        await loginAs(userPage, 'user');
        const baseline = await searchMovieIds(userPage);
        test.skip(baseline.length < 3, 'query returned too few titles to prove genre narrowing');

        await setParentalTags(adminPage, userId, ['horror']);
        try {
            const blocked = await searchMovieIds(userPage);
            expect(blocked.length, 'genre block must remove Horror-genre titles').toBeLessThan(baseline.length);
            expect(blocked, 'the Horror-genre original must be gone').not.toContain(NOTLD_1968);
        } finally {
            await setParentalTags(adminPage, userId, []);
            await userCtx.close();
            await adminCtx.close();
        }
    });
});
