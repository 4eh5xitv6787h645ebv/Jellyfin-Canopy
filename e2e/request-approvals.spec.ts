// In-App Request Approvals (milestone "In-App Request Approvals"):
// Jellyfin admins (and Seerr users with Manage Requests) can approve/decline
// pending Seerr requests from inside the Requests page. The server enforces the
// permission on every action; the client only renders the buttons for callers
// the server says can act (canApproveRequests) and gates them on the admin
// RequestApprovalsEnabled toggle.
//
// This spec proves both halves against the real endpoint:
//   - ADMIN: the endpoint reports canApproveRequests=true, the Approve/Decline
//     affordance renders on the pending request card, and the approve/decline
//     endpoint round-trips (a real decline moves the request out of the pending
//     set — which also cleans up the request this spec created).
//   - NON-ADMIN: no approve/decline UI renders on their own pending request, and
//     a direct POST to the approve endpoint is refused with 403 (bare contract).
import { test, expect, loginAs, assertNoRuntimeErrors } from './fixtures/auth';
import { seerrReady, tmdbReady } from './fixtures/seerr';

/* eslint-disable @typescript-eslint/no-explicit-any */

// Stable TMDB movie ids (verified against seerr-dev). Distinct per test so the
// two tests never fight over the same Seerr request row.
const ADMIN_TMDB = 603;        // The Matrix (1999)
const NONADMIN_TMDB = 604;     // The Matrix Reloaded (2003)

/** POST a Seerr request in the current user's context; best-effort (an existing
 *  request answers non-2xx, which is fine — the row is what we need). */
async function ensureRequest(page: any, tmdbId: number): Promise<void> {
    await page.evaluate(async (id: number) => {
        const api = (window as any).ApiClient;
        try {
            await api.ajax({
                type: 'POST',
                url: api.getUrl('/JellyfinElevate/jellyseerr/request'),
                data: JSON.stringify({ mediaType: 'movie', mediaId: id }),
                contentType: 'application/json',
                dataType: 'json',
            });
        } catch {
            // already-exists / already-available — the request row still exists.
        }
    }, tmdbId);
}

/** GET /arr/requests in the current user's context → { canApproveRequests, rows }. */
async function fetchRequests(page: any): Promise<{ canApproveRequests: boolean; rows: any[] }> {
    return page.evaluate(async () => {
        const api = (window as any).ApiClient;
        const res = await api.getJSON(api.getUrl('/JellyfinElevate/arr/requests?take=200'));
        return { canApproveRequests: res?.canApproveRequests === true, rows: (res?.requests || []) as any[] };
    });
}

/** The pending (requestStatus === 1) row id for a tmdbId, or null. */
function pendingRowId(rows: any[], tmdbId: number): number | null {
    const row = rows.find((r) => Number(r.tmdbId) === tmdbId && Number(r.requestStatus) === 1);
    return row && row.id != null ? Number(row.id) : null;
}

/** Open the actual Requests page and wait for the requests section to settle. */
async function openRequestsPage(page: any): Promise<void> {
    await page.evaluate(() => {
        (window as any).JellyfinElevate.downloadsPage.showPage();
    });
    await page.waitForSelector('#je-downloads-page:not(.hide)', { timeout: 30_000 });
    await page.waitForFunction(() => {
        const section = document.querySelector('.je-requests-section');
        if (!section) return false;
        if (section.querySelector('.je-loading')) return false;
        return !!section.querySelector('.je-request-card, .je-empty-state');
    }, undefined, { timeout: 30_000 });
}

/** As admin: best-effort decline any pending row for these tmdbIds (cleanup). */
async function declinePendingFor(page: any, tmdbIds: number[]): Promise<void> {
    await page.evaluate(async (ids: number[]) => {
        const api = (window as any).ApiClient;
        try {
            const res = await api.getJSON(api.getUrl('/JellyfinElevate/arr/requests?take=200'));
            for (const row of (res?.requests || []) as any[]) {
                if (ids.includes(Number(row.tmdbId)) && Number(row.requestStatus) === 1 && row.id != null) {
                    try {
                        await api.ajax({
                            type: 'POST',
                            url: api.getUrl(`/JellyfinElevate/arr/requests/${row.id}/decline`),
                            dataType: 'json',
                        });
                    } catch { /* best effort */ }
                }
            }
        } catch { /* best effort */ }
    }, tmdbIds);
}

