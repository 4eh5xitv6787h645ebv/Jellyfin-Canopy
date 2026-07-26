// Actor/target-isolated state for the Canopy User Settings panel.
//
// The normal settings runtime remains strictly self-owned.  When an
// administrator opens another user's preferences route, this module keeps the
// target files, revisions, shortcut map, write queue, and rollback state in a
// panel-local editor.  Nothing here publishes target data through
// JC.currentSettings, JC.userConfig, JC.state, or browser storage.

import { JC } from '../../globals';
import type { IdentityContext, UserSettings } from '../../types/jc';
import type { UserSettingsSaveResult } from '../config';
import {
    canonicalizeShortcut,
    normalizeShortcutEntries,
} from '../shortcut-codec';

export type PanelEditorMode = 'self' | 'admin-target';
export type PanelUserFile = 'settings.json' | 'shortcuts.json';

export interface PanelEditorContext {
    readonly mode: PanelEditorMode;
    readonly actor: IdentityContext;
    readonly targetUserId: string;
    readonly targetDisplayName: string;
    readonly appliesToActor: boolean;
    readonly settings: UserSettings;
    readonly shortcuts: Record<string, unknown>;
    readonly activeShortcuts: Record<string, string>;
    isCurrent(): boolean;
    saveSettings(): Promise<UserSettingsSaveResult>;
    saveShortcuts(): Promise<UserSettingsSaveResult>;
}

export class AdminTargetPersistenceError extends Error {
    readonly kind: 'authorization' | 'cancelled' | 'conflict' | 'protocol' | 'unavailable' | 'validation';
    readonly status?: number;
    readonly retryable: boolean;
    readonly ambiguous: boolean;
    readonly authoritative?: Record<string, unknown>;

    constructor(message: string, options: {
        kind: AdminTargetPersistenceError['kind'];
        status?: number;
        retryable?: boolean;
        ambiguous?: boolean;
        authoritative?: Record<string, unknown>;
        cause?: unknown;
    }) {
        super(message, { cause: options.cause });
        this.name = 'AdminTargetPersistenceError';
        this.kind = options.kind;
        this.status = options.status;
        this.retryable = options.retryable === true;
        this.ambiguous = options.ambiguous === true;
        this.authoritative = options.authoritative;
    }
}

function stalePanelError(cause?: unknown): AdminTargetPersistenceError {
    return new AdminTargetPersistenceError('Settings panel is stale.', {
        kind: 'cancelled',
        cause,
    });
}

interface AdminFileEnvelope {
    file: PanelUserFile;
    revision: number;
    contentHash: string;
    data: Record<string, unknown>;
    targetUserId: string;
    targetDisplayName: string;
}

interface SaveWaiter {
    resolve(result: UserSettingsSaveResult): void;
    reject(reason: unknown): void;
}

interface SaveIntent {
    readonly seq: number;
    readonly file: PanelUserFile;
    readonly target: Record<string, unknown>;
    baseWire: Record<string, unknown> | null;
    desiredWire: Record<string, unknown>;
    serialized: string;
    readonly waiters: SaveWaiter[];
}

interface FileQueue {
    running: boolean;
    active: SaveIntent | null;
    pending: SaveIntent | null;
    latestSeq: number;
    acknowledged: Record<string, unknown>;
    acknowledgedHash: string;
    conflictFence: boolean;
    releaseSafetyHold: (() => void) | null;
}

// TypeScript keeps the synchronous `pending = null` narrowing across awaits.
// Read through a function to observe saves enqueued while transport was active.
function currentPending(queue: FileQueue): SaveIntent | null {
    return queue.pending;
}

function normalizeId(value: unknown): string {
    return typeof value === 'string'
        ? value.trim().replace(/-/g, '').toLowerCase()
        : '';
}

const UNKNOWN_SERVER_ID = normalizeId('unknown-server');

function isResolvedTargetServer(value: unknown): boolean {
    const normalized = normalizeId(value);
    return normalized !== '' && normalized !== UNKNOWN_SERVER_ID;
}

function liveTargetServerId(): string {
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
        if (isResolvedTargetServer(direct)) return String(direct);
    } catch { /* try server-info forms */ }
    try {
        const info = typeof client.serverInfo === 'function'
            ? client.serverInfo.call(client)
            : (client.serverInfo || client._serverInfo);
        const fromInfo = info?.Id || info?.ServerId || '';
        if (isResolvedTargetServer(fromInfo)) return fromInfo;
    } catch { /* fall through to address */ }
    try {
        const address = typeof client.serverAddress === 'function'
            ? client.serverAddress.call(client)
            : (client.serverAddress || client.getUrl('/'));
        if (isResolvedTargetServer(address)) {
            return new URL(String(address), window.location.href).origin;
        }
    } catch { /* unresolved below */ }
    return '';
}

