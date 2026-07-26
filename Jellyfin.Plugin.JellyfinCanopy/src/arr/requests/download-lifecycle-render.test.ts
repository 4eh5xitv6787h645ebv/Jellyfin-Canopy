import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../../core/ui-kit';
import type { DownloadActivity } from './data';

function activity(id: string, overrides: Partial<DownloadActivity> = {}): DownloadActivity {
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

describe('download lifecycle page rendering', () => {
    let plugin: ReturnType<typeof vi.fn>;
    let data: typeof import('./data');
    let actions: typeof import('./actions');
    let render: typeof import('./render');
    let container: HTMLDivElement;

    beforeEach(async () => {
        vi.resetModules();
        document.body.innerHTML = '';
        const JC = window.JellyfinCanopy as unknown as Record<string, unknown>;
        plugin = vi.fn();
        JC.core = { api: { plugin } };
        JC.pluginConfig = { ShowDownloadsInRequests: true, SeerrEnabled: false };
        JC.t = (key: string) => key;
        data = await import('./data');
        actions = await import('./actions');
        render = await import('./render');
        container = document.createElement('div');
        document.body.appendChild(container);
        window.JellyfinCanopy.identity.own(container);
        render.setActiveContainer(container);
        data.state.downloadsHasSnapshot = true;
    });

    it('always exposes three keyboard tabs backed by labelled tab panels', () => {
        data.state.downloadsCounts = { downloading: 12, processing: 4, history: 31 };
        data.state.downloads = [activity('active')];

        render.renderPage();

        const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
        expect(tabs).toHaveLength(3);
        expect(tabs.map((tab) => tab.dataset.tab)).toEqual(['downloading', 'processing', 'history']);
        expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
        expect(tabs[0]?.getAttribute('tabindex')).toBe('0');
        expect(tabs.slice(1).every((tab) => tab.getAttribute('tabindex') === '-1')).toBe(true);
        for (const tab of tabs) {
            const panelId = tab.getAttribute('aria-controls');
            expect(panelId).toBeTruthy();
            expect(container.querySelector(`#${panelId}`)?.getAttribute('role')).toBe('tabpanel');
        }
        expect(container.querySelectorAll('[role="tabpanel"]:not([hidden])')).toHaveLength(1);
        expect(container.textContent).toContain('Title active');
    });

    it('renders persistent truncation health and accessible History pagination', () => {
        data.state.downloadsActiveTruncated = true;
        data.state.downloadsDegraded = true;
        data.state.downloadHistory = [activity('history', {
            section: 'history',
            lifecycle: 'imported',
        })];
        data.state.downloadsActiveTab = 'history';
        data.state.historyPage = 2;
        data.state.historyAppliedPage = 2;
        data.state.historyTotalPages = 3;
        data.state.historyTruncated = true;

        render.renderPage();

        expect(container.querySelector('.jc-downloads-health')?.textContent).toContain('downloads_active_truncated');
        expect(container.textContent).toContain('Title history');
        expect(container.querySelector('[data-history-page="prev"]')?.getAttribute('aria-label'))
            .toBe('downloads_history_previous');
        expect(container.querySelector('[data-history-page="next"]')?.getAttribute('aria-label'))
            .toBe('downloads_history_next');
        expect(container.textContent).toContain('downloads_history_truncated');
    });

    it('does not present rows from the previous server search as matching new text', () => {
        data.state.downloads = [activity('old', { title: 'Old unfiltered row' })];
        data.state.downloadsSearchQuery = 'new query';
        data.state.downloadsAppliedSearchQuery = '';

        render.renderPage();

        expect(container.textContent).not.toContain('Old unfiltered row');
        expect(container.textContent).toContain('downloads_search_loading');
    });

    it('returns to the applied History page when the next page fails', async () => {
        const retainedHistory = activity('retained-history', {
            title: 'Retained page-one history',
            section: 'history',
            lifecycle: 'imported',
        });
        plugin.mockResolvedValueOnce({
            items: [],
            history: [retainedHistory],
            sources: [{
                source: 'Sonarr',
                instanceId: 'sonarr-main',
                instanceName: 'Main Sonarr',
                state: 'fresh',
                capturedAt: new Date().toISOString(),
            }],
            counts: { downloading: 0, processing: 0, history: 41 },
            generatedAt: new Date().toISOString(),
            historyPage: 1,
            historyPageSize: 20,
            historyTotalItems: 41,
            historyTotalPages: 3,
        });
        await data.fetchDownloads();
        data.state.downloadsActiveTab = 'history';
        plugin.mockRejectedValueOnce(new Error('page two unavailable'));
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        try {
            await actions.nextHistoryPage();
        } finally {
            consoleError.mockRestore();
        }

        expect(plugin).toHaveBeenCalledWith(
            '/arr/queue?historyPage=2&historyPageSize=20',
            expect.objectContaining({ signal: expect.any(AbortSignal) })
        );
        expect(data.state.historyPage).toBe(1);
        expect(data.state.historyAppliedPage).toBe(1);
        expect(data.state.downloadsError).toBe(true);
        expect(container.textContent).toContain('Retained page-one history');
        expect(container.querySelector<HTMLButtonElement>('[data-history-page="prev"]')?.disabled)
            .toBe(true);
        expect(container.querySelector('[data-history-page="next"]')).not.toBeNull();
    });
});
