const MAX_COLLECTIONS = 500;
const MAX_CONTENT_ITEMS = 50;
const MAX_RECORD_ENTRIES = 50;
const MAX_TEXT_LENGTH = 300;
const MAX_HREF_LENGTH = 2048;
const MAX_COLLECTION_MEDIA_COUNT = 1_000_000;
const MAX_HANDLED_MEDIA_COUNT = 100_000_000;
const MAX_RETENTION_DAYS = 36_500;
const MAX_RULE_COUNT = 100_000;
const MAX_CONTENT_TOTAL = 1_000_000;
const MAX_INT32 = 2_147_483_647;
const MEDIA_TYPES = new Set(['movie', 'show', 'season', 'episode'] as const);
const SECTION_STATES = new Set(['available', 'partial', 'unsupported', 'unavailable'] as const);
const OVERLAY_STATUSES = new Set(['idle', 'running', 'error'] as const);
const IDENTITY_WARNINGS = new Set(['identity_mismatch', 'identity_unknown'] as const);
const ERROR_CODES = new Set([
    'invalid_configuration',
    'blocked_target',
    'response_too_large',
    'too_large',
    'malformed_body',
    'configuration_changed',
    'identity_mismatch',
    'wrong_service',
    'not_ready',
    'throttled',
    'upstream_error',
    'unsupported',
    'redirect',
    'canceled',
    'timeout',
    'disabled',
    'unavailable',
] as const);

export type MaintainerrMediaType = 'movie' | 'show' | 'season' | 'episode';
export type MaintainerrSectionState = 'available' | 'partial' | 'unsupported' | 'unavailable';
export type MaintainerrOverlayStatus = 'idle' | 'running' | 'error';
export type MaintainerrIdentityWarning = 'identity_mismatch' | 'identity_unknown';
export type MaintainerrErrorCode =
    | 'invalid_configuration'
    | 'blocked_target'
    | 'response_too_large'
    | 'too_large'
    | 'malformed_body'
    | 'configuration_changed'
    | 'identity_mismatch'
    | 'wrong_service'
    | 'not_ready'
    | 'throttled'
    | 'upstream_error'
    | 'unsupported'
    | 'redirect'
    | 'canceled'
    | 'timeout'
    | 'disabled'
    | 'unavailable';

export interface MaintainerrStatus {
    ready: boolean;
    degraded: boolean;
    version: string;
    jellyfinMode: boolean;
    capable: boolean;
    identityMatch: boolean;
    identityWarning?: MaintainerrIdentityWarning;
    error?: MaintainerrErrorCode;
}

export interface MaintainerrCollectionSummary {
    id: number;
    title: string;
    type: MaintainerrMediaType;
    isActive: boolean;
    mediaCount: number;
    deleteAfterDays?: number;
    manualCollection: boolean;
    handledMediaAmount: number;
    lastDurationInSeconds: number;
    totalSizeBytes?: number;
    handledMediaSizeBytes: number;
    href?: string;
}

export interface MaintainerrStorage {
    state: Exclude<MaintainerrSectionState, 'partial'>;
    error?: MaintainerrErrorCode;
    generatedAt?: string;
    collectionSummary?: MaintainerrCollectionStorageSummary;
    cleanupTotals?: MaintainerrCleanupTotals;
    reclaimableUsingFallback?: boolean;
}

export interface MaintainerrCollectionStorageSummary {
    reclaimableCount: number;
    activeSizeBytes: number;
    reclaimableSizedCount: number;
    inactiveCount: number;
    totalCollectionCount: number;
    movieSizeBytes: number;
    showSizeBytes: number;
    seasonSizeBytes: number;
    episodeSizeBytes: number;
    reclaimableMovieCount: number;
    reclaimableShowCount: number;
    reclaimableSeasonCount: number;
    reclaimableEpisodeCount: number;
}

export interface MaintainerrCleanupTotals {
    itemsHandled: number;
    moviesHandled: number;
    showsHandled: number;
    seasonsHandled: number;
    episodesHandled: number;
    bytesHandled: number;
    movieBytesHandled: number;
    showBytesHandled: number;
    seasonBytesHandled: number;
    episodeBytesHandled: number;
}

export interface MaintainerrRules {
    state: MaintainerrSectionState;
    error?: MaintainerrErrorCode;
    count?: number;
    processingQueue?: boolean;
    executing?: boolean;
    pendingCount?: number;
    queueCount?: number;
}

