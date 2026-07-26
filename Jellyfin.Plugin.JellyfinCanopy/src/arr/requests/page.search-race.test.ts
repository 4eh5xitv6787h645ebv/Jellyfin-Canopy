import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../arr-globals';
import type { ApiApi, LifecycleHandle } from '../../types/jc';
import type { PageDescriptor } from '../../enhanced/pages/types';

describe('Requests page search intent', () => {
    let plugin: ReturnType<typeof vi.fn>;
    let descriptor: PageDescriptor;
    let data: typeof import('./data');
    let handle: LifecycleHandle;
    let host: HTMLDivElement;
    let adoptionController: AbortController;
    let pendingSearch: {
        query: string;
        promise: Promise<unknown>;
        resolve: (value: unknown) => void;
    } | null;

    beforeEach(async () => {
        vi.resetModules();
        document.body.replaceChildren();
        JC.identity.transition('requests-search-server', 'requests-search-user', 'requests-search-start');
        JC.pluginConfig = {
            DownloadsPageEnabled: true,
            ShowDownloadsInRequests: true,
            DownloadsPagePollingEnabled: false,
            SeerrEnabled: false,
            DownloadsPageShowIssues: false,
        };
        JC.t = (key: string) => key;
        pendingSearch = null;
        plugin = vi.fn((path: string) => {
            if (path.startsWith('/arr/queue?')) {
                const query = new URLSearchParams(path.split('?')[1]).get('search') || '';
                if (pendingSearch?.query === query) return pendingSearch.promise;
                return Promise.resolve({
                    items: [],
                    history: [],
                    sources: [],
                    counts: { downloading: 0, processing: 0, history: 0 },
                    historyPage: 1,
                    historyPageSize: 20,
                    historyTotalItems: 0,
                    historyTotalPages: 1,
                });
            }
            if (path.startsWith('/arr/requests?')) {
                return Promise.resolve({
                    requests: [],
                    totalPages: 1,
                    canApproveRequests: false,
                });
            }
            return Promise.reject(new Error(`Unexpected request: ${path}`));
        });
        JC.core.api = { plugin } as unknown as ApiApi;

        const lifecycle = await import('../../core/lifecycle');
        handle = lifecycle.register('requests-search-race-test');
        ({ downloadsPageDescriptor: descriptor } = await import('./page'));
        data = await import('./data');

        host = document.createElement('div');
        document.body.appendChild(host);
        adoptionController = new AbortController();
        await descriptor.render({
            host,
            handle,
            signal: adoptionController.signal,
        });
        await vi.waitFor(() => {
            expect(data.state.downloadsHasSnapshot).toBe(true);
            expect(data.state.isLoading).toBe(false);
        });
    });

    afterEach(() => {
        adoptionController.abort();
        handle.teardown();
        descriptor.onHide?.();
        host.remove();
        vi.useRealTimers();
    });

    it('retires a pending input debounce when search is closed', async () => {
        vi.useFakeTimers();

        host.querySelector<HTMLButtonElement>('.jc-downloads-search-toggle')!.click();
        const input = host.querySelector<HTMLInputElement>('.jc-downloads-search-input')!;
        input.value = 'needle';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(data.state.searchDebounceTimer).not.toBeNull();

        host.querySelector<HTMLButtonElement>('.jc-downloads-search-toggle')!.click();
        expect(data.state.downloadsSearchVisible).toBe(false);
        expect(data.state.downloadsSearchQuery).toBe('');
        expect(data.state.searchDebounceTimer).toBeNull();

        await vi.advanceTimersByTimeAsync(300);

        const queueRequests = plugin.mock.calls
            .map(([path]) => String(path))
            .filter((path) => path.startsWith('/arr/queue?'));
        expect(queueRequests).toHaveLength(2);
        expect(queueRequests.some((path) => new URLSearchParams(path.split('?')[1]).has('search')))
            .toBe(false);
        expect(data.state.downloadsAppliedSearchQuery).toBe('');
    });

    it('does not restore an obsolete caret after a superseded search completes', async () => {
        vi.useFakeTimers();
        let resolveSearch!: (value: unknown) => void;
        const searchPromise = new Promise<unknown>((resolve) => {
            resolveSearch = resolve;
        });
        pendingSearch = {
            query: 'alpha',
            promise: searchPromise,
            resolve: resolveSearch,
        };

        host.querySelector<HTMLButtonElement>('.jc-downloads-search-toggle')!.click();
        let input = host.querySelector<HTMLInputElement>('.jc-downloads-search-input')!;
        input.focus();
        input.value = 'alpha';
        input.setSelectionRange(5, 5);
        input.dispatchEvent(new Event('input', { bubbles: true }));

        vi.advanceTimersByTime(300);
        await Promise.resolve();
        expect(plugin.mock.calls
            .map(([path]) => String(path))
            .some((path) => path.includes('search=alpha'))).toBe(true);

        input = host.querySelector<HTMLInputElement>('.jc-downloads-search-input')!;
        input.focus();
        input.value = 'alphabet';
        input.setSelectionRange(8, 8);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        // Keep B pending so A finishes in the exact debounce window the race targets.
        if (data.state.searchDebounceTimer) {
            clearTimeout(data.state.searchDebounceTimer);
            data.state.searchDebounceTimer = null;
        }

        pendingSearch.resolve({
            items: [],
            history: [],
            sources: [],
            counts: { downloading: 0, processing: 0, history: 0 },
            historyPage: 1,
            historyPageSize: 20,
            historyTotalItems: 0,
            historyTotalPages: 1,
        });
        await Promise.resolve();
        await Promise.resolve();
        await vi.runAllTimersAsync();

        const currentInput = host.querySelector<HTMLInputElement>('.jc-downloads-search-input')!;
        expect(currentInput.value).toBe('alphabet');
        expect(currentInput.selectionStart).toBe(8);
        expect(data.state.downloadsSearchQuery).toBe('alphabet');
        expect(data.state.downloadsAppliedSearchQuery).toBe('');
    });
});
