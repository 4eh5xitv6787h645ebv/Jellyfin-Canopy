// src/arr/calendar/data.ts
// Calendar Page — state, settings and data access (split from calendar-page.js).
// The former raw fetch() calls with hand-built auth headers are routed through
// JE.core.api.plugin (same /JellyfinElevate/arr endpoints, core auth headers).
//
// calendar/render-views.ts is imported circularly (renderPage) — every
// cross-module reference happens inside function bodies at call time, so the
// cycle is safe under ES module evaluation.

import { JE } from '../arr-globals';
import { renderPage } from './render-views';
import { getEventDateKey } from './event-date';
import { describeFetchError } from '../../core/fetch-error';
import type { ApiApi } from '../../types/je';

const logPrefix = '🪼 Jellyfin Elevate: Calendar Page:';

const api = JE.core.api as ApiApi;

/** One calendar event as returned by /arr/calendar. */
export interface CalendarEvent {
    id: string;
    type?: string;
    title?: string;
    subtitle?: string;
    itemId?: string;
    itemEpisodeId?: string;
    tvdbId?: number | string;
    imdbId?: string;
    tmdbId?: number | string;
    episodeTvdbId?: number | string;
    episodeImdbId?: string;
    seasonNumber?: number;
    episodeNumber?: number;
    releaseDate?: string;
    // True when releaseDate is a calendar day with no meaningful clock time; the
    // event must bucket by releaseDateLocal without timezone conversion (CRIT-1).
    dateOnly?: boolean;
    // The intended "yyyy-MM-dd" calendar day for a date-only release.
    releaseDateLocal?: string;
    releaseType?: string;
    source?: string;
    instanceName?: string;
    alsoInInstances?: string[];
    monitored?: boolean;
    hasFile?: boolean;
    posterUrl?: string;
    backdropUrl?: string;
    [key: string]: unknown;
}

export interface CalendarUserData {
    isFavorite?: boolean;
    isWatched?: boolean;
}

export interface CalendarSettings {
    firstDayOfWeek: string;
    timeFormat: string;
    highlightFavorites: boolean;
    highlightWatchedSeries: boolean;
    showUnmonitored: boolean;
    showOnlyRequested: boolean;
    forceOnlyRequested: boolean;
    displayMode?: string;
    filterByLibraryAccess?: boolean;
}

export interface CalendarState {
    events: CalendarEvent[];
    eventsError: boolean;
    isLoading: boolean;
    pageVisible: boolean;
    previousPage: Element | null;
    currentDate: Date;
    viewMode: string;
    rangeStart: Date | null;
    rangeEnd: Date | null;
    sidebarCollapsed: boolean | null;
    settings: CalendarSettings;
    userDataMap: Map<string, CalendarUserData>;
    activeFilters: Set<string>;
    filterMatchMode: string;
    filterInvert: boolean;
    requestedItems: Set<string>;
    requestedLoaded: boolean;
    requestedLoading: boolean;
    requestedError: boolean;
    locationSignature: string | null;
    locationUnsubscribe: (() => void) | null;
    _customTabContainer: HTMLElement | null;
}

/** Per-instance error entry surfaced by the /arr/calendar envelope. */
interface CalendarErrorEntry {
    source?: string;
    instanceName?: string;
    reason?: string;
}

const STORAGE_KEYS = {
    showUnmonitored: 'je.calendar.showUnmonitored',
};

function getStoredShowUnmonitored(): boolean | null {
    try {
        const stored = window.localStorage?.getItem(STORAGE_KEYS.showUnmonitored);
        if (stored === null) return null;
        return stored === 'true';
    } catch {
        return null;
    }
}

export function setStoredShowUnmonitored(value: boolean): void {
    try {
        window.localStorage?.setItem(STORAGE_KEYS.showUnmonitored, String(!!value));
    } catch {
        // ignore storage errors
    }
}

