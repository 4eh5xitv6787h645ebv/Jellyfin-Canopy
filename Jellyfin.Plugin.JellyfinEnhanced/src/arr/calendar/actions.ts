// src/arr/calendar-page-actions.ts (formerly js/arr/calendar-page-actions.js)
// Calendar Page — user actions: data refresh, view/display mode switching,
// filter toggles and event-click navigation (split from calendar-page.js).

import { JE } from '../arr-globals';
import {
    ensureRequestData,
    fetchCalendarEvents,
    fetchUserData,
    searchFromProviders,
    setStoredShowUnmonitored,
    state
} from './data';
import {
    getRangeForView
} from './render-events';
import {
    renderPage,
    syncPageModeClasses,
    toggleSidebarCollapsed,
    updateDisplayModeButtons
} from './render-views';
import type { CalendarEvent } from './data';

const logPrefix = '🪼 Jellyfin Enhanced: Calendar Page:';

/**
 * Load all data
 */
export async function loadAllData(): Promise<void> {
    state.isLoading = true;
    renderPage();

    const { start, end } = getRangeForView(state.currentDate, state.viewMode);
    state.rangeStart = start;
    state.rangeEnd = end;

    // First fetch calendar events
    await fetchCalendarEvents(start, end);

    // Then fetch user data for those specific events
    await fetchUserData();

    if (state.activeFilters.has('Requests') || state.settings.forceOnlyRequested) {
        await ensureRequestData();
    }

    state.isLoading = false;
    renderPage();
}

// Switch between month/week/agenda views
export function setViewMode(mode: string): void {
    if (state.viewMode === mode) return;
    state.viewMode = mode;
    syncPageModeClasses();

    JE.currentSettings = JE.currentSettings || JE.loadSettings?.() || {};
    JE.currentSettings.calendarDefaultViewMode = mode;
    if (typeof JE.saveUserSettings === 'function') {
        void JE.saveUserSettings('settings.json', JE.currentSettings);
    }

    void loadAllData();
}

export function setDisplayMode(mode: string): void {
    if (!mode || state.settings.displayMode === mode) return;
    state.settings.displayMode = mode;
    syncPageModeClasses();
    JE.currentSettings = JE.currentSettings || JE.loadSettings?.() || {};
    JE.currentSettings.calendarDisplayMode = mode;
    if (typeof JE.saveUserSettings === 'function') {
        void JE.saveUserSettings('settings.json', JE.currentSettings);
    }

    if (state.viewMode === 'agenda') {
        updateDisplayModeButtons();
        return;
    }

    renderPage();
}

// Navigate forward or backward
export function shiftPeriod(direction: string): void {
    const delta = direction === 'next' ? 1 : -1;
    const current = new Date(state.currentDate);

    if (state.viewMode === 'month') {
        current.setDate(1);
        current.setMonth(current.getMonth() + delta);
    } else if (state.viewMode === 'week') {
        current.setDate(current.getDate() + delta * 7);
    } else if (state.viewMode === 'day') {
        current.setDate(current.getDate() + delta);
    } else {
        current.setDate(current.getDate() + delta * 30);
    }

    state.currentDate = current;
    void loadAllData();
}

// Jump to today's date
export function goToday(): void {
    state.currentDate = new Date();
    void loadAllData();
}

// Toggle filter on/off
export function toggleFilter(filterType: string): void {
    if (state.settings.forceOnlyRequested && filterType === 'Requests') {
        return;
    }

    if (state.activeFilters.has(filterType)) {
        state.activeFilters.delete(filterType);
    } else {
        state.activeFilters.add(filterType);
        if (filterType === 'Requests') {
            void ensureRequestData();
        }
    }
    renderPage();
}

export function setFilterMatchMode(mode: string): void {
    if (!mode || (mode !== 'any' && mode !== 'all')) return;
    if (state.activeFilters.size < 2) return;
    if (state.filterMatchMode === mode) return;
    state.filterMatchMode = mode;
    renderPage();
}

export function toggleFilterInvert(): void {
    if (state.activeFilters.size === 0) return;
    state.filterInvert = !state.filterInvert;
    renderPage();
}

// Toggle show unmonitored series on/off
export function toggleShowUnmonitored(): void {
    state.settings.showUnmonitored = !state.settings.showUnmonitored;
    setStoredShowUnmonitored(state.settings.showUnmonitored);
    renderPage();
}

/**
 * Navigate to Jellyfin item by provider IDs
 */
async function navigateToJellyfinItem(event: CalendarEvent, options: { preferSeries?: boolean } = {}): Promise<void> {
    const preferSeries = !!options.preferSeries;
    const isMovie = event.type === 'Movie';

    if (!event.hasFile && (!preferSeries || isMovie)) return;

    const itemId = (preferSeries || isMovie)
        ? event.itemId
        : event.itemEpisodeId;

    // No need to search if itemId is already provided
    if (itemId) {
        window.location.hash = `#/details?id=${itemId}`;
        return;
    }

    if (event.itemEpisodeId && !preferSeries) {
        window.location.hash = `#/details?id=${event.itemEpisodeId}`;
        return;
    }

    try {
        const providerItemId = await searchFromProviders(event, { preferSeries });
        if (providerItemId) {
            window.location.hash = `#/details?id=${providerItemId}`;
            return;
        }
    } catch (error) {
        console.error(`${logPrefix} Navigation failed:`, error);
    }
}

/**
 * Handle click on calendar event
 */
export function handleEventClick(e: MouseEvent): void {
    const target = e.target as Element | null;

    const sidebarToggle = target?.closest('.je-calendar-sidebar-toggle');
    if (sidebarToggle) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        toggleSidebarCollapsed();
        return;
    }

    const filterModeBtn = target?.closest<HTMLElement>('.je-calendar-filter-btn');
    if (filterModeBtn) {
        const mode = filterModeBtn.dataset.filterMode;
        if (mode) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            setFilterMatchMode(mode);
        }
        return;
    }

    const filterInvertBtn = target?.closest('.je-calendar-filter-invert');
    if (filterInvertBtn) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        toggleFilterInvert();
        return;
    }

    const modeBtn = target?.closest<HTMLElement>('.je-calendar-mode-btn');
    if (modeBtn) {
        const mode = modeBtn.dataset.mode;
        if (mode) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            setDisplayMode(mode);
        }
        return;
    }

    const playBtn = target?.closest<HTMLElement>('.je-calendar-play-btn');
    if (playBtn) {
        const playEventId = playBtn.dataset.eventId;
        const playEvent = state.events.find((ev) => ev.id === playEventId);
        if (!playEvent) return;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        void navigateToJellyfinItem(playEvent, { preferSeries: false });
        return;
    }

    const timePill = target?.closest('.je-calendar-card-time');
    if (timePill) {
        const cardEl = timePill.closest<HTMLElement>('.je-calendar-card');
        const timeEventId = cardEl?.dataset.eventId;
        const timeEvent = timeEventId ? state.events.find((ev) => ev.id === timeEventId) : null;
        if (timeEvent?.hasFile) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            void navigateToJellyfinItem(timeEvent, { preferSeries: false });
            return;
        }
    }

    const eventEl = target?.closest<HTMLElement>('.je-calendar-event, .je-calendar-agenda-event, .je-calendar-card');
    if (!eventEl) return;

    const eventId = eventEl.dataset.eventId;
    if (!eventId) return;

    const event = state.events.find((ev) => ev.id === eventId);
    if (!event) return;

    e.preventDefault();
    e.stopPropagation();
    void navigateToJellyfinItem(event, { preferSeries: true });
}
