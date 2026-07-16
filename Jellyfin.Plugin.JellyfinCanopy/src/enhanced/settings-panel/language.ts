// src/enhanced/settings-panel/language.ts
//
// Display-language selector (locale enumeration + persistence) and the
// clear-translation-cache button in the settings panel.
// Split from ui.js (code motion; bodies verbatim).
// (Converted from js/enhanced/ui-panel-language.js — bodies semantically identical.)

import { JC } from '../../globals';
import { toast } from '../../core/ui-kit';
import type { PanelContext } from './panel';
import type { IdentityContext } from '../../types/jc';

/* eslint-disable @typescript-eslint/no-explicit-any */

const reloadTimers = new Set<number>();

function scheduleReload(context: IdentityContext, delay: number): void {
    const timer = window.setTimeout(() => {
        reloadTimers.delete(timer);
        if (JC.identity.isCurrent(context)) window.location.reload();
    }, delay);
    reloadTimers.add(timer);
}

/**
 * Wires the language dropdown and translation-cache controls.
 * @param {object} ctx Shared panel context assembled in settings-panel/panel.ts.
 */
export function wireLanguageControls(ctx: PanelContext): void {
    const { resetAutoCloseTimer } = ctx;
    const context = JC.identity.capture();
    if (!context) return;

    // --- Language Settings ---
    const displayLanguageSelect = document.getElementById('displayLanguageSelect') as HTMLSelectElement | null;
    if (displayLanguageSelect) {
        // Get current user ID for localStorage key
        const userId = context.userId;
        const languageKey = `${userId}-language`;
        const scopedLanguageKey = `jc-display-language:${context.serverId}:${context.userId}`;

        // Get saved language from localStorage as well
        const storedLanguage = JC.storage.local.read('settings-language', scopedLanguageKey, 'scoped-language');
        const localStorageLang = storedLanguage.state === 'Valid' ? storedLanguage.value : null;
        const savedLanguage = (JC.currentSettings as any).displayLanguage || localStorageLang || '';
        let acknowledgedDisplayLanguage = String(savedLanguage);

        console.log('🪼 Jellyfin Canopy: Current language setting:', {
            fromSettings: (JC.currentSettings as any).displayLanguage,
            fromLocalStorage: localStorageLang,
            willUse: savedLanguage
        });

        // Populate language options from server-side locale enumeration
        void (async () => {
            const CUSTOM_DISPLAY_NAMES: Record<string, string> = {
                'pr': 'Pirate',
                'en-GB': 'English (United Kingdom)',
                'en-US': 'English (United States)',
                'zh-CN': 'Chinese (Simplified)',
                'zh-HK': 'Chinese (Hong Kong)',
                'pt-BR': 'Portuguese (Brazil)'
            };

            try {
                // PERF(R6/ENH-5): the server /JellyfinCanopy/locales endpoint is the
                // authoritative locale list for THIS build. The former per-open
                // api.github.com fetch pointed at the UPSTREAM repo (wrong key set),
                // leaked the client IP, and hit GitHub's 60/hr anonymous rate limit
                // (→ 403) — dropped entirely; no replacement needed.
                const [localeCodes, cultures]: [any, any] = await Promise.all([
                    JC.core.api!.plugin('/locales'),
                    JC.core.api!.jf('/Localization/Cultures'),
                ]);
                if (!JC.identity.isCurrent(context) || !displayLanguageSelect.isConnected) return;

                const cultureMap: Record<string, any> = {};
                cultures.forEach((c: any) => {
                    cultureMap[c.TwoLetterISOLanguageName.toLowerCase()] = c;
                });

                // Generic English is the fallback catalog, not a selectable
                // language alongside the en-GB and en-US variants.
                const selectableLocaleCodes = localeCodes.filter((code: any) => code !== 'en');
                const localeSet = new Set(selectableLocaleCodes.map((c: any) => c.toLowerCase()));
                const options = selectableLocaleCodes.map((code: any) => {
                    let displayName = CUSTOM_DISPLAY_NAMES[code]
                        || cultureMap[code.toLowerCase()]?.DisplayName;
                    if (!displayName && code.includes('-')) {
                        const baseName = cultureMap[code.split('-')[0].toLowerCase()]?.DisplayName;
                        // Append region qualifier when the base code also exists to avoid duplicate labels
                        displayName = baseName && localeSet.has(code.split('-')[0].toLowerCase())
                            ? `${baseName} (${code.split('-')[1]})`
                            : baseName;
                    }
                    return { code, displayName: displayName || code };
                });

                options.sort((a: any, b: any) => a.displayName.localeCompare(b.displayName));
                options.forEach(({ code, displayName }: any) => {
                    const option = document.createElement('option');
                    option.value = code;
                    option.textContent = displayName;
                    option.style.background = 'rgba(30,30,30,1)';
                    option.style.color = '#fff';
                    displayLanguageSelect.appendChild(option);
                });
            } catch (err) {
                if (!JC.identity.isCurrent(context)) return;
                console.warn('🪼 Jellyfin Canopy: Failed to load language options:', err);
            }

            if (!JC.identity.isCurrent(context) || !displayLanguageSelect.isConnected) return;

            // Normalize saved language code with region support (e.g., zh-HK) when available
            let normalizedLanguage = '';
            if (savedLanguage) {
                // Normalize the saved language to match dropdown format (e.g., en-GB, zh-HK)
                const normalizedSaved = savedLanguage.includes('-')
                    ? `${savedLanguage.split('-')[0].toLowerCase()}-${savedLanguage.split('-')[1].toUpperCase()}`
                    : savedLanguage.toLowerCase();

                const hasExactOption = Array.from(displayLanguageSelect.options)
                    .some(option => option.value.toLowerCase() === normalizedSaved.toLowerCase());
                normalizedLanguage = hasExactOption ? normalizedSaved : normalizedSaved.split('-')[0];
            }

            // Set the saved language after options are added
            if (normalizedLanguage) {
                displayLanguageSelect.value = normalizedLanguage;
            }
            acknowledgedDisplayLanguage = displayLanguageSelect.value;
            console.log('🪼 Jellyfin Canopy: Set language dropdown to:', savedLanguage || 'Auto', 'Normalized to:', normalizedLanguage, 'Select element value is now:', displayLanguageSelect.value);
        })();

        // Save language on change
        displayLanguageSelect.addEventListener('change', (e) => { void (async () => {
            if (!JC.identity.isCurrent(context)) return;
            const newLang = (e.target as HTMLSelectElement).value;
            const previousLang = acknowledgedDisplayLanguage;

            const normalizeLangCode = (code: string) => {
                if (!code) return code;
                const parts = code.split('-');
                if (parts.length === 1) return parts[0].toLowerCase();
                if (parts.length === 2) return `${parts[0].toLowerCase()}-${parts[1].toUpperCase()}`;
                return code;
            };

            // Use the language code as-is, no special mapping
            const fullCultureCode = normalizeLangCode(newLang);

            // All dropdown options come from /JellyfinCanopy/locales, so they are guaranteed valid
            const translationExists = true;

            // Save to settings.json (use base language code)
            (JC.currentSettings as any).displayLanguage = newLang;
            try {
                await JC.saveUserSettings!('settings.json', JC.currentSettings);
            } catch (error) {
                if (!JC.identity.isCurrent(context)) return;
                (e.target as HTMLSelectElement).value = previousLang;
                return;
            }
            if (!JC.identity.isCurrent(context)) return;
            acknowledgedDisplayLanguage = newLang;

            // Save to localStorage (use the same code)
            if (fullCultureCode) {
                JC.storage.local.write('settings-language', scopedLanguageKey, fullCultureCode, 'scoped-language');
                JC.storage.local.write('settings-language', languageKey, fullCultureCode, 'compatibility-language');
            } else {
                // Set empty value instead of removing key
                JC.storage.local.write('settings-language', scopedLanguageKey, '', 'scoped-language');
                JC.storage.local.write('settings-language', languageKey, '', 'compatibility-language');
            }

            if (newLang && !translationExists) {
                toast(`${JC.icon!(JC.IconName!.WARNING)} Translation file not available for selected language. Falling back to English.`);
            } else {
                toast(JC.t!('toast_language_changed'));
            }
            scheduleReload(context, 1500);
        })(); });
    }

    // Clear translation cache button
    const clearTranslationCacheButton = document.getElementById('clearTranslationCacheButton');
    if (clearTranslationCacheButton) {
        clearTranslationCacheButton.addEventListener('click', () => {
            if (!JC.identity.isCurrent(context)) return;
            const cacheKeys = [];
            const CACHE_PREFIX = 'JC_translation_';
            const CACHE_TIMESTAMP_PREFIX = 'JC_translation_ts_';

            const storedKeys = JC.storage.local.keys('settings-language', 'translation-cache-prefix');
            for (const key of storedKeys.value || []) {
                if (key && (key.startsWith(CACHE_PREFIX) || key.startsWith(CACHE_TIMESTAMP_PREFIX))) {
                    cacheKeys.push(key);
                }
            }

            let clearedCount = 0;
            for (const key of cacheKeys) {
                if (JC.storage.local.remove(
                    'settings-language', key, 'translation-cache-entry',
                ).state === 'Valid') {
                    clearedCount += 1;
                }
            }

            toast(JC.t!('toast_translation_cache_cleared', { count: Number(clearedCount) || 0 }));
            scheduleReload(context, 2000);
            resetAutoCloseTimer();
        });
    }
}

JC.identity.registerReset('settings-language', () => {
    for (const timer of reloadTimers) clearTimeout(timer);
    reloadTimers.clear();
});
