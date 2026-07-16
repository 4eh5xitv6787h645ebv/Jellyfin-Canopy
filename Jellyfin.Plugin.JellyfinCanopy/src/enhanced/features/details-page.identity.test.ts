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
});
