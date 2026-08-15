// src/tags/languagetags.ts
// Jellyfin Language Flags Overlay — a spec over the core tag-renderer factory
// (src/core/tag-renderer-base.ts), which owns the cache/ignore/tagged/CSS/
// reinitialize plumbing. This module supplies only the language-specific
// parts: audio-stream extraction and regional/neutral language markup.

import { JC as JEBase } from '../globals';
import { flagSvgUrl } from '../core/asset-urls';
import { createStableMethodFacade } from '../core/feature-loader';
import {
    buildMediaLanguagePresentations,
    resolveMediaLanguageIdentities,
    validateMediaLanguageIdentity,
} from '../core/media-language';
import type { MediaLanguageIdentity } from '../core/media-language';
import {
    currentLanguageTagFilter,
    filterMediaLanguageIdentities,
    languageTagFilterControlsOrder,
} from './language-tag-filter';
import { register, reinitialize, resolvePosition } from '../core/tag-renderer-base';
import type { TagRendererContext, TagSpec } from '../types/jc';

/**
 * Local view of the shared namespace adding the public members this module
 * OWNS (frozen surface consumed by js/plugin.js and the settings panel).
 */
const JC = JEBase as typeof JEBase & {
    initializeLanguageTags?: () => void;
    reinitializeLanguageTags?: () => void;
};

const logPrefix = '🪼 Jellyfin Canopy: Language Tags:';
const containerClass = 'language-overlay-container';
const flagClass = 'language-flag';
const neutralClass = 'language-code-badge';
const presentationClass = 'language-tag-presentation';
// v5 retires untyped v4 snapshots. The hot-cache path runs before item type is
// known, so a legacy BoxSet leaf payload could otherwise suppress its new
// response-only member projection.
const LANGUAGE_CACHE_SCHEMA_VERSION = 6;

type LanguageCoverageState = 'full' | 'partial' | 'unknown';

interface LanguageCoverageProjection {
    eligibleMemberCount: number | null;
    observedMemberCount: number | null;
    complete: boolean;
    full: MediaLanguageIdentity[];
    partial: MediaLanguageIdentity[];
    unknown: MediaLanguageIdentity[];
    truncated: boolean;
    omittedLanguageCount: number | null;
    memberNoun: 'episode' | 'member';
}

/** Versioned browser-cache shape. Pre-version caches lost regional subtags. */
export interface LanguageCachePayload {
    schemaVersion: typeof LANGUAGE_CACHE_SCHEMA_VERSION;
    languages: MediaLanguageIdentity[];
    originalLanguage: string | null;
    timestamp: number;
}

export function createLanguageCachePayload(
    values: unknown,
    now = Date.now(),
    originalLanguage: unknown = null,
): LanguageCachePayload | null {
    const languages = resolveMediaLanguageIdentities(values);
    const original = typeof originalLanguage === 'string'
        ? resolveMediaLanguageIdentities([originalLanguage])[0]?.canonicalTag || null
        : null;
    return languages.length > 0 && Number.isSafeInteger(now) && now >= 0 ? {
        schemaVersion: LANGUAGE_CACHE_SCHEMA_VERSION,
        languages,
        originalLanguage: original,
        timestamp: now,
    } : null;
}

export function readLanguageCachePayload(value: unknown): LanguageCachePayload | null {
    // The hot cache adds exactly one `{ value, timestamp }` wrapper. Never
    // recurse through attacker-controlled storage shapes.
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const outer = value as Record<string, unknown>;
    const candidate = 'value' in outer ? outer.value : value;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const record = candidate as Record<string, unknown>;
    if (record.schemaVersion !== LANGUAGE_CACHE_SCHEMA_VERSION || !Array.isArray(record.languages)
        || (record.originalLanguage !== null && typeof record.originalLanguage !== 'string')) return null;
    if (!Number.isSafeInteger(record.timestamp) || (record.timestamp as number) < 0) return null;
    const validated = record.languages.map(validateMediaLanguageIdentity);
    if (validated.some((language) => language === null)) return null;
    const languages = resolveMediaLanguageIdentities(validated);
    // Current payloads are already canonical and deduplicated. Any dropped,
    // duplicated, forged or malformed member invalidates the whole snapshot.
    if (languages.length === 0 || languages.length !== record.languages.length) return null;
    if (JSON.stringify(languages) !== JSON.stringify(validated)) return null;
    const originalLanguage = record.originalLanguage === null
        ? null
        : resolveMediaLanguageIdentities([record.originalLanguage])[0]?.canonicalTag || null;
    if (originalLanguage !== record.originalLanguage) return null;
    return {
        schemaVersion: LANGUAGE_CACHE_SCHEMA_VERSION,
        languages,
        originalLanguage,
        timestamp: record.timestamp as number,
    };
}

