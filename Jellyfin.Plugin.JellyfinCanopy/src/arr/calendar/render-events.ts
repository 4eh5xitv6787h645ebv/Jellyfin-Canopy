// src/arr/calendar/render-events.ts
// Calendar Page — date-range helpers, event formatting and single-event /
// agenda-event / card rendering (split from calendar-page.js).

import { assetUrl } from '../../core/asset-urls';
import { formatDate, formatTime } from '../../core/locale';
import { JC } from '../arr-globals';
import { state, STATUS_COLORS } from './data';
import { getEventTimeLabel } from './event-date';
import type { CalendarEvent } from './data';

const escapeHtml = JC.escapeHtml;

// PERF(R6): no remote assets — arr icons served from the local asset cache.
const SONARR_ICON_URL = assetUrl('icons/sonarr.svg');
const RADARR_ICON_URL = assetUrl('icons/radarr-light-hybrid-light.svg');

// Get start and end dates for current view
export function getRangeForView(anchorDate: Date, viewMode: string): { start: Date; end: Date } {
    const start = new Date(
        anchorDate.getFullYear(),
        anchorDate.getMonth(),
        anchorDate.getDate(),
        0, 0, 0, 0
    );

    if (viewMode === 'month') {
        start.setDate(1);
        const end = new Date(
            start.getFullYear(),
            start.getMonth() + 1,
            0,
            23, 59, 59, 999
        );
        return { start, end };
    }

    if (viewMode === 'week') {
        const daysOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const firstDayIndex = daysOfWeek.indexOf(state.settings.firstDayOfWeek);
        const currentDayIndex = start.getDay();
        const diff = (currentDayIndex - firstDayIndex + 7) % 7;
        start.setDate(start.getDate() - diff);

        const end = new Date(start);
        end.setDate(start.getDate() + 6);
        end.setHours(23, 59, 59, 999);
        return { start, end };
    }

    if (viewMode === 'day') {
        const endDay = new Date(start);
        endDay.setHours(23, 59, 59, 999);
        return { start, end: endDay };
    }

    const endAgenda = new Date(start);
    endAgenda.setDate(start.getDate() + 29);
    endAgenda.setHours(23, 59, 59, 999);
    return { start, end: endAgenda };
}

/**
 * Get days in month
 */
