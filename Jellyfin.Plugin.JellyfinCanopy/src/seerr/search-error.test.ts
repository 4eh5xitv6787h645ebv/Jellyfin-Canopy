// Unit test for the Seerr search error channel (W4-ERR-4).
//
// api.search() used to `catch { return { results: [] } }`, making a backend
// failure indistinguishable from a genuinely-empty result (the search section
// then renders nothing at all). It must now carry a sanitized `error` so the
// consumer can surface it once instead of silently omitting the section.
import { describe, expect, it, beforeEach, vi } from 'vitest';

describe('seerr api.search error channel', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        vi.resetModules();
        fetchMock = vi.fn();
        const JC = window.JellyfinCanopy as unknown as Record<string, unknown>;
        JC.core = { api: { fetch: fetchMock } };
        JC.pluginConfig = {};
        JC.t = (k: string) => k;
        await import('./api');
    });

    function api(): { search: (q: string, p?: number, o?: unknown) => Promise<{ results: unknown[]; error?: string }> } {
        return (window.JellyfinCanopy as unknown as { seerrAPI: { search: (q: string, p?: number, o?: unknown) => Promise<{ results: unknown[]; error?: string }> } }).seerrAPI;
    }

    it('returns an error field (not a bare empty result) when the backend fails', async () => {
        fetchMock.mockRejectedValue(new Error('seerr unreachable'));

        const result = await api().search('batman');

        expect(result.results).toEqual([]);
        expect(result.error).toBeTruthy();
    });

    it('does not carry an error on a genuinely-empty successful search', async () => {
        fetchMock.mockResolvedValue({ results: [], page: 1, totalPages: 1 });

        const result = await api().search('nothingmatches');

        expect(result.results).toEqual([]);
        expect(result.error).toBeUndefined();
    });
});
