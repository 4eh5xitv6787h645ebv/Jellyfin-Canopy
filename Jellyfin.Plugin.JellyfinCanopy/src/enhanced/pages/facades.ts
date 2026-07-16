import { createStableMethodFacade } from '../../core/feature-loader';
import { JC } from '../../globals';
import { openPage } from './router-bridge';

type PageId = 'calendar' | 'downloads' | 'hidden-content' | 'bookmarks';
type Method = (...args: never[]) => unknown;
type Facade = Record<string, Method>;

const noop = (): void => undefined;
const resolved = (): Promise<void> => Promise.resolve();

const fallbacks: Record<PageId, Facade> = {
    calendar: {
        showPage: () => { openPage('calendar'); }, refresh: resolved,
        setViewMode: noop, shiftPeriod: noop, goToday: noop, toggleFilter: noop,
        toggleShowUnmonitored: noop, renderPage: noop, injectStyles: noop,
        loadSettings: noop, handleEventClick: noop, setDisplayMode: noop,
        toggleSidebarCollapsed: noop, updateDisplayModeButtons: noop,
    },
    downloads: {
        showPage: () => { openPage('downloads'); }, refresh: resolved,
        filterDownloads: noop, searchDownloads: noop, filterRequests: noop,
        filterIssues: noop, nextPage: noop, prevPage: noop, nextIssuesPage: noop,
        prevIssuesPage: noop, renderPage: noop, injectStyles: noop,
    },
    'hidden-content': {
        showPage: () => { openPage('hidden-content'); }, renderPage: noop, injectStyles: noop,
    },
    bookmarks: {
        showPage: () => { openPage('bookmarks'); }, refresh: noop,
    },
};

const stable = {
    calendar: createStableMethodFacade(fallbacks.calendar),
    downloads: createStableMethodFacade(fallbacks.downloads),
    'hidden-content': createStableMethodFacade(fallbacks['hidden-content']),
    bookmarks: createStableMethodFacade(fallbacks.bookmarks),
};

/** Attach an implementation behind a frozen stable facade; stale detach is harmless. */
export function attachPageFacade(id: PageId, implementation: object): () => void {
    return stable[id].install({ ...fallbacks[id], ...implementation });
}

// Preserve one document-lifetime object and method identity for user scripts
// and legacy PluginPages callers while route chunks attach/detach underneath.
(JC as typeof JC & { calendarPage: import('../../arr/calendar/page').CalendarPageApi }).calendarPage =
    stable.calendar.facade as unknown as import('../../arr/calendar/page').CalendarPageApi;
(JC as typeof JC & { downloadsPage: import('../../arr/requests/page').DownloadsPageApi }).downloadsPage =
    stable.downloads.facade as unknown as import('../../arr/requests/page').DownloadsPageApi;
JC.hiddenContentPage = stable['hidden-content'].facade as unknown as
    import('../hidden-content-page/page').HiddenContentPageApi;
JC.bookmarksPage = stable.bookmarks.facade as unknown as import('../bookmarks/page').BookmarksPageApi;
