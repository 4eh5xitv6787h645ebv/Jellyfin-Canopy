// src/enhanced/pages/entry-points.ts
//
// Registry-driven entry points for every surface, and the SINGLE owner of
// the '.jellyfinCanopySection' drawer section (settings-panel registers its
// Enhanced Panel link through ensureCanopySection — two independent creators
// previously produced nondeterministic drawer ordering).
//
// Surfaces:
//  * Drawer — the legacy sidebar or the modern MUI mobile drawer (one
//    resolver: getSidebarContainer). One link per available page, ordered
//    by PagesOrder, reconciled on every body-mutation pass so live config
//    changes add AND remove entries.
//  * Header tray — modern desktop's only persistent chrome; one compact
//    icon button per available page (fixes: no entry point at all on the
//    modern desktop layout with default config).
//  * User menu — links on the preferences menu page, both layouts.
//
// R9: entry points render unconditionally and resolve the router lazily at
// click time (router-bridge.openPage) — no readiness gate can strand the
// pages unreachable.

import { JC } from '../../globals';
import { onBodyMutation } from '../../core/dom-observer';
import { onNavigate, onViewPage } from '../../core/navigation';
import { getSidebarContainer, getHeaderRightContainer } from '../helpers';
import { insertHeaderTrayButton } from '../header-tray';
import { orderedPages, pageAvailable, resolvePage } from './registry';
import { openPage } from './router-bridge';
import { refreshCurrent } from './fallback-host';
import type { PageDescriptor } from './types';
import type { IdentityContext } from '../../types/jc';

const PAGES_TRAY_ORDER_BASE = 30;
let initialized = false;

function pageTitle(descriptor: PageDescriptor): string {
    return JC.t?.(descriptor.titleKey) || descriptor.titleFallback;
}

function activate(descriptor: PageDescriptor, event: Event, context: IdentityContext): void {
    event.preventDefault();
    if (!JC.identity.isCurrent(context)) return;
    if (resolvePage() === descriptor) {
        refreshCurrent();
        return;
    }
    openPage(descriptor.id);
}

// ── Drawer section (single owner) ─────────────────────────────────────────

/**
 * Get or create the Canopy drawer section inside the given sidebar. Exposed
 * for settings-panel (its Enhanced Panel link is pinned LAST, after the
 * page entries, via the 'jc-pinned-last' marker).
 */
export function ensureCanopySection(sidebar: HTMLElement): HTMLElement {
    let section = sidebar.querySelector<HTMLElement>('.jellyfinCanopySection');
    if (!section) {
        section = document.createElement('div');
        section.className = 'jellyfinCanopySection';
        const header = document.createElement('h3');
        header.className = 'sidebarHeader';
        header.textContent = 'Jellyfin Canopy';
        section.appendChild(header);
        const mediaSection = sidebar.querySelector('.libraryMenuOptions');
        if (mediaSection) {
            sidebar.insertBefore(section, mediaSection);
        } else {
            sidebar.appendChild(section);
        }
    }
    return section;
}

/** Insert an entry keeping page order and pinned-last links in place. */
export function insertSectionEntry(section: HTMLElement, entry: HTMLElement, pinnedLast = false): void {
    if (pinnedLast) {
        entry.dataset.jcPinnedLast = 'true';
        section.appendChild(entry);
        return;
    }
    const firstPinned = section.querySelector<HTMLElement>('[data-jc-pinned-last]');
    section.insertBefore(entry, firstPinned);
}

function drawerLinkId(descriptor: PageDescriptor): string {
    return `jcPageLink-${descriptor.id}`;
}

function buildDrawerLink(descriptor: PageDescriptor, context: IdentityContext): HTMLAnchorElement {
    const link = document.createElement('a');
    link.setAttribute('is', 'emby-linkbutton');
    link.className = 'lnkMediaFolder navMenuOption emby-button';
    link.href = `#${descriptor.route}`;
    link.id = drawerLinkId(descriptor);
    link.setAttribute('data-jc-identity-owned', 'true');
    JC.identity.own(link, context);
    const icon = document.createElement('span');
    icon.className = 'material-icons navMenuOptionIcon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = descriptor.icon;
    const label = document.createElement('span');
    label.className = 'sectionName navMenuOptionText';
    label.textContent = pageTitle(descriptor);
    link.append(icon, label);
    link.addEventListener('click', (e) => activate(descriptor, e, context));
    return link;
}

/** Reconcile the drawer entries with the live registry state. */
function reconcileDrawer(): void {
    const context = JC.identity.capture();
    if (!context) return;
    const sidebar = getSidebarContainer();
    if (!sidebar) return;
    const section = ensureCanopySection(sidebar);

    let anchor: HTMLElement | null = section.querySelector<HTMLElement>('.sidebarHeader');
    for (const descriptor of orderedPages()) {
        const existing = section.querySelector<HTMLElement>(`#${drawerLinkId(descriptor)}`);
        if (!pageAvailable(descriptor)) {
            existing?.remove();
            continue;
        }
        let link = existing;
        if (link && !JC.identity.isOwned(link, context)) {
            link.remove();
            link = null;
        }
        if (!link) {
            link = buildDrawerLink(descriptor, context);
        }
        // Deterministic order regardless of injection timing: place each
        // entry right after the previous one (header first).
        const expectedPrev = anchor;
        if (link.previousElementSibling !== expectedPrev || link.parentElement !== section) {
            section.insertBefore(link, expectedPrev ? expectedPrev.nextElementSibling : section.firstChild);
        }
        anchor = link;
    }
}

