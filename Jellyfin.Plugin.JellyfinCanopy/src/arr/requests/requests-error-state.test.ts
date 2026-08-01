// Unit tests for the Requests-page error state (CRIT-2 / W4-ERR-1, W4-ERR-2).
//
// A backend failure (e.g. the requests proxy's 502 when Seerr is unreachable)
// must drive an explicit ERROR state, not the "No requests found" empty state,
// and a total downloads-fetch failure must toast once instead of silently
// showing "No active downloads".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationOptions } from '../../types/jc';
// ui-kit installs the real JC.escapeHtml (the setup stub is a no-op) which the
// render modules capture at import.
import '../../core/ui-kit';

const visibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');

interface HttpErrorLike extends Error { status?: number; responseJSON?: unknown; }
function httpError(status: number, message: string): HttpErrorLike {
    const e = new Error(`HTTP ${status}`) as HttpErrorLike;
    e.status = status;
    e.responseJSON = { message };
    return e;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve!: (value: T) => void;
    return {
        promise: new Promise<T>((done) => {
            resolve = done;
        }),
        resolve,
    };
}

function downloadEnvelope(
    id: string,
    title: string,
    options: {
        stale?: boolean;
        sourceState?: 'fresh' | 'stale' | 'unavailable' | 'incomplete' | 'configuration';
        capturedAt?: string | null;
        generatedAt?: string;
    } = {}
): Record<string, unknown> {
    const stale = options.stale === true;
    const generatedAt = options.generatedAt ?? new Date(Date.now()).toISOString();
    const capturedAt = Object.prototype.hasOwnProperty.call(options, 'capturedAt')
        ? options.capturedAt
        : generatedAt;
    return {
        items: [{
            id,
            source: 'Sonarr',
            instanceId: 'sonarr-1',
            instanceName: 'Main Sonarr',
            title,
            subtitle: null,
            mediaType: 'episode',
            seasonNumber: 1,
            episodeNumber: 1,
            section: 'downloading',
            lifecycle: 'downloading',
            progress: 25,
            timeRemaining: '00:12:00',
            occurredAt: null,
            stale,
            reasonCode: null,
            terminal: false,
            groupCount: 1,
            importedCount: null,
            expectedCount: null,
            partial: false,
            provenance: null,
            jellyfinItemId: null,
            availability: 'unknown',
        }],
        history: [],
        sources: [{
            source: 'Sonarr',
            instanceId: 'sonarr-1',
            instanceName: 'Main Sonarr',
            state: options.sourceState ?? (stale ? 'stale' : 'fresh'),
            capturedAt,
        }],
        stale,
        counts: { downloading: 1, processing: 0, history: 0 },
        generatedAt,
        historyPage: 1,
        historyPageSize: 20,
        historyTotalItems: 0,
        historyTotalPages: 1,
    };
}

function mixedSourceEnvelope(): Record<string, unknown> {
    const stale = downloadEnvelope(
        'activity-stale-a',
        'Stale Sonarr title',
        {
            stale: true,
            sourceState: 'stale',
            capturedAt: '2026-07-25T11:56:00Z',
            generatedAt: '2026-07-25T12:00:00Z',
        }
    );
    const fresh = downloadEnvelope(
        'activity-fresh-b',
        'Fresh Radarr title',
        { generatedAt: '2026-07-25T12:00:00Z' }
    );
    const freshItem = {
        ...(fresh.items as Record<string, unknown>[])[0],
        source: 'Radarr',
        instanceId: 'radarr-1',
        instanceName: 'Main Radarr',
    };
    const freshSource = {
        ...(fresh.sources as Record<string, unknown>[])[0],
        source: 'Radarr',
        instanceId: 'radarr-1',
        instanceName: 'Main Radarr',
    };
    return {
        ...stale,
        items: [
            ...(stale.items as Record<string, unknown>[]),
            freshItem,
        ],
        sources: [
            ...(stale.sources as Record<string, unknown>[]),
            freshSource,
        ],
        degraded: true,
        stale: true,
        counts: { downloading: 2, processing: 0, history: 0 },
    };
}

