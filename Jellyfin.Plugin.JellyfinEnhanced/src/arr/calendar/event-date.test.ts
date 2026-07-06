// Unit tests for src/arr/calendar/event-date.ts — the single decision point for
// which calendar cell an event lands in and what time (if any) to print.
//
// CRIT-1: date-only releases (Radarr cinema/digital/physical; Sonarr airDate
// fallback) must render on the correct LOCAL day with no bogus clock time. The
// bug only manifests for viewers off a whole-UTC offset, so pin a negative-offset
// zone — Node honours a runtime process.env.TZ change for Date operations.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getEventDateKey, getEventTimeLabel } from './event-date';
import type { CalendarEvent } from './data';

// `process` has no ambient type in the src tsconfig (no @types/node); reach it
// through a typed globalThis cast. Node honours a runtime TZ mutation for Date.
const nodeEnv = (globalThis as unknown as {
    process?: { env: Record<string, string | undefined> };
}).process?.env;
const originalTz = nodeEnv?.TZ;
beforeAll(() => { if (nodeEnv) nodeEnv.TZ = 'America/Los_Angeles'; }); // UTC-7 in July (PDT)
afterAll(() => {
    if (!nodeEnv) return;
    if (originalTz === undefined) delete nodeEnv.TZ;
    else nodeEnv.TZ = originalTz;
});

const evt = (over: Partial<CalendarEvent>): CalendarEvent => ({ id: 'e', ...over });

describe('getEventDateKey', () => {
    it('buckets a date-only release on its server-supplied local day (no TZ drift)', () => {
        // Midnight-UTC on July 10 reinterpreted in LA is July 9 — the CRIT-1 drift.
        // The date-only path must use releaseDateLocal verbatim and stay on July 10.
        const key = getEventDateKey(evt({
            releaseDate: '2026-07-10T00:00:00.000Z',
            dateOnly: true,
            releaseDateLocal: '2026-07-10',
        }));
        expect(key).toBe('2026-07-10');
    });

    it('converts a genuine instant to the viewer local day', () => {
        // 02:00Z on July 10 is 19:00 on July 9 in LA — an instant still converts.
        const key = getEventDateKey(evt({ releaseDate: '2026-07-10T02:00:00.000Z', dateOnly: false }));
        expect(key).toBe('2026-07-09');
    });
});

describe('getEventTimeLabel', () => {
    it('shows no time for a date-only release', () => {
        // Pre-fix, midnight-UTC in LA is 17:00 → a bogus "5:00 PM" printed.
        const label = getEventTimeLabel(evt({ releaseDate: '2026-07-10T00:00:00.000Z', dateOnly: true }));
        expect(label).toBeNull();
    });

    it('shows a local time for a genuine timed instant', () => {
        const label = getEventTimeLabel(evt({ releaseDate: '2026-07-10T18:30:00.000Z', dateOnly: false }));
        expect(label).not.toBeNull();
    });
});
