// src/enhanced/config.ts
//
// Manages plugin configuration, user settings, and shared state.
// (Converted from js/enhanced/config.js — bodies semantically identical.)

import { JC } from '../globals';
import type { UserSettings } from '../types/jc';
import { adminDefaultsView } from '../core/config-resolve';
import { escapeHtml, toast } from '../core/ui-kit';

function normalizeIdentityPart(value: unknown): string {
    if (typeof value !== 'string' && typeof value !== 'number') return '';
    return String(value).trim().replace(/-/g, '').toLowerCase();
}

const UNKNOWN_SERVER_ID = normalizeIdentityPart('unknown-server');

function isResolvedServerId(value: unknown): boolean {
    const normalized = normalizeIdentityPart(value);
    return normalized !== '' && normalized !== UNKNOWN_SERVER_ID;
}

function liveApiClientServerId(): string {
    const client = ApiClient as JellyfinApiClient & {
        serverId?: string | (() => string);
        serverInfo?: { Id?: string; ServerId?: string } | (() => { Id?: string; ServerId?: string });
        _serverInfo?: { Id?: string; ServerId?: string };
        serverAddress?: string | (() => string);
    };
    try {
        const direct = typeof client.serverId === 'function'
            ? client.serverId.call(client)
            : client.serverId;
        if (isResolvedServerId(direct)) return String(direct);
    } catch { /* try server-info forms */ }
    try {
        const info = typeof client.serverInfo === 'function'
            ? client.serverInfo.call(client)
            : (client.serverInfo || client._serverInfo);
        const fromInfo = info?.Id || info?.ServerId || '';
        if (isResolvedServerId(fromInfo)) return fromInfo;
    } catch { /* fall through to address */ }
    try {
        const address = typeof client.serverAddress === 'function'
            ? client.serverAddress.call(client)
            : (client.serverAddress || client.getUrl('/'));
        if (isResolvedServerId(address)) return new URL(String(address), window.location.href).origin;
    } catch { /* unknown-server below */ }
    return '';
}

/**
 * Constants derived from the plugin configuration.
 */
JC.CONFIG = {
    // Use getters so values always reflect the latest pluginConfig even if assigned later
    get TOAST_DURATION(): number { return ((JC.pluginConfig && JC.pluginConfig.ToastDuration) as number) || 1500; },
    get HELP_PANEL_AUTOCLOSE_DELAY(): number { return ((JC.pluginConfig && JC.pluginConfig.HelpPanelAutocloseDelay) as number) || 15000; }
};

/**
 * Shared state variables used across different components.
 */
JC.state = JC.state || {
    activeShortcuts: {},
    // { itemId, surface: 'continuewatching'|'nextup'|null, ts } captured on a menu trigger.
    removeContext: null,
    pauseScreenClickTimer: null
};

type PersistenceErrorKind = 'validation' | 'authorization' | 'conflict' | 'unavailable' | 'cancelled' | 'protocol';

export interface UserSettingsSaveResult {
    acknowledged: true;
    deduplicated: boolean;
    file: string;
    revision: number;
    contentHash: string;
}

export class UserSettingsPersistenceError extends Error {
    readonly kind: PersistenceErrorKind;
    readonly status?: number;
    readonly retryable: boolean;
    readonly ambiguous: boolean;
    readonly authoritative?: Record<string, unknown>;

    constructor(message: string, options: {
        kind: PersistenceErrorKind;
        status?: number;
        retryable?: boolean;
        ambiguous?: boolean;
        authoritative?: Record<string, unknown>;
        cause?: unknown;
    }) {
        super(message, { cause: options.cause });
        this.name = 'UserSettingsPersistenceError';
        this.kind = options.kind;
        this.status = options.status;
        this.retryable = options.retryable === true;
        this.ambiguous = options.ambiguous === true;
        this.authoritative = options.authoritative;
    }
}

interface SaveAcknowledgement {
    success: boolean;
    conflict?: boolean;
    message?: string;
    file: string;
    revision: number;
    contentHash: string;
    data: Record<string, unknown>;
}

interface SaveWaiter {
    resolve: (result: UserSettingsSaveResult) => void;
    reject: (reason: unknown) => void;
}

interface SaveIntent {
    seq: number;
    cacheKey: string;
    fileName: string;
    owner: NonNullable<ReturnType<NonNullable<typeof JC.identity>['capture']>>;
    target: Record<string, unknown>;
    baseWire: Record<string, unknown> | null;
    desiredWire: Record<string, unknown>;
    serialized: string;
    waiters: SaveWaiter[];
}

