// src/arr/calendar/render-views.ts
// Calendar Page — month/week/day/agenda view rendering, legend, sidebar
// collapse and the full page shell (split from calendar-page.js).

import { formatDate } from '../../core/locale';
import { JC } from '../arr-globals';
import {
    filterEvents,
    groupEventsByDate,
    state,
    STATUS_COLORS
} from './data';
import {
    formatHourLabel,
    formatRangeLabel,
    getDaysInMonth,
    getFirstDayOfMonth,
    getRangeForView,
    isTodayDate,
    renderAgendaEvent,
    renderCardItems,
    renderEvent
} from './render-events';
import type { CalendarEvent } from './data';

function getDefaultSidebarCollapsed(): boolean {
    if (window.matchMedia) {
        return window.matchMedia('(max-width: 768px)').matches;
    }

    return false;
}

function applySidebarCollapsedState(): void {
    const sidebar = document.querySelector('.jc-calendar-sidebar');
    const toggle = document.querySelector('.jc-calendar-sidebar-toggle');
    if (!sidebar || !toggle) return;

    sidebar.classList.toggle('is-collapsed', !!state.sidebarCollapsed);
    toggle.setAttribute('aria-expanded', state.sidebarCollapsed ? 'false' : 'true');
}

function setSidebarCollapsed(collapsed: boolean): void {
    state.sidebarCollapsed = !!collapsed;
    applySidebarCollapsedState();
}

export function toggleSidebarCollapsed(): void {
    if (typeof state.sidebarCollapsed !== 'boolean') {
        state.sidebarCollapsed = getDefaultSidebarCollapsed();
    }
    setSidebarCollapsed(!state.sidebarCollapsed);
}

export function updateDisplayModeButtons(): void {
    const buttons = document.querySelectorAll<HTMLElement>('.jc-calendar-mode-btn');
    buttons.forEach((btn) => {
        const mode = btn.dataset.mode;
        btn.classList.toggle('active', mode === state.settings.displayMode);
    });
}

// Render month grid view
function renderMonthView(): string {
    const anchor = new Date(state.currentDate);
    anchor.setHours(0, 0, 0, 0);
    anchor.setDate(1);

    const daysInMonth = getDaysInMonth(anchor);
    const firstDay = getFirstDayOfMonth(anchor);
    let filteredEvents = filterEvents(state.events);
    if (JC.hiddenContent?.filterCalendarEvents) filteredEvents = JC.hiddenContent.filterCalendarEvents(filteredEvents);
    const groupedEvents = groupEventsByDate(filteredEvents);
    if (filteredEvents.length === 0) {
        return `<div class="jc-calendar-empty">${JC.t?.('calendar_no_releases')}</div>`;
    }

    const daysOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const firstDayOfWeekIndex = daysOfWeek.indexOf(state.settings.firstDayOfWeek);
    const orderedDaysOfWeek = [...daysOfWeek.slice(firstDayOfWeekIndex), ...daysOfWeek.slice(0, firstDayOfWeekIndex)];

    let html = '<div class="jc-calendar-month">';
    html += '<div class="jc-calendar-weekdays">';
    orderedDaysOfWeek.forEach((day) => {
        html += `<div class="jc-calendar-weekday">${day.substring(0, 3)}</div>`;
    });
    html += '</div>';
    html += '<div class="jc-calendar-month-grid">';

    for (let i = 0; i < firstDay; i++) {
        html += '<div class="jc-calendar-day jc-calendar-day-placeholder" style="opacity: 0.3;"></div>';
    }

    for (let day = 1; day <= daysInMonth; day++) {
        const year = anchor.getFullYear();
        const month = String(anchor.getMonth() + 1).padStart(2, '0');
        const dayStr = String(day).padStart(2, '0');
        const dateStr = `${year}-${month}-${dayStr}`;

        const dayEvents = groupedEvents[dateStr] || [];
        dayEvents.sort((a, b) => new Date(a.releaseDate as string).getTime() - new Date(b.releaseDate as string).getTime());

        const dayDate = new Date(year, anchor.getMonth(), day);
        const todayClass = isTodayDate(dayDate) ? ' jc-calendar-today' : '';
        const weekdayLabel = daysOfWeek[dayDate.getDay()].substring(0, 3);
        html += `
        <div class="jc-calendar-day${todayClass}">
          <div class="jc-calendar-day-header">
            <span class="jc-calendar-day-number">${day}</span>
            <span class="jc-calendar-month-day-name">${weekdayLabel}</span>
          </div>
          <div class="${state.settings.displayMode === 'cards' ? 'jc-calendar-day-cards' : 'jc-calendar-events-list'}">
            ${state.settings.displayMode === 'cards' ? renderCardItems(dayEvents) : dayEvents.map((event) => renderEvent(event)).join('')}
          </div>
        </div>
      `;
    }

    html += '</div></div>';
    return html;
}

