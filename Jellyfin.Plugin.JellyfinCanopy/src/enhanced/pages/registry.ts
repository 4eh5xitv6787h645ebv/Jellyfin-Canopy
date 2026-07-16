// src/enhanced/pages/registry.ts
//
// The page registry: descriptors keyed by id and by route, plus the admin
// PagesOrder ordering. Gates are ALWAYS evaluated live at the call site —
// nothing here caches enablement, so live config changes apply on the next
// decision without re-registration.

import { JC } from '../../globals';
import type { PageDescriptor } from './types';

const byId = new Map<string, PageDescriptor>();
const byRoute = new Map<string, PageDescriptor>();

function renderLoadingPage({ host }: import('./types').PageContext): void {
    const loading = document.createElement('div');
    loading.className = 'jc-page-loading padded-left padded-right';
    loading.setAttribute('role', 'status');
    loading.textContent = JC.t?.('loading') || 'Loading…';
    host.appendChild(loading);
}

/** Boot-safe route metadata. Feature chunks replace these placeholders only
 * for their current navigation activation, then unregistration restores them. */
const catalog: readonly PageDescriptor[] = [
    {
        id: 'calendar', route: '/calendar', titleKey: 'calendar_title',
        titleFallback: 'Calendar', icon: 'calendar_today',
        isEnabled: () => !!JC.pluginConfig?.CalendarPageEnabled, render: renderLoadingPage,
    },
    {
        id: 'downloads', route: '/downloads', titleKey: 'requests_requests',
        titleFallback: 'Requests', icon: 'download',
        isEnabled: () => !!JC.pluginConfig?.DownloadsPageEnabled, render: renderLoadingPage,
    },
    {
        id: 'hidden-content', route: '/hidden-content', titleKey: 'hidden_content_manage_title',
        titleFallback: 'Hidden Content', icon: 'visibility_off',
        isEnabled: () => !!JC.pluginConfig?.HiddenContentEnabled, render: renderLoadingPage,
    },
    {
        id: 'bookmarks', route: '/bookmarks', titleKey: 'bookmarks_library_title',
        titleFallback: 'Bookmarks', icon: 'bookmarks',
        isEnabled: () => !!JC.pluginConfig?.BookmarksEnabled, render: renderLoadingPage,
    },
];

/** Register an active descriptor and return an idempotent restoration closure. */
export function registerPage(descriptor: PageDescriptor): () => void {
    const previousById = byId.get(descriptor.id);
    const previousByRoute = byRoute.get(descriptor.route);
    byId.set(descriptor.id, descriptor);
    byRoute.set(descriptor.route, descriptor);
    let active = true;
    return () => {
        if (!active) return;
        active = false;
        if (byId.get(descriptor.id) === descriptor) {
            if (previousById) byId.set(descriptor.id, previousById);
            else byId.delete(descriptor.id);
        }
        if (byRoute.get(descriptor.route) === descriptor) {
            if (previousByRoute) byRoute.set(descriptor.route, previousByRoute);
            else byRoute.delete(descriptor.route);
        }
    };
}

/** Immutable route catalog used by early boot without importing page chunks. */
export function catalogPages(): readonly PageDescriptor[] {
    return catalog;
}

/** Look a page up by id. */
export function getPage(id: string): PageDescriptor | null {
    return byId.get(id) ?? null;
}

/**
 * Resolve a location to a registered page. Exact route match only —
 * '#/bookmarksfoo' is NOT bookmarks (the old prefix matching opened pages
 * for unrelated URLs).
 * @param loc Defaults to window.location.
 */
export function resolvePage(
    loc: { hash: string } = window.location
): PageDescriptor | null {
    // Both JF12 layouts route via hash URLs ('#/calendar'); strip any query.
    const raw = loc.hash.startsWith('#') ? loc.hash.slice(1) : loc.hash;
    const path = raw.split('?')[0];
    return byRoute.get(path) ?? null;
}

/** True when the descriptor may act for the CURRENT user/config, live. */
export function pageAvailable(descriptor: PageDescriptor): boolean {
    try {
        if (!descriptor.isEnabled()) return false;
        if (descriptor.adminOnly && !JC.currentUser?.Policy?.IsAdministrator) return false;
        return true;
    } catch {
        return false;
    }
}

/**
 * Registered pages in admin-configured order. PagesOrder is a CSV of page
 * ids; unknown ids are ignored, missing ids are appended in registration
 * order — so a stale or partial value degrades to a complete, valid list.
 */
export function orderedPages(): PageDescriptor[] {
    const rawOrder = JC.pluginConfig?.PagesOrder;
    const configured = (typeof rawOrder === 'string' ? rawOrder : '')
        .split(',')
        .map((token) => token.trim())
        .filter(Boolean);
    const seen = new Set<string>();
    const ordered: PageDescriptor[] = [];
    for (const id of configured) {
        const descriptor = byId.get(id);
        if (descriptor && !seen.has(id)) {
            ordered.push(descriptor);
            seen.add(id);
        }
    }
    for (const descriptor of byId.values()) {
        if (!seen.has(descriptor.id)) ordered.push(descriptor);
    }
    return ordered;
}

for (const descriptor of catalog) registerPage(descriptor);