const TARGET_SETTING_DEFAULTS: Record<string, unknown> = {
    autoPauseEnabled: true, autoResumeEnabled: false, autoPipEnabled: false,
    autoSkipIntro: false, autoSkipOutro: false,
    selectedStylePresetIndex: 0, selectedFontSizePresetIndex: 2, selectedFontFamilyPresetIndex: 0,
    customSubtitleTextColor: '#FFFFFFFF', customSubtitleBgColor: '#00000000',
    usingCustomColors: false, disableCustomSubtitleStyles: false,
    subtitleVerticalPosition: 85, subtitleHorizontalPosition: 50,
    randomButtonEnabled: true, randomIncludeMovies: true, randomIncludeShows: true, randomUnwatchedOnly: false,
    showWatchProgress: false, showFileSizes: false, showAudioLanguages: true, removeContinueWatchingEnabled: false, hideFavoritesTab: false,
    watchProgressMode: 'percentage', watchProgressTimeFormat: 'hours',
    pauseScreenEnabled: true, pauseScreenDelaySeconds: 5,
    qualityTagsEnabled: false, genreTagsEnabled: false, languageTagsEnabled: false, ratingTagsEnabled: false, peopleTagsEnabled: false, tagsHideOnHover: false,
    showResolutionTag: true, showSourceTag: true, showDynamicRangeTag: true, showSpecialFormatTag: true, showVideoCodecTag: true, showAudioInfoTag: true,
    resolutionTagOrder: 1, sourceTagOrder: 2, dynamicRangeTagOrder: 3, specialFormatTagOrder: 4, videoCodecTagOrder: 5, audioInfoTagOrder: 6,
    qualityTagsPosition: 'top-left', genreTagsPosition: 'top-right', languageTagsPosition: 'bottom-left', ratingTagsPosition: 'bottom-right',
    showRatingInPlayer: true, reviewsExpandedByDefault: false, displayLanguage: '',
    calendarDisplayMode: 'list', calendarDefaultViewMode: 'agenda',
    disableAllShortcuts: false, longPress2xEnabled: false, lastOpenedTab: 'shortcuts',
    isAdmin: undefined,
};
const TARGET_EDITABLE_SETTING_KEYS = new Set([
    ...Object.keys(TARGET_SETTING_DEFAULTS).filter(
        key => key !== 'lastOpenedTab' && key !== 'isAdmin',
    ),
    'animeFillerWarningsEnabled',
]);

function resolveTargetSettings(
    userSettings: Record<string, unknown>,
    pluginDefaults: Record<string, unknown>,
): UserSettings {
    const adminDefaults: Record<string, unknown> = {};
    for (const key of Object.keys(pluginDefaults)) {
        adminDefaults[key.charAt(0).toLowerCase() + key.slice(1)] = pluginDefaults[key];
    }
    const defaults = TARGET_SETTING_DEFAULTS;
    const merged: Record<string, unknown> = { ...userSettings };
    for (const key of Object.keys(defaults)) {
        const stored = userSettings[key];
        if (stored !== null && stored !== undefined
            && Object.prototype.hasOwnProperty.call(userSettings, key)) {
            merged[key] = typeof stored === 'object'
                && ((Array.isArray(stored) && stored.length === 0)
                    || (!Array.isArray(stored) && stored !== null))
                ? pluginDefaults[key] ?? defaults[key]
                : stored;
        } else {
            merged[key] = Object.prototype.hasOwnProperty.call(adminDefaults, key)
                && adminDefaults[key] !== null && adminDefaults[key] !== undefined
                ? adminDefaults[key]
                : defaults[key];
        }
    }
    merged.displayLanguage = Object.prototype.hasOwnProperty.call(userSettings, 'displayLanguage')
        ? userSettings.displayLanguage
        : (pluginDefaults.DefaultLanguage || '');
    // Panel navigation is editor-local in target mode. Preserve even an empty
    // or absent wire value so an unrelated preference save cannot materialize
    // the actor runtime's default tab into the target file.
    if (Object.prototype.hasOwnProperty.call(userSettings, 'lastOpenedTab')) {
        merged.lastOpenedTab = userSettings.lastOpenedTab;
    } else {
        delete merged.lastOpenedTab;
    }
    return merged;
}

interface TargetShortcut {
    Name?: string;
    Key?: string;
}

function resolveTargetShortcuts(
    pluginDefaults: Record<string, unknown>,
    targetShortcuts: Record<string, unknown>,
): Record<string, string> {
    normalizeShortcutEntries(targetShortcuts.Shortcuts);
    const collect = (value: unknown): Record<string, string> => Array.isArray(value)
        ? (value as TargetShortcut[]).reduce<Record<string, string>>((result, shortcut) => {
            if (shortcut?.Name && shortcut.Key !== undefined) {
                result[shortcut.Name] = canonicalizeShortcut(shortcut.Key);
            }
            return result;
        }, {})
        : {};
    return {
        ...collect(pluginDefaults.Shortcuts),
        ...collect(targetShortcuts.Shortcuts),
    };
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function cloneValue(value: unknown): unknown {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value)) as unknown;
}

