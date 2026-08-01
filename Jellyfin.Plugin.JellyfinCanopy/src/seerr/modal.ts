// src/seerr/modal.ts
import { JC } from '../globals';
import { installModalA11y, type ModalA11yHandle } from '../core/modal-a11y';

/* eslint-disable @typescript-eslint/no-explicit-any -- legacy Seerr payload shapes; typed incrementally */

/** Options for the generic Seerr request modal. */
export interface SeerrModalOptions {
    title: string;
    subtitle: string;
    bodyHtml: string;
    backdropPath?: string | null;
    backdropUrl?: string | null;
    onSave: (modalElement: HTMLElement, primaryBtn: HTMLButtonElement, close: () => void) => void | Promise<void>;
    onClose?: () => void;
    buttonText?: string;
}
/** Handle returned by SeerrModalApi.create. */
export interface SeerrModalHandle {
    modalElement: HTMLElement;
    show: () => void;
    close: () => void;
}

/** Generic Seerr request modal factory (JC.seerrModal). */
export interface SeerrModalApi {
    create: (options: SeerrModalOptions) => SeerrModalHandle;
    createAdvancedOptionsHTML: (idPrefix: string) => string;
    populateAdvancedOptions: (modalElement: HTMLElement, data: any, idPrefix: string) => void;
    closeAll: () => void;
}

declare module '../types/jc' {
    interface JEGlobal {
        /** Generic Seerr request modal (src/seerr/modal.ts). */
        seerrModal?: SeerrModalApi;
    }
}

const logPrefix = '🪼 Jellyfin Canopy: Seerr Modal:';
const modal = {} as SeerrModalApi;
type ManagedModal = SeerrModalHandle & { destroy: () => void };
type IdentityCleanupElement = HTMLElement & { _jcIdentityCleanups?: Set<() => void> };
const activeModals = new Set<ManagedModal>();

const HISTORY_STATE_KEY = '__jellyfinCanopySeerrModal';
const HISTORY_OWNER = 'jellyfin-canopy/seerr-modal';
const HISTORY_LEDGER_KEY = 'jellyfin-canopy:seerr-modal-history:v2';
const HISTORY_GLOBAL_KEY = '__jellyfinCanopySeerrModalHistoryOwnerV2';
const MAX_RETIRED_HISTORY_TOKENS = 128;

interface ModalHistoryMarker {
    owner: typeof HISTORY_OWNER;
    version: 2;
    token: string;
    hostState: unknown;
    traversal: 'terminal' | 'bidirectional';
    nextDirection: 'back' | 'forward';
}

interface ModalHistoryState extends Record<string, unknown> {
    [HISTORY_STATE_KEY]: ModalHistoryMarker;
}

interface ModalHistoryRecord {
    token: string;
    closeFromHistory: () => void;
    destroy: () => void;
    rebaseFocusReturn: (removedRoot: HTMLElement, replacement: HTMLElement | null) => void;
}

interface PendingBaseExit {
    token: string;
    hostState: unknown;
    hostStateFingerprint: string | null;
    hostHref: string;
    /** Durable direction to commit after the delayed Back crosses this marker. */
    nextDirectionAfterBack: 'forward' | null;
    /** Removes the temporary observer that detects replacement of this marker. */
    releaseReplaceStateWatch: (() => void) | null;
}

interface ModalHistoryOwnerState {
    version: 2;
    listener: ((event: PopStateEvent) => void) | null;
    records: Map<string, ModalHistoryRecord>;
    knownTokens: string[];
    /** Direction to take on the next encounter when marker retagging was unavailable. */
    pendingBidirectional: Map<string, ModalHistoryMarker['nextDirection']>;
    /**
     * A current marker whose programmatic Back was rejected after its UI had
     * to be retired synchronously. The next exact base pop continues once more
     * so that one user Back still reaches the real predecessor.
     */
    pendingBaseExit: PendingBaseExit | null;
    adoptionToken: string | null;
    configListener: (() => void) | null;
}

type ModalHistoryWindow = Window & {
    [HISTORY_GLOBAL_KEY]?: ModalHistoryOwnerState;
};

let historyTokenSequence = 0;

const escapeHtml = JC.escapeHtml;

function readModalHistoryMarker(state: unknown): ModalHistoryMarker | null {
    if (state === null || typeof state !== 'object') return null;
    const marker = (state as Record<string, unknown>)[HISTORY_STATE_KEY];
    if (marker === null || typeof marker !== 'object') return null;
    const candidate = marker as Partial<ModalHistoryMarker>;
    if (candidate.owner !== HISTORY_OWNER
        || candidate.version !== 2
        || typeof candidate.token !== 'string'
        || candidate.token.length === 0
        || (candidate.traversal !== 'terminal' && candidate.traversal !== 'bidirectional')
        || (candidate.nextDirection !== 'back' && candidate.nextDirection !== 'forward')) {
        return null;
    }
    return candidate as ModalHistoryMarker;
}

