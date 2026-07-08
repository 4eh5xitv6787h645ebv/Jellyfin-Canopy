// Unit test for api.canRequest4k — the single client-side gate for the 4K
// request affordance. It must combine the JE admin toggle (master switch) with
// the Seerr-reported capability + per-user 4K permission carried on the cached
// user-status, and degrade to hidden until that status resolves.
import { describe, expect, it, beforeEach, vi } from 'vitest';

describe('jellyseerr api.canRequest4k gating', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        vi.resetModules();
        fetchMock = vi.fn();
        const JE = window.JellyfinElevate as unknown as Record<string, unknown>;
        JE.core = { api: { fetch: fetchMock } };
        JE.pluginConfig = {};
        JE.t = (k: string) => k;
        JE.toast = vi.fn();
        JE.escapeHtml = (s: unknown) => String(s);
        await import('./api');
    });

    function api(): {
        checkUserStatus: () => Promise<unknown>;
        canRequest4k: (mediaType: string) => boolean;
    } {
        return (window.JellyfinElevate as unknown as {
            jellyseerrAPI: { checkUserStatus: () => Promise<unknown>; canRequest4k: (m: string) => boolean };
        }).jellyseerrAPI;
    }

    function setConfig(cfg: Record<string, unknown>): void {
        (window.JellyfinElevate as unknown as { pluginConfig: unknown }).pluginConfig = cfg;
    }

    async function primeStatus(status: Record<string, unknown>): Promise<void> {
        fetchMock.mockResolvedValue(status);
        await api().checkUserStatus();
    }

    it('hides 4K when the admin toggle is off, even if the user is capable', async () => {
        setConfig({ JellyseerrEnable4KRequests: false });
        await primeStatus({ active: true, userFound: true, canRequest4kMovie: true });
        expect(api().canRequest4k('movie')).toBe(false);
    });

    it('hides 4K when the Seerr/user capability is false, even if admin-enabled', async () => {
        setConfig({ JellyseerrEnable4KRequests: true });
        await primeStatus({ active: true, userFound: true, canRequest4kMovie: false });
        expect(api().canRequest4k('movie')).toBe(false);
    });

    it('shows 4K per media type only when admin toggle AND capability agree', async () => {
        setConfig({ JellyseerrEnable4KRequests: true, JellyseerrEnable4KTvRequests: true });
        await primeStatus({ active: true, userFound: true, canRequest4kMovie: true, canRequest4kTv: false });
        expect(api().canRequest4k('movie')).toBe(true);
        expect(api().canRequest4k('tv')).toBe(false);
    });

    it('respects the separate TV admin toggle', async () => {
        setConfig({ JellyseerrEnable4KRequests: false, JellyseerrEnable4KTvRequests: true });
        await primeStatus({ active: true, userFound: true, canRequest4kMovie: true, canRequest4kTv: true });
        expect(api().canRequest4k('movie')).toBe(false);
        expect(api().canRequest4k('tv')).toBe(true);
    });

    it('degrades to hidden until user-status resolves', () => {
        setConfig({ JellyseerrEnable4KRequests: true });
        // No primeStatus — cached status is still null.
        fetchMock.mockResolvedValue({ active: true, userFound: true, canRequest4kMovie: true });
        expect(api().canRequest4k('movie')).toBe(false);
    });
});