test.describe('in-app request approvals', () => {
    test('admin: affordance renders and the approve/decline endpoint round-trips', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);
        test.skip(
            !(await seerrReady(page)) || !(await tmdbReady(page)),
            'Seerr/TMDB not configured — set JELLYSEERR_* and TMDB_API_KEY at seed time to run'
        );

        try {
            // Seed a PENDING request as the non-admin (non-auto-approve) user so it
            // stays pending; the admin sees everyone's requests.
            await loginAs(page, 'user', consoleErrors);
            await ensureRequest(page, ADMIN_TMDB);

            await loginAs(page, 'admin', consoleErrors);
            const before = await fetchRequests(page);
            const rowId = pendingRowId(before.rows, ADMIN_TMDB);
            test.skip(rowId == null, 'could not seed a pending request for the admin round-trip');

            // The admin gate resolves true and the affordance renders.
            expect(before.canApproveRequests, 'admin endpoint reports canApproveRequests').toBe(true);
            await openRequestsPage(page);
            const buttons = await page.evaluate(() => ({
                approve: document.querySelectorAll('.je-requests-section .je-request-approve-btn').length,
                decline: document.querySelectorAll('.je-requests-section .je-request-decline-btn').length,
            }));
            expect(buttons.approve, 'approve buttons render for admin on pending requests').toBeGreaterThan(0);
            expect(buttons.decline, 'decline buttons render for admin on pending requests').toBeGreaterThan(0);

            // Round-trip: decline the seeded request through the JE endpoint and
            // confirm it leaves the pending set (also the cleanup for this row).
            const declineStatus = await page.evaluate(async (id: number) => {
                const api = (window as any).ApiClient;
                const res = await api.ajax({
                    type: 'POST',
                    url: api.getUrl(`/JellyfinElevate/arr/requests/${id}/decline`),
                    dataType: 'json',
                });
                return res?.success === true;
            }, rowId);
            expect(declineStatus, 'decline endpoint returns success').toBe(true);

            const after = await fetchRequests(page);
            expect(pendingRowId(after.rows, ADMIN_TMDB), 'declined request is no longer pending').toBeNull();

            assertNoRuntimeErrors(consoleErrors);
        } finally {
            await loginAs(page, 'admin');
            await declinePendingFor(page, [ADMIN_TMDB]);
        }
    });

    test('non-admin: no approve/decline UI and the endpoint returns 403', async ({ page, consoleErrors }) => {
        await loginAs(page, 'user', consoleErrors);
        test.skip(
            !(await seerrReady(page)) || !(await tmdbReady(page)),
            'Seerr/TMDB not configured — set JELLYSEERR_* and TMDB_API_KEY at seed time to run'
        );

        try {
            // A pending request in the non-admin's OWN view — so if approval UI
            // leaked it would render here.
            await ensureRequest(page, NONADMIN_TMDB);
            const mine = await fetchRequests(page);
            expect(mine.canApproveRequests, 'non-admin endpoint reports canApproveRequests=false').toBe(false);
            const rowId = pendingRowId(mine.rows, NONADMIN_TMDB);
            test.skip(rowId == null, 'could not seed a pending request in the non-admin view');

            await openRequestsPage(page);
            const counts = await page.evaluate(() => ({
                cards: document.querySelectorAll('.je-requests-section .je-request-card').length,
                approve: document.querySelectorAll('.je-requests-section .je-request-approve-btn').length,
                decline: document.querySelectorAll('.je-requests-section .je-request-decline-btn').length,
            }));
            expect(counts.cards, 'the non-admin still sees their request cards').toBeGreaterThan(0);
            expect(counts.approve, 'no approve buttons render for the non-admin').toBe(0);
            expect(counts.decline, 'no decline buttons render for the non-admin').toBe(0);

            // The server still enforces: a direct POST is refused with 403.
            const status = await page.evaluate(async (id: number) => {
                const api = (window as any).ApiClient;
                const res = await fetch(api.getUrl(`/JellyfinElevate/arr/requests/${id}/approve`), {
                    method: 'POST',
                    headers: {
                        Authorization: `MediaBrowser Token="${api.accessToken()}", Client="cc", Device="cc", DeviceId="cc", Version="1"`,
                    },
                });
                return res.status;
            }, rowId);
            expect(status, 'non-admin approve is refused with 403').toBe(403);

            // Only console errors are asserted here: the intentional 403 above is a
            // deliberate authz-refusal, not a broken endpoint, so unexpected4xx()
            // (which would flag it) is intentionally not asserted for this test.
            expect(consoleErrors.real(), 'unexpected console errors').toEqual([]);
        } finally {
            await loginAs(page, 'admin');
            await declinePendingFor(page, [NONADMIN_TMDB]);
        }
    });
});