function taggedHistoryState(
    token: string,
    hostState: unknown,
    traversal: ModalHistoryMarker['traversal'] = 'terminal',
    nextDirection: ModalHistoryMarker['nextDirection'] = 'back'
): ModalHistoryState {
    const state = hostState !== null
        && typeof hostState === 'object'
        && !Array.isArray(hostState)
        ? { ...(hostState as Record<string, unknown>) }
        : {};
    return {
        ...state,
        [HISTORY_STATE_KEY]: {
            owner: HISTORY_OWNER,
            version: 2,
            token,
            hostState,
            traversal,
            nextDirection,
        },
    };
}

function nextHistoryToken(): string {
    historyTokenSequence += 1;
    const uuid = globalThis.crypto?.randomUUID?.();
    return uuid
        ? `${uuid}-${historyTokenSequence}`
        : `${Date.now().toString(36)}-${historyTokenSequence}`;
}

function readPersistedHistoryLedger(): {
    knownTokens: string[];
    pending: Array<[string, ModalHistoryMarker['nextDirection']]>;
} {
    try {
        const raw = sessionStorage.getItem(HISTORY_LEDGER_KEY);
        if (!raw) return { knownTokens: [], pending: [] };
        const parsed = JSON.parse(raw) as { knownTokens?: unknown; pending?: unknown };
        const strings = (value: unknown): string[] => Array.isArray(value)
            ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
            : [];
        const directions = (value: unknown): Array<[string, ModalHistoryMarker['nextDirection']]> => {
            if (!Array.isArray(value)) return [];
            const result: Array<[string, ModalHistoryMarker['nextDirection']]> = [];
            for (const item of value) {
                // Accept the original v2 string form as a conservative Back-first fallback.
                if (typeof item === 'string' && item.length > 0) {
                    result.push([item, 'back']);
                } else if (Array.isArray(item)) {
                    const token: unknown = item[0];
                    const direction: unknown = item[1];
                    if (typeof token === 'string'
                        && token.length > 0
                        && (direction === 'back' || direction === 'forward')) {
                        result.push([token, direction]);
                    }
                }
            }
            return result;
        };
        return {
            knownTokens: strings(parsed.knownTokens).slice(-MAX_RETIRED_HISTORY_TOKENS),
            pending: directions(parsed.pending).slice(-MAX_RETIRED_HISTORY_TOKENS),
        };
    } catch {
        return { knownTokens: [], pending: [] };
    }
}

function historyStateFingerprint(state: unknown): string | null {
    if (state === undefined) return 'undefined';
    try {
        const serialized = JSON.stringify(state);
        return serialized === undefined ? null : `${typeof state}:${serialized}`;
    } catch {
        return null;
    }
}

function getHistoryOwner(): ModalHistoryOwnerState {
    const globalWindow = window as ModalHistoryWindow;
    const current = globalWindow[HISTORY_GLOBAL_KEY];
    if (current?.version === 2
        && current.records instanceof Map
        && current.pendingBidirectional instanceof Map) {
        const pending = current.pendingBaseExit;
        if (pending !== null
            && (!pending
                || typeof pending.token !== 'string'
                || typeof pending.hostHref !== 'string'
                || (pending.hostStateFingerprint !== null
                    && typeof pending.hostStateFingerprint !== 'string'))) {
            // Adopt owners created by an earlier v2 chunk generation.
            current.pendingBaseExit = null;
        } else if (pending) {
            if (pending.nextDirectionAfterBack !== 'forward') {
                pending.nextDirectionAfterBack = null;
            }
            if (typeof pending.releaseReplaceStateWatch !== 'function') {
                pending.releaseReplaceStateWatch = null;
            }
        }
        return current;
    }

    const persisted = readPersistedHistoryLedger();
    const owner: ModalHistoryOwnerState = {
        version: 2,
        listener: null,
        records: new Map(),
        knownTokens: [...new Set(persisted.knownTokens)],
        pendingBidirectional: new Map(persisted.pending),
        pendingBaseExit: null,
        adoptionToken: null,
        configListener: null,
    };
    globalWindow[HISTORY_GLOBAL_KEY] = owner;
    return owner;
}

function persistHistoryLedger(owner: ModalHistoryOwnerState): void {
    try {
        sessionStorage.setItem(HISTORY_LEDGER_KEY, JSON.stringify({
            knownTokens: owner.knownTokens.slice(-MAX_RETIRED_HISTORY_TOKENS),
            pending: Array.from(owner.pendingBidirectional.entries()).slice(-MAX_RETIRED_HISTORY_TOKENS),
        }));
    } catch {
        // History cleanup remains functional in memory when storage is denied.
    }
}

function rememberHistoryToken(owner: ModalHistoryOwnerState, token: string): void {
    owner.knownTokens = owner.knownTokens.filter((known) => known !== token);
    owner.knownTokens.push(token);
    while (owner.knownTokens.length > MAX_RETIRED_HISTORY_TOKENS) {
        const removed = owner.knownTokens.shift();
        if (removed) owner.pendingBidirectional.delete(removed);
    }
    persistHistoryLedger(owner);
}

function markKnownTokensBidirectional(owner: ModalHistoryOwnerState): void {
    for (const token of owner.knownTokens) {
        if (!owner.pendingBidirectional.has(token)) owner.pendingBidirectional.set(token, 'back');
    }
    while (owner.pendingBidirectional.size > MAX_RETIRED_HISTORY_TOKENS) {
        const oldest = owner.pendingBidirectional.keys().next().value;
        if (!oldest) break;
        owner.pendingBidirectional.delete(oldest);
    }
    persistHistoryLedger(owner);
}

