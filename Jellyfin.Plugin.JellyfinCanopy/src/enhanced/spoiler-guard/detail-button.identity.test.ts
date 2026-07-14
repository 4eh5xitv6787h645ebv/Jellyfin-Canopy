import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    enabled: false,
    enableForSeries: vi.fn<() => Promise<void>>(),
    disableForSeries: vi.fn<() => Promise<void>>(),
    confirmDisableSpoiler: vi.fn<() => Promise<boolean>>(),
    refreshSpoilerableImages: vi.fn<() => void>(),
}));

vi.mock('./state', () => ({
    isEnabledFor: () => mocks.enabled,
    isMovieEnabledFor: () => mocks.enabled,
    isCollectionEnabledFor: () => mocks.enabled,
    enableForSeries: () => mocks.enableForSeries(),
    disableForSeries: () => mocks.disableForSeries(),
    enableForMovie: () => mocks.enableForSeries(),
    disableForMovie: () => mocks.disableForSeries(),
    enableForCollection: () => mocks.enableForSeries(),
    disableForCollection: () => mocks.disableForSeries(),
    getUserPrefs: () => ({}),
    isStateLoaded: () => true,
}));

vi.mock('./dialog', () => ({
    confirmDisableSpoiler: () => mocks.confirmDisableSpoiler(),
}));

vi.mock('./image-refresh', () => ({
    refreshSpoilerableImages: () => mocks.refreshSpoilerableImages(),
}));

import { JC } from '../../globals';
import { addSpoilerBlurButton } from './detail-button';

function deferred(): { promise: Promise<void>; resolve(): void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

function renderPage(): HTMLElement {
    document.body.innerHTML = '<div id="itemDetailPage"><div class="detailButtons"></div></div>';
    return document.getElementById('itemDetailPage')!;
}

async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

describe('Spoiler Guard detail button identity ownership', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = '';
        JC.identity.transition('', '', 'detail-button-test-reset');
        JC.identity.transition('server-a', 'user-a', 'detail-button-test-start');
        (JC.pluginConfig as Record<string, unknown>).SpoilerBlurEnabled = true;
        (JC.pluginConfig as Record<string, unknown>).SpoilerBlurStrictRefresh = false;
        JC.t = (key: string) => key;
        JC.toast = vi.fn();
        JC.tagPipeline = {
            registerRenderer: vi.fn(),
            invalidateServerCache: vi.fn().mockResolvedValue(undefined),
        };
        mocks.enabled = false;
        mocks.enableForSeries.mockReset().mockResolvedValue(undefined);
        mocks.disableForSeries.mockReset().mockResolvedValue(undefined);
        mocks.confirmDisableSpoiler.mockReset().mockResolvedValue(true);
        mocks.refreshSpoilerableImages.mockClear();
    });

    afterEach(() => {
        JC.identity.transition('', '', 'detail-button-test-cleanup');
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    it('removes A and drops its held completion while allowing a fresh B control', async () => {
        const held = deferred();
        mocks.enableForSeries.mockReturnValueOnce(held.promise);
        const page = renderPage();
        addSpoilerBlurButton('item-a', page, 'Series');
        const retainedA = page.querySelector<HTMLButtonElement>('.jc-spoiler-blur-btn')!;
        retainedA.click();
        expect(mocks.enableForSeries).toHaveBeenCalledTimes(1);

        JC.identity.transition('server-a', 'user-b', 'account-switch');
        expect(document.querySelector('.jc-spoiler-blur-btn')).toBeNull();
        held.resolve();
        await flush();

        expect(JC.toast).not.toHaveBeenCalled();
        expect(mocks.refreshSpoilerableImages).not.toHaveBeenCalled();
        retainedA.click();
        expect(mocks.enableForSeries).toHaveBeenCalledTimes(1);

        addSpoilerBlurButton('item-b', page, 'Series');
        const buttonB = page.querySelector<HTMLButtonElement>('.jc-spoiler-blur-btn')!;
        expect(buttonB).toBeTruthy();
        expect(buttonB).not.toBe(retainedA);
        buttonB.click();
        await flush();

        expect(mocks.enableForSeries).toHaveBeenCalledTimes(2);
        expect(mocks.refreshSpoilerableImages).toHaveBeenCalledTimes(1);
        expect(JC.toast).toHaveBeenCalledWith('spoiler_blur_enabled_toast');
    });

    it('cancels an A-owned strict-refresh reload timer synchronously', async () => {
        (JC.pluginConfig as Record<string, unknown>).SpoilerBlurStrictRefresh = true;
        const page = renderPage();
        addSpoilerBlurButton('item-a', page, 'Series');
        page.querySelector<HTMLButtonElement>('.jc-spoiler-blur-btn')!.click();
        await flush();
        expect(vi.getTimerCount()).toBe(1);

        JC.identity.transition('server-a', 'user-b', 'account-switch');
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(1_000);
    });
});
