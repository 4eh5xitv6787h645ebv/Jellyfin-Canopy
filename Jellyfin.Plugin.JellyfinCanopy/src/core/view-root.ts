// src/core/view-root.ts
//
// Resolves the current instance of a Jellyfin native page without relying on
// document.getElementById(). Jellyfin's view cache can keep an old hidden page
// connected while mounting another page with the same id, and navigation is
// announced before the incoming view replaces the outgoing visible element.
//
// A raw viewbeforeshow/viewshow is the ownership hand-off: stamp its target
// with the exact pathname/search/hash identity that was current when Jellyfin
// showed it. `viewbeforeshow` covers React-hosted modern views; `viewshow`
// covers legacy viewManager mounts and cached POP re-shows. Consumers receive
// a root only when that stamp still matches the current navigation. That makes
// early navigation callbacks fail closed until the incoming lifecycle event.

import { navDedupKey } from './navigation';

interface ShownRootRecord {
    navigationKey: string;
    sequence: number;
}

export interface CurrentViewRoot {
    root: HTMLElement;
    navigationKey: string;
    showSequence: number;
}

let shownRoots = new WeakMap<HTMLElement, ShownRootRecord>();
let showSequence = 0;
let everRecordedViewLifecycle = false;

function escapeAttributeValue(value: string): string {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
        return CSS.escape(value);
    }
    return value.replace(/["\\]/g, '\\$&');
}

/**
 * Enumerate every element carrying an exact id, including duplicate ids.
 * Attribute selectors are intentional: selector engines may optimize `#id`
 * through getElementById() and silently return only the first cached instance.
 */
export function queryElementsById(id: string, scope: ParentNode = document): HTMLElement[] {
    return Array.from(
        scope.querySelectorAll<HTMLElement>(`[id="${escapeAttributeValue(id)}"]`)
    );
}

function isVisibleConnectedRoot(root: HTMLElement): boolean {
    if (!root.isConnected || root.hidden) return false;
    if (root.getAttribute('aria-hidden') === 'true') return false;
    return root.closest('.hide, [hidden], [aria-hidden="true"]') === null;
}

/** Record one native view instance as shown for the current navigation. */
export function recordViewRootShown(element: Element | null | undefined): void {
    if (!(element instanceof HTMLElement)) return;
    shownRoots.set(element, {
        navigationKey: navDedupKey(),
        sequence: ++showSequence,
    });
    everRecordedViewLifecycle = true;
}

/**
 * Resolve the current visible instance of a native page id.
 *
 * Before the bundle has observed any view lifecycle event, one unique visible instance is
 * safe to adopt: this is the normal "bundle booted on the page" case. After a
 * lifecycle event has been observed, an unstamped visible element can be the
 * outgoing half of a navigation transition, so callers wait for the incoming
 * viewbeforeshow/viewshow.
 */
export function resolveCurrentViewRoot(pageId: string): CurrentViewRoot | null {
    const navigationKey = navDedupKey();
    const visibleRoots = queryElementsById(pageId).filter(isVisibleConnectedRoot);
    let winner: { root: HTMLElement; record: ShownRootRecord } | null = null;

    for (const root of visibleRoots) {
        const record = shownRoots.get(root);
        if (!record || record.navigationKey !== navigationKey) continue;
        if (!winner || record.sequence > winner.record.sequence) {
            winner = { root, record };
        }
    }

    if (winner) {
        return {
            root: winner.root,
            navigationKey: winner.record.navigationKey,
            showSequence: winner.record.sequence,
        };
    }

    if (!everRecordedViewLifecycle && visibleRoots.length === 1) {
        const root = visibleRoots[0];
        recordViewRootShown(root);
        const record = shownRoots.get(root)!;
        return { root, navigationKey: record.navigationKey, showSequence: record.sequence };
    }

    return null;
}

/** Test-only reset for the module-level weak ownership ledger. */
export function resetViewRootTrackingForTests(): void {
    shownRoots = new WeakMap<HTMLElement, ShownRootRecord>();
    showSequence = 0;
    everRecordedViewLifecycle = false;
}

for (const eventName of ['viewbeforeshow', 'viewshow']) {
    document.addEventListener(eventName, (event) => {
        recordViewRootShown(event.target as Element | null);
    }, true);
}
