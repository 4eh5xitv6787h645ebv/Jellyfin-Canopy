// Seerr search/discovery results must respect each Jellyfin user's own
// parental-rating limit, server-side. A restricted account must not even be
// sent titles above its limit (a client-only hide would still deliver them and
// be trivially bypassed via devtools). Administrators and users with no limit
// see everything unchanged.
//
// This drives the REAL proxy endpoint through the browser's authenticated
// ApiClient (which carries the per-user token the proxy resolves the policy
// from) as both a restricted non-admin and a bypassed admin, and asserts the
// server filtered the JSON — not the DOM.
import { test, expect, loginAs, USERS } from './fixtures/auth';
import { seerrReady, tmdbReady } from './fixtures/seerr';

/* eslint-disable @typescript-eslint/no-explicit-any */

// Stable TMDB ids for the "Deadpool" query (verified against seerr-dev).
const DEADPOOL_R = 293660;        // Deadpool (2016) — US "R" (score 17)
const DEADPOOL2_R = 383498;       // Deadpool 2 — US "R" (score 17)
const DEADPOOL_PERSON = 4790510;  // a person result — never rating-gated
const QUERY = 'Deadpool';

/** Search the JC Seerr proxy in the current user's authenticated context. */
async function searchIds(page: any): Promise<{ movies: number[]; all: number[] }> {
    return page.evaluate(async (query: string) => {
        const api = (window as any).ApiClient;
        const url = api.getUrl(`/JellyfinCanopy/jellyseerr/search?query=${encodeURIComponent(query)}&page=1&language=en`);
        const res = await api.getJSON(url);
        const results = (res.results || []) as any[];
        return {
            movies: results.filter((r) => r.mediaType === 'movie').map((r) => r.id),
            all: results.map((r) => r.id),
        };
    }, QUERY);
}

/** GET a proxy path in the current user's context, returning the HTTP status. */
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

/** POST a Seerr request in the current user's context, returning the HTTP status. */
async function postRequestStatus(page: any, mediaType: string, tmdbId: number): Promise<number> {
    return page.evaluate(async (args: { mediaType: string; tmdbId: number }) => {
        const api = (window as any).ApiClient;
        try {
            await api.ajax({
                type: 'POST',
                url: api.getUrl('/JellyfinCanopy/jellyseerr/request'),
                data: JSON.stringify({ mediaType: args.mediaType, mediaId: args.tmdbId }),
                contentType: 'application/json',
                dataType: 'json',
            });
            return 200;
        } catch (e: any) {
            return e?.status || 0;
        }
    }, { mediaType, tmdbId });
}

/** Find jc_arruser's id (non-admin) via the admin session. */
async function findRestrictedUserId(page: any, username: string): Promise<string> {
    return page.evaluate(async (name: string) => {
        const api = (window as any).ApiClient;
        const users = await api.getJSON(api.getUrl('/Users'));
        const match = (users || []).find((u: any) => u.Name === name);
        if (!match) throw new Error(`user ${name} not found`);
        return match.Id as string;
    }, username);
}

/** Set (or clear, with null) the user's max parental rating via the policy API. */
async function setMaxParentalRating(page: any, userId: string, score: number | null): Promise<void> {
    await page.evaluate(async (args: { userId: string; score: number | null }) => {
        const api = (window as any).ApiClient;
        const user = await api.getJSON(api.getUrl(`/Users/${args.userId}`));
        const policy = user.Policy;
        policy.MaxParentalRating = args.score;
        await api.ajax({
            type: 'POST',
            url: api.getUrl(`/Users/${args.userId}/Policy`),
            data: JSON.stringify(policy),
            contentType: 'application/json',
        });
    }, { userId, score });
}

test.describe('seerr parental-rating filter', () => {
    test('restricted user is filtered server-side; admin and no-limit are not', async ({ page, consoleErrors }) => {
        // ── Admin: discover the restricted user and impose a PG-13 (13) limit ──
        await loginAs(page, 'admin', consoleErrors);
        // The reproducible docker seed is bare: without a live Jellyseerr + TMDB
        // backend the search returns nothing and this security guard can't run.
        // Skip cleanly rather than fail on an unmet precondition (set
        // JELLYSEERR_* / TMDB_API_KEY at seed time to run).
        test.skip(
            !(await seerrReady(page)) || !(await tmdbReady(page)),
            'Seerr/TMDB not configured — set JELLYSEERR_* and TMDB_API_KEY at seed time to run'
        );
        const restrictedUserId = await findRestrictedUserId(page, USERS.user.username);

        try {
            await setMaxParentalRating(page, restrictedUserId, 13);

            // Admin bypasses parental controls -> full result set (baseline).
            const admin = await searchIds(page);
            expect(admin.movies, 'admin baseline should include the R-rated Deadpool').toContain(DEADPOOL_R);
            expect(admin.movies).toContain(DEADPOOL2_R);

            // Admin can also open any title's detail (no gate) — via both the Seerr
            // detail endpoint and the raw TMDB passthrough.
            expect(await getStatus(page, `/JellyfinCanopy/jellyseerr/movie/${DEADPOOL_R}`),
                'admin detail fetch is not gated').toBe(200);
            expect(await getStatus(page, `/JellyfinCanopy/tmdb/movie/${DEADPOOL_R}`),
                'admin raw TMDB fetch is not gated').toBe(200);

            // ── Restricted user: R titles removed, subset of admin, person kept ──
            await loginAs(page, 'user', consoleErrors);
            const user = await searchIds(page);

            // The core requirement: R-rated titles a PG-13 user can't watch are gone.
            expect(user.movies, 'restricted user must not see R-rated Deadpool').not.toContain(DEADPOOL_R);
            expect(user.movies, 'restricted user must not see R-rated Deadpool 2').not.toContain(DEADPOOL2_R);

            // Filtering actually happened and never invents ids.
            expect(user.all.length).toBeLessThan(admin.all.length);
            for (const id of user.all) {
                expect(admin.all, 'restricted results must be a subset of the admin results').toContain(id);
            }

            // Non movie/tv results (people) are never rating-gated.
            expect(user.all, 'person results are never filtered').toContain(DEADPOOL_PERSON);

            // The same restriction gates the detail endpoint and the request POST, so a
            // restricted user can neither open nor request a blocked title by tmdbId.
            expect(await getStatus(page, `/JellyfinCanopy/jellyseerr/movie/${DEADPOOL_R}`),
                'restricted user is blocked from a blocked title detail').toBe(403);
            expect(await getStatus(page, `/JellyfinCanopy/tmdb/movie/${DEADPOOL_R}`),
                'restricted user is blocked from the raw TMDB detail too').toBe(403);
            expect(await postRequestStatus(page, 'movie', DEADPOOL_R),
                'restricted user cannot request a blocked title').toBe(403);

            // ── No-limit path: clear the limit, user sees everything again ──
            await loginAs(page, 'admin', consoleErrors);
            await setMaxParentalRating(page, restrictedUserId, null);

            await loginAs(page, 'user', consoleErrors);
            const userAfter = await searchIds(page);
            expect(userAfter.movies, 'with no limit the user sees the R titles again').toContain(DEADPOOL_R);

            expect(consoleErrors.real(), 'no unexpected console errors').toEqual([]);
        } finally {
            // Always clear the imposed limit so the shared dev user is left clean.
            await loginAs(page, 'admin');
            await setMaxParentalRating(page, restrictedUserId, null);
        }
    });
});
