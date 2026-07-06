// src/arr/calendar/event-date.ts
//
// The one place that decides which calendar CELL an event belongs to and what
// TIME (if any) to print. Date-only releases (Radarr cinema/digital/physical;
// Sonarr airDate fallback) carry `dateOnly` + `releaseDateLocal` from the server
// and must NOT be timezone-converted — doing so bucketed them on the wrong local
// day for any viewer west of UTC and printed a bogus clock time (CRIT-1).
// Genuine instants (Sonarr airDateUtc) keep local conversion.

import { state } from './data';
import type { CalendarEvent } from './data';

/** "yyyy-MM-dd" local-day bucket key for an event, or null when undatable. */
export function getEventDateKey(event: CalendarEvent): string | null {
    if (!event.releaseDate) return null;
    // Date-only: the server already computed the intended calendar day; use it
    // verbatim — never new Date(...), which reinterprets midnight-UTC in the
    // viewer's zone and drifts the event onto the previous day.
    if (event.dateOnly && event.releaseDateLocal) {
        return event.releaseDateLocal;
    }
    const date = new Date(event.releaseDate);
    if (Number.isNaN(date.getTime())) return null;
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/** Display time label, or null when there is no meaningful clock time. */
export function getEventTimeLabel(event: CalendarEvent): string | null {
    if (!event.releaseDate) return null;
    if (event.dateOnly) return null; // date-only → no time, ever
    const date = new Date(event.releaseDate);
    if (Number.isNaN(date.getTime())) return null;
    if (date.getHours() === 0 && date.getMinutes() === 0) return null;
    const hour12 = state.settings.timeFormat === '5pm/5:30pm';
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12 });
}