function isFreshLanguageCachePayload(payload: LanguageCachePayload, now: number, ttl: number): boolean {
    const age = now - payload.timestamp;
    return Number.isFinite(ttl) && ttl >= 0 && age >= 0 && age < ttl;
}

/**
 * Extracts audio languages from a Jellyfin item's media sources.
 * @param sourceItem - The item (or first episode) to extract languages from.
 * @returns Canonical, de-duplicated BCP-47 language tags.
 */
function extractLanguagesFromItem(sourceItem: any): MediaLanguageIdentity[] {
    if (!sourceItem) return [];
    const languages: string[] = [];

    // Process audio streams from a flat list
    const processStreams = function(streams: any[] | undefined) {
        if (!streams) return;
        streams.filter(function(s: any) { return s.Type === 'Audio'; }).forEach(function(stream: any) {
            const langCode = stream.Language;
            if (langCode && !['und', 'root'].includes(langCode.toLowerCase())) {
                languages.push(langCode);
            }
        });
    };

    // Handle both formats: nested MediaSources[].MediaStreams[] and flat MediaStreams[]
    if (sourceItem.MediaSources) {
        sourceItem.MediaSources.forEach(function(source: any) {
            processStreams(source.MediaStreams);
        });
    }
    if (sourceItem.MediaStreams) {
        processStreams(sourceItem.MediaStreams);
    }

    return resolveMediaLanguageIdentities(languages);
}

/**
 * Build and attach the flag overlay for a card.
 * @param ctx - Factory context (tagged/ignore/cache helpers).
 * @param container - The render target element.
 * @param languages - Languages in any supported shape.
 */
function insertLanguageTags(
    ctx: TagRendererContext,
    container: HTMLElement,
    languages: any,
    authoritativeOriginal: unknown = null,
): void {
    if (!container) return;
    if (ctx.isTagged(container)) return;
    // Always re-render to handle cache migrations or setting changes
    ctx.removeExistingOverlay(container);
    container.style.position = 'relative'; // Avoid forced reflow from getComputedStyle

    const wrap = document.createElement('div');
    wrap.className = containerClass;
    const pos = resolvePosition('languageTagsPosition', 'LanguageTagsPosition', 'bottom-left');
    wrap.style.position = 'absolute';
    wrap.style.top = pos.topVal; wrap.style.right = pos.rightVal; wrap.style.bottom = pos.bottomVal; wrap.style.left = pos.leftVal;
    // If positioned top-right and the card has indicators, add a top margin to avoid overlap
    const hasIndicators = !!container.querySelector('.cardIndicators');
    if (hasIndicators && pos.needsTopRightOffset) {
        wrap.style.marginTop = 'clamp(20px, 3vw, 30px)';
    }

    const maxToShow = 3;
    const policy = currentLanguageTagFilter();
    const filtered = filterMediaLanguageIdentities(
        languages,
        policy,
        authoritativeOriginal,
    );
    buildMediaLanguagePresentations(filtered, languageTagFilterControlsOrder(policy))
        .slice(0, maxToShow).forEach((presentation) => {
        const tag = document.createElement('span');
        tag.className = presentationClass;
        tag.setAttribute('role', 'img');
        tag.setAttribute('aria-label', presentation.accessibleLabel);
        tag.dataset.langTags = JSON.stringify(presentation.canonicalTags);

        if (presentation.kind === 'flag' && presentation.flagRegion) {
            tag.dataset.region = presentation.flagRegion;
            const img = document.createElement('img');
            // PERF(R6): the validated ISO region is served from the local asset cache.
            img.src = flagSvgUrl(presentation.flagRegion);
            img.className = flagClass;
            img.alt = '';
            img.setAttribute('aria-hidden', 'true');
            img.loading = 'lazy';
            tag.appendChild(img);
        } else {
            tag.classList.add(neutralClass);
            tag.dataset.region = '';
            tag.textContent = presentation.token;
        }
        wrap.appendChild(tag);
    });
    ctx.commitOverlay(container, wrap);
}

