import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';

const mocks = vi.hoisted(() => ({
    loadState: vi.fn(() => Promise.resolve()),
    resetState: vi.fn(),
    installWatchedRefresh: vi.fn(),
    setIdentityCookie: vi.fn(),
    primeIdentityCookieEarly: vi.fn(),
    liveHandler: null as (() => void) | null,
}));

vi.mock('./state', () => ({
    loadState: mocks.loadState,
    resetState: mocks.resetState,
    whenLoaded: vi.fn(),
    isLoadOk: vi.fn(),
    isEnabledFor: vi.fn(),
    isMovieEnabledFor: vi.fn(),
    isCollectionEnabledFor: vi.fn(),
    hasEnabledCollections: vi.fn(),
    fetchMovieScope: vi.fn(),
    enableForSeries: vi.fn(),
    disableForSeries: vi.fn(),
    enableForMovie: vi.fn(),
    disableForMovie: vi.fn(),
    enableForCollection: vi.fn(),
    disableForCollection: vi.fn(),
    isTmdbEnabled: vi.fn(),
    enableForTmdb: vi.fn(),
    disableForTmdb: vi.fn(),
    getUserPrefs: vi.fn(),
    setUserPrefs: vi.fn(),
}));
vi.mock('./identity', () => ({
    setIdentityCookie: mocks.setIdentityCookie,
    primeIdentityCookieEarly: mocks.primeIdentityCookieEarly,
}));
vi.mock('./watched-refresh', () => ({ installWatchedRefresh: mocks.installWatchedRefresh }));
vi.mock('./detail-button', () => ({ addSpoilerBlurButton: vi.fn() }));
vi.mock('./dialog', () => ({ confirmDisableSpoiler: vi.fn() }));
vi.mock('./styles', () => ({ injectSpoilerGuardCss: vi.fn() }));
vi.mock('../../core/live', () => ({
    LIVE: { CONFIG_CHANGED: 'config-changed' },
    on: vi.fn((_type: string, handler: () => void) => {
        mocks.liveHandler = handler;
        return vi.fn();
    }),
}));

describe('spoiler guard identity activation', () => {
    beforeEach(() => {
        vi.resetModules();
        mocks.loadState.mockClear();
        mocks.resetState.mockClear();
        mocks.installWatchedRefresh.mockClear();
        mocks.setIdentityCookie.mockClear();
        mocks.primeIdentityCookieEarly.mockClear();
        mocks.liveHandler = null;
        JC.pluginConfig = { SpoilerBlurEnabled: true };
    });

    it('loads once per epoch and remains dormant when B has the feature disabled', async () => {
        const original = JC.identity.capture()!;
        await import('./index');
        expect(mocks.loadState).toHaveBeenCalledTimes(1);

        const next = JC.identity.transition('server-b', 'user-b', 'spoiler-index-test')!;
        JC.pluginConfig = { SpoilerBlurEnabled: false };
        await JC.identity.activate(next);
        await JC.identity.activate(next);
        expect(mocks.loadState).toHaveBeenCalledTimes(1);

        JC.pluginConfig = { SpoilerBlurEnabled: true };
        mocks.liveHandler?.();
        expect(mocks.resetState).toHaveBeenCalledTimes(1);
        expect(mocks.loadState).toHaveBeenCalledTimes(2);
        expect(mocks.installWatchedRefresh).toHaveBeenCalledTimes(2);

        JC.identity.transition(original.serverId, original.userId, 'spoiler-index-test-restore');
    });
});
