// Shared, import-pure media-language parsing and presentation.
//
// Country flags are national metadata. They are therefore selected only from
// an explicit, assigned ISO 3166-1 alpha-2 region in the media's BCP-47 tag.
// This module never calls Intl.Locale.maximize() and never consults filenames,
// titles, release groups, viewer locale, or likely-subtag data.

/** Maximum well-formed BCP-47 tag length accepted from media metadata. */
const MAX_TAG_LENGTH = 255;

/** Maximum visible neutral token length; the complete tag remains accessible. */
const MAX_NEUTRAL_TOKEN_LENGTH = 12;

/**
 * Assigned ISO 3166-1 alpha-2 codes (ISO Online Browsing Platform, 2026-08).
 * Non-country flag-icons extras (for example EU, UN and XK) are deliberately
 * excluded because this feature presents explicit national regions only.
 */
const ISO_3166_ALPHA2 = new Set(
    ('ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bl bm bn bo bq br bs bt bv bw by bz '
        + 'ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg eh er es et fi fj fk fm fo fr '
        + 'ga gb gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je jm jo jp '
        + 'ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mf mg mh mk ml mm mn mo mp mq mr ms mt '
        + 'mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw '
        + 'sa sb sc sd se sg sh si sj sk sl sm sn so sr ss st sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ua ug '
        + 'um us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw').split(' ')
);

let displayNamesConstructor: typeof Intl.DisplayNames | null = null;
let englishLanguageNames: Intl.DisplayNames | null = null;

/** Parsed language data shared by poster and details consumers. */
export interface ResolvedMediaLanguage {
    canonicalTag: string;
    semanticTag: string;
    language: string | null;
    script: string | null;
    explicitRegion: string | null;
    displayName: string;
    flagRegion: string | null;
    status: 'valid' | 'undetermined' | 'invalid';
}

/** Canonical media identity plus whether its alpha-2 country was trusted. */
export interface MediaLanguageIdentity {
    canonicalTag: string;
    flagRegion: string | null;
}

/** One deterministic poster/details presentation, possibly grouping one flag. */
export interface MediaLanguagePresentation {
    kind: 'flag' | 'neutral';
    flagRegion: string | null;
    token: string;
    canonicalTags: string[];
    displayNames: string[];
    accessibleLabel: string;
}

interface LocaleLike {
    toString(): string;
    readonly baseName: string;
    readonly language?: string;
    readonly script?: string;
    readonly region?: string;
}

function invalidResult(): ResolvedMediaLanguage {
    return {
        canonicalTag: '',
        semanticTag: '',
        language: null,
        script: null,
        explicitRegion: null,
        displayName: '',
        flagRegion: null,
        status: 'invalid',
    };
}

function displayLanguageName(semanticTag: string): string {
    try {
        if (typeof Intl.DisplayNames !== 'function') return semanticTag.toUpperCase();
        if (displayNamesConstructor !== Intl.DisplayNames || !englishLanguageNames) {
            displayNamesConstructor = Intl.DisplayNames;
            englishLanguageNames = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });
        }
        return englishLanguageNames.of(semanticTag) || semanticTag.toUpperCase();
    } catch {
        return semanticTag.toUpperCase();
    }
}

/**
 * Return the region subtag written in the input's core language identifier.
 *
 * Intl.Locale canonicalizes numeric and retired regions (`840` -> `US`,
 * `SU` -> `RU`). Those mappings are useful for canonical identity but are not
 * proof that the media explicitly named a currently assigned alpha-2 country.
 */
function rawCoreRegion(raw: string): string | null {
    const subtags = raw.split('-');
    if (!/^[A-Za-z]{2,8}$/.test(subtags[0] || '')) return null;
    let index = 1;

    // RFC 5646 permits up to three extlangs after a two/three-letter primary
    // language. Intl.Locale supports only a subset, but this scan must still
    // identify the core region without mistaking an extension value for one.
    if (subtags[0].length <= 3) {
        let extlangs = 0;
        while (extlangs < 3 && /^[A-Za-z]{3}$/.test(subtags[index] || '')) {
            index += 1;
            extlangs += 1;
        }
    }
    if (/^[A-Za-z]{4}$/.test(subtags[index] || '')) index += 1;
    const candidate = subtags[index] || '';
    return /^[A-Za-z]{2}$|^[0-9]{3}$/.test(candidate) ? candidate.toUpperCase() : null;
}

