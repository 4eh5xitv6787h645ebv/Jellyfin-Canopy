import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import { recordDetailsViewShown, resetDetailsViewTrackingForTests } from '../../core/details-view';
import {
    initializeDetailsPage,
    installDetailsPage,
    resetDetailsPage,
} from './details-page';

async function flushPromises(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

function mountDetailsPage(itemId: string): HTMLElement {
    window.history.replaceState(null, '', `/web/index.html#/details?id=${itemId}`);
    const page = document.createElement('div');
    page.id = 'itemDetailPage';
    page.className = 'page libraryPage';
    page.innerHTML = `
        <h1>Item</h1>
        <div class="detailButtons"></div>
        <div class="itemMiscInfo itemMiscInfo-primary"></div>
    `;
    document.body.appendChild(page);
    recordDetailsViewShown(page);
    return page;
}

function publishSpoilerReady(): void {
    const context = JC.identity.capture();
    if (!context) throw new Error('test identity missing');
    window.dispatchEvent(new CustomEvent('jc:spoiler-guard-ready', {
        detail: {
            serverId: context.serverId,
            userId: context.userId,
            identityEpoch: context.epoch,
        },
    }));
}

describe('details-page identity dispatcher', () => {
    let disposeInstall: (() => void) | undefined;
    let unregisterReset: (() => void) | undefined;
    let unregisterActivate: (() => void) | undefined;

    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = '';
        resetDetailsViewTrackingForTests();
        disposeInstall = installDetailsPage();
        unregisterReset = JC.identity.registerReset('details-page-identity-test', resetDetailsPage);
        unregisterActivate = JC.identity.registerActivate(
            'details-page-identity-test',
            initializeDetailsPage,
        );
        JC.identity.transition('page-server-a', 'page-user-a', 'details-page-test');
        JC.currentSettings = {};
        JC.pluginConfig = {};
        JC.hiddenContent = undefined;
        JC.spoilerGuard = undefined;
    });

    afterEach(() => {
        JC.identity.transition('', '', 'details-page-test-cleanup');
        unregisterActivate?.();
        unregisterActivate = undefined;
        unregisterReset?.();
        unregisterReset = undefined;
        disposeInstall?.();
        disposeInstall = undefined;
        resetDetailsPage();
        vi.restoreAllMocks();
        vi.clearAllTimers();
        vi.useRealTimers();
        document.body.innerHTML = '';
        resetDetailsViewTrackingForTests();
        window.history.replaceState(null, '', '/web/index.html#/home');
    });

    it('owns the phone action-row containment adapter for its activation', () => {
        const style = document.getElementById('jc-details-page-responsive-styles');
        expect(style?.textContent).toContain('@media (max-width: 600px)');
        expect(style?.textContent).toContain('#itemDetailPage .detailRibbon > .mainDetailButtons');
        expect(style?.textContent).toContain('flex-wrap: wrap');

        disposeInstall?.();
        disposeInstall = undefined;
        expect(document.getElementById('jc-details-page-responsive-styles')).toBeNull();
    });

    it('cancels A queued dispatch and starts the visible item under B ownership', async () => {
        mountDetailsPage('queued-item');
        const getItem = vi.spyOn(ApiClient, 'getItem').mockResolvedValue({ Type: 'Movie' });
        const contextA = JC.identity.capture()!;
        await JC.identity.activate(contextA);

        const contextB = JC.identity.transition('page-server-b', 'page-user-b', 'details-page-test')!;
        JC.currentSettings = {};
        await JC.identity.activate(contextB);
        vi.advanceTimersByTime(100);
        await flushPromises();

        expect(getItem).toHaveBeenCalledTimes(1);
        expect(getItem).toHaveBeenCalledWith('pageuserb', 'queued-item');
    });

    it('cancels an A item-type backoff before it can refetch under B', async () => {
        mountDetailsPage('retry-item');
        const getItem = vi.spyOn(ApiClient, 'getItem').mockRejectedValue(new Error('temporary'));
        const contextA = JC.identity.capture()!;
        await JC.identity.activate(contextA);
        vi.advanceTimersByTime(100);
        await flushPromises();
        expect(getItem).toHaveBeenCalledTimes(1);

        JC.identity.transition('page-server-b', 'page-user-b', 'details-page-test');
        vi.advanceTimersByTime(10_000);
        await flushPromises();

        expect(getItem).toHaveBeenCalledTimes(1);
    });

    it('retries a first-activation Spoiler-only detail exactly once after readiness', async () => {
        mountDetailsPage('spoiler-cold-item');
        vi.spyOn(ApiClient, 'getItem').mockResolvedValue({ Type: 'Series' });
        const addSpoilerBlurButton = vi.fn();
        JC.pluginConfig = { SpoilerBlurEnabled: true };
        JC.currentSettings = {};
        JC.spoilerGuard = undefined;

        initializeDetailsPage();
        vi.advanceTimersByTime(100);
        await flushPromises();
        vi.advanceTimersByTime(100);
        await flushPromises();

        expect(addSpoilerBlurButton).not.toHaveBeenCalled();

        // Re-entry while Spoiler Guard is still loading keeps one target.
        initializeDetailsPage();
        vi.advanceTimersByTime(100);
        await flushPromises();
        expect(addSpoilerBlurButton).not.toHaveBeenCalled();

        JC.spoilerGuard = { addSpoilerBlurButton } as unknown as typeof JC.spoilerGuard;
        publishSpoilerReady();
        await flushPromises();
        expect(addSpoilerBlurButton).toHaveBeenCalledTimes(1);
        expect(addSpoilerBlurButton).toHaveBeenLastCalledWith(
            'spoiler-cold-item',
            document.getElementById('itemDetailPage'),
            'Series',
        );
        publishSpoilerReady();
        expect(addSpoilerBlurButton).toHaveBeenCalledTimes(1);
    });

    it('waits through a retained inactive facade until the new activation is ready', async () => {
        mountDetailsPage('spoiler-warm-item');
        vi.spyOn(ApiClient, 'getItem').mockResolvedValue({ Type: 'Movie' });
        const fallbackAdd = vi.fn();
        const activeAdd = vi.fn();
        let addDelegate = fallbackAdd;
        const stableAdd = (itemId: string, page: Element, itemType: string): void => {
            addDelegate(itemId, page, itemType);
        };
        JC.pluginConfig = { SpoilerBlurEnabled: true };
        JC.spoilerGuard = { addSpoilerBlurButton: stableAdd } as unknown as typeof JC.spoilerGuard;

        initializeDetailsPage();
        vi.advanceTimersByTime(100);
        await flushPromises();
        vi.advanceTimersByTime(100);
        await flushPromises();
        expect(fallbackAdd).toHaveBeenCalledTimes(1);

        addDelegate = activeAdd;
        publishSpoilerReady();
        expect(fallbackAdd).toHaveBeenCalledTimes(1);
        expect(activeAdd).toHaveBeenCalledTimes(1);
    });

    it('ignores Spoiler readiness that settles after the details route changes', async () => {
        mountDetailsPage('spoiler-route-a');
        vi.spyOn(ApiClient, 'getItem').mockResolvedValue({ Type: 'Movie' });
        const addSpoilerBlurButton = vi.fn();
        JC.pluginConfig = { SpoilerBlurEnabled: true };
        JC.spoilerGuard = undefined;

        initializeDetailsPage();
        vi.advanceTimersByTime(100);
        await flushPromises();
        vi.advanceTimersByTime(100);
        await flushPromises();
        expect(addSpoilerBlurButton).not.toHaveBeenCalled();

        window.history.replaceState(null, '', '/web/index.html#/home');
        JC.spoilerGuard = { addSpoilerBlurButton } as unknown as typeof JC.spoilerGuard;
        publishSpoilerReady();
        await flushPromises();

        expect(addSpoilerBlurButton).not.toHaveBeenCalled();
    });

    it('clears a held Spoiler retry on identity reset and feature disposal', async () => {
        mountDetailsPage('spoiler-identity-a');
        vi.spyOn(ApiClient, 'getItem').mockResolvedValue({ Type: 'BoxSet' });
        const addSpoilerBlurButton = vi.fn();
        JC.pluginConfig = { SpoilerBlurEnabled: true };
        JC.spoilerGuard = undefined;

        initializeDetailsPage();
        vi.advanceTimersByTime(100);
        await flushPromises();
        vi.advanceTimersByTime(100);
        await flushPromises();
        expect(addSpoilerBlurButton).not.toHaveBeenCalled();

        JC.identity.transition('page-server-b', 'page-user-b', 'spoiler-readiness-identity');
        JC.spoilerGuard = { addSpoilerBlurButton } as unknown as typeof JC.spoilerGuard;
        publishSpoilerReady();
        await flushPromises();
        expect(addSpoilerBlurButton).not.toHaveBeenCalled();

        // Re-arm under B, then prove explicit feature disposal owns the same
        // cancellation boundary even without another identity transition.
        JC.spoilerGuard = undefined;
        window.history.replaceState(null, '', '/web/index.html#/details?id=spoiler-identity-b');
        document.body.innerHTML = '';
        resetDetailsViewTrackingForTests();
        mountDetailsPage('spoiler-identity-b');
        initializeDetailsPage();
        vi.advanceTimersByTime(100);
        await flushPromises();
        vi.advanceTimersByTime(100);
        await flushPromises();
        expect(addSpoilerBlurButton).not.toHaveBeenCalled();

        disposeInstall?.();
        disposeInstall = undefined;
        JC.spoilerGuard = { addSpoilerBlurButton } as unknown as typeof JC.spoilerGuard;
        publishSpoilerReady();
        await flushPromises();
        expect(addSpoilerBlurButton).not.toHaveBeenCalled();
    });

    it('uses the feature-scope fence for stale config or navigation generations', async () => {
        disposeInstall?.();
        let activationCurrent = true;
        disposeInstall = installDetailsPage(() => activationCurrent);
        mountDetailsPage('spoiler-generation');
        vi.spyOn(ApiClient, 'getItem').mockResolvedValue({ Type: 'Series' });
        const addSpoilerBlurButton = vi.fn();
        JC.pluginConfig = { SpoilerBlurEnabled: true };
        JC.spoilerGuard = undefined;

        initializeDetailsPage();
        vi.advanceTimersByTime(100);
        await flushPromises();
        vi.advanceTimersByTime(100);
        await flushPromises();
        expect(addSpoilerBlurButton).not.toHaveBeenCalled();

        activationCurrent = false;
        JC.spoilerGuard = { addSpoilerBlurButton } as unknown as typeof JC.spoilerGuard;
        publishSpoilerReady();
        await flushPromises();
        expect(addSpoilerBlurButton).not.toHaveBeenCalled();
    });
});