describe('requests page error state', () => {
    let plugin: ReturnType<typeof vi.fn>;
    let toast: ReturnType<typeof vi.fn>;
    let notify: ReturnType<typeof vi.fn<(options: NotificationOptions) => void>>;
    let data: typeof import('./data');
    let render: typeof import('./render');

    beforeEach(async () => {
        vi.resetModules();
        document.body.innerHTML = '';
        plugin = vi.fn();
        toast = vi.fn();
        notify = vi.fn<(options: NotificationOptions) => void>();
        const JC = window.JellyfinCanopy as unknown as Record<string, unknown>;
        JC.core = { api: { plugin }, ui: { notify } };
        JC.pluginConfig = { SeerrEnabled: true, ShowDownloadsInRequests: true };
        JC.t = (k: string) => k;
        JC.toast = toast;
        // Import AFTER JC.core.api is set — data.ts captures `JC.core.api` at eval.
        data = await import('./data');
        render = await import('./render');
    });

    afterEach(() => {
        data.resetRequestsIdentityState();
        render.setActiveContainer(null);
        vi.useRealTimers();
        if (visibilityDescriptor) {
            Object.defineProperty(document, 'visibilityState', visibilityDescriptor);
        } else {
            Reflect.deleteProperty(document, 'visibilityState');
        }
    });

    it('fetchRequests flags requestsError on a structured 502 and renders the error state', async () => {
        plugin.mockRejectedValue(httpError(502, 'Seerr unreachable'));

        await data.fetchRequests();

        expect(data.state.requestsError).toBe(true);
        expect(data.state.requests.length).toBe(0);

        data.state.isLoading = false;
        const container = document.createElement('div');
        document.body.appendChild(container);
        window.JellyfinCanopy.identity.own(container);
        render.setActiveContainer(container);
        render.renderPage();
        render.setActiveContainer(null);

        expect(container.innerHTML).toContain('requests_load_error');
        expect(container.innerHTML).not.toContain('requests_no_requests_found');
    });

    it('a successful fetch clears requestsError so the empty state can show again', async () => {
        data.state.requestsError = true;
        plugin.mockResolvedValue({ requests: [], totalPages: 1 });

        await data.fetchRequests();

        expect(data.state.requestsError).toBe(false);

        data.state.isLoading = false;
        const container = document.createElement('div');
        document.body.appendChild(container);
        window.JellyfinCanopy.identity.own(container);
        render.setActiveContainer(container);
        render.renderPage();
        render.setActiveContainer(null);

        expect(container.innerHTML).toContain('requests_no_requests_found');
        expect(container.innerHTML).not.toContain('requests_load_error');
    });

    it('a first downloads-fetch failure renders an explicit error, never an empty queue', async () => {
        plugin.mockRejectedValue(new Error('network down'));

        await data.fetchDownloads();

        expect(data.state.downloads.length).toBe(0);
        expect(data.state.downloadsError).toBe(true);
        expect(data.state.downloadsStale).toBe(true);
        expect(data.state.downloadsHasSnapshot).toBe(false);
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0][0]).toMatchObject({
            message: 'downloads_load_error',
            severity: 'error',
            dedupeKey: 'requests:downloads-total-failure',
        });
        expect(toast).not.toHaveBeenCalled();

        const container = document.createElement('div');
        document.body.appendChild(container);
        window.JellyfinCanopy.identity.own(container);
        render.setActiveContainer(container);
        render.renderPage();
        render.setActiveContainer(null);

        expect(container.innerHTML).toContain('downloads_load_error');
        expect(container.innerHTML).not.toContain('downloads_empty_downloading');
        expect(container.querySelector('[role="alert"]')).not.toBeNull();
    });

    it('retains and visibly marks the last successful snapshot after refresh failure', async () => {
        plugin
            .mockResolvedValueOnce(downloadEnvelope('activity-1', 'Retained title'))
            .mockRejectedValueOnce(new Error('refresh unavailable'));

        await data.fetchDownloads();
        await data.fetchDownloads();

        expect(data.state.downloads).toHaveLength(1);
        expect(data.state.downloads[0]?.title).toBe('Retained title');
        expect(data.state.downloadsHasSnapshot).toBe(true);
        expect(data.state.downloadsError).toBe(true);
        expect(data.state.downloadsDegraded).toBe(true);
        expect(data.state.downloadsStale).toBe(true);

        const container = document.createElement('div');
        document.body.appendChild(container);
        window.JellyfinCanopy.identity.own(container);
        render.setActiveContainer(container);
        render.renderPage();
        render.setActiveContainer(null);

        expect(container.textContent).toContain('Retained title');
        expect(container.innerHTML).toContain('downloads_snapshot_refresh_failed');
        expect(container.querySelector('.jc-downloads-health')).not.toBeNull();
    });

    it('expires a retained failed-refresh snapshot after the fixed five-minute bound', async () => {
        vi.useFakeTimers();
        plugin
            .mockResolvedValueOnce(downloadEnvelope('activity-expiring', 'Expiring title'))
            .mockRejectedValueOnce(new Error('refresh unavailable'));

        await data.fetchDownloads();
        await data.fetchDownloads();

        expect(data.state.downloadsHasSnapshot).toBe(true);
        expect(data.state.downloads[0]?.title).toBe('Expiring title');
        expect(vi.getTimerCount()).toBe(1);

        await vi.advanceTimersByTimeAsync(data.DOWNLOADS_SNAPSHOT_RETENTION_MS - 1);
        expect(data.state.downloadsHasSnapshot).toBe(true);

        await vi.advanceTimersByTimeAsync(1);
        expect(data.state.downloads).toEqual([]);
        expect(data.state.downloadHistory).toEqual([]);
        expect(data.state.downloadSources).toEqual([]);
        expect(data.state.downloadsHasSnapshot).toBe(false);
        expect(data.state.downloadsError).toBe(true);
        expect(data.state.downloadsDegraded).toBe(true);
        expect(data.state.downloadsStale).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('expires a successful server-stale snapshot while polling is disabled and visibility-paused', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-25T12:00:00Z'));
        Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            value: 'hidden',
        });
        (window.JellyfinCanopy.pluginConfig as Record<string, unknown>)
            .DownloadsPagePollingEnabled = false;
        plugin.mockResolvedValue(downloadEnvelope(
            'activity-server-stale',
            'Server stale title',
            { stale: true, sourceState: 'stale' }
        ));

        await data.fetchDownloads();

        expect(data.state.downloadsHasSnapshot).toBe(true);
        expect(data.state.downloadsError).toBe(false);
        expect(data.state.downloadsStale).toBe(true);
        expect(vi.getTimerCount()).toBe(1);

        await vi.advanceTimersByTimeAsync(data.DOWNLOADS_SNAPSHOT_RETENTION_MS);

        expect(data.state.downloads).toEqual([]);
        expect(data.state.downloadHistory).toEqual([]);
        expect(data.state.downloadSources).toEqual([
            expect.objectContaining({ state: 'unavailable', capturedAt: null }),
        ]);
        expect(data.state.downloadsHasSnapshot).toBe(false);
        expect(data.state.downloadsError).toBe(true);
        expect(data.state.downloadsDegraded).toBe(true);
        expect(data.state.downloadsStale).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('inherits an aged server-stale capture instead of granting a new five-minute lease', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-25T12:00:00Z'));
        plugin.mockResolvedValue(downloadEnvelope(
            'activity-aged-server-stale',
            'Aged stale title',
            {
                stale: true,
                sourceState: 'stale',
                capturedAt: '2026-07-25T11:56:00Z',
                generatedAt: '2026-07-25T12:00:00Z',
            }
        ));

        await data.fetchDownloads();

        await vi.advanceTimersByTimeAsync(59_999);
        expect(data.state.downloadsHasSnapshot).toBe(true);

        await vi.advanceTimersByTimeAsync(1);
        expect(data.state.downloadsHasSnapshot).toBe(false);
        expect(data.state.downloadsError).toBe(true);
    });

    it('expires only an aged stale source while retaining a fresh peer', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-25T12:00:00Z'));
        plugin.mockResolvedValue(mixedSourceEnvelope());

        await data.fetchDownloads();
        expect(data.state.downloads).toHaveLength(2);

        await vi.advanceTimersByTimeAsync(60_000);

        expect(data.state.downloads.map((item) => item.title))
            .toEqual(['Fresh Radarr title']);
        expect(data.state.downloadSources).toEqual([
            expect.objectContaining({
                source: 'Sonarr',
                state: 'unavailable',
                capturedAt: null,
            }),
            expect.objectContaining({ source: 'Radarr', state: 'fresh' }),
        ]);
        expect(data.state.downloadsHasSnapshot).toBe(true);
        expect(data.state.downloadsCounts.downloading).toBe(1);
        expect(data.state.downloadsError).toBe(true);
        expect(data.state.downloadsDegraded).toBe(true);
        expect(data.state.downloadsStale).toBe(false);
        expect(data.state.historyTruncated).toBe(true);
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(
            data.DOWNLOADS_SNAPSHOT_RETENTION_MS - 60_000
        );
        expect(vi.getTimerCount()).toBe(0);
    });

    it('measures stale-source and handoff leases from request start, not receipt', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-25T12:00:00Z'));
        const envelope = mixedSourceEnvelope();
        const freshHandoff = (envelope.items as Record<string, unknown>[])[1];
        freshHandoff.stale = true;
        const held = deferred<unknown>();
        plugin.mockReturnValueOnce(held.promise);

        const pending = data.fetchDownloads();
        await vi.advanceTimersByTimeAsync(30_000);
        held.resolve(envelope);
        await pending;

        expect(data.state.downloads).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(29_999);
        expect(data.state.downloads).toHaveLength(2);

        await vi.advanceTimersByTimeAsync(1);
        expect(data.state.downloads.map((item) => item.title))
            .toEqual(['Fresh Radarr title']);

        await vi.advanceTimersByTimeAsync(4 * 60_000 - 1);
        expect(data.state.downloads).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(data.state.downloads).toEqual([]);
        expect(data.state.downloadsHasSnapshot).toBe(true);
    });

    it('marks a retained page-N history slice incomplete after selective expiry', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-25T12:00:00Z'));
        const envelope = mixedSourceEnvelope();
        envelope.history = (envelope.items as Record<string, unknown>[]).map((item) => ({
            ...item,
            section: 'history',
            lifecycle: 'imported',
            terminal: true,
        }));
        envelope.items = [];
        envelope.counts = { downloading: 0, processing: 0, history: 45 };
        envelope.historyPage = 3;
        envelope.historyPageSize = 20;
        envelope.historyTotalItems = 45;
        envelope.historyTotalPages = 3;
        plugin.mockResolvedValue(envelope);
        data.state.historyPage = 3;

        await data.fetchDownloads();
        await vi.advanceTimersByTimeAsync(60_000);

        expect(data.state.downloadHistory.map((item) => item.title))
            .toEqual(['Fresh Radarr title']);
        expect(data.state.historyPage).toBe(1);
        expect(data.state.historyAppliedPage).toBe(1);
        expect(data.state.historyTotalItems).toBe(1);
        expect(data.state.historyTotalPages).toBe(1);
        expect(data.state.downloadsCounts.history).toBe(1);
        expect(data.state.historyTruncated).toBe(true);
    });

    it.each([
        'unavailable',
        'incomplete',
        'configuration',
    ] as const)(
        'invalidates off-page history totals when an aged %s server scope expires',
        async (sourceState) => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-07-25T12:00:00Z'));
            const envelope = mixedSourceEnvelope();
            const freshItem = (envelope.items as Record<string, unknown>[])[1];
            envelope.items = [];
            envelope.history = [{
                ...freshItem,
                section: 'history',
                lifecycle: 'imported',
                terminal: true,
            }];
            envelope.counts = { downloading: 0, processing: 0, history: 101 };
            envelope.historyPage = 3;
            envelope.historyPageSize = 20;
            envelope.historyTotalItems = 101;
            envelope.historyTotalPages = 6;
            (envelope.sources as Record<string, unknown>[])[0] = {
                ...(envelope.sources as Record<string, unknown>[])[0],
                state: sourceState,
            };
            plugin.mockResolvedValue(envelope);
            data.state.historyPage = 3;

            await data.fetchDownloads();
            await vi.advanceTimersByTimeAsync(60_000);

            expect(data.state.downloadHistory).toHaveLength(1);
            expect(data.state.downloadHistory[0]?.title).toBe('Fresh Radarr title');
            expect(data.state.historyPage).toBe(1);
            expect(data.state.historyTotalItems).toBe(1);
            expect(data.state.historyTotalPages).toBe(1);
            expect(data.state.downloadsCounts.history).toBe(1);
            expect(data.state.historyTruncated).toBe(true);
            expect(data.state.downloadsActiveTruncated).toBe(true);
            expect(data.state.downloadSources[0]).toEqual(
                expect.objectContaining({ state: sourceState, capturedAt: null })
            );
        }
    );

    it('bounds stale off-page metadata without discarding healthy visible rows', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-25T12:00:00Z'));
        const envelope = downloadEnvelope('visible-fresh', 'Visible fresh title');
        envelope.stale = true;
        envelope.counts = { downloading: 1, processing: 0, history: 101 };
        envelope.historyPage = 3;
        envelope.historyTotalItems = 101;
        envelope.historyTotalPages = 6;
        plugin.mockResolvedValue(envelope);
        data.state.historyPage = 3;

        await data.fetchDownloads();
        expect(data.state.downloadsCounts.history).toBe(101);
        expect(data.state.downloadsStale).toBe(true);

        await vi.advanceTimersByTimeAsync(data.DOWNLOADS_SNAPSHOT_RETENTION_MS);

        expect(data.state.downloads.map((item) => item.id)).toEqual(['visible-fresh']);
        expect(data.state.downloadsCounts).toEqual({
            downloading: 1,
            processing: 0,
            history: 0,
        });
        expect(data.state.historyPage).toBe(1);
        expect(data.state.historyTotalItems).toBe(0);
        expect(data.state.historyTotalPages).toBe(1);
        expect(data.state.historyTruncated).toBe(true);
        expect(data.state.downloadsActiveTruncated).toBe(true);
        expect(data.state.downloadsStale).toBe(false);
        expect(data.state.downloadsError).toBe(true);
        expect(data.state.downloadsDegraded).toBe(true);
        expect(data.state.downloadsHasSnapshot).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('bounds stale active metadata hidden beyond the response cap', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-25T12:00:00Z'));
        const envelope = downloadEnvelope('visible-fresh', 'Visible fresh title');
        envelope.stale = true;
        envelope.activeTruncated = true;
        envelope.counts = { downloading: 501, processing: 0, history: 0 };
        plugin.mockResolvedValue(envelope);

        await data.fetchDownloads();
        expect(data.state.downloadsCounts.downloading).toBe(501);

        await vi.advanceTimersByTimeAsync(data.DOWNLOADS_SNAPSHOT_RETENTION_MS);

        expect(data.state.downloads.map((item) => item.id)).toEqual(['visible-fresh']);
        expect(data.state.downloadsCounts.downloading).toBe(1);
        expect(data.state.downloadsActiveTruncated).toBe(true);
        expect(data.state.downloadsError).toBe(true);
    });

    it('does not renew off-cap metadata across filtered search projections', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-25T12:00:00Z'));
        const alpha = downloadEnvelope('alpha-visible', 'Alpha visible');
        alpha.stale = true;
        alpha.activeTruncated = true;
        alpha.counts = { downloading: 501, processing: 0, history: 0 };
        const beta = downloadEnvelope('beta-visible', 'Beta visible');
        plugin
            .mockResolvedValueOnce(alpha)
            .mockResolvedValueOnce(beta)
            .mockResolvedValueOnce(alpha);

        data.state.downloadsSearchQuery = 'alpha';
        await data.fetchDownloads();
        await vi.advanceTimersByTimeAsync(60_000);
        data.state.downloadsSearchQuery = 'beta';
        await data.fetchDownloads();
        expect(data.state.downloadsStale).toBe(false);

        await vi.advanceTimersByTimeAsync(60_000);
        data.state.downloadsSearchQuery = 'alpha';
        await data.fetchDownloads();
        await vi.advanceTimersByTimeAsync(3 * 60_000);

        expect(data.state.downloads.map((item) => item.id)).toEqual(['alpha-visible']);
        expect(data.state.downloadsCounts.downloading).toBe(1);
        expect(data.state.downloadsActiveTruncated).toBe(true);
        expect(data.state.downloadsError).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('invalidates an inactive stale search silently, then sanitizes it on return', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-25T12:00:00Z'));
        const alpha = downloadEnvelope('alpha-visible', 'Alpha visible');
        alpha.stale = true;
        alpha.activeTruncated = true;
        alpha.counts = { downloading: 501, processing: 0, history: 0 };
        const beta = downloadEnvelope('beta-visible', 'Beta visible');
        plugin
            .mockResolvedValueOnce(alpha)
            .mockResolvedValueOnce(beta)
            .mockResolvedValueOnce(alpha);

        data.state.downloadsSearchQuery = 'alpha';
        await data.fetchDownloads();
        await vi.advanceTimersByTimeAsync(60_000);
        data.state.downloadsSearchQuery = 'beta';
        await data.fetchDownloads();
        await vi.advanceTimersByTimeAsync(4 * 60_000);

        expect(data.state.downloads.map((item) => item.id)).toEqual(['beta-visible']);
        expect(data.state.downloadsError).toBe(false);
        expect(data.state.downloadsActiveTruncated).toBe(false);

        data.state.downloadsSearchQuery = 'alpha';
        await data.fetchDownloads();
        expect(data.state.downloads.map((item) => item.id)).toEqual(['alpha-visible']);
        expect(data.state.downloadsCounts.downloading).toBe(1);
        expect(data.state.downloadsError).toBe(true);
        expect(data.state.downloadsActiveTruncated).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps a younger source lease when an inactive search gate expires', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-25T12:00:00Z'));
        const alpha = downloadEnvelope('alpha-visible', 'Alpha visible');
        alpha.stale = true;
        const beta = downloadEnvelope(
            'unused',
            'Unused',
            {
                sourceState: 'unavailable',
                capturedAt: '2026-07-25T12:00:00Z',
                generatedAt: '2026-07-25T12:00:00Z',
            }
        );
        beta.items = [];
        beta.counts = { downloading: 0, processing: 0, history: 0 };
        beta.stale = false;
        plugin
            .mockResolvedValueOnce(alpha)
            .mockResolvedValueOnce(beta);

        data.state.downloadsSearchQuery = 'alpha';
        await data.fetchDownloads();
        await vi.advanceTimersByTimeAsync(60_000);
        data.state.downloadsSearchQuery = 'beta';
        await data.fetchDownloads();

        await vi.advanceTimersByTimeAsync(4 * 60_000);
        expect(data.state.downloadSources).toEqual([
            expect.objectContaining({
                state: 'unavailable',
                capturedAt: '2026-07-25T12:00:00Z',
            }),
        ]);
        expect(data.state.downloadsError).toBe(false);
        expect(vi.getTimerCount()).toBe(1);

        await vi.advanceTimersByTimeAsync(60_000);
        expect(data.state.downloadSources).toEqual([
            expect.objectContaining({
                state: 'unavailable',
                capturedAt: null,
            }),
        ]);
        expect(data.state.downloadsHasSnapshot).toBe(false);
        expect(data.state.downloadsError).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not renew stale metadata across polls and cancels it on recovery', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-25T12:00:00Z'));
        const stale = downloadEnvelope('visible-fresh', 'Visible fresh title');
        stale.stale = true;
        stale.counts = { downloading: 1, processing: 0, history: 99 };
        stale.historyTotalItems = 99;
        stale.historyTotalPages = 5;
        const recovered = downloadEnvelope('recovered', 'Recovered title');
        plugin
            .mockResolvedValueOnce(stale)
            .mockResolvedValueOnce(stale)
            .mockResolvedValueOnce(recovered);

        await data.fetchDownloads();
        await vi.advanceTimersByTimeAsync(2 * 60_000);
        await data.fetchDownloads();
        await vi.advanceTimersByTimeAsync(3 * 60_000);

        expect(data.state.downloadsCounts.history).toBe(0);
        expect(data.state.historyTruncated).toBe(true);
        expect(vi.getTimerCount()).toBe(0);

        await data.fetchDownloads();
        expect(data.state.downloads.map((item) => item.id)).toEqual(['recovered']);
        expect(data.state.downloadsError).toBe(false);
        expect(data.state.historyTruncated).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(data.DOWNLOADS_SNAPSHOT_RETENTION_MS);
        expect(data.state.downloads.map((item) => item.id)).toEqual(['recovered']);
    });

    it('expires staggered empty stale sources on their independent deadlines', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-25T12:00:00Z'));
        const envelope = downloadEnvelope('unused', 'Unused');
        envelope.items = [];
        envelope.counts = { downloading: 0, processing: 0, history: 0 };
        envelope.stale = true;
        envelope.sources = [
            {
                source: 'Sonarr',
                instanceId: 'sonarr-a',
                instanceName: 'Sonarr A',
                state: 'stale',
                capturedAt: '2026-07-25T11:56:00Z',
            },
            {
                source: 'Sonarr',
                instanceId: 'sonarr-b',
                instanceName: 'Sonarr B',
                state: 'stale',
                capturedAt: '2026-07-25T11:58:00Z',
            },
        ];
        plugin.mockResolvedValue(envelope);

        await data.fetchDownloads();
        await vi.advanceTimersByTimeAsync(60_000);

        expect(data.state.downloadSources.map((source) => source.state))
            .toEqual(['unavailable', 'stale']);
        expect(data.state.downloadsHasSnapshot).toBe(true);

        await vi.advanceTimersByTimeAsync(2 * 60_000);
        expect(data.state.downloadSources.map((source) => source.state))
            .toEqual(['unavailable', 'unavailable']);
        expect(data.state.downloadsHasSnapshot).toBe(false);
        expect(vi.getTimerCount()).toBe(1);

        await vi.advanceTimersByTimeAsync(2 * 60_000);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('expires a zero-row unavailable source with a retained collection capture', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-25T12:00:00Z'));
        const envelope = downloadEnvelope('unused', 'Unused');
        envelope.items = [];
        envelope.counts = { downloading: 0, processing: 0, history: 0 };
        envelope.stale = false;
        envelope.degraded = true;
        envelope.sources = [{
            source: 'Radarr',
            instanceId: 'radarr-partial',
            instanceName: 'Partial Radarr',
            state: 'unavailable',
            capturedAt: '2026-07-25T11:58:00Z',
        }];
        plugin.mockResolvedValue(envelope);

        await data.fetchDownloads();
        expect(data.state.downloadsHasSnapshot).toBe(true);
        expect(vi.getTimerCount()).toBe(1);

        await vi.advanceTimersByTimeAsync(3 * 60_000);
        expect(data.state.downloadSources).toEqual([
            expect.objectContaining({
                state: 'unavailable',
                capturedAt: null,
            }),
        ]);
        expect(data.state.downloadsHasSnapshot).toBe(false);
        expect(data.state.downloadsError).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps a separate transport deadline after selective stale-source expiry', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-25T12:00:00Z'));
        plugin
            .mockResolvedValueOnce(mixedSourceEnvelope())
            .mockRejectedValueOnce(new Error('transport unavailable'));

        await data.fetchDownloads();
        await data.fetchDownloads();

        await vi.advanceTimersByTimeAsync(60_000);
        expect(data.state.downloads.map((item) => item.title))
            .toEqual(['Fresh Radarr title']);
        expect(data.state.downloadsHasSnapshot).toBe(true);
        expect(vi.getTimerCount()).toBe(1);

        await vi.advanceTimersByTimeAsync(
            data.DOWNLOADS_SNAPSHOT_RETENTION_MS - 60_000
        );
        expect(data.state.downloads).toEqual([]);
        expect(data.state.downloadSources).toEqual([]);
        expect(data.state.downloadsHasSnapshot).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not renew a stale capture when the same snapshot is polled again', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-25T12:00:00Z'));
        plugin
            .mockResolvedValueOnce(downloadEnvelope(
                'activity-repeated-server-stale',
                'Repeated stale title',
                {
                    stale: true,
                    sourceState: 'stale',
                    capturedAt: '2026-07-25T11:56:00Z',
                    generatedAt: '2026-07-25T12:00:00Z',
                }
            ))
            .mockResolvedValueOnce(downloadEnvelope(
                'activity-repeated-server-stale',
                'Repeated stale title',
                {
                    stale: true,
                    sourceState: 'stale',
                    capturedAt: '2026-07-25T11:56:00Z',
                    generatedAt: '2026-07-25T12:00:30Z',
                }
            ));

        await data.fetchDownloads();
        await vi.advanceTimersByTimeAsync(30_000);
        await data.fetchDownloads();
        await vi.advanceTimersByTimeAsync(29_999);
        expect(data.state.downloadsHasSnapshot).toBe(true);

        await vi.advanceTimersByTimeAsync(1);
        expect(data.state.downloadsHasSnapshot).toBe(false);
        expect(data.state.downloadsError).toBe(true);
    });

    it('retains a handoff-only stale row whose upstream source is fresh', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-25T12:00:00Z'));
        plugin.mockResolvedValue(downloadEnvelope(
            'activity-handoff-stale',
            'Queue handoff title',
            {
                stale: true,
                sourceState: 'fresh',
                generatedAt: '2026-07-25T12:00:00Z',
            }
        ));

        await data.fetchDownloads();

        expect(data.state.downloadsHasSnapshot).toBe(true);
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(data.DOWNLOADS_SNAPSHOT_RETENTION_MS - 1);
        expect(data.state.downloadsHasSnapshot).toBe(true);
        await vi.advanceTimersByTimeAsync(1);
        expect(data.state.downloads).toEqual([]);
        expect(data.state.downloadSources).toEqual([
            expect.objectContaining({ state: 'fresh' }),
        ]);
        expect(data.state.downloadsHasSnapshot).toBe(true);
        expect(data.state.downloadsStale).toBe(false);
        expect(data.state.downloadsError).toBe(true);
    });

    it('keeps a handoff deadline across History page projection changes', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-25T12:00:00Z'));
        const visible = downloadEnvelope(
            'history-handoff',
            'Paged handoff',
            { stale: true, sourceState: 'fresh' }
        );
        const handoff = {
            ...(visible.items as Record<string, unknown>[])[0],
            section: 'history',
            lifecycle: 'imported',
            terminal: true,
        };
        visible.items = [];
        visible.history = [handoff];
        visible.counts = { downloading: 0, processing: 0, history: 1 };
        visible.historyPage = 1;
        visible.historyTotalItems = 1;
        visible.historyTotalPages = 2;
        visible.stale = true;
        const hidden = {
            ...visible,
            history: [],
            historyPage: 2,
        };
        plugin
            .mockResolvedValueOnce(visible)
            .mockResolvedValueOnce(hidden)
            .mockResolvedValueOnce(visible)
            .mockResolvedValueOnce(visible);

        await data.fetchDownloads();
        await vi.advanceTimersByTimeAsync(60_000);
        data.state.historyPage = 2;
        await data.fetchDownloads();
        expect(data.state.downloadHistory).toEqual([]);

        await vi.advanceTimersByTimeAsync(60_000);
        data.state.historyPage = 1;
        await data.fetchDownloads();
        await vi.advanceTimersByTimeAsync(3 * 60_000 - 1);
        expect(data.state.downloadHistory).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(1);
        expect(data.state.downloadHistory).toEqual([]);
        expect(data.state.downloadsError).toBe(true);
        expect(vi.getTimerCount()).toBe(0);

        await data.fetchDownloads();
        expect(data.state.downloadHistory).toEqual([]);
        expect(data.state.downloadsError).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('clamps off-page totals when a visible handoff shares the metadata deadline', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-25T12:00:00Z'));
        const envelope = downloadEnvelope(
            'visible-handoff',
            'Visible handoff',
            { stale: true, sourceState: 'fresh' }
        );
        envelope.stale = true;
        envelope.counts = { downloading: 1, processing: 0, history: 99 };
        envelope.historyTotalItems = 99;
        envelope.historyTotalPages = 5;
        plugin.mockResolvedValue(envelope);

        await data.fetchDownloads();
        await vi.advanceTimersByTimeAsync(data.DOWNLOADS_SNAPSHOT_RETENTION_MS);

        expect(data.state.downloads).toEqual([]);
        expect(data.state.downloadsCounts).toEqual({
            downloading: 0,
            processing: 0,
            history: 0,
        });
        expect(data.state.historyTotalItems).toBe(0);
        expect(data.state.historyTotalPages).toBe(1);
        expect(data.state.historyTruncated).toBe(true);
        expect(data.state.downloadsActiveTruncated).toBe(true);
        expect(data.state.downloadsError).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('clears a projection-preserved handoff lease on unfiltered recovery', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-25T12:00:00Z'));
        const visible = downloadEnvelope(
            'reused-handoff-id',
            'Recovered handoff',
            { stale: true, sourceState: 'fresh' }
        );
        const hidden = {
            ...visible,
            items: [],
            stale: true,
            counts: { downloading: 1, processing: 0, history: 0 },
        };
        const recovered = downloadEnvelope('healthy', 'Healthy');
        recovered.items = [];
        recovered.counts = { downloading: 0, processing: 0, history: 0 };
        plugin
            .mockResolvedValueOnce(visible)
            .mockResolvedValueOnce(hidden)
            .mockResolvedValueOnce(recovered)
            .mockResolvedValueOnce(visible);

        await data.fetchDownloads();
        await vi.advanceTimersByTimeAsync(60_000);
        await data.fetchDownloads();
        await vi.advanceTimersByTimeAsync(60_000);
        await data.fetchDownloads();
        await vi.advanceTimersByTimeAsync(60_000);
        await data.fetchDownloads();

        await vi.advanceTimersByTimeAsync(2 * 60_000);
        expect(data.state.downloads).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(3 * 60_000);
        expect(data.state.downloads).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not renew stale handoffs when unrelated rows churn', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-25T12:00:00Z'));
        const first = downloadEnvelope(
            'handoff-a',
            'Surviving handoff',
            { stale: true, sourceState: 'fresh' }
        );
        const firstItem = (first.items as Record<string, unknown>[])[0];
        first.items = [
            firstItem,
            { ...firstItem, id: 'handoff-b', title: 'Departing handoff' },
        ];
        const second = downloadEnvelope(
            'handoff-a',
            'Surviving handoff',
            { stale: true, sourceState: 'fresh' }
        );
        const secondItem = (second.items as Record<string, unknown>[])[0];
        second.items = [
            secondItem,
            { ...secondItem, id: 'handoff-c', title: 'New handoff' },
        ];
        plugin
            .mockResolvedValueOnce(first)
            .mockResolvedValueOnce(second);

        await data.fetchDownloads();
        await vi.advanceTimersByTimeAsync(2 * 60_000);
        await data.fetchDownloads();
        await vi.advanceTimersByTimeAsync(3 * 60_000);

        expect(data.state.downloads).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([null, 'not-a-date'])(
        'expires stale media immediately when its source capture is %s',
        async (capturedAt) => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-07-25T12:00:00Z'));
            plugin.mockResolvedValue(downloadEnvelope(
                'activity-invalid-server-stale',
                'Invalid stale title',
                {
                    stale: true,
                    sourceState: 'stale',
                    capturedAt,
                    generatedAt: '2026-07-25T12:00:00Z',
                }
            ));

            await data.fetchDownloads();

            expect(data.state.downloadsHasSnapshot).toBe(false);
            expect(data.state.downloads).toEqual([]);
            expect(data.state.downloadsError).toBe(true);
            expect(vi.getTimerCount()).toBe(1);
            await vi.advanceTimersByTimeAsync(
                data.DOWNLOADS_SNAPSHOT_RETENTION_MS
            );
            expect(vi.getTimerCount()).toBe(0);
        }
    );

    it('cancels successful server-stale expiry on fresh recovery and identity teardown', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-25T12:00:00Z'));
        plugin
            .mockResolvedValueOnce(downloadEnvelope(
                'activity-server-stale',
                'Server stale title',
                { stale: true, sourceState: 'stale' }
            ))
            .mockResolvedValueOnce(downloadEnvelope('activity-recovered', 'Recovered title'));

        await data.fetchDownloads();
        expect(vi.getTimerCount()).toBe(1);

        await data.fetchDownloads();
        expect(data.state.downloads[0]?.title).toBe('Recovered title');
        expect(data.state.downloadsStale).toBe(false);
        expect(vi.getTimerCount()).toBe(0);

        await vi.advanceTimersByTimeAsync(data.DOWNLOADS_SNAPSHOT_RETENTION_MS + 1);
        expect(data.state.downloadsHasSnapshot).toBe(true);

        plugin.mockResolvedValueOnce(downloadEnvelope(
            'activity-server-stale-again',
            'Server stale again',
            { stale: true, sourceState: 'stale' }
        ));
        await data.fetchDownloads();
        expect(vi.getTimerCount()).toBe(1);
        data.resetRequestsIdentityState();
        expect(vi.getTimerCount()).toBe(0);
        expect(data.state.downloadsHasSnapshot).toBe(false);
    });

    it('cancels retained-snapshot expiry on recovery and identity teardown', async () => {
        vi.useFakeTimers();
        plugin
            .mockResolvedValueOnce(downloadEnvelope('activity-old', 'Old title'))
            .mockRejectedValueOnce(new Error('refresh unavailable'))
            .mockResolvedValueOnce(downloadEnvelope('activity-fresh', 'Fresh title'));

        await data.fetchDownloads();
        await data.fetchDownloads();
        expect(vi.getTimerCount()).toBe(1);

        await vi.advanceTimersByTimeAsync(data.DOWNLOADS_SNAPSHOT_RETENTION_MS / 2);
        await data.fetchDownloads();
        expect(data.state.downloads[0]?.title).toBe('Fresh title');
        expect(data.state.downloadsError).toBe(false);
        expect(vi.getTimerCount()).toBe(0);

        await vi.advanceTimersByTimeAsync(data.DOWNLOADS_SNAPSHOT_RETENTION_MS / 2 + 1);
        expect(data.state.downloadsHasSnapshot).toBe(true);
        expect(data.state.downloads[0]?.title).toBe('Fresh title');

        plugin.mockRejectedValueOnce(new Error('another outage'));
        await data.fetchDownloads();
        expect(vi.getTimerCount()).toBe(1);
        data.resetRequestsIdentityState();
        expect(vi.getTimerCount()).toBe(0);
        expect(data.state.downloadsHasSnapshot).toBe(false);
    });

    it('does not repaint a retained container owned by the previous identity', () => {
        const container = document.createElement('div');
        container.innerHTML = '<span>account-a-sentinel</span>';
        document.body.appendChild(container);
        window.JellyfinCanopy.identity.own(container);
        render.setActiveContainer(container);

        const epoch = window.JellyfinCanopy.identity.getEpoch();
        window.JellyfinCanopy.identity.transition('requests-test-server', `requests-user-${epoch}`, 'test-account-switch');
        render.renderPage();
        render.setActiveContainer(null);

        expect(container.innerHTML).toContain('account-a-sentinel');
        expect(container.innerHTML).not.toContain('requests_no_requests_found');
    });
});
