/** Versioned provider identity persisted with hidden-content rows. */
export interface HiddenContentIdentity {
    version: 1;
    provider: 'tmdb';
    mediaType: 'movie' | 'tv';
    id: string;
}

export type HiddenMediaType = HiddenContentIdentity['mediaType'];
export type HiddenIdentityStatus = 'resolved' | 'legacy-unresolved' | 'unsupported' | 'local-only';

export interface HiddenIdentitySource {
    identity?: Partial<HiddenContentIdentity> | null;
    tmdbId?: string | number | null;
    mediaType?: string | null;
    type?: string | null;
}

export const HIDDEN_CONTENT_IDENTITY_VERSION = 1 as const;

export function normalizeHiddenMediaType(value: unknown): HiddenMediaType | null {
    if (typeof value !== 'string') return null;
    switch (value.trim().toLowerCase()) {
        case 'movie': return 'movie';
        case 'tv':
        case 'series': return 'tv';
        default: return null;
    }
}

function normalizeProviderId(value: unknown): string | null {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const id = String(value).trim();
    return /^(?=.*[1-9])\d{1,32}$/.test(id) ? id : null;
}

export function createTmdbIdentity(
    id: string | number | null | undefined,
    mediaType: unknown,
): HiddenContentIdentity | null {
    const normalizedId = normalizeProviderId(id);
    const normalizedType = normalizeHiddenMediaType(mediaType);
    if (!normalizedId || !normalizedType) return null;
    return {
        version: HIDDEN_CONTENT_IDENTITY_VERSION,
        provider: 'tmdb',
        mediaType: normalizedType,
        id: normalizedId,
    };
}

/**
 * Reads a persisted identity, or conservatively upgrades a legacy TMDB row
 * only when its old Type field unambiguously identifies movie versus TV.
 */
export function identityFromSource(source: HiddenIdentitySource | null | undefined): HiddenContentIdentity | null {
    if (!source) return null;
    const identity = source.identity;
    if (identity) {
        if (identity.version === HIDDEN_CONTENT_IDENTITY_VERSION
            && String(identity.provider || '').toLowerCase() === 'tmdb') {
            return createTmdbIdentity(identity.id, identity.mediaType);
        }
        // Unknown or malformed explicit versions are not legacy rows. Leave
        // them unresolved rather than silently downgrading future semantics.
        return null;
    }
    return createTmdbIdentity(source.tmdbId, source.mediaType || source.type);
}

/** Classifies management rows without treating unknown explicit schemas as legacy. */
export function hiddenIdentityStatus(source: HiddenIdentitySource | null | undefined): HiddenIdentityStatus {
    if (identityFromSource(source)) return 'resolved';
    if (source?.identity) return 'unsupported';
    return source?.tmdbId ? 'legacy-unresolved' : 'local-only';
}

export function hiddenIdentityKey(identity: HiddenContentIdentity): string {
    return `hc${identity.version}:${identity.provider}:${identity.mediaType}:${encodeURIComponent(identity.id)}`;
}

export function sameHiddenIdentity(
    left: HiddenContentIdentity | null | undefined,
    right: HiddenContentIdentity | null | undefined,
): boolean {
    return !!left && !!right
        && left.version === right.version
        && left.provider === right.provider
        && left.mediaType === right.mediaType
        && left.id === right.id;
}
