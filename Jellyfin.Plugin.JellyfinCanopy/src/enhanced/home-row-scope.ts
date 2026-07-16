// src/enhanced/home-row-scope.ts
//
// Locale-independent ownership for Jellyfin 12 home rows. Jellyfin renders
// translated headings, so visible text is never a stable row identifier. Home
// rows are resolved from host-owned component ids, exact route parameters, or
// the identity-scoped DisplayPreferences snapshot used by jellyfin-web itself.

import { onNavigate } from '../core/navigation';
import { JC } from '../globals';
import type { IdentityContext } from '../types/jc';

export type HomeRowKind = 'continuewatching' | 'nextup' | 'collection' | 'ordinary';

export interface HomeRowResolution {
    readonly kind: HomeRowKind | 'unresolved';
    /** True when the element belongs to a Jellyfin home-section slot. */
    readonly isHomeRow: boolean;
    /** Stable enough to detect a card/section being reused under another row. */
    readonly signature: string;
    readonly section: HTMLElement | null;
}

interface DisplayPreferencesSnapshot {
    readonly ownerKey: string;
    readonly customPrefs: Readonly<Record<string, string>>;
}

interface DisplayPreferencesDto {
    CustomPrefs?: Record<string, unknown> | null;
}

interface ResolverPass {
    readonly routeEvidence: WeakMap<HTMLElement, boolean>;
    readonly tvLayout: WeakMap<Element, boolean>;
}

const DEFAULT_SECTIONS = Object.freeze([
    'smalllibrarytiles',
    'resume',
    'resumeaudio',
    'resumebook',
    'livetv',
    'nextup',
    'latestmedia',
    'none',
    'none',
    'none',
]);
const KNOWN_SECTIONS = new Set([
    'none', 'smalllibrarytiles', 'librarybuttons', 'activerecordings',
    'resume', 'resumeaudio', 'resumebook', 'latestmedia', 'nextup', 'livetv',
]);
const COLLECTION_TYPES = new Set([
    'collectionfolder', 'userview', 'boxset', 'playlist', 'channel',
]);
const MAX_PREF_ATTEMPTS = 3;
const PREF_RETRY_BASE_MS = 500;

const listeners = new Set<() => void>();
let snapshot: DisplayPreferencesSnapshot | null = null;
let ownerKey: string | null = null;
let requestGeneration = 0;
let requestAttempts = 0;
let inFlight: Promise<void> | null = null;
let retryHandle: number | null = null;
let navigateUnsubscribe: (() => void) | null = null;
let lastNavigationRoute: string | null = null;
let routeEvidenceCache = new WeakMap<HTMLElement, {
    readonly link: HTMLAnchorElement;
    readonly href: string;
}>();
let configuredSectionsCache = new WeakMap<Element, {
    readonly isTvLayout: boolean;
    readonly sections: readonly string[];
}>();

function contextKey(context: IdentityContext): string {
    return `${context.serverId}\u0000${context.userId}\u0000${context.epoch}`;
}

function notifyListeners(): void {
    for (const listener of [...listeners]) {
        try { listener(); }
        catch (error) {
            console.warn('🪼 Jellyfin Canopy: Home-row resolver listener failed', error);
        }
    }
}

function clearRetry(): void {
    if (retryHandle !== null) window.clearTimeout(retryHandle);
    retryHandle = null;
}

function resetSnapshot(nextOwnerKey: string | null, notify: boolean): void {
    requestGeneration += 1;
    clearRetry();
    snapshot = null;
    ownerKey = nextOwnerKey;
    requestAttempts = 0;
    inFlight = null;
    routeEvidenceCache = new WeakMap();
    configuredSectionsCache = new WeakMap();
    if (notify) notifyListeners();
}

function currentContext(): IdentityContext | null {
    const context = JC.identity?.capture?.() || null;
    const nextOwnerKey = context ? contextKey(context) : null;
    if (nextOwnerKey !== ownerKey) resetSnapshot(nextOwnerKey, false);
    return context;
}

function sanitizeCustomPrefs(value: unknown): Readonly<Record<string, string>> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return Object.freeze({});
    const prefs: Record<string, string> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
        if (!/^homesection\d+$/.test(key) || typeof raw !== 'string') continue;
        prefs[key] = raw.toLowerCase().trim();
    }
    return Object.freeze(prefs);
}

