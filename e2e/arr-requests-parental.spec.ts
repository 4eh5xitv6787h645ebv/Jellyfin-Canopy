// The Requests page (GET /JellyfinEnhanced/arr/requests, backing
// JE.downloadsPage) must apply each caller's OWN Jellyfin parental-rating
// limit server-side — exactly the gap SEERR-1 found: the controller returned
// every row regardless of the caller's MaxParentalRating. A restricted user
// must never be sent (nor rendered) a request whose title is above their
// limit; an admin (who bypasses parental controls) still sees it.
//
// A client-only hide would still deliver the row and be trivially bypassed via
// devtools, so the load-bearing assertions read the endpoint JSON the browser's
// authenticated ApiClient receives (carrying each user's own token), and the
// rendered Requests page is opened as a second, DOM-level check.
//
// Isolation: the non-admin only sees THEIR OWN requests (no Seerr view-all
// permission), so the above-limit and allowed requests are created AS that
// user (with the limit cleared) — they are then genuinely in the user's own
// view, and only the imposed limit can remove them. The core catch is the
// round-trip: with the limit the above-limit row is gone; clearing it brings
// the row back; the admin sees it throughout.
import { test, expect, loginAs, assertNoRuntimeErrors, USERS } from './fixtures/auth';
import { seerrReady, tmdbReady, findRestrictedUserId, setMaxParentalRating } from './fixtures/seerr';

/* eslint-disable @typescript-eslint/no-explicit-any */

// Stable TMDB movie ids (verified against seerr-dev).
const ABOVE_LIMIT_TMDB = 293660;   // Deadpool (2016) — US "R" (score 17) > 13
const ABOVE_LIMIT_TITLE = /deadpool/i;
const ALLOWED_TMDB = 862;          // Toy Story (1995) — US "G" (low score) <= 13
const ALLOWED_TITLE = /toy story/i;
const PG13_SCORE = 13;

/** POST a Seerr request in the current user's context; best-effort (an existing
 *  request answers non-2xx, which is fine — the row is what we need). */
async function ensureRequest(page: any, mediaType: string, tmdbId: number): Promise<void> {
    await page.evaluate(async (args: { mediaType: string; tmdbId: number }) => {
        const api = (window as any).ApiClient;
        try {
            await api.ajax({
                type: 'POST',
                url: api.getUrl('/JellyfinEnhanced/jellyseerr/request'),
                data: JSON.stringify({ mediaType: args.mediaType, mediaId: args.tmdbId }),
                contentType: 'application/json',
                dataType: 'json',
            });
        } catch {
            // already-exists / already-available — the request row still exists.
        }
    }, { mediaType, tmdbId });
}

/** GET /arr/requests in the current user's context → the row tmdbIds. */
async function requestTmdbIds(page: any): Promise<number[]> {
    return page.evaluate(async () => {
        const api = (window as any).ApiClient;
        const res = await api.getJSON(api.getUrl('/JellyfinEnhanced/arr/requests?take=200'));
        return ((res?.requests || []) as any[])
            .map((r) => Number(r.tmdbId))
            .filter((n) => Number.isFinite(n));
    });
}

/** Open the ACTUAL Requests page and read the rendered request-card titles. */
async function renderedRequestTitles(page: any): Promise<string[]> {
    await page.evaluate(() => {
        (window as any).JellyfinEnhanced.downloadsPage.showPage();
    });
    // Wait for the page container, then for the requests section to SETTLE:
    // either it rendered cards or an empty/error state (loadAllData resolved) —
    // never assert while it still shows the `.je-loading` placeholder.
    await page.waitForSelector('#je-downloads-page:not(.hide)', { timeout: 30_000 });
    await page.waitForFunction(() => {
        const section = document.querySelector('.je-requests-section');
        if (!section) return false;
        if (section.querySelector('.je-loading')) return false;
        return !!section.querySelector('.je-request-card, .je-empty-state');
    }, undefined, { timeout: 30_000 });
    return page.evaluate(() =>
        [...document.querySelectorAll('.je-requests-section .je-request-card .je-request-title')]
            .map((el) => (el.textContent || '').trim())
    );
}

