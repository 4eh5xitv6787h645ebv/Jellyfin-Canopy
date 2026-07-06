// src/enhanced/config.ts
//
// Manages plugin configuration, user settings, and shared state.
// (Converted from js/enhanced/config.js — bodies semantically identical.)

import { JE } from '../globals';
import type { UserSettings } from '../types/je';

/**
 * Constants derived from the plugin configuration.
 */
JE.CONFIG = {
    // Use getters so values always reflect the latest pluginConfig even if assigned later
    get TOAST_DURATION(): number { return ((JE.pluginConfig && JE.pluginConfig.ToastDuration) as number) || 1500; },
    get HELP_PANEL_AUTOCLOSE_DELAY(): number { return ((JE.pluginConfig && JE.pluginConfig.HelpPanelAutocloseDelay) as number) || 15000; }
};

/**
 * Shared state variables used across different components.
 */
JE.state = JE.state || {
    activeShortcuts: {},
    // { itemId, surface: 'continuewatching'|'nextup'|null, ts } captured on a menu trigger.
    removeContext: null,
    skipToastShown: false,
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

JE.saveUserSettings = async (fileName: string, settings: unknown): Promise<void> => {
    if (typeof ApiClient === 'undefined' || !ApiClient.getCurrentUserId) {
        console.error("🪼 Jellyfin Enhanced: ApiClient not available");
        return;
    }
    try {
        const userId = ApiClient.getCurrentUserId();
        if (!userId) {
            console.error("🪼 Jellyfin Enhanced: User ID not available");
            return;
        }

        // Fail LOUDLY on a no-arg / bad-fileName save instead of silently no-oping.
        // A call like saveUserSettings() serializes `undefined` and — for non-
        // settings.json files — hits the dedup guard below and returns without ever
        // POSTing, which is exactly how the pause-screen delay silently lost writes.
        if (!fileName || typeof settings === 'undefined') {
            console.error('🪼 Jellyfin Enhanced: saveUserSettings called without fileName/settings', { fileName });
            return;
        }

        // Convert data back to PascalCase for server C# deserialization
        let dataToSave: unknown = settings;
        if ((fileName === 'bookmark.json' || fileName === 'settings.json') && typeof window.JellyfinEnhanced?.toPascalCase === 'function') {
            dataToSave = window.JellyfinEnhanced.toPascalCase(settings);
        }

        const serialized = JSON.stringify(dataToSave);
        const cacheKey = `${userId}:${fileName}`;

        // For non-settings files, skip the POST if nothing has changed.
        // settings.json is exempt: loadSettings() merges defaults so the first
        // save per session will always differ from the raw server value — that
        // write-back is intentional and must not be suppressed.
        if (fileName !== 'settings.json' && _lastSavedJson[cacheKey] === serialized) {
            return; // no-op — identical to last save
        }

        await ApiClient.ajax({
            type: 'POST',
            url: ApiClient.getUrl(`/JellyfinEnhanced/user-settings/${userId}/${fileName}`),
            data: serialized,
            contentType: 'application/json'
        });

        // Update the cache on success so subsequent identical saves are skipped
        _lastSavedJson[cacheKey] = serialized;
    } catch (e) {
        console.error(`🪼 Jellyfin Enhanced: Failed to save ${fileName}:`, e);
    }
};

/**
 * Loads and merges settings from user config, plugin defaults, and hardcoded fallbacks.
 */
JE.loadSettings = (): UserSettings => {
    const userSettings: Record<string, unknown> = JE.userConfig?.settings || {};
    const pluginDefaults: Record<string, unknown> = JE.pluginConfig || {};

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
        } else if (Object.prototype.hasOwnProperty.call(pluginDefaults, key) && pluginDefaults[key] !== null && pluginDefaults[key] !== undefined) {
            mergedSettings[key] = pluginDefaults[key];
        } else {
            mergedSettings[key] = hardcodedDefaults[key];
        }
    }

    mergedSettings.displayLanguage = Object.prototype.hasOwnProperty.call(userSettings, 'displayLanguage')
        ? userSettings.displayLanguage
        : (pluginDefaults.DefaultLanguage || '');
    mergedSettings.lastOpenedTab = userSettings.lastOpenedTab || 'shortcuts';

    // Admin default → per-user default (camelCase merge above misses PascalCase from GetPublicConfig). Sticky once explicitly set.
    if (!Object.prototype.hasOwnProperty.call(userSettings, 'removeContinueWatchingEnabled')
        && pluginDefaults.RemoveContinueWatchingEnabled === true) {
        mergedSettings.removeContinueWatchingEnabled = true;
    }

    // Ensure isAdmin is always present (even if undefined) so it can be set later
    if (!Object.prototype.hasOwnProperty.call(mergedSettings, 'isAdmin')) {
        mergedSettings.isAdmin = userSettings.isAdmin !== undefined ? userSettings.isAdmin : undefined;
    }

    return mergedSettings;
};

/** Shape of a shortcut entry in plugin/user config. */
interface ShortcutEntry {
    Name?: string;
    Key?: string;
}

/**
 * Initializes keyboard shortcut mappings from plugin and user configurations.
 */
JE.initializeShortcuts = function (): void {
    const pluginDefaults = JE.pluginConfig || {};
    const userShortcutsConfig = JE.userConfig?.shortcuts || {};

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

    JE.state!.activeShortcuts = JE.state!.activeShortcuts || {};
    Object.assign(JE.state!.activeShortcuts, defaultShortcuts, userShortcuts);
};
