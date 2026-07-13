// src/arr/calendar/page.ts
//
// Calendar page descriptor + the frozen JC.calendarPage facade. All
// lifecycle (routing, adoption, teardown) is owned by the shared pages
// framework; this module only knows how to render calendar content into an
// adopted host and which actions the markup's inline handlers need.

import { JC } from '../arr-globals';
import { registerPage } from '../../enhanced/pages/registry';
import { openPage } from '../../enhanced/pages/router-bridge';
import { injectStyles } from './styles';
import { loadSettings } from './data';
import { renderPage, setActiveContainer, toggleSidebarCollapsed, updateDisplayModeButtons } from './render-views';
import {
    goToday,
    handleEventClick,
    loadAllData,
    setDisplayMode,
    setViewMode,
    shiftPeriod,
    toggleFilter,
    toggleShowUnmonitored
} from './actions';
import type { PageContext } from '../../enhanced/pages/types';

function render({ host, handle }: PageContext): void {
    injectStyles();
    loadSettings();

    const content = document.createElement('div');
    content.setAttribute('data-role', 'content');
    const primary = document.createElement('div');
    primary.className = 'content-primary jc-calendar-page';
    const container = document.createElement('div');
    container.id = 'jc-calendar-container';
    container.className = 'jc-interior-page-top';
    container.style.paddingLeft = '0.5em';
    container.style.paddingRight = '0.5em';
    primary.appendChild(container);
    content.appendChild(primary);
    host.appendChild(content);

    setActiveContainer(container);
    handle.onTeardown(() => setActiveContainer(null));
    // Delegated content clicks (event cards, sidebar toggle, display-mode
    // buttons) — scoped to the adopted host and drained with it, replacing
    // the old permanent document-level listener.
    handle.addListener(host, 'click', handleEventClick as EventListener);

    void loadAllData();
}

registerPage({
    id: 'calendar',
    route: '/calendar',
    titleKey: 'calendar_title',
    titleFallback: 'Calendar',
    icon: 'calendar_today',
    isEnabled: () => !!JC.pluginConfig?.CalendarPageEnabled,
    render
});

/** The frozen JC.calendarPage contract (e2e + inline onclick handlers). */
export interface CalendarPageApi {
    showPage: () => void;
    refresh: () => Promise<void>;
    setViewMode: (mode: string) => void;
    shiftPeriod: (direction: string) => void;
    goToday: () => void;
    toggleFilter: (filterType: string) => void;
    toggleShowUnmonitored: () => void;
    renderPage: () => void;
    injectStyles: () => void;
    loadSettings: () => void;
    handleEventClick: (e: MouseEvent) => void;
    setDisplayMode: (mode: string) => void;
    toggleSidebarCollapsed: () => void;
    updateDisplayModeButtons: () => void;
}

// The frozen public surface (e2e + inline onclick handlers in the markup).
// showPage delegates to the framework; content actions are unchanged.
JC.calendarPage = {
    showPage: () => { openPage('calendar'); },
    refresh: loadAllData,
    setViewMode,
    shiftPeriod,
    goToday,
    toggleFilter,
    toggleShowUnmonitored,
    renderPage,
    injectStyles,
    loadSettings,
    handleEventClick,
    setDisplayMode,
    toggleSidebarCollapsed,
    updateDisplayModeButtons
};
