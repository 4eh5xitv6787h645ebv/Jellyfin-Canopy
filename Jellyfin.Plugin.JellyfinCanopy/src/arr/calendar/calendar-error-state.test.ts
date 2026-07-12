// Unit tests for the Calendar-page error state (W4-ERR-3, W4-ERR-6).
//
// A total calendar-fetch failure must flag eventsError (so the view renders an
// explicit ERROR state instead of "No upcoming releases") and toast once. A
// mid-loop failure while loading the Requests filter must flag requestedError
// and toast once rather than silently under-populating the filter.
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
        JC.pluginConfig = { JellyseerrEnabled: true, CalendarFilterByLibraryAccess: true };
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
        views.renderPage(container);

        expect(container.innerHTML).toContain('calendar_load_error');
        expect(container.innerHTML).not.toContain('calendar_no_releases');
    });

    it('fetchUserRequests flags requestedError and toasts once on a mid-loop failure', async () => {
        plugin.mockRejectedValue(new Error('requests down'));

        await data.ensureRequestData();

        expect(data.state.requestedError).toBe(true);
        expect(data.state.requestedLoaded).toBe(true);
        expect(toast).toHaveBeenCalledTimes(1);
        expect(String(toast.mock.calls[0][0])).toContain('calendar_load_error');
    });
});
