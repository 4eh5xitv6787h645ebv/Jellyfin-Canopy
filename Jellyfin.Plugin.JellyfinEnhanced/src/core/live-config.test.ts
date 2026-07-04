// Unit test for src/core/live-config.ts — a CONFIG_CHANGED live event must
// refetch the plugin config, merge it into JE.pluginConfig IN PLACE (reference
// identity preserved), and fire the legacy je:config-changed DOM event.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JE } from '../globals';
import { emit, LIVE } from './live';
import './live-config'; // registers the CONFIG_CHANGED handler at import

describe('config hot-reload reaction', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('refetches config and merges into JE.pluginConfig in place', async () => {
        const configRef = JE.pluginConfig; // capture the reference modules hold
        (JE.pluginConfig as Record<string, unknown>).StaleKept = true;

        const plugin = vi.fn((path: string) => {
            if (path.startsWith('/public-config')) return Promise.resolve({ JellyseerrEnabled: true, NewToggle: 1 });
            if (path.startsWith('/private-config')) return Promise.resolve({ SecretUrl: 'http://x' });
            return Promise.resolve({});
        });
        JE.core.api = { plugin } as unknown as NonNullable<typeof JE.core.api>;

        const domEvent = vi.fn();
        window.addEventListener('je:config-changed', domEvent);

        emit(LIVE.CONFIG_CHANGED, { JellyfinEnhanced: 'config-changed', Version: '9.9.9.0' });

        await vi.waitFor(() => {
            expect(JE.pluginConfig.JellyseerrEnabled).toBe(true);
        });

        // public + private both merged...
        expect(JE.pluginConfig.NewToggle).toBe(1);
        expect(JE.pluginConfig.SecretUrl).toBe('http://x');
        // ...pre-existing keys preserved...
        expect(JE.pluginConfig.StaleKept).toBe(true);
        // ...and the object identity is unchanged (Object.assign, not reassign).
        expect(JE.pluginConfig).toBe(configRef);
        // legacy hook fired for unmigrated modules.
        expect(domEvent).toHaveBeenCalledTimes(1);

        // both endpoints hit with a cache-buster.
        expect(plugin).toHaveBeenCalledWith(expect.stringMatching(/^\/public-config\?_je=\d+/), expect.anything());
        expect(plugin).toHaveBeenCalledWith(expect.stringMatching(/^\/private-config\?_je=\d+/), expect.anything());

        window.removeEventListener('je:config-changed', domEvent);
    });

    it('survives a public-config fetch failure without throwing', async () => {
        JE.core.api = {
            plugin: vi.fn(() => Promise.reject(new Error('network')))
        } as unknown as NonNullable<typeof JE.core.api>;
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        expect(() => emit(LIVE.CONFIG_CHANGED, {})).not.toThrow();
        await vi.waitFor(() => expect(consoleError).toHaveBeenCalled());
    });
});
