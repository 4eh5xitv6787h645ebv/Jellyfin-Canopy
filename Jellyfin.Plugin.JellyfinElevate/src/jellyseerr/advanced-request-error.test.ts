// Unit test for the advanced-request modal error state (W4-ERR-5).
//
// fetchAdvancedRequestData() used to `catch { return { servers: [], tags: [] } }`,
// so a backend failure produced three empty dropdowns that look like a valid
// empty config. It must now carry an `error`, and populateAdvancedOptions must
// render that error instead of polling for selects that will never populate.
import { describe, expect, it, beforeEach, vi } from 'vitest';

describe('jellyseerr advanced-request error state', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        vi.resetModules();
        fetchMock = vi.fn();
        const JE = window.JellyfinElevate as unknown as Record<string, unknown>;
        JE.core = { api: { fetch: fetchMock } };
        JE.pluginConfig = {};
        JE.t = (k: string) => k;
        await import('./api');
        await import('./modal');
    });

    function je(): Record<string, any> {
        return window.JellyfinElevate as Record<string, any>;
    }

    it('fetchAdvancedRequestData carries an error field on backend failure', async () => {
        fetchMock.mockRejectedValue(new Error('sonarr down'));

        const data = await je().jellyseerrAPI.fetchAdvancedRequestData('movie');

        expect(data.servers).toEqual([]);
        expect(data.error).toBeTruthy();
    });

    it('populateAdvancedOptions renders the error note instead of empty dropdowns', () => {
        const host = document.createElement('div');
        host.innerHTML = je().jellyseerrModal.createAdvancedOptionsHTML('movie');

        je().jellyseerrModal.populateAdvancedOptions(
            host,
            { servers: [], tags: [], error: 'Failed to load server options' },
            'movie'
        );

        expect(host.querySelector('.jellyseerr-advanced-error')).not.toBeNull();
        expect(host.textContent).toContain('Failed to load server options');
        // The error path must NOT leave the three empty placeholder selects behind.
        expect(host.querySelector('#movie-server')).toBeNull();
    });
});