function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function revisionOf(value: Record<string, unknown>): number | null {
    const revision = Number(value.Revision ?? value.revision);
    return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}

function withoutRevision(value: Record<string, unknown>): Record<string, unknown> {
    const result = cloneRecord(value);
    delete result.Revision;
    delete result.revision;
    return result;
}

function withoutServerManaged(value: Record<string, unknown>): Record<string, unknown> {
    const result = withoutRevision(value);
    delete result.IsAdmin;
    delete result.isAdmin;
    return result;
}

function sameValue(left: unknown, right: unknown): boolean {
    return canonical(left) === canonical(right);
}

function sameContent(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
    return sameValue(withoutServerManaged(left), withoutServerManaged(right));
}

function changedKeys(base: Record<string, unknown>, desired: Record<string, unknown>): string[] {
    const keys = new Set([...Object.keys(base), ...Object.keys(desired)]);
    keys.delete('Revision');
    keys.delete('revision');
    keys.delete('IsAdmin');
    keys.delete('isAdmin');
    return [...keys].filter(key => !sameValue(base[key], desired[key]));
}

function safeRebase(
    base: Record<string, unknown> | null,
    desired: Record<string, unknown>,
    authoritative: Record<string, unknown>,
): Record<string, unknown> | null {
    if (!base) return null;
    const rebased = cloneRecord(authoritative);
    for (const key of changedKeys(base, desired)) {
        const remote = authoritative[key];
        const oldValue = base[key];
        const newValue = desired[key];
        // Never silently overwrite a value changed independently by someone
        // else.  A non-overlapping conflict is safe to rebase and retry.
        if (!sameValue(remote, oldValue) && !sameValue(remote, newValue)) return null;
        if (newValue === undefined) delete rebased[key];
        else rebased[key] = cloneValue(newValue);
    }
    return rebased;
}