interface SaveQueue {
    running: boolean;
    active: SaveIntent | null;
    pending: SaveIntent | null;
    latestSeq: number;
}

const SUPPORTED_USER_FILES = new Set(['settings.json', 'shortcuts.json', 'elsewhere.json']);
const _ackedWire = new Map<string, Record<string, unknown>>();
const _ackedSerialized = new Map<string, string>();
const _ackedHash = new Map<string, string>();
const _latestIntentWire = new Map<string, Record<string, unknown>>();
const _queues = new Map<string, SaveQueue>();
const _conflictedKeys = new Set<string>();
const _lastErrorToastAt = new Map<string, number>();
let saveSequence = 0;

function clearSaveState(): void {
    _ackedWire.clear();
    _ackedSerialized.clear();
    _ackedHash.clear();
    _latestIntentWire.clear();
    _queues.clear();
    _conflictedKeys.clear();
    _lastErrorToastAt.clear();
}

JC.identity?.registerReset?.('enhanced-config-writes', clearSaveState);

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function wireValue(fileName: string, settings: unknown): Record<string, unknown> {
    let value = settings;
    if (fileName === 'settings.json' && typeof window.JellyfinCanopy?.toPascalCase === 'function') {
        value = window.JellyfinCanopy.toPascalCase(settings);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new UserSettingsPersistenceError(`Invalid ${fileName} payload`, { kind: 'validation' });
    }
    return cloneRecord(value as Record<string, unknown>);
}

function localValue(fileName: string, wire: Record<string, unknown>): Record<string, unknown> {
    if (fileName === 'settings.json' && typeof (window.JellyfinCanopy as any)?.toCamelCase === 'function') {
        return (window.JellyfinCanopy as any).toCamelCase(cloneRecord(wire)) as Record<string, unknown>;
    }
    return cloneRecord(wire);
}

function revisionOf(value: Record<string, unknown>): number | null {
    const revision = Number(value.Revision ?? value.revision);
    return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}

function withoutRevision(value: Record<string, unknown>): Record<string, unknown> {
    const clone = cloneRecord(value);
    delete clone.Revision;
    delete clone.revision;
    return clone;
}

function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function sameValue(left: unknown, right: unknown): boolean {
    return canonical(left) === canonical(right);
}

function withoutServerManaged(value: Record<string, unknown>): Record<string, unknown> {
    const clone = withoutRevision(value);
    delete clone.IsAdmin;
    delete clone.isAdmin;
    return clone;
}

function sameContent(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
    return sameValue(withoutServerManaged(left), withoutServerManaged(right));
}

function cacheKeyFor(owner: SaveIntent['owner'], fileName: string): string {
    return `${owner.serverId}:${owner.userId}:${fileName}`;
}

function statusOf(error: unknown): number | undefined {
    if (!error || typeof error !== 'object') return undefined;
    const shaped = error as { status?: number; statusCode?: number; response?: { status?: number } };
    const status = Number(shaped.status ?? shaped.statusCode ?? shaped.response?.status);
    return Number.isFinite(status) && status > 0 ? status : undefined;
}