function forgetHistoryToken(owner: ModalHistoryOwnerState, token: string): void {
    const knownLength = owner.knownTokens.length;
    owner.knownTokens = owner.knownTokens.filter((known) => known !== token);
    const pending = owner.pendingBidirectional.delete(token);
    if (pending || owner.knownTokens.length !== knownLength) persistHistoryLedger(owner);
}

function clearPendingBaseExit(owner: ModalHistoryOwnerState): PendingBaseExit | null {
    const pending = owner.pendingBaseExit;
    if (!pending) return null;
    owner.pendingBaseExit = null;
    pending.releaseReplaceStateWatch?.();
    pending.releaseReplaceStateWatch = null;
    return pending;
}

function watchPendingMarkerReplacement(
    owner: ModalHistoryOwnerState,
    pending: PendingBaseExit
): (() => void) | null {
    const originalDescriptor = Object.getOwnPropertyDescriptor(history, 'replaceState');
    const original = history.replaceState.bind(history);
    let active = true;
    const wrapped = function(
        this: History,
        data: unknown,
        unused: string,
        url?: string | URL | null
    ): void {
        if (this !== history) {
            History.prototype.replaceState.call(this, data, unused, url);
            return;
        }
        const currentMarker = readModalHistoryMarker(history.state);
        original(data, unused, url);
        if (owner.pendingBaseExit !== pending
            || currentMarker?.token !== pending.token
            || readModalHistoryMarker(history.state)?.token === pending.token) return;

        // replaceState removed the exact current marker before its delayed
        // Back. The replacement is now a real current entry, so the base pop
        // must not be auto-continued past that route's predecessor.
        clearPendingBaseExit(owner);
        forgetHistoryToken(owner, pending.token);
    };
    try {
        history.replaceState = wrapped;
    } catch {
        return null;
    }
    return () => {
        if (!active) return;
        active = false;
        if (history.replaceState !== wrapped) return;
        if (originalDescriptor) {
            Object.defineProperty(history, 'replaceState', originalDescriptor);
        } else {
            Reflect.deleteProperty(history, 'replaceState');
        }
    };
}

function armPendingBaseExit(
    owner: ModalHistoryOwnerState,
    marker: ModalHistoryMarker,
    nextDirectionAfterBack: PendingBaseExit['nextDirectionAfterBack'] = null
): void {
    clearPendingBaseExit(owner);
    rememberHistoryToken(owner, marker.token);
    const pending: PendingBaseExit = {
        token: marker.token,
        hostState: marker.hostState,
        hostStateFingerprint: historyStateFingerprint(marker.hostState),
        hostHref: location.href,
        nextDirectionAfterBack,
        releaseReplaceStateWatch: null,
    };
    owner.pendingBaseExit = pending;
    pending.releaseReplaceStateWatch = watchPendingMarkerReplacement(owner, pending);
}

function pendingBaseExitMatchesState(
    pending: PendingBaseExit,
    state: unknown,
    href: string
): boolean {
    if (href !== pending.hostHref) return false;
    if (Object.is(state, pending.hostState)) return true;
    const eventFingerprint = historyStateFingerprint(state);
    return pending.hostStateFingerprint !== null
        && eventFingerprint === pending.hostStateFingerprint;
}

function pendingBaseExitMatches(pending: PendingBaseExit, event: PopStateEvent): boolean {
    return pendingBaseExitMatchesState(pending, event.state, location.href);
}

function commitPendingBaseExit(owner: ModalHistoryOwnerState, pending: PendingBaseExit): void {
    if (pending.nextDirectionAfterBack === 'forward') {
        rememberHistoryToken(owner, pending.token);
        owner.pendingBidirectional.set(pending.token, 'forward');
        persistHistoryLedger(owner);
        return;
    }
    forgetHistoryToken(owner, pending.token);
}

function handlePendingBaseExitPop(
    owner: ModalHistoryOwnerState,
    event: PopStateEvent,
    marker: ModalHistoryMarker | null
): boolean {
    const pending = owner.pendingBaseExit;
    if (!pending) return false;
    if (!pendingBaseExitMatches(pending, event)) {
        // Another real entry became current before the deferred base. Preserve
        // two-way traversal around every buried marker and let that host pop
        // proceed normally instead of navigating over it.
        clearPendingBaseExit(owner);
        markKnownTokensBidirectional(owner);
        return false;
    }

    event.stopImmediatePropagation();
    clearPendingBaseExit(owner);
    commitPendingBaseExit(owner, pending);
    if (marker) {
        // Nested modal markers embed the preceding marker as hostState. Walk
        // the complete private chain before applying the user's real Back.
        const nextDirection = marker.traversal === 'bidirectional'
            || owner.pendingBidirectional.has(marker.token)
            ? 'forward'
            : null;
        armPendingBaseExit(owner, marker, nextDirection);
    }
    try {
        history.back();
    } catch (error) {
        // When the exact base is already current, a failed continuation leaves
        // a real host entry current. For a nested marker, the newly armed
        // tombstone remains available for the next attempt.
        console.warn(`${logPrefix} could not continue a deferred modal history exit:`, error);
    }
    return true;
}