function sameCustomPrefs(
    left: Readonly<Record<string, string>>,
    right: Readonly<Record<string, string>>,
): boolean {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length && leftKeys.every((key) => left[key] === right[key]);
}

/** Start one identity-fenced preferences read. Failures remain retryable. */
function loadHomeRowScopes(): void {
    const context = currentContext();
    if (!context || snapshot || inFlight || requestAttempts >= MAX_PREF_ATTEMPTS) return;
    if (typeof ApiClient?.getDisplayPreferences !== 'function') return;

    requestAttempts += 1;
    const generation = requestGeneration;
    const expectedOwnerKey = contextKey(context);
    inFlight = Promise.resolve(ApiClient.getDisplayPreferences('usersettings', context.userId, 'emby'))
        .then((result: unknown) => {
            if (generation !== requestGeneration || ownerKey !== expectedOwnerKey || !JC.identity.isCurrent(context)) return;
            const dto = result as DisplayPreferencesDto | null;
            const customPrefs = sanitizeCustomPrefs(dto?.CustomPrefs);
            const changed = !snapshot || !sameCustomPrefs(snapshot.customPrefs, customPrefs);
            snapshot = Object.freeze({
                ownerKey: expectedOwnerKey,
                customPrefs,
            });
            requestAttempts = 0;
            if (changed) {
                configuredSectionsCache = new WeakMap();
                notifyListeners();
            }
        })
        .catch((error: unknown) => {
            if (generation !== requestGeneration || ownerKey !== expectedOwnerKey || !JC.identity.isCurrent(context)) return;
            console.warn('🪼 Jellyfin Canopy: Home-row preferences read failed', error);
            if (requestAttempts < MAX_PREF_ATTEMPTS && listeners.size > 0) {
                const delay = PREF_RETRY_BASE_MS * requestAttempts;
                retryHandle = window.setTimeout(() => {
                    retryHandle = null;
                    loadHomeRowScopes();
                }, delay);
            }
        })
        .finally(() => {
            if (generation === requestGeneration) inFlight = null;
        });
}

export function primeHomeRowScopes(): void {
    loadHomeRowScopes();
}

