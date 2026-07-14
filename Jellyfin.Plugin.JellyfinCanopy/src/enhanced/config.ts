// src/enhanced/config.ts
//
// Manages plugin configuration, user settings, and shared state.
// (Converted from js/enhanced/config.js — bodies semantically identical.)

import { JC } from '../globals';
import type { UserSettings } from '../types/jc';
import { adminDefaultsView } from '../core/config-resolve';

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

/**
 * Saves user settings to the server.
 * For files other than settings.json, skips the POST if the data is identical
 * to the last saved value (prevents redundant writes for bookmarks, shortcuts etc.).
 * settings.json is always allowed through on the first save per session because
 * loadSettings() merges server data with defaults, so the merged result legitimately
 * differs from the raw stored value and must be written back.
 */
// Per-file cache of the last JSON string successfully sent to the server.
const _lastSavedJson: Record<string, string> = {};

function clearSaveDeduplication(): void {
    for (const key of Object.keys(_lastSavedJson)) delete _lastSavedJson[key];
}

// The loader installs identity before loading the bundle. Optional chaining is
// retained for isolated module tests which provide only the old bootstrap stub.
JC.identity?.registerReset?.('enhanced-config-writes', clearSaveDeduplication);

JC.saveUserSettings = async (fileName: string, settings: unknown): Promise<void> => {
    try {
        // Fail LOUDLY on a no-arg / bad-fileName save instead of silently no-oping.
        // A call like saveUserSettings() serializes `undefined` and — for non-
        // settings.json files — hits the dedup guard below and returns without ever
        // POSTing, which is exactly how the pause-screen delay silently lost writes.
        if (!fileName || typeof settings === 'undefined') {
            console.error('🪼 Jellyfin Canopy: saveUserSettings called without fileName/settings', { fileName });
            return;
        }

        const owner = JC.identity?.ownerOf?.(settings);
        if (!owner || !JC.identity.isCurrent(owner)) {
            console.error(`🪼 Jellyfin Canopy: Refusing to save ${fileName}; settings have no current identity owner`);
            return;
        }

        if (typeof ApiClient === 'undefined' || typeof ApiClient.getCurrentUserId !== 'function') {
            console.error("🪼 Jellyfin Canopy: ApiClient not available");
            return;
        }
        // The authentication hook normally transitions identity before the host
        // changes this value. Keep this independent check so a missed/foreign
        // ApiClient replacement still cannot send A's object with B's token.
        if (normalizeIdentityPart(ApiClient.getCurrentUserId()) !== owner.userId) {
            console.error(`🪼 Jellyfin Canopy: Refusing to save ${fileName}; live user does not own the settings`);
            return;
        }
        const liveServerId = liveApiClientServerId();
        if (!isResolvedServerId(owner.serverId)
            || !isResolvedServerId(liveServerId)
            || normalizeIdentityPart(liveServerId) !== normalizeIdentityPart(owner.serverId)) {
            console.error(`🪼 Jellyfin Canopy: Refusing to save ${fileName}; live server does not own the settings`);
            return;
        }

        // Convert data back to PascalCase for server C# deserialization
        let dataToSave: unknown = settings;
        if (typeof window.JellyfinCanopy?.toPascalCase === 'function') {
            if (fileName === 'bookmark.json') {
                // Mirror the load-side key preservation so bookmark ids (`Bm_…`)
                // keep their case on disk (save-side symmetry of LOADER-8).
                dataToSave = window.JellyfinCanopy.toPascalCase(settings, { preserveKey: (k: string) => /^bm_/i.test(k) });
            } else if (fileName === 'settings.json') {
                dataToSave = window.JellyfinCanopy.toPascalCase(settings);
            }
        }

        const serialized = JSON.stringify(dataToSave);
        const cacheKey = `${owner.serverId}:${owner.userId}:${fileName}`;

        // For non-settings files, skip the POST if nothing has changed.
        // settings.json is exempt: loadSettings() merges defaults so the first
        // save per session will always differ from the raw server value — that
        // write-back is intentional and must not be suppressed.
        if (fileName !== 'settings.json' && _lastSavedJson[cacheKey] === serialized) {
            return; // no-op — identical to last save
        }

        // No await occurs between this final owner check and ajax invocation.
        // Therefore an identity transition cannot interleave and substitute B's
        // authentication after we have authorized A's snapshot.
        if (!JC.identity.isCurrent(owner) || !JC.identity.isOwned(settings, owner)) return;

        // Production writes use the central identity-owned transport so a
        // transition aborts both queued and active A saves before B can run.
        // The fallback preserves isolated config-module tests/legacy embedding
        // where the core bundle has not installed JC.core.api yet.
        if (JC.core.api?.plugin) {
            await JC.core.api.plugin(`/user-settings/${owner.userId}/${fileName}`, {
                method: 'POST',
                body: serialized,
                headers: { 'Content-Type': 'application/json' },
                // Retrying a non-idempotent settings write can duplicate work.
                skipRetry: true
            });
        } else {
            await ApiClient.ajax({
                type: 'POST',
                url: ApiClient.getUrl(`/JellyfinCanopy/user-settings/${owner.userId}/${fileName}`),
                data: serialized,
                contentType: 'application/json'
            });
        }

        // A may have logged out while its request was in flight. Never publish
        // that acknowledgement into the new epoch's deduplication state.
        if (JC.identity.isCurrent(owner) && JC.identity.isOwned(settings, owner)) {
            _lastSavedJson[cacheKey] = serialized;
        }
    } catch (e) {
        // Identity/navigation teardown intentionally aborts the old owner's
        // transport. It is a successful fence, not a user-visible save error.
        if ((e as Error | null)?.name === 'AbortError') return;
        console.error(`🪼 Jellyfin Canopy: Failed to save ${fileName}:`, e);
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

    return JC.identity?.own?.(mergedSettings, context) || mergedSettings;
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
