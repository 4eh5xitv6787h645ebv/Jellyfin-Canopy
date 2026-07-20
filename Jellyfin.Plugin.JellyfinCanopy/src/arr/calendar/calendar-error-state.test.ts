// Unit tests for the Calendar-page error state (W4-ERR-3, W4-ERR-6).
//
// A total calendar-fetch failure must flag eventsError (so the view renders an
// explicit ERROR state instead of "No upcoming releases") and toast once. A
// A request-snapshot failure must flag requestedError, publish no partial keys,
// and remain retryable rather than silently under-populating the filter.
import { describe, expect, it, beforeEach, vi } from 'vitest';
import '../../core/ui-kit';

describe('calendar page error state', () => {
    let plugin: ReturnType<typeof vi.fn>;
    let toast: ReturnType<typeof vi.fn>;
    let data: typeof import('./data');
    let views: typeof import('./render-views');

    beforeEach(async () => {
        vi.resetModules();
        plugin = vi.fn();
        toast = vi.fn();
        const JC = window.JellyfinCanopy as unknown as Record<string, unknown>;
        JC.core = { api: { plugin } };
        JC.pluginConfig = { SeerrEnabled: true, CalendarFilterByLibraryAccess: true };
        JC.t = (k: string) => k;
        JC.toast = toast;
        data = await import('./data');
        views = await import('./render-views');
    });

    it('fetchCalendarEvents flags eventsError and toasts on total failure, rendering the error state', async () => {
        plugin.mockRejectedValue(new Error('backend down'));

        await data.fetchCalendarEvents(new Date('2026-01-01'), new Date('2026-02-01'));

        expect(data.state.eventsError).toBe(true);
        expect(data.state.events.length).toBe(0);
        expect(toast).toHaveBeenCalledTimes(1);
        expect(String(toast.mock.calls[0][0])).toContain('calendar_load_error');

        data.state.isLoading = false;
        const container = document.createElement('div');
        document.body.appendChild(container);
        views.setActiveContainer(container);
        views.renderPage();
        views.setActiveContainer(null);

        expect(container.innerHTML).toContain('calendar_load_error');
        expect(container.innerHTML).not.toContain('calendar_no_releases');
        expect(container.querySelector('.jc-calendar-view-btn.active')?.getAttribute('aria-pressed')).toBe('true');
        expect(container.querySelector('.jc-calendar-mode-btn')?.getAttribute('aria-pressed')).toMatch(/^(?:true|false)$/);
    });

    it('fetchUserRequests publishes a complete server-owned snapshot', async () => {
        plugin.mockResolvedValue({
            complete: true,
            results: [{ id: 1 }, { id: 2 }],
            pageInfo: { page: 1, pages: 1, pageSize: 2, results: 2 },
            requests: [
                { tmdbId: 42, type: 'tv' },
                { tmdbId: 99, type: 'movie' },
            ],
            totalResults: 2,
            requestKeyCount: 2,
        });

        await data.ensureRequestData();

        expect(plugin).toHaveBeenCalledWith('/arr/request-snapshot?userOnly=true', { signal: undefined });
        expect(data.state.requestedItems).toEqual(new Set(['tv:42', 'movie:99']));
        expect(data.state.requestedLoaded).toBe(true);
        expect(data.state.requestedError).toBe(false);
        expect(toast).not.toHaveBeenCalled();
    });

    it('flags a snapshot failure, publishes no partial keys, and allows a retry', async () => {
        data.state.requestedItems = new Set(['movie:stale']);
        plugin.mockRejectedValue(new Error('requests down'));

        await data.ensureRequestData();

        expect(data.state.requestedError).toBe(true);
        expect(data.state.requestedLoaded).toBe(false);
        expect(data.state.requestedItems.size).toBe(0);
        expect(toast).toHaveBeenCalledTimes(1);
        expect(String(toast.mock.calls[0][0])).toContain('calendar_load_error');

        plugin.mockResolvedValue({
            complete: true,
            results: [{ id: 2 }],
            pageInfo: { page: 1, pages: 1, pageSize: 1, results: 1 },
            requests: [{ tmdbId: 42, type: 'tv' }],
            totalResults: 1,
            requestKeyCount: 1,
        });
        await data.ensureRequestData();

        expect(plugin).toHaveBeenCalledTimes(2);
        expect(data.state.requestedItems).toEqual(new Set(['tv:42']));
        expect(data.state.requestedLoaded).toBe(true);
        expect(data.state.requestedError).toBe(false);
    });

    it('rejects an unproven or internally inconsistent snapshot without publishing it', async () => {
        plugin.mockResolvedValue({
            complete: false,
            requests: [{ tmdbId: 42, type: 'tv' }],
            requestKeyCount: 1,
        });

        await data.ensureRequestData();

        expect(data.state.requestedItems.size).toBe(0);
        expect(data.state.requestedLoaded).toBe(false);
        expect(data.state.requestedError).toBe(true);

        plugin.mockResolvedValue({
            complete: true,
            requests: [{ tmdbId: 42, type: 'tv' }],
            requestKeyCount: 2,
        });
        await data.ensureRequestData();

        expect(data.state.requestedItems.size).toBe(0);
        expect(data.state.requestedLoaded).toBe(false);
        expect(data.state.requestedError).toBe(true);
    });
});