// ── Header tray (modern desktop) ──────────────────────────────────────────

function trayButtonId(descriptor: PageDescriptor): string {
    return `jcPageTray-${descriptor.id}`;
}

function reconcileTray(): void {
    const context = JC.identity.capture();
    if (!context) return;
    // The tray is the modern layout's surface; the legacy header has the
    // drawer instead. getHeaderRightContainer resolves per layout — on the
    // legacy layout the drawer covers discovery, so skip the tray there.
    if (!document.documentElement.classList.contains('jc-modern-layout')) return;
    const tray = getHeaderRightContainer();
    if (!tray) return;
    orderedPages().forEach((descriptor, index) => {
        let existing = document.getElementById(trayButtonId(descriptor));
        if (existing && !JC.identity.isOwned(existing, context)) {
            existing.remove();
            existing = null;
        }
        if (!pageAvailable(descriptor)) {
            existing?.remove();
            return;
        }
        if (existing) return;
        const button = document.createElement('button');
        button.id = trayButtonId(descriptor);
        button.type = 'button';
        button.setAttribute('is', 'paper-icon-button-light');
        button.className = 'headerButton headerButtonRight paper-icon-button-light';
        button.setAttribute('data-jc-identity-owned', 'true');
        JC.identity.own(button, context);
        button.title = pageTitle(descriptor);
        const icon = document.createElement('span');
        icon.className = 'material-icons';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = descriptor.icon;
        button.appendChild(icon);
        button.addEventListener('click', (e) => activate(descriptor, e, context));
        insertHeaderTrayButton(tray, button, PAGES_TRAY_ORDER_BASE + index);
    });
}

// ── User preferences menu ─────────────────────────────────────────────────

function prefsLinkId(descriptor: PageDescriptor): string {
    return `jcPagePrefs-${descriptor.id}`;
}

function reconcilePrefsMenu(): void {
    const context = JC.identity.capture();
    if (!context) return;
    const page = document.getElementById('myPreferencesMenuPage');
    if (!page || page.classList.contains('hide')) return;
    const menuContainer = page.querySelector('.verticalSection');
    if (!menuContainer) return;
    for (const descriptor of orderedPages()) {
        let existing = document.getElementById(prefsLinkId(descriptor));
        if (existing && !JC.identity.isOwned(existing, context)) {
            existing.remove();
            existing = null;
        }
        if (!pageAvailable(descriptor)) {
            existing?.remove();
            continue;
        }
        if (existing) continue;
        const link = document.createElement('a');
        link.id = prefsLinkId(descriptor);
        link.setAttribute('is', 'emby-linkbutton');
        link.setAttribute('data-ripple', 'false');
        link.href = `#${descriptor.route}`;
        link.className = 'listItem-border emby-button';
        link.setAttribute('data-jc-identity-owned', 'true');
        JC.identity.own(link, context);
        link.style.display = 'block';
        link.style.padding = '0';
        link.style.margin = '0';
        const item = document.createElement('div');
        item.className = 'listItem';
        const icon = document.createElement('span');
        icon.className = `material-icons listItemIcon listItemIcon-transparent ${descriptor.icon}`;
        icon.setAttribute('aria-hidden', 'true');
        const body = document.createElement('div');
        body.className = 'listItemBody';
        const text = document.createElement('div');
        text.className = 'listItemBodyText';
        text.textContent = pageTitle(descriptor);
        body.appendChild(text);
        item.append(icon, body);
        link.appendChild(item);
        link.addEventListener('click', (e) => activate(descriptor, e, context));
        menuContainer.appendChild(link);
    }
}

/** Wire all surfaces off the shared observers/events (no private pollers). */
export function initEntryPoints(): void {
    if (initialized) return;
    initialized = true;
    onBodyMutation('jc-pages-entries', () => {
        reconcileDrawer();
        reconcileTray();
        reconcilePrefsMenu();
    });
    onNavigate(() => {
        reconcileTray();
        reconcilePrefsMenu();
    });
    onViewPage(() => {
        reconcilePrefsMenu();
    });
    reconcileDrawer();
    reconcileTray();
}

function resetEntryPoints(): void {
    document.querySelectorAll<HTMLElement>(
        '[id^="jcPageLink-"], [id^="jcPageTray-"], [id^="jcPagePrefs-"]'
    ).forEach((entry) => entry.remove());
}

function activateEntryPoints(): void {
    reconcileDrawer();
    reconcileTray();
    reconcilePrefsMenu();
}

JC.identity.registerReset('pages-entry-points', resetEntryPoints);
JC.identity.registerActivate('pages-entry-points', activateEntryPoints);
