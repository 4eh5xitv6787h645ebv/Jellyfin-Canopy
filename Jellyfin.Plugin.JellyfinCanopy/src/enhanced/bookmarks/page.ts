// src/enhanced/bookmarks/page.ts
//
// Bookmarks page descriptor + the frozen JC.bookmarksPage facade. All page
// lifecycle (routing, adoption, teardown) is owned by the shared pages
// framework; this module only knows how to build the bookmarks host and hand a
// render target to the reused library renderer.
//
// Replaces the deleted library-init.ts (the uncapped 100ms boot poll, the
// CustomTabs body observer and native-tab wiring) and library-page.ts (the
// faux page div, body-fallback mis-parenting and location watcher). The
// framework owns readiness, adoption and drain; every adoption is a fresh
// render (no view cache).

import { JC } from '../../globals';
import {
    renderBookmarksLibrary,
    renderActiveBookmarks,
    resetBookmarksLibraryRender,
    setActiveContainer,
} from './library-render';
import { resetBookmarksLibraryPlayback } from './library-items';
import { resetBookmarksLibraryModals } from './library-modals';
import { resetBookmarksLibraryReplacementModals } from './library-replacements';
import { injectBookmarksLibraryStyles } from './library-styles';
import type { PageContext, PageDescriptor } from '../pages/types';

function render({ host, handle }: PageContext): void {
    injectBookmarksLibraryStyles();
    const content = document.createElement('div');
    content.setAttribute('data-role', 'content');
    const primary = document.createElement('div');
    primary.className = 'content-primary jc-bookmarks-page';
    const container = document.createElement('div');
    // A dedicated id: the old code scanned a bare '.sections.bookmarks' class
    // and picked the LAST visible match, mis-targeting stale/duplicate nodes.
    // The adopted host owns exactly one container.
    container.id = 'jc-bookmarks-container';
    primary.appendChild(container);
    content.appendChild(primary);
    host.appendChild(content);

    // DOM-as-truth render target for this adoption; cleared on drain so any
    // later refresh into a detached container is a no-op.
    setActiveContainer(container);
    handle.track(() => setActiveContainer(null));

    // The module's own change event (dispatched on `document` by the bookmarks
    // core on every add/update/delete/sync) now simply re-renders into the
    // active container. Registered through the dispose bag so it is scoped to
    // this adoption and torn down on drain — replacing the permanent,
    // never-removed document listener the old library-init installed. (It must
    // bind on `document`: the event is dispatched there and does not propagate
    // down to the host.)
    handle.addListener(document, 'jc-bookmarks-updated', () => renderActiveBookmarks());

    void renderBookmarksLibrary(container);
}

export const bookmarksPageDescriptor: PageDescriptor & { id: 'bookmarks' } = {
    id: 'bookmarks',
    route: '/bookmarks',
    titleKey: 'bookmarks_library_title',
    titleFallback: 'Bookmarks',
    icon: 'bookmarks',
    isEnabled: () => !!JC.pluginConfig?.BookmarksEnabled,
    render,
    onHide: () => {
        document.getElementById('jc-bookmarks-library-styles')?.remove();
        resetBookmarksLibraryReplacementModals();
        resetBookmarksLibraryModals();
        resetBookmarksLibraryPlayback();
        resetBookmarksLibraryRender();
    },
};

/** The frozen JC.bookmarksPage contract (parity with JC.calendarPage; e2e-facing). */
export interface BookmarksPageApi {
    /** Navigate to the bookmarks page from anywhere (delegates to the router). */
    showPage: () => void;
    /** Re-render the adopted host in place (no-op when the page is not open). */
    refresh: () => void;
}

// showPage delegates to the framework router; refresh re-renders the adopted
// host in place. Symmetric with JC.calendarPage / downloadsPage / etc.
export const bookmarksPageFacade: Omit<BookmarksPageApi, 'showPage'> = {
    refresh: () => { renderActiveBookmarks(); }
};