export function getDaysInMonth(date: Date): number {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

/**
 * Get first day of month
 */
export function getFirstDayOfMonth(date: Date): number {
    const firstDay = new Date(date.getFullYear(), date.getMonth(), 1);
    const dayOfWeek = firstDay.getDay();

    // Convert based on first day of week setting
    const daysOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const firstDayOfWeek = daysOfWeek.indexOf(state.settings.firstDayOfWeek);

    return (dayOfWeek - firstDayOfWeek + 7) % 7;
}

export function isTodayDate(date: Date): boolean {
    const now = new Date();
    return date.getFullYear() === now.getFullYear()
        && date.getMonth() === now.getMonth()
        && date.getDate() === now.getDate();
}

/**
 * Get event color
 */
function getEventColor(event: CalendarEvent): string {
    const map: Record<string, string> = {
        CinemaRelease: STATUS_COLORS.CinemaRelease,
        DigitalRelease: STATUS_COLORS.DigitalRelease,
        PhysicalRelease: STATUS_COLORS.PhysicalRelease,
        Episode: STATUS_COLORS.Episode,
    };

    const themeVars = JC.themer?.getThemeVariables?.() || {};
    const primaryAccent = themeVars.primaryAccent || '#00a4dc';
    return map[event.releaseType as string] || primaryAccent;
}

// Get translated release type label
function formatReleaseLabel(event: CalendarEvent): string {
    if (event.releaseType === 'CinemaRelease') return JC.t?.('calendar_cinema_release') ?? '';
    if (event.releaseType === 'DigitalRelease') return JC.t?.('calendar_digital_release') ?? '';
    if (event.releaseType === 'PhysicalRelease') return JC.t?.('calendar_physical_release') ?? '';
    if (event.releaseType === 'Episode') return JC.t?.('calendar_episode') ?? '';
    return 'Release';
}

// Format date range label for header
export function formatRangeLabel(): string {
    if (!state.rangeStart || !state.rangeEnd) {
        return formatDate(new Date(state.currentDate), { month: 'long', year: 'numeric' });
    }

    if (state.viewMode === 'month') {
        return formatDate(new Date(state.currentDate), { month: 'long', year: 'numeric' });
    }

    const startLabel = formatDate(state.rangeStart, { month: 'short', day: 'numeric' });
    const endLabel = formatDate(state.rangeEnd, { month: 'short', day: 'numeric' });

    if (state.viewMode === 'week') {
        return `${startLabel} - ${endLabel}`;
    }

    if (state.viewMode === 'day') {
        const dayLabel = JC.t?.('calendar_day') || 'Day';
        const relativeLabel = getRelativeDayLabel(state.rangeStart);
        return `${dayLabel} • ${relativeLabel}`;
    }

    return `${JC.t?.('calendar_agenda') ?? ''} • ${startLabel} → ${endLabel}`;
}

function getRelativeDayLabel(date: Date): string {
    const d = new Date(date);
    const today = new Date();
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const targetStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diffDays = Math.round((targetStart.getTime() - todayStart.getTime()) / 86400000);

    if (diffDays === 0) return JC.t?.('calendar_today') ?? '';
    if (diffDays === -1) return JC.t?.('calendar_yesterday') ?? '';
    if (diffDays === 1) return JC.t?.('calendar_tomorrow') ?? '';
    return formatDate(targetStart, { month: 'short', day: 'numeric' });
}

export function formatHourLabel(hour: number): string {
    const hour12 = state.settings.timeFormat === '5pm/5:30pm';
    const base = new Date(2000, 0, 1, hour, 0, 0, 0);
    return formatTime(base, { hour: 'numeric', minute: '2-digit', hour12 });
}

/**
 * Build tooltip text for calendar event
 */
function buildEventTooltip(event: CalendarEvent): string {
    let tooltip = event.title ?? '';

    // Add episode info for series (e.g., "S01E05 - Episode Title")
    if (event.type === 'Series' && event.subtitle) {
        tooltip += ` ${event.subtitle}`;
    }

    return tooltip;
}

function renderStatusIcons(event: CalendarEvent): string {
    const userData = state.userDataMap?.get(event.id);
    const watchlistLabel = JC.t?.('calendar_watchlist') || 'Watchlist';
    const watchedLabel = JC.t?.('calendar_watched') || 'Watched';
    const icons: string[] = [];

    if (state.settings.highlightFavorites && userData?.isFavorite) {
        icons.push(`<span class="jc-calendar-status-icon jc-status-watchlist material-symbols-rounded" title="${watchlistLabel}" aria-label="${watchlistLabel}">bookmark</span>`);
    }
    if (state.settings.highlightWatchedSeries && userData?.isWatched) {
        icons.push(`<span class="jc-calendar-status-icon jc-status-watched material-symbols-rounded" title="${watchedLabel}" aria-label="${watchedLabel}">visibility</span>`);
    }

    if (!icons.length) return '';
    return `<span class="jc-calendar-status-icons">${icons.join('')}</span>`;
}

/**
 * Build the display label for the instance badge on a calendar event.
 * Join all instances so the badge reads e.g. "Radarr, Radarr4K" instead of just "Radarr".
 */
function buildInstanceLabel(event: CalendarEvent): string {
    const primary = event.instanceName || event.source || '';
    if (!Array.isArray(event.alsoInInstances) || event.alsoInInstances.length === 0) {
        return primary;
    }
    const all = [primary, ...event.alsoInInstances];
    return all.join(', ');
}

function buildTimePill(event: CalendarEvent): string {
    const timeLabel = getEventTimeLabel(event);
    if (!timeLabel) return '';

    const releaseDate = event.releaseDate ? new Date(event.releaseDate) : null;
    const releaseTime = releaseDate && !Number.isNaN(releaseDate.getTime()) ? releaseDate.getTime() : null;
    const nowTime = Date.now();
    const isPast = releaseTime !== null && releaseTime <= nowTime;
    const isLate = releaseTime !== null && (nowTime - releaseTime) >= 24 * 60 * 60 * 1000;
    const timePillClass = event.hasFile
        ? 'jc-calendar-card-time is-available'
        : (isLate ? 'jc-calendar-card-time is-late is-unavailable' : (isPast ? 'jc-calendar-card-time is-past is-unavailable' : 'jc-calendar-card-time is-unavailable'));

    const labelHtml = timeLabel ? `<span class="jc-calendar-card-time-label">${escapeHtml(timeLabel)}</span>` : '';
    return `<div class="${timePillClass}">${labelHtml}</div>`;
}

function formatTimeText(event: CalendarEvent): string {
    const timeLabel = getEventTimeLabel(event);
    return timeLabel ? `<span style="opacity: 0.85; font-size: 1em;">${escapeHtml(timeLabel)}</span>` : '';
}

function normalizeImageUrl(url: string): string {
    return encodeURI(url).replace(/'/g, '%27');
}

function getEventBackgroundStyle(event: CalendarEvent, color: string): string {
    if (state.settings.displayMode !== 'backdrop') {
        return `background: ${color}20;`;
    }
    const imageUrl = event.backdropUrl || event.posterUrl;
    if (!imageUrl) {
        return `background: ${color}20;`;
    }

    const overlay = 'rgba(0, 0, 0, 0.6)';
    const safeUrl = normalizeImageUrl(imageUrl);
    return `background-image: linear-gradient(${overlay}, ${overlay}), url('${safeUrl}'); background-size: cover; background-position: center; background-repeat: no-repeat;`;
}

/**
 * Render calendar event
 */
export function renderEvent(event: CalendarEvent): string {
    const color = getEventColor(event);
    const releaseTypeLabel = formatReleaseLabel(event);
    const typeIcon = event.type === 'Series' ? SONARR_ICON_URL : RADARR_ICON_URL;
    const sourceLabelRaw = buildInstanceLabel(event);
    const sourceLabel = escapeHtml(sourceLabelRaw);
    const iconClass = event.source === 'Sonarr' ? 'jc-calendar-sonarr-icon' : 'jc-calendar-radarr-icon';
    const subtitle = event.subtitle ? `<span class="jc-calendar-event-subtitle">${escapeHtml(event.subtitle)}</span>` : '';
    const hasFileClass = event.hasFile ? ' jc-has-file' : '';
    const tooltip = buildEventTooltip(event);
    const hasBackdropClass = (state.settings.displayMode === 'backdrop' && (event.backdropUrl || event.posterUrl)) ? ' jc-has-backdrop' : '';
    const statusIcons = renderStatusIcons(event);
    const statusTop = statusIcons ? `<div class="jc-calendar-event-status-top">${statusIcons}</div>` : '';
    const timeText = formatTimeText(event);
    const playButton = event.hasFile ? `<button class="jc-calendar-play-btn" title="${JC.t?.('seerr_btn_available')}" aria-label="${JC.t?.('seerr_btn_available')}" data-event-id="${escapeHtml(event.id)}"><span class="material-icons">play_arrow</span></button>` : '';
    const backgroundStyle = getEventBackgroundStyle(event, color);

    return `
      <div class="jc-calendar-event${hasFileClass}${hasBackdropClass}" style="border-left-color: ${color}; ${backgroundStyle}" title="${escapeHtml(tooltip)}" data-event-id="${escapeHtml(event.id)}">
        ${statusTop}
        <span class="jc-calendar-event-title">${escapeHtml(event.title)}</span>
        ${subtitle}
        <div class="jc-calendar-event-type">
          <img src="${typeIcon}" alt="${escapeHtml(event.type)}" class="${iconClass}" />
          <span>${releaseTypeLabel} • <span class="jc-arr-badge" title="${sourceLabel}">${sourceLabel}</span></span>
          ${timeText ? ` • ${timeText}` : ''}${playButton}
        </div>
      </div>
    `;
}

// Render single event in agenda view
export function renderAgendaEvent(event: CalendarEvent): string {
    const color = getEventColor(event);
    const releaseTypeLabel = formatReleaseLabel(event);
    const typeIcon = event.type === 'Series' ? SONARR_ICON_URL : RADARR_ICON_URL;
    const sourceLabelRaw = buildInstanceLabel(event);
    const sourceLabel = escapeHtml(sourceLabelRaw);
    const iconClass = event.source === 'Sonarr' ? 'jc-sonarr-icon' : 'jc-radarr-icon';
    const subtitle = event.subtitle || '';
    const timeLabel = getEventTimeLabel(event);
    const hasFileClass = event.hasFile ? ' jc-has-file' : '';

    // Build indicators array (only add if they exist)
    const indicators: string[] = [];
    if (event.hasFile) {
        indicators.push(`<button class="jc-calendar-play-btn" title="${JC.t?.('seerr_btn_available')}" aria-label="${JC.t?.('seerr_btn_available')}" data-event-id="${escapeHtml(event.id)}"><span class="material-icons">play_arrow</span></button>`);
    }
    const statusIcons = renderStatusIcons(event);
    if (statusIcons) {
        indicators.push(statusIcons);
    }

    // Get material icon based on release type
    let materialIcon = 'movie';
    if (event.releaseType === 'CinemaRelease') materialIcon = 'local_movies';
    else if (event.releaseType === 'DigitalRelease') materialIcon = 'ondemand_video';
    else if (event.releaseType === 'PhysicalRelease') materialIcon = 'album';
    else if (event.releaseType === 'Episode') materialIcon = 'tv_guide';

    const subtitleHtml = subtitle
        ? `<span class="jc-calendar-agenda-subtitle">${escapeHtml(subtitle)}</span>`
        : '';

    return `
      <div class="jc-calendar-agenda-event${hasFileClass}" data-event-id="${escapeHtml(event.id)}">
        <div class="jc-calendar-agenda-indicators">
          ${indicators.join('')}
        </div>
        <span class="material-symbols-rounded" style="font-size: 20px;">${materialIcon}</span>
        <div class="jc-calendar-agenda-event-marker" style="background: ${color};"></div>
        <div class="jc-calendar-agenda-event-content">
          <div class="jc-calendar-agenda-event-title">
            <span class="jc-calendar-agenda-title-text">${escapeHtml(event.title)}</span>
            ${subtitleHtml}
          </div>
          <div class="jc-calendar-agenda-event-meta">
            <img src="${typeIcon}" alt="${escapeHtml(event.type)}" class="${iconClass}" />
            <span>${releaseTypeLabel}</span>
            <span>•</span>
            <span class="jc-arr-badge" title="${sourceLabel}">${sourceLabel}</span>
            ${timeLabel ? `<span>• ${escapeHtml(timeLabel)}</span>` : ''}
          </div>
        </div>
      </div>
    `;
}

export function renderCardItems(events: CalendarEvent[]): string {
    if (!events.length) return '';

    return events.map((event) => {
        const poster = event.posterUrl || event.backdropUrl;
        const releaseTypeLabel = formatReleaseLabel(event);
        const typeIcon = event.type === 'Series' ? SONARR_ICON_URL : RADARR_ICON_URL;
        const sourceLabelRaw = buildInstanceLabel(event);
        const sourceLabel = escapeHtml(sourceLabelRaw);
        const iconClass = event.source === 'Sonarr' ? 'jc-calendar-sonarr-icon' : 'jc-calendar-radarr-icon';
        const statusIcons = renderStatusIcons(event);
        const timePill = buildTimePill(event);
        const playButton = event.hasFile ? `<button class="jc-calendar-play-btn jc-calendar-play-btn-card" title="${JC.t?.('seerr_btn_available')}" aria-label="${JC.t?.('seerr_btn_available')}" data-event-id="${escapeHtml(event.id)}"><span class="material-icons">play_arrow</span></button>` : '';
        const timeRow = timePill || playButton ? `<div class="jc-calendar-card-time-row">${timePill}${playButton}</div>` : '';
        const statusTop = statusIcons ? `<div class="jc-calendar-card-status-top">${statusIcons}</div>` : '';
        const color = getEventColor(event);
        if (poster) {
            return `
          <div class="jc-calendar-card" data-event-id="${escapeHtml(event.id)}" style="border-bottom-color: ${color};">
            <div class="jc-calendar-card-image-wrap">
              <img src="${escapeHtml(normalizeImageUrl(poster))}" alt="" class="jc-calendar-card-image">
              ${statusTop}
              <div class="jc-calendar-card-overlay">
                ${timeRow}
                <div class="jc-calendar-card-title">
                  <span class="jc-calendar-card-title-text">${escapeHtml(event.title)}</span>
                </div>
                ${event.subtitle ? `<div class="jc-calendar-card-subtitle">${escapeHtml(event.subtitle)}</div>` : `<div class="jc-calendar-card-subtitle"></div>`}
                <div class="jc-calendar-card-meta">
                  <img src="${typeIcon}" alt="${escapeHtml(event.type)}" class="${iconClass}" />
                  <span>${releaseTypeLabel}</span>
                  <span>•</span>
                  <span class="jc-arr-badge" title="${sourceLabel}">${sourceLabel}</span>
                </div>
              </div>
            </div>
          </div>
        `;
        }

        return `
        <div class="jc-calendar-card" data-event-id="${escapeHtml(event.id)}" style="border-bottom-color: ${color};">
          ${statusTop}
          ${timeRow}
          <div class="jc-calendar-card-title">
            <span class="jc-calendar-card-title-text">${escapeHtml(event.title)}</span>
          </div>
          ${event.subtitle ? `<div class="jc-calendar-card-subtitle">${escapeHtml(event.subtitle)}</div>` : `<div class="jc-calendar-card-subtitle"></div>`}
          <div class="jc-calendar-card-meta">
            <img src="${typeIcon}" alt="${escapeHtml(event.type)}" class="${iconClass}" />
            <span>${releaseTypeLabel}</span>
            <span>•</span>
            <span class="jc-arr-badge" title="${sourceLabel}">${sourceLabel}</span>
          </div>
        </div>
      `;
    }).join('');
}
