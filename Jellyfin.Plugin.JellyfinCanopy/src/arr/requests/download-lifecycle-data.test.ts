import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../../core/ui-kit';

function activity(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id,
        source: 'Sonarr',
        instanceId: 'sonarr-main',
        instanceName: 'Main Sonarr',
        title: `Title ${id}`,
        subtitle: null,
        mediaType: 'episode',
        seasonNumber: 1,
        episodeNumber: 2,
        section: 'downloading',
        lifecycle: 'downloading',
        progress: 25,
        timeRemaining: null,
        occurredAt: null,
        stale: false,
        reasonCode: null,
        terminal: false,
        groupCount: 1,
        importedCount: null,
        expectedCount: null,
        partial: false,
        provenance: null,
        jellyfinItemId: null,
        availability: 'unknown',
        ...overrides,
    };
}

function envelope(items: unknown[] = [], history: unknown[] = []): Record<string, unknown> {
    return {
        items,
        history,
        sources: [],
        degraded: false,
        stale: false,
        generatedAt: '2026-07-25T01:00:00Z',
        counts: {
            downloading: items.length,
            processing: 0,
            history: history.length,
        },
        historyPage: 1,
        historyPageSize: 20,
        historyTotalItems: history.length,
        historyTotalPages: 1,
        historyTruncated: false,
        activeTruncated: false,
    };
}

describe('download lifecycle data contract', () => {
    let plugin: ReturnType<typeof vi.fn>;
    let data: typeof import('./data');

    beforeEach(async () => {
        vi.resetModules();
        plugin = vi.fn();
        const JC = window.JellyfinCanopy as unknown as Record<string, unknown>;
        JC.core = { api: { plugin } };
        JC.pluginConfig = {};
        JC.t = (key: string) => key;
        data = await import('./data');
    });

    it('uses authoritative sections/counts/paging and safely normalizes future values', async () => {
        plugin.mockResolvedValue({
            ...envelope(),
            items: [
                activity('future', {
                    section: 'processing',
                    lifecycle: 'futureLifecycle',
                    progress: 150,
                    provenance: 'private-upstream-value',
                    availability: 'futureAvailability',
                    reasonCode: 'future-reason',
                }),
                activity('', { title: 'Unsafe synthetic identity candidate' }),
                activity('duplicate', { section: 'downloading' }),
                activity('history-from-items', { section: 'history', lifecycle: 'imported' }),
            ],
            history: [
                activity('duplicate', { section: 'history', lifecycle: 'failed' }),
                activity('history-row', { section: 'history', lifecycle: 'imported' }),
            ],
            sources: [{
                source: 'Sonarr',
                instanceId: 'sonarr-main',
                instanceName: 'Main Sonarr',
                state: 'futureSourceState',
                capturedAt: null,
            }],
            counts: { downloading: 7, processing: 8, history: 99 },
            historyPage: 2,
            historyPageSize: 20,
            historyTotalItems: 99,
            historyTotalPages: 5,
            activeTruncated: true,
        });
        data.state.historyPage = 2;
        data.state.downloadsSearchQuery = '  Alien  ';

        await data.fetchDownloads();

        const call = plugin.mock.calls[0] as unknown[] | undefined;
        const requestOptions = call?.[1] as { signal?: AbortSignal } | undefined;
        expect(call?.[0]).toBe('/arr/queue?historyPage=2&historyPageSize=20&search=Alien');
        expect(requestOptions?.signal).toBeInstanceOf(AbortSignal);
        const future = data.state.downloads.find((item) => item.id === 'future');
        expect(future).toMatchObject({
            lifecycle: 'unknown',
            progress: 100,
            provenance: null,
            availability: 'unknown',
        });
        expect(data.state.downloads.some((item) => item.title === 'Unsafe synthetic identity candidate')).toBe(false);
        expect(data.state.downloads.filter((item) => item.id === 'duplicate')).toHaveLength(1);
        expect(data.state.downloadHistory.some((item) => item.id === 'duplicate')).toBe(false);
        expect(data.state.downloadHistory.map((item) => item.id)).toEqual([
            'history-row',
            'history-from-items',
        ]);
        expect(data.state.downloadsCounts).toEqual({ downloading: 7, processing: 8, history: 99 });
        expect(data.state.historyPage).toBe(2);
        expect(data.state.historyTotalPages).toBe(5);
        expect(data.state.downloadSources[0]?.state).toBe('incomplete');
        expect(data.state.downloadsActiveTruncated).toBe(true);
        expect(data.state.downloadsDegraded).toBe(true);
    });

    it('aborts the superseded request and only publishes the latest snapshot', async () => {
        let resolveFirst!: (value: unknown) => void;
        let resolveSecond!: (value: unknown) => void;
        const firstResult = new Promise((resolve) => { resolveFirst = resolve; });
        const secondResult = new Promise((resolve) => { resolveSecond = resolve; });
        plugin
            .mockReturnValueOnce(firstResult)
            .mockReturnValueOnce(secondResult);

        const first = data.fetchDownloads();
        const firstCall = plugin.mock.calls[0] as unknown[] | undefined;
        const firstSignal = (firstCall?.[1] as { signal: AbortSignal }).signal;
        const second = data.fetchDownloads();
        expect(firstSignal.aborted).toBe(true);

        resolveSecond(envelope([activity('latest', { title: 'Latest snapshot' })]));
        await second;
        resolveFirst(envelope([activity('old', { title: 'Old snapshot' })]));
        await first;

        expect(data.state.downloads.map((item) => item.id)).toEqual(['latest']);
    });
});