function safeCount(value: unknown): number | null {
    return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

/** Validate one server-owned, caller-scoped coverage projection fail closed. */
function readLanguageCoverage(
    value: unknown,
    memberNoun: 'episode' | 'member',
): LanguageCoverageProjection | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.Complete !== 'boolean'
        || typeof record.Truncated !== 'boolean'
        || !Array.isArray(record.FullLanguages)
        || !Array.isArray(record.PartialLanguages)
        || !Array.isArray(record.UnknownLanguages)) return null;
    const eligibleCountField = memberNoun === 'episode' ? 'EligibleEpisodeCount' : 'EligibleMemberCount';
    const observedCountField = memberNoun === 'episode' ? 'ObservedEpisodeCount' : 'ObservedMemberCount';
    const eligibleMemberCount = record[eligibleCountField] === null
        ? null
        : safeCount(record[eligibleCountField]);
    const observedMemberCount = record[observedCountField] === null
        ? null
        : safeCount(record[observedCountField]);
    const omittedLanguageCount = memberNoun === 'member'
        ? (record.OmittedLanguageCount === null ? null : safeCount(record.OmittedLanguageCount))
        : null;
    if ((record[eligibleCountField] !== null && eligibleMemberCount === null)
        || (record[observedCountField] !== null && observedMemberCount === null)
        || (eligibleMemberCount !== null && observedMemberCount !== null
            && observedMemberCount > eligibleMemberCount)
        || (memberNoun === 'member' && record.OmittedLanguageCount !== null
            && omittedLanguageCount === null)
        || (memberNoun === 'member' && omittedLanguageCount === null
            && (record.Complete || eligibleMemberCount !== null || observedMemberCount !== null
                || record.FullLanguages.length > 0 || record.PartialLanguages.length > 0
                || record.UnknownLanguages.length > 0))
        || (memberNoun === 'member' && !record.Truncated
            && omittedLanguageCount !== null && omittedLanguageCount !== 0)) return null;

    const rawIdentityCount = record.FullLanguages.length
        + record.PartialLanguages.length
        + record.UnknownLanguages.length;
    if (rawIdentityCount > 32) return null;
    const groups: Array<[LanguageCoverageState, MediaLanguageIdentity[]]> = [
        ['full', resolveMediaLanguageIdentities(record.FullLanguages)],
        ['partial', resolveMediaLanguageIdentities(record.PartialLanguages)],
        ['unknown', resolveMediaLanguageIdentities(record.UnknownLanguages)],
    ];
    const tierRank: Record<LanguageCoverageState, number> = { full: 0, unknown: 1, partial: 2 };
    const merged = new Map<string, { state: LanguageCoverageState; language: MediaLanguageIdentity }>();
    for (const [state, languages] of groups) {
        for (const language of languages) {
            const current = merged.get(language.canonicalTag);
            if (!current) {
                merged.set(language.canonicalTag, { state, language });
                continue;
            }
            current.state = tierRank[state] > tierRank[current.state] ? state : current.state;
            if (current.language.flagRegion !== language.flagRegion) {
                current.language = { ...current.language, flagRegion: null };
            }
        }
    }
    const byTier = (state: LanguageCoverageState): MediaLanguageIdentity[] => Array.from(merged.values())
        .filter((entry) => entry.state === state)
        .map((entry) => entry.language)
        .sort((left, right) => left.canonicalTag < right.canonicalTag ? -1
            : left.canonicalTag > right.canonicalTag ? 1 : 0);
    const full = byTier('full');
    const partial = byTier('partial');
    const unknown = byTier('unknown');
    if (record.Complete && (eligibleMemberCount === null || observedMemberCount !== eligibleMemberCount)) return null;
    if ((record.Complete && unknown.length > 0) || (!record.Complete && full.length > 0)) return null;
    return {
        eligibleMemberCount,
        observedMemberCount,
        complete: record.Complete,
        full,
        partial,
        unknown,
        truncated: record.Truncated,
        omittedLanguageCount,
        memberNoun,
    };
}

