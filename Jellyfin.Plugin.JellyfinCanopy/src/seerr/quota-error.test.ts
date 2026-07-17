// Unit test for the request-error toast sanitization (W4-ERR-8).
//
// handleRequestError used to toast the raw upstream Seerr message
// (error.responseJSON.message), which could leak an internal Seerr URL or a
// 500 stack. It must now route through describeFetchError, which drops
// URL-bearing / HTML / over-long blobs and falls back to a generic message.
import { describe, expect, it, beforeEach, vi } from 'vitest';

describe('seerr handleRequestError sanitization', () => {
    let toast: ReturnType<typeof vi.fn>;
    let internal: Record<string, any>;

    beforeEach(async () => {
        vi.resetModules();
        toast = vi.fn();
        const JC = window.JellyfinCanopy as unknown as Record<string, unknown>;
        JC.pluginConfig = {};
        JC.t = (k: string) => k;
        JC.toast = toast;
        await import('./ui/quota');
        internal = (await import('./ui/internal')).internal;
    });

    it('does not leak a URL-bearing upstream message to the toast', async () => {
        const err = {
            status: 500,
            responseJSON: { message: 'Request failed at http://seerr.internal:5055/api/v1/request' },
        };

        await internal.handleRequestError(err, 'movie', null, null);

        expect(toast).toHaveBeenCalledTimes(1);
        const arg = String(toast.mock.calls[0][0]);
        expect(arg).not.toContain('seerr.internal');
        expect(arg).not.toContain('http');
        // Falls back to the generic request-fail key instead.
        expect(arg).toContain('seerr_modal_toast_request_fail');
    });

    it('passes a clean short upstream message through', async () => {
        const err = { status: 500, responseJSON: { message: 'Movie already requested' } };

        await internal.handleRequestError(err, 'movie', null, null);

        expect(toast).toHaveBeenCalledTimes(1);
        expect(String(toast.mock.calls[0][0])).toContain('Movie already requested');
    });

    it('shows eligibility timing only when the quota is actually restricted', () => {
        const future = new Date(Date.now() + 3_600_000).toISOString();

        const available = internal.formatQuotaLine({
            limit: 5,
            used: 4,
            remaining: 1,
            days: 7,
            restricted: false,
            nextResetAt: future,
        }, 'movie');
        const restricted = internal.formatQuotaLine({
            limit: 5,
            used: 5,
            remaining: 0,
            days: 7,
            restricted: true,
            nextResetAt: future,
        }, 'movie');

        expect(available.resetText).toBe('');
        expect(restricted.resetText).toContain('seerr_quota_reset_in_');
    });
});

// The server computes nextResetAt from a bounded paginated history scan and
// publishes quota.resetProjectionComplete: true when the projection covered
// the complete dataset (a missing nextResetAt is then PROVEN absent), false
// when the scan was incomplete / failed (the reset is UNAVAILABLE, not
// absent). The UI must render those two no-timestamp cases differently.
describe('seerr quota reset unavailable-vs-absent distinction', () => {
    let internal: Record<string, any>;
    let JC: Record<string, unknown>;

    const restrictedSide = () => ({
        limit: 5,
        used: 5,
        remaining: 0,
        days: 7,
        restricted: true,
    });

    beforeEach(async () => {
        vi.resetModules();
        JC = window.JellyfinCanopy as unknown as Record<string, unknown>;
        JC.pluginConfig = {};
        JC.t = (k: string) => k;
        JC.toast = vi.fn();
        delete (window as any).Dashboard;
        await import('./ui/quota');
        internal = (await import('./ui/internal')).internal;
    });

    it('renders the unavailable hint when the reset projection is incomplete', () => {
        const line = internal.formatQuotaLine(restrictedSide(), 'movie', false);

        expect(line.resetText).toBe('seerr_quota_reset_unavailable');
    });

    it('renders no reset copy when the reset is proven absent (projection complete)', () => {
        const line = internal.formatQuotaLine(restrictedSide(), 'movie', true);

        expect(line.resetText).toBe('');
    });

    it('legacy two-argument calls keep the current behavior (undefined is not "unavailable")', () => {
        const line = internal.formatQuotaLine(restrictedSide(), 'movie');

        expect(line.resetText).toBe('');
    });

    it('prefers a resolved timestamp over the unavailable hint', () => {
        const future = new Date(Date.now() + 3_600_000).toISOString();
        const line = internal.formatQuotaLine(
            { ...restrictedSide(), nextResetAt: future },
            'movie',
            true
        );

        expect(line.resetText).toContain('seerr_quota_reset_in_');
    });

    it('does not show the unavailable hint on an unrestricted side', () => {
        const line = internal.formatQuotaLine(
            { limit: 5, used: 2, remaining: 3, days: 7, restricted: false },
            'movie',
            false
        );

        expect(line.resetText).toBe('');
    });

    it('buildQuotaChip surfaces the unavailable hint from the top-level flag', () => {
        const chip = internal.buildQuotaChip(
            { movie: restrictedSide(), tv: null, resetProjectionComplete: false },
            'movie'
        );

        const subs = Array.from(chip!.querySelectorAll('.seerr-quota-chip-sub'))
            .map((el: any) => el.textContent);
        expect(subs).toContain('seerr_quota_reset_unavailable');
    });

    it('buildQuotaChip renders only the restricted hint when the reset is proven absent', () => {
        const chip = internal.buildQuotaChip(
            { movie: restrictedSide(), tv: null, resetProjectionComplete: true },
            'movie'
        );

        const subs = Array.from(chip!.querySelectorAll('.seerr-quota-chip-sub'))
            .map((el: any) => el.textContent);
        expect(subs).toContain('seerr_quota_restricted_hint');
        expect(subs).not.toContain('seerr_quota_reset_unavailable');
    });

    it('showQuotaErrorDialog includes the unavailable hint when the projection is incomplete', async () => {
        const alert = vi.fn();
        (window as any).Dashboard = { alert };
        JC.seerrAPI = {
            fetchUserQuota: vi.fn().mockResolvedValue({
                movie: restrictedSide(),
                tv: null,
                resetProjectionComplete: false,
            }),
        };

        await internal.showQuotaErrorDialog(
            { status: 403, responseJSON: { message: 'Movie Quota exceeded.' } },
            'movie'
        );

        expect(alert).toHaveBeenCalledTimes(1);
        expect(String(alert.mock.calls[0][0].message)).toContain('seerr_quota_reset_unavailable');
    });

    it('showQuotaErrorDialog omits the unavailable hint when the reset is proven absent', async () => {
        const alert = vi.fn();
        (window as any).Dashboard = { alert };
        JC.seerrAPI = {
            fetchUserQuota: vi.fn().mockResolvedValue({
                movie: restrictedSide(),
                tv: null,
                resetProjectionComplete: true,
            }),
        };

        await internal.showQuotaErrorDialog(
            { status: 403, responseJSON: { message: 'Movie Quota exceeded.' } },
            'movie'
        );

        expect(alert).toHaveBeenCalledTimes(1);
        expect(String(alert.mock.calls[0][0].message)).not.toContain('seerr_quota_reset_unavailable');
    });
});
