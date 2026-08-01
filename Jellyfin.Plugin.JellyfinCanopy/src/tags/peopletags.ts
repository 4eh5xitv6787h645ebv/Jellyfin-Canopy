// src/tags/peopletags.ts
// Jellyfin Canopy People Tags - Show cast member information (birthplace, age, deceased status)
//
// NOTE: unlike the poster tag modules, this one is NOT a tag-pipeline
// renderer — it targets person cards on the item detail page with its own
// managed observer and per-person backend endpoint, so the tag-renderer
// factory does not apply here.

import { JC as JEBase } from '../globals';
import { flagPngUrl } from '../core/asset-urls';
import { createBoundedCache, type BoundedCache } from '../core/bounded-cache';
import { getItemIdFromUrl, getVisibleDetailsPage } from '../core/details-view';
import { createStableMethodFacade } from '../core/feature-loader';
import { ensureMaterialSymbolsFont, injectCss, removeCss } from '../core/ui-kit';
import type { ApiApi, JELegacyHelpers, PluginConfig, UserSettings } from '../types/jc';

interface PersonData {
    isDeceased?: boolean;
    ageAtDeath?: number | null;
    currentAge?: number | null;
    ageAtItemRelease?: number | null;
    birthPlace?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPersonData(value: unknown): value is PersonData {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPersonCache(value: unknown): value is Record<string, PersonData> {
    return isRecord(value) && Object.values(value).every(isPersonData);
}

function isTimestampCache(value: unknown): value is Record<string, number> {
    return isRecord(value) && Object.values(value).every(
        (timestamp) => typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp >= 0,
    );
}

/**
 * Local view of the shared namespace adding the public member this module
 * OWNS plus the legacy helper/config members it reads that are not yet
 * typed on JEGlobal (owned by unconverted js/ modules).
 */
const JC = JEBase as typeof JEBase & {
    initializePeopleTags?: () => void;
    currentSettings: UserSettings & { peopleTagsEnabled?: boolean };
    pluginConfig: PluginConfig;
    core: { api: ApiApi };
    helpers: JELegacyHelpers & {
        createObserver(
            id: string,
            cb: MutationCallback,
            target: Node,
            config: MutationObserverInit
        ): { disconnect?: () => void; unsubscribe?: () => void };
    };
};

/**
 * PERF(#359): maximum concurrent in-flight /person/{id} requests per batch.
 * Matches the repository's established bounded pool size for per-entity
 * enrichment (ISSUE_ENRICHMENT_CONCURRENCY, TAG_FALLBACK_CONCURRENCY) —
 * overlapped instead of serial, but never an unbounded fan-out across a
 * 50-person cast.
 */
export const PEOPLE_TAGS_CONCURRENCY = 6;

/**
 * PERF(R9/#361): one bounded, item/page-owned retry ladder for transient
 * person lookups. Four retries after the initial attempt cover short backend
 * stalls without turning a persistent outage into an unbounded request loop.
 */
const PEOPLE_TAGS_RETRY_DELAYS_MS = [250, 500, 1000, 2000] as const;

/**
 * PERF(R8/#361): body-observer work may inspect descendants only after an
 * added node is structurally proven to intersect the owned cast surfaces.
 * Traversal then yields after this small synchronous budget and resumes from
 * the same cursor asynchronously, keeping large React mounts off one frame.
 */
const PEOPLE_TAGS_OBSERVER_SCAN_BUDGET_MS = 2;

/**
 * PERF(#359) GLOBAL request budget. The per-batch worker pool caps concurrency
 * WITHIN one generation, but a same-identity reinitialization (a supported
 * settings restart) starts a fresh pool while the retired generation's requests
 * are still in flight — teardown retires those workers but cannot cancel a
 * request already handed to the core API, so two per-generation pools would run
 * up to 2× the cap concurrently. This module-level semaphore is the SINGLE
 * owner of the /person concurrency budget: every worker of every generation
 * acquires a permit before issuing a request and releases it when the request
 * settles, so People Tags never exceeds PEOPLE_TAGS_CONCURRENCY globally.
 */
interface Semaphore {
    acquire(): Promise<void>;
    release(): void;
    reset(): void;
}

function createSemaphore(maxPermits: number): Semaphore {
    let available = maxPermits;
    let waiters: Array<() => void> = [];
    return {
        acquire(): Promise<void> {
            if (available > 0) {
                available -= 1;
                return Promise.resolve();
            }
            return new Promise<void>((resolve) => { waiters.push(resolve); });
        },
        release(): void {
            const next = waiters.shift();
            if (next) next();
            // Never let a late release from a retired/aborted generation push
            // the budget above its ceiling (which would admit >cap later).
            else if (available < maxPermits) available += 1;
        },
        reset(): void {
            // Only on a true identity reset: a new user's budget starts fresh.
            // A stale in-flight release afterwards is bounded by the ceiling
            // clamp above, so it can never over-credit.
            available = maxPermits;
            waiters = [];
        },
    };
}

const peopleTagsRequestGate = createSemaphore(PEOPLE_TAGS_CONCURRENCY);

let activePeopleTagsCleanup: ((clearPersistent: boolean) => void) | null = null;

/**
 * PERF(#359) lifecycle fence. Monotonic counter bumped on every teardown and
 * (re)initialization. Each initializer captures its value and treats itself as
 * live only while the counter still matches — so a retired closure's worker
 * pool, render guards, completion timers and cache-persist path all go dormant
 * the instant a newer initializer starts, EVEN under the same Jellyfin
 * identity (a supported same-user settings restart). Without it two same-user
 * pools run concurrently (double the concurrency cap) and a retired pool's
 * stale cache map can overwrite the active one.
 */
let peopleTagsGeneration = 0;

function teardownPeopleTags(clearPersistent: boolean): void {
    peopleTagsGeneration += 1;
    const cleanup = activePeopleTagsCleanup;
    activePeopleTagsCleanup = null;
    try { cleanup?.(clearPersistent); } catch { /* continue */ }
    document.querySelectorAll('.jc-people-age-container, .jc-people-place-banner').forEach((node) => node.remove());
    document.querySelectorAll('.jc-deceased-poster').forEach((node) => node.classList.remove('jc-deceased-poster'));
}

export function resetPeopleTagsIdentity(): void {
    teardownPeopleTags(true);
    // A different Jellyfin identity starts with a fresh concurrency budget.
    // (A same-identity settings restart goes through initializePeopleTags and
    // must NOT reset the gate — its retired requests still hold their permits.)
    peopleTagsRequestGate.reset();
    removeCss('jc-people-tags-styles');
}

/**
 * Effective people-tags cache TTL in milliseconds, derived from the
 * admin-configurable TagsCacheTtlDays — the SAME setting every other tag family
 * reads (core/tag-renderer-base.ts), default 30 days. People tags used to read a
 * phantom `PeopleTagsCacheTtlDays` key that is not a PluginConfiguration property
 * and is never projected to the client, so it was always undefined ⇒ pinned at
 * 30 days. Exported so the derivation is deterministically unit-testable.
 */
export function peopleTagsCacheTtlMs(cfg: PluginConfig | null | undefined): number {
    return ((cfg?.TagsCacheTtlDays) || 30) * 24 * 60 * 60 * 1000;
}

function initializePeopleTags(): void {
    // A same-user settings reinitialization should replace observers/timers
    // without throwing away that user's valid persistent cache.
    teardownPeopleTags(false);
    if (!JC.currentSettings.peopleTagsEnabled) {
        console.log('🪼 Jellyfin Canopy: People Tags: Feature is disabled in settings.');
        return;
    }

    const context = JC.identity.capture();
    if (!context || !JC.identity.isCurrent(context)) return;
    // Capture THIS initializer's generation (teardown above already bumped the
    // counter). generationIsCurrent() means "this closure is still the live
    // one AND the identity is unchanged" — a later initialize/teardown makes
    // the first conjunct false, retiring every guard downstream without a
    // per-call edit.
    const myGeneration = peopleTagsGeneration;
    const generationIsCurrent = (): boolean =>
        peopleTagsGeneration === myGeneration && JC.identity.isCurrent(context);
    // User settings can disable this feature without changing identity or
    // generation. Treat that as an immediate work fence so waiting retries,
    // semaphore waiters, in-flight results and render commits cannot outlive
    // the visible toggle state.
    const isCurrent = (): boolean =>
        generationIsCurrent() && JC.currentSettings?.peopleTagsEnabled === true;
    const timers = new Set<number>();
    let observerHandle: { disconnect?: () => void; unsubscribe?: () => void } | null = null;

    const logPrefix = '🪼 Jellyfin Canopy: People Tags:';
    const CACHE_KEY = 'JellyfinCanopy-peopleTagsCache';
    const CACHE_TIMESTAMP_KEY = 'JellyfinCanopy-peopleTagsCacheTimestamp';
    const CACHE_OWNER_KEY = 'JellyfinCanopy-peopleTagsCacheIdentityOwner';
    const CACHE_TTL = peopleTagsCacheTtlMs(JC.pluginConfig);

    const schedule = (fn: () => void, delay: number): number => {
        const timer = window.setTimeout(() => {
            timers.delete(timer);
            // Generation ownership, rather than feature eligibility, decides
            // whether the callback may run: a timer whose feature was disabled
            // still needs to clear its retry/debounce bookkeeping, but every
            // work path below rechecks isCurrent() before fetching or rendering.
            if (generationIsCurrent()) fn();
        }, delay);
        timers.add(timer);
        return timer;
    };

    // Country mapping dictionary
    const COUNTRY_MAP: Record<string, string> = {
        'United States': 'US', 'USA': 'US', 'America': 'US',
        'United Kingdom': 'GB', 'UK': 'GB', 'England': 'GB', 'Scotland': 'GB', 'Wales': 'GB',
        'Canada': 'CA', 'Australia': 'AU', 'New Zealand': 'NZ',
        'Germany': 'DE', 'France': 'FR', 'Italy': 'IT', 'Spain': 'ES',
        'Mexico': 'MX', 'Brazil': 'BR', 'Argentina': 'AR',
        'Japan': 'JP', 'South Korea': 'KR', 'China': 'CN',
        'India': 'IN', 'Russia': 'RU', 'Sweden': 'SE',
        'Norway': 'NO', 'Denmark': 'DK', 'Finland': 'FI',
        'Netherlands': 'NL', 'Belgium': 'BE', 'Austria': 'AT',
        'Switzerland': 'CH', 'Poland': 'PL', 'Czech Republic': 'CZ',
        'Czechia': 'CZ', 'Greece': 'GR', 'Portugal': 'PT',
        'Turkey': 'TR', 'Israel': 'IL', 'South Africa': 'ZA',
        'Chile': 'CL', 'Colombia': 'CO', 'Peru': 'PE',
        'Thailand': 'TH', 'Malaysia': 'MY', 'Singapore': 'SG',
        'Philippines': 'PH', 'Indonesia': 'ID', 'Vietnam': 'VN',
        'Ukraine': 'UA', 'Iran': 'IR', 'Ireland': 'IE',
        'Hungary': 'HU', 'Romania': 'RO', 'Bulgaria': 'BG',
        'Croatia': 'HR', 'Serbia': 'RS', 'Slovenia': 'SI',
        'Estonia': 'EE', 'Latvia': 'LV', 'Lithuania': 'LT', 'Iceland': 'IS',
        'Luxembourg': 'LU', 'Monaco': 'MC', 'Liechtenstein': 'LI',
        'Malta': 'MT', 'Cyprus': 'CY',
        'Slovakia': 'SK', 'Bosnia and Herzegovina': 'BA', 'Bosnia': 'BA',
        'North Macedonia': 'MK', 'Macedonia': 'MK', 'Albania': 'AL',
        'Montenegro': 'ME', 'Moldova': 'MD', 'Belarus': 'BY',
        'Kosovo': 'XK', 'Georgia': 'GE', 'Armenia': 'AM', 'Azerbaijan': 'AZ',
        'Saudi Arabia': 'SA', 'United Arab Emirates': 'AE', 'UAE': 'AE',
        'Qatar': 'QA', 'Kuwait': 'KW', 'Bahrain': 'BH', 'Oman': 'OM',
        'Jordan': 'JO', 'Lebanon': 'LB', 'Egypt': 'EG', 'Iraq': 'IQ',
        'Syria': 'SY', 'Yemen': 'YE', 'Palestine': 'PS',
        'Pakistan': 'PK', 'Bangladesh': 'BD', 'Sri Lanka': 'LK', 'Nepal': 'NP',
        'Taiwan': 'TW', 'Hong Kong': 'HK', 'Macau': 'MO',
        'Kazakhstan': 'KZ', 'Uzbekistan': 'UZ', 'Afghanistan': 'AF',
        'Mongolia': 'MN', 'Myanmar': 'MM', 'Cambodia': 'KH', 'Laos': 'LA',
        'Venezuela': 'VE', 'Ecuador': 'EC', 'Uruguay': 'UY', 'Paraguay': 'PY',
        'Bolivia': 'BO', 'Costa Rica': 'CR', 'Panama': 'PA', 'Nicaragua': 'NI',
        'Honduras': 'HN', 'El Salvador': 'SV', 'Guatemala': 'GT', 'Belize': 'BZ',
        'Cuba': 'CU', 'Jamaica': 'JM', 'Dominican Republic': 'DO',
        'Puerto Rico': 'PR', 'Trinidad and Tobago': 'TT', 'Barbados': 'BB',
        'Haiti': 'HT', 'Bahamas': 'BS', 'Guyana': 'GY', 'Suriname': 'SR',
        'Nigeria': 'NG', 'Kenya': 'KE', 'Ghana': 'GH', 'Ethiopia': 'ET',
        'Morocco': 'MA', 'Algeria': 'DZ', 'Tunisia': 'TN', 'Libya': 'LY',
        'Senegal': 'SN', 'Uganda': 'UG', 'Tanzania': 'TZ', 'Zimbabwe': 'ZW',
        'Zambia': 'ZM', 'Botswana': 'BW', 'Namibia': 'NA', 'Angola': 'AO',
        'Mozambique': 'MZ', 'Madagascar': 'MG', 'Cameroon': 'CM',
        'Ivory Coast': 'CI', "Côte d'Ivoire": 'CI', 'Mali': 'ML', 'Burkina Faso': 'BF',
        'Papua New Guinea': 'PG', 'Fiji': 'FJ', 'Samoa': 'WS', 'Tonga': 'TO'
    };

    const expectedCacheOwner = `${context.serverId}:${context.userId}`;
    const owner = JC.storage.local.read('people-tags', CACHE_OWNER_KEY, 'cache-owner');
    if (owner.state !== 'Valid' || owner.value !== expectedCacheOwner) {
        // Older builds stored an unowned cache. It cannot safely be replayed
        // after login as a different Jellyfin user.
        JC.storage.local.remove('people-tags', CACHE_KEY, 'cache-payload');
        JC.storage.local.remove('people-tags', CACHE_TIMESTAMP_KEY, 'cache-timestamps');
        JC.storage.local.write('people-tags', CACHE_OWNER_KEY, expectedCacheOwner, 'cache-owner');
    }
    const cachedPeople = JC.storage.local.readJson('people-tags', CACHE_KEY, isPersonCache, 'cache-payload');
    const cachedTimestamps = JC.storage.local.readJson(
        'people-tags', CACHE_TIMESTAMP_KEY, isTimestampCache, 'cache-timestamps',
    );
    let peopleCache: Record<string, PersonData> = cachedPeople.state === 'Valid'
        ? cachedPeople.value
        : {};
    let peopleCacheTimestamp: Record<string, number> = cachedTimestamps.state === 'Valid'
        ? cachedTimestamps.value
        : {};
    const Hot = (JC._hotCache = JC._hotCache || { ttl: CACHE_TTL });
    const previousHot = Hot.peopleTags as BoundedCache<string, unknown> | undefined;
    previousHot?.clear?.();
    const hotPeopleTags = createBoundedCache<string, { data: PersonData; timestamp: number }>({
        maxEntries: 1000,
        ttlMs: CACHE_TTL,
    });
    Hot.peopleTags = hotPeopleTags;

    let processedCastMembers = new WeakSet<Element>();
    let lastProcessedItemId: string | null = null;
    let peopleTagsComplete = false; // Set true after all cast members tagged for current item
    let isProcessing = false;
    // PERF(#359): a run requested while a batch is in flight (a late guest-cast
    // mount, or a navigation to a new item) must not be silently dropped — it is
    // remembered here and drained once the active batch settles. Without it the
    // one-shot snapshot starves cards that mount mid-batch and the current page
    // stays untagged after a stale batch exits.
    let rerunRequested = false;

    // PERF(R9/#361): a SINGLE retry ladder belongs to one concrete visible
    // page + item under this initializer's captured identity/generation.
    // `retryAttempts` counts automatic retries that actually STARTED while
    // visible (the initial observer-driven request is not part of the four-
    // entry delay table). A hidden tab owns no timer and consumes no entry.
    let retryTimer: number | null = null;
    let retryPage: HTMLElement | null = null;
    let retryItemId: string | null = null;
    let retryAttempts = 0;
    let retryWaiting = false;
    let retryVisibilityListener: (() => void) | null = null;
    // Installed by initialize() once its observer scan cursor exists. Cleanup
    // invokes the hook so no deferred traversal retains an old page/generation.
    let cancelPendingObserverScan: (() => void) | null = null;

    const retryScopeMatches = (page: HTMLElement, itemId: string): boolean =>
        retryPage === page && retryItemId === itemId;

    const pageScopeIsCurrent = (page: HTMLElement, itemId: string): boolean => {
        if (!isCurrent()) return false;
        const visible = getVisibleDetailsPage();
        return visible !== null && visible.page === page && visible.itemId === itemId;
    };

    const clearRetryTimer = (): void => {
        if (retryTimer !== null) {
            clearTimeout(retryTimer);
            timers.delete(retryTimer);
        }
        retryTimer = null;
    };

    const removeRetryVisibilityListener = (): void => {
        if (retryVisibilityListener === null) return;
        document.removeEventListener('visibilitychange', retryVisibilityListener);
        retryVisibilityListener = null;
    };

    const resetRetryLadder = (): void => {
        clearRetryTimer();
        removeRetryVisibilityListener();
        retryPage = null;
        retryItemId = null;
        retryAttempts = 0;
        retryWaiting = false;
    };

    activePeopleTagsCleanup = (clearPersistent) => {
        cancelPendingObserverScan?.();
        cancelPendingObserverScan = null;
        resetRetryLadder();
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        if (observerHandle?.unsubscribe) observerHandle.unsubscribe();
        else observerHandle?.disconnect?.();
        observerHandle = null;
        hotPeopleTags.clear();
        peopleCache = {};
        peopleCacheTimestamp = {};
        if (clearPersistent) {
            JC.storage.local.remove('people-tags', CACHE_KEY, 'cache-payload');
            JC.storage.local.remove('people-tags', CACHE_TIMESTAMP_KEY, 'cache-timestamps');
            JC.storage.local.remove('people-tags', CACHE_OWNER_KEY, 'cache-owner');
        }
    };

    // Styles for deceased indicators, overlay positioning, and material-symbols-rounded font.
    // Shared @font-face lives in core/ui-kit (local asset cache), not here.
    ensureMaterialSymbolsFont();
    injectCss('jc-people-tags-styles', `
        .material-symbols-rounded {
            font-family: 'Material Symbols Rounded';
            font-weight: normal;
            font-style: normal;
            font-size: 24px;
            line-height: 1;
            letter-spacing: normal;
            text-transform: none;
            display: inline-block;
            white-space: nowrap;
            word-wrap: normal;
            direction: ltr;
            -webkit-font-feature-settings: 'liga';
            -moz-font-feature-settings: 'liga';
            font-feature-settings: 'liga';
            -webkit-font-smoothing: antialiased;
        }

        /* Ensure cardScalable has position: relative for absolute positioned overlays */
        #castCollapsible .personCard .cardScalable {
            position: relative;
        }

        /* Deceased poster styling */
        .jc-deceased-poster .cardImageContainer {
            filter: grayscale(100%) opacity(0.7);
        }

        .jc-deceased-poster .cardScalable::after {
            content: "✝";
            position: absolute;
            top: 8px;
            right: 8px;
            z-index: 3;
            color: white;
            font-weight: bold;
            font-size: 2em;
            text-shadow: 0 0 4px black;
            pointer-events: none;
        }

        /* People tag banner styling */
        .jc-people-tag-banner {
            max-width: 100%;
            box-sizing: border-box;
        }
    `);

    console.log(`${logPrefix} Initialized`);

    /**
     * Extract country code from birthplace string
     * @param placeString - Full birthplace string like "London, England, UK"
     * @returns ISO 3166-1 alpha-2 country code or null
     */
    function getCountryCodeFromBirthPlace(placeString: string): string | null {
        if (!placeString || typeof placeString !== 'string') return null;

        // Split by comma and take the last part (country is typically last)
        const parts = placeString.split(',').map(p => p.trim());
        if (parts.length === 0) return null;

        const lastPart = parts[parts.length - 1];

        // Check if it matches any country name (case-insensitive)
        for (const [countryName, code] of Object.entries(COUNTRY_MAP)) {
            if (countryName.toLowerCase() === lastPart.toLowerCase()) {
                return code;
            }
        }

        return null;
    }

    /**
     * Fetch person info with caching.
     *
     * PERF(#359): the successful backend path updates the in-memory maps and
     * the hot cache per person but no longer serializes the WHOLE persistent
     * map per person (that was O(N^2) main-thread JSON work across a cast).
     * `cacheChanged` tells the batch owner (processCastMembers) that one
     * settled-batch flush is required. `failed` distinguishes a TRANSIENT
     * backend/network error (retryable — concrete cards remain unprocessed)
     * from a genuine empty response (definitive — cards may be completed);
     * only the fetch itself is gated by the global request budget so cache
     * hits stay free.
     * @param personId
     * @param itemId (optional, for calculating age at release)
     */
    async function getPersonInfo(
        personId: string,
        itemId: string | null = null,
    ): Promise<{ data: PersonData | null; cacheChanged: boolean; failed: boolean }> {
        if (!isCurrent()) return { data: null, cacheChanged: false, failed: false };
        const cacheKey = itemId ? `${personId}-${itemId}` : personId;
        const now = Date.now();

        // Check in-memory cache first
        if (hotPeopleTags.has(cacheKey)) {
            const cached = hotPeopleTags.get(cacheKey)!;
            if (isCurrent() && now - cached.timestamp < CACHE_TTL) {
                return { data: cached.data, cacheChanged: false, failed: false };
            }
        }

        // Check localStorage cache
        if (peopleCache[cacheKey] && peopleCacheTimestamp[cacheKey]) {
            if (now - peopleCacheTimestamp[cacheKey] < CACHE_TTL) {
                if (!isCurrent()) return { data: null, cacheChanged: false, failed: false };
                const data = JC.identity.own(peopleCache[cacheKey], context);
                peopleCache[cacheKey] = data;
                hotPeopleTags.set(cacheKey, { data, timestamp: now });
                return { data, cacheChanged: false, failed: false };
            }
        }

        // Fetch from backend under the GLOBAL request budget so the total
        // number of concurrent /person calls across all generations stays
        // within PEOPLE_TAGS_CONCURRENCY. Only the network round-trip holds a
        // permit; the finally guarantees the permit is returned even when the
        // batch has been retired mid-flight.
        await peopleTagsRequestGate.acquire();
        try {
            // The setting or identity may have changed while this worker was
            // queued behind another generation's global request permits.
            if (!isCurrent()) return { data: null, cacheChanged: false, failed: false };
            const queryString = itemId ? `?itemId=${encodeURIComponent(itemId)}` : '';
            const data = await JC.core.api.plugin(`/person/${encodeURIComponent(personId)}${queryString}`, {
                cacheKey: `people-tags:${cacheKey}`,
            });
            if (!isCurrent()) return { data: null, cacheChanged: false, failed: false };

            if (isPersonData(data)) {
                // Cache it (hot + in-memory now; persisted once per settled batch)
                const ownedData = JC.identity.own(data, context);
                peopleCache[cacheKey] = ownedData;
                peopleCacheTimestamp[cacheKey] = now;
                hotPeopleTags.set(cacheKey, { data: ownedData, timestamp: now });

                return { data: ownedData, cacheChanged: true, failed: false };
            }
            // Well-formed but empty/non-person response: genuine no-data.
            return { data: null, cacheChanged: false, failed: false };
        } catch (error) {
            if (isCurrent()) console.warn(`${logPrefix} Failed to fetch person info for ${personId}:`, error);
            // Transient failure — let the projection owner leave every card
            // unprocessed so a later pass can recover once the backend is healthy.
            return { data: null, cacheChanged: false, failed: true };
        } finally {
            peopleTagsRequestGate.release();
        }
    }

    /**
     * Serialize the persistent people cache exactly once for a settled batch.
     * Only called when at least one backend fetch changed the cache and the
     * identity context is still current.
     */
    function persistPeopleCache(): void {
        if (!isCurrent()) return;
        JC.storage.local.write('people-tags', CACHE_OWNER_KEY, expectedCacheOwner, 'cache-owner');
        JC.storage.local.write('people-tags', CACHE_KEY, JSON.stringify(peopleCache), 'cache-payload');
        JC.storage.local.write('people-tags', CACHE_TIMESTAMP_KEY, JSON.stringify(peopleCacheTimestamp), 'cache-timestamps');
    }

    /**
     * Create one age chip (deceased / current / at-release share markup).
     * @param variant - Suffix for the chip class (deceased|current|release)
     * @param background - Chip background color
     * @param iconName - Material Symbols icon name
     * @param age - Age value to display
     */
    function createAgeChip(variant: string, background: string, iconName: string, age: number): HTMLElement {
        const ageChip = document.createElement('div');
        ageChip.className = `jc-people-age-chip jc-people-age-${variant}`;
        ageChip.style.cssText = `
            display: flex;
            align-items: center;
            gap: 4px;
            background: ${background};
            padding: 3px 8px;
            border-radius: 3px;
            font-size: 11px;
            font-weight: 500;
            color: white;
            box-shadow: 0 1px 3px rgba(0,0,0,0.3);
        `;

        const icon = document.createElement('span');
        icon.className = 'material-symbols-rounded jc-people-age-icon';
        icon.textContent = iconName;
        icon.style.cssText = 'font-size: 13px;';
        ageChip.appendChild(icon);

        const text = document.createElement('span');
        text.className = 'jc-people-age-text';
        text.textContent = `${age}y`;
        ageChip.appendChild(text);

        return ageChip;
    }

    /**
     * Create people tag chips in top-left corner and birthplace banner at bottom
     * @returns Object with ageContainer and placeContainer elements
     */
    function createPeopleTag(personData: PersonData): { ageContainer: HTMLElement; placeContainer: HTMLElement } {
        // Age chips container (top-left)
        const ageContainer = document.createElement('div');
        ageContainer.className = 'jc-people-age-container';
        ageContainer.dataset.jcIdentityOwned = 'true';
        JC.identity.own(ageContainer, context);
        ageContainer.style.cssText = `
            position: absolute;
            top: 8px;
            left: 8px;
            display: flex;
            flex-direction: column;
            gap: 4px;
            align-items: flex-start;
            z-index: 3;
            pointer-events: none;
        `;

        // Current age or age at death chip
        if (personData.isDeceased && personData.ageAtDeath !== null && personData.ageAtDeath !== undefined) {
            ageContainer.appendChild(createAgeChip('deceased', 'rgba(180, 50, 50, 0.85)', 'event_busy', personData.ageAtDeath));
        } else if (personData.currentAge !== null && personData.currentAge !== undefined) {
            ageContainer.appendChild(createAgeChip('current', 'rgba(100, 170, 100, 0.85)', 'cake', personData.currentAge));
        }

        // Age at item release chip
        if (personData.ageAtItemRelease !== null && personData.ageAtItemRelease !== undefined) {
            ageContainer.appendChild(createAgeChip('release', 'rgba(70, 130, 180, 0.85)', 'movie', personData.ageAtItemRelease));
        }

        // Birthplace banner (bottom of card)
        const placeContainer = document.createElement('div');
        placeContainer.className = 'jc-people-place-banner';
        placeContainer.dataset.jcIdentityOwned = 'true';
        JC.identity.own(placeContainer, context);
        placeContainer.style.cssText = `
            position: absolute;
            bottom: 0;
            left: 0;
            right: 0;
            background: linear-gradient(to top, rgba(0,0,0,0.9), rgba(0,0,0,0.7), transparent);
            padding: 12px 8px 8px 8px;
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 11px;
            color: white;
            z-index: 1;
            pointer-events: none;
        `;

        if (personData.birthPlace) {
            // Extract country code from birthplace
            const countryCode = getCountryCodeFromBirthPlace(personData.birthPlace);

            // Country flag PNG — PERF(R6): no remote assets, served from the local asset cache.
            if (countryCode) {
                const flagImg = document.createElement('img');
                flagImg.className = 'jc-people-flag';
                flagImg.src = flagPngUrl(countryCode);
                flagImg.style.cssText = 'width: 16px; height: 12px; border-radius: 2px; object-fit: cover;';
                flagImg.alt = countryCode;
                placeContainer.appendChild(flagImg);
            }

            const locationIcon = document.createElement('span');
            locationIcon.className = 'material-symbols-rounded jc-people-place-icon';
            locationIcon.textContent = 'place';
            locationIcon.style.cssText = 'font-size: 14px; opacity: 0.9;';
            placeContainer.appendChild(locationIcon);

            const placeText = document.createElement('span');
            placeText.className = 'jc-people-place-text';
            placeText.textContent = personData.birthPlace;
            placeText.style.cssText = 'overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; opacity: 0.95;';
            placeText.title = personData.birthPlace;
            placeContainer.appendChild(placeText);
        }

        return { ageContainer, placeContainer };
    }

    interface PersonCardTask {
        cards: HTMLElement[];
        personId: string;
    }

    /**
     * Synchronously collect the unprocessed person-card tasks of one
     * cast/guest cast collapsible section within the OWNED visible page.
     *
     * PERF(#359/#361) fetch dedup and render completion have different owners:
     *  - `claimedTasks` groups every unprocessed card occurrence by person id,
     *    so the batch performs one lookup even when the same person appears
     *    repeatedly within cast or across cast/guest sections.
     *  - `processedCastMembers` records completion per concrete card only after
     *    a definitive result is applied. A later duplicate or React replacement
     *    therefore reuses the hot/persistent person result and still receives
     *    its own overlay instead of being skipped by a person-id render gate.
     * @param page - The owned visible details page to search within.
     * @param collapsibleSelector - CSS selector for the collapsible (e.g., '#castCollapsible' or '#guestCastCollapsible')
     * @param claimedTasks - Unique lookup tasks already claimed by this batch.
     */
    function collectSectionTasks(
        page: HTMLElement,
        collapsibleSelector: string,
        claimedTasks: Map<string, PersonCardTask>,
    ): PersonCardTask[] {
        const tasks: PersonCardTask[] = [];
        const collapsible = page.querySelector(collapsibleSelector);
        if (!collapsible) return tasks;

        const castCards = collapsible.querySelectorAll<HTMLElement>('.personCard');
        if (castCards.length === 0) return tasks;

        console.debug(`${logPrefix} Found ${castCards.length} cast members in ${collapsibleSelector}`);

        for (const card of castCards) {
            if (processedCastMembers.has(card)) continue;

            const personId = card.getAttribute('data-id');
            if (!personId) continue;

            const claimed = claimedTasks.get(personId);
            if (claimed) {
                claimed.cards.push(card);
                continue;
            }

            const task = { cards: [card], personId };
            claimedTasks.set(personId, task);
            tasks.push(task);
        }
        return tasks;
    }

    /**
     * Deterministically interleave the (already deduplicated) cast and guest
     * cast task lists so a guest-cast card enters the first bounded worker
     * wave even when the normal cast alone exceeds the concurrency cap.
     */
    function interleaveTasks(castTasks: PersonCardTask[], guestTasks: PersonCardTask[]): PersonCardTask[] {
        const merged: PersonCardTask[] = [];
        const longest = Math.max(castTasks.length, guestTasks.length);
        for (let index = 0; index < longest; index += 1) {
            if (index < castTasks.length) merged.push(castTasks[index]);
            if (index < guestTasks.length) merged.push(guestTasks[index]);
        }
        return merged;
    }

    interface PersonCardOutcome {
        /** Whether the lookup changed the persistent cache state. */
        cacheChanged: boolean;
        /** Whether every still-unprocessed occurrence needs a bounded retry. */
        transientFailure: boolean;
    }

    /**
     * Fetch one person's data and project it onto every matching card collected
     * for this batch. Each application independently preserves the identity,
     * owned-page, item, and connectivity guards; only a concrete card that
     * receives a definitive current result is marked complete.
     */
    async function processPersonCards(
        task: PersonCardTask,
        currentItemId: string,
        batchIsCurrent: () => boolean,
    ): Promise<PersonCardOutcome> {
        const { cards, personId } = task;
        try {
            const { data: personData, cacheChanged, failed } = await getPersonInfo(personId, currentItemId);
            if (!batchIsCurrent()) return { cacheChanged, transientFailure: false };
            // A transient fetch failure is NOT a definitive no-data result:
            // keep every concrete card unprocessed so a remembered observer
            // pass can retry the same live elements after recovery.
            if (failed) return { cacheChanged, transientFailure: true };

            for (const card of cards) {
                if (!batchIsCurrent()) break;
                if (!card.isConnected) continue;

                // A genuine no-data result is definitive for this occurrence.
                if (!personData) {
                    processedCastMembers.add(card);
                    continue;
                }

                try {
                    // Apply deceased styling to poster if applicable.
                    if (personData.isDeceased) {
                        card.classList.add('jc-deceased-poster');
                        console.debug(`${logPrefix} Marked ${personId} as deceased`);
                    }

                    // Find the image container with position: relative.
                    const cardScalable = card.querySelector('.cardScalable');
                    if (!cardScalable) {
                        console.warn(`${logPrefix} No cardScalable found for ${personId}`);
                        // React may have mounted the person-card shell before
                        // its scalable image anchor. This data-bearing card is
                        // NOT complete; a relevant descendant mutation will
                        // re-project the hot result once the anchor exists.
                        continue;
                    }

                    // Remove existing tags if any.
                    cardScalable.querySelector('.jc-people-age-container')?.remove();
                    cardScalable.querySelector('.jc-people-place-banner')?.remove();

                    // Create and append age chips (top-left) and place banner (bottom).
                    const tags = createPeopleTag(personData);
                    if (!batchIsCurrent() || !cardScalable.isConnected) continue;
                    if (tags.ageContainer.children.length > 0) {
                        cardScalable.appendChild(tags.ageContainer);
                    }
                    if (tags.placeContainer.children.length > 0) {
                        cardScalable.appendChild(tags.placeContainer);
                    }
                    processedCastMembers.add(card);
                } catch (error) {
                    console.warn(`${logPrefix} Error projecting cast member ${personId}:`, error);
                }
            }
            return { cacheChanged, transientFailure: false };
        } catch (error) {
            console.warn(`${logPrefix} Error processing cast member ${personId}:`, error);
            return { cacheChanged: false, transientFailure: true };
        }
    }

    interface CastMembersOutcome {
        transientFailure: boolean;
    }

    /**
     * Process cast and guest cast members in the current view.
     *
     * PERF(#359): person lookups drain through ONE bounded worker pool shared
     * by both sections (the repo's fixed-size worker/cursor pattern — see
     * enrichIssuesForDisplay and processFallbackBatch) instead of a serial
     * await-per-card loop with a hard cast→guest barrier. Each overlay still
     * renders individually as its result lands; the persistent cache is
     * flushed once after the whole batch settles.
     */
    async function processCastMembers(
        page: HTMLElement,
        currentItemId: string,
    ): Promise<CastMembersOutcome> {
        if (!isCurrent() || isProcessing) return { transientFailure: false };
        isProcessing = true;
        let transientFailure = false;

        try {
            // Collect both sections synchronously from the OWNED page. Cast is
            // collected first so the first normal-cast occurrence owns a
            // shared person's task position; every later occurrence joins its
            // card list. Unique cast/guest tasks are then interleaved so neither
            // section starves behind the other.
            const claimedTasks = new Map<string, PersonCardTask>();
            const tasks = interleaveTasks(
                collectSectionTasks(page, '#castCollapsible', claimedTasks),
                collectSectionTasks(page, '#guestCastCollapsible', claimedTasks),
            );
            if (tasks.length === 0) return { transientFailure: false };

            // The batch is current only while the SAME owned page is still the
            // visible details view for the SAME item. getVisibleDetailsPage()
            // returns null mid-transition (details→details push), so the batch
            // aborts rather than tagging the outgoing view under the incoming
            // item's id.
            const batchIsCurrent = (): boolean => pageScopeIsCurrent(page, currentItemId);

            let cacheChanged = false;
            let nextIndex = 0;
            const worker = async (): Promise<void> => {
                while (batchIsCurrent()) {
                    const index = nextIndex;
                    nextIndex += 1;
                    if (index >= tasks.length) return;
                    const task = tasks[index];
                    const outcome = await processPersonCards(task, currentItemId, batchIsCurrent);
                    // Persist if ANY task changed the cache (aggregate-any, not
                    // last-write-wins — a later cache HIT must not erase an
                    // earlier fetch's need to flush).
                    if (outcome.cacheChanged) cacheChanged = true;
                    if (outcome.transientFailure) transientFailure = true;
                }
            };
            const workerCount = Math.min(PEOPLE_TAGS_CONCURRENCY, tasks.length);
            await Promise.all(Array.from({ length: workerCount }, () => worker()));

            // One persistent-cache serialization per settled batch (was once
            // per person = O(N^2) across a cast).
            if (cacheChanged && isCurrent()) persistPeopleCache();

            return { transientFailure };

        } catch (error) {
            if (isCurrent()) console.error(`${logPrefix} Error in processCastMembers:`, error);
            return { transientFailure: true };
        } finally {
            if (generationIsCurrent()) isProcessing = false;
        }
    }

    /**
     * Main initialization using proper page navigation hooks
     */
    function initialize(): void {
        console.debug(`${logPrefix} Initializing with managed observer pattern`);

        // Handle item details page display with an identity-owned debounce.
        // A helper-owned timeout cannot be cancelled synchronously on logout.
        let debounceTimer: number | null = null;

        const clearDebounceTimer = (): void => {
            if (debounceTimer === null) return;
            clearTimeout(debounceTimer);
            timers.delete(debounceTimer);
            debounceTimer = null;
        };

        const documentIsVisible = (): boolean => document.visibilityState !== 'hidden';

        /** Keep one listener only while a retry ladder owns a page/item. */
        function ensureRetryVisibilityListener(): void {
            if (retryVisibilityListener !== null) return;
            retryVisibilityListener = () => {
                const page = retryPage;
                const itemId = retryItemId;
                if (!page || !itemId || !pageScopeIsCurrent(page, itemId)) {
                    resetRetryLadder();
                    return;
                }
                if (!documentIsVisible()) {
                    // Hidden time does not count down a partially elapsed
                    // backoff. Visibility resumes this SAME entry in full.
                    clearRetryTimer();
                    return;
                }
                if (retryWaiting && retryTimer === null) armRetryTimer(page, itemId);
            };
            document.addEventListener('visibilitychange', retryVisibilityListener);
        }

        /** Arm the current unconsumed ladder entry, but only while visible. */
        function armRetryTimer(page: HTMLElement, itemId: string): void {
            if (!retryWaiting || retryTimer !== null) return;
            if (!retryScopeMatches(page, itemId) || !pageScopeIsCurrent(page, itemId)) {
                resetRetryLadder();
                return;
            }
            ensureRetryVisibilityListener();
            if (!documentIsVisible()) return;

            const delay = PEOPLE_TAGS_RETRY_DELAYS_MS[retryAttempts];
            retryTimer = schedule(() => {
                retryTimer = null;
                if (!retryWaiting || !retryScopeMatches(page, itemId)
                    || !pageScopeIsCurrent(page, itemId)) {
                    resetRetryLadder();
                    return;
                }
                // A visibilitychange normally cancels this timer immediately.
                // Recheck at the boundary for hosts that update visibilityState
                // before delivering the event; the entry remains unconsumed.
                if (!documentIsVisible()) return;

                retryWaiting = false;
                retryAttempts += 1;
                peopleTagsComplete = false;
                runPeopleTags();
            }, delay);
        }

        /** Arm at most one automatic retry for the current page/item scope. */
        const scheduleTransientRetry = (page: HTMLElement, itemId: string): void => {
            if (!pageScopeIsCurrent(page, itemId)) {
                if (retryScopeMatches(page, itemId)) resetRetryLadder();
                return;
            }
            if (!retryScopeMatches(page, itemId)) {
                resetRetryLadder();
                retryPage = page;
                retryItemId = itemId;
            }
            if (retryWaiting) return;
            if (retryAttempts >= PEOPLE_TAGS_RETRY_DELAYS_MS.length) {
                clearRetryTimer();
                retryWaiting = false;
                removeRetryVisibilityListener();
                console.warn(`${logPrefix} Transient retry ladder exhausted for item ${itemId}`);
                // Preserve the exhausted count as the automatic-attempt cap.
                // Cards remain unprocessed; a future relevant mutation resets
                // the ladder and can recover after the backend is healthy.
                return;
            }

            retryWaiting = true;
            ensureRetryVisibilityListener();
            armRetryTimer(page, itemId);
        };

        function runPeopleTags(): void {
            if (!isCurrent()) {
                // A disabled feature may reach here from a timer already queued
                // by the formerly enabled generation. Retire its strong page
                // reference and visibility listener without issuing work.
                if (generationIsCurrent()) resetRetryLadder();
                return;
            }

            // Resolve the visible details page and its item id as ONE owned
            // pair. getVisibleDetailsPage() returns null mid-transition
            // (details→details push, where the OUTGOING page is still visible
            // while the URL already names the next item), so we never tag the
            // outgoing view under the incoming item's id — we defer, and the
            // next viewshow/mutation probe lands on the correct page.
            const visible = getVisibleDetailsPage();
            if (!visible) return;
            const { page, itemId } = visible;

            const castSection = page.querySelector('#castCollapsible');
            const guestCastSection = page.querySelector('#guestCastCollapsible');
            if (!castSection && !guestCastSection) {
                if (retryScopeMatches(page, itemId)) resetRetryLadder();
                return;
            }

            try {
                // Reset cache when navigating to a new item
                if (lastProcessedItemId !== itemId) {
                    resetRetryLadder();
                    lastProcessedItemId = itemId;
                    processedCastMembers = new WeakSet();
                    peopleTagsComplete = false;
                    console.debug(`${logPrefix} New item detected: ${itemId}`);
                }

                // Skip if already fully processed for this item.
                if (peopleTagsComplete) return;
                // A queued observer debounce can outlive the failed batch that
                // created the retry owner. It joins that counted attempt; it
                // must not start an immediate, uncounted request in parallel.
                if (retryScopeMatches(page, itemId) && retryWaiting) return;
                // A batch is already draining: remember that another pass is
                // owed (a late guest-cast mount, or a navigation to a new item)
                // and let the settling batch pick it up. Dropping it here is
                // what starved late sections and left the current page untagged.
                if (isProcessing) {
                    rerunRequested = true;
                    return;
                }

                // Process cast members for this item, then either drain a
                // pending rerun or mark complete after a short delay to allow
                // late-arriving DOM updates. Capture the itemId so stale
                // completions from previous navigations don't mark the wrong
                // item as done.
                const processingItemId = itemId;
                void processCastMembers(page, itemId).then((outcome) => {
                    if (!isCurrent()) {
                        // In-flight requests cannot be forcibly aborted through
                        // this API seam, but their result and retry owner are
                        // synchronously fenced once they settle.
                        if (generationIsCurrent()) resetRetryLadder();
                        return;
                    }
                    // Scope retirement owns ordering first. A remembered rerun
                    // on a DIFFERENT current page is still drained immediately;
                    // an old page can never install a ladder for the new one.
                    if (!pageScopeIsCurrent(page, processingItemId)) {
                        if (retryScopeMatches(page, processingItemId)) resetRetryLadder();
                        if (rerunRequested) {
                            rerunRequested = false;
                            runPeopleTags();
                        }
                        return;
                    }
                    if (outcome.transientFailure) {
                        // Failure accounting owns same-scope reruns. Every card
                        // added while this request was in flight is still live
                        // and will be collected by the next COUNTED snapshot.
                        // Cancel a not-yet-fired observer debounce for the same
                        // reason: it coalesces into this one retry owner.
                        rerunRequested = false;
                        clearDebounceTimer();
                        peopleTagsComplete = false;
                        scheduleTransientRetry(page, processingItemId);
                        return;
                    }

                    // A definitive settled pass ends any prior failure ladder.
                    resetRetryLadder();
                    // Definitive data may have landed while a new card mounted.
                    // Its concrete occurrence was not in the settled snapshot,
                    // so drain that owed projection now (the hot result is free).
                    if (rerunRequested) {
                        rerunRequested = false;
                        runPeopleTags();
                        return;
                    }
                    schedule(() => {
                        // Only mark complete when NOTHING is still running or
                        // owed. A completion timer scheduled by an earlier batch
                        // must not fire while a newer batch drains (or a rerun
                        // is pending) — doing so wedges the peopleTagsComplete
                        // gate and starves cards that mount mid-batch. A pending
                        // debounce (a freshly observed cast/guest update not yet
                        // dispatched) counts as owed work too: completing over it
                        // would make that queued run return early and leave the
                        // newly mounted section untagged.
                        if (isCurrent() && !isProcessing && !rerunRequested
                            && debounceTimer === null
                            && retryTimer === null
                            && !retryWaiting
                            && lastProcessedItemId === processingItemId) {
                            peopleTagsComplete = true;
                        }
                    }, 2000);
                });
            } catch (e) {
                // Ignore errors (likely not on an item page)
            }
        }
        const handlePeopleTags = () => {
            if (!isCurrent()) return;
            clearDebounceTimer();
            debounceTimer = schedule(() => {
                debounceTimer = null;
                runPeopleTags();
            }, 100);
        };

        /**
         * One resumable ownership-first scan. `mutations` and TreeWalker keep
         * their exact cursor positions across zero-delay slices; no selector
         * query ever runs against an arbitrary added body subtree.
         */
        interface ObserverScanCursor {
            page: HTMLElement;
            itemId: string;
            sections: Element[];
            mutations: MutationRecord[];
            mutationIndex: number;
            addedNodeIndex: number;
            pendingRoots: Element[];
            seenRoots: WeakSet<Element>;
            walker: TreeWalker | null;
        }

        type ObserverScanResult = 'complete' | 'overflow' | 'relevant';
        const pendingObserverScans: ObserverScanCursor[] = [];
        let observerScanTimer: number | null = null;

        const clearPendingObserverScans = (): void => {
            if (observerScanTimer !== null) {
                clearTimeout(observerScanTimer);
                timers.delete(observerScanTimer);
            }
            observerScanTimer = null;
            pendingObserverScans.length = 0;
        };
        cancelPendingObserverScan = clearPendingObserverScans;

        const cardBelongsToScan = (cursor: ObserverScanCursor, card: HTMLElement): boolean =>
            cursor.page.contains(card) && cursor.sections.some((section) => section.contains(card));

        const classifyObserverElement = (cursor: ObserverScanCursor, element: Element): boolean => {
            if (element.matches('.personCard')
                && cardBelongsToScan(cursor, element as HTMLElement)) {
                return true;
            }
            if (!element.matches('.cardScalable')) return false;
            const card = element.closest<HTMLElement>('.personCard');
            if (!card || !cardBelongsToScan(cursor, card)) return false;
            // A replacement/late anchor makes completion concrete again. This
            // is harmless for a whole new card (it is absent from the WeakSet)
            // and necessary for a previously completed shell.
            processedCastMembers.delete(card);
            return true;
        };

        /** Consume one added node (or mutation boundary) and queue owned roots. */
        const queueNextOwnedRoots = (cursor: ObserverScanCursor): 'advanced' | 'done' => {
            if (cursor.mutationIndex >= cursor.mutations.length) return 'done';
            const mutation = cursor.mutations[cursor.mutationIndex];
            if (cursor.addedNodeIndex >= mutation.addedNodes.length) {
                cursor.mutationIndex += 1;
                cursor.addedNodeIndex = 0;
                return 'advanced';
            }

            const node = mutation.addedNodes[cursor.addedNodeIndex];
            cursor.addedNodeIndex += 1;
            if (!(node instanceof Element)) return 'advanced';

            // Structural narrowing happens BEFORE descendant traversal. An
            // added descendant scans itself; an added page/wrapper scans only
            // the concrete cast section(s) it contains. An unrelated subtree
            // is rejected here in O(number of owned sections).
            for (const section of cursor.sections) {
                let root: Element | null = null;
                if (node === section || section.contains(node)) root = node;
                else if (node.contains(section)) root = section;
                if (root !== null && !cursor.seenRoots.has(root)) cursor.pendingRoots.push(root);
            }
            return 'advanced';
        };

        const drainObserverScan = (cursor: ObserverScanCursor): ObserverScanResult => {
            if (!pageScopeIsCurrent(cursor.page, cursor.itemId)) return 'complete';
            const startedAt = performance.now();
            let didWork = false;

            while (true) {
                if (didWork && performance.now() - startedAt >= PEOPLE_TAGS_OBSERVER_SCAN_BUDGET_MS) {
                    return 'overflow';
                }

                if (cursor.walker !== null) {
                    const element = cursor.walker.nextNode() as Element | null;
                    didWork = true;
                    if (element === null) {
                        cursor.walker = null;
                        continue;
                    }
                    if (classifyObserverElement(cursor, element)) return 'relevant';
                    continue;
                }

                const root = cursor.pendingRoots.pop();
                if (root) {
                    didWork = true;
                    if (cursor.seenRoots.has(root) || !cursor.page.contains(root)) continue;
                    cursor.seenRoots.add(root);
                    cursor.walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
                    if (classifyObserverElement(cursor, root)) return 'relevant';
                    continue;
                }

                const progress = queueNextOwnedRoots(cursor);
                if (progress === 'done') return 'complete';
                didWork = true;
            }
        };

        const handleRelevantAddition = (page: HTMLElement, itemId: string): void => {
            if (!pageScopeIsCurrent(page, itemId)) return;
            clearPendingObserverScans();
            peopleTagsComplete = false;
            const matchesRetryScope = retryScopeMatches(page, itemId);
            const retryExhausted = matchesRetryScope
                && !retryWaiting
                && retryAttempts >= PEOPLE_TAGS_RETRY_DELAYS_MS.length;
            if ((retryPage !== null && !matchesRetryScope) || retryExhausted) {
                resetRetryLadder();
            } else if (matchesRetryScope && retryWaiting) {
                // Timer-backed and hidden visibility-backed waits are the same
                // owner: the new card joins its next counted snapshot.
                return;
            }
            handlePeopleTags();
        };

        const scheduleObserverScanContinuation = (): void => {
            if (observerScanTimer !== null || pendingObserverScans.length === 0) return;
            observerScanTimer = schedule(() => {
                observerScanTimer = null;
                if (!isCurrent()) {
                    clearPendingObserverScans();
                    return;
                }
                const cursor = pendingObserverScans[0];
                if (!cursor) return;
                const result = drainObserverScan(cursor);
                if (result === 'relevant') {
                    handleRelevantAddition(cursor.page, cursor.itemId);
                    return;
                }
                if (result === 'complete') pendingObserverScans.shift();
                scheduleObserverScanContinuation();
            }, 0);
        };

        const inspectRelevantAdditions = (
            mutations: MutationRecord[],
            page: HTMLElement,
            itemId: string,
            castSection: Element | null,
            guestCastSection: Element | null,
        ): void => {
            const sections = [castSection, guestCastSection].filter((section): section is Element => section !== null);
            const cursor: ObserverScanCursor = {
                page,
                itemId,
                sections,
                mutations,
                mutationIndex: 0,
                addedNodeIndex: 0,
                pendingRoots: [],
                seenRoots: new WeakSet<Element>(),
                walker: null,
            };
            const result = drainObserverScan(cursor);
            if (result === 'relevant') {
                handleRelevantAddition(page, itemId);
            } else if (result === 'overflow') {
                pendingObserverScans.push(cursor);
                scheduleObserverScanContinuation();
            }
        };

        // Create managed observer for people tags.
        // Only watches childList (not attributes) to avoid firing on every hover
        // class/style change. Cast sections appear via childList mutations.
        observerHandle = JC.helpers.createObserver(
            'people-tags',
            (mutations) => {
                if (!generationIsCurrent()) return;
                if (!isCurrent()) {
                    clearDebounceTimer();
                    clearPendingObserverScans();
                    resetRetryLadder();
                    rerunRequested = false;
                    peopleTagsComplete = false;
                    return;
                }

                // Navigation owns every queued callback, including the NULL id
                // of details→non-details. Release the old page strongly held by
                // an active OR exhausted retry and discard traversal/debounce
                // cursors before probing whether the new route has cast work.
                try {
                    const currentId = getItemIdFromUrl();
                    if (currentId !== lastProcessedItemId) {
                        clearDebounceTimer();
                        clearPendingObserverScans();
                        resetRetryLadder();
                        rerunRequested = false;
                        peopleTagsComplete = false;
                        if (currentId === null) {
                            lastProcessedItemId = null;
                            processedCastMembers = new WeakSet();
                            return;
                        }
                    }
                } catch {}

                // Resolve the owned visible page (duplicate-id safe; null
                // mid-transition). runPeopleTags re-resolves the same pair, so
                // this is only a cheap gate to avoid scheduling a debounce when
                // there is nothing to tag.
                const visible = getVisibleDetailsPage();
                if (!visible) return;
                const castSection = visible.page.querySelector('#castCollapsible');
                const guestCastSection = visible.page.querySelector('#guestCastCollapsible');
                if (!castSection && !guestCastSection) return;

                inspectRelevantAdditions(
                    mutations,
                    visible.page,
                    visible.itemId,
                    castSection,
                    guestCastSection,
                );
            },
            document.body,
            {
                childList: true,
                subtree: true
            }
        );

        // R9/#361: activation or a same-identity/config restart can occur after
        // Jellyfin has already mounted the cast. Schedule one owned-page pass
        // after observation begins so those cards cannot depend on an unrelated
        // future body mutation; the normal debounce coalesces any simultaneous
        // cast mount into this same bounded snapshot.
        handlePeopleTags();

        console.debug(`${logPrefix} Initialization complete`);
    }

    initialize();
}

const stablePeopleTags = createStableMethodFacade({
    initialize: (): void => {},
});

/** Install the frozen people-tags initializer for one cluster activation. */
export function installPeopleTagsFacade(): () => void {
    const uninstall = stablePeopleTags.install({ initialize: initializePeopleTags });
    JC.initializePeopleTags = stablePeopleTags.facade.initialize;
    return uninstall;
}