function recordOf(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function field(record: Record<string, unknown>, camel: string, pascal: string): unknown {
    return record[camel] ?? record[pascal];
}

function parseEnvelope(
    value: unknown,
    expectedFile: PanelUserFile,
    expectedTargetId: string,
    mutation: boolean,
): AdminFileEnvelope {
    const record = recordOf(value);
    const data = recordOf(record ? field(record, 'data', 'Data') : null);
    const file = record ? field(record, 'file', 'File') : null;
    const revision = Number(record ? field(record, 'revision', 'Revision') : Number.NaN);
    const hashValue = record ? field(record, 'contentHash', 'ContentHash') : null;
    const targetValue = record ? field(record, 'targetUserId', 'TargetUserId') : null;
    const nameValue = record ? field(record, 'targetDisplayName', 'TargetDisplayName') : null;
    const success = record ? field(record, 'success', 'Success') : null;
    const targetUserId = normalizeId(targetValue);
    const contentHash = typeof hashValue === 'string' ? hashValue.toLowerCase() : '';
    const targetDisplayName = typeof nameValue === 'string' ? nameValue.trim() : '';

    if (!record || !data || file !== expectedFile
        || success !== true
        || !Number.isSafeInteger(revision) || revision < 0
        || revisionOf(data) !== revision
        || !/^[0-9a-f]{64}$/.test(contentHash)
        || targetUserId !== expectedTargetId
        || targetDisplayName.length === 0) {
        throw new AdminTargetPersistenceError(
            mutation
                ? 'The server did not acknowledge the exact target user settings revision.'
                : 'The server returned malformed target user settings.',
            { kind: 'protocol', ambiguous: mutation },
        );
    }

    return {
        file: expectedFile,
        revision,
        contentHash,
        data: cloneRecord(data),
        targetUserId,
        targetDisplayName,
    };
}

function parseConflictEnvelope(
    value: unknown,
    expectedFile: PanelUserFile,
    expectedTargetId: string,
): AdminFileEnvelope {
    const record = recordOf(value);
    const data = recordOf(record ? field(record, 'data', 'Data') : null);
    const file = record ? field(record, 'file', 'File') : null;
    const revision = Number(record ? field(record, 'revision', 'Revision') : Number.NaN);
    const hashValue = record ? field(record, 'contentHash', 'ContentHash') : null;
    const targetValue = record ? field(record, 'targetUserId', 'TargetUserId') : null;
    const nameValue = record ? field(record, 'targetDisplayName', 'TargetDisplayName') : null;
    const conflict = record ? field(record, 'conflict', 'Conflict') : null;
    const contentHash = typeof hashValue === 'string' ? hashValue.toLowerCase() : '';
    const targetUserId = normalizeId(targetValue);
    const targetDisplayName = typeof nameValue === 'string' ? nameValue.trim() : '';
    if (!record || !data || conflict !== true || file !== expectedFile
        || !Number.isSafeInteger(revision) || revision < 0
        || revisionOf(data) !== revision
        || !/^[0-9a-f]{64}$/.test(contentHash)
        || targetUserId !== expectedTargetId
        || targetDisplayName.length === 0) {
        throw new AdminTargetPersistenceError(
            'The server returned unverified target conflict evidence.',
            { kind: 'conflict', status: 409, ambiguous: true },
        );
    }
    return {
        file: expectedFile,
        revision,
        contentHash,
        data: cloneRecord(data),
        targetUserId,
        targetDisplayName,
    };
}

function statusOf(error: unknown): number | undefined {
    if (!error || typeof error !== 'object') return undefined;
    const shaped = error as { status?: number; statusCode?: number; response?: { status?: number } };
    const status = Number(shaped.status ?? shaped.statusCode ?? shaped.response?.status);
    return Number.isFinite(status) && status > 0 ? status : undefined;
}

function responseJson(error: unknown): Record<string, unknown> | undefined {
    if (!error || typeof error !== 'object') return undefined;
    const response = (error as { responseJSON?: unknown }).responseJSON;
    return recordOf(response) || undefined;
}

function classifyError(
    error: unknown,
    expectedFile?: PanelUserFile,
    expectedTargetId?: string,
): AdminTargetPersistenceError {
    if (error instanceof AdminTargetPersistenceError) return error;
    const status = statusOf(error);
    const response = responseJson(error);
    const messageValue = response ? field(response, 'message', 'Message') : null;
    const message = typeof messageValue === 'string'
        ? messageValue
        : ((error as Error | null)?.message || 'Target user settings request failed.');
    const name = (error as Error | null)?.name;
    if (name === 'AbortError' || name === 'IdentityChangedError') {
        return new AdminTargetPersistenceError(message, {
            kind: 'cancelled',
            ambiguous: true,
            cause: error,
        });
    }
    if (status === 400 || status === 413 || status === 428) {
        return new AdminTargetPersistenceError(message, { kind: 'validation', status, cause: error });
    }
    if (status === 401 || status === 403) {
        return new AdminTargetPersistenceError(message, { kind: 'authorization', status, cause: error });
    }
    if (status === 409) {
        if (!expectedFile || !expectedTargetId || !response) {
            return new AdminTargetPersistenceError(message, {
                kind: 'conflict',
                status,
                ambiguous: true,
                cause: error,
            });
        }
        let authoritative: Record<string, unknown>;
        try {
            authoritative = parseConflictEnvelope(
                response,
                expectedFile,
                expectedTargetId,
            ).data;
        } catch (conflictError) {
            return new AdminTargetPersistenceError(message, {
                kind: 'conflict',
                status,
                ambiguous: true,
                cause: conflictError,
            });
        }
        return new AdminTargetPersistenceError(message, {
            kind: 'conflict',
            status,
            retryable: true,
            authoritative,
            cause: error,
        });
    }
    if (status === 429 || (status !== undefined && status >= 500)) {
        return new AdminTargetPersistenceError(message, {
            kind: 'unavailable',
            status,
            retryable: true,
            cause: error,
        });
    }
    if (status === undefined) {
        return new AdminTargetPersistenceError(message, {
            kind: 'unavailable',
            retryable: true,
            ambiguous: true,
            cause: error,
        });
    }
    return new AdminTargetPersistenceError(message, { kind: 'protocol', status, cause: error });
}

function localValue(file: PanelUserFile, wire: Record<string, unknown>): Record<string, unknown> {
    if (file === 'settings.json') {
        const transformed = JC.transformUserFileCase?.(file, cloneRecord(wire), 'load')
            ?? JC.toCamelCase?.(cloneRecord(wire))
            ?? cloneRecord(wire);
        const record = recordOf(transformed);
        if (!record) {
            throw new AdminTargetPersistenceError('Target settings conversion failed.', { kind: 'protocol' });
        }
        return record;
    }
    const result = cloneRecord(wire);
    normalizeShortcutEntries(result.Shortcuts);
    if (!Array.isArray(result.Shortcuts)) result.Shortcuts = [];
    return result;
}

function wireValue(file: PanelUserFile, local: Record<string, unknown>): Record<string, unknown> {
    let transformed: unknown = local;
    if (file === 'settings.json') {
        transformed = JC.transformUserFileCase?.(file, local, 'save')
            ?? JC.toPascalCase?.(local)
            ?? local;
    }
    const result = recordOf(transformed);
    if (!result) {
        throw new AdminTargetPersistenceError('Target settings payload is invalid.', { kind: 'validation' });
    }
    const clone = cloneRecord(result);
    if (file === 'shortcuts.json') normalizeShortcutEntries(clone.Shortcuts);
    return clone;
}

function settingsWireKeysByLocalKey(
    wire: Record<string, unknown>,
): Map<string, string> {
    const result = new Map<string, string>();
    for (const wireKey of Object.keys(wire)) {
        if (wireKey === 'Revision' || wireKey === 'revision') continue;
        const converted = localValue('settings.json', { [wireKey]: wire[wireKey] });
        const localKey = Object.keys(converted).find(
            key => key !== 'Revision' && key !== 'revision',
        );
        if (localKey && !result.has(localKey)) result.set(localKey, wireKey);
    }
    return result;
}

function mergeChangedSettingsWire(
    current: Record<string, unknown>,
    baseWire: Record<string, unknown>,
    pluginDefaults: Record<string, unknown>,
): Record<string, unknown> {
    const baseline = resolveTargetSettings(
        localValue('settings.json', baseWire),
        pluginDefaults,
    ) as Record<string, unknown>;
    const transformed = wireValue('settings.json', current);
    const existingKeys = settingsWireKeysByLocalKey(baseWire);
    const transformedKeys = settingsWireKeysByLocalKey(transformed);
    const result = cloneRecord(baseWire);
    for (const localKey of TARGET_EDITABLE_SETTING_KEYS) {
        if (sameValue(baseline[localKey], current[localKey])) continue;
        const existingKey = existingKeys.get(localKey);
        const outputKey = transformedKeys.get(localKey) || existingKey;
        if (!outputKey) continue;
        if (existingKey && existingKey !== outputKey) delete result[existingKey];
        if (!Object.prototype.hasOwnProperty.call(current, localKey)) {
            delete result[outputKey];
        } else {
            result[outputKey] = cloneValue(transformed[outputKey]);
        }
    }
    return result;
}

function restoreIntentTarget(intent: SaveIntent, wire: Record<string, unknown>): void {
    const desired = localValue(intent.file, intent.desiredWire);
    const restored = localValue(intent.file, wire);
    const keys = new Set([...Object.keys(desired), ...Object.keys(restored)]);
    keys.delete('Revision');
    keys.delete('revision');
    for (const key of keys) {
        // Retain a later edit which happened while this request was in flight.
        if (!sameValue(intent.target[key], desired[key])) continue;
        if (Object.prototype.hasOwnProperty.call(restored, key)) {
            intent.target[key] = cloneValue(restored[key]);
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

async function isActorAdministrator(actor: IdentityContext): Promise<boolean> {
    if (!JC.identity.isCurrent(actor)) {
        throw stalePanelError();
    }
    try {
        // Resolve privilege from Jellyfin for this authenticated session. Never
        // use target settings' IsAdmin field—or a mutable cached global—as the
        // client-side authorization decision. The server policy remains the
        // independent enforcement boundary.
        const user = await ApiClient.getCurrentUser() as {
            Id?: unknown;
            Policy?: { IsAdministrator?: boolean };
        } | null;
        if (!JC.identity.isCurrent(actor)) {
            throw stalePanelError();
        }
        return normalizeId(user?.Id) === normalizeId(actor.userId)
            && user?.Policy?.IsAdministrator === true;
    } catch (error) {
        if (!JC.identity.isCurrent(actor)) {
            throw stalePanelError(error);
        }
        throw classifyError(error);
    }
}

function adminPath(targetUserId: string, suffix: string): string {
    return `/admin/user-settings/${encodeURIComponent(targetUserId)}/${suffix}`;
}

/** Backward-compatible self editor for independently wired legacy/test panes. */
export function createSelfPanelEditorContext(actor: IdentityContext): PanelEditorContext {
    const settings: UserSettings = JC.currentSettings || {};
    const shortcuts = (JC.userConfig?.shortcuts || { Shortcuts: [] }) as Record<string, unknown>;
    if (!Array.isArray(shortcuts.Shortcuts)) shortcuts.Shortcuts = [];
    return {
        mode: 'self',
        actor,
        targetUserId: normalizeId(actor.userId),
        targetDisplayName: '',
        appliesToActor: true,
        settings,
        shortcuts,
        activeShortcuts: JC.state?.activeShortcuts || {},
        isCurrent: () => JC.identity.isCurrent(actor),
        saveSettings: () => JC.saveUserSettings!('settings.json', settings),
        saveShortcuts: () => JC.saveUserSettings!('shortcuts.json', shortcuts),
    };
}

async function pluginRequest(
    path: string,
    signal: AbortSignal,
    options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<unknown> {
    if (!JC.core.api?.plugin) {
        throw new AdminTargetPersistenceError('The Canopy request client is unavailable.', {
            kind: 'unavailable',
            retryable: true,
        });
    }
    return JC.core.api.plugin(path, {
        ...options,
        signal,
        skipCache: true,
        skipRetry: true,
    });
}

/**
 * Build a panel editor after the click-time route/view and actor fences have
 * been captured.  `isLaunchCurrent` must remain true for the editor lifetime.
 */
export async function createPanelEditorContext(options: {
    actor: IdentityContext;
    requestedTargetUserId?: string | null;
    signal: AbortSignal;
    isLaunchCurrent: () => boolean;
}): Promise<PanelEditorContext> {
    const { actor, signal, isLaunchCurrent } = options;
    const requestedTarget = normalizeId(options.requestedTargetUserId);
    const isAdminTarget = !!requestedTarget && requestedTarget !== normalizeId(actor.userId);
    const liveActorMatches = (): boolean => {
        try {
            const liveServerId = liveTargetServerId();
            return normalizeId(ApiClient.getCurrentUserId()) === normalizeId(actor.userId)
                && isResolvedTargetServer(actor.serverId)
                && isResolvedTargetServer(liveServerId)
                && normalizeId(liveServerId) === normalizeId(actor.serverId);
        } catch {
            return false;
        }
    };
    const isCurrent = () => !signal.aborted
        && JC.identity.isCurrent(actor)
        && isLaunchCurrent()
        && (!isAdminTarget || liveActorMatches());

    if (!requestedTarget || requestedTarget === normalizeId(actor.userId)) {
        if (!isCurrent()) {
            throw stalePanelError();
        }
        const editor = createSelfPanelEditorContext(actor);
        return { ...editor, isCurrent };
    }

    if (!liveActorMatches()) {
        throw new AdminTargetPersistenceError(
            'The live Jellyfin session does not match the settings panel actor.',
            { kind: 'authorization', status: 403 },
        );
    }
    const actorIsAdministrator = await isActorAdministrator(actor);
    if (!isCurrent()) {
        throw stalePanelError();
    }
    if (!actorIsAdministrator) {
        throw new AdminTargetPersistenceError(
            'The active user is not authorized to edit another user.',
            { kind: 'authorization', status: 403 },
        );
    }

    let settingsRaw: unknown;
    let shortcutsRaw: unknown;
    try {
        [settingsRaw, shortcutsRaw] = await Promise.all([
            pluginRequest(adminPath(requestedTarget, `settings.json?_=${Date.now()}`), signal),
            pluginRequest(adminPath(requestedTarget, `shortcuts.json?_=${Date.now()}`), signal),
        ]);
    } catch (error) {
        if (!isCurrent()) {
            throw stalePanelError(error);
        }
        throw classifyError(error);
    }
    if (!isCurrent()) {
        throw stalePanelError();
    }

    const settingsEnvelope = parseEnvelope(settingsRaw, 'settings.json', requestedTarget, false);
    const shortcutsEnvelope = parseEnvelope(shortcutsRaw, 'shortcuts.json', requestedTarget, false);
    if (settingsEnvelope.targetDisplayName !== shortcutsEnvelope.targetDisplayName) {
        throw new AdminTargetPersistenceError('Target identity metadata did not match across user files.', {
            kind: 'protocol',
        });
    }

    const pluginDefaults = cloneRecord(JC.pluginConfig || {});
    const localSettingsFile = localValue('settings.json', settingsEnvelope.data);
    const settings = resolveTargetSettings(
        localSettingsFile,
        pluginDefaults,
    ) as Record<string, unknown>;
    const shortcuts = localValue('shortcuts.json', shortcutsEnvelope.data);
    const activeShortcuts = resolveTargetShortcuts(pluginDefaults, shortcuts);
    const targets: Record<PanelUserFile, Record<string, unknown>> = {
        'settings.json': settings,
        'shortcuts.json': shortcuts,
    };
    const queues: Record<PanelUserFile, FileQueue> = {
        'settings.json': {
            running: false,
            active: null,
            pending: null,
            latestSeq: 0,
            acknowledged: cloneRecord(settingsEnvelope.data),
            acknowledgedHash: settingsEnvelope.contentHash,
            conflictFence: false,
            releaseSafetyHold: null,
        },
        'shortcuts.json': {
            running: false,
            active: null,
            pending: null,
            latestSeq: 0,
            acknowledged: cloneRecord(shortcutsEnvelope.data),
            acknowledgedHash: shortcutsEnvelope.contentHash,
            conflictFence: false,
            releaseSafetyHold: null,
        },
    };
    let sequence = 0;

    const readEvidence = async (file: PanelUserFile): Promise<AdminFileEnvelope> => {
        const raw = await pluginRequest(
            adminPath(requestedTarget, `${encodeURIComponent(file)}/evidence?_=${Date.now()}`),
            signal,
        );
        if (!isCurrent()) {
            throw stalePanelError();
        }
        return parseEnvelope(raw, file, requestedTarget, false);
    };

    const postCandidate = async (
        file: PanelUserFile,
        candidate: Record<string, unknown>,
    ): Promise<AdminFileEnvelope> => {
        const revision = revisionOf(candidate);
        if (revision === null) {
            throw new AdminTargetPersistenceError('Target settings revision is missing.', {
                kind: 'validation',
            });
        }
        let raw: unknown;
        try {
            raw = await pluginRequest(adminPath(requestedTarget, file), signal, {
                method: 'POST',
                body: candidate,
                headers: { 'If-Match': `"${revision}"` },
            });
        } catch (error) {
            throw classifyError(error, file, requestedTarget);
        }
        const envelope = parseEnvelope(raw, file, requestedTarget, true);
        if (!sameContent(envelope.data, candidate)) {
            throw new AdminTargetPersistenceError(
                'The server acknowledged different target user settings content.',
                { kind: 'protocol', ambiguous: true },
            );
        }
        return envelope;
    };

    const executeIntent = async (intent: SaveIntent): Promise<AdminFileEnvelope> => {
        if (!isCurrent()) {
            throw stalePanelError();
        }
        const queue = queues[intent.file];
        if (queue.conflictFence) {
            throw new AdminTargetPersistenceError('Reload before saving this target file again.', {
                kind: 'conflict',
                status: 409,
            });
        }

        let candidate = cloneRecord(intent.desiredWire);
        if (!intent.baseWire || revisionOf(intent.baseWire) === null) {
            const evidence = await readEvidence(intent.file);
            intent.baseWire = evidence.data;
            candidate.Revision = evidence.revision;
            delete candidate.revision;
        }
        const baseRevision = intent.baseWire ? revisionOf(intent.baseWire) : null;
        if (revisionOf(candidate) === null && baseRevision !== null) candidate.Revision = baseRevision;
        if (revisionOf(candidate) === null) {
            throw new AdminTargetPersistenceError('Server evidence omitted the target revision.', {
                kind: 'protocol',
            });
        }

        let lastAuthoritative: Record<string, unknown> | undefined;
        for (let attempt = 0; attempt < 5; attempt++) {
            try {
                return await postCandidate(intent.file, candidate);
            } catch (rawError) {
                const error = classifyError(rawError);
                if (!isCurrent()) throw error;
                if (error.ambiguous) {
                    try {
                        const evidence = await readEvidence(intent.file);
                        if (sameContent(evidence.data, candidate)) return evidence;
                        if (evidence.revision === revisionOf(candidate) && attempt === 0) continue;
                        throw new AdminTargetPersistenceError(
                            'The target save outcome is uncertain; reload before retrying.',
                            {
                                kind: 'conflict',
                                status: 409,
                                ambiguous: true,
                                authoritative: evidence.data,
                                cause: error,
                            },
                        );
                    } catch (evidenceError) {
                        if (evidenceError instanceof AdminTargetPersistenceError
                            && (evidenceError.kind === 'conflict'
                                || evidenceError.kind === 'cancelled'
                                || (evidenceError.kind === 'unavailable' && evidenceError.ambiguous))) {
                            throw evidenceError;
                        }
                        throw new AdminTargetPersistenceError(
                            'The target save outcome could not be verified.',
                            {
                                kind: 'unavailable',
                                retryable: true,
                                ambiguous: true,
                                cause: evidenceError,
                            },
                        );
                    }
                }
                if (error.kind !== 'conflict' || !error.authoritative) throw error;
                lastAuthoritative = error.authoritative;
                if (sameContent(error.authoritative, candidate)) {
                    const evidence = await readEvidence(intent.file);
                    if (sameContent(evidence.data, candidate)) return evidence;
                }
                const rebased = safeRebase(intent.baseWire, intent.desiredWire, error.authoritative);
                if (!rebased) throw error;
                candidate = rebased;
            }
        }
        throw new AdminTargetPersistenceError('Target settings kept changing; reload and retry.', {
            kind: 'conflict',
            status: 409,
            retryable: true,
            authoritative: lastAuthoritative,
        });
    };

    const drain = async (file: PanelUserFile): Promise<void> => {
        const queue = queues[file];
        if (queue.running) return;
        queue.running = true;
        try {
            while (queue.pending) {
                const intent = queue.pending;
                queue.pending = null;
                queue.active = intent;
                try {
                    const acknowledgement = await executeIntent(intent);
                    if (!isCurrent()) {
                        throw stalePanelError();
                    }
                    queue.acknowledged = cloneRecord(acknowledgement.data);
                    queue.acknowledgedHash = acknowledgement.contentHash;
                    const pending = currentPending(queue);
                    if (pending) {
                        const rebased = safeRebase(
                            pending.baseWire,
                            pending.desiredWire,
                            acknowledgement.data,
                        );
                        if (rebased) {
                            pending.baseWire = cloneRecord(acknowledgement.data);
                            pending.desiredWire = rebased;
                            pending.serialized = canonical(withoutRevision(rebased));
                        }
                    }
                    restoreIntentTarget(intent, acknowledgement.data);
                    intent.waiters.forEach(waiter => waiter.resolve({
                        acknowledged: true,
                        deduplicated: false,
                        file,
                        revision: acknowledgement.revision,
                        contentHash: acknowledgement.contentHash,
                    }));
                } catch (rawError) {
                    const error = classifyError(rawError);
                    intent.waiters.forEach(waiter => waiter.reject(error));
                    const pending = currentPending(queue);
                    if (pending) {
                        pending.baseWire = cloneRecord(queue.acknowledged);
                        const revision = revisionOf(queue.acknowledged);
                        if (revision !== null) {
                            pending.desiredWire.Revision = revision;
                            delete pending.desiredWire.revision;
                        }
                    }
                    if (!currentPending(queue) && queue.latestSeq === intent.seq) {
                        if (error.kind === 'conflict' || error.ambiguous) queue.conflictFence = true;
                        const rollback = error.authoritative || queue.acknowledged;
                        // This editor is panel-local, so even an uncertain
                        // transport outcome can safely return its controls to
                        // the last server-evidenced snapshot and fence further
                        // writes until a fresh open. It never claims that the
                        // remote outcome was absent.
                        if (rollback) restoreIntentTarget(intent, rollback);
                    }
                    if (error.kind !== 'cancelled' && isCurrent()) {
                        document.dispatchEvent(new CustomEvent('jc:admin-target-settings-save-error', {
                            detail: {
                                file,
                                kind: error.kind,
                                status: error.status,
                                retryable: error.retryable,
                                ambiguous: error.ambiguous,
                            },
                        }));
                    }
                } finally {
                    queue.active = null;
                }
            }
        } finally {
            queue.running = false;
            queue.releaseSafetyHold?.();
            queue.releaseSafetyHold = null;
        }
    };

    const save = (file: PanelUserFile): Promise<UserSettingsSaveResult> => {
        try {
            if (!isCurrent()) {
                throw stalePanelError();
            }
            const queue = queues[file];
            if (queue.conflictFence) {
                throw new AdminTargetPersistenceError(
                    'Reload before saving this target file again.',
                    { kind: 'conflict', status: 409 },
                );
            }
            const target = targets[file];
            const desiredWire = file === 'settings.json'
                ? mergeChangedSettingsWire(target, queue.acknowledged, pluginDefaults)
                : wireValue(file, target);
            const revision = revisionOf(queue.acknowledged);
            if (revision === null) {
                throw new AdminTargetPersistenceError('Target settings revision is missing.', {
                    kind: 'protocol',
                });
            }
            desiredWire.Revision = revision;
            delete desiredWire.revision;
            const serialized = canonical(withoutRevision(desiredWire));
            if (!queue.active && !queue.pending
                && sameContent(queue.acknowledged, desiredWire)
                && queue.acknowledgedHash) {
                return Promise.resolve({
                    acknowledged: true,
                    deduplicated: true,
                    file,
                    revision,
                    contentHash: queue.acknowledgedHash,
                });
            }
            return new Promise<UserSettingsSaveResult>((resolve, reject) => {
                const waiter = { resolve, reject };
                if (queue.active?.serialized === serialized) {
                    if (queue.pending) {
                        queue.active.waiters.push(...queue.pending.waiters);
                        queue.pending = null;
                        queue.latestSeq = queue.active.seq;
                    }
                    queue.active.waiters.push(waiter);
                    return;
                }
                if (queue.pending?.serialized === serialized) {
                    queue.pending.waiters.push(waiter);
                    return;
                }
                const intent: SaveIntent = {
                    seq: ++sequence,
                    file,
                    target,
                    baseWire: cloneRecord(queue.acknowledged),
                    desiredWire,
                    serialized,
                    waiters: queue.pending ? [...queue.pending.waiters, waiter] : [waiter],
                };
                queue.pending = intent;
                queue.latestSeq = intent.seq;
                queue.releaseSafetyHold ??= JC.core.refreshSafety?.acquireHold('settings-write') || null;
                void drain(file);
            });
        } catch (error) {
            return Promise.reject(classifyError(error));
        }
    };

    return {
        mode: 'admin-target',
        actor,
        targetUserId: requestedTarget,
        targetDisplayName: settingsEnvelope.targetDisplayName,
        appliesToActor: false,
        settings,
        shortcuts,
        activeShortcuts,
        isCurrent,
        saveSettings: () => save('settings.json'),
        saveShortcuts: () => save('shortcuts.json'),
    };
}