function responseJson(error: unknown): Record<string, unknown> | undefined {
    if (!error || typeof error !== 'object') return undefined;
    const value = (error as { responseJSON?: unknown }).responseJSON;
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function classifyPersistenceError(error: unknown): UserSettingsPersistenceError {
    if (error instanceof UserSettingsPersistenceError) return error;
    const status = statusOf(error);
    const response = responseJson(error);
    const responseData = response?.data ?? response?.Data;
    const authoritative = responseData && typeof responseData === 'object' && !Array.isArray(responseData)
        ? responseData as Record<string, unknown>
        : undefined;
    const responseMessage = response?.message ?? response?.Message;
    const message = typeof responseMessage === 'string'
        ? responseMessage
        : ((error as Error | null)?.message || 'User settings write failed');
    const name = (error as Error | null)?.name;
    if (name === 'AbortError' || name === 'IdentityChangedError') {
        return new UserSettingsPersistenceError(message, { kind: 'cancelled', ambiguous: true, cause: error });
    }
    if (status === 400 || status === 413 || status === 428) {
        return new UserSettingsPersistenceError(message, { kind: 'validation', status, cause: error });
    }
    if (status === 401 || status === 403) {
        return new UserSettingsPersistenceError(message, { kind: 'authorization', status, cause: error });
    }
    if (status === 409) {
        return new UserSettingsPersistenceError(message, {
            kind: 'conflict', status, retryable: true, authoritative, cause: error
        });
    }
    if (status === 429 || (status !== undefined && status >= 500)) {
        return new UserSettingsPersistenceError(message, {
            kind: 'unavailable', status, retryable: true, cause: error
        });
    }
    if (status === undefined) {
        return new UserSettingsPersistenceError(message, {
            kind: 'unavailable', retryable: true, ambiguous: true, cause: error
        });
    }
    return new UserSettingsPersistenceError(message, { kind: 'protocol', status, cause: error });
}

function parseAcknowledgement(value: unknown, fileName: string): SaveAcknowledgement {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new UserSettingsPersistenceError('Server returned a malformed save acknowledgement', { kind: 'protocol' });
    }
    const record = value as Record<string, unknown>;
    const data = record.data ?? record.Data;
    const revision = Number(record.revision ?? record.Revision);
    const rawContentHash = record.contentHash ?? record.ContentHash;
    const contentHash = typeof rawContentHash === 'string' ? rawContentHash : '';
    const success = record.success ?? record.Success;
    const responseFile = record.file ?? record.File;
    const conflict = record.conflict ?? record.Conflict;
    const responseMessage = record.message ?? record.Message;
    if (success !== true || responseFile !== fileName
        || !Number.isSafeInteger(revision) || revision < 0
        || !/^[0-9a-f]{64}$/i.test(contentHash)
        || !data || typeof data !== 'object' || Array.isArray(data)
        || revisionOf(data as Record<string, unknown>) !== revision) {
        throw new UserSettingsPersistenceError('Server did not acknowledge the exact user settings revision', { kind: 'protocol' });
    }
    return {
        success: true,
        conflict: conflict === true,
        message: typeof responseMessage === 'string' ? responseMessage : undefined,
        file: fileName,
        revision,
        contentHash,
        data: cloneRecord(data as Record<string, unknown>)
    };
}