function topHistoryRecord(owner: ModalHistoryOwnerState): ModalHistoryRecord | null {
    let result: ModalHistoryRecord | null = null;
    for (const record of owner.records.values()) result = record;
    return result;
}

function replaceCurrentModalMarker(marker: ModalHistoryMarker): boolean {
    try {
        history.replaceState(
            taggedHistoryState(
                marker.token,
                marker.hostState,
                marker.traversal,
                marker.nextDirection
            ),
            '',
            location.href
        );
        return true;
    } catch (error) {
        console.warn(`${logPrefix} could not update a private modal history marker:`, error);
        return false;
    }
}

function retiredMarkerDirection(
    owner: ModalHistoryOwnerState,
    marker: ModalHistoryMarker
): ModalHistoryMarker['nextDirection'] {
    return owner.pendingBidirectional.get(marker.token)
        ?? (marker.traversal === 'bidirectional' ? marker.nextDirection : 'back');
}

function traverseRetiredMarker(
    owner: ModalHistoryOwnerState,
    marker: ModalHistoryMarker,
    forceBidirectional = false
): void {
    const pendingDirection = owner.pendingBidirectional.get(marker.token);
    if (marker.traversal !== 'bidirectional' && !pendingDirection && !forceBidirectional) {
        try {
            history.back();
        } catch (error) {
            rememberHistoryToken(owner, marker.token);
            owner.pendingBidirectional.set(marker.token, 'back');
            persistHistoryLedger(owner);
            throw error;
        }
        forgetHistoryToken(owner, marker.token);
        return;
    }

    const direction = retiredMarkerDirection(owner, marker);
    const nextDirection = direction === 'back' ? 'forward' : 'back';
    const retagged = replaceCurrentModalMarker({
        ...marker,
        traversal: 'bidirectional',
        nextDirection,
    });
    if (!retagged) {
        // The marker remains terminal (or retains its old direction). Keep the
        // opposite traversal durably so the next encounter still reaches the
        // real route on the other side instead of bouncing forever.
        rememberHistoryToken(owner, marker.token);
        owner.pendingBidirectional.set(marker.token, nextDirection);
        persistHistoryLedger(owner);
    }
    try {
        if (direction === 'forward') history.forward();
        else history.back();
    } catch (error) {
        // Retagging records the direction expected *after* a successful move.
        // A rejected move must retry its original direction instead.
        rememberHistoryToken(owner, marker.token);
        owner.pendingBidirectional.set(marker.token, direction);
        persistHistoryLedger(owner);
        throw error;
    }
    if (retagged) forgetHistoryToken(owner, marker.token);
}

function handleModalHistoryPop(event: PopStateEvent): void {
    const owner = getHistoryOwner();
    owner.adoptionToken = null;
    const marker = readModalHistoryMarker(event.state);
    if (handlePendingBaseExitPop(owner, event, marker)) return;
    if (!marker) {
        // Host/base entries are never wrapped. Their exact event.state is
        // delivered unchanged to routers registered before and after us.
        let top = topHistoryRecord(owner);
        while (top) {
            const token = top.token;
            top.closeFromHistory();
            forgetHistoryToken(owner, token);
            top = topHistoryRecord(owner);
        }
        return;
    }

    // An owned modal marker is a private same-document sentinel, never a host
    // destination. Repair any replaceState performed by an earlier router and
    // keep later routers from rendering the transient entry.
    const currentMarker = readModalHistoryMarker(history.state);
    if (currentMarker?.token !== marker.token) replaceCurrentModalMarker(marker);
    event.stopImmediatePropagation();

    // A multi-entry traversal can bypass more than one live nested modal.
    // Close every modal above the marker that the browser actually reached.
    let top = topHistoryRecord(owner);
    let closedAbove = false;
    while (top && top.token !== marker.token) {
        top.closeFromHistory();
        closedAbove = true;
        top = topHistoryRecord(owner);
    }

    const reached = owner.records.get(marker.token);
    if (reached && closedAbove) {
        // A one-step Back from an inner modal lands on the still-live outer
        // modal marker. That marker is the intended current UI, not a ghost.
        return;
    }
    if (reached) {
        // Returning from a newer host route reaches this modal's own marker.
        // Retire its UI and continue through the private entry to the host base.
        reached.closeFromHistory();
    } else if (topHistoryRecord(owner)) {
        // The reached marker is retired but an older live modal remains below
        // it. The private entry still must be skipped before that modal resumes.
    }

    // A still-live marker can only be reached from a newer host entry: Back
    // from the marker itself would have landed on its untagged base and closed
    // through the branch above. Preserve two-way reachability to that newer
    // route even if the UI had not been explicitly retired there first.
    try {
        traverseRetiredMarker(owner, marker, Boolean(reached));
    } catch (error) {
        console.warn(`${logPrefix} could not traverse a retired modal history marker:`, error);
    }
}

function ensureHistoryOwner(): ModalHistoryOwnerState {
    const owner = getHistoryOwner();
    if (owner.listener !== handleModalHistoryPop) {
        if (owner.listener) window.removeEventListener('popstate', owner.listener, true);
        window.addEventListener('popstate', handleModalHistoryPop, { capture: true });
        owner.listener = handleModalHistoryPop;
    }
    return owner;
}

