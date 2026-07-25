import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import { closeArrSearchModals } from './modal';
import { openManage } from './manage-modal';

const originalApi = JC.core.api;
const originalConfig = JC.pluginConfig;
const originalTranslation = JC.t;
const visibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');

const context = {
    kind: 'series',
    service: 'sonarr',
    name: 'Resolved Jellyfin Show',
    seasonNumber: null,
    episodeNumber: null,
    serviceConfigured: true,
    supportsInteractive: false,
    canManage: true,
    targets: [{
        instanceName: 'TV',
        service: 'sonarr',
        arrId: 12,
        episodeId: null,
        monitored: true,
        hasFile: false,
    }],
    addableInstances: [],
    errors: [],
};

const partialStatus = {
    items: [{
        instanceName: 'TV',
        service: 'sonarr',
        lifecycle: 'waitingForImport',
        section: 'processing',
        reasonCode: 'transitionPending',
        progress: 100,
        timeRemaining: null,
        // A forward-incompatible or compromised payload must not regain the removed raw-title UI.
        title: 'PRIVATE.DOWNLOADER.RELEASE.NAME',
    }],
    errors: [{ instanceName: 'Backup TV', reason: 'page 1: network error' }],
    isComplete: false,
};

function setVisibility(value: 'visible' | 'hidden'): void {
    Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value,
    });
    document.dispatchEvent(new Event('visibilitychange'));
}

function installApi(
    status: (options: { signal?: AbortSignal }) => Promise<unknown>
): ReturnType<typeof vi.fn> {
    const plugin = vi.fn((path: string, options?: { signal?: AbortSignal }) => {
        if (path.startsWith('/arr/search/context')) return Promise.resolve(context);
        if (path.startsWith('/arr/search/status')) return status(options || {});
        return Promise.reject(new Error(`Unexpected request: ${path}`));
    });
    JC.core.api = { plugin } as unknown as NonNullable<typeof JC.core.api>;
    return plugin;
}

describe('arr Manage normalized lifecycle status', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        JC.identity.transition('test-server-id', 'test-user-id', 'manage-lifecycle-test');
        JC.pluginConfig = { DownloadsPageEnabled: true };
        JC.t = (key: string) => key;
        setVisibility('visible');
    });

    afterEach(() => {
        closeArrSearchModals();
        vi.useRealTimers();
        JC.core.api = originalApi;
        JC.pluginConfig = originalConfig;
        JC.t = originalTranslation;
        if (visibilityDescriptor) {
            Object.defineProperty(document, 'visibilityState', visibilityDescriptor);
        } else {
            Reflect.deleteProperty(document, 'visibilityState');
        }
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    it('renders context-owned media text, localized lifecycle reasons, partial errors, and progress semantics', async () => {
        installApi(() => Promise.resolve(partialStatus));

        await openManage('item-1');

        const modal = document.querySelector('.jc-arr-modal')!;
        expect(modal.textContent).toContain('Resolved Jellyfin Show');
        expect(modal.textContent).not.toContain('PRIVATE.DOWNLOADER.RELEASE.NAME');
        expect(modal.textContent).toContain('downloads_tab_processing');
        expect(modal.textContent).toContain('downloads_lifecycle_waiting_for_import');
        expect(modal.textContent).toContain('downloads_reason_transition_pending');
        expect(modal.textContent).toContain('downloads_snapshot_degraded');
        expect(modal.textContent).toContain('Backup TV: page 1: network error');

        const progress = modal.querySelector('[role="progressbar"]')!;
        expect(progress.getAttribute('aria-valuemin')).toBe('0');
        expect(progress.getAttribute('aria-valuemax')).toBe('100');
        expect(progress.getAttribute('aria-valuenow')).toBe('100');
        expect(progress.getAttribute('aria-label')).toBe('downloads_transfer_progress');
    });

    it('does not fabricate zero transfer progress when ARR supplies no usable size', async () => {
        installApi(() => Promise.resolve({
            ...partialStatus,
            items: [{
                ...partialStatus.items[0],
                progress: null,
            }],
        }));

        await openManage('item-unknown-progress');

        const modal = document.querySelector('.jc-arr-modal')!;
        expect(modal.textContent).toContain('downloads_lifecycle_waiting_for_import');
        expect(modal.querySelector('[role="progressbar"]')).toBeNull();
        expect(modal.textContent).not.toContain('0%');
    });

    it('pauses while hidden, aborts an active status read on close, and stops its timer', async () => {
        vi.useFakeTimers();
        let statusCalls = 0;
        let activeSignal: AbortSignal | undefined;
        const plugin = installApi(({ signal }) => {
            statusCalls += 1;
            if (statusCalls === 1) return Promise.resolve(partialStatus);
            activeSignal = signal;
            return new Promise((_resolve, reject) => {
                signal?.addEventListener(
                    'abort',
                    () => reject(new DOMException('Aborted', 'AbortError')),
                    { once: true }
                );
            });
        });

        await openManage('item-2');
        expect(statusCalls).toBe(1);

        setVisibility('hidden');
        await vi.advanceTimersByTimeAsync(60_000);
        expect(statusCalls).toBe(1);

        setVisibility('visible');
        await vi.advanceTimersByTimeAsync(0);
        expect(statusCalls).toBe(2);
        expect(activeSignal?.aborted).toBe(false);

        document.querySelector<HTMLButtonElement>('.jc-arr-modal-close')!.click();
        expect(activeSignal?.aborted).toBe(true);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(statusCalls).toBe(2);
        expect(plugin.mock.calls.filter(([path]) =>
            String(path).startsWith('/arr/search/status'))).toHaveLength(2);
    });

    it('keeps the last successful rows visible when a poll transport fails', async () => {
        vi.useFakeTimers();
        let statusCalls = 0;
        installApi(() => {
            statusCalls += 1;
            return statusCalls === 1
                ? Promise.resolve(partialStatus)
                : Promise.reject(new Error('network unavailable'));
        });

        await openManage('item-transport');
        await vi.advanceTimersByTimeAsync(10_000);

        const modalText = document.querySelector('.jc-arr-modal')!.textContent;
        expect(statusCalls).toBe(2);
        expect(modalText).toContain('Resolved Jellyfin Show');
        expect(modalText).toContain('downloads_lifecycle_waiting_for_import');
        expect(modalText).toContain('downloads_snapshot_refresh_failed');
    });

    it('caps the lifetime polling budget for one modal load', async () => {
        vi.useFakeTimers();
        let statusCalls = 0;
        installApi(() => {
            statusCalls += 1;
            return Promise.resolve(partialStatus);
        });

        await openManage('item-3');
        await vi.advanceTimersByTimeAsync(20 * 60_000);
        expect(statusCalls).toBe(61);

        await vi.advanceTimersByTimeAsync(20 * 60_000);
        expect(statusCalls).toBe(61);
    });
});