export interface MaintainerrOverlays {
    state: Exclude<MaintainerrSectionState, 'partial'>;
    error?: MaintainerrErrorCode;
    status?: MaintainerrOverlayStatus;
    lastRun?: string;
}

export interface MaintainerrLinks {
    overview?: string;
    rules?: string;
    storageMetrics?: string;
}

export interface MaintainerrDashboard {
    status: MaintainerrStatus;
    collections: MaintainerrCollectionSummary[];
    storage: MaintainerrStorage;
    rules: MaintainerrRules;
    overlays: MaintainerrOverlays;
    links?: MaintainerrLinks;
}

export interface MaintainerrCollectionItem {
    id: number;
    title: string;
    type: MaintainerrMediaType;
    href?: string;
}

export interface MaintainerrCollectionContent {
    page: number;
    size: number;
    totalSize: number;
    items: MaintainerrCollectionItem[];
}

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonObject
        : null;
}

function boundedText(
    value: unknown,
    allowEmpty = false,
    maximumLength = MAX_TEXT_LENGTH,
): string | null {
    if (typeof value !== 'string'
        || value.length > maximumLength
        || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return null;
    const parsed = value.trim();
    return parsed || allowEmpty ? parsed : null;
}

function finiteNumber(
    value: unknown,
    minimum = 0,
    maximum = Number.MAX_SAFE_INTEGER,
): number | null {
    return typeof value === 'number'
        && Number.isFinite(value)
        && value >= minimum
        && value <= maximum
        ? value
        : null;
}

function integer(
    value: unknown,
    minimum = 0,
    maximum = Number.MAX_SAFE_INTEGER,
): number | null {
    const parsed = finiteNumber(value, minimum, maximum);
    return parsed !== null && Number.isSafeInteger(parsed) ? parsed : null;
}

function optionalNumber(
    value: unknown,
    maximum = Number.MAX_SAFE_INTEGER,
): number | undefined | null {
    return value === undefined || value === null ? undefined : integer(value, 0, maximum);
}

/**
 * The server canonicalizes every accepted timestamp with DateTimeOffset's
 * round-trip ("O") formatter before publication. Requiring that exact
 * downstream shape keeps arbitrary date-like strings from reaching the UI.
 */
function optionalIsoTimestamp(value: unknown): string | undefined | null {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string' || value.length > 64) return null;
    const match = value.match(
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{7})([+-])(\d{2}):(\d{2})$/,
    );
    if (!match || !Number.isFinite(Date.parse(value))) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    const offsetHour = Number(match[9]);
    const offsetMinute = Number(match[10]);
    if (year < 1
        || offsetHour > 14
        || offsetMinute > 59
        || (offsetHour === 14 && offsetMinute !== 0)) return null;
    const calendar = new Date(0);
    calendar.setUTCFullYear(year, month - 1, day);
    calendar.setUTCHours(hour, minute, second, 0);
    if (calendar.getUTCFullYear() !== year
        || calendar.getUTCMonth() !== month - 1
        || calendar.getUTCDate() !== day
        || calendar.getUTCHours() !== hour
        || calendar.getUTCMinutes() !== minute
        || calendar.getUTCSeconds() !== second) return null;
    return value;
}

function optionalBoolean(value: unknown): boolean | undefined | null {
    return value === undefined || value === null
        ? undefined
        : typeof value === 'boolean' ? value : null;
}

function optionalEnum<T extends string>(
    value: unknown,
    values: ReadonlySet<T>,
): T | undefined | null {
    if (value === undefined || value === null) return undefined;
    return typeof value === 'string' && values.has(value as T) ? value as T : null;
}

function numberRecord<const K extends string>(
    value: unknown,
    keys: readonly K[],
): Partial<Record<K, number>> | undefined | null {
    if (value === undefined || value === null) return undefined;
    const object = objectValue(value);
    if (!object) return null;
    const result: Partial<Record<K, number>> = {};
    for (const key of keys.slice(0, MAX_RECORD_ENTRIES)) {
        if (!Object.prototype.hasOwnProperty.call(object, key)) continue;
        const parsed = integer(object[key]);
        if (parsed === null) return null;
        result[key] = parsed;
    }
    return Object.keys(result).length > 0 ? result : undefined;
}