function currentNavigationRoute(): string {
    return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function jellyfinRoute(route: string): { name: string; params: URLSearchParams } {
    const hashRoute = route.match(/#(\/[^#]*)$/)?.[1];
    const raw = hashRoute || route.split('#', 1)[0];
    const parsed = new URL(raw, window.location.origin);
    const name = parsed.pathname.split('/').filter(Boolean).pop()?.replace(/\.html$/i, '').toLowerCase() || '';
    return { name, params: parsed.searchParams };
}

function isHomeNavigation(route = currentNavigationRoute()): boolean {
    return jellyfinRoute(route).name === 'home';
}

function isHomePreferencesNavigation(route: string, userId: string): boolean {
    const parsed = jellyfinRoute(route);
    const targetUserId = parsed.params.get('userId');
    return parsed.name === 'mypreferenceshome' && (!targetUserId || targetUserId === userId);
}

/**
 * Keep resolver navigation/async ownership active for one feature lifecycle.
 * The snapshot remains valid for ordinary navigation. Jellyfin's home-layout
 * editor writes these exact preferences on `mypreferenceshome`; leaving that
 * route invalidates the snapshot before any scoped action can use stale order.
 */
export function acquireHomeRowScopes(onChange: () => void): () => void {
    // Each acquire owns a distinct token even when two feature activations use
    // the same exported callback function.
    const subscription = (): void => onChange();
    listeners.add(subscription);
    if (!navigateUnsubscribe) {
        lastNavigationRoute = currentNavigationRoute();
        navigateUnsubscribe = onNavigate(() => {
            const context = currentContext();
            const route = currentNavigationRoute();
            const enteredHome = isHomeNavigation(route)
                && (lastNavigationRoute === null || !isHomeNavigation(lastNavigationRoute));
            const leftHomePreferences = context !== null
                && lastNavigationRoute !== null
                && isHomePreferencesNavigation(lastNavigationRoute, context.userId)
                && !isHomePreferencesNavigation(route, context.userId);
            lastNavigationRoute = route;
            if (leftHomePreferences) resetSnapshot(ownerKey, true);
            if (!isHomeNavigation(route)) return;
            // DisplayPreferences are server/user scoped and may have changed in
            // another client. Every real Home entry discards the old mapping;
            // consumers fail visible until this authoritative read completes.
            if (enteredHome && snapshot) resetSnapshot(ownerKey, true);
            // A new navigation is a new bounded retry stimulus after a prior
            // exhausted batch; it does not create an unbounded background loop.
            if (requestAttempts >= MAX_PREF_ATTEMPTS) requestAttempts = 0;
            loadHomeRowScopes();
        });
    }
    let disposed = false;
    return () => {
        if (disposed) return;
        disposed = true;
        listeners.delete(subscription);
        if (listeners.size !== 0) return;
        navigateUnsubscribe?.();
        navigateUnsubscribe = null;
        lastNavigationRoute = null;
        resetSnapshot(null, false);
    };
}

function closestSection(element: Element): HTMLElement | null {
    const selector = '.section, .verticalSection, .homeSection, #resumableSection, #resumableItems, #nextUpItemsSection, #nextUpItems';
    if (element.matches(selector)) return element as HTMLElement;
    return element.closest<HTMLElement>(selector);
}

function cardFor(element: Element): HTMLElement | null {
    if (element.matches('.card, .listItem')) return element as HTMLElement;
    return element.closest<HTMLElement>('.card, .listItem');
}

function hasExactNextUpRoute(section: HTMLElement, pass?: ResolverPass): boolean {
    const passResult = pass?.routeEvidence.get(section);
    if (passResult !== undefined) return passResult;
    const cached = routeEvidenceCache.get(section);
    if (cached
        && cached.link.isConnected
        && section.contains(cached.link)
        && cached.link.getAttribute('href') === cached.href) {
        pass?.routeEvidence.set(section, true);
        return true;
    }
    routeEvidenceCache.delete(section);
    // Jellyfin owns this title-link class. Restricting the scan to header links
    // avoids walking every card anchor once per card in a large row.
    const links = section.querySelectorAll<HTMLAnchorElement>(
        'a.sectionTitleTextButton[href], .sectionTitleContainer > a[href], .sectionTitle a[href], h2 > a[href]',
    );
    for (const link of links) {
        const href = link.getAttribute('href') || '';
        const queryIndex = href.indexOf('?');
        if (queryIndex < 0) continue;
        const hashIndex = href.indexOf('#', queryIndex);
        const params = new URLSearchParams(href.slice(queryIndex + 1, hashIndex < 0 ? undefined : hashIndex));
        const type = (params.get('type') || '').toLowerCase();
        const itemTypes = (params.get('itemTypes') || '').toLowerCase();
        if (type === 'nextup' || itemTypes === 'nextup') {
            routeEvidenceCache.set(section, Object.freeze({ link, href }));
            pass?.routeEvidence.set(section, true);
            return true;
        }
    }
    pass?.routeEvidence.set(section, false);
    return false;
}

function sectionIndex(section: HTMLElement): number | null {
    for (const className of section.classList) {
        const match = /^section(\d+)$/.exec(className);
        if (match) return Number.parseInt(match[1], 10);
    }
    return null;
}

function configuredSections(
    container: Element,
    customPrefs: Readonly<Record<string, string>>,
    pass?: ResolverPass,
): readonly string[] {
    let isTvLayout = pass?.tvLayout.get(container);
    if (isTvLayout === undefined) {
        isTvLayout = Boolean(container.querySelector(':scope > .section10'));
        pass?.tvLayout.set(container, isTvLayout);
    }
    const cached = configuredSectionsCache.get(container);
    if (cached?.isTvLayout === isTvLayout) return cached.sections;
    const sections: string[] = [];
    for (let index = 0; index < 10; index += 1) {
        let value = customPrefs[`homesection${index}`] || DEFAULT_SECTIONS[index] || 'none';
        if (value === 'folders') value = DEFAULT_SECTIONS[0];
        if (!KNOWN_SECTIONS.has(value)) {
            console.warn(`🪼 Jellyfin Canopy: Unknown Jellyfin home-section type at slot ${index}`);
            value = `unknown:${index}`;
        }
        sections.push(value);
    }
    if (isTvLayout && !sections.includes('smalllibrarytiles') && !sections.includes('librarybuttons')) {
        sections.unshift('smalllibrarytiles');
    }
    const frozenSections = Object.freeze([...sections]);
    configuredSectionsCache.set(container, Object.freeze({ isTvLayout, sections: frozenSections }));
    return frozenSections;
}

/** Invalidate bounded DOM-derived facts after a relevant section mutation. */
export function invalidateHomeRowSection(section: Element): void {
    const owner = closestSection(section);
    const container = owner?.closest('.homeSectionsContainer')
        || (section.matches('.homeSectionsContainer') ? section : section.closest('.homeSectionsContainer'));
    if (container) configuredSectionsCache.delete(container);
}

function collectionKind(card: HTMLElement | null): boolean {
    if (!card) return false;
    const type = (card.dataset.type || '').toLowerCase();
    if (COLLECTION_TYPES.has(type)) return true;
    return Boolean((card.dataset.collectiontype || '').trim());
}

function resolved(
    kind: HomeRowKind | 'unresolved',
    isHomeRow: boolean,
    signature: string,
    section: HTMLElement | null,
): HomeRowResolution {
    return Object.freeze({ kind, isHomeRow, signature, section });
}

function resolveHomeRowScopeWithPass(
    element: Element,
    pass?: ResolverPass,
): HomeRowResolution {
    const context = currentContext();
    const card = cardFor(element);
    const section = closestSection(element);

    if (card?.closest('#resumableSection, #resumableItems')) {
        return resolved('continuewatching', false, 'legacy:continuewatching', section);
    }
    if (card?.closest('#nextUpItemsSection, #nextUpItems')) {
        return resolved('nextup', false, 'legacy:nextup', section);
    }
    if (section?.matches('#resumableSection, #resumableItems')) {
        return resolved('continuewatching', false, 'legacy:continuewatching', section);
    }
    if (section?.matches('#nextUpItemsSection, #nextUpItems')) {
        return resolved('nextup', false, 'legacy:nextup', section);
    }
    const container = section?.closest('.homeSectionsContainer');
    const index = section ? sectionIndex(section) : null;
    if (section && container && index !== null) {
        if (!context || !snapshot || snapshot.ownerKey !== contextKey(context)) {
            if (hasExactNextUpRoute(section, pass)) {
                return resolved('nextup', true, `home:${index}:route-nextup`, section);
            }
            primeHomeRowScopes();
            return resolved('unresolved', true, `home:${index}:pending`, section);
        }
        const sections = configuredSections(container, snapshot.customPrefs, pass);
        const sectionType = sections[index];
        if (!sectionType) return resolved('unresolved', true, `home:${index}:invalid`, section);
        if (sectionType.startsWith('unknown:')) {
            return resolved('unresolved', true, `home:${index}:${sectionType}`, section);
        }
        if (sectionType === 'resume') return resolved('continuewatching', true, `home:${index}:resume`, section);
        if (sectionType === 'nextup') return resolved('nextup', true, `home:${index}:nextup`, section);
        if (sectionType === 'smalllibrarytiles' || sectionType === 'librarybuttons') {
            return resolved('collection', true, `home:${index}:${sectionType}`, section);
        }
        return resolved(collectionKind(card) ? 'collection' : 'ordinary', true, `home:${index}:${sectionType}`, section);
    }

    if (section && hasExactNextUpRoute(section, pass)) {
        return resolved('nextup', false, 'route:nextup', section);
    }

    if (section?.closest('.homeSectionsContainer')) {
        primeHomeRowScopes();
        return resolved('unresolved', true, 'home:unknown', section);
    }
    if (collectionKind(card)) return resolved('collection', false, 'card:collection', section);
    return resolved('ordinary', false, 'ordinary', section);
}

/** Resolve one card or section without inspecting rendered language. */
export function resolveHomeRowScope(element: Element): HomeRowResolution {
    return resolveHomeRowScopeWithPass(element);
}

/** Share negative route evidence only inside one synchronous DOM pass. */
export function createHomeRowScopeResolver(): (element: Element) => HomeRowResolution {
    const pass: ResolverPass = {
        routeEvidence: new WeakMap<HTMLElement, boolean>(),
        tvLayout: new WeakMap<Element, boolean>(),
    };
    return (element: Element): HomeRowResolution => resolveHomeRowScopeWithPass(element, pass);
}

/** Test/lifecycle helper: drop all async state without registering anything. */
export function resetHomeRowScopes(): void {
    listeners.clear();
    navigateUnsubscribe?.();
    navigateUnsubscribe = null;
    resetSnapshot(null, false);
}
