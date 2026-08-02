import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiApi, LifecycleHandle } from '../types/jc';
import { JC } from '../globals';
import { register } from '../core/lifecycle';
import { maintainerrPageDescriptor, maintainerrPageFacade } from './page';

function dashboard(): Record<string, unknown> {
    return {
        status: {
            ready: true,
            degraded: false,
            version: '3.18.0',
            jellyfinMode: true,
            capable: true,
            identityMatch: true,
        },
        collections: [
            {
                id: 1,
                title: 'Keep <script>alert(1)</script>',
                type: 'movie',
                isActive: true,
                mediaCount: 3,
                deleteAfterDays: 1,
                manualCollection: false,
                handledMediaAmount: 1,
                lastDurationInSeconds: 12,
                totalSizeBytes: 2048,
                handledMediaSizeBytes: 1024,
                href: 'https://maintainerr.example/collections/1',
            },
            {
                id: 2,
                title: 'Inactive television',
                type: 'show',
                isActive: false,
                mediaCount: 8,
                deleteAfterDays: 30,
                manualCollection: true,
                handledMediaAmount: 0,
                lastDurationInSeconds: 0,
                handledMediaSizeBytes: 0,
            },
        ],
        storage: {
            state: 'available',
            generatedAt: '2026-07-26T00:00:00.0000000+00:00',
            collectionSummary: {
                reclaimableCount: 3,
                activeSizeBytes: 2048,
                reclaimableSizedCount: 2,
                inactiveCount: 1,
                totalCollectionCount: 2,
                movieSizeBytes: 1,
                showSizeBytes: 2,
                seasonSizeBytes: 3,
                episodeSizeBytes: 4,
                reclaimableMovieCount: 1,
                reclaimableShowCount: 1,
                reclaimableSeasonCount: 1,
                reclaimableEpisodeCount: 1,
                upstreamSecretSentinel: 123,
            },
            cleanupTotals: {
                itemsHandled: 5,
                moviesHandled: 1,
                showsHandled: 1,
                seasonsHandled: 1,
                episodesHandled: 1,
                bytesHandled: 4096,
                movieBytesHandled: 1,
                showBytesHandled: 2,
                seasonBytesHandled: 3,
                episodeBytesHandled: 4,
            },
            reclaimableUsingFallback: true,
        },
        rules: {
            state: 'available',
            count: 4,
            processingQueue: false,
            executing: false,
            pendingCount: 2,
            queueCount: 1,
        },
        overlays: {
            state: 'available',
            status: 'idle',
        },
        links: {
            overview: 'https://maintainerr.example/overview',
            rules: 'https://maintainerr.example/rules',
            storageMetrics: 'https://maintainerr.example/storage-metrics',
        },
    };
}

