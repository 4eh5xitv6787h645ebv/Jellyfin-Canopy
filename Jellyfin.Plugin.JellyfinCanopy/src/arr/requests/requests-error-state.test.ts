// Unit tests for the Requests-page error state (CRIT-2 / W4-ERR-1, W4-ERR-2).
//
// A backend failure (e.g. the requests proxy's 502 when Seerr is unreachable)
// must drive an explicit ERROR state, not the "No requests found" empty state,
// and a total downloads-fetch failure must toast once instead of silently
// showing "No active downloads".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// ui-kit installs the real JC.escapeHtml (the setup stub is a no-op) which the
// render modules capture at import.
import '../../core/ui-kit';

interface HttpErrorLike extends Error { status?: number; responseJSON?: unknown; }
function httpError(status: number, message: string): HttpErrorLike {
    const e = new Error(`HTTP ${status}`) as HttpErrorLike;
    e.status = status;
    e.responseJSON = { message };
    return e;
}

function downloadEnvelope(id: string, title: string): Record<string, unknown> {
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
        }],
        history: [],
        sources: [{
            source: 'Sonarr',
            instanceId: 'sonarr-1',
            instanceName: 'Main Sonarr',
            state: 'fresh',
            capturedAt: '2026-07-25T01:00:00Z',
        }],
        counts: { downloading: 1, processing: 0, history: 0 },
        generatedAt: '2026-07-25T01:00:00Z',
        historyPage: 1,
        historyPageSize: 20,
        historyTotalItems: 0,
        historyTotalPages: 1,
    };
}

describe('requests page error state', () => {
    let plugin: ReturnType<typeof vi.fn>;
    let toast: ReturnType<typeof vi.fn>;
    let data: typeof import('./data');
    let render: typeof import('./render');

    beforeEach(async () => {
        vi.resetModules();
        document.body.innerHTML = '';
        plugin = vi.fn();
        toast = vi.fn();
        const JC = window.JellyfinCanopy as unknown as Record<string, unknown>;
        JC.core = { api: { plugin } };
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
        expect(toast).toHaveBeenCalledTimes(1);
        expect(String(toast.mock.calls[0][0])).toContain('downloads_load_error');

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