function adoptCurrentHistoryMarker(owner: ModalHistoryOwnerState): void {
    const marker = readModalHistoryMarker(history.state);
    if (!marker || owner.records.has(marker.token) || owner.adoptionToken === marker.token) return;
    owner.adoptionToken = marker.token;
    const direction = retiredMarkerDirection(owner, marker);
    const preserveBidirectionalDirection = marker.traversal === 'bidirectional'
        || owner.pendingBidirectional.has(marker.token);
    try {
        traverseRetiredMarker(owner, marker);
    } catch (error) {
        owner.adoptionToken = null;
        const current = readModalHistoryMarker(history.state);
        if (current?.token === marker.token) {
            if (direction === 'back') {
                armPendingBaseExit(
                    owner,
                    current,
                    preserveBidirectionalDirection ? 'forward' : null
                );
            }
            else rememberHistoryToken(owner, current.token);
        }
        console.warn(`${logPrefix} could not traverse a reloaded modal history marker:`, error);
    }
}

/**
 * Creates and manages a generic modal for Seerr requests.
 * @param {object} options - Configuration for the modal.
 * @param {string} options.title - The main title of the modal.
 * @param {string} options.subtitle - The subtitle (usually the movie/show name).
 * @param {string} options.bodyHtml - The HTML content for the modal body.
 * @param {string} options.backdropPath - TMDB backdrop image path (e.g., '/abc123.jpg').
 * @param {string} options.backdropUrl - Full backdrop image URL (alternative to backdropPath).
 * @param {function} options.onSave - The callback function to execute when the primary button is clicked.
 * @param {function} [options.onClose] - Optional cleanup callback invoked before the modal is removed.
 * @param {string} [options.buttonText] - Optional custom text for the primary button (defaults to localized 'Request').
 * @returns {object} - An object with methods to show and close the modal.
 */
