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

let activePeopleTagsCleanup: ((clearPersistent: boolean) => void) | null = null;

function teardownPeopleTags(clearPersistent: boolean): void {
    const cleanup = activePeopleTagsCleanup;
    activePeopleTagsCleanup = null;
    try { cleanup?.(clearPersistent); } catch { /* continue */ }
    document.querySelectorAll('.jc-people-age-container, .jc-people-place-banner').forEach((node) => node.remove());
    document.querySelectorAll('.jc-deceased-poster').forEach((node) => node.classList.remove('jc-deceased-poster'));
}

export function resetPeopleTagsIdentity(): void {
    teardownPeopleTags(true);
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
    const isCurrent = (): boolean => JC.identity.isCurrent(context);
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
            if (isCurrent()) fn();
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
    let processedPersonIds = new Set<string>();
    let lastProcessedItemId: string | null = null;
    let peopleTagsComplete = false; // Set true after all cast members tagged for current item
    let isProcessing = false;

    activePeopleTagsCleanup = (clearPersistent) => {
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
     * settled-batch flush is required.
     * @param personId
     * @param itemId (optional, for calculating age at release)
     */
    async function getPersonInfo(
        personId: string,
        itemId: string | null = null,
    ): Promise<{ data: PersonData | null; cacheChanged: boolean }> {
        if (!isCurrent()) return { data: null, cacheChanged: false };
        const cacheKey = itemId ? `${personId}-${itemId}` : personId;
        const now = Date.now();

        // Check in-memory cache first
        if (hotPeopleTags.has(cacheKey)) {
            const cached = hotPeopleTags.get(cacheKey)!;
            if (isCurrent() && now - cached.timestamp < CACHE_TTL) {
                return { data: cached.data, cacheChanged: false };
            }
        }

        // Check localStorage cache
        if (peopleCache[cacheKey] && peopleCacheTimestamp[cacheKey]) {
            if (now - peopleCacheTimestamp[cacheKey] < CACHE_TTL) {
                if (!isCurrent()) return { data: null, cacheChanged: false };
                const data = JC.identity.own(peopleCache[cacheKey], context);
                peopleCache[cacheKey] = data;
                hotPeopleTags.set(cacheKey, { data, timestamp: now });
                return { data, cacheChanged: false };
            }
        }

        // Fetch from backend
        try {
            const queryString = itemId ? `?itemId=${encodeURIComponent(itemId)}` : '';
            const data = await JC.core.api.plugin(`/person/${encodeURIComponent(personId)}${queryString}`, {
                cacheKey: `people-tags:${cacheKey}`,
            });
            if (!isCurrent()) return { data: null, cacheChanged: false };

            if (isPersonData(data)) {
                // Cache it (hot + in-memory now; persisted once per settled batch)
                const ownedData = JC.identity.own(data, context);
                peopleCache[cacheKey] = ownedData;
                peopleCacheTimestamp[cacheKey] = now;
                hotPeopleTags.set(cacheKey, { data: ownedData, timestamp: now });

                return { data: ownedData, cacheChanged: true };
            }
        } catch (error) {
            if (isCurrent()) console.warn(`${logPrefix} Failed to fetch person info for ${personId}:`, error);
        }

        return { data: null, cacheChanged: false };
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
        card: HTMLElement;
        personId: string;
    }

    /**
     * Synchronously collect the unprocessed person-card tasks of one
     * cast/guest cast collapsible section, preserving the exact dedup gate
     * order of the old serial loop (card dedup, then person-id dedup).
     * @param collapsibleSelector - CSS selector for the collapsible (e.g., '#castCollapsible' or '#guestCastCollapsible')
     */
    function collectSectionTasks(collapsibleSelector: string): PersonCardTask[] {
        const tasks: PersonCardTask[] = [];
        const collapsible = document.querySelector(`#itemDetailPage:not(.hide) ${collapsibleSelector}`);
        if (!collapsible) return tasks;

        const castCards = collapsible.querySelectorAll<HTMLElement>('.personCard');
        if (castCards.length === 0) return tasks;

        console.debug(`${logPrefix} Found ${castCards.length} cast members in ${collapsibleSelector}`);

        for (const card of castCards) {
            if (processedCastMembers.has(card)) continue;
            processedCastMembers.add(card);

            const personId = card.getAttribute('data-id');
            if (!personId) continue;

            // Skip if we've already processed this person ID in this item
            if (processedPersonIds.has(personId)) continue;

            processedPersonIds.add(personId);
            tasks.push({ card, personId });
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

    /**
     * Fetch and render one person card's overlays. Result application is
     * guarded by identity currency, the live item id, and card connectivity —
     * a stale navigation mid-flight applies NO tags to the new page.
     * @returns Whether the lookup changed the persistent cache state.
     */
    async function processPersonCard(task: PersonCardTask, currentItemId: string): Promise<boolean> {
        const { card, personId } = task;
        const batchIsCurrent = (): boolean => isCurrent()
            && new URLSearchParams(window.location.hash.split('?')[1]).get('id') === currentItemId;
        try {
            const { data: personData, cacheChanged } = await getPersonInfo(personId, currentItemId);
            if (!batchIsCurrent() || !card.isConnected) return cacheChanged;
            if (!personData) return cacheChanged;

            // Apply deceased styling to poster if applicable
            if (personData.isDeceased) {
                card.classList.add('jc-deceased-poster');
                console.debug(`${logPrefix} Marked ${personId} as deceased`);
            }

            // Find the cardScalable element (image container with position: relative)
            const cardScalable = card.querySelector('.cardScalable');
            if (!cardScalable) {
                console.warn(`${logPrefix} No cardScalable found for ${personId}`);
                return cacheChanged;
            }

            // Remove existing tags if any
            const existingAgeContainer = cardScalable.querySelector('.jc-people-age-container');
            if (existingAgeContainer) {
                existingAgeContainer.remove();
            }
            const existingPlaceBanner = cardScalable.querySelector('.jc-people-place-banner');
            if (existingPlaceBanner) {
                existingPlaceBanner.remove();
            }

            // Create and append age chips (top-left) and place banner (bottom)
            const tags = createPeopleTag(personData);
            if (!batchIsCurrent() || !cardScalable.isConnected) return cacheChanged;
            if (tags.ageContainer.children.length > 0) {
                cardScalable.appendChild(tags.ageContainer);
            }
            if (tags.placeContainer.children.length > 0) {
                cardScalable.appendChild(tags.placeContainer);
            }
            return cacheChanged;
        } catch (error) {
            console.warn(`${logPrefix} Error processing cast member ${personId}:`, error);
            return false;
        }
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
    async function processCastMembers(): Promise<void> {
        if (!isCurrent() || isProcessing) return;
        isProcessing = true;

        try {
            // Get current item ID from URL
            const hash = window.location.hash;
            const params = new URLSearchParams(hash.split('?')[1]);
            const currentItemId = params.get('id');

            if (!currentItemId) {
                console.debug(`${logPrefix} No item ID found in URL`);
                return;
            }

            // Collect both sections synchronously (cast first so duplicate
            // person ids keep preferring the normal-cast card), then
            // interleave so neither section starves behind the other.
            const tasks = interleaveTasks(
                collectSectionTasks('#castCollapsible'),
                collectSectionTasks('#guestCastCollapsible'),
            );
            if (tasks.length === 0) return;

            const batchIsCurrent = (): boolean => isCurrent()
                && new URLSearchParams(window.location.hash.split('?')[1]).get('id') === currentItemId;

            let cacheChanged = false;
            let nextIndex = 0;
            const worker = async (): Promise<void> => {
                while (batchIsCurrent()) {
                    const index = nextIndex;
                    nextIndex += 1;
                    if (index >= tasks.length) return;
                    cacheChanged = (await processPersonCard(tasks[index], currentItemId)) || cacheChanged;
                }
            };
            const workerCount = Math.min(PEOPLE_TAGS_CONCURRENCY, tasks.length);
            await Promise.all(Array.from({ length: workerCount }, () => worker()));

            // One persistent-cache serialization per settled batch (was once
            // per person = O(N^2) across a cast).
            if (cacheChanged && isCurrent()) persistPeopleCache();

        } catch (error) {
            if (isCurrent()) console.error(`${logPrefix} Error in processCastMembers:`, error);
        } finally {
            if (isCurrent()) isProcessing = false;
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
        const runPeopleTags = () => {
            if (!isCurrent()) return;
            const castSection = document.querySelector('#itemDetailPage:not(.hide) #castCollapsible');
            const guestCastSection = document.querySelector('#itemDetailPage:not(.hide) #guestCastCollapsible');

            if (!castSection && !guestCastSection) return;

            try {
                const itemId = new URLSearchParams(window.location.hash.split('?')[1]).get('id');
                if (!itemId) return;

                // Reset cache when navigating to a new item
                if (lastProcessedItemId !== itemId) {
                    lastProcessedItemId = itemId;
                    processedCastMembers = new WeakSet();
                    processedPersonIds = new Set();
                    peopleTagsComplete = false;
                    console.debug(`${logPrefix} New item detected: ${itemId}`);
                }

                // Skip if already fully processed for this item
                if (peopleTagsComplete || isProcessing) {
                    return;
                }

                // Process cast members for this item, then mark complete
                // after a short delay to allow late-arriving DOM updates.
                // Capture the itemId so stale completions from previous
                // navigations don't mark the wrong item as done.
                const processingItemId = itemId;
                void processCastMembers().then(() => {
                    if (!isCurrent()) return;
                    schedule(() => {
                        if (isCurrent() && lastProcessedItemId === processingItemId) {
                            peopleTagsComplete = true;
                        }
                    }, 2000);
                });
            } catch (e) {
                // Ignore errors (likely not on an item page)
            }
        };
        const handlePeopleTags = () => {
            if (!isCurrent()) return;
            if (debounceTimer !== null) {
                clearTimeout(debounceTimer);
                timers.delete(debounceTimer);
            }
            debounceTimer = schedule(() => {
                debounceTimer = null;
                runPeopleTags();
            }, 100);
        };

        // Create managed observer for people tags.
        // Only watches childList (not attributes) to avoid firing on every hover
        // class/style change. Cast sections appear via childList mutations.
        observerHandle = JC.helpers.createObserver(
            'people-tags',
            (mutations) => {
                if (!isCurrent() || !JC.currentSettings?.peopleTagsEnabled) return;

                // Reset completion flag when navigating to a different item
                // (must happen BEFORE the peopleTagsComplete check)
                try {
                    const currentId = new URLSearchParams(window.location.hash.split('?')[1]).get('id');
                    if (currentId && currentId !== lastProcessedItemId) {
                        peopleTagsComplete = false;
                    }
                } catch {}

                if (peopleTagsComplete) return;

                // Quick check: only process if we're on a detail page
                if (!document.querySelector('#itemDetailPage:not(.hide)')) return;

                // Only react to actual node additions, not attribute changes
                let hasNewNodes = false;
                for (const mutation of mutations) {
                    if (mutation.addedNodes.length > 0) {
                        hasNewNodes = true;
                        break;
                    }
                }
                if (!hasNewNodes) return;

                const castSection = document.querySelector('#itemDetailPage:not(.hide) #castCollapsible');
                const guestCastSection = document.querySelector('#itemDetailPage:not(.hide) #guestCastCollapsible');
                if (!castSection && !guestCastSection) return;

                handlePeopleTags();
            },
            document.body,
            {
                childList: true,
                subtree: true
            }
        );

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