/**
 * Get default view mode from settings, defaults to agenda
 */
function getDefaultViewMode(): string {
    JE.currentSettings = JE.currentSettings || JE.loadSettings?.() || {};
    const configuredDefault = ((JE.currentSettings.calendarDefaultViewMode as string) || 'agenda').toLowerCase();
    if (configuredDefault === 'month' || configuredDefault === 'week' || configuredDefault === 'agenda' || configuredDefault === 'day') {
        return configuredDefault;
    }

    // Default to agenda if no valid setting
    return 'agenda';
}

// State management
export const state: CalendarState = {
    events: [],
    eventsError: false,
    isLoading: false,
    pageVisible: false,
    previousPage: null,
    currentDate: new Date(),
    viewMode: getDefaultViewMode(),
    rangeStart: null,
    rangeEnd: null,
    sidebarCollapsed: null,
    settings: {
        firstDayOfWeek: 'Monday',
        timeFormat: '5pm/5:30pm',
        highlightFavorites: false,
        highlightWatchedSeries: false,
        showUnmonitored: false,
        showOnlyRequested: false,
        forceOnlyRequested: false,
    },
    userDataMap: new Map(),
    activeFilters: new Set(), // Track active filters
    filterMatchMode: 'any',
    filterInvert: false,
    requestedItems: new Set(),
    requestedLoaded: false,
    requestedLoading: false,
    requestedError: false,
    locationSignature: null,
    locationUnsubscribe: null,
    _customTabContainer: null,
};

// Status color mapping
export const STATUS_COLORS: Record<string, string> = {
    CinemaRelease: '#2196f3',
    DigitalRelease: '#9c27b0',
    PhysicalRelease: '#ff5722',
    Episode: '#4caf50',
};

// Load calendar settings from plugin config
export function loadSettings(): void {
    const config = JE.pluginConfig || {};
    JE.currentSettings = JE.currentSettings || JE.loadSettings?.() || {};
    const storedShowUnmonitored = getStoredShowUnmonitored();
    const forceOnlyRequested = config.CalendarForceOnlyRequested || false;
    state.settings = {
        firstDayOfWeek: config.CalendarFirstDayOfWeek || 'Monday',
        timeFormat: config.CalendarTimeFormat || '5pm/5:30pm',
        highlightFavorites: config.CalendarHighlightFavorites || false,
        highlightWatchedSeries: config.CalendarHighlightWatchedSeries || false,
        showUnmonitored: storedShowUnmonitored ?? false,
        displayMode: JE.currentSettings.calendarDisplayMode || 'list',
        filterByLibraryAccess: config.CalendarFilterByLibraryAccess !== false,
        showOnlyRequested: config.CalendarShowOnlyRequested || false,
        forceOnlyRequested,
    };

    // If show only requested is enabled, set Requests as active by default
    if (!state.settings.forceOnlyRequested && state.settings.showOnlyRequested && state.activeFilters.size === 0) {
        state.activeFilters.add('Requests');
    }

    // Force-only mode handles request filtering globally, so the Requests chip/filter
    // should not remain active in the interactive filter set.
    if (state.settings.forceOnlyRequested) {
        state.activeFilters.delete('Requests');
    }
}

