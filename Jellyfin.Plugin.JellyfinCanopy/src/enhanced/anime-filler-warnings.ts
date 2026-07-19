// Accessible, caller-scoped filler markers for episode cards and episode details.
// Importing this module is side-effect free; the feature scope owns all work.

import { onBodyMutation } from '../core/dom-observer';
import { getVisibleDetailsPage } from '../core/details-view';
import { JC } from '../globals';

interface ClassificationItem {
    ItemId: string;
    Classification: 'Filler' | 'Canon' | 'Unknown';
    Reason?: string;
}

interface ClassificationResponse {
    Items?: ClassificationItem[];
    items?: Array<{ itemId: string; classification: 'Filler' | 'Canon' | 'Unknown'; reason?: string }>;
}

interface CachedClassification {
    classification: ClassificationItem['Classification'];
    expiresAt: number;
}

const MARKER_CLASS = 'jc-anime-filler-marker';
const ANCHOR_CLASS = 'jc-anime-filler-anchor';
const STYLE_ID = 'jc-anime-filler-warning-styles';
const ID_ATTRIBUTES = ['data-id', 'data-itemid'] as const;

function localizedFiller(): string {
    const translated = JC.t?.('anime_filler_badge');
    return translated && translated !== 'anime_filler_badge' ? translated : 'Filler';
}

function itemIdFor(element: Element): string | null {
    for (const attribute of ID_ATTRIBUTES) {
        const value = element.getAttribute(attribute);
        if (value) return value;
    }
    const owner = element.closest<HTMLElement>('[data-id], [data-itemid]');
    if (owner) return owner.dataset.id || owner.dataset.itemid || null;
    const child = element.querySelector<HTMLElement>('[data-id], [data-itemid]');
    return child?.dataset.id || child?.dataset.itemid || null;
}

function collectTargets(page: HTMLElement): Map<string, Set<HTMLElement>> {
    const targets = new Map<string, Set<HTMLElement>>();
    const add = (itemId: string, target: HTMLElement): void => {
        const entries = targets.get(itemId) || new Set<HTMLElement>();
        entries.add(target);
        targets.set(itemId, entries);
    };
    const current = getVisibleDetailsPage();
    if (current?.page === page) add(current.itemId, page);
    page.querySelectorAll<HTMLElement>('[data-id], [data-itemid]').forEach((element) => {
        const id = itemIdFor(element);
        const card = element.closest<HTMLElement>('.card, .listItem');
        if (id && card) add(id, card);
    });
    return targets;
}

function removeMarker(target: HTMLElement): void {
    target.querySelectorAll<HTMLElement>(`.${MARKER_CLASS}`).forEach(marker => {
        marker.parentElement?.classList.remove(ANCHOR_CLASS);
        marker.remove();
    });
}

function marker(): HTMLSpanElement {
    const badge = document.createElement('span');
    badge.className = MARKER_CLASS;
    badge.textContent = localizedFiller();
    badge.setAttribute('role', 'note');
    badge.setAttribute('aria-label', localizedFiller());
    badge.title = localizedFiller();
    return badge;
}

function applyMarker(target: HTMLElement, filler: boolean, itemId: string): void {
    const visible = target.matches('[id="itemDetailPage"]') ? getVisibleDetailsPage() : null;
    const currentItemId = visible?.page === target ? visible.itemId : itemIdFor(target);
    const existing = target.querySelector<HTMLElement>(`.${MARKER_CLASS}`);
    if (!filler || currentItemId && currentItemId !== itemId) {
        if (existing) removeMarker(target);
        return;
    }
    if (existing?.dataset.itemId === itemId) return;
    if (existing) removeMarker(target);
    const badge = marker();
    badge.dataset.itemId = itemId;
    if (target.matches('[id="itemDetailPage"]')) {
        const anchor = target.querySelector<HTMLElement>('.itemName, .detailPagePrimaryContainer, .detailRibbon');
        if (anchor) {
            anchor.classList.add(ANCHOR_CLASS);
            anchor.appendChild(badge);
        }
        return;
    }
    const anchor = target.querySelector<HTMLElement>('.cardScalable, .cardImageContainer, .listItemImage') || target;
    anchor.classList.add(ANCHOR_CLASS);
    anchor.appendChild(badge);
}