modal.create = function({ title, subtitle, bodyHtml, backdropPath, backdropUrl, onSave, onClose, buttonText }) {
    const identity = JC.identity.capture();
    const modalElement = document.createElement('div') as IdentityCleanupElement;
    modalElement.className = 'seerr-season-modal';
    modalElement.dataset.jcIdentityOwned = 'true';
    JC.identity.own(modalElement, identity);
    modalElement.setAttribute('role', 'dialog');
    modalElement.setAttribute('aria-modal', 'true');
    modalElement.setAttribute('tabindex', '-1');

    // Support both backdropUrl (full URL) and backdropPath (TMDB path)
    let backdropImage;
    if (backdropUrl) {
        backdropImage = `url('${escapeHtml(backdropUrl)}')`;
    } else if (backdropPath) {
        backdropImage = `url('https://image.tmdb.org/t/p/w1280${escapeHtml(backdropPath)}')`;
    } else {
        backdropImage = 'linear-gradient(45deg, #3b82f6, #8b5cf6)';
    }

    // Build modal structure — bodyHtml is intentionally trusted HTML from internal callers
    const contentEl = document.createElement('div');
    contentEl.className = 'seerr-season-content';
    contentEl.setAttribute('role', 'document');
    contentEl.setAttribute('aria-labelledby', 'seerr-modal-title');

    const headerEl = document.createElement('div');
    headerEl.className = 'seerr-season-header';
    headerEl.style.cssText = `background-image: ${backdropImage}; background-size: cover; background-position: center;`;

    const titleEl = document.createElement('div');
    titleEl.id = 'seerr-modal-title';
    titleEl.className = 'seerr-season-title';
    titleEl.textContent = title;

    const subtitleEl = document.createElement('div');
    subtitleEl.className = 'seerr-season-subtitle';
    subtitleEl.textContent = subtitle;

    headerEl.appendChild(titleEl);
    headerEl.appendChild(subtitleEl);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'seerr-modal-body';
    bodyEl.style.cssText = 'padding: 24px; max-height: calc(80vh - 200px); overflow-y: auto;';
    bodyEl.innerHTML = bodyHtml;

    const footerEl = document.createElement('div');
    footerEl.className = 'seerr-modal-footer';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'seerr-modal-button seerr-modal-button-secondary';
    cancelBtn.setAttribute('aria-label', JC.t!('seerr_modal_cancel'));
    cancelBtn.textContent = JC.t!('seerr_modal_cancel');

    const primaryBtn = document.createElement('button');
    primaryBtn.className = 'seerr-modal-button seerr-modal-button-primary';
    primaryBtn.setAttribute('aria-label', buttonText || JC.t!('seerr_modal_request'));
    primaryBtn.textContent = buttonText || JC.t!('seerr_modal_request');

    footerEl.appendChild(cancelBtn);
    footerEl.appendChild(primaryBtn);

    contentEl.appendChild(headerEl);
    contentEl.appendChild(bodyEl);
    contentEl.appendChild(footerEl);

    modalElement.appendChild(contentEl);

    // A11Y-5: focus trap + Escape + focus RESTORE come from the shared modal
    // util (the former hand-rolled handleKeydown trapped focus but never
    // restored it, and never counted toward the jc-modal-open shortcut gate).
    let a11y: ModalA11yHandle | null = null;

    let isClosing = false;
    let showTimer: ReturnType<typeof setTimeout> | null = null;
    let removeTimer: ReturnType<typeof setTimeout> | null = null;
    let historyToken: string | null = null;
    let historyBackRequested = false;
    let focusReturnTarget: HTMLElement | null = null;
    const cleanups = new Set<() => void>();
    modalElement._jcIdentityCleanups = cleanups;
    const isCurrent = () => !!identity
        && JC.identity.isCurrent(identity)
        && !isClosing
        && !historyBackRequested;

    const show = () => {
        if (installLeases <= 0 || JC.seerrModal !== modal) {
            // A handle retained from a retired chunk generation must never
            // reinstall that generation's document-wide history delegate.
            // Settle the never-shown handle locally instead.
            requestClose(true);
            return;
        }
        if (!isCurrent() || document.body.contains(modalElement)) return;
        document.body.appendChild(modalElement);
        document.body.classList.add('seerr-modal-is-open');
        // The host/base entry is deliberately left byte-for-byte untouched so
        // every router sees its original PopStateEvent.state. Only the private
        // same-URL modal sentinel is tagged and later skipped by our owner.
        const owner = ensureHistoryOwner();
        const token = nextHistoryToken();
        const hostState: unknown = history.state;
        historyToken = token;
        try {
            history.pushState(taggedHistoryState(token, hostState), '', location.href);
        } catch (error) {
            // The base was never mutated, so cleanup is sufficient even when
            // the browser rejects the private sentinel.
            closeInternal(true, false);
            throw error;
        }
        rememberHistoryToken(owner, token);
        owner.records.set(token, {
            token,
            closeFromHistory: () => {
                const restoreFocus = topHistoryRecord(owner)?.token === token;
                closeInternal(false, restoreFocus);
            },
            destroy: () => requestClose(true),
            rebaseFocusReturn: (removedRoot, replacement) => {
                if (focusReturnTarget && removedRoot.contains(focusReturnTarget)) {
                    focusReturnTarget = replacement;
                }
            },
        });
        try {
            focusReturnTarget = document.activeElement as HTMLElement | null;
            a11y = installModalA11y(modalElement, {
                labelledBy: 'seerr-modal-title',
                initialFocus: () => modalElement.querySelector<HTMLElement>('button:not([disabled]), select, input'),
                onEscape: () => requestClose(false),
            });
            showTimer = setTimeout(() => {
                showTimer = null;
                if (isCurrent() && document.body.contains(modalElement)) modalElement.classList.add('show');
            }, 10);
        } catch (error) {
            // pushState already published a private entry. Use the same owned
            // one-shot close path so a later setup failure cannot strand it.
            requestClose(true);
            throw error;
        }
    };

    const finishClose = () => {
        if (document.body.contains(modalElement)) modalElement.remove();
        activeModals.delete(handle);
        if (!document.querySelector('.seerr-season-modal')) {
            document.body.classList.remove('seerr-modal-is-open');
        }
    };

    const closeInternal = (immediate: boolean, restoreFocus = true) => {
        if (isClosing) return;
        isClosing = true;
        const owner = getHistoryOwner();
        if (historyToken !== null) {
            owner.records.delete(historyToken);
            if (!restoreFocus) {
                for (const record of owner.records.values()) {
                    record.rebaseFocusReturn(modalElement, focusReturnTarget);
                }
            }
        }

        if (showTimer !== null) {
            clearTimeout(showTimer);
            showTimer = null;
        }
        if (removeTimer !== null) {
            clearTimeout(removeTimer);
            removeTimer = null;
        }
        for (const cleanup of cleanups) {
            try { cleanup(); } catch { /* continue closing */ }
        }
        cleanups.clear();

        if (typeof onClose === 'function') {
            try {
                onClose();
            } catch (err) {
                console.error(`${logPrefix} onClose handler failed:`, err);
            }
        }

        a11y?.release(false);
        a11y = null;
        if (restoreFocus
            && focusReturnTarget
            && document.contains(focusReturnTarget)) focusReturnTarget.focus();
        modalElement.classList.remove('show');
        if (immediate) {
            finishClose();
        } else {
            removeTimer = setTimeout(() => {
                removeTimer = null;
                finishClose();
            }, 300);
        }
    };
    const requestClose = (immediate: boolean) => {
        const owner = getHistoryOwner();
        if (isClosing) {
            // A normal Back/success close releases interaction immediately but
            // leaves the fading DOM owned until its 300 ms removal timer. An
            // identity/config teardown during that window must upgrade the
            // pending close to synchronous removal so stale controls cannot
            // remain connected in the new owner epoch.
            if (immediate && removeTimer !== null) {
                clearTimeout(removeTimer);
                removeTimer = null;
                finishClose();
            }
            return;
        }
        if (historyBackRequested) {
            // A teardown boundary cannot wait for an already-requested browser
            // traversal: retire stale controls now and consume the token here,
            // because the pending host pop will no longer find its live record.
            if (immediate) {
                closeInternal(true, false);
                if (historyToken !== null) forgetHistoryToken(owner, historyToken);
            }
            return;
        }
        const marker = readModalHistoryMarker(history.state);
        if (historyToken !== null
            && marker?.token === historyToken) {
            historyBackRequested = true;
            try {
                history.back();
            } catch (error) {
                // replaceState cannot remove the private entry: rewriting it
                // to look like the host would merely turn the next Back into
                // an invisible same-URL stop. A user close keeps the live modal
                // interactive; synchronous teardown retires stale UI but leaves
                // a document-global tombstone that applies the next real Back
                // after the exact hidden base transition.
                historyBackRequested = false;
                if (immediate) {
                    closeInternal(true, false);
                    const current = readModalHistoryMarker(history.state);
                    if (current?.token === historyToken) {
                        const nextDirection = current.traversal === 'bidirectional'
                            || owner.pendingBidirectional.has(current.token)
                            ? 'forward'
                            : null;
                        armPendingBaseExit(owner, current, nextDirection);
                    } else if (!current) {
                        markKnownTokensBidirectional(owner);
                    }
                }
                console.warn(`${logPrefix} could not consume a modal history entry:`, error);
                return;
            }
            // Identity/config teardown must synchronously retire stale controls.
            if (immediate) {
                closeInternal(true, false);
                // The live record was removed before the asynchronous base
                // pop, so that event cannot consume this token for us. Leaving
                // it persisted would let a later install promote a terminal
                // forward-only sentinel into a bidirectional dead end.
                if (historyToken !== null) forgetHistoryToken(owner, historyToken);
            }
            return;
        }

        // An intervening host entry or another modal owns the current entry.
        // Never back over it. A real host entry means every known private
        // marker behind it may need two-way skipping; a nested modal marker
        // alone does not create a newer real destination.
        if (historyToken !== null
            && !marker
            && owner.records.has(historyToken)) {
            // History exposes no supported entry identity or reliable way to
            // distinguish a host push from a replace. Conservatively prepare
            // every known private marker for two-way skipping; tokens for a
            // replaced-away marker are harmless and both ledgers are bounded.
            // This never uses history.length to guess and never navigates the
            // host while a non-owned entry is current.
            markKnownTokensBidirectional(owner);
        }
        closeInternal(immediate, false);
    };
    const close = () => requestClose(false);

    // Event listeners for closing the modal
    cancelBtn.addEventListener('click', () => { if (isCurrent()) requestClose(false); });
    modalElement.addEventListener('click', (e: MouseEvent) => { if (isCurrent() && e.target === modalElement) requestClose(false); });

    // Event listener for the primary action button
    primaryBtn.addEventListener('click', () => {
        if (!isCurrent()) return;
        void onSave(modalElement, primaryBtn, close);
    });

    const handle: ManagedModal = { modalElement, show, close, destroy: () => requestClose(true) };
    activeModals.add(handle);
    return handle;
};

