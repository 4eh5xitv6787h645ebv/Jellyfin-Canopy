// Unit test for the advanced-request modal error state (W4-ERR-5).
//
// fetchAdvancedRequestData() used to `catch { return { servers: [], tags: [] } }`,
// so a backend failure produced three empty dropdowns that look like a valid
// empty config. It must now carry an `error`, and populateAdvancedOptions must
// render that error instead of polling for selects that will never populate.
import { describe, expect, it, beforeEach, vi } from 'vitest';

describe('seerr advanced-request error state', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        vi.resetModules();
        fetchMock = vi.fn();
        const JC = window.JellyfinCanopy as unknown as Record<string, unknown>;
        JC.core = { api: { fetch: fetchMock } };
        JC.pluginConfig = {};
        JC.t = (k: string) => k;
        await import('./api');
        await import('./modal');
    });

    function jc(): Record<string, any> {
        return window.JellyfinCanopy as Record<string, any>;
    }

    it('fetchAdvancedRequestData carries an error field on backend failure', async () => {
        fetchMock.mockRejectedValue(new Error('sonarr down'));

        const data = await jc().seerrAPI.fetchAdvancedRequestData('movie');

        expect(data.servers).toEqual([]);
        expect(data.error).toBeTruthy();
    });

    it('populateAdvancedOptions renders the error note instead of empty dropdowns', () => {
        const host = document.createElement('div');
        host.innerHTML = jc().seerrModal.createAdvancedOptionsHTML('movie');

        jc().seerrModal.populateAdvancedOptions(
            host,
            { servers: [], tags: [], error: 'Failed to load server options' },
            'movie'
        );

        expect(host.querySelector('.seerr-advanced-error')).not.toBeNull();
        expect(host.textContent).toContain('Failed to load server options');
        // The error path must NOT leave the three empty placeholder selects behind.
        expect(host.querySelector('#movie-server')).toBeNull();
    });
});
