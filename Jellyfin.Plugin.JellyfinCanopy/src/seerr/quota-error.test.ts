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