/**
 * Resolve one media language tag without inferring a country.
 *
 * The accepted grammar is the Unicode locale-identifier subset implemented by
 * Intl.Locale. Private-use-only and grandfathered RFC 5646 forms are rejected
 * deterministically because they do not carry usable media-language identity.
 *
 * The returned `semanticTag` excludes Unicode/private extensions so display
 * names and deduplication remain stable, while `canonicalTag` preserves the
 * complete canonical input for cache and accessible metadata.
 */
export function resolveMediaLanguage(value: unknown): ResolvedMediaLanguage {
    if (typeof value !== 'string') return invalidResult();
    const raw = value.trim();
    if (!raw || raw.length > MAX_TAG_LENGTH || raw.toLowerCase() === 'root') {
        return invalidResult();
    }

    if (typeof Intl.Locale !== 'function') {
        // A deficient runtime may retain a bounded base language as neutral,
        // but it must never mint a national flag through a home-grown parser.
        if (!/^[A-Za-z]{2,3}$/.test(raw)) return invalidResult();
        const language = raw.toLowerCase();
        return {
            canonicalTag: language,
            semanticTag: language,
            language,
            script: null,
            explicitRegion: null,
            displayName: displayLanguageName(language),
            flagRegion: null,
            status: language === 'und' ? 'undetermined' : 'valid',
        };
    }

    try {
        const inputRegion = rawCoreRegion(raw);
        const locale = new Intl.Locale(raw) as LocaleLike;
        const canonicalTag = locale.toString();
        const semanticTag = locale.baseName;
        const language = locale.language || null;
        const explicitRegion = locale.region || null;
        const supportedInputRegion = inputRegion?.toLowerCase() || '';
        const status = !language || language === 'und' ? 'undetermined' : 'valid';
        return {
            canonicalTag,
            semanticTag,
            language,
            script: locale.script || null,
            explicitRegion,
            displayName: status === 'valid' ? displayLanguageName(semanticTag) : '',
            flagRegion: status === 'valid'
                && /^[A-Z]{2}$/.test(inputRegion || '')
                && ISO_3166_ALPHA2.has(supportedInputRegion)
                ? supportedInputRegion.toUpperCase()
                : null,
            status,
        };
    } catch {
        return invalidResult();
    }
}

function rawCode(value: unknown): string | null {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const code = record.code ?? record.Code;
    return typeof code === 'string' ? code : null;
}

export function validateMediaLanguageIdentity(value: unknown): MediaLanguageIdentity | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.canonicalTag !== 'string'
        || (record.flagRegion !== null && typeof record.flagRegion !== 'string')) return null;
    const resolved = resolveMediaLanguage(record.canonicalTag);
    if (resolved.status !== 'valid' || resolved.canonicalTag !== record.canonicalTag) return null;
    if (record.flagRegion !== null
        && (!/^[A-Z]{2}$/.test(record.flagRegion) || resolved.flagRegion !== record.flagRegion)) return null;
    return {
        canonicalTag: resolved.canonicalTag,
        // A null marker is deliberately conservative: it preserves the fact
        // that the original raw region was numeric, retired or unsupported.
        flagRegion: record.flagRegion,
    };
}

/**
 * Resolve raw media metadata or validated cache identities without losing the
 * provenance that made an alpha-2 region safe to present as a national flag.
 */
export function resolveMediaLanguageIdentities(values: unknown): MediaLanguageIdentity[] {
    if (!Array.isArray(values)) return [];
    const identities = new Map<string, MediaLanguageIdentity>();
    for (const value of values) {
        const fromCache = validateMediaLanguageIdentity(value);
        let identity: MediaLanguageIdentity | null = fromCache;
        if (!identity) {
            const code = rawCode(value);
            if (code === null) continue;
            const resolved = resolveMediaLanguage(code);
            if (resolved.status !== 'valid') continue;
            identity = {
                canonicalTag: resolved.canonicalTag,
                flagRegion: resolved.flagRegion,
            };
        }
        const existing = identities.get(identity.canonicalTag);
        if (!existing) {
            identities.set(identity.canonicalTag, { ...identity });
        } else if (existing.flagRegion !== identity.flagRegion) {
            // Conflicting sources for one canonical tag fail neutral. A raw
            // `en-840` must never borrow trust from a separate `en-US` value.
            existing.flagRegion = null;
        }
    }
    return Array.from(identities.values()).sort((left, right) =>
        left.canonicalTag < right.canonicalTag ? -1 : left.canonicalTag > right.canonicalTag ? 1 : 0);
}