function insertLanguageCoverage(
    ctx: TagRendererContext,
    container: HTMLElement,
    coverage: LanguageCoverageProjection,
    authoritativeOriginal: unknown = null,
): void {
    if (!container || ctx.isTagged(container)) return;
    ctx.removeExistingOverlay(container);
    container.style.position = 'relative';
    const wrap = document.createElement('div');
    wrap.className = containerClass;
    const pos = resolvePosition('languageTagsPosition', 'LanguageTagsPosition', 'bottom-left');
    wrap.style.position = 'absolute';
    wrap.style.top = pos.topVal; wrap.style.right = pos.rightVal;
    wrap.style.bottom = pos.bottomVal; wrap.style.left = pos.leftVal;
    if (container.querySelector('.cardIndicators') && pos.needsTopRightOffset) {
        wrap.style.marginTop = 'clamp(20px, 3vw, 30px)';
    }

    const groups: Array<[LanguageCoverageState, MediaLanguageIdentity[]]> = [
        ['full', coverage.full],
        ['partial', coverage.partial],
        ['unknown', coverage.unknown],
    ];
    const filter = currentLanguageTagFilter();
    const presentations = groups.flatMap(([state, languages]) =>
        buildMediaLanguagePresentations(
            filterMediaLanguageIdentities(languages, filter, authoritativeOriginal),
            languageTagFilterControlsOrder(filter),
        )
            .map((presentation) => ({ state, presentation })));

    for (const { state, presentation } of presentations.slice(0, 3)) {
        const tag = document.createElement('span');
        tag.className = `${presentationClass} language-coverage-${state}`;
        tag.setAttribute('role', 'img');
        const count = coverage.eligibleMemberCount;
        const countLabel = count === null
            ? ''
            : ` across ${count} eligible ${coverage.memberNoun}${count === 1 ? '' : 's'}`;
        tag.setAttribute('aria-label', `${presentation.accessibleLabel} — ${state} coverage${countLabel}`);
        tag.dataset.langTags = JSON.stringify(presentation.canonicalTags);
        tag.dataset.coverage = state;
        if (presentation.kind === 'flag' && presentation.flagRegion) {
            tag.dataset.region = presentation.flagRegion;
            const img = document.createElement('img');
            img.src = flagSvgUrl(presentation.flagRegion);
            img.className = flagClass;
            img.alt = '';
            img.setAttribute('aria-hidden', 'true');
            img.loading = 'lazy';
            tag.appendChild(img);
        } else {
            tag.classList.add(neutralClass);
            tag.dataset.region = '';
            tag.textContent = presentation.token;
        }
        wrap.appendChild(tag);
    }

    if (presentations.length === 0) {
        const state = document.createElement('span');
        state.className = `${presentationClass} ${neutralClass} language-coverage-state`;
        state.setAttribute('role', 'img');
        state.dataset.region = '';
        if (coverage.complete && coverage.eligibleMemberCount === 0) {
            state.textContent = '0';
            state.setAttribute('aria-label', `No eligible ${coverage.memberNoun}s for language coverage`);
        } else if (coverage.complete) {
            state.textContent = '—';
            const count = coverage.eligibleMemberCount;
            state.setAttribute(
                'aria-label',
                `No recognized audio languages across ${count} eligible ${coverage.memberNoun}${count === 1 ? '' : 's'}`,
            );
        } else {
            state.textContent = '?';
            state.setAttribute(
                'aria-label',
                coverage.memberNoun === 'member'
                    ? 'Collection language coverage incomplete'
                    : 'Language coverage incomplete',
            );
        }
        wrap.appendChild(state);
    }
    ctx.commitOverlay(container, wrap);
}

