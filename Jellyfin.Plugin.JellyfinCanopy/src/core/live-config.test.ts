// Unit test for src/core/live-config.ts — a CONFIG_CHANGED live event must
// refetch the plugin config, merge it into JC.pluginConfig IN PLACE (reference
// identity preserved), and fire the legacy jc:config-changed DOM event.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import { emit, LIVE } from './live';
import './live-config'; // registers the CONFIG_CHANGED handler at import

describe('config hot-reload reaction', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('refetches config and merges into JC.pluginConfig in place', async () => {
        const configRef = JC.pluginConfig; // capture the reference modules hold
        (JC.pluginConfig as Record<string, unknown>).StaleKept = true;

        const plugin = vi.fn((path: string) => {
            if (path.startsWith('/public-config')) return Promise.resolve({ SeerrEnabled: true, NewToggle: 1 });
            if (path.startsWith('/private-config')) return Promise.resolve({ SecretUrl: 'http://x' });
            return Promise.resolve({});
        });
        JC.core.api = { plugin } as unknown as NonNullable<typeof JC.core.api>;

        const domEvent = vi.fn();
        window.addEventListener('jc:config-changed', domEvent);

        emit(LIVE.CONFIG_CHANGED, { JellyfinCanopy: 'config-changed', Version: '9.9.9.0' });

        await vi.waitFor(() => {
            expect(JC.pluginConfig.SeerrEnabled).toBe(true);
        });

        // public + private both merged...
        expect(JC.pluginConfig.NewToggle).toBe(1);
        expect(JC.pluginConfig.SecretUrl).toBe('http://x');
        // ...pre-existing keys preserved...
        expect(JC.pluginConfig.StaleKept).toBe(true);
        // ...and the object identity is unchanged (Object.assign, not reassign).
        expect(JC.pluginConfig).toBe(configRef);
        // legacy hook fired for unmigrated modules.
        expect(domEvent).toHaveBeenCalledTimes(1);

        // both endpoints hit with a cache-buster.
        expect(plugin).toHaveBeenCalledWith(expect.stringMatching(/^\/public-config\?_je=\d+/), expect.anything());
        expect(plugin).toHaveBeenCalledWith(expect.stringMatching(/^\/private-config\?_je=\d+/), expect.anything());

        window.removeEventListener('jc:config-changed', domEvent);
    });

    it('survives a public-config fetch failure without throwing', async () => {
        JC.core.api = {
            plugin: vi.fn(() => Promise.reject(new Error('network')))
        } as unknown as NonNullable<typeof JC.core.api>;
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        expect(() => emit(LIVE.CONFIG_CHANGED, {})).not.toThrow();
        await vi.waitFor(() => expect(consoleError).toHaveBeenCalled());
    });

    it('rebuilds the personalized tag projection when admin spoiler policy changes', async () => {
        JC.pluginConfig.SpoilerStripRatings = false;
        JC.core.api = {
            plugin: vi.fn((path: string) => path.startsWith('/public-config')
                ? Promise.resolve({ SpoilerStripRatings: true })
                : Promise.resolve({})),
        } as unknown as NonNullable<typeof JC.core.api>;
        const invalidateServerCache = vi.fn().mockResolvedValue(undefined);
        JC.tagPipeline = { registerRenderer: vi.fn(), invalidateServerCache };

        emit(LIVE.CONFIG_CHANGED, {});

        await vi.waitFor(() => expect(invalidateServerCache).toHaveBeenCalledTimes(1));
    });
});
describe('config hot-reload in-flight guard (CORE-9)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('a superseded (slower) refresh does not overwrite the newer one', async () => {
        let resolveSlow: (value: unknown) => void = () => undefined;
        const slow = new Promise<unknown>((resolve) => { resolveSlow = resolve; });
        const fast = Promise.resolve({ Marker: 'new' });

        let publicCall = 0;
        JC.core.api = {
            plugin: vi.fn((path: string) => {
                if (path.startsWith('/public-config')) {
                    publicCall += 1;
                    return publicCall === 1 ? slow : fast; // first (older) refresh is the slow one
                }
                return Promise.resolve({});
            })
        } as unknown as NonNullable<typeof JC.core.api>;

        emit(LIVE.CONFIG_CHANGED, {}); // refresh 1 (seq 1) -> awaits slow
        emit(LIVE.CONFIG_CHANGED, {}); // refresh 2 (seq 2) -> awaits fast
        await Promise.resolve();

        // Fast (newer) settles first and wins.
        await vi.waitFor(() => expect(JC.pluginConfig.Marker).toBe('new'));

        // Slow (older) settles LAST — but must be discarded, not overwrite.
        resolveSlow({ Marker: 'old' });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(JC.pluginConfig.Marker).toBe('new');
    });

    it('prunes keys the previous public payload had but the new one dropped', async () => {
        let publicCall = 0;
        JC.core.api = {
            plugin: vi.fn((path: string) => {
                if (path.startsWith('/public-config')) {
                    publicCall += 1;
                    return Promise.resolve(publicCall === 1 ? { Gone: 1, Keep: 1 } : { Keep: 2 });
                }
                return Promise.resolve({});
            })
        } as unknown as NonNullable<typeof JC.core.api>;

        emit(LIVE.CONFIG_CHANGED, {});
        await vi.waitFor(() => expect(JC.pluginConfig.Gone).toBe(1));

        emit(LIVE.CONFIG_CHANGED, {});
        await vi.waitFor(() => expect(JC.pluginConfig.Keep).toBe(2));

        expect('Gone' in JC.pluginConfig).toBe(false);
    });
});