function ensureStyles(): HTMLStyleElement {
    const existing = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (existing) return existing;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
        .${ANCHOR_CLASS} { position: relative; }
        .${MARKER_CLASS} { display: inline-flex; align-items: center; min-height: 1.55em; padding: 0.15em 0.55em; border-radius: 999px; background: rgba(155, 24, 34, 0.94); color: #fff; font-size: 0.78rem; font-weight: 700; line-height: 1.2; letter-spacing: 0.02em; }
        .cardScalable > .${MARKER_CLASS}, .cardImageContainer > .${MARKER_CLASS}, .listItemImage > .${MARKER_CLASS} { position: absolute; z-index: 4; right: 0.45rem; top: 0.45rem; pointer-events: none; }
        .itemName > .${MARKER_CLASS}, .detailPagePrimaryContainer > .${MARKER_CLASS}, .detailRibbon > .${MARKER_CLASS} { margin-inline-start: 0.65rem; vertical-align: middle; }
    `;
    document.head.appendChild(style);
    return style;
}

/** Installs one navigation-owned activation. */
export function installAnimeFillerWarnings(signal: AbortSignal, isCurrent: () => boolean): () => void {
    const style = ensureStyles();
    const requestAbort = new AbortController();
    const abortRequests = (): void => requestAbort.abort();
    signal.addEventListener('abort', abortRequests, { once: true });
    let timer: ReturnType<typeof setTimeout> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryDeadline = Number.POSITIVE_INFINITY;
    let generation = 0;
    let requestInFlight = false;
    let failureUntil = 0;
    let identityObserver: MutationObserver | null = null;
    let identityRoot: HTMLElement | null = null;
    const classifications = new Map<string, CachedClassification>();

    const armRetryAt = (deadline: number): void => {
        if (signal.aborted || !isCurrent() || !Number.isFinite(deadline)) return;
        if (retryTimer !== null && deadline >= retryDeadline) return;
        if (retryTimer !== null) clearTimeout(retryTimer);
        retryDeadline = deadline;
        retryTimer = setTimeout(() => {
            retryTimer = null;
            retryDeadline = Number.POSITIVE_INFINITY;
            schedule();
        }, Math.max(0, deadline - Date.now()));
    };

    const readClassification = (itemId: string): ClassificationItem['Classification'] | undefined => {
        const key = itemId.toLowerCase();
        const cached = classifications.get(key);
        if (!cached) return undefined;
        if (cached.expiresAt <= Date.now()) {
            classifications.delete(key);
            return undefined;
        }
        armRetryAt(cached.expiresAt);
        return cached.classification;
    };

    const scan = (): void => {
        if (signal.aborted || !isCurrent()) return;
        const visible = getVisibleDetailsPage();
        if (!visible) {
            identityObserver?.disconnect();
            identityRoot = null;
            return;
        }
        if (identityRoot !== visible.page) {
            identityObserver?.disconnect();
            identityObserver = new MutationObserver(schedule);
            identityObserver.observe(visible.page, {
                attributes: true,
                attributeFilter: [...ID_ATTRIBUTES],
                subtree: true,
            });
            identityRoot = visible.page;
        }
        const targets = collectTargets(visible.page);
        if (targets.size === 0) return;
        for (const [id, elements] of targets) {
            elements.forEach((element) => {
                const existing = element.querySelector<HTMLElement>(`.${MARKER_CLASS}`);
                if (existing && existing.dataset.itemId !== id) removeMarker(element);
            });
            const known = readClassification(id);
            if (known) elements.forEach(element => applyMarker(element, known === 'Filler', id));
        }
        const missingIds = [...targets.keys()]
            .filter(id => readClassification(id) === undefined)
            .slice(0, 100);
        if (missingIds.length === 0 || requestInFlight) return;
        if (Date.now() < failureUntil) {
            armRetryAt(failureUntil);
            return;
        }
        const run = generation;
        requestInFlight = true;
        void ApiClient.ajax({
            type: 'POST',
            url: ApiClient.getUrl('/JellyfinCanopy/anime-filler/classifications'),
            contentType: 'application/json',
            dataType: 'json',
            data: JSON.stringify({ itemIds: missingIds }),
            signal: requestAbort.signal,
        }).then((rawResponse: unknown) => {
            if (signal.aborted || !isCurrent() || run !== generation) return;
            const response = rawResponse as ClassificationResponse;
            const items = response.Items || response.items?.map(item => ({
                ItemId: item.itemId,
                Classification: item.classification,
                Reason: item.reason,
            })) || [];
            // A well-formed response includes every requested ID. Treat omitted
            // entries as Unknown so a partial upstream result cannot cause a
            // hot retry loop.
            missingIds.forEach(id => classifications.set(id.toLowerCase(), {
                classification: 'Unknown',
                expiresAt: Number.POSITIVE_INFINITY,
            }));
            items.forEach(item => {
                const transient = item.Classification === 'Unknown'
                    && item.Reason === 'provider-unavailable';
                const expiresAt = transient ? Date.now() + 30_000 : Number.POSITIVE_INFINITY;
                classifications.set(item.ItemId.toLowerCase(), {
                    classification: item.Classification,
                    expiresAt,
                });
                if (transient) armRetryAt(expiresAt);
            });
            const current = getVisibleDetailsPage();
            const currentTargets = current ? collectTargets(current.page) : new Map<string, Set<HTMLElement>>();
            for (const [id, elements] of currentTargets) {
                const filler = readClassification(id) === 'Filler';
                elements.forEach(element => applyMarker(element, filler, id));
            }
        }).catch(() => {
            if (signal.aborted || requestAbort.signal.aborted || !isCurrent() || run !== generation) return;
            failureUntil = Date.now() + 30_000;
            missingIds.forEach(id => targets.get(id)?.forEach(removeMarker));
            armRetryAt(failureUntil);
        }).finally(() => {
            if (run !== generation) return;
            requestInFlight = false;
            schedule();
        });
    };

    const schedule = (): void => {
        if (timer !== null) return;
        timer = setTimeout(() => {
            timer = null;
            scan();
        }, 80);
    };
    schedule();
    const observer = onBodyMutation('anime-filler-warnings', schedule);
    return () => {
        generation++;
        requestAbort.abort();
        signal.removeEventListener('abort', abortRequests);
        if (timer !== null) clearTimeout(timer);
        if (retryTimer !== null) clearTimeout(retryTimer);
        observer.unsubscribe();
        identityObserver?.disconnect();
        identityRoot = null;
        document.querySelectorAll(`.${MARKER_CLASS}`).forEach(element => {
            element.parentElement?.classList.remove(ANCHOR_CLASS);
            element.remove();
        });
        style.remove();
    };
}