/**
 * Generates the HTML string for the advanced request options form.
 * @param {string} idPrefix - A prefix ('movie' or 'tv') to ensure unique element IDs.
 * @returns {string} - The HTML content for the form.
 */
modal.createAdvancedOptionsHTML = function(idPrefix) {
    return `
        <div class="seerr-advanced-options">
            <h3>${JC.t!('seerr_advanced_options')}</h3>
            <div class="seerr-form-row">
                <div class="seerr-form-group">
                    <label for="${idPrefix}-server">${JC.t!('seerr_server_select')}</label>
                    <select is="emby-select" id="${idPrefix}-server" class="emby-select"></select>
                </div>
                <div class="seerr-form-group">
                    <label for="${idPrefix}-quality">${JC.t!('seerr_quality_select')}</label>
                    <select is="emby-select" id="${idPrefix}-quality" class="emby-select"></select>
                </div>
            </div>
            <div class="seerr-form-row">
                <div class="seerr-form-group">
                    <label for="${idPrefix}-folder">${JC.t!('seerr_folder_select')}</label>
                    <select is="emby-select" id="${idPrefix}-folder" class="emby-select"></select>
                </div>
            </div>
        </div>
    `;
};

/**
 * Populates the select dropdowns in the advanced options form.
 * @param {HTMLElement} modalElement - The root element of the modal.
 * @param {object} data - The data fetched from the API, containing servers, profiles, and folders.
 * @param {string} idPrefix - The prefix ('movie' or 'tv') used for the element IDs.
 */
