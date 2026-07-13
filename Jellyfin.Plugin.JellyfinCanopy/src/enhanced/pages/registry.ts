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

/** Register a page descriptor (bundle init; idempotent by id). */
export function registerPage(descriptor: PageDescriptor): void {
    byId.set(descriptor.id, descriptor);
    byRoute.set(descriptor.route, descriptor);
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
    const configured = String(JC.pluginConfig?.PagesOrder ?? '')
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