async function pluginRequest(path: string, options: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<unknown> {
    if (JC.core.api?.plugin) {
        return JC.core.api.plugin(path, { ...options, skipRetry: true });
    }
    const method = options.method || 'GET';
    return ApiClient.ajax({
        type: method,
        url: ApiClient.getUrl(`/JellyfinCanopy${path}`),
        data: options.body === undefined ? undefined : JSON.stringify(options.body),
        contentType: options.body === undefined ? undefined : 'application/json',
        dataType: 'json',
        headers: options.headers
    });
}

async function readEvidence(intent: SaveIntent): Promise<SaveAcknowledgement> {
    const raw = await pluginRequest(
        `/user-settings/${encodeURIComponent(intent.owner.userId)}/${encodeURIComponent(intent.fileName)}/evidence`,
        { method: 'GET' }
    );
    return parseAcknowledgement(raw, intent.fileName);
}

function changedKeys(base: Record<string, unknown>, desired: Record<string, unknown>): string[] {
    const keys = new Set([...Object.keys(base), ...Object.keys(desired)]);
    keys.delete('Revision');
    keys.delete('revision');
    return [...keys].filter(key => !sameValue(base[key], desired[key]));
}

function safeRebase(intent: SaveIntent, authoritative: Record<string, unknown>): Record<string, unknown> | null {
    if (!intent.baseWire) return null;
    const rebased = cloneRecord(authoritative);
    for (const key of changedKeys(intent.baseWire, intent.desiredWire)) {
        const remote = authoritative[key];
        const base = intent.baseWire[key];
        const desired = intent.desiredWire[key];
        if (!sameValue(remote, base) && !sameValue(remote, desired)) return null;
        if (typeof desired === 'undefined') delete rebased[key];
        else rebased[key] = cloneRecord({ value: desired }).value;
    }
    return rebased;
}

async function postCandidate(intent: SaveIntent, candidate: Record<string, unknown>): Promise<SaveAcknowledgement> {
    const revision = revisionOf(candidate);
    if (revision === null) {
        throw new UserSettingsPersistenceError('User settings revision is missing', { kind: 'validation' });
    }
    const raw = await pluginRequest(`/user-settings/${encodeURIComponent(intent.owner.userId)}/${intent.fileName}`, {
        method: 'POST',
        body: candidate,
        headers: { 'If-Match': `"${revision}"` }
    });
    const ack = parseAcknowledgement(raw, intent.fileName);
    if (!sameContent(ack.data, candidate)) {
        throw new UserSettingsPersistenceError('Server acknowledged different user settings content', { kind: 'protocol' });
    }
    return ack;
}

async function executeIntent(intent: SaveIntent): Promise<SaveAcknowledgement> {
    if (!JC.identity.isCurrent(intent.owner) || !JC.identity.isOwned(intent.target, intent.owner)) {
        throw new UserSettingsPersistenceError('Identity changed before user settings could be saved', {
            kind: 'cancelled', ambiguous: false
        });
    }
    if (_conflictedKeys.has(intent.cacheKey)) {
        throw new UserSettingsPersistenceError('Reload before saving this user settings file again', {
            kind: 'conflict', status: 409, retryable: false
        });
    }

    let candidate = cloneRecord(intent.desiredWire);
    if (!intent.baseWire || revisionOf(intent.baseWire) === null) {
        const evidence = await readEvidence(intent);
        intent.baseWire = evidence.data;
        // The evidence read establishes the only valid conditional-write base.
        // Never retain a stale revision copied from a failed predecessor.
        candidate.Revision = evidence.revision;
        delete candidate.revision;
    }
    if (revisionOf(candidate) === null) {
        const baseRevision = intent.baseWire ? revisionOf(intent.baseWire) : null;
        if (baseRevision === null) {
            throw new UserSettingsPersistenceError('Server evidence omitted the user settings revision', { kind: 'protocol' });
        }
        candidate.Revision = baseRevision;
    }

    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            return await postCandidate(intent, candidate);
        } catch (rawError) {
            const error = classifyPersistenceError(rawError);
            if (!JC.identity.isCurrent(intent.owner)) throw error;

            if (error.ambiguous) {
                try {
                    const evidence = await readEvidence(intent);
                    if (sameContent(evidence.data, candidate)) return evidence;
                    if (evidence.revision === revisionOf(candidate)) {
                        if (error.kind === 'cancelled') throw error;
                        if (attempt === 0) continue;
                        throw new UserSettingsPersistenceError(
                            'The server remained unchanged after repeated unverified save attempts',
                            { kind: 'unavailable', retryable: true, ambiguous: true, authoritative: evidence.data, cause: error }
                        );
                    }
                    throw new UserSettingsPersistenceError(
                        'The save outcome is uncertain and the server has different content; reload before retrying',
                        { kind: 'conflict', status: 409, ambiguous: true, authoritative: evidence.data, cause: error }
                    );
                } catch (evidenceError) {
                    if (evidenceError instanceof UserSettingsPersistenceError
                        && (evidenceError.kind === 'conflict'
                            || evidenceError.kind === 'cancelled'
                            || (evidenceError.kind === 'unavailable' && evidenceError.ambiguous))) {
                        throw evidenceError;
                    }
                    throw new UserSettingsPersistenceError(
                        'The save outcome could not be verified; changes remain unsaved until reload',
                        { kind: 'unavailable', retryable: true, ambiguous: true, cause: evidenceError }
                    );
                }
            }

            if (error.kind !== 'conflict' || !error.authoritative) throw error;
            if (sameContent(error.authoritative, candidate)) {
                const evidence = await readEvidence(intent);
                if (sameContent(evidence.data, candidate)) return evidence;
            }
            const rebased = safeRebase(intent, error.authoritative);
            if (!rebased) throw error;
            candidate = rebased;
        }
    }
    throw new UserSettingsPersistenceError('User settings kept changing; reload and retry', {
        kind: 'conflict', status: 409, retryable: true
    });
}

function restoreTarget(intent: SaveIntent, wire: Record<string, unknown>): void {
    if (!JC.identity.isCurrent(intent.owner) || !JC.identity.isOwned(intent.target, intent.owner)) return;
    const desired = localValue(intent.fileName, intent.desiredWire);
    const restored = localValue(intent.fileName, wire);
    const keys = new Set([...Object.keys(desired), ...Object.keys(restored)]);
    keys.delete('Revision');
    keys.delete('revision');
    for (const key of keys) {
        // A newer unsaved edit may have happened after this intent was
        // captured but before it settled. Restore only fields that still equal
        // this intent's value; preserve later edits for their next save.
        if (!sameValue(intent.target[key], desired[key])) continue;
        if (Object.prototype.hasOwnProperty.call(restored, key)) {
            intent.target[key] = cloneRecord({ value: restored[key] }).value;
        } else {
            delete intent.target[key];
        }
    }
    if (Object.prototype.hasOwnProperty.call(restored, 'revision')) {
        intent.target.revision = restored.revision;
        delete intent.target.Revision;
    } else if (Object.prototype.hasOwnProperty.call(restored, 'Revision')) {
        intent.target.Revision = restored.Revision;
        delete intent.target.revision;
    }
}

