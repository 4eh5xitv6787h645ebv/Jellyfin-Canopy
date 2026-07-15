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
        const abortAllRequests = vi.fn();
        const clearCache = vi.fn();
        JC.core.api = {
            plugin,
            manager: { abortAllRequests, clearCache },
        } as unknown as NonNullable<typeof JC.core.api>;

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
        expect(abortAllRequests).toHaveBeenCalledTimes(1);
        expect(clearCache).toHaveBeenCalledTimes(1);

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

    it('drops an A refresh continuation after the same user moves to server B', async () => {
        const contextA = JC.identity.transition('live-server-a', 'shared-user', 'live-config-test-a')!;
        JC.pluginConfig = {};
        let resolvePublic: (value: unknown) => void = () => undefined;
        const heldPublic = new Promise<unknown>((resolve) => { resolvePublic = resolve; });
        const plugin = vi.fn((path: string) => path.startsWith('/public-config')
            ? heldPublic
            : Promise.resolve({}));
        JC.core.api = { plugin } as unknown as NonNullable<typeof JC.core.api>;
        const scheduleScan = vi.fn();
        const invalidateServerCache = vi.fn().mockResolvedValue(undefined);
        JC.tagPipeline = { registerRenderer: vi.fn(), scheduleScan, invalidateServerCache };
        const domEvent = vi.fn();
        window.addEventListener('jc:config-changed', domEvent);

        emit(LIVE.CONFIG_CHANGED, {});
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(1));
        JC.identity.transition('live-server-b', 'shared-user', 'live-config-test-b');
        JC.pluginConfig = {};
        resolvePublic({ Marker: 'stale-a' });
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(JC.identity.isCurrent(contextA)).toBe(false);
        expect(JC.pluginConfig.Marker).toBeUndefined();
        expect(domEvent).not.toHaveBeenCalled();
        expect(scheduleScan).not.toHaveBeenCalled();
        expect(invalidateServerCache).not.toHaveBeenCalled();
        window.removeEventListener('jc:config-changed', domEvent);
    });

    it('does not let a synchronous DOM listener move A config work into B pipeline state', async () => {
        const contextA = JC.identity.transition('live-dispatch-server-a', 'live-dispatch-user-a', 'live-dispatch-a')!;
        JC.pluginConfig = { SpoilerStripRatings: false };
        JC.core.api = {
            plugin: vi.fn((path: string) => path.startsWith('/public-config')
                ? Promise.resolve({ SpoilerStripRatings: true })
                : Promise.resolve({})),
        } as unknown as NonNullable<typeof JC.core.api>;
        const scheduleScan = vi.fn();
        const invalidateServerCache = vi.fn().mockResolvedValue(undefined);
        JC.tagPipeline = { registerRenderer: vi.fn(), scheduleScan, invalidateServerCache };
        const switchIdentity = vi.fn(() => {
            JC.identity.transition('live-dispatch-server-b', 'live-dispatch-user-b', 'live-dispatch-b');
        });
        window.addEventListener('jc:config-changed', switchIdentity);

        try {
            emit(LIVE.CONFIG_CHANGED, {});
            await vi.waitFor(() => expect(switchIdentity).toHaveBeenCalledTimes(1));
            await Promise.resolve();

            expect(JC.identity.isCurrent(contextA)).toBe(false);
            expect(invalidateServerCache).not.toHaveBeenCalled();
            expect(scheduleScan).not.toHaveBeenCalled();
        } finally {
            window.removeEventListener('jc:config-changed', switchIdentity);
        }
    });
});
describe('config hot-reload in-flight guard (CORE-9)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('invalidates once when a newer refresh supersedes a policy-merging refresh', async () => {
        JC.pluginConfig = { SpoilerStripRatings: false };
        let resolveFirstPrivate: (value: unknown) => void = () => undefined;
        const heldFirstPrivate = new Promise<unknown>((resolve) => { resolveFirstPrivate = resolve; });
        let publicCalls = 0;
        let privateCalls = 0;
        const plugin = vi.fn((path: string) => {
            if (path.startsWith('/public-config')) {
                publicCalls += 1;
                return Promise.resolve({ SpoilerStripRatings: true });
            }
            if (path.startsWith('/private-config')) {
                privateCalls += 1;
                return privateCalls === 1 ? heldFirstPrivate : Promise.resolve({});
            }
            return Promise.resolve({});
        });
        JC.core.api = { plugin } as unknown as NonNullable<typeof JC.core.api>;
        const invalidateServerCache = vi.fn().mockResolvedValue(undefined);
        const scheduleScan = vi.fn();
        JC.tagPipeline = { registerRenderer: vi.fn(), invalidateServerCache, scheduleScan };

        emit(LIVE.CONFIG_CHANGED, {}); // H1 merges the policy, then waits on private-config.
        await vi.waitFor(() => {
            expect(privateCalls).toBe(1);
            expect(JC.pluginConfig.SpoilerStripRatings).toBe(true);
        });

        emit(LIVE.CONFIG_CHANGED, {}); // H2 sees the merged value and supersedes H1.
        await vi.waitFor(() => expect(invalidateServerCache).toHaveBeenCalledTimes(1));
        expect(publicCalls).toBe(2);
        expect(privateCalls).toBe(2);
        expect(scheduleScan).not.toHaveBeenCalled();

        resolveFirstPrivate({});
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(invalidateServerCache).toHaveBeenCalledTimes(1);
    });

    it('retries an unchanged dirty policy after cache invalidation rejects once', async () => {
        JC.identity.transition('live-retry-server', 'live-retry-user', 'live-config-retry-test');
        JC.pluginConfig = { SpoilerStripRatings: false };
        JC.core.api = {
            plugin: vi.fn((path: string) => path.startsWith('/public-config')
                ? Promise.resolve({ SpoilerStripRatings: true })
                : Promise.resolve({})),
        } as unknown as NonNullable<typeof JC.core.api>;
        const invalidateServerCache = vi.fn()
            .mockRejectedValueOnce(new Error('transient invalidation failure'))
            .mockResolvedValue(undefined);
        const scheduleScan = vi.fn();
        JC.tagPipeline = { registerRenderer: vi.fn(), invalidateServerCache, scheduleScan };
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        emit(LIVE.CONFIG_CHANGED, {});
        await vi.waitFor(() => expect(consoleLog).toHaveBeenCalledTimes(1));
        expect(invalidateServerCache).toHaveBeenCalledTimes(1);

        // The fetched policy is unchanged, but the failed invalidation must not
        // have advanced the successful baseline.
        emit(LIVE.CONFIG_CHANGED, {});
        await vi.waitFor(() => expect(consoleLog).toHaveBeenCalledTimes(2));
        expect(invalidateServerCache).toHaveBeenCalledTimes(2);

        // Once the retry succeeds, another identical push takes the cheap path.
        emit(LIVE.CONFIG_CHANGED, {});
        await vi.waitFor(() => expect(scheduleScan).toHaveBeenCalledTimes(1));
        expect(invalidateServerCache).toHaveBeenCalledTimes(2);
    });

    it('shares a pending invalidation between overlapping equivalent pushes', async () => {
        JC.identity.transition('live-dedup-server', 'live-dedup-user', 'live-config-dedup-test');
        JC.pluginConfig = { SpoilerStripRatings: false };
        let privateCalls = 0;
        JC.core.api = {
            plugin: vi.fn((path: string) => {
                if (path.startsWith('/public-config')) {
                    return Promise.resolve({ SpoilerStripRatings: true });
                }
                privateCalls += 1;
                return Promise.resolve({});
            }),
        } as unknown as NonNullable<typeof JC.core.api>;
        let resolveInvalidation: () => void = () => undefined;
        const heldInvalidation = new Promise<void>((resolve) => { resolveInvalidation = resolve; });
        const invalidateServerCache = vi.fn(() => heldInvalidation);
        const scheduleScan = vi.fn();
        JC.tagPipeline = { registerRenderer: vi.fn(), invalidateServerCache, scheduleScan };
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        emit(LIVE.CONFIG_CHANGED, {});
        await vi.waitFor(() => expect(invalidateServerCache).toHaveBeenCalledTimes(1));

        emit(LIVE.CONFIG_CHANGED, {});
        await vi.waitFor(() => expect(privateCalls).toBe(2));
        expect(invalidateServerCache).toHaveBeenCalledTimes(1);

        resolveInvalidation();
        await vi.waitFor(() => expect(consoleLog).toHaveBeenCalledTimes(2));

        emit(LIVE.CONFIG_CHANGED, {});
        await vi.waitFor(() => expect(scheduleScan).toHaveBeenCalledTimes(1));
        expect(invalidateServerCache).toHaveBeenCalledTimes(1);
    });

    it('does not let an older invalidation completion roll back a newer policy', async () => {
        JC.identity.transition('live-order-server', 'live-order-user', 'live-config-order-test');
        JC.pluginConfig = { SpoilerStripRatings: false, SpoilerStripTags: false };
        let publicCalls = 0;
        JC.core.api = {
            plugin: vi.fn((path: string) => {
                if (path.startsWith('/public-config')) {
                    publicCalls += 1;
                    return Promise.resolve(publicCalls === 1
                        ? { SpoilerStripRatings: true, SpoilerStripTags: false }
                        : { SpoilerStripRatings: true, SpoilerStripTags: true });
                }
                return Promise.resolve({});
            }),
        } as unknown as NonNullable<typeof JC.core.api>;
        let resolveOlderInvalidation: () => void = () => undefined;
        const olderInvalidation = new Promise<void>((resolve) => { resolveOlderInvalidation = resolve; });
        const invalidateServerCache = vi.fn()
            .mockImplementationOnce(() => olderInvalidation)
            .mockResolvedValue(undefined);
        const scheduleScan = vi.fn();
        JC.tagPipeline = { registerRenderer: vi.fn(), invalidateServerCache, scheduleScan };
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        emit(LIVE.CONFIG_CHANGED, {});
        await vi.waitFor(() => expect(invalidateServerCache).toHaveBeenCalledTimes(1));

        emit(LIVE.CONFIG_CHANGED, {});
        await vi.waitFor(() => expect(consoleLog).toHaveBeenCalledTimes(1));
        expect(invalidateServerCache).toHaveBeenCalledTimes(2);

        resolveOlderInvalidation();
        await vi.waitFor(() => expect(consoleLog).toHaveBeenCalledTimes(2));

        emit(LIVE.CONFIG_CHANGED, {});
        await vi.waitFor(() => expect(scheduleScan).toHaveBeenCalledTimes(1));
        expect(invalidateServerCache).toHaveBeenCalledTimes(2);
    });

    it('starts fresh F1 work when policy observations follow F1 to F2 to F1', async () => {
        JC.identity.transition('live-aba-server', 'live-aba-user', 'live-config-aba-test');
        JC.pluginConfig = { SpoilerStripRatings: false, SpoilerStripTags: false };
        const policies = [
            { SpoilerStripRatings: true, SpoilerStripTags: false },
            { SpoilerStripRatings: true, SpoilerStripTags: true },
            { SpoilerStripRatings: true, SpoilerStripTags: false },
            { SpoilerStripRatings: true, SpoilerStripTags: false },
        ];
        let publicCalls = 0;
        JC.core.api = {
            plugin: vi.fn((path: string) => path.startsWith('/public-config')
                ? Promise.resolve(policies[Math.min(publicCalls++, policies.length - 1)])
                : Promise.resolve({})),
        } as unknown as NonNullable<typeof JC.core.api>;
        let resolveFirst: () => void = () => undefined;
        let resolveSecond: () => void = () => undefined;
        let resolveThird: () => void = () => undefined;
        const first = new Promise<void>((resolve) => { resolveFirst = resolve; });
        const second = new Promise<void>((resolve) => { resolveSecond = resolve; });
        const third = new Promise<void>((resolve) => { resolveThird = resolve; });
        const invalidateServerCache = vi.fn()
            .mockImplementationOnce(() => first)
            .mockImplementationOnce(() => second)
            .mockImplementationOnce(() => third);
        const scheduleScan = vi.fn();
        JC.tagPipeline = { registerRenderer: vi.fn(), invalidateServerCache, scheduleScan };
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        emit(LIVE.CONFIG_CHANGED, {});
        await vi.waitFor(() => expect(invalidateServerCache).toHaveBeenCalledTimes(1));
        emit(LIVE.CONFIG_CHANGED, {});
        await vi.waitFor(() => expect(invalidateServerCache).toHaveBeenCalledTimes(2));
        emit(LIVE.CONFIG_CHANGED, {});
        await vi.waitFor(() => expect(invalidateServerCache).toHaveBeenCalledTimes(3));

        resolveFirst();
        resolveSecond();
        await vi.waitFor(() => expect(consoleLog).toHaveBeenCalledTimes(2));
        resolveThird();
        await vi.waitFor(() => expect(consoleLog).toHaveBeenCalledTimes(3));

        emit(LIVE.CONFIG_CHANGED, {});
        await vi.waitFor(() => expect(scheduleScan).toHaveBeenCalledTimes(1));
        expect(invalidateServerCache).toHaveBeenCalledTimes(3);
    });

    it('reasserts the successful baseline after a different policy starts invalidating', async () => {
        JC.identity.transition('live-return-server', 'live-return-user', 'live-config-return-test');
        JC.pluginConfig = { SpoilerStripRatings: false };
        const policies = [
            { SpoilerStripRatings: true },
            { SpoilerStripRatings: false },
            { SpoilerStripRatings: false },
        ];
        let publicCalls = 0;
        JC.core.api = {
            plugin: vi.fn((path: string) => path.startsWith('/public-config')
                ? Promise.resolve(policies[Math.min(publicCalls++, policies.length - 1)])
                : Promise.resolve({})),
        } as unknown as NonNullable<typeof JC.core.api>;
        let resolveAway: () => void = () => undefined;
        let resolveReturn: () => void = () => undefined;
        const away = new Promise<void>((resolve) => { resolveAway = resolve; });
        const returned = new Promise<void>((resolve) => { resolveReturn = resolve; });
        const invalidateServerCache = vi.fn()
            .mockImplementationOnce(() => away)
            .mockImplementationOnce(() => returned);
        const scheduleScan = vi.fn();
        JC.tagPipeline = { registerRenderer: vi.fn(), invalidateServerCache, scheduleScan };
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        emit(LIVE.CONFIG_CHANGED, {});
        await vi.waitFor(() => expect(invalidateServerCache).toHaveBeenCalledTimes(1));
        emit(LIVE.CONFIG_CHANGED, {});
        await vi.waitFor(() => expect(invalidateServerCache).toHaveBeenCalledTimes(2));

        resolveAway();
        resolveReturn();
        await vi.waitFor(() => expect(consoleLog).toHaveBeenCalledTimes(2));

        emit(LIVE.CONFIG_CHANGED, {});
        await vi.waitFor(() => expect(scheduleScan).toHaveBeenCalledTimes(1));
        expect(invalidateServerCache).toHaveBeenCalledTimes(2);
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
