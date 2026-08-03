// src/seerr/modal.ts
import { JC } from '../globals';
import { installModalA11y, type ModalA11yHandle } from '../core/modal-a11y';
import type { HistoryMutation } from '../types/jc';

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
const MODAL_TITLE_SEQUENCE_KEY = '__jellyfinCanopySeerrModalTitleSequenceV1';
const MAX_RETIRED_HISTORY_TOKENS = 128;

interface ModalHistoryMarker {
    owner: typeof HISTORY_OWNER;
    version: 2;
    token: string;
    hostState: unknown;
    traversal: 'terminal' | 'bidirectional';
    nextDirection: 'back' | 'forward';
    /** Exact older entry identity on Navigation API-capable clients. */
    hostNavigationKey?: string;
}

interface ModalHistoryState extends Record<string, unknown> {
    [HISTORY_STATE_KEY]: ModalHistoryMarker;
}

interface ModalHistoryRecord {
    token: string;
    hostState: unknown;
    hostStateFingerprint: string | null;
    hostHref: string;
    hostNavigationKey: string | null;
    /** A host entry was prospectively observed above this live marker. */
    buriedByHost: boolean;
    /** A host write retained/copied this token after its private publication. */
    hostMutationObserved: boolean;
    /** The next browser pop is the owned Back issued from this exact marker. */
    pendingOwnedBack: boolean;
    closeFromHistory: () => void;
    destroy: () => void;
}

interface PendingBaseExit {
    token: string;
    hostState: unknown;
    hostStateFingerprint: string | null;
    hostHref: string;
    hostNavigationKey: string | null;
    /** Durable direction to commit after the delayed Back crosses this marker. */
    nextDirectionAfterBack: 'forward' | null;
    /** Removes the temporary observer that detects replacement of this marker. */
    releaseReplaceStateWatch: (() => void) | null;
}

interface PendingOwnedTraversal {
    token: string;
    markerHref: string;
    phase: 'queued' | 'issued' | 'superseded-queued' | 'superseded-issued' | 'superseded-reactive-push' | 'recovering-forward';
    hostState: unknown;
    hostStateFingerprint: string | null;
    hostHref: string;
    markerNavigationKey: string | null;
    hostNavigationKey: string | null;
    classicEntriesAboveBase: number;
    /** One deferred classic retry; canceled logically when the original Back wins. */
    classicRetryQueued: boolean;
    lastHostEntryKey: string | null;
    /** Recovery has crossed this transaction's private marker toward its target. */
    recoveringMarkerCrossed: boolean;
    /** Retagged private entry to restore while an issued traversal is still on it. */
    markerSnapshot: ModalHistoryMarker | null;
}

interface RetiredModalBase {
    token: string;
    hostState: unknown;
    hostStateFingerprint: string | null;
    hostNavigationKey: string | null;
}

interface HostHistorySnapshot {
    state: unknown;
    href: string;
    navigationKey: string | null;
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
    /** The one modal traversal that can own (or be superseded during) a browser Back. */
    pendingOwnedTraversal: PendingOwnedTraversal | null;
    /** A synchronous router PUSH observed from the immutable private marker pop. */
    markerPopPushWinner: ModalHistoryMarker | null;
    /** Exact older-side neighbors for buried markers skipped by history.go/menu jumps. */
    retiredBases: Map<string, RetiredModalBase>;
    /** Last real entry observed, used to quarantine a delayed copied private marker. */
    lastHostEntry: HostHistorySnapshot | null;
    adoptionToken: string | null;
    configListener: (() => void) | null;
    historyObserver: ((mutation: HistoryMutation) => void) | null;
    routeObserver: ((event?: Event) => void) | null;
    releaseNavigationObservers: (() => void) | null;
    /** Suppresses the public mutation hook around this owner's private rewrites. */
    internalHistoryWriteDepth: number;
}