/** "yyyy-MM-dd" for a Date's LOCAL calendar day (matches getEventDateKey's bucketing). */
function toLocalDayKey(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * Fetch calendar events from backend
 */
export async function fetchCalendarEvents(startDate: Date, endDate: Date): Promise<unknown> {
    try {
        const query = new URLSearchParams({
            start: startDate.toISOString(),
            end: endDate.toISOString(),
            // The view's LOCAL calendar-day bounds. Date-only releases (Radarr cinema/digital/
            // physical; Sonarr airDate fallback) carry no clock time, so the server must range-
            // filter them by LOCAL day: their midnight-UTC instant can fall a timezone offset
            // outside [start,end] even though their local day is in view, and a UTC-instant
            // compare would wrongly drop them for any viewer off UTC (CRIT-1).
            startDay: toLocalDayKey(startDate),
            endDay: toLocalDayKey(endDate),
        });
        const data = await api.plugin(`/arr/calendar?${query.toString()}`) as { events?: CalendarEvent[]; errors?: CalendarErrorEntry[] };
        state.events = (data.events || []).filter((evt) => evt && evt.releaseDate);
        state.eventsError = false;
        // Surface per-instance errors from the backend envelope so a misconfigured or
        // unreachable arr instance doesn't silently leave the calendar looking fine.
        surfaceCalendarErrors(data.errors);
        return data;
    } catch (error) {
        console.error(`${logPrefix} Failed to fetch calendar events:`, error);
        state.events = [];
        // A total failure has no per-instance errors[] envelope to surface, so
        // flag it + toast once — otherwise the calendar would render "No
        // upcoming releases" as though the range were genuinely empty (W4-ERR-3).
        state.eventsError = true;
        if (typeof JE.toast === 'function') {
            JE.toast('⚠ ' + esc(describeFetchError(error, JE.t?.('calendar_load_error') || 'Unable to load calendar')));
        }
        return null;
    }
}

// Once-per-session dedup so a permanently-misconfigured instance doesn't toast on every
// calendar refresh. Self-heals: when an error stops appearing the memo entry is dropped
// so a future reoccurrence re-toasts.
const _toastedCalendarErrors = new Set<string>();
// Alias the shared HTML-escape helper to keep toast concatenations short. JE.toast uses
// innerHTML so admin-set instance names + upstream error reasons must be escaped.
// The inline fallback is a real escaper so XSS is blocked even if helpers.js
// hasn't loaded yet (e.g. a load-order race on first init).
const esc = (s: unknown): string => {
    if (JE.helpers?.escHtml) return JE.helpers.escHtml(s);
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- frozen behavior: non-strings coerce via String()
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
};
function surfaceCalendarErrors(errors: CalendarErrorEntry[] | undefined): void {
    if (!Array.isArray(errors) || errors.length === 0) {
        // All previously-failing instances have recovered — drop the memo so future errors re-toast.
        _toastedCalendarErrors.clear();
        return;
    }
    const seenThisTick = new Set<string>();
    errors.forEach(function(err) {
        const key = (err.source || '') + '|' + (err.instanceName || '') + '|' + (err.reason || '');
        seenThisTick.add(key);
        if (_toastedCalendarErrors.has(key)) return;
        _toastedCalendarErrors.add(key);
        if (typeof JE.toast === 'function') {
            JE.toast(
                '⚠ ' + esc(err.source || 'Arr') + ' calendar instance "' +
                esc(err.instanceName || 'unknown') + '" failed: ' + esc(err.reason)
            );
        }
        console.warn(`${logPrefix} ${err.source || 'Arr'} instance "${err.instanceName}" error: ${err.reason}`);
    });
    // Drop memo entries for errors that didn't reappear — lets future occurrences re-toast.
    Array.from(_toastedCalendarErrors).forEach(function(k) {
        if (!seenThisTick.has(k)) _toastedCalendarErrors.delete(k);
    });
}

/**
 * Fetch user data (favorite/watched status) for calendar events
 * Uses POST endpoint to only check specific calendar events, not entire library
 */
export async function fetchUserData(): Promise<void> {
    if (!state.settings.highlightFavorites && !state.settings.highlightWatchedSeries) {
        state.userDataMap = new Map();
        return;
    }

    if (!state.events?.length) {
        state.userDataMap = new Map();
        return;
    }

    try {
        // Send only the events we need to check
        const eventsToCheck = state.events.map((evt) => ({
            id: evt.id,
            type: evt.type,
            title: evt.title,
            itemId: evt.itemId,
            itemEpisodeId: evt.itemEpisodeId,
            tvdbId: evt.tvdbId,
            imdbId: evt.imdbId,
            tmdbId: evt.tmdbId,
            seasonNumber: evt.seasonNumber,
            episodeNumber: evt.episodeNumber,
        }));

        const data = await api.plugin('/arr/calendar/user-data', {
            method: 'POST',
            body: { events: eventsToCheck },
        }) as { results?: { id: string; isFavorite?: boolean; isWatched?: boolean }[] };

        // Build Map for O(1) lookup by event ID
        state.userDataMap = new Map();
        (data.results || []).forEach((result) => {
            state.userDataMap.set(result.id, {
                isFavorite: result.isFavorite,
                isWatched: result.isWatched,
            });
        });
    } catch {
        // Silently handle error - highlighting is optional
        state.userDataMap = new Map();
    }
}

async function fetchUserRequests(): Promise<void> {
    if (!JE.pluginConfig?.JellyseerrEnabled) {
        state.requestedItems = new Set();
        state.requestedLoaded = true;
        state.requestedLoading = false;
        return;
    }

    state.requestedLoading = true;
    state.requestedError = false;
    const requested = new Set<string>();
    const pageSize = 200;
    let page = 1;
    let totalPages = 1;

    try {
        while (page <= totalPages) {
            const skip = (page - 1) * pageSize;
            const query = new URLSearchParams({
                take: String(pageSize),
                skip: String(skip),
                userOnly: 'true',
            });

            const data = await api.plugin(`/arr/requests?${query.toString()}`) as {
                totalPages?: number;
                requests?: { tmdbId?: number | string; type?: string }[];
            };
            totalPages = data.totalPages || 1;
            (data.requests || []).forEach((req) => {
                const tmdbId = req?.tmdbId;
                const type = (req?.type || '').toLowerCase();
                if (!tmdbId || !type) return;
                requested.add(`${type}:${tmdbId}`);
            });

            page += 1;
        }
    } catch (error) {
        console.warn(`${logPrefix} Failed to fetch user requests:`, error);
        // A mid-loop throw would otherwise under-populate the Requests filter
        // silently (requestedLoaded still flips true in finally). Flag it +
        // toast once so the "Requests"/force-only view isn't quietly incomplete.
        state.requestedError = true;
        if (typeof JE.toast === 'function') {
            JE.toast('⚠ ' + esc(describeFetchError(error, JE.t?.('calendar_load_error') || 'Unable to load calendar')));
        }
    } finally {
        state.requestedItems = requested;
        state.requestedLoaded = true;
        state.requestedLoading = false;
        if (state.pageVisible) {
            renderPage();
        }
    }
}

export async function ensureRequestData(): Promise<void> {
    if (state.requestedLoading || state.requestedLoaded) return;
    await fetchUserRequests();
}

/**
 * Filter events based on active filters
 */
export function filterEvents(events: CalendarEvent[]): CalendarEvent[] {
    // First, filter by monitored status if showUnmonitored is false
    let filteredEvents = events;
    if (!state.settings.showUnmonitored) {
        filteredEvents = events.filter((event) => {
            // Filter out unmonitored items from both Sonarr and Radarr
            return event.monitored !== false;
        });
    }

    // Defense-in-depth: hide events the user cannot access.
    // If user-data was fetched, events with an itemId but no user-data
    // entry are from inaccessible libraries. (Primary filtering is server-side.)
    if (state.settings.filterByLibraryAccess && state.userDataMap && state.userDataMap.size > 0) {
        const checkedEventIds = new Set(state.userDataMap.keys());
        filteredEvents = filteredEvents.filter(
            (event) => !event.itemId || checkedEventIds.has(event.id),
        );
    }

    const getRequestKey = (event: CalendarEvent): string | null => {
        const tmdbId = event?.tmdbId;
        if (!tmdbId) return null;
        const type = event.type === 'Series' ? 'tv' : 'movie';
        return `${type}:${tmdbId}`;
    };

    const isRequestedEvent = (event: CalendarEvent): boolean => {
        const key = getRequestKey(event);
        return key ? state.requestedItems.has(key) : false;
    };

    // Hard-enforced mode: always scope to requested items regardless of interactive filters.
    if (state.settings.forceOnlyRequested) {
        filteredEvents = filteredEvents.filter((event) => isRequestedEvent(event));
    }

    // Then apply user-selected filters
    if (state.activeFilters.size == 0) return filteredEvents;

    const filters = Array.from(state.activeFilters);

    return filteredEvents.filter((event) => {
        const userData = state.userDataMap?.get(event.id);
        const matchesFilter = (filterType: string): boolean => {
            if (filterType === 'Watchlist') return !!userData?.isFavorite;
            if (filterType === 'Watched') return !!userData?.isWatched;
            if (filterType === 'Available') return !!event.hasFile;
            if (filterType === 'Requests') return isRequestedEvent(event);
            return event.releaseType === filterType;
        };

        const matched = state.filterMatchMode === 'all'
            ? filters.every(matchesFilter)
            : filters.some(matchesFilter);

        return state.filterInvert ? !matched : matched;
    });
}

/**
 * Group events by date
 */
export function groupEventsByDate(events: CalendarEvent[]): Record<string, CalendarEvent[]> {
    const grouped: Record<string, CalendarEvent[]> = {};

    events.forEach((event) => {
        // getEventDateKey is the single decision point: date-only releases bucket
        // by their server-supplied local day; genuine instants convert to local.
        const dateKey = getEventDateKey(event);
        if (!dateKey) return;

        if (!grouped[dateKey]) {
            grouped[dateKey] = [];
        }

        grouped[dateKey].push(event);
    });

    return grouped;
}

/**
 * Search for an item by provider IDs using the server endpoint.
 * @param event - Calendar event with provider IDs
 * @returns Item ID or null if not found
 */
export async function searchFromProviders(event: CalendarEvent, options: { preferSeries?: boolean } = {}): Promise<string | null> {
    const preferSeries = !!options.preferSeries;
    const episodeProviders: Record<string, string> = {};
    const seriesProviders: Record<string, string> = {};
    if (event.episodeImdbId) episodeProviders.Imdb = event.episodeImdbId;
    if (event.episodeTvdbId) episodeProviders.Tvdb = String(event.episodeTvdbId);
    if (event.imdbId) seriesProviders.Imdb = event.imdbId;
    if (event.tvdbId) seriesProviders.Tvdb = String(event.tvdbId);
    if (event.tmdbId) seriesProviders.Tmdb = String(event.tmdbId);

    const hasEpisodeProviders = Object.keys(episodeProviders).length > 0;
    const hasSeriesProviders = Object.keys(seriesProviders).length > 0;
    if (!hasEpisodeProviders && !hasSeriesProviders) return null;

    try {
        const lookup = async (providers: Record<string, string>): Promise<string | null> => {
            const params = new URLSearchParams();
            Object.entries(providers).forEach(([key, value]) => {
                params.append(`providers[${key}]`, value);
            });

            try {
                const itemId = await api.plugin(`/items/by-providers?${params.toString()}`) as string | null;
                return itemId || null;
            } catch (error) {
                // An HTTP error (e.g. 404) means "not found" — fall through to the
                // next provider lookup, matching the pre-core `!response.ok` path.
                if ((error as { status?: number } | null)?.status) return null;
                throw error;
            }
        };

        if (hasEpisodeProviders && !preferSeries) {
            const episodeItemId = await lookup(episodeProviders);
            if (episodeItemId) return episodeItemId;
        }

        if (hasSeriesProviders) {
            return await lookup(seriesProviders);
        }

        return null;
    } catch (error) {
        console.error(`${logPrefix} Provider search failed:`, error);
        return null;
    }
}