function persistenceFailureMessage(error: UserSettingsPersistenceError, rollbackApplied: boolean): string {
    return error.kind === 'conflict'
        ? 'These settings changed elsewhere. Reload before retrying.'
        : error.kind === 'authorization'
            ? 'Your session is not authorized to save these settings.'
            : error.ambiguous
                ? 'The save could not be verified. Reload before making more changes.'
                : rollbackApplied
                    ? 'Changes could not be saved. The last confirmed settings were restored.'
                    : 'Changes could not be saved; no write was acknowledged.';
}

function emitPersistenceFailure(
    fileName: string,
    cacheKey: string,
    error: UserSettingsPersistenceError,
    rollbackApplied = false
): void {
    document.dispatchEvent(new CustomEvent('jc:user-settings-save-error', {
        detail: { file: fileName, kind: error.kind, status: error.status, retryable: error.retryable, ambiguous: error.ambiguous }
    }));
    const now = Date.now();
    if (now - (_lastErrorToastAt.get(cacheKey) || 0) < 2000) return;
    _lastErrorToastAt.set(cacheKey, now);
    toast(`{{icon:error}} ${escapeHtml(persistenceFailureMessage(error, rollbackApplied))}`, 5000);
}

function notifyPersistenceFailure(
    intent: SaveIntent,
    error: UserSettingsPersistenceError,
    rollbackApplied: boolean
): void {
    console.error(`🪼 Jellyfin Canopy: Failed to save ${intent.fileName}:`, error);
    if (!JC.identity.isCurrent(intent.owner)) return;
    emitPersistenceFailure(intent.fileName, intent.cacheKey, error, rollbackApplied);
}

function notifyImmediatePersistenceFailure(fileName: string, error: UserSettingsPersistenceError): void {
    console.error(`🪼 Jellyfin Canopy: Refused to save ${fileName}:`, error);
    emitPersistenceFailure(fileName, `immediate:${fileName}`, error);
}

async function drainQueue(queue: SaveQueue): Promise<void> {
    if (queue.running) return;
    queue.running = true;
    try {
        while (queue.pending) {
            const intent = queue.pending;
            queue.pending = null;
            queue.active = intent;
            try {
                const ack = await executeIntent(intent);
                if (!JC.identity.isCurrent(intent.owner)) {
                    throw new UserSettingsPersistenceError('Identity changed after save acknowledgement', {
                        kind: 'cancelled', ambiguous: false
                    });
                }
                _ackedWire.set(intent.cacheKey, cloneRecord(ack.data));
                _ackedSerialized.set(intent.cacheKey, canonical(withoutRevision(ack.data)));
                _ackedHash.set(intent.cacheKey, ack.contentHash);
                if (queue.pending) {
                    // The pending intent was edited while this write was in
                    // flight.  Its logical base is the state just acknowledged,
                    // not the pre-write revision copied from the live object.
                    // Advancing both snapshots avoids a manufactured 409 and
                    // makes the final coalesced edit a true sequential commit.
                    queue.pending.baseWire = cloneRecord(ack.data);
                    queue.pending.desiredWire['Revision'] = ack.revision;
                    delete queue.pending.desiredWire['revision'];
                }
                if (!queue.pending && queue.latestSeq === intent.seq) {
                    _latestIntentWire.set(intent.cacheKey, cloneRecord(ack.data));
                    restoreTarget(intent, ack.data);
                }
                const result: UserSettingsSaveResult = {
                    acknowledged: true,
                    deduplicated: false,
                    file: intent.fileName,
                    revision: ack.revision,
                    contentHash: ack.contentHash
                };
                intent.waiters.forEach(waiter => waiter.resolve(result));
            } catch (rawError) {
                const error = classifyPersistenceError(rawError);
                let rollbackApplied = false;
                // Settle callers before any best-effort DOM conversion, event,
                // or toast code can itself fail.
                intent.waiters.forEach(waiter => waiter.reject(error));
                if (queue.pending) {
                    // A never-acknowledged intent cannot become the logical
                    // base for the next edit. Rebase the queued payload from
                    // the last server-confirmed snapshot (or force a fresh
                    // evidence read when none exists) so failed fields cannot
                    // disappear from changedKeys() and resolve as false success.
                    const acknowledged = _ackedWire.get(intent.cacheKey);
                    queue.pending.baseWire = acknowledged ? cloneRecord(acknowledged) : null;
                    if (acknowledged) {
                        const revision = revisionOf(acknowledged);
                        if (revision !== null) {
                            queue.pending.desiredWire.Revision = revision;
                            delete queue.pending.desiredWire.revision;
                        }
                    } else {
                        delete queue.pending.desiredWire.Revision;
                        delete queue.pending.desiredWire.revision;
                    }
                }
                if (!queue.pending && queue.latestSeq === intent.seq) {
                    try {
                        if (error.kind === 'conflict') _conflictedKeys.add(intent.cacheKey);
                        const rollback = error.authoritative || _ackedWire.get(intent.cacheKey);
                        if (!error.ambiguous && rollback) {
                            restoreTarget(intent, rollback);
                            rollbackApplied = true;
                        }
                        _latestIntentWire.set(intent.cacheKey, cloneRecord(rollback || intent.desiredWire));
                    } catch (rollbackError) {
                        console.error(`🪼 Jellyfin Canopy: Failed to restore ${intent.fileName} after rejection:`, rollbackError);
                    }
                }
                try { notifyPersistenceFailure(intent, error, rollbackApplied); } catch (notifyError) {
                    console.error(`🪼 Jellyfin Canopy: Failed to report ${intent.fileName} rejection:`, notifyError);
                }
            } finally {
                queue.active = null;
            }
        }
    } finally {
        queue.running = false;
    }
}