// Render week grid view
function renderWeekView(): string {
    const { start } = getRangeForView(state.currentDate, 'week');
    const daysOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    let filteredEvents = filterEvents(state.events);
    if (JC.hiddenContent?.filterCalendarEvents) filteredEvents = JC.hiddenContent.filterCalendarEvents(filteredEvents);
    const groupedEvents = groupEventsByDate(filteredEvents);
    if (filteredEvents.length === 0) {
        return `<div class="jc-calendar-empty">${JC.t?.('calendar_no_releases')}</div>`;
    }

    let html = '<div class="jc-calendar-grid">';

    for (let i = 0; i < 7; i++) {
        const day = new Date(start);
        day.setDate(start.getDate() + i);
        const year = day.getFullYear();
        const month = String(day.getMonth() + 1).padStart(2, '0');
        const dayNum = String(day.getDate()).padStart(2, '0');
        const dateKey = `${year}-${month}-${dayNum}`;
        const dayEvents = groupedEvents[dateKey] || [];
        dayEvents.sort((a, b) => new Date(a.releaseDate as string).getTime() - new Date(b.releaseDate as string).getTime());

        const todayClass = isTodayDate(day) ? ' jc-calendar-today' : '';
        html += `
        <div class="jc-calendar-day${todayClass}">
          <div class="jc-calendar-day-header">
            <span class="jc-calendar-day-number">${day.getDate()}</span>
            <span class="jc-calendar-day-name">${daysOfWeek[day.getDay()].substring(0, 3)}</span>
          </div>
          <div class="${state.settings.displayMode === 'cards' ? 'jc-calendar-day-cards' : 'jc-calendar-events-list'}">
            ${state.settings.displayMode === 'cards' ? renderCardItems(dayEvents) : dayEvents.map((event) => renderEvent(event)).join('')}
          </div>
        </div>
      `;
    }

    html += '</div>';
    return html;
}

// Render agenda list view
function renderAgendaView(): string {
    let filteredEvents = filterEvents(state.events);
    if (JC.hiddenContent?.filterCalendarEvents) filteredEvents = JC.hiddenContent.filterCalendarEvents(filteredEvents);
    const groupedEvents = groupEventsByDate(filteredEvents);
    const dates = Object.keys(groupedEvents).sort();

    if (dates.length === 0) {
        return `<div class="jc-calendar-empty">${JC.t?.('calendar_no_releases')}</div>`;
    }

    let html = '<div class="jc-calendar-agenda">';
    dates.forEach((dateKey) => {
        const [year, month, day] = dateKey.split('-');
        const dateObj = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
        const weekday = formatDate(dateObj, { weekday: 'short' });
        const monthDay = formatDate(dateObj, { month: 'short', day: 'numeric' });

        const dayEvents = groupedEvents[dateKey] || [];
        dayEvents.sort((a, b) => new Date(a.releaseDate as string).getTime() - new Date(b.releaseDate as string).getTime());

        html += `
        <div class="jc-calendar-agenda-row">
          <div class="jc-calendar-agenda-date">
            <div>${weekday}, ${monthDay}</div>
          </div>
          <div class="jc-calendar-agenda-events">
            ${dayEvents.map((event) => renderAgendaEvent(event)).join('')}
          </div>
        </div>
      `;
    });

    html += '</div>';
    return html;
}