/**
 * Canonicalize, de-duplicate and ASCII-sort valid language tags.
 * Display names are deliberately not persisted because they are presentation,
 * not media identity.
 */
export function canonicalizeMediaLanguageTags(values: unknown): string[] {
    return resolveMediaLanguageIdentities(values).map((identity) => identity.canonicalTag);
}

function presentationToken(language: ResolvedMediaLanguage): string {
    const value = language.semanticTag.toUpperCase();
    return value.length <= MAX_NEUTRAL_TOKEN_LENGTH
        ? value
        : `${value.slice(0, MAX_NEUTRAL_TOKEN_LENGTH - 1)}…`;
}

/**
 * Build deterministic visual presentations after semantic deduplication.
 * Explicit flags sharing one region are grouped; neutral script/macroregion
 * variants remain distinct. The three-item poster cap is applied by consumers
 * after this function returns.
 */
export function buildMediaLanguagePresentations(
    values: unknown,
    preserveInputOrder = false,
): MediaLanguagePresentation[] {
    const identities = preserveInputOrder && Array.isArray(values)
        ? values.flatMap((value) => resolveMediaLanguageIdentities([value]))
            .filter((value, index, all) => all.findIndex((candidate) => candidate.canonicalTag === value.canonicalTag) === index)
        : resolveMediaLanguageIdentities(values);
    const resolved = identities
        .map((identity) => ({
            ...resolveMediaLanguage(identity.canonicalTag),
            flagRegion: identity.flagRegion,
        }));
    if (!preserveInputOrder) resolved.sort((left, right) => left.semanticTag < right.semanticTag ? -1
            : left.semanticTag > right.semanticTag ? 1
                : left.canonicalTag < right.canonicalTag ? -1
                    : left.canonicalTag > right.canonicalTag ? 1 : 0);

    const semantic = new Map<string, ResolvedMediaLanguage[]>();
    for (const entry of resolved) {
        const group = semantic.get(entry.semanticTag) || [];
        group.push(entry);
        semantic.set(entry.semanticTag, group);
    }

    const presentations = new Map<string, MediaLanguagePresentation>();
    const accessibleLabels = new Map<string, Map<string, string>>();
    for (const group of semantic.values()) {
        const first = group[0];
        const key = first.flagRegion ? `flag:${first.flagRegion}` : `neutral:${first.semanticTag}`;
        const presentation = presentations.get(key) || {
            kind: first.flagRegion ? 'flag' : 'neutral',
            flagRegion: first.flagRegion,
            token: first.flagRegion || presentationToken(first),
            canonicalTags: [],
            displayNames: [],
            accessibleLabel: '',
        } satisfies MediaLanguagePresentation;
        const labels = accessibleLabels.get(key) || new Map<string, string>();
        for (const entry of group) {
            if (!presentation.canonicalTags.includes(entry.canonicalTag)) {
                presentation.canonicalTags.push(entry.canonicalTag);
            }
            if (!presentation.displayNames.includes(entry.displayName)) {
                presentation.displayNames.push(entry.displayName);
            }
            labels.set(entry.canonicalTag, `${entry.displayName} (${entry.canonicalTag})`);
        }
        presentations.set(key, presentation);
        accessibleLabels.set(key, labels);
    }

    return Array.from(presentations.entries()).map(([key, presentation]) => {
        presentation.canonicalTags.sort();
        presentation.displayNames.sort();
        const labels = accessibleLabels.get(key)!;
        presentation.accessibleLabel = presentation.canonicalTags
            .map((tag) => labels.get(tag)!)
            .join(', ');
        return presentation;
    });
}