JC.rememberUserSettingsSnapshot = (fileName: string, settings: unknown): void => {
    if (!SUPPORTED_USER_FILES.has(fileName) || !settings || typeof settings !== 'object') return;
    const owner = JC.identity.ownerOf(settings) || JC.identity.capture();
    if (!owner || !JC.identity.isCurrent(owner)) return;
    const wire = wireValue(fileName, settings);
    const key = cacheKeyFor(owner, fileName);
    const serialized = canonical(withoutRevision(wire));
    // A normal GET is authoritative baseline state, but it does not carry the
    // exact write-evidence hash.  Keep it for rollback/rebase while requiring
    // the first save (including a no-op save) to obtain a structured server
    // acknowledgement before the write-dedup cache can advance.
    if (_ackedSerialized.get(key) !== serialized) {
        _ackedSerialized.delete(key);
        _ackedHash.delete(key);
    }
    _ackedWire.set(key, wire);
    _latestIntentWire.set(key, cloneRecord(wire));
    _conflictedKeys.delete(key);
};

JC.saveUserSettings = (fileName: string, settings: unknown): Promise<UserSettingsSaveResult> => {
    try {
        if (!SUPPORTED_USER_FILES.has(fileName) || !settings || typeof settings !== 'object' || Array.isArray(settings)) {
            throw new UserSettingsPersistenceError('saveUserSettings requires a supported file and object payload', { kind: 'validation' });
        }
        const owner = JC.identity?.ownerOf?.(settings);
        if (!owner || !JC.identity.isCurrent(owner) || !JC.identity.isOwned(settings, owner)) {
            throw new UserSettingsPersistenceError(`Refusing to save ${fileName}; payload has no current identity owner`, {
                kind: 'cancelled'
            });
        }
        if (typeof ApiClient === 'undefined' || typeof ApiClient.getCurrentUserId !== 'function') {
            throw new UserSettingsPersistenceError('ApiClient is unavailable', { kind: 'unavailable', retryable: true });
        }
        if (normalizeIdentityPart(ApiClient.getCurrentUserId()) !== owner.userId) {
            throw new UserSettingsPersistenceError(`Refusing to save ${fileName}; live user does not own the payload`, {
                kind: 'authorization'
            });
        }
        const liveServerId = liveApiClientServerId();
        if (!isResolvedServerId(owner.serverId)
            || !isResolvedServerId(liveServerId)
            || normalizeIdentityPart(liveServerId) !== normalizeIdentityPart(owner.serverId)) {
            throw new UserSettingsPersistenceError(`Refusing to save ${fileName}; live server does not own the payload`, {
                kind: 'authorization'
            });
        }

        const target = settings as Record<string, unknown>;
        const desiredWire = wireValue(fileName, settings);
        const key = cacheKeyFor(owner, fileName);
        const serialized = canonical(withoutRevision(desiredWire));
        const revision = revisionOf(_ackedWire.get(key) || desiredWire) || 0;
        let queue = _queues.get(key);
        const acknowledgedHash = _ackedHash.get(key);
        if (!queue?.active && !queue?.pending
            && !_conflictedKeys.has(key)
            && _ackedSerialized.get(key) === serialized && acknowledgedHash) {
            return Promise.resolve({
                acknowledged: true,
                deduplicated: true,
                file: fileName,
                revision,
                contentHash: acknowledgedHash
            });
        }

        if (!queue) {
            queue = { running: false, active: null, pending: null, latestSeq: 0 };
            _queues.set(key, queue);
        }
        const saveQueue = queue;

        return new Promise<UserSettingsSaveResult>((resolve, reject) => {
            const waiter = { resolve, reject };
            if (saveQueue.active?.serialized === serialized) {
                saveQueue.active.waiters.push(waiter);
                return;
            }
            if (saveQueue.pending?.serialized === serialized) {
                saveQueue.pending.waiters.push(waiter);
                return;
            }
            const baseWire = _latestIntentWire.get(key) || _ackedWire.get(key) || null;
            const intent: SaveIntent = {
                seq: ++saveSequence,
                cacheKey: key,
                fileName,
                owner,
                target,
                baseWire: baseWire ? cloneRecord(baseWire) : null,
                desiredWire,
                serialized,
                waiters: saveQueue.pending ? [...saveQueue.pending.waiters, waiter] : [waiter]
            };
            saveQueue.pending = intent;
            saveQueue.latestSeq = intent.seq;
            _latestIntentWire.set(key, cloneRecord(desiredWire));
            void drainQueue(saveQueue);
        });
    } catch (error) {
        const classified = classifyPersistenceError(error);
        try { notifyImmediatePersistenceFailure(fileName, classified); } catch { /* rejection remains observable */ }
        return Promise.reject(classified);
    }
};