function parseStatus(value: unknown): MaintainerrStatus | null {
    const object = objectValue(value);
    if (!object
        || typeof object.ready !== 'boolean'
        || typeof object.degraded !== 'boolean'
        || typeof object.jellyfinMode !== 'boolean'
        || typeof object.capable !== 'boolean'
        || typeof object.identityMatch !== 'boolean') return null;
    const version = boundedText(object.version, true, 80);
    const identityWarning = optionalEnum(object.identityWarning, IDENTITY_WARNINGS);
    const error = optionalEnum(object.error, ERROR_CODES);
    if (version === null
        || identityWarning === null
        || error === null
        || (object.identityMatch && identityWarning !== undefined)
        || (!object.identityMatch && identityWarning === undefined)) return null;
    return {
        ready: object.ready,
        degraded: object.degraded,
        version,
        jellyfinMode: object.jellyfinMode,
        capable: object.capable,
        identityMatch: object.identityMatch,
        identityWarning,
        error,
    };
}

function parseCollection(value: unknown): MaintainerrCollectionSummary | null {
    const object = objectValue(value);
    if (!object
        || typeof object.isActive !== 'boolean'
        || typeof object.manualCollection !== 'boolean') return null;
    const id = integer(object.id, 1, MAX_INT32);
    const mediaCount = integer(object.mediaCount, 0, MAX_COLLECTION_MEDIA_COUNT);
    if (id === null || mediaCount === null) return null;
    const title = boundedText(object.title);
    const type = boundedText(object.type);
    if (!title || !type || !MEDIA_TYPES.has(type as MaintainerrMediaType)) return null;
    const deleteAfterDays = optionalNumber(object.deleteAfterDays, MAX_RETENTION_DAYS);
    const handledMediaAmount = integer(object.handledMediaAmount, 0, MAX_HANDLED_MEDIA_COUNT);
    const lastDurationInSeconds = integer(object.lastDurationInSeconds, 0, MAX_INT32);
    const totalSizeBytes = optionalNumber(object.totalSizeBytes);
    const handledMediaSizeBytes = integer(object.handledMediaSizeBytes);
    const href = optionalAbsoluteHref(object.href);
    if (deleteAfterDays === null
        || handledMediaAmount === null
        || lastDurationInSeconds === null
        || totalSizeBytes === null
        || handledMediaSizeBytes === null
        || (object.href !== undefined && object.href !== null && !href)) return null;
    return {
        id,
        title,
        type: type as MaintainerrMediaType,
        isActive: object.isActive,
        mediaCount,
        deleteAfterDays,
        manualCollection: object.manualCollection,
        handledMediaAmount,
        lastDurationInSeconds,
        totalSizeBytes,
        handledMediaSizeBytes,
        href,
    };
}

function parseStorage(value: unknown): MaintainerrStorage | null {
    const object = objectValue(value);
    if (!object) return null;
    const generatedAt = optionalIsoTimestamp(object.generatedAt);
    const state = optionalEnum(object.state, SECTION_STATES);
    const error = optionalEnum(object.error, ERROR_CODES);
    const reclaimableUsingFallback = optionalBoolean(object.reclaimableUsingFallback);
    if (!state
        || state === 'partial'
        || generatedAt === null
        || error === null
        || reclaimableUsingFallback === null) return null;
    const collectionSummary = numberRecord(object.collectionSummary, [
        'reclaimableCount',
        'activeSizeBytes',
        'reclaimableSizedCount',
        'inactiveCount',
        'totalCollectionCount',
        'movieSizeBytes',
        'showSizeBytes',
        'seasonSizeBytes',
        'episodeSizeBytes',
        'reclaimableMovieCount',
        'reclaimableShowCount',
        'reclaimableSeasonCount',
        'reclaimableEpisodeCount',
    ]);
    const cleanupTotals = numberRecord(object.cleanupTotals, [
        'itemsHandled',
        'moviesHandled',
        'showsHandled',
        'seasonsHandled',
        'episodesHandled',
        'bytesHandled',
        'movieBytesHandled',
        'showBytesHandled',
        'seasonBytesHandled',
        'episodeBytesHandled',
    ]);
    if (collectionSummary === null || cleanupTotals === null) return null;
    if (state === 'available'
        && (error !== undefined
            || generatedAt === undefined
            || collectionSummary === undefined
            || Object.keys(collectionSummary).length !== 13
            || cleanupTotals === undefined
            || Object.keys(cleanupTotals).length !== 10
            || reclaimableUsingFallback === undefined)) return null;
    if (state !== 'available'
        && (error === undefined
            || generatedAt !== undefined
            || collectionSummary !== undefined
            || cleanupTotals !== undefined
            || reclaimableUsingFallback !== undefined)) return null;
    return {
        state,
        ...(error !== undefined ? { error } : {}),
        ...(generatedAt !== undefined ? { generatedAt } : {}),
        ...(collectionSummary !== undefined
            ? { collectionSummary: collectionSummary as MaintainerrCollectionStorageSummary }
            : {}),
        ...(cleanupTotals !== undefined
            ? { cleanupTotals: cleanupTotals as MaintainerrCleanupTotals }
            : {}),
        ...(reclaimableUsingFallback !== undefined ? { reclaimableUsingFallback } : {}),
    };
}