type ModalHistoryWindow = Window & {
    [HISTORY_GLOBAL_KEY]?: ModalHistoryOwnerState;
    [MODAL_TITLE_SEQUENCE_KEY]?: number;
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
    nextDirection: ModalHistoryMarker['nextDirection'] = 'back',
    hostNavigationKey: string | null = null
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
            ...(hostNavigationKey ? { hostNavigationKey } : {}),
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

function nextModalTitleId(): string {
    const globalWindow = window as ModalHistoryWindow;
    const stored = globalWindow[MODAL_TITLE_SEQUENCE_KEY];
    let sequence = Number.isSafeInteger(stored) && (stored ?? 0) > 0
        ? stored as number
        : 0;
    let id: string;
    do {
        sequence = sequence >= Number.MAX_SAFE_INTEGER ? 1 : sequence + 1;
        id = `seerr-modal-title-${sequence}`;
    } while (document.getElementById(id));
    globalWindow[MODAL_TITLE_SEQUENCE_KEY] = sequence;
    return id;
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
    try {
        const seen = new Map<object, number>();
        const encode = (value: unknown): unknown => {
            if (value === null) return ['null'];
            switch (typeof value) {
                case 'undefined': return ['undefined'];
                case 'boolean': return ['boolean', value];
                case 'string': return ['string', value];
                case 'bigint': return ['bigint', value.toString()];
                case 'number':
                    if (Number.isNaN(value)) return ['number', 'NaN'];
                    if (value === Infinity) return ['number', 'Infinity'];
                    if (value === -Infinity) return ['number', '-Infinity'];
                    if (Object.is(value, -0)) return ['number', '-0'];
                    return ['number', value];
                case 'symbol':
                case 'function':
                    throw new TypeError('unsupported history state value');
            }

            const object = value;
            const priorId = seen.get(object);
            if (priorId !== undefined) return ['reference', priorId];
            const id = seen.size;
            seen.set(object, id);

            if (Array.isArray(value)) {
                const entries = Array.from({ length: value.length }, (_, index) =>
                    Object.prototype.hasOwnProperty.call(value, index)
                        ? encode(value[index])
                        : ['hole']);
                const extra = Object.keys(value)
                    .filter((key) => !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)
                    .sort()
                    .map((key) => [key, encode((value as unknown as Record<string, unknown>)[key])]);
                return ['array', id, entries, extra];
            }
            if (value instanceof Date) {
                return ['date', id, Number.isNaN(value.getTime()) ? 'invalid' : value.toISOString()];
            }
            if (value instanceof RegExp) return ['regexp', id, value.source, value.flags];
            if (value instanceof Map) {
                return ['map', id, Array.from(value, ([key, item]) => [encode(key), encode(item)])];
            }
            if (value instanceof Set) return ['set', id, Array.from(value, encode)];
            if (value instanceof ArrayBuffer) {
                return ['array-buffer', id, Array.from(new Uint8Array(value))];
            }
            if (ArrayBuffer.isView(value)) {
                return [
                    'array-buffer-view',
                    id,
                    value.constructor.name,
                    Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
                ];
            }
            if (typeof Blob !== 'undefined' && value instanceof Blob) {
                if (typeof File !== 'undefined' && value instanceof File) {
                    return ['file', id, value.name, value.size, value.type, value.lastModified];
                }
                // Blob bytes are asynchronous-only. Size/type are the strongest
                // synchronous structured-clone identity available, analogous to
                // the structural fallback already required for plain objects.
                return ['blob', id, value.size, value.type];
            }
            if (value instanceof Error) {
                return [
                    'error',
                    id,
                    value.name,
                    value.message,
                    'cause' in value ? encode(value.cause) : ['absent'],
                ];
            }

            const record = value as Record<string, unknown>;
            return [
                'object',
                id,
                Object.keys(record).sort().map((key) => [key, encode(record[key])]),
            ];
        };
        return JSON.stringify(encode(state));
    } catch {
        return null;
    }
}

function findMarkerInPrivateChain(state: unknown, token: string): ModalHistoryMarker | null {
    const visited = new Set<string>();
    let marker = readModalHistoryMarker(state);
    while (marker && !visited.has(marker.token)) {
        if (marker.token === token) return marker;
        visited.add(marker.token);
        marker = readModalHistoryMarker(marker.hostState);
    }
    return null;
}

function getHistoryOwner(): ModalHistoryOwnerState {
    const globalWindow = window as ModalHistoryWindow;
    const current = globalWindow[HISTORY_GLOBAL_KEY];
    if (current?.version === 2
        && current.records instanceof Map
        && current.pendingBidirectional instanceof Map) {
        if (!(current.retiredBases instanceof Map)) current.retiredBases = new Map();
        if (current.lastHostEntry !== null
            && (!current.lastHostEntry
                || typeof current.lastHostEntry.href !== 'string')) {
            current.lastHostEntry = null;
        } else if (current.lastHostEntry
            && typeof current.lastHostEntry.navigationKey !== 'string') {
            current.lastHostEntry.navigationKey = null;
        }
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
            if (typeof pending.hostNavigationKey !== 'string') {
                pending.hostNavigationKey = null;
            }
            if (pending.nextDirectionAfterBack !== 'forward') {
                pending.nextDirectionAfterBack = null;
            }
            if (typeof pending.releaseReplaceStateWatch !== 'function') {
                pending.releaseReplaceStateWatch = null;
            }
        }
        const ownedTraversal = current.pendingOwnedTraversal;
        if (ownedTraversal !== null
            && (!ownedTraversal
                || typeof ownedTraversal.token !== 'string'
                || typeof ownedTraversal.markerHref !== 'string'
                || ![
                    'queued',
                    'issued',
                    'superseded-queued',
                    'superseded-issued',
                    'superseded-reactive-push',
                    'recovering-forward',
                ].includes(ownedTraversal.phase))) {
            current.pendingOwnedTraversal = null;
        } else if (ownedTraversal) {
            if (typeof ownedTraversal.hostHref !== 'string') ownedTraversal.hostHref = '';
            if (ownedTraversal.hostStateFingerprint !== null
                && typeof ownedTraversal.hostStateFingerprint !== 'string') {
                ownedTraversal.hostStateFingerprint = historyStateFingerprint(ownedTraversal.hostState);
            }
            if (typeof ownedTraversal.markerNavigationKey !== 'string') {
                ownedTraversal.markerNavigationKey = null;
            }
            if (typeof ownedTraversal.hostNavigationKey !== 'string') {
                ownedTraversal.hostNavigationKey = null;
            }
            if (!Number.isSafeInteger(ownedTraversal.classicEntriesAboveBase)
                || ownedTraversal.classicEntriesAboveBase < 1) {
                ownedTraversal.classicEntriesAboveBase = 1;
            }
            if (typeof ownedTraversal.classicRetryQueued !== 'boolean') {
                ownedTraversal.classicRetryQueued = false;
            }
            if (typeof ownedTraversal.lastHostEntryKey !== 'string') {
                ownedTraversal.lastHostEntryKey = null;
            }
            if (typeof ownedTraversal.recoveringMarkerCrossed !== 'boolean') {
                // An older hot chunk cannot prove which side of the marker its
                // in-flight Forward reached. Fail closed against rewriting the
                // durable base identity to an intermediate/newer entry.
                ownedTraversal.recoveringMarkerCrossed = ownedTraversal.phase === 'recovering-forward';
            }
            if (!readModalHistoryMarker({ [HISTORY_STATE_KEY]: ownedTraversal.markerSnapshot })) {
                ownedTraversal.markerSnapshot = null;
            }
        }
        if (!readModalHistoryMarker({ [HISTORY_STATE_KEY]: current.markerPopPushWinner })) {
            current.markerPopPushWinner = null;
        }
        if (!Number.isSafeInteger(current.internalHistoryWriteDepth)
            || current.internalHistoryWriteDepth < 0) {
            current.internalHistoryWriteDepth = 0;
        }
        if (typeof current.historyObserver !== 'function') current.historyObserver = null;
        if (typeof current.routeObserver !== 'function') current.routeObserver = null;
        if (typeof current.releaseNavigationObservers !== 'function') {
            current.releaseNavigationObservers = null;
        }
        for (const record of current.records.values()) {
            if (typeof record.hostHref === 'string'
                && (record.hostNavigationKey === null
                    || typeof record.hostNavigationKey === 'string')
                && (record.hostStateFingerprint === null
                    || typeof record.hostStateFingerprint === 'string')
                && typeof record.buriedByHost === 'boolean'
                && typeof record.hostMutationObserved === 'boolean'
                && typeof record.pendingOwnedBack === 'boolean') continue;

            // Adopt live records published by a pre-invariant v2 chunk. When
            // its marker is still in the current private chain, the marker
            // itself carries the exact base needed by the new owner.
            const marker = findMarkerInPrivateChain(history.state, record.token);
            if (marker) {
                record.hostState = marker.hostState;
                record.hostStateFingerprint = historyStateFingerprint(marker.hostState);
                record.hostHref = location.href;
                record.hostNavigationKey = marker.hostNavigationKey ?? null;
                record.buriedByHost = false;
                record.hostMutationObserved = false;
                record.pendingOwnedBack = false;
            } else {
                // No supported API can recover an old buried entry's base.
                // Keep its UI closable at the marker and conservatively retain
                // two-way traversal rather than guessing from history.length.
                record.hostState = undefined;
                record.hostStateFingerprint = null;
                record.hostHref = '';
                record.hostNavigationKey = null;
                record.buriedByHost = true;
                record.hostMutationObserved = false;
                record.pendingOwnedBack = false;
                preserveHistoryTokenDirection(current, record.token, 'back');
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
        pendingOwnedTraversal: null,
        markerPopPushWinner: null,
        retiredBases: new Map(),
        lastHostEntry: readModalHistoryMarker(history.state) ? null : {
            state: history.state,
            href: location.href,
            navigationKey: currentNavigationEntryKey(),
        },
        adoptionToken: null,
        configListener: null,
        historyObserver: null,
        routeObserver: null,
        releaseNavigationObservers: null,
        internalHistoryWriteDepth: 0,
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

function preserveHistoryTokenDirection(
    owner: ModalHistoryOwnerState,
    token: string,
    direction: ModalHistoryMarker['nextDirection']
): void {
    rememberHistoryToken(owner, token);
    if (!owner.pendingBidirectional.has(token)) {
        owner.pendingBidirectional.set(token, direction);
        persistHistoryLedger(owner);
    }
}

function setHistoryTokenDirection(
    owner: ModalHistoryOwnerState,
    token: string,
    direction: ModalHistoryMarker['nextDirection']
): void {
    rememberHistoryToken(owner, token);
    owner.pendingBidirectional.set(token, direction);
    persistHistoryLedger(owner);
}

function modalHistoryRecordBaseMatches(
    record: ModalHistoryRecord,
    state: unknown,
    _href: string
): boolean {
    // event.state is the immutable traversal payload. An earlier popstate
    // router may synchronously canonicalize location with replaceState before
    // this capture listener runs, so current location.href is not authoritative
    // for identifying the entry that actually produced the event.
    const currentKey = currentNavigationEntryKey();
    if (record.hostNavigationKey !== null && currentKey !== null) {
        return currentKey === record.hostNavigationKey;
    }
    if (Object.is(state, record.hostState)) return true;
    const fingerprint = historyStateFingerprint(state);
    return record.hostStateFingerprint !== null
        && fingerprint === record.hostStateFingerprint;
}

function historyStateMatches(
    expectedState: unknown,
    expectedFingerprint: string | null,
    state: unknown
): boolean {
    if (Object.is(state, expectedState)) return true;
    const fingerprint = historyStateFingerprint(state);
    return expectedFingerprint !== null && fingerprint === expectedFingerprint;
}

function privateMarkerChainContainsToken(
    state: unknown,
    href: string,
    token: string,
    markerHref: string
): boolean {
    if (href !== markerHref) return false;
    const visited = new Set<string>();
    let marker = readModalHistoryMarker(state);
    while (marker && !visited.has(marker.token)) {
        if (marker.token === token) return true;
        visited.add(marker.token);
        marker = readModalHistoryMarker(marker.hostState);
    }
    return false;
}

function privateMarkerChainContains(
    state: unknown,
    href: string,
    record: ModalHistoryRecord
): boolean {
    return privateMarkerChainContainsToken(state, href, record.token, record.hostHref);
}

function rememberRetiredBase(
    owner: ModalHistoryOwnerState,
    token: string,
    hostState: unknown,
    hostNavigationKey: string | null
): void {
    owner.retiredBases.delete(token);
    owner.retiredBases.set(token, {
        token,
        hostState,
        hostStateFingerprint: historyStateFingerprint(hostState),
        hostNavigationKey,
    });
    while (owner.retiredBases.size > MAX_RETIRED_HISTORY_TOKENS) {
        const oldest = owner.retiredBases.keys().next().value;
        if (!oldest) break;
        owner.retiredBases.delete(oldest);
    }
}

function markRetiredBasesReached(
    owner: ModalHistoryOwnerState,
    state: unknown
): void {
    for (const base of owner.retiredBases.values()) {
        const currentKey = currentNavigationEntryKey();
        const matches = base.hostNavigationKey !== null && currentKey !== null
            ? base.hostNavigationKey === currentKey
            : historyStateMatches(base.hostState, base.hostStateFingerprint, state);
        if (matches) {
            setHistoryTokenDirection(owner, base.token, 'forward');
        }
    }
}

function markRecordBuriedByHost(
    owner: ModalHistoryOwnerState,
    record: ModalHistoryRecord
): void {
    record.buriedByHost = true;
    record.pendingOwnedBack = false;
    rememberRetiredBase(owner, record.token, record.hostState, record.hostNavigationKey);
    preserveHistoryTokenDirection(owner, record.token, 'back');
    // A live nested record can be the only remaining closure that proves a
    // retired outer marker sits below it. Burying the live record buries that
    // complete private ancestor chain as well.
    const visited = new Set<string>();
    let ancestor = readModalHistoryMarker(record.hostState);
    while (ancestor && !visited.has(ancestor.token)) {
        visited.add(ancestor.token);
        rememberRetiredBase(
            owner,
            ancestor.token,
            ancestor.hostState,
            ancestor.hostNavigationKey ?? null
        );
        preserveHistoryTokenDirection(owner, ancestor.token, 'back');
        ancestor = readModalHistoryMarker(ancestor.hostState);
    }
}

function withInternalHistoryWrite<T>(owner: ModalHistoryOwnerState, write: () => T): T {
    owner.internalHistoryWriteDepth += 1;
    try {
        return write();
    } finally {
        owner.internalHistoryWriteDepth -= 1;
    }
}

function currentNavigationEntryKey(): string | null {
    const navigation = (window as Window & {
        navigation?: { currentEntry?: { key?: unknown } | null };
    }).navigation;
    const key = navigation?.currentEntry?.key;
    return typeof key === 'string' && key.length > 0 ? key : null;
}

function rememberHostEntry(
    owner: ModalHistoryOwnerState,
    state: unknown,
    href: string
): void {
    if (readModalHistoryMarker(state)) return;
    owner.lastHostEntry = {
        state,
        href,
        navigationKey: currentNavigationEntryKey(),
    };
}

function restoreLastHostEntry(owner: ModalHistoryOwnerState): boolean {
    const snapshot = owner.lastHostEntry;
    if (!snapshot) return false;
    const currentKey = currentNavigationEntryKey();
    if (snapshot.navigationKey !== null
        && currentKey !== null
        && snapshot.navigationKey !== currentKey) return false;

    try {
        withInternalHistoryWrite(owner, () => {
            History.prototype.replaceState.call(
                history,
                snapshot.state,
                '',
                snapshot.href
            );
        });
        return true;
    } catch (error) {
        console.warn(`${logPrefix} could not restore a host entry overwritten by a copied marker:`, error);
        return false;
    }
}

function clearPendingOwnedTraversal(
    owner: ModalHistoryOwnerState,
    expected: PendingOwnedTraversal | null = owner.pendingOwnedTraversal
): PendingOwnedTraversal | null {
    if (!expected || owner.pendingOwnedTraversal !== expected) return null;
    owner.pendingOwnedTraversal = null;
    return expected;
}

function effectiveHistoryAction(mutation: HistoryMutation): 'PUSH' | 'REPLACE' | 'POP' | null {
    if (mutation.action) return mutation.action;
    if (mutation.source === 'pushState') return 'PUSH';
    if (mutation.source === 'replaceState') return 'REPLACE';
    return null;
}

/** Remove only our private field when a host write copied the current marker. */
function stripCurrentCopiedMarker(owner: ModalHistoryOwnerState, token: string): boolean {
    const currentState: unknown = history.state;
    if (readModalHistoryMarker(currentState)?.token !== token
        || currentState === null
        || typeof currentState !== 'object') return false;

    const replacement: Record<string, unknown> = {
        ...(currentState as Record<string, unknown>),
    };
    Reflect.deleteProperty(replacement, HISTORY_STATE_KEY);
    try {
        withInternalHistoryWrite(owner, () => {
            history.replaceState(replacement, '', location.href);
        });
        return true;
    } catch (error) {
        console.warn(`${logPrefix} could not remove a copied modal history marker:`, error);
        return false;
    }
}

/**
 * Record host history ownership while each modal closure is still live. This
 * prospective bit removes the ambiguity after a later traversal: an untagged
 * entry may be this modal's base or a newer route that merely sits above it.
 */
function observePotentialHostBurial(
    owner: ModalHistoryOwnerState,
    state: unknown,
    href: string,
    definiteHistoryMutation: boolean
): void {
    const currentMarker = readModalHistoryMarker(state);
    for (const record of Array.from(owner.records.values())) {
        if (privateMarkerChainContains(state, href, record)) continue;
        // A private marker can itself be another live record's exact nested
        // base. Retagging or publishing that private chain is not a host burial.
        if (currentMarker && modalHistoryRecordBaseMatches(record, state, href)) continue;
        if (!definiteHistoryMutation && modalHistoryRecordBaseMatches(record, state, href)) continue;
        markRecordBuriedByHost(owner, record);
    }
}

function handleModalHistoryMutation(mutation: HistoryMutation): void {
    const owner = getHistoryOwner();
    if (owner.internalHistoryWriteDepth > 0) return;
    const action = effectiveHistoryAction(mutation);
    if (action === 'POP') return;

    const activeEvent = (window as Window & { event?: Event }).event;
    const insidePopState = activeEvent instanceof PopStateEvent;
    const pending = owner.pendingOwnedTraversal;
    if (action === 'PUSH' && insidePopState && pending === null) {
        const activeMarker = readModalHistoryMarker(activeEvent.state);
        if (activeMarker) owner.markerPopPushWinner = activeMarker;
    }

    const currentEntryKey = currentNavigationEntryKey();
    if (action === 'REPLACE' && pending?.markerSnapshot) {
        const stillOnIssuedMarker = pending.markerNavigationKey !== null
            && currentEntryKey !== null
            ? pending.markerNavigationKey === currentEntryKey
            : !insidePopState;
        if (stillOnIssuedMarker) {
            // An earlier router scheduled work from the private pop, but the
            // browser has not applied our Back/Forward yet. Keep that entry
            // private until the next pop; otherwise the replacement becomes a
            // visible ghost stop on the user's later reverse traversal.
            replaceCurrentModalMarker(owner, pending.markerSnapshot, pending.markerHref);
            return;
        }
    }
    if (action === 'REPLACE'
        && pending?.phase === 'issued'
        && insidePopState) {
        // The Back just reached its selected entry and an earlier SPA router is
        // canonicalizing that same pop. It did not supersede the traversal.
        // PopStateEvent.state remains the immutable entry payload and the owner
        // listener below will consume/repair it as needed.
        return;
    }
    const traversalReactiveRewrite = action === 'REPLACE'
        && pending !== null
        && ((pending.hostNavigationKey !== null
            && currentEntryKey !== null
            && currentEntryKey !== pending.hostNavigationKey)
            // Once recovery has left the stale base, a REPLACE can only rewrite
            // the entry currently being crossed. It cannot create a newer
            // destination than the PUSH target already saved in the transaction.
            // Classic Firefox has no Navigation entry key, and routers commonly
            // defer this canonicalization through a task, MessageChannel, or rAF,
            // after window.event is no longer the originating PopStateEvent.
            || pending.phase === 'recovering-forward'
            || (pending.phase === 'superseded-issued' && insidePopState));
    const copiedMarker = readModalHistoryMarker(mutation.state);
    const copiedRecord = copiedMarker
        ? owner.records.get(copiedMarker.token) ?? null
        : null;
    if (copiedRecord) copiedRecord.hostMutationObserved = true;

    const copiedPendingToken = copiedMarker !== null
        && pending !== null
        && copiedMarker.token === pending.token;
    const copiedLiveToken = copiedRecord !== null;
    const copiedRetiredToken = copiedMarker !== null
        && !copiedLiveToken
        && owner.retiredBases.has(copiedMarker.token);
    if (action === 'REPLACE'
        && copiedRetiredToken
        && !insidePopState
        && (!pending || pending.markerSnapshot === null)
        && restoreLastHostEntry(owner)) {
        // A router retained immutable marker event.state beyond the traversal
        // that produced it, then replaced the already-reached host entry. The
        // retained token and exact last-host snapshot prove this write is stale;
        // restore that entry without publishing a synthetic navigation event.
        return;
    }
    const markerWasStripped = (copiedPendingToken || copiedLiveToken || copiedRetiredToken)
        ? stripCurrentCopiedMarker(owner, copiedMarker!.token)
        : false;
    const effectiveState: unknown = markerWasStripped ? history.state : mutation.state;
    const effectiveHref = markerWasStripped ? location.href : mutation.href;

    rememberHostEntry(owner, effectiveState, effectiveHref);

    observePotentialHostBurial(owner, effectiveState, effectiveHref, true);

    if (action === 'PUSH'
        && pending?.phase === 'issued'
        && !insidePopState
        && pending.markerSnapshot?.traversal === 'bidirectional'
        && pending.markerSnapshot.nextDirection === 'back') {
        // Forward was issued from a retired marker, then an asynchronous router
        // PUSH replaced the marker's complete Forward chain with this new entry.
        // No owned pop can now arrive: the old target was truncated and the PUSH
        // winner is already current. Settle immediately and leave the retained
        // marker pointing Back from the new host route.
        clearPendingOwnedTraversal(owner, pending);
        setHistoryTokenDirection(owner, pending.token, 'back');
        return;
    }

    if (action === 'REPLACE'
        && pending?.phase === 'recovering-forward'
        && !pending.recoveringMarkerCrossed) {
        // This rewrite happened while recovery was still on the older side of
        // the private marker. Preserve its canonicalized identity separately
        // from the saved newer PUSH target, so a later history-menu/go(-N)
        // arrival can arm the marker Forward instead of bouncing back here.
        rememberRetiredBase(owner, pending.token, effectiveState, currentEntryKey);
    }

    if (pending
        && owner.pendingOwnedTraversal === pending
        && (pending.phase === 'queued'
            || pending.phase === 'issued'
            || pending.phase === 'superseded-queued'
            || pending.phase === 'superseded-issued'
            || pending.phase === 'superseded-reactive-push'
            || pending.phase === 'recovering-forward')) {
        const wasRecovering = pending.phase === 'recovering-forward';
        const wasReactivePush = pending.phase === 'superseded-reactive-push';
        const wasIssued = pending.phase === 'issued' || pending.phase === 'superseded-issued';
        const previousTargetMatches = pending.hostHref === effectiveHref
            && historyStateMatches(
                pending.hostState,
                pending.hostStateFingerprint,
                effectiveState
            );
        const reactivePush = action === 'PUSH'
            && (wasRecovering || wasReactivePush || insidePopState);
        pending.phase = reactivePush
            ? 'superseded-reactive-push'
            : wasRecovering
            ? 'recovering-forward'
            : wasIssued ? 'superseded-issued' : 'superseded-queued';
        if (!traversalReactiveRewrite) {
            pending.hostState = effectiveState;
            pending.hostStateFingerprint = historyStateFingerprint(effectiveState);
            pending.hostHref = effectiveHref;
            pending.hostNavigationKey = currentEntryKey;
        }

        if (wasIssued) {
            // A host write after Back dispatch cannot cancel Chromium's queued
            // traversal and can cancel Firefox's. Retire interaction now in
            // both engines; the global transaction repairs only if a stale
            // base pop subsequently arrives.
            const record = owner.records.get(pending.token);
            if (record) record.destroy();
            if (mutation.source === 'replaceState' && copiedPendingToken) {
                forgetHistoryToken(owner, pending.token);
            } else {
                preserveHistoryTokenDirection(owner, pending.token, 'back');
            }
            const entryKey = pending.hostNavigationKey ?? mutation.entryKey ?? null;
            // The patched History method and Jellyfin's raw HISTORY_UPDATE bus
            // can report the same PUSH. The direct method call is always a new
            // entry; the later raw report merely supplies its router key.
            const duplicateRawPush = mutation.source === 'HISTORY_UPDATE'
                && previousTargetMatches
                && (entryKey === null
                    || pending.lastHostEntryKey === null
                    || entryKey === pending.lastHostEntryKey);
            const isNewPushEntry = action === 'PUSH'
                && !duplicateRawPush
                && (mutation.source !== 'HISTORY_UPDATE'
                    || entryKey === null
                    || entryKey !== pending.lastHostEntryKey);
            if (action === 'PUSH' && entryKey !== null) {
                pending.lastHostEntryKey = entryKey;
            }
            if (isNewPushEntry
                && !reactivePush
                && pending.hostNavigationKey === null) {
                pending.classicEntriesAboveBase += 1;
                if (!pending.classicRetryQueued) {
                    pending.classicRetryQueued = true;
                    setTimeout(() => {
                        pending.classicRetryQueued = false;
                        if (owner.pendingOwnedTraversal !== pending
                            || pending.phase !== 'superseded-issued'
                            || pending.hostNavigationKey !== null) return;
                        try {
                            // A late push can cancel Firefox's already-issued
                            // Back. Retry only if that Back did not produce a
                            // pop first; issuing both traversals synchronously
                            // can leave a queued Forward at Chromium's capped
                            // history boundary and undo the user's next Back.
                            history.go(-pending.classicEntriesAboveBase);
                        } catch (error) {
                            console.warn(`${logPrefix} could not settle a pushed route over modal Back:`, error);
                        }
                    }, 0);
                }
            }
        }
    }

    if (copiedMarker && mutation.source === 'replaceState' && !copiedRetiredToken) {
        // replaceState destroyed the one entry that carried this exact token;
        // unlike a copied push, there is no private sentinel left to traverse.
        forgetHistoryToken(owner, copiedMarker.token);
    }
}

function handleModalRouteNavigation(): void {
    const owner = getHistoryOwner();
    rememberHostEntry(owner, history.state, location.href);
    observePotentialHostBurial(
        owner,
        history.state,
        location.href,
        false
    );
}

function ensureNavigationObservers(owner: ModalHistoryOwnerState): void {
    if (owner.historyObserver === handleModalHistoryMutation
        && owner.routeObserver === handleModalRouteNavigation) return;

    owner.releaseNavigationObservers?.();
    const releases: Array<() => void> = [];
    const navigation = JC.core.navigation;
    if (navigation?.onHistoryMutation) {
        releases.push(navigation.onHistoryMutation(handleModalHistoryMutation));
    }
    if (navigation?.onNavigate) {
        releases.push(navigation.onNavigate(handleModalRouteNavigation));
    }
    owner.historyObserver = handleModalHistoryMutation;
    owner.routeObserver = handleModalRouteNavigation;
    const releaseNavigationObservers = () => {
        for (const release of releases.splice(0)) release();
        if (owner.historyObserver === handleModalHistoryMutation) owner.historyObserver = null;
        if (owner.routeObserver === handleModalRouteNavigation) owner.routeObserver = null;
        if (owner.releaseNavigationObservers === releaseNavigationObservers) {
            owner.releaseNavigationObservers = null;
        }
    };
    owner.releaseNavigationObservers = releaseNavigationObservers;
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
        hostNavigationKey: marker.hostNavigationKey ?? null,
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
    const currentKey = currentNavigationEntryKey();
    if (pending.hostNavigationKey !== null && currentKey !== null) {
        return pending.hostNavigationKey === currentKey;
    }
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

function replaceCurrentModalMarker(
    owner: ModalHistoryOwnerState,
    marker: ModalHistoryMarker,
    href = location.href
): boolean {
    try {
        withInternalHistoryWrite(owner, () => {
            History.prototype.replaceState.call(
                history,
                taggedHistoryState(
                    marker.token,
                    marker.hostState,
                    marker.traversal,
                    marker.nextDirection,
                    marker.hostNavigationKey ?? null
                ),
                '',
                href
            );
        });
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

function armRetiredMarkerTraversal(
    owner: ModalHistoryOwnerState,
    marker: ModalHistoryMarker,
    direction: ModalHistoryMarker['nextDirection']
): { pending: PendingOwnedTraversal; created: boolean } {
    const existing = owner.pendingOwnedTraversal;
    if (existing) {
        existing.markerSnapshot = marker;
        return { pending: existing, created: false };
    }

    const retiredBase = direction === 'back'
        ? owner.retiredBases.get(marker.token) ?? null
        : null;
    const hostState = retiredBase?.hostState ?? marker.hostState;
    const pending: PendingOwnedTraversal = {
        token: marker.token,
        markerHref: location.href,
        phase: 'issued',
        hostState,
        hostStateFingerprint: historyStateFingerprint(hostState),
        hostHref: location.href,
        markerNavigationKey: currentNavigationEntryKey(),
        hostNavigationKey: direction === 'back'
            ? retiredBase?.hostNavigationKey ?? marker.hostNavigationKey ?? null
            : null,
        classicEntriesAboveBase: 1,
        classicRetryQueued: false,
        lastHostEntryKey: null,
        recoveringMarkerCrossed: false,
        markerSnapshot: marker,
    };
    owner.pendingOwnedTraversal = pending;
    return { pending, created: true };
}

function traverseRetiredMarker(
    owner: ModalHistoryOwnerState,
    marker: ModalHistoryMarker,
    forceBidirectional = false
): void {
    const pendingDirection = owner.pendingBidirectional.get(marker.token);
    if (marker.traversal !== 'bidirectional' && !pendingDirection && !forceBidirectional) {
        const armed = armRetiredMarkerTraversal(owner, marker, 'back');
        try {
            history.back();
        } catch (error) {
            if (armed.created) clearPendingOwnedTraversal(owner, armed.pending);
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
    const nextMarker: ModalHistoryMarker = {
        ...marker,
        traversal: 'bidirectional',
        nextDirection,
    };
    const retagged = replaceCurrentModalMarker(owner, nextMarker);
    if (!retagged) {
        // The marker remains terminal (or retains its old direction). Keep the
        // opposite traversal durably so the next encounter still reaches the
        // real route on the other side instead of bouncing forever.
        rememberHistoryToken(owner, marker.token);
        owner.pendingBidirectional.set(marker.token, nextDirection);
        persistHistoryLedger(owner);
    }
    const armed = armRetiredMarkerTraversal(owner, nextMarker, direction);
    try {
        if (direction === 'forward') history.forward();
        else history.back();
    } catch (error) {
        if (armed.created) clearPendingOwnedTraversal(owner, armed.pending);
        // Retagging records the direction expected *after* a successful move.
        // A rejected move must retry its original direction instead.
        rememberHistoryToken(owner, marker.token);
        owner.pendingBidirectional.set(marker.token, direction);
        persistHistoryLedger(owner);
        throw error;
    }
    if (retagged) forgetHistoryToken(owner, marker.token);
}

function pendingOwnedTraversalTargetMatches(
    pending: PendingOwnedTraversal,
    state: unknown,
    href: string
): boolean {
    const currentKey = currentNavigationEntryKey();
    if (pending.hostNavigationKey !== null && currentKey !== null) {
        return currentKey === pending.hostNavigationKey;
    }
    // PopStateEvent.state is immutable even when an earlier router rewrites
    // the recovered route's URL before our capture listener runs.
    if (historyStateMatches(
        pending.hostState,
        pending.hostStateFingerprint,
        state
    )) return true;
    // Chromium can also collapse a Blob-bearing *target* entry to null. This
    // fallback is scoped to the exact host href while recovery is active; an
    // arbitrary null entry elsewhere is still traversed normally.
    return state === null && href === pending.hostHref;
}

function handlePendingOwnedTraversalPop(
    owner: ModalHistoryOwnerState,
    event: PopStateEvent,
    marker: ModalHistoryMarker | null
): boolean {
    const pending = owner.pendingOwnedTraversal;
    if (!pending) return false;

    if (pending.phase === 'queued' || pending.phase === 'superseded-queued') {
        // A traversal not yet dispatched cannot own a browser event.
        clearPendingOwnedTraversal(owner, pending);
        return false;
    }
    if (pending.phase === 'issued') {
        // This is the one pop owned by close(). The live record's exact flag
        // supplies a safe fallback when Chromium loses Blob event.state.
        clearPendingOwnedTraversal(owner, pending);
        return false;
    }

    if (pending.phase === 'superseded-reactive-push') {
        // A router PUSH performed while an older pop was being delivered has
        // already won and truncated the stale Forward chain. Never expose that
        // older event.state to later routers, and never try to traverse beyond
        // the newly current route (which could leave this document).
        event.stopImmediatePropagation();
        clearPendingOwnedTraversal(owner, pending);
        if (marker?.token === pending.token) {
            // The PUSH was made while the retained marker was current, so it is
            // still directly behind the new host entry and remains two-way.
            setHistoryTokenDirection(owner, pending.token, 'back');
        } else {
            forgetHistoryToken(owner, pending.token);
        }
        return true;
    }

    if (pending.phase === 'superseded-issued') {
        // The owned Back, or the exact PUSH-only go(-N) coalescing handshake,
        // has reached the modal's original base. That base may itself be a
        // lower live marker. Keep it live/private and recover Forward through
        // only the retired token to the latest host target.
        event.stopImmediatePropagation();
        pending.phase = 'recovering-forward';
        pending.recoveringMarkerCrossed = false;
        setHistoryTokenDirection(owner, pending.token, 'forward');
        try {
            history.forward();
        } catch (error) {
            clearPendingOwnedTraversal(owner, pending);
            console.warn(`${logPrefix} could not restore a route that superseded modal Back:`, error);
        }
        return true;
    }

    if (marker) {
        if (pending.phase === 'recovering-forward' && marker.token === pending.token) {
            // Cross recovery locally without closing an older live outer modal.
            event.stopImmediatePropagation();
            pending.recoveringMarkerCrossed = true;
            try {
                traverseRetiredMarker(owner, marker);
            } catch (error) {
                clearPendingOwnedTraversal(owner, pending);
                console.warn(`${logPrefix} could not cross a recovering modal marker:`, error);
            }
            return true;
        }

        // Firefox cancels a queued Back when a later push wins. Its eventual
        // real one-step user Back reaches the retained marker, not the old
        // base. Drop supersession so ordinary Back-first marker traversal wins.
        clearPendingOwnedTraversal(owner, pending);
        return false;
    }

    if (pendingOwnedTraversalTargetMatches(pending, event.state, location.href)) {
        clearPendingOwnedTraversal(owner, pending);
        forgetHistoryToken(owner, pending.token);
        return false;
    }

    if (pending.phase === 'recovering-forward') {
        // Multiple host pushes can sit beyond the retained marker. Continue
        // across intermediate real entries until the latest observed target.
        event.stopImmediatePropagation();
        try {
            history.forward();
        } catch (error) {
            clearPendingOwnedTraversal(owner, pending);
            console.warn(`${logPrefix} could not finish restoring a superseding route:`, error);
        }
        return true;
    }

    clearPendingOwnedTraversal(owner, pending);
    return false;
}

function handleMarkerPopPushWinner(
    owner: ModalHistoryOwnerState,
    event: PopStateEvent,
    marker: ModalHistoryMarker | null
): boolean {
    const winner = owner.markerPopPushWinner;
    owner.markerPopPushWinner = null;
    if (!winner || !marker || winner.token !== marker.token) return false;

    // A router registered before the owner synchronously PUSHed a genuine host
    // route while this immutable private pop was being delivered. The new route
    // owns the current entry and truncates the old newer branch; never replace it
    // with the stale marker snapshot or apply the marker's queued traversal.
    event.stopImmediatePropagation();
    clearPendingOwnedTraversal(owner);
    const records = Array.from(owner.records.values());
    for (let index = records.length - 1; index >= 0; index -= 1) {
        const record = records[index];
        const reachedOrAbove = record.token === marker.token
            || findMarkerInPrivateChain(record.hostState, marker.token) !== null;
        if (!reachedOrAbove) continue;
        record.closeFromHistory();
        setHistoryTokenDirection(owner, record.token, 'back');
    }
    setHistoryTokenDirection(owner, marker.token, 'back');
    return true;
}

function handleModalHistoryPop(event: PopStateEvent): void {
    const owner = getHistoryOwner();
    owner.adoptionToken = null;
    if (owner.pendingOwnedTraversal) {
        // The issued Back/Forward has now left the marker that its snapshot was
        // guarding. A later recovery marker pop will arm a fresh snapshot.
        owner.pendingOwnedTraversal.markerSnapshot = null;
    }
    const marker = readModalHistoryMarker(event.state);
    if (!marker) rememberHostEntry(owner, history.state, location.href);
    if (handleMarkerPopPushWinner(owner, event, marker)) return;
    if (handlePendingOwnedTraversalPop(owner, event, marker)) return;
    if (handlePendingBaseExitPop(owner, event, marker)) return;
    if (!marker) {
        // Host/base entries are never wrapped. Their exact event.state is
        // delivered unchanged to routers registered before and after us.
        markRetiredBasesReached(owner, event.state);
        const records = Array.from(owner.records.values());
        let crossedBaseIndex = -1;
        // Only a record whose exact base became current was crossed. A newer
        // host base (A→M1→B→M2→B) settles M2 but must leave M1 live at B.
        for (let index = records.length - 1; index >= 0; index -= 1) {
            if (records[index].pendingOwnedBack
                || modalHistoryRecordBaseMatches(records[index], event.state, location.href)) {
                crossedBaseIndex = index;
                break;
            }
        }
        if (crossedBaseIndex < 0) return;

        for (let index = records.length - 1; index >= crossedBaseIndex; index -= 1) {
            const record = records[index];
            record.closeFromHistory();
            if (record.buriedByHost) {
                // A direct multi-entry traversal crossed this private marker
                // from its newer host side. Its next encounter must continue
                // Forward; the real host entry on that side remains reachable.
                setHistoryTokenDirection(owner, record.token, 'forward');
            } else {
                forgetHistoryToken(owner, record.token);
            }
        }
        return;
    }

    // An owned modal marker is a private same-document sentinel, never a host
    // destination. Repair any replaceState performed by an earlier router and
    // keep later routers from rendering the transient entry.
    const currentMarker = readModalHistoryMarker(history.state);
    if (currentMarker?.token !== marker.token) replaceCurrentModalMarker(owner, marker);
    event.stopImmediatePropagation();

    // A multi-entry traversal can bypass more than one live nested modal.
    // Close every modal above the marker that the browser actually reached.
    let top = topHistoryRecord(owner);
    const closedAbove: ModalHistoryRecord[] = [];
    while (top && top.token !== marker.token) {
        const record = top;
        top.closeFromHistory();
        closedAbove.push(record);
        top = topHistoryRecord(owner);
    }

    const reached = owner.records.get(marker.token);
    if (reached && closedAbove.length > 0) {
        // Reaching a still-live lower marker proves every buried live record
        // above it was crossed by this traversal, even when history.go skipped
        // their individual popstate events.
        for (const record of closedAbove) {
            if (record.buriedByHost) {
                setHistoryTokenDirection(owner, record.token, 'forward');
            }
        }
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
    ensureNavigationObservers(owner);
    return owner;
}

function adoptCurrentHistoryMarker(owner: ModalHistoryOwnerState): void {
    const marker = readModalHistoryMarker(history.state);
    if (!marker
        || owner.pendingOwnedTraversal
        || owner.records.has(marker.token)
        || owner.adoptionToken === marker.token) return;
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
    const titleId = nextModalTitleId();
    contentEl.className = 'seerr-season-content';
    contentEl.setAttribute('role', 'document');
    contentEl.setAttribute('aria-labelledby', titleId);

    const headerEl = document.createElement('div');
    headerEl.className = 'seerr-season-header';
    headerEl.style.cssText = `background-image: ${backdropImage}; background-size: cover; background-position: center;`;

    const titleEl = document.createElement('div');
    titleEl.id = titleId;
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
    let pendingCloseTransaction: (PendingOwnedTraversal & {
        marker: ModalHistoryMarker;
        immediate: boolean;
    }) | null = null;
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
        const hostHref = location.href;
        const hostNavigationKey = currentNavigationEntryKey();
        historyToken = token;
        try {
            withInternalHistoryWrite(owner, () => {
                history.pushState(
                    taggedHistoryState(token, hostState, 'terminal', 'back', hostNavigationKey),
                    '',
                    location.href
                );
            });
        } catch (error) {
            // The base was never mutated, so cleanup is sufficient even when
            // the browser rejects the private sentinel.
            closeInternal(true, false);
            throw error;
        }
        rememberHistoryToken(owner, token);
        owner.records.set(token, {
            token,
            hostState,
            hostStateFingerprint: historyStateFingerprint(hostState),
            hostHref,
            hostNavigationKey,
            buriedByHost: false,
            hostMutationObserved: false,
            pendingOwnedBack: false,
            closeFromHistory: () => {
                const restoreFocus = topHistoryRecord(owner)?.token === token;
                closeInternal(false, restoreFocus);
            },
            destroy: () => requestClose(true),
        });
        try {
            a11y = installModalA11y(modalElement, {
                labelledBy: titleId,
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

        a11y?.release(restoreFocus);
        a11y = null;
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
    const settlePendingCloseTransaction = (
        transaction: NonNullable<typeof pendingCloseTransaction>
    ): void => {
        if (pendingCloseTransaction !== transaction) return;
        pendingCloseTransaction = null;
        const owner = getHistoryOwner();
        const token = historyToken;
        const record = token === null ? null : owner.records.get(token) ?? null;
        const current = readModalHistoryMarker(history.state);
        const stillOwnsCurrentEntry = owner.pendingOwnedTraversal === transaction
            && transaction.phase === 'queued'
            && token !== null
            && current?.token === token
            && current.token === transaction.marker.token
            && location.href === transaction.markerHref
            && !record?.hostMutationObserved;

        if (!stillOwnsCurrentEntry) {
            // A host write won the same task after close() but before traversal
            // dispatch. Never issue a stale Back over that real entry. Firefox
            // may otherwise cancel the traversal and retain inert modal gates;
            // Chromium may apply it from the new entry and skip the host route.
            historyBackRequested = false;
            if (token !== null
                && !privateMarkerChainContainsToken(
                    history.state,
                    location.href,
                    token,
                    transaction.markerHref
                )) {
                if (record) markRecordBuriedByHost(owner, record);
                else preserveHistoryTokenDirection(owner, token, 'back');
            }
            if (owner.pendingOwnedTraversal === transaction) {
                clearPendingOwnedTraversal(owner, transaction);
            }
            if (!isClosing) closeInternal(transaction.immediate, false);
            return;
        }

        transaction.phase = 'issued';
        if (record) record.pendingOwnedBack = true;
        try {
            history.back();
        } catch (error) {
            // replaceState cannot remove the private entry: rewriting it to
            // look like the host would merely turn the next Back into an
            // invisible same-URL stop. A user close keeps the live modal
            // interactive; synchronous teardown leaves a document-global
            // tombstone that applies the next real Back after the hidden base.
            historyBackRequested = false;
            if (record) record.pendingOwnedBack = false;
            if (owner.pendingOwnedTraversal === transaction) {
                clearPendingOwnedTraversal(owner, transaction);
            }
            if (transaction.immediate && current) {
                const nextDirection = current.traversal === 'bidirectional'
                    || owner.pendingBidirectional.has(current.token)
                    ? 'forward'
                    : null;
                armPendingBaseExit(owner, current, nextDirection);
            }
            console.warn(`${logPrefix} could not consume a modal history entry:`, error);
            return;
        }

        if (transaction.immediate && token !== null) {
            // The live record was retired before the asynchronous base pop, so
            // that event cannot consume this terminal token for us.
            forgetHistoryToken(owner, token);
        }
    };

    const queueOwnedMarkerExit = (
        marker: ModalHistoryMarker,
        immediate: boolean
    ): void => {
        historyBackRequested = true;
        const transaction = {
            token: marker.token,
            marker,
            markerHref: location.href,
            phase: 'queued' as const,
            hostState: undefined,
            hostStateFingerprint: null,
            hostHref: '',
            markerNavigationKey: currentNavigationEntryKey(),
            hostNavigationKey: null,
            classicEntriesAboveBase: 1,
            classicRetryQueued: false,
            lastHostEntryKey: null,
            recoveringMarkerCrossed: false,
            markerSnapshot: null,
            immediate,
        };
        pendingCloseTransaction = transaction;
        const owner = getHistoryOwner();
        owner.pendingOwnedTraversal = transaction;
        if (immediate) closeInternal(true, false);
        setTimeout(() => settlePendingCloseTransaction(transaction), 0);
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
            if (immediate && pendingCloseTransaction) {
                // Upgrade the same-task ownership recheck without issuing Back
                // early. Controls still retire synchronously at reset boundaries.
                pendingCloseTransaction.immediate = true;
                closeInternal(true, false);
            } else if (immediate) {
                // The recheck already issued traversal; retire stale controls
                // while the pending pop remains owned by the global delegate.
                closeInternal(true, false);
                if (historyToken !== null) forgetHistoryToken(owner, historyToken);
            }
            return;
        }
        const marker = readModalHistoryMarker(history.state);
        if (historyToken !== null
            && marker?.token === historyToken) {
            queueOwnedMarkerExit(marker, immediate);
            return;
        }

        // An intervening host entry or another modal owns the current entry.
        // Never back over it. A real host entry means every known private
        // marker behind it may need two-way skipping; a nested modal marker
        // alone does not create a newer real destination.
        if (historyToken !== null && owner.records.has(historyToken)) {
            const record = owner.records.get(historyToken)!;
            if (!privateMarkerChainContains(history.state, location.href, record)) {
                markRecordBuriedByHost(owner, record);
            }
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