function renderDayView(): string {
    const filteredEvents = filterEvents(state.events);
    const groupedEvents = groupEventsByDate(filteredEvents);
    const current = new Date(state.currentDate);
    const dateKey = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}-${String(current.getDate()).padStart(2, '0')}`;
    const dayEvents = groupedEvents[dateKey] || [];
    dayEvents.sort((a, b) => new Date(a.releaseDate as string).getTime() - new Date(b.releaseDate as string).getTime());

    if (dayEvents.length === 0) {
        return `<div class="jc-calendar-empty">${JC.t?.('calendar_no_releases')}</div>`;
    }

    if (state.settings.displayMode === 'cards') {
        return `
        <div class="jc-calendar-dayline jc-calendar-day-cards">
          ${renderCardItems(dayEvents)}
        </div>
      `;
    }

    const groups: { allDay: CalendarEvent[]; hours: Map<number, CalendarEvent[]> } = { allDay: [], hours: new Map() };
    dayEvents.forEach((event) => {
        const date = new Date(event.releaseDate as string);
        if (Number.isNaN(date.getTime())) {
            groups.allDay.push(event);
            return;
        }
        const hasTime = !(date.getHours() === 0 && date.getMinutes() === 0);
        if (!hasTime) {
            groups.allDay.push(event);
            return;
        }
        const hour = date.getHours();
        if (!groups.hours.has(hour)) groups.hours.set(hour, []);
        (groups.hours.get(hour) as CalendarEvent[]).push(event);
    });

    let html = '<div class="jc-calendar-day-hours">';
    const allDayLabel = JC.t?.('calendar_all_day') || 'All day';
    if (groups.allDay.length) {
        const allDayEvents = groups.allDay;
        const allDayClass = state.settings.displayMode === 'cards'
            ? 'jc-calendar-hour-events jc-calendar-day-cards'
            : 'jc-calendar-hour-events';
        html += `
        <div class="jc-calendar-hour-row">
          <div class="jc-calendar-hour-label">${allDayLabel}</div>
          <div class="${allDayClass}">
            ${state.settings.displayMode === 'cards' ? renderCardItems(allDayEvents) : allDayEvents.map((event) => renderEvent(event)).join('')}
          </div>
        </div>
      `;
    }

    for (let hour = 0; hour < 24; hour += 1) {
        const hourEvents = groups.hours.get(hour);
        if (!hourEvents || hourEvents.length === 0) continue;
        const hourClass = state.settings.displayMode === 'cards'
            ? 'jc-calendar-hour-events jc-calendar-day-cards'
            : 'jc-calendar-hour-events';
        html += `
        <div class="jc-calendar-hour-row">
          <div class="jc-calendar-hour-label">${formatHourLabel(hour)}</div>
          <div class="${hourClass}">
            ${state.settings.displayMode === 'cards' ? renderCardItems(hourEvents) : hourEvents.map((event) => renderEvent(event)).join('')}
          </div>
        </div>
      `;
    }

    html += '</div>';
    return html;
}

// Render calendar based on current view mode
function renderCalendar(): string {
    // A backend failure must show an explicit ERROR state, not the per-view
    // "No upcoming releases" empty message that a genuinely empty range shows.
    if (state.eventsError) {
        return `<div class="jc-calendar-empty jc-error-state">${JC.t?.('calendar_load_error') || 'Unable to load calendar'}</div>`;
    }
    if (state.viewMode === 'week') return renderWeekView();
    if (state.viewMode === 'agenda') return renderAgendaView();
    if (state.viewMode === 'day') return renderDayView();
    return renderMonthView();
}

// Render color legend
function renderLegend(): string {
    const hasActiveFilters = state.activeFilters.size > 0;
    const getItemClass = (filterType: string): string => {
        if (!hasActiveFilters) return '';
        return state.activeFilters.has(filterType) ? 'active' : 'inactive';
    };

    const showRequestsFilter = !!JC.pluginConfig?.JellyseerrEnabled && !state.settings.forceOnlyRequested;
    const requestsLabel = JC.t?.('requests_requests') || 'Requests';
    const requestsLegend = showRequestsFilter
        ? `<div class="jc-calendar-legend-item ${getItemClass('Requests')}" onclick="window.JellyfinCanopy.calendarPage.toggleFilter('Requests'); event.stopPropagation();">
          <span class="material-symbols-rounded" style="color: #6f63f2; font-size: 18px;">download</span>
          <span>${requestsLabel}</span>
        </div>`
        : '';

    const watchlistLegend = state.settings.highlightFavorites
        ? `<div class="jc-calendar-legend-item ${getItemClass('Watchlist')}" onclick="window.JellyfinCanopy.calendarPage.toggleFilter('Watchlist'); event.stopPropagation();">
          <span class="material-symbols-rounded" style="color: #ffd700; font-size: 18px; font-variation-settings: 'FILL' 1;">bookmark</span>
          <span>${JC.t?.('calendar_watchlist')}</span>
        </div>`
        : '';

    const watchedLegend = state.settings.highlightWatchedSeries
        ? `<div class="jc-calendar-legend-item ${getItemClass('Watched')}" onclick="window.JellyfinCanopy.calendarPage.toggleFilter('Watched'); event.stopPropagation();">
          <span class="material-symbols-rounded" style="color: #64b5f6; font-size: 18px;">visibility</span>
          <span>${JC.t?.('calendar_watched')}</span>
        </div>`
        : '';

    const hasTwoFilters = state.activeFilters.size >= 2;
    const unmonitoredLegend = `<div class="jc-calendar-legend-item jc-calendar-unmonitored-toggle ${state.settings.showUnmonitored ? 'active' : hasActiveFilters ? 'inactive' : ''}" onclick="window.JellyfinCanopy.calendarPage.toggleShowUnmonitored(); event.stopPropagation();" style="cursor: pointer;">
        <span class="material-symbols-rounded" style="color: #ff9800; font-size: 18px;">${state.settings.showUnmonitored ? 'visibility' : 'visibility_off'}</span>
        <span>${JC.t?.('calendar_include_unmonitored') || 'Unmonitored'}</span>
      </div>`;
    const filterControls = `
      <div class="jc-calendar-filter-controls">
        <div class="jc-calendar-filter-toggle ${hasTwoFilters ? '' : 'is-disabled'}" role="group" aria-label="Filter mode">
          <button type="button" class="jc-calendar-filter-btn ${state.filterMatchMode === 'any' ? 'active' : ''}" data-filter-mode="any" ${hasTwoFilters ? '' : 'disabled aria-disabled="true"'}>OR</button>
          <button type="button" class="jc-calendar-filter-btn ${state.filterMatchMode === 'all' ? 'active' : ''}" data-filter-mode="all" ${hasTwoFilters ? '' : 'disabled aria-disabled="true"'}>AND</button>
        </div>
        <button type="button" class="jc-calendar-filter-invert ${state.filterInvert ? 'active' : ''} ${hasActiveFilters ? '' : 'is-disabled'}" data-filter-invert="true" ${hasActiveFilters ? '' : 'disabled aria-disabled="true"'}>NOT</button>
      </div>`;

    return `
      <div class="jc-calendar-legend">
        ${filterControls}
        <div class="jc-calendar-legend-item ${getItemClass('CinemaRelease')}" onclick="window.JellyfinCanopy.calendarPage.toggleFilter('CinemaRelease'); event.stopPropagation();">
          <span class="material-symbols-rounded" style="color: ${STATUS_COLORS.CinemaRelease}; font-size: 18px;">local_movies</span>
          <span>${JC.t?.('calendar_cinema_release')}</span>
        </div>
        <div class="jc-calendar-legend-item ${getItemClass('DigitalRelease')}" onclick="window.JellyfinCanopy.calendarPage.toggleFilter('DigitalRelease'); event.stopPropagation();">
          <span class="material-symbols-rounded" style="color: ${STATUS_COLORS.DigitalRelease}; font-size: 18px;">ondemand_video</span>
          <span>${JC.t?.('calendar_digital_release')}</span>
        </div>
        <div class="jc-calendar-legend-item ${getItemClass('PhysicalRelease')}" onclick="window.JellyfinCanopy.calendarPage.toggleFilter('PhysicalRelease'); event.stopPropagation();">
          <span class="material-symbols-rounded" style="color: ${STATUS_COLORS.PhysicalRelease}; font-size: 18px;">album</span>
          <span>${JC.t?.('calendar_physical_release')}</span>
        </div>
        <div class="jc-calendar-legend-item ${getItemClass('Episode')}" onclick="window.JellyfinCanopy.calendarPage.toggleFilter('Episode'); event.stopPropagation();">
          <span class="material-symbols-rounded" style="color: ${STATUS_COLORS.Episode}; font-size: 18px;">tv_guide</span>
          <span>${JC.t?.('calendar_episode')}</span>
        </div>
        <div class="jc-calendar-legend-item ${getItemClass('Available')}" onclick="window.JellyfinCanopy.calendarPage.toggleFilter('Available'); event.stopPropagation();">
          <span class="material-symbols-rounded" style="color: #4caf50; font-size: 18px;">check_circle</span>
          <span>${JC.t?.('jellyseerr_btn_available') || 'Available'}</span>
        </div>
        ${requestsLegend}
        ${watchlistLegend}
        ${watchedLegend}
        ${unmonitoredLegend}
      </div>
    `;
}

// Create or get page container element
export function createPageContainer(): HTMLElement {
    let page = document.getElementById('jc-calendar-page');
    if (!page) {
        page = document.createElement('div');
        page.id = 'jc-calendar-page';
        page.className = 'page type-interior mainAnimatedPage hide';
        page.setAttribute('data-title', 'Calendar');
        page.setAttribute('data-backbutton', 'true');
        page.setAttribute('data-url', '#/calendar');
        page.setAttribute('data-type', 'custom');
        page.innerHTML = `
        <div data-role="content">
          <div class="content-primary jc-calendar-page">
            <div id="jc-calendar-container" class="jc-interior-page-top" style="padding-left: 0.5em; padding-right: 0.5em;"></div>
          </div>
        </div>
      `;

        const mainContent = document.querySelector('.mainAnimatedPages');
        if (mainContent) {
            mainContent.appendChild(page);
        } else {
            document.body.appendChild(page);
        }
    }

    return page;
}

/**
 * Render the full page.
 * @param targetContainer - Optional container to render into
 *   (used by custom-tab mode to avoid duplicate-ID conflicts).
 */
export function renderPage(targetContainer?: HTMLElement): void {
    syncPageModeClasses();
    let container: HTMLElement | null;
    if (targetContainer) {
        state._customTabContainer = targetContainer;
        container = targetContainer;
    } else if (state._customTabContainer && document.contains(state._customTabContainer)
        && window.location.hash.indexOf('userpluginsettings') === -1) {
        // Re-use stored custom tab container, but not on Plugin Pages route
        container = state._customTabContainer;
    } else {
        state._customTabContainer = null;
        const page = createPageContainer();
        container = document.getElementById('jc-calendar-container');
        if (!page || !container) return;
    }

    if (typeof state.sidebarCollapsed !== 'boolean') {
        state.sidebarCollapsed = getDefaultSidebarCollapsed();
    }

    container.innerHTML = `
      <div class="jc-calendar-header">
        <h1 class="jc-calendar-title">${formatRangeLabel()}</h1>
        <div class="jc-calendar-actions jc-calendar-actions-center">
          <div class="jc-calendar-nav">
            <div class="jc-calendar-nav-group">
              <button class="jc-calendar-nav-btn" onclick="window.JellyfinCanopy.calendarPage.shiftPeriod('prev'); event.stopPropagation();" aria-label="${JC.t?.('calendar_prev')}">‹</button>
              <button class="jc-calendar-nav-btn jc-calendar-nav-today" onclick="window.JellyfinCanopy.calendarPage.goToday(); event.stopPropagation();">${JC.t?.('calendar_today')}</button>
              <button class="jc-calendar-nav-btn" onclick="window.JellyfinCanopy.calendarPage.shiftPeriod('next'); event.stopPropagation();" aria-label="${JC.t?.('calendar_next')}">›</button>
            </div>
          </div>
        </div>
        <div class="jc-calendar-actions jc-calendar-actions-right">
          <div class="jc-calendar-nav">
            <button class="jc-calendar-view-btn ${state.viewMode === 'day' ? 'active' : ''}" onclick="window.JellyfinCanopy.calendarPage.setViewMode('day'); event.stopPropagation();">${JC.t?.('calendar_day') || 'Day'}</button>
            <button class="jc-calendar-view-btn ${state.viewMode === 'week' ? 'active' : ''}" onclick="window.JellyfinCanopy.calendarPage.setViewMode('week'); event.stopPropagation();">${JC.t?.('calendar_week')}</button>
            <button class="jc-calendar-view-btn ${state.viewMode === 'month' ? 'active' : ''}" onclick="window.JellyfinCanopy.calendarPage.setViewMode('month'); event.stopPropagation();">${JC.t?.('calendar_month')}</button>
            <button class="jc-calendar-view-btn ${state.viewMode === 'agenda' ? 'active' : ''}" onclick="window.JellyfinCanopy.calendarPage.setViewMode('agenda'); event.stopPropagation();">${JC.t?.('calendar_agenda')}</button>
            <div class="jc-calendar-mode-toggle ${state.viewMode === 'agenda' ? 'is-disabled' : ''}" role="group" aria-label="Display mode">
              <button type="button" class="jc-calendar-mode-btn ${state.settings.displayMode === 'list' ? 'active' : ''}" title="List" aria-label="List" data-mode="list" ${state.viewMode === 'agenda' ? 'disabled aria-disabled="true"' : ''}>
                <span class="material-icons">view_list</span>
              </button>
              <button type="button" class="jc-calendar-mode-btn ${state.settings.displayMode === 'backdrop' ? 'active' : ''}" title="Backdrop" aria-label="Backdrop" data-mode="backdrop" ${state.viewMode === 'agenda' ? 'disabled aria-disabled="true"' : ''}>
                <span class="material-icons">image</span>
              </button>
              <button type="button" class="jc-calendar-mode-btn ${state.settings.displayMode === 'cards' ? 'active' : ''}" title="Cards" aria-label="Cards" data-mode="cards" ${state.viewMode === 'agenda' ? 'disabled aria-disabled="true"' : ''}>
                <span class="material-icons">view_module</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      ${state.isLoading ? `<div class="jc-calendar-empty">${JC.t?.('calendar_loading')}</div>` : ''}

        <div class="jc-calendar-layout">
          <div class="jc-calendar-main">
            ${!state.isLoading ? renderCalendar() : ''}
          </div>
          <aside class="jc-calendar-sidebar${state.sidebarCollapsed ? ' is-collapsed' : ''}">
            <button type="button" class="jc-calendar-sidebar-toggle" aria-expanded="${state.sidebarCollapsed ? 'false' : 'true'}" aria-controls="jc-calendar-sidebar-content">
              <span class="material-icons jc-calendar-sidebar-toggle-icon">expand_more</span>
            </button>
            <div class="jc-calendar-sidebar-content" id="jc-calendar-sidebar-content">
              ${renderLegend().replace('jc-calendar-legend"', 'jc-calendar-legend jc-calendar-legend-vertical"')}
            </div>
          </aside>
        </div>

      ${
        ''
    }
    `;

    applySidebarCollapsedState();
}

export function syncPageModeClasses(): void {
    const nodes = document.querySelectorAll('.jc-calendar-page, .content-primary.jc-calendar-page');
    if (!nodes.length) return;
    nodes.forEach((node) => {
        node.classList.remove('jc-view-day', 'jc-view-week', 'jc-view-month', 'jc-view-agenda');
        node.classList.remove('jc-display-list', 'jc-display-backdrop', 'jc-display-cards');
        if (state.viewMode) {
            node.classList.add(`jc-view-${state.viewMode}`);
        }
        if (state.settings.displayMode) {
            node.classList.add(`jc-display-${state.settings.displayMode}`);
        }
    });
}