describe('Maintainerr native page', () => {
    let host: HTMLElement;
    let handle: LifecycleHandle;
    let adoption: AbortController;

    beforeEach(() => {
        document.body.replaceChildren();
        JC.identity.transition('maintainerr-page-server', `user-${Math.random()}`, 'maintainerr-page-test');
        JC.pluginConfig = { MaintainerrEnabled: true, MaintainerrPageEnabled: true };
        JC.currentUser = { Policy: { IsAdministrator: true } };
        JC.t = (key: string) => key;
        host = document.createElement('div');
        document.body.appendChild(host);
        handle = register(`maintainerr-page-test-${Math.random()}`);
        adoption = new AbortController();
    });

    afterEach(() => {
        adoption.abort();
        handle.teardown();
        maintainerrPageDescriptor.onHide?.();
        host.remove();
        vi.restoreAllMocks();
    });

    it('denies rendering and requests for a non-administrator', () => {
        const plugin = vi.fn();
        JC.core.api = { plugin } as unknown as ApiApi;
        JC.currentUser = { Policy: { IsAdministrator: false } };

        void maintainerrPageDescriptor.render({ host, handle, signal: adoption.signal });

        expect(host.childElementCount).toBe(0);
        expect(plugin).not.toHaveBeenCalled();
    });

    it('accepts cancellation before upstream work starts and publishes no stale dashboard', async () => {
        let upstreamStarted = false;
        let requestSignal: AbortSignal | undefined;
        const plugin = vi.fn((
            _path: string,
            options?: { signal?: AbortSignal },
        ) => new Promise<unknown>((resolve, reject) => {
            requestSignal = options?.signal;
            requestSignal?.addEventListener('abort', () => {
                reject(new DOMException('canceled before upstream start', 'AbortError'));
            }, { once: true });
            queueMicrotask(() => {
                if (requestSignal?.aborted) return;
                upstreamStarted = true;
                resolve(dashboard());
            });
        }));
        JC.core.api = { plugin } as unknown as ApiApi;

        void maintainerrPageDescriptor.render({ host, handle, signal: adoption.signal });
        adoption.abort();
        await Promise.resolve();
        await Promise.resolve();

        expect(requestSignal?.aborted).toBe(true);
        expect(upstreamStarted).toBe(false);
        expect(host.querySelectorAll('.jc-maintainerr-collection')).toHaveLength(0);
        expect(host.textContent).not.toContain('Weekend cleanup');
        expect(host.querySelector('[role="alert"]')).toBeNull();
    });

    it('renders safe views, local controls, binary units, and modal focus lifecycle', async () => {
        const plugin = vi.fn((path: string) => {
            if (path === '/maintainerr/dashboard') return Promise.resolve(dashboard());
            if (path.startsWith('/maintainerr/collections/1/content?')) {
                return Promise.resolve({
                    page: 1,
                    size: 25,
                    totalSize: 1,
                    items: [{
                        id: 20,
                        title: '<img src=x onerror=alert(1)>',
                        type: 'movie',
                        href: '/collections/1',
                    }],
                });
            }
            return Promise.reject(new Error(`Unexpected request ${path}`));
        });
        JC.core.api = { plugin } as unknown as ApiApi;

        void maintainerrPageDescriptor.render({ host, handle, signal: adoption.signal });
        await vi.waitFor(() => expect(host.querySelectorAll('.jc-maintainerr-collection')).toHaveLength(2));

        expect(host.querySelector('.jc-maintainerr-warning')?.textContent).toContain('no built-in authentication');
        expect(host.textContent).toContain('2 KiB');
        expect(host.textContent).toContain('1 day retention');
        expect(host.textContent).toContain('30 days retention');
        expect(host.textContent).toContain('2 of 2 collections');
        const aggregateCards = host.querySelector('.jc-maintainerr-grid')?.textContent || '';
        expect(aggregateCards).toContain('Reclaimable collections3');
        expect(aggregateCards).toContain('Reclaimable storage2 KiB');
        expect(aggregateCards).toContain('Items handled5');
        expect(aggregateCards).toContain('Storage reclaimed4 KiB');
        expect(host.textContent).not.toContain('Active size');
        expect(host.textContent).not.toContain('Reclaimable items');
        expect(host.textContent).toContain('estimate');
        expect(host.textContent).not.toContain('upstreamSecretSentinel');
        expect(host.querySelectorAll('script')).toHaveLength(0);
        expect(host.textContent).toContain('<script>alert(1)</script>');

        const rulesTab = host.querySelector<HTMLButtonElement>('[data-view="rules"]')!;
        rulesTab.click();
        expect(rulesTab.isConnected).toBe(false);
        const selectedRulesTab = host.querySelector<HTMLButtonElement>('[data-view="rules"]')!;
        expect(selectedRulesTab.getAttribute('aria-selected')).toBe('true');
        expect(host.querySelector('#jc-maintainerr-rules-panel')?.textContent).toContain('Configured rules');
        expect(host.querySelector<HTMLAnchorElement>('#jc-maintainerr-rules-panel a')?.href)
            .toBe('https://maintainerr.example/rules');

        host.querySelector<HTMLButtonElement>('[data-view="collections"]')!.click();
        const filter = host.querySelector<HTMLSelectElement>(
            '[data-control="collection-filter"]',
        )!;
        filter.focus();
        filter.value = 'inactive';
        filter.dispatchEvent(new Event('change', { bubbles: true }));
        const focusedFilter = host.querySelector<HTMLSelectElement>(
            '[data-control="collection-filter"]',
        )!;
        expect(document.activeElement).toBe(focusedFilter);
        expect(host.querySelectorAll('.jc-maintainerr-collection')).toHaveLength(1);
        focusedFilter.value = 'all';
        focusedFilter.dispatchEvent(new Event('change', { bubbles: true }));
        expect(document.activeElement).toBe(host.querySelector(
            '[data-control="collection-filter"]',
        ));

        const sort = host.querySelector<HTMLSelectElement>(
            '[data-control="collection-sort"]',
        )!;
        sort.focus();
        sort.value = 'mediaCount';
        sort.dispatchEvent(new Event('change', { bubbles: true }));
        expect(document.activeElement).toBe(host.querySelector(
            '[data-control="collection-sort"]',
        ));

        const search = host.querySelector<HTMLInputElement>('[data-control="collection-search"]')!;
        search.focus();
        search.value = 'inactive';
        search.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            data: 'inactive',
            inputType: 'insertCompositionText',
            isComposing: true,
        }));
        expect(host.querySelector('[data-control="collection-search"]')).toBe(search);
        expect(document.activeElement).toBe(search);
        expect(host.querySelectorAll('.jc-maintainerr-collection')).toHaveLength(2);
        search.dispatchEvent(new CompositionEvent('compositionend', {
            bubbles: true,
            data: 'inactive',
        }));
        expect(host.querySelectorAll('.jc-maintainerr-collection')).toHaveLength(1);
        expect(host.textContent).toContain('Inactive television');
        expect(host.textContent).toContain('1 of 2 collections');

        const nextSearch = host.querySelector<HTMLInputElement>('[data-control="collection-search"]')!;
        nextSearch.value = '';
        nextSearch.dispatchEvent(new Event('input', { bubbles: true }));
        const open = host.querySelector<HTMLButtonElement>(
            '[data-action="open-collection"][data-collection-id="1"]',
        )!;
        open.focus();
        open.click();
        await vi.waitFor(() => {
            expect(host.querySelector('.jc-maintainerr-content-title')?.textContent)
                .toBe('<img src=x onerror=alert(1)>');
        });
        const close = host.querySelector<HTMLButtonElement>('[data-action="close-collection"]')!;
        expect(document.activeElement).toBe(close);
        const lastFocusable = host.querySelector<HTMLAnchorElement>('.jc-maintainerr-content-item a')!;
        lastFocusable.focus();
        lastFocusable.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
        expect(document.activeElement).toBe(close);
        close.click();
        expect(document.activeElement).toBe(host.querySelector(
            '[data-action="open-collection"][data-collection-id="1"]',
        ));
    });

    it('uses singular collection grammar at one and localizes media enums in cards, search, and content', async () => {
        const payload = dashboard();
        payload.collections = (payload.collections as unknown[]).slice(0, 1);
        const translations: Record<string, string> = {
            maintainerr_collection_filtered_count_one: '{count} von {total} Sammlung',
            maintainerr_media_type_movie: 'Film',
            maintainerr_media_type_show: 'Fernsehserie',
            maintainerr_media_type_season: 'Staffel',
            maintainerr_media_type_episode: 'Folge',
        };
        JC.t = (key: string, params?: Record<string, unknown>) => {
            const template = translations[key] || key;
            return Object.entries(params || {}).reduce(
                (value, [name, replacement]) => value.replace(
                    new RegExp(`\\{${name}\\}`, 'g'),
                    String(replacement),
                ),
                template,
            );
        };
        const plugin = vi.fn((path: string) => {
            if (path === '/maintainerr/dashboard') return Promise.resolve(payload);
            if (path.startsWith('/maintainerr/collections/1/content?')) {
                return Promise.resolve({
                    page: 1,
                    size: 25,
                    totalSize: 1,
                    items: [{
                        id: 30,
                        title: 'Lokalisierte Folge',
                        type: 'episode',
                    }],
                });
            }
            return Promise.reject(new Error(`Unexpected request ${path}`));
        });
        JC.core.api = { plugin } as unknown as ApiApi;

        void maintainerrPageDescriptor.render({ host, handle, signal: adoption.signal });
        await vi.waitFor(() => expect(host.querySelectorAll('.jc-maintainerr-collection')).toHaveLength(1));
        expect(host.textContent).toContain('1 von 1 Sammlung');
        expect(host.querySelector('.jc-maintainerr-collection-meta .jc-maintainerr-chip')?.textContent)
            .toBe('Film');

        const search = host.querySelector<HTMLInputElement>('[data-control="collection-search"]')!;
        search.value = 'Film';
        search.dispatchEvent(new InputEvent('input', { bubbles: true }));
        expect(host.querySelectorAll('.jc-maintainerr-collection')).toHaveLength(1);
        const rawSearch = host.querySelector<HTMLInputElement>('[data-control="collection-search"]')!;
        rawSearch.value = 'movie';
        rawSearch.dispatchEvent(new InputEvent('input', { bubbles: true }));
        expect(host.querySelectorAll('.jc-maintainerr-collection')).toHaveLength(1);
        host.querySelector<HTMLButtonElement>('[data-action="open-collection"]')!.click();
        await vi.waitFor(() => expect(host.querySelector('.jc-maintainerr-content-item .jc-maintainerr-chip')
            ?.textContent).toBe('Folge'));
    });

    it('coalesces forced refreshes in flight and permits the next refresh after settlement', async () => {
        let refreshResolve!: (value: unknown) => void;
        let refreshPromise = new Promise<unknown>((resolve) => { refreshResolve = resolve; });
        const plugin = vi.fn((path: string) => {
            if (path === '/maintainerr/dashboard') return Promise.resolve(dashboard());
            if (path === '/maintainerr/dashboard?refresh=true') return refreshPromise;
            return Promise.reject(new Error(`Unexpected request ${path}`));
        });
        JC.core.api = { plugin } as unknown as ApiApi;
        void maintainerrPageDescriptor.render({ host, handle, signal: adoption.signal });
        await vi.waitFor(() => expect(host.querySelector('[data-action="refresh"]')).not.toBeNull());
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledWith(
            '/maintainerr/dashboard',
            expect.objectContaining({ skipCache: true, skipRetry: true, timeoutMs: 15_000 }),
        ));

        const initialRefresh = host.querySelector<HTMLButtonElement>('[data-action="refresh"]')!;
        initialRefresh.focus();
        initialRefresh.click();
        const first = maintainerrPageFacade.refresh();
        const coalesced = maintainerrPageFacade.refresh();
        expect(plugin.mock.calls.filter(([path]) => path === '/maintainerr/dashboard?refresh=true')).toHaveLength(1);
        const refreshingButton = host.querySelector<HTMLButtonElement>('[data-action="refresh"]')!;
        expect(refreshingButton.disabled).toBe(false);
        expect(refreshingButton.getAttribute('aria-disabled')).toBe('true');
        expect(refreshingButton.getAttribute('aria-busy')).toBe('true');
        expect(refreshingButton.textContent).toContain('Refreshing…');
        expect(document.activeElement).toBe(refreshingButton);
        expect(host.querySelector<HTMLElement>('[role="status"]')?.textContent).toContain('Refreshing…');
        refreshResolve(dashboard());
        await Promise.all([first, coalesced]);
        expect(host.querySelector<HTMLButtonElement>('[data-action="refresh"]')?.getAttribute('aria-busy'))
            .toBe('false');
        expect(host.querySelector<HTMLButtonElement>('[data-action="refresh"]')?.textContent)
            .toContain('Refresh');
        expect(host.querySelector<HTMLButtonElement>('[data-action="refresh"]')?.getAttribute('aria-disabled'))
            .toBe('false');
        expect(document.activeElement).toBe(host.querySelector('[data-action="refresh"]'));

        refreshPromise = Promise.resolve(dashboard());
        await maintainerrPageFacade.refresh();
        expect(plugin.mock.calls.filter(([path]) => path === '/maintainerr/dashboard?refresh=true')).toHaveLength(2);
    });

    it('renders independent section failures without turning them into zero or empty success', async () => {
        const payload = dashboard();
        payload.storage = { state: 'unsupported', error: 'unsupported' };
        payload.rules = {
            state: 'partial',
            error: 'timeout',
            count: 0,
        };
        payload.overlays = { state: 'unavailable', error: 'timeout' };
        JC.core.api = {
            plugin: vi.fn().mockResolvedValue(payload),
        } as unknown as ApiApi;

        void maintainerrPageDescriptor.render({ host, handle, signal: adoption.signal });
        await vi.waitFor(() => expect(host.textContent).toContain('not supported'));

        expect(host.textContent).toContain('temporarily unavailable');
        expect(host.textContent).not.toContain('NaN');
        host.querySelector<HTMLButtonElement>('[data-view="rules"]')!.click();
        const rulesPanel = host.querySelector('#jc-maintainerr-rules-panel')!;
        expect(rulesPanel.textContent).toContain('Some data');
        expect(rulesPanel.textContent).toContain('Configured rules');
        expect(rulesPanel.textContent).not.toContain('Queued');
    });

    it.each([
        ['invalid_configuration', 'not configured correctly'],
        ['invalid_request', 'not configured correctly'],
        ['blocked_target', 'blocked the configured Maintainerr destination'],
        ['response_too_large', 'exceeded Canopy’s safe size limit'],
        ['too_large', 'too many records'],
        ['malformed_body', 'unexpected format'],
        ['malformed_response', 'unexpected format'],
        ['configuration_changed', 'settings changed during the request'],
        ['identity_mismatch', 'identity does not match'],
        ['wrong_service', 'not Maintainerr 3.18'],
        ['not_ready', 'is not ready'],
        ['throttled', 'temporarily limited'],
        ['upstream_error', 'could not complete the read-only request'],
        ['unsupported', 'not supported'],
        ['redirect', 'redirected the request'],
        ['canceled', 'request was canceled'],
        ['timeout', 'request timed out'],
        ['disabled', 'integration or this feature is disabled'],
        ['unavailable', 'temporarily unavailable'],
    ])('humanizes the %s server code without exposing raw error text', async (code, expected) => {
        const failure = Object.assign(new Error('raw upstream detail'), {
            responseJSON: {
                error: code,
                message: 'http://private-maintainerr.internal/api',
            },
        });
        JC.core.api = {
            plugin: vi.fn().mockRejectedValue(failure),
        } as unknown as ApiApi;

        void maintainerrPageDescriptor.render({ host, handle, signal: adoption.signal });
        await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent)
            .toContain(expected));
        expect(host.querySelector('[role="alert"]')?.textContent).not.toBe(code);
        if (code.includes('_')) expect(host.textContent).not.toContain(code);
        expect(host.textContent).not.toContain('private-maintainerr');
    });

    it('humanizes allowlisted dashboard and collection failures without showing machine codes', async () => {
        const dashboardFailure = Object.assign(new Error('raw upstream detail'), {
            responseJSON: {
                error: 'wrong_service',
                message: 'http://private-maintainerr.internal/api',
            },
        });
        JC.core.api = {
            plugin: vi.fn().mockRejectedValue(dashboardFailure),
        } as unknown as ApiApi;

        void maintainerrPageDescriptor.render({ host, handle, signal: adoption.signal });
        await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent)
            .toContain('not Maintainerr 3.18'));
        expect(host.textContent).not.toContain('wrong_service');
        expect(host.textContent).not.toContain('private-maintainerr');

        maintainerrPageDescriptor.onHide?.();
        handle.teardown();
        host.replaceChildren();
        handle = register(`maintainerr-page-error-test-${Math.random()}`);
        adoption.abort();
        adoption = new AbortController();
        const collectionFailure = Object.assign(new Error('oversize'), {
            responseJSON: { error: 'too_large' },
        });
        JC.core.api = {
            plugin: vi.fn((path: string) => path === '/maintainerr/dashboard'
                ? Promise.resolve(dashboard())
                : Promise.reject(collectionFailure)),
        } as unknown as ApiApi;

        void maintainerrPageDescriptor.render({ host, handle, signal: adoption.signal });
        await vi.waitFor(() => expect(host.querySelectorAll('.jc-maintainerr-collection')).toHaveLength(2));
        host.querySelector<HTMLButtonElement>(
            '[data-action="open-collection"][data-collection-id="1"]',
        )!.click();
        await vi.waitFor(() => expect(host.querySelector('.jc-maintainerr-dialog [role="alert"]')?.textContent)
            .toContain('too many records'));
        expect(host.textContent).not.toContain('too_large');
    });
});
