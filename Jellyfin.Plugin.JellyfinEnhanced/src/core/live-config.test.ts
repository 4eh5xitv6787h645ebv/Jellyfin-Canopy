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

describe('config hot-reload delivery-flag re-sanitize (INIT-1)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        delete JE._deliveryPluginsInstalled;
    });

    it('re-forces a stale UsePluginPages flag to false after the live merge', async () => {
        JE._deliveryPluginsInstalled = { customTabs: false, pluginPages: false };
        (JE.pluginConfig as Record<string, unknown>).HiddenContentUsePluginPages = false;

        // Server still stores the pre-uninstall `true`.
        JE.core.api = {
            plugin: vi.fn((path: string) => path.startsWith('/public-config')
                ? Promise.resolve({ HiddenContentUsePluginPages: true, RefreshMarker: 'done' })
                : Promise.resolve({}))
        } as unknown as NonNullable<typeof JE.core.api>;

        emit(LIVE.CONFIG_CHANGED, {});

        // Gate on RefreshMarker so we assert AFTER the merge (not vacuously on the
        // initial false); the flag must have been re-zeroed by the sanitizer.
        await vi.waitFor(() => {
            expect(JE.pluginConfig.RefreshMarker).toBe('done');
            expect(JE.pluginConfig.HiddenContentUsePluginPages).toBe(false);
        });
    });

    it('never exposes a stale flag as true during the private-config round-trip (LC-1)', async () => {
        JE._deliveryPluginsInstalled = { customTabs: false, pluginPages: false };
        (JE.pluginConfig as Record<string, unknown>).HiddenContentUsePluginPages = false;

        let releasePrivate: (v: unknown) => void = () => undefined;
        const privatePending = new Promise<unknown>((resolve) => { releasePrivate = resolve; });

        // Sampled inside the private-config fetch: this runs AFTER the public
        // merge but BEFORE private resolves — exactly the window a drawer rebuild
        // would observe. The public payload re-writes the stale `true`.
        let flagDuringWindow: unknown = 'unsampled';

        JE.core.api = {
            plugin: vi.fn((path: string) => {
                if (path.startsWith('/public-config')) {
                    return Promise.resolve({ HiddenContentUsePluginPages: true, RefreshMarker: 'pub' });
                }
                if (path.startsWith('/private-config')) {
                    flagDuringWindow = JE.pluginConfig.HiddenContentUsePluginPages;
                    return privatePending;
                }
                return Promise.resolve({});
            })
        } as unknown as NonNullable<typeof JE.core.api>;

        emit(LIVE.CONFIG_CHANGED, {});

        // Wait until the refresh has entered the private-config fetch.
        await vi.waitFor(() => expect(flagDuringWindow).not.toBe('unsampled'));

        // The stale flag must ALREADY be false across the await — never observably true.
        expect(flagDuringWindow).toBe(false);

        // Draining private-config keeps it false (the end-of-refresh sanitize).
        releasePrivate({});
        await vi.waitFor(() => expect(JE.pluginConfig.HiddenContentUsePluginPages).toBe(false));
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
        JE.core.api = {
            plugin: vi.fn((path: string) => {
                if (path.startsWith('/public-config')) {
                    publicCall += 1;
                    return publicCall === 1 ? slow : fast; // first (older) refresh is the slow one
                }
                return Promise.resolve({});
            })
        } as unknown as NonNullable<typeof JE.core.api>;

        emit(LIVE.CONFIG_CHANGED, {}); // refresh 1 (seq 1) -> awaits slow
        emit(LIVE.CONFIG_CHANGED, {}); // refresh 2 (seq 2) -> awaits fast
        await Promise.resolve();

        // Fast (newer) settles first and wins.
        await vi.waitFor(() => expect(JE.pluginConfig.Marker).toBe('new'));

        // Slow (older) settles LAST — but must be discarded, not overwrite.
        resolveSlow({ Marker: 'old' });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(JE.pluginConfig.Marker).toBe('new');
    });

    it('prunes keys the previous public payload had but the new one dropped', async () => {
        let publicCall = 0;
        JE.core.api = {
            plugin: vi.fn((path: string) => {
                if (path.startsWith('/public-config')) {
                    publicCall += 1;
                    return Promise.resolve(publicCall === 1 ? { Gone: 1, Keep: 1 } : { Keep: 2 });
                }
                return Promise.resolve({});
            })
        } as unknown as NonNullable<typeof JE.core.api>;

        emit(LIVE.CONFIG_CHANGED, {});
        await vi.waitFor(() => expect(JE.pluginConfig.Gone).toBe(1));

        emit(LIVE.CONFIG_CHANGED, {});
        await vi.waitFor(() => expect(JE.pluginConfig.Keep).toBe(2));

        expect('Gone' in JE.pluginConfig).toBe(false);
    });
});
