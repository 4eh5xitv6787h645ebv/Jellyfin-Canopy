// Unit test for api.canRequest4k — the single client-side gate for the 4K
// request affordance. It must combine the JC admin toggle (master switch) with
// the Seerr-reported capability + per-user 4K permission carried on the cached
// user-status, and degrade to hidden until that status resolves.
import { describe, expect, it, beforeEach, vi } from 'vitest';

describe('seerr api.canRequest4k gating', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        vi.resetModules();
        fetchMock = vi.fn();
        const JC = window.JellyfinCanopy as unknown as Record<string, unknown>;
        JC.core = { api: { fetch: fetchMock } };
        JC.pluginConfig = {};
        JC.t = (k: string) => k;
        JC.toast = vi.fn();
        JC.escapeHtml = (s: unknown) => String(s);
        await import('./api');
    });

    function api(): {
        checkUserStatus: () => Promise<unknown>;
        canRequest4k: (mediaType: string) => boolean;
    } {
        return (window.JellyfinCanopy as unknown as {
            seerrAPI: { checkUserStatus: () => Promise<unknown>; canRequest4k: (m: string) => boolean };
        }).seerrAPI;
    }

    function setConfig(cfg: Record<string, unknown>): void {
        (window.JellyfinCanopy as unknown as { pluginConfig: unknown }).pluginConfig = cfg;
    }

    async function primeStatus(status: Record<string, unknown>): Promise<void> {
        fetchMock.mockResolvedValue(status);
        await api().checkUserStatus();
    }

    it('hides 4K when the admin toggle is off, even if the user is capable', async () => {
        setConfig({ SeerrEnable4KRequests: false });
        await primeStatus({ active: true, userFound: true, canRequest4kMovie: true });
        expect(api().canRequest4k('movie')).toBe(false);
    });

    it('hides 4K when the Seerr/user capability is false, even if admin-enabled', async () => {
        setConfig({ SeerrEnable4KRequests: true });
        await primeStatus({ active: true, userFound: true, canRequest4kMovie: false });
        expect(api().canRequest4k('movie')).toBe(false);
    });

    it('shows 4K per media type only when admin toggle AND capability agree', async () => {
        setConfig({ SeerrEnable4KRequests: true, SeerrEnable4KTvRequests: true });
        await primeStatus({ active: true, userFound: true, canRequest4kMovie: true, canRequest4kTv: false });
        expect(api().canRequest4k('movie')).toBe(true);
        expect(api().canRequest4k('tv')).toBe(false);
    });

    it('respects the separate TV admin toggle', async () => {
        setConfig({ SeerrEnable4KRequests: false, SeerrEnable4KTvRequests: true });
        await primeStatus({ active: true, userFound: true, canRequest4kMovie: true, canRequest4kTv: true });
        expect(api().canRequest4k('movie')).toBe(false);
        expect(api().canRequest4k('tv')).toBe(true);
    });

    it('degrades to hidden until user-status resolves', () => {
        setConfig({ SeerrEnable4KRequests: true });
        // No primeStatus — cached status is still null.
        fetchMock.mockResolvedValue({ active: true, userFound: true, canRequest4kMovie: true });
        expect(api().canRequest4k('movie')).toBe(false);
    });

    it('does not memoize a navigation cancellation as an unavailable capability', async () => {
        setConfig({ SeerrEnable4KRequests: true });
        const cancellation = new Error('Request was aborted');
        cancellation.name = 'AbortError';
        fetchMock
            .mockRejectedValueOnce(cancellation)
            .mockResolvedValueOnce({
                active: true,
                userFound: true,
                canRequest4kMovie: true,
            });

        await expect(api().checkUserStatus()).rejects.toMatchObject({ name: 'AbortError' });

        await expect(api().checkUserStatus()).resolves.toMatchObject({
            active: true,
            userFound: true,
            canRequest4kMovie: true,
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(api().canRequest4k('movie')).toBe(true);
    });

    it('retires pending and cached capability work when live config changes', async () => {
        setConfig({ SeerrEnable4KRequests: true });
        let resolveOld!: (value: unknown) => void;
        fetchMock
            // eslint-disable-next-line @typescript-eslint/no-misused-promises -- deterministic config-generation race
            .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
            .mockResolvedValueOnce({
                active: true,
                userFound: true,
                canRequest4kMovie: false,
            })
            .mockResolvedValueOnce({
                active: true,
                userFound: true,
                canRequest4kMovie: true,
            });

        const oldStatus = api().checkUserStatus();
        window.dispatchEvent(new CustomEvent('jc:config-changed'));
        resolveOld({ active: true, userFound: true, canRequest4kMovie: true });

        await expect(oldStatus).rejects.toThrow(/stale configuration/i);
        await expect(api().checkUserStatus()).resolves.toMatchObject({
            canRequest4kMovie: false,
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(api().canRequest4k('movie')).toBe(false);

        // A settled positive/negative status is sticky until this same config
        // boundary; after it, the next caller must resolve the replacement
        // source instead of reusing B's cached capability.
        window.dispatchEvent(new CustomEvent('jc:config-changed'));
        await expect(api().checkUserStatus()).resolves.toMatchObject({
            canRequest4kMovie: true,
        });
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(api().canRequest4k('movie')).toBe(true);
    });
});