/**
 * Loads and merges settings from user config, plugin defaults, and hardcoded fallbacks.
 */
JC.loadSettings = (): UserSettings => {
    const context = JC.identity?.capture?.() || null;
    const storedSettings = JC.userConfig?.settings || {};
    // An owner-tagged object from a prior epoch must never seed B's merged
    // settings. During legacy/test boot (no active context), retain the old
    // behaviour so the pure default-resolution contract remains usable.
    const storedOwner = JC.identity?.ownerOf?.(storedSettings) || null;
    const userSettings: Record<string, unknown> = context && storedOwner
        && !JC.identity.isOwned(storedSettings, context)
        ? {}
        : storedSettings;
    if (context && !storedOwner) JC.identity.own(userSettings, context);
    const pluginDefaults: Record<string, unknown> = JC.pluginConfig || {};
    // JC.pluginConfig is PascalCase; the merge below iterates camelCase keys, so
    // the admin tier resolves through a camelCase VIEW (ENH-4). Without this the
    // admin tier read `pluginDefaults[camelKey]` off the PascalCase object and
    // always missed, silently falling every paired setting through to hardcoded.
    const adminDefaults = adminDefaultsView(pluginDefaults);

    const hardcodedDefaults: Record<string, unknown> = {
        autoPauseEnabled: true, autoResumeEnabled: false, autoPipEnabled: false,
        autoSkipIntro: false, autoSkipOutro: false,
        selectedStylePresetIndex: 0, selectedFontSizePresetIndex: 2, selectedFontFamilyPresetIndex: 0,
        customSubtitleTextColor: '#FFFFFFFF', customSubtitleBgColor: '#00000000',
        usingCustomColors: false,
        disableCustomSubtitleStyles: false,
        subtitleVerticalPosition: 85, subtitleHorizontalPosition: 50,
        randomButtonEnabled: true,
        randomIncludeMovies: true, randomIncludeShows: true, randomUnwatchedOnly: false,
        showWatchProgress: false, showFileSizes: false, showAudioLanguages: true, removeContinueWatchingEnabled: false,
        watchProgressMode: 'percentage',
        watchProgressTimeFormat: 'hours',
        pauseScreenEnabled: true,
        pauseScreenDelaySeconds: 5,
        qualityTagsEnabled: false, genreTagsEnabled: false, languageTagsEnabled: false, ratingTagsEnabled: false, peopleTagsEnabled: false, tagsHideOnHover: false,
        showResolutionTag: true, showSourceTag: true, showDynamicRangeTag: true, showSpecialFormatTag: true, showVideoCodecTag: true, showAudioInfoTag: true,
        resolutionTagOrder: 1, sourceTagOrder: 2, dynamicRangeTagOrder: 3, specialFormatTagOrder: 4, videoCodecTagOrder: 5, audioInfoTagOrder: 6,
        qualityTagsPosition: 'top-left', genreTagsPosition: 'top-right', languageTagsPosition: 'bottom-left', ratingTagsPosition: 'bottom-right',
        showRatingInPlayer: true,
        reviewsExpandedByDefault: false,
        displayLanguage: '',
        calendarDisplayMode: 'list',
        calendarDefaultViewMode: 'agenda',
        disableAllShortcuts: false, longPress2xEnabled: false, lastOpenedTab: 'shortcuts',
        isAdmin: undefined
    };

    const mergedSettings: Record<string, unknown> = {};
    // Seed with all keys from the stored user settings so that any field not
    // listed in hardcodedDefaults (e.g. fields added in newer plugin versions,
    // or fields the frontend doesn't actively manage) is preserved as-is and
    // not silently dropped when currentSettings is written back to the server.
    for (const key in userSettings) {
        mergedSettings[key] = userSettings[key];
    }
    for (const key in hardcodedDefaults) {
        if (Object.prototype.hasOwnProperty.call(userSettings, key) && userSettings[key] !== null && userSettings[key] !== undefined) {
            // Detect corrupted values (empty arrays or unexpected objects)
            if (typeof userSettings[key] === 'object' && Array.isArray(userSettings[key]) && userSettings[key].length === 0) {
                mergedSettings[key] = pluginDefaults[key] ?? hardcodedDefaults[key];
            } else if (typeof userSettings[key] === 'object' && userSettings[key] !== null && !Array.isArray(userSettings[key])) {
                mergedSettings[key] = pluginDefaults[key] ?? hardcodedDefaults[key];
            } else {
                mergedSettings[key] = userSettings[key];
            }
        } else if (Object.prototype.hasOwnProperty.call(adminDefaults, key) && adminDefaults[key] !== null && adminDefaults[key] !== undefined) {
            mergedSettings[key] = adminDefaults[key];
        } else {
            mergedSettings[key] = hardcodedDefaults[key];
        }
    }

    // displayLanguage stays an explicit override: its admin default is the
    // RENAMED property DefaultLanguage, which the generic camelCase view maps to
    // `defaultLanguage` (not `displayLanguage`), so the merge loop can't resolve
    // it. removeContinueWatchingEnabled is NOT special-cased anymore — the admin
    // tier now resolves RemoveContinueWatchingEnabled generically through
    // adminDefaults.
    mergedSettings.displayLanguage = Object.prototype.hasOwnProperty.call(userSettings, 'displayLanguage')
        ? userSettings.displayLanguage
        : (pluginDefaults.DefaultLanguage || '');
    mergedSettings.lastOpenedTab = userSettings.lastOpenedTab || 'shortcuts';

    // Ensure isAdmin is always present (even if undefined) so it can be set later
    if (!Object.prototype.hasOwnProperty.call(mergedSettings, 'isAdmin')) {
        mergedSettings.isAdmin = userSettings.isAdmin !== undefined ? userSettings.isAdmin : undefined;
    }

    const ownedSettings = JC.identity?.own?.(mergedSettings, context) || mergedSettings;
    JC.rememberUserSettingsSnapshot?.('settings.json', ownedSettings);
    return ownedSettings;
};