/** As ADMIN: find the request rows for these tmdbIds and decline them (cleanup). */
async function declineRequestsFor(page: any, tmdbIds: number[]): Promise<void> {
    await page.evaluate(async (ids: number[]) => {
        const api = (window as any).ApiClient;
        try {
            const res = await api.getJSON(api.getUrl('/JellyfinEnhanced/arr/requests?take=200'));
            for (const row of (res?.requests || []) as any[]) {
                if (ids.includes(Number(row.tmdbId)) && row.id != null) {
                    try {
                        await api.ajax({
                            type: 'POST',
                            url: api.getUrl(`/JellyfinEnhanced/arr/requests/${row.id}/decline`),
                            dataType: 'json',
                        });
                    } catch { /* best effort */ }
                }
            }
        } catch { /* best effort */ }
    }, tmdbIds);
}

test.describe('requests page parental filter', () => {
    test('the requests list and page respect the caller parental limit', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);
        // The reproducible docker seed is bare (no TMDB/Seerr). Skip cleanly
        // rather than fail an unmeetable precondition (set JELLYSEERR_* /
        // TMDB_API_KEY at seed time to run this security guard).
        test.skip(
            !(await seerrReady(page)) || !(await tmdbReady(page)),
            'Seerr/TMDB not configured — set JELLYSEERR_* and TMDB_API_KEY at seed time to run'
        );
        const restrictedUserId = await findRestrictedUserId(page, USERS.user.username);

        try {
            // ── Seed both requests as the non-admin with NO limit, so they are
            //    genuinely in that user's own view (only the limit can remove them).
            await setMaxParentalRating(page, restrictedUserId, null);
            await loginAs(page, 'user', consoleErrors);
            await ensureRequest(page, 'movie', ABOVE_LIMIT_TMDB);
            await ensureRequest(page, 'movie', ALLOWED_TMDB);

            const unlimited = await requestTmdbIds(page);
            // If the non-admin Seerr account can't be seeded with both requests
            // (not linked / titles unavailable in this env), there is nothing to
            // gate — skip rather than assert a false negative.
            test.skip(
                !unlimited.includes(ABOVE_LIMIT_TMDB) || !unlimited.includes(ALLOWED_TMDB),
                'could not seed both an above-limit and an allowed request for the non-admin'
            );

            // ── Impose PG-13 on the non-admin.
            await loginAs(page, 'admin', consoleErrors);
            await setMaxParentalRating(page, restrictedUserId, PG13_SCORE);

            // Admin bypasses parental controls: the above-limit row is present.
            const adminRows = await requestTmdbIds(page);
            expect(adminRows, 'admin sees the above-limit request (bypasses parental controls)')
                .toContain(ABOVE_LIMIT_TMDB);

            // ── Restricted user: above-limit gone, allowed kept — endpoint JSON …
            await loginAs(page, 'user', consoleErrors);
            const limited = await requestTmdbIds(page);
            expect(limited, 'restricted user must not be sent the above-limit request')
                .not.toContain(ABOVE_LIMIT_TMDB);
            expect(limited, 'restricted user still sees the allowed request')
                .toContain(ALLOWED_TMDB);
            // Filtering never invents rows: the limited set is a subset of the
            // same user's no-limit set.
            for (const id of limited) {
                expect(unlimited, 'limited rows are a subset of the no-limit rows').toContain(id);
            }

            // … and the ACTUAL rendered Requests page (recent-first ordering puts
            //    both freshly-created requests on the first page).
            const titles = await renderedRequestTitles(page);
            expect(
                titles.some((t) => ALLOWED_TITLE.test(t)),
                'the allowed title is rendered on the Requests page'
            ).toBe(true);
            expect(
                titles.some((t) => ABOVE_LIMIT_TITLE.test(t)),
                'the above-limit title is NOT rendered on the Requests page'
            ).toBe(false);

            // ── Round-trip: clearing the limit brings the above-limit row back
            //    (proves the endpoint applied the CALLER's live limit, not a cache).
            await loginAs(page, 'admin', consoleErrors);
            await setMaxParentalRating(page, restrictedUserId, null);
            await loginAs(page, 'user', consoleErrors);
            const restored = await requestTmdbIds(page);
            expect(restored, 'with no limit the above-limit request returns')
                .toContain(ABOVE_LIMIT_TMDB);

            assertNoRuntimeErrors(consoleErrors);
        } finally {
            // Leave the shared dev account clean: clear the limit and best-effort
            // decline the requests this spec created.
            await loginAs(page, 'admin');
            await setMaxParentalRating(page, restrictedUserId, null);
            await declineRequestsFor(page, [ABOVE_LIMIT_TMDB, ALLOWED_TMDB]);
        }
    });
});