modal.populateAdvancedOptions = function(modalElement, data, idPrefix) {
    const identity = JC.identity.ownerOf(modalElement) || JC.identity.capture();
    const isCurrent = () => !!identity
        && JC.identity.isCurrent(identity)
        && document.body.contains(modalElement);
    // Backend failed to load server options: show an error note instead of
    // polling for selects that will only ever be populated with empty
    // placeholders — three empty dropdowns look like a valid config (W4-ERR-5).
    if (data && data.error) {
        const container = modalElement.querySelector('.seerr-advanced-options');
        if (container) {
            container.innerHTML = `<h3>${JC.t!('seerr_advanced_options')}</h3><div class="seerr-advanced-error">${JC.escapeHtml(data.error)}</div>`;
        }
        return;
    }

    // Use a timer to ensure emby-select elements are ready
    let attempts = 0;
    const maxAttempts = 50; // 5 seconds
    const interval = setInterval(() => {
        if (!isCurrent()) {
            clearInterval(interval);
            return;
        }
        const serverSelect = modalElement.querySelector<HTMLSelectElement>(`#${idPrefix}-server`);
        const qualitySelect = modalElement.querySelector<HTMLSelectElement>(`#${idPrefix}-quality`);
        const folderSelect = modalElement.querySelector<HTMLSelectElement>(`#${idPrefix}-folder`);

        if (serverSelect && qualitySelect && folderSelect) {
            clearInterval(interval);

            serverSelect.innerHTML = '<option value="">Select Server...</option>';
            qualitySelect.innerHTML = '<option value="">Select Quality...</option>';
            folderSelect.innerHTML = '<option value="">Select Folder...</option>';

            data.servers.forEach((server: any) => {
                const option = document.createElement('option');
                option.value = server.id;
                option.textContent = server.name || `Server ${server.id}`;
                if (server.isDefault) option.selected = true;
                serverSelect.appendChild(option);
            });

            function updateServerDependentOptions() {
                const selectedServer = data.servers.find((s: any) => s.id == serverSelect!.value);
                qualitySelect!.innerHTML = '<option value="">Select Quality...</option>';
                folderSelect!.innerHTML = '<option value="">Select Folder...</option>';
                if (!selectedServer) return;

                selectedServer.qualityProfiles.forEach((profile: any) => {
                    const option = document.createElement('option');
                    option.value = profile.id;
                    option.textContent = profile.name || `Profile ${profile.id}`;
                    if (profile.id === selectedServer.activeProfileId) option.selected = true;
                    qualitySelect!.appendChild(option);
                });
                selectedServer.rootFolders.forEach((folder: any) => {
                    const option = document.createElement('option');
                    option.value = folder.path;
                    option.textContent = folder.path;
                    if (folder.path === selectedServer.activeDirectory) option.selected = true;
                    folderSelect!.appendChild(option);
                });
            }

            serverSelect.addEventListener('change', updateServerDependentOptions);
            // Trigger initial population if a default server is selected
            if (serverSelect.value) {
                updateServerDependentOptions();
            }

        } else {
            attempts++;
            if (attempts > maxAttempts) {
                clearInterval(interval);
                console.error(`${logPrefix} Could not find advanced options elements in modal after ${maxAttempts} attempts.`);
            }
        }
    }, 100);
    const cleanups = (modalElement as IdentityCleanupElement)._jcIdentityCleanups;
    cleanups?.add(() => clearInterval(interval));
};

modal.closeAll = function(): void {
    const owner = getHistoryOwner();
    // Records are document-global so a newer chunk generation can still
    // retire modals created by an older generation. Work newest-first to issue
    // at most one Back for the currently owned sentinel.
    for (const record of Array.from(owner.records.values()).reverse()) {
        record.destroy();
    }
    // Also retire handles created but never shown by this module generation.
    for (const active of [...activeModals]) active.destroy();
};

let uninstallIdentityReset: (() => void) | null = null;
let installLeases = 0;

export function installSeerrModal(): () => void {
    JC.seerrModal = modal;
    const historyOwner = ensureHistoryOwner();
    const currentMarker = readModalHistoryMarker(history.state);
    const pendingBaseExit = historyOwner.pendingBaseExit;
    if (!currentMarker
        && pendingBaseExit
        && !pendingBaseExitMatchesState(pendingBaseExit, history.state, location.href)) {
        // A route mutation or hot-generation handoff replaced/pushed over the
        // pending marker without going through our temporary method observer.
        // It is no longer safe to auto-continue an eventual matching base pop.
        clearPendingBaseExit(historyOwner);
    }
    if (!currentMarker
        && historyOwner.records.size === 0
        && historyOwner.knownTokens.length > 0) {
        // A full reload on a newer host route discards the modal DOM/closures
        // but not its Back-list sentinel. Persist the two-way intent so the
        // first encounter can promote direction into the marker itself.
        markKnownTokensBidirectional(historyOwner);
    }
    adoptCurrentHistoryMarker(historyOwner);
    if (installLeases === 0) {
        const unregisterReset = JC.identity.registerReset('seerr-request-modal', modal.closeAll);
        // Advanced modals snapshot the 4K gate. Retire them at config boundaries.
        try {
            if (historyOwner.configListener
                && historyOwner.configListener !== modal.closeAll) {
                window.removeEventListener('jc:config-changed', historyOwner.configListener);
            }
            window.addEventListener('jc:config-changed', modal.closeAll);
            historyOwner.configListener = modal.closeAll;
        } catch (error) {
            unregisterReset();
            throw error;
        }
        uninstallIdentityReset = unregisterReset;
    }
    installLeases += 1;
    let installed = true;
    return () => {
        if (!installed) return;
        installed = false;
        installLeases -= 1;
        if (installLeases > 0) return;
        uninstallIdentityReset?.();
        uninstallIdentityReset = null;
        if (historyOwner.configListener === modal.closeAll) {
            window.removeEventListener('jc:config-changed', modal.closeAll);
            historyOwner.configListener = null;
        }
        if (historyOwner.listener === handleModalHistoryPop) {
            // Only the generation that currently owns the document-wide
            // delegate may drain document-global records. A stale disposer
            // must not close modals created by the replacement generation.
            modal.closeAll();
        } else {
            // Still retire this generation's shown and never-shown handles.
            for (const active of [...activeModals]) active.destroy();
        }
    };
}