function parseRules(value: unknown): MaintainerrRules | null {
    const object = objectValue(value);
    if (!object) return null;
    const state = optionalEnum(object.state, SECTION_STATES);
    const error = optionalEnum(object.error, ERROR_CODES);
    const count = optionalNumber(object.count, MAX_RULE_COUNT);
    const processingQueue = optionalBoolean(object.processingQueue);
    const executing = optionalBoolean(object.executing);
    const pendingCount = optionalNumber(object.pendingCount, MAX_COLLECTIONS);
    const queueCount = optionalNumber(object.queueCount, MAX_COLLECTIONS);
    if (!state
        || error === null
        || count === null
        || processingQueue === null
        || executing === null
        || pendingCount === null
        || queueCount === null) return null;
    const executionValues = [processingQueue, executing, pendingCount, queueCount];
    const executionPresent = executionValues.every((entry) => entry !== undefined);
    const executionAbsent = executionValues.every((entry) => entry === undefined);
    if (state === 'available' && (error !== undefined || count === undefined || !executionPresent)) return null;
    if ((state === 'unavailable' || state === 'unsupported')
        && (error === undefined || count !== undefined || !executionAbsent)) return null;
    if (state === 'partial'
        && (error === undefined
            || (count === undefined && executionAbsent)
            || (count !== undefined && executionPresent)
            || (!executionPresent && !executionAbsent))) return null;
    return {
        state,
        ...(error !== undefined ? { error } : {}),
        ...(count !== undefined ? { count } : {}),
        ...(processingQueue !== undefined ? { processingQueue } : {}),
        ...(executing !== undefined ? { executing } : {}),
        ...(pendingCount !== undefined ? { pendingCount } : {}),
        ...(queueCount !== undefined ? { queueCount } : {}),
    };
}

