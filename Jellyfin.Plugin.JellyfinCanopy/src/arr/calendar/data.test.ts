// Unit tests for src/arr/calendar/data.ts — the calendar data-access layer.
//
// CRIT-1 (range filter): a date-only release whose LOCAL day intersects the view must not be
// dropped. The client must hand the server the view's LOCAL calendar-day bounds (startDay/endDay)
// so the server can range-filter date-only releases by day instead of by UTC instant — otherwise
// a midnight-UTC release for a local day in view is filtered out for any viewer off UTC.
import { describe, expect, it, beforeEach, vi } from 'vitest';
import '../../core/ui-kit';

describe('fetchCalendarEvents local-day bounds (CRIT-1)', () => {
    let plugin: ReturnType<typeof vi.fn>;
    let data: typeof import('./data');

    beforeEach(async () => {
        vi.resetModules();
        plugin = vi.fn();
        const JC = window.JellyfinCanopy as unknown as Record<string, unknown>;
        JC.core = { api: { plugin } };
        JC.pluginConfig = { CalendarFilterByLibraryAccess: true };
        JC.t = (k: string) => k;
        JC.toast = vi.fn();
        data = await import('./data');
    });

    it('sends the view LOCAL-day bounds so a boundary date-only release survives the server filter', async () => {
        // A boundary date-only release: midnight-UTC on the viewed local day.
        plugin.mockResolvedValue({
            events: [{
                id: 'm1',
                releaseDate: '2026-07-10T00:00:00.000Z',
                dateOnly: true,
                releaseDateLocal: '2026-07-10',
            }],
        });

        // Day view of 2026-07-10 built from LOCAL Date components (start = local midnight,
        // end = local end-of-day) — exactly what getRangeForView produces.
        const start = new Date(2026, 6, 10, 0, 0, 0, 0);
        const end = new Date(2026, 6, 10, 23, 59, 59, 999);
        await data.fetchCalendarEvents(start, end);

        const url = String(plugin.mock.calls[0][0]);
        expect(url).toContain('startDay=2026-07-10');
        expect(url).toContain('endDay=2026-07-10');
        // The boundary release is retained for local-day bucketing.
        expect(data.state.events.map((e) => e.id)).toContain('m1');
    });
});
