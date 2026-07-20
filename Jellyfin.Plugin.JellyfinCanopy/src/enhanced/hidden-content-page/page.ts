// src/enhanced/hidden-content-page/page.ts
//
// Hidden Content page descriptor + the frozen JC.hiddenContentPage facade. All
// lifecycle (routing, adoption, teardown) is owned by the shared pages
// framework; this module only knows how to render hidden-content into an
// adopted host, repaint on the user's own hidden-content changes, and reset
// its cross-user/search state when the page is drained.
//
// Non-admins see their OWN hidden items; the admin cross-user filter surfaces
// only for admins (admin.ts/render.ts decide live), so the descriptor is NOT
// adminOnly — every authenticated user may open the page.

import { JC } from '../../globals';
import { injectStyles } from './styles';
import { renderPage, setActiveContainer } from './render';
import { resetAdminUi } from './admin';
import {
    capturePageFence,
    resetHiddenContentPageState,
    schedulePageTimeout,
    state,
} from './state';
import type { PageContext, PageDescriptor } from '../pages/types';

function render({ host, handle }: PageContext): void {
    injectStyles();

    const content = document.createElement('div');
    content.setAttribute('data-role', 'content');
    content.dataset.jcIdentityOwned = 'true';
    content.dataset.jcHiddenPageOwner = 'true';
    const primary = document.createElement('div');
    primary.className = 'content-primary jc-hidden-content-page';
    primary.dataset.jcThemeSurface = 'hidden-content';
    primary.dataset.jcThemeComponent = 'management-page';
    const container = document.createElement('div');
    container.id = 'jc-hidden-content-container';
    // Shared header-clearance offset (see JC.injectGlobalStyles
    // .jc-interior-page-top): full ~5em everywhere by default, compacted on
    // phones only on the modern layout.
    container.className = 'jc-interior-page-top';
    container.style.paddingLeft = '0.5em';
    container.style.paddingRight = '0.5em';
    primary.appendChild(container);
    content.appendChild(primary);
    host.appendChild(content);

    setActiveContainer(container);
    handle.track(() => setActiveContainer(null));

    // Identity activation re-adopts a still-mounted route before Stage 6
    // recreates JC.hiddenContent. Retry exactly once on the next task; Stage 6
    // is synchronous after activation, and the page-owned timer drains if the
    // route/account changes first.
    if (!JC.hiddenContent) {
        const fence = capturePageFence();
        schedulePageTimeout(() => renderPage(), 0, fence);
    }

    // Repaint on the user's own hidden-content changes. Registered through the
    // per-adoption dispose bag so it drains with the page — no permanent window
    // listener leaking across adoptions. There is exactly ONE container now, so
    // renderPage() (a no-op when the active container is disconnected) targets
    // the right surface without the old getElementById lookup.
    handle.addListener(window, 'jc-hidden-content-changed', () => {
        // This event fires only for the ADMIN's own hidden-content changes.
        // Invalidate the cached admin user list so the dropdown picks up
        // new/emptied users on the next render — but only on the admin's own
        // view, so viewing another user isn't stripped mid-inspection.
        if (state.adminIsAdmin === true && !state.selectedAdminUserId) {
            state.adminUsers = null;
        }
        // Don't repaint while viewing another user — the admin's own change
        // must not clobber that read-only view with own-list data.
        if (!state.selectedAdminUserId) renderPage();
    });

    // Kick the initial load: renderPage() resolves admin status / loads the
    // user list (fire-and-forget) and paints the current user's hidden items.
    renderPage();
}

/**
 * Full state reset on drain (mirrors the old hidePage teardown). A drained
 * page must never leak admin cross-user / search / scoped state into the next
 * adoption. Bumping adminLoadToken invalidates any in-flight cross-user fetch
 * so a late completion can't repopulate adminItems/adminUsers after the page
 * has been left; clearing adminUsersLoading frees the next open to re-fetch.
 */
function onHide(): void {
    document.getElementById('jc-hidden-content-page-styles')?.remove();
    resetAdminUi();
    resetHiddenContentPageState();
}

export const hiddenContentPageDescriptor: PageDescriptor & { id: 'hidden-content' } = {
    id: 'hidden-content',
    route: '/hidden-content',
    titleKey: 'hidden_content_manage_title',
    titleFallback: 'Hidden Content',
    icon: 'visibility_off',
    isEnabled: () => !!JC.pluginConfig?.HiddenContentEnabled,
    render,
    onHide,
};

/** The frozen JC.hiddenContentPage contract (PluginPages HTML + e2e). */
export interface HiddenContentPageApi {
    showPage: () => void;
    renderPage: () => void;
    injectStyles: () => void;
}

// The frozen public surface. showPage delegates to the framework; renderPage /
// injectStyles remain for the (soon-dead) PluginPages HTML and are now
// no-op-safe (renderPage no-ops without an adopted container).
export const hiddenContentPageFacade: Omit<HiddenContentPageApi, 'showPage'> = {
    renderPage,
    injectStyles,
};