function parseOverlays(value: unknown): MaintainerrOverlays | null {
    const object = objectValue(value);
    if (!object) return null;
    const state = optionalEnum(object.state, SECTION_STATES);
    const error = optionalEnum(object.error, ERROR_CODES);
    const status = optionalEnum(object.status, OVERLAY_STATUSES);
    const lastRun = optionalIsoTimestamp(object.lastRun);
    if (!state
        || state === 'partial'
        || error === null
        || status === null
        || lastRun === null) return null;
    if (state === 'available' && (error !== undefined || status === undefined)) return null;
    if (state !== 'available'
        && (error === undefined || status !== undefined || lastRun !== undefined)) return null;
    return {
        state,
        ...(error !== undefined ? { error } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(lastRun !== undefined ? { lastRun } : {}),
    };
}

function parseLinks(value: unknown): MaintainerrLinks | undefined | null {
    if (value === undefined || value === null) return undefined;
    const object = objectValue(value);
    if (!object) return null;
    const overview = optionalAbsoluteHref(object.overview);
    const rules = optionalAbsoluteHref(object.rules);
    const storageMetrics = optionalAbsoluteHref(object.storageMetrics);
    if ((object.overview !== undefined && object.overview !== null && !overview)
        || (object.rules !== undefined && object.rules !== null && !rules)
        || (object.storageMetrics !== undefined && object.storageMetrics !== null && !storageMetrics)) return null;
    return {
        overview,
        rules,
        storageMetrics,
    };
}

/** Parse the bounded, server-sanitized admin dashboard DTO. */
export function parseMaintainerrDashboard(value: unknown): MaintainerrDashboard | null {
    const object = objectValue(value);
    if (!object
        || !Array.isArray(object.collections)
        || object.collections.length > MAX_COLLECTIONS) return null;
    const status = parseStatus(object.status);
    const storage = parseStorage(object.storage);
    const rules = parseRules(object.rules);
    const overlays = parseOverlays(object.overlays);
    if (!status || !storage || !rules || !overlays) return null;
    const links = parseLinks(object.links);
    if (links === null) return null;
    const collections = object.collections.map(parseCollection);
    if (collections.some((entry) => entry === null)) return null;
    return {
        status,
        storage,
        rules,
        overlays,
        collections: collections as MaintainerrCollectionSummary[],
        links,
    };
}

/** Parse one bounded collection-content page. */
export function parseMaintainerrCollectionContent(value: unknown): MaintainerrCollectionContent | null {
    const object = objectValue(value);
    if (!object
        || !Array.isArray(object.items)
        || object.items.length > MAX_CONTENT_ITEMS) return null;
    const page = integer(object.page, 1, MAX_INT32);
    const size = integer(object.size, 1);
    const totalSize = integer(object.totalSize, 0, MAX_CONTENT_TOTAL);
    if (page === null || size === null || size > MAX_CONTENT_ITEMS || totalSize === null) return null;
    const offset = (page - 1) * size;
    if (!Number.isSafeInteger(offset)
        || object.items.length > size
        || object.items.length > totalSize
        || (totalSize === 0 && (page !== 1 || object.items.length !== 0))
        || (totalSize > 0
            && (offset >= totalSize
                || object.items.length === 0
                || object.items.length > totalSize - offset))) return null;
    const items = object.items.map((raw): MaintainerrCollectionItem | null => {
        const item = objectValue(raw);
        if (!item) return null;
        const id = integer(item.id, 1, MAX_INT32);
        const title = boundedText(item.title);
        const type = boundedText(item.type);
        if (id === null || !title || !type || !MEDIA_TYPES.has(type as MaintainerrMediaType)) return null;
        const href = optionalHref(item.href);
        if (item.href !== undefined && item.href !== null && !href) return null;
        return {
            id,
            title,
            type: type as MaintainerrMediaType,
            href,
        };
    });
    if (items.some((entry) => entry === null)) return null;
    return { page, size, totalSize, items: items as MaintainerrCollectionItem[] };
}

/**
 * Accept only bounded HTTP(S) links or rooted paths. The server is the primary
 * allowlist owner; this use-time check prevents a malformed DTO from creating a
 * javascript:/credential-bearing link.
 */
export function optionalHref(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const raw = value.trim();
    if (!raw
        || raw.length > MAX_HREF_LENGTH
        || /[\u0000-\u001f\u007f-\u009f\\?#]/.test(raw)
        || /%(?:2e|2f|5c|25)/i.test(raw)) return undefined;
    const isRooted = raw.startsWith('/') && !raw.startsWith('//');
    const isAbsoluteHttp = /^https?:\/\//i.test(raw);
    if (!isRooted && !isAbsoluteHttp) return undefined;
    try {
        const rawPath = isRooted
            ? raw
            : raw.replace(/^https?:\/\/[^/]+/i, '') || '/';
        if (rawPath.split('/').some((segment) => segment === '.' || segment === '..')) return undefined;
        const parsed = new URL(raw, window.location.origin);
        if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
            || parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
        const approvedTail = /\/(?:collections\/[1-9][0-9]*(?:\/exclusions)?|rules|overview|storage-metrics)\/?$/;
        if (!approvedTail.test(parsed.pathname)) return undefined;
        const rootedApproved = /^\/(?:collections\/[1-9][0-9]*(?:\/exclusions)?|rules|overview|storage-metrics)\/?$/;
        if (isRooted && !rootedApproved.test(parsed.pathname)) return undefined;
        return isRooted
            ? parsed.pathname
            : parsed.href;
    } catch {
        return undefined;
    }
}

/** Dashboard links are resolved server-side and must therefore be absolute. */
function optionalAbsoluteHref(value: unknown): string | undefined {
    const href = optionalHref(value);
    return href && /^https?:\/\//i.test(href) ? href : undefined;
}
