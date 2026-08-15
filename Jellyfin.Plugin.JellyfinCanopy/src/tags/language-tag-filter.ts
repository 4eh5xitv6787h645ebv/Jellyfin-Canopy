import { resolveMediaLanguage, resolveMediaLanguageIdentities } from '../core/media-language';
import type { MediaLanguageIdentity } from '../core/media-language';
import { JC } from '../globals';

export const LANGUAGE_TAG_FILTER_SCHEMA_VERSION = 1;
export const MAX_LANGUAGE_TAG_FILTER_ENTRIES = 16;

export interface LanguageTagFilterPolicy {
    schemaVersion: typeof LANGUAGE_TAG_FILTER_SCHEMA_VERSION;
    languages: string[];
    includeOriginal: boolean;
    /** Runtime-only marker; never persisted. */
    failClosed?: true;
}

/** Missing means compatibility mode; malformed state is an active empty policy. */
export function normalizeLanguageTagFilter(value: unknown): LanguageTagFilterPolicy | null {
    if (value === null || value === undefined) return null;
    const failed = (): LanguageTagFilterPolicy => ({
        schemaVersion: LANGUAGE_TAG_FILTER_SCHEMA_VERSION,
        languages: [],
        includeOriginal: false,
        failClosed: true,
    });
    if (!value || typeof value !== 'object' || Array.isArray(value)) return failed();
    const record = value as Record<string, unknown>;
    const schemaVersion = record.schemaVersion ?? record.SchemaVersion;
    const includeOriginal = record.includeOriginal ?? record.IncludeOriginal;
    const rawLanguages = record.languages ?? record.Languages;
    if (schemaVersion !== LANGUAGE_TAG_FILTER_SCHEMA_VERSION
        || typeof includeOriginal !== 'boolean'
        || !Array.isArray(rawLanguages)
        || rawLanguages.length > MAX_LANGUAGE_TAG_FILTER_ENTRIES) return failed();
    const languages: string[] = [];
    for (const raw of rawLanguages) {
        const resolved = resolveMediaLanguage(raw);
        if (resolved.status !== 'valid' || resolved.canonicalTag !== raw || languages.includes(raw)) return failed();
        languages.push(raw);
    }
    return { schemaVersion: LANGUAGE_TAG_FILTER_SCHEMA_VERSION, languages, includeOriginal };
}

export function effectiveLanguageTagFilter(
    userValue: unknown,
    adminValue: unknown,
): LanguageTagFilterPolicy | null {
    return normalizeLanguageTagFilter(userValue === null || userValue === undefined ? adminValue : userValue);
}

/** Apply selection after canonicalization, preserving policy order and explicit regions. */
export function filterMediaLanguageIdentities(
    values: unknown,
    policy: LanguageTagFilterPolicy | null,
    authoritativeOriginal: unknown = null,
): MediaLanguageIdentity[] {
    const identities = resolveMediaLanguageIdentities(values);
    if (policy === null) return identities;
    if (policy.languages.length === 0 && !policy.includeOriginal && policy.failClosed !== true) return identities;
    const byTag = new Map(identities.map((entry) => [entry.canonicalTag, entry]));
    const ordered: MediaLanguageIdentity[] = [];
    const add = (tag: string): void => {
        const identity = byTag.get(tag);
        if (identity && !ordered.some((entry) => entry.canonicalTag === tag)) ordered.push(identity);
    };
    if (policy.includeOriginal) {
        const original = resolveMediaLanguage(authoritativeOriginal);
        if (original.status === 'valid') add(original.canonicalTag);
    }
    policy.languages.forEach(add);
    return ordered;
}

export function languageTagFilterControlsOrder(policy: LanguageTagFilterPolicy | null): boolean {
    return policy !== null
        && (policy.failClosed === true || policy.includeOriginal || policy.languages.length > 0);
}

export function currentLanguageTagFilter(): LanguageTagFilterPolicy | null {
    const user = JC.currentSettings?.languageTagFilter;
    const admin = JC.pluginConfig?.LanguageTagFilter;
    return effectiveLanguageTagFilter(user, admin);
}