/** Factory spec — everything language-specific lives here. */
const spec: TagSpec = {
    logPrefix,
    settingKey: 'languageTagsEnabled',
    containerClass,
    taggedAttr: 'jcLanguageTagged',
    styleId: 'language-tags-styles',
    cache: {
        key: 'JellyfinCanopy-languageTagsCache',
        legacyPrefix: 'languageTagsCache',
        hotBucket: 'language',
        pruneOnSave: true,
    },
    buildCss() {
        return `
            .${containerClass} {
                display: flex;
                flex-direction: column;
                gap: 3px;
                z-index: 101;
                pointer-events: none;
                max-height: 90%;
                overflow: hidden;
            }
            .${flagClass} {
                width: clamp(24px, 6vw, 32px);
                height: auto;
                border-radius: 2px;
                box-shadow: 0 1px 3px rgba(0,0,0,0.4);
                flex-shrink: 0;
                object-fit: cover;
            }
            .${presentationClass} {
                position: relative;
                display: inline-flex;
                min-width: clamp(24px, 6vw, 32px);
                min-height: 1.25em;
                align-items: center;
                justify-content: center;
                box-sizing: border-box;
                flex-shrink: 0;
            }
            .${neutralClass} {
                max-width: 5.5em;
                padding: 0.12em 0.3em;
                overflow: hidden;
                border: 1px solid rgba(255,255,255,0.72);
                border-radius: 3px;
                background: rgba(18,18,18,0.88);
                color: #fff;
                font-size: clamp(9px, 2.2vw, 12px);
                font-weight: 700;
                line-height: 1.1;
                letter-spacing: 0.02em;
                text-overflow: ellipsis;
                white-space: nowrap;
                box-shadow: 0 1px 3px rgba(0,0,0,0.4);
            }
            .${presentationClass}[data-coverage]::after {
                position: absolute;
                right: -0.28em;
                bottom: -0.28em;
                min-width: 1.05em;
                min-height: 1.05em;
                border: 1px solid rgba(255,255,255,0.9);
                border-radius: 50%;
                background: rgba(18,18,18,0.95);
                color: #fff;
                font-size: 0.55em;
                font-weight: 800;
                line-height: 1;
                text-align: center;
            }
            .language-coverage-full::after { content: '✓'; }
            .language-coverage-partial::after { content: '◐'; }
            .language-coverage-unknown::after { content: '?'; }
            @media (max-width: 768px) {
                .${flagClass} {
                    width: clamp(20px, 5vw, 26px);
                }
                .${presentationClass} {
                    min-width: clamp(20px, 5vw, 26px);
                }
                .${containerClass} { gap: 2px; }
            }
            @media (max-width: 480px) {
                .${flagClass} {
                    width: clamp(16px, 4vw, 20px);
                }
                .${presentationClass} {
                    min-width: clamp(16px, 4vw, 20px);
                }
                .${containerClass} {
                    gap: 2px;
                }
            }
        `;
    },
    pipeline: {
        needsFirstEpisode: true,
        needsParentSeries: false,
        render(ctx, el, item: any, extras: any) {
            if (ctx.shouldIgnore(el)) return;
            if (ctx.isTagged(el)) return;
            // Skip cards hidden by hidden-content module
            if (el.closest('.jc-hidden')) return;

            const itemId = item.Id;
            const isEpisodeContainer = item.Type === 'Series' || item.Type === 'Season';
            const isCollection = item.Type === 'BoxSet';
            const isContainer = isEpisodeContainer || isCollection;
            const coverageValue = isCollection
                ? item.CollectionLanguageCoverage
                : item.LanguageCoverage;
            if (isContainer && coverageValue !== undefined) {
                const coverage = readLanguageCoverage(
                    coverageValue,
                    isCollection ? 'member' : 'episode',
                );
                // Coverage is policy-scoped, so never retain it in browser storage.
                ctx.hot?.delete(itemId);
                ctx.setPersistent(itemId, undefined);
                if (coverage) insertLanguageCoverage(ctx, el, coverage, item.OriginalLanguage);
                return;
            }
            if (isCollection) {
                // A legacy leaf cache entry must never become representative
                // collection evidence after a server downgrade or upgrade.
                ctx.hot?.delete(itemId);
                ctx.setPersistent(itemId, undefined);
                return;
            }
            // Check hot cache first
            const hot = ctx.hot?.get(itemId);
            if (hot) {
                const payload = readLanguageCachePayload(hot);
                if (payload && isFreshLanguageCachePayload(payload, Date.now(), ctx.cacheTtl)) {
                    insertLanguageTags(ctx, el, payload.languages, payload.originalLanguage ?? item.OriginalLanguage);
                    return;
                }
                // Pre-version cache entries irreversibly lost region data.
                ctx.hot?.delete(itemId);
            }

            let sourceItem = item;
            if (isEpisodeContainer) {
                if (extras.firstEpisode) {
                    sourceItem = extras.firstEpisode;
                } else {
                    return; // No first episode available, skip
                }
            }

            const languages = extractLanguagesFromItem(sourceItem);

            if (languages.length > 0) {
                if (isContainer) {
                    // Old servers expose only representative first-Episode data.
                    // Render that compatibility fallback, but never cache it as
                    // aggregate coverage evidence.
                    insertLanguageTags(ctx, el, languages, sourceItem.OriginalLanguage ?? item.OriginalLanguage);
                } else {
                    const payload = createLanguageCachePayload(
                        languages,
                        Date.now(),
                        sourceItem.OriginalLanguage ?? item.OriginalLanguage,
                    )!;
                    ctx.setPersistent(itemId, payload);
                    ctx.hot?.set(itemId, { value: payload, timestamp: payload.timestamp });
                    insertLanguageTags(ctx, el, payload.languages, sourceItem.OriginalLanguage ?? item.OriginalLanguage);
                }
            }
        },
        renderFromCache(ctx, el, itemId) {
            if (ctx.isTagged(el)) return true;
            if (ctx.shouldIgnore(el)) return true;
            if (el.closest('.jc-hidden')) return true;
            const now = Date.now();
            const hot = ctx.hot?.get(itemId);
            if (hot !== undefined) {
                const payload = readLanguageCachePayload(hot);
                if (payload && isFreshLanguageCachePayload(payload, now, ctx.cacheTtl)) {
                    insertLanguageTags(ctx, el, payload.languages, payload.originalLanguage);
                    return true;
                }
                ctx.hot?.delete(itemId);
            }
            const persistent = ctx.getPersistent(itemId);
            if (persistent !== undefined) {
                const payload = readLanguageCachePayload(persistent);
                if (payload && isFreshLanguageCachePayload(payload, now, ctx.cacheTtl)) {
                    insertLanguageTags(ctx, el, payload.languages, payload.originalLanguage);
                    return true;
                }
                ctx.setPersistent(itemId, undefined);
            }
            // Reject legacy, corrupt, stale and future-dated entries so the
            // authoritative server/live path can refill on this scan.
            return false;
        },
        renderFromServerCache(ctx, el, entry: any) {
            if (ctx.isTagged(el)) return;
            if (ctx.shouldIgnore(el)) return;
            const isCollection = entry.Type === 'BoxSet'
                || entry.CollectionLanguageCoverage !== undefined;
            const coverageValue = isCollection
                ? entry.CollectionLanguageCoverage
                : entry.LanguageCoverage;
            if (coverageValue !== undefined) {
                const coverage = readLanguageCoverage(
                    coverageValue,
                    isCollection ? 'member' : 'episode',
                );
                if (coverage) insertLanguageCoverage(ctx, el, coverage, entry.OriginalLanguage);
                return;
            }
            if (isCollection) return;
            const codes = entry.AudioLanguages;
            if (!codes || codes.length === 0) return;
            insertLanguageTags(ctx, el, codes, entry.OriginalLanguage);
        },
    },
};

function initializeLanguageTags(): void {
    register('language', spec);
}

/**
 * Re-initializes the Language Tags feature
 * Cleans up existing state and re-applies tags.
 */
function reinitializeLanguageTags(): void {
    reinitialize('language', spec);
}

const stableLanguageTags = createStableMethodFacade({
    initialize: (): void => {},
    reinitialize: (): void => {},
});

/** Install frozen language-tag entry points for one cluster activation. */
export function installLanguageTagsFacade(): () => void {
    const uninstall = stableLanguageTags.install({
        initialize: initializeLanguageTags,
        reinitialize: reinitializeLanguageTags,
    });
    JC.initializeLanguageTags = stableLanguageTags.facade.initialize;
    JC.reinitializeLanguageTags = stableLanguageTags.facade.reinitialize;
    return uninstall;
}
