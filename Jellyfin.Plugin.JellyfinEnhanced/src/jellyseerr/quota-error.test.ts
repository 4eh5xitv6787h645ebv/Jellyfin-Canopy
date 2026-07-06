// Unit test for the request-error toast sanitization (W4-ERR-8).
//
// handleRequestError used to toast the raw upstream Seerr message
// (error.responseJSON.message), which could leak an internal Seerr URL or a
// 500 stack. It must now route through describeFetchError, which drops
// URL-bearing / HTML / over-long blobs and falls back to a generic message.
import { describe, expect, it, beforeEach, vi } from 'vitest';

describe('jellyseerr handleRequestError sanitization', () => {
    let toast: ReturnType<typeof vi.fn>;
    let internal: Record<string, any>;

    beforeEach(async () => {
        vi.resetModules();
        toast = vi.fn();
        const JE = window.JellyfinEnhanced as unknown as Record<string, unknown>;
        JE.pluginConfig = {};
        JE.t = (k: string) => k;
        JE.toast = toast;
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
        expect(arg).toContain('jellyseerr_modal_toast_request_fail');
    });

    it('passes a clean short upstream message through', async () => {
        const err = { status: 500, responseJSON: { message: 'Movie already requested' } };

        await internal.handleRequestError(err, 'movie', null, null);

        expect(toast).toHaveBeenCalledTimes(1);
        expect(String(toast.mock.calls[0][0])).toContain('Movie already requested');
    });
});