/** Shape of a shortcut entry in plugin/user config. */
interface ShortcutEntry {
    Name?: string;
    Key?: string;
}

/**
 * Initializes keyboard shortcut mappings from plugin and user configurations.
 */
JC.initializeShortcuts = function (): void {
    const pluginDefaults = JC.pluginConfig || {};
    const userShortcutsConfig = JC.userConfig?.shortcuts || {};
    JC.rememberUserSettingsSnapshot?.('shortcuts.json', userShortcutsConfig);

    const defaultShortcuts = Array.isArray(pluginDefaults.Shortcuts)
        ? (pluginDefaults.Shortcuts as ShortcutEntry[]).reduce<Record<string, string>>((acc, s) => {
            if (s && s.Name && s.Key !== undefined) acc[s.Name] = s.Key;
            return acc;
          }, {})
        : {};

    const userShortcuts = Array.isArray(userShortcutsConfig.Shortcuts)
        ? (userShortcutsConfig.Shortcuts as ShortcutEntry[]).reduce<Record<string, string>>((acc, s) => {
            if (s && s.Name && s.Key !== undefined) acc[s.Name] = s.Key;
            return acc;
          }, {})
        : {};

    // Replace the map instead of merging in place: keys belonging only to A
    // must disappear when B initializes in the same SPA document.
    JC.state!.activeShortcuts = { ...defaultShortcuts, ...userShortcuts };
};
