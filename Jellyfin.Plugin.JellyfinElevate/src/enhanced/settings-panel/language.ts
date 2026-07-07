// src/enhanced/settings-panel/language.ts
//
// Display-language selector (locale enumeration + persistence) and the
// clear-translation-cache button in the settings panel.
// Split from ui.js (code motion; bodies verbatim).
// (Converted from js/enhanced/ui-panel-language.js — bodies semantically identical.)

import { JE } from '../../globals';
import { toast } from '../../core/ui-kit';
import type { PanelContext } from './panel';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Wires the language dropdown and translation-cache controls.
 * @param {object} ctx Shared panel context assembled in settings-panel/panel.ts.
 */
export function wireLanguageControls(ctx: PanelContext): void {
    const { resetAutoCloseTimer } = ctx;

    // --- Language Settings ---
    const displayLanguageSelect = document.getElementById('displayLanguageSelect') as HTMLSelectElement | null;
    if (displayLanguageSelect) {
        // Get current user ID for localStorage key
        const userId = ApiClient.getCurrentUserId();
        const languageKey = `${userId}-language`;

        // Get saved language from localStorage as well
        const localStorageLang = localStorage.getItem(languageKey);
        const savedLanguage = (JE.currentSettings as any).displayLanguage || localStorageLang || '';

        console.log('🪼 Jellyfin Elevate: Current language setting:', {
            fromSettings: (JE.currentSettings as any).displayLanguage,
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
                // PERF(R6/ENH-5): the server /JellyfinElevate/locales endpoint is the
                // authoritative locale list for THIS build. The former per-open
                // api.github.com fetch pointed at the UPSTREAM repo (wrong key set),
                // leaked the client IP, and hit GitHub's 60/hr anonymous rate limit
                // (→ 403) — dropped entirely; no replacement needed.
                const [localeCodes, cultures]: [any, any] = await Promise.all([
                    ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('/JellyfinElevate/locales'), dataType: 'json' }),
                    ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('/Localization/Cultures'), dataType: 'json' })
                ]);

                const cultureMap: Record<string, any> = {};
                cultures.forEach((c: any) => {
                    cultureMap[c.TwoLetterISOLanguageName.toLowerCase()] = c;
                });

                const localeSet = new Set(localeCodes.map((c: any) => c.toLowerCase()));
                const options = localeCodes.map((code: any) => {
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
                console.warn('🪼 Jellyfin Elevate: Failed to load language options:', err);
            }

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
            console.log('🪼 Jellyfin Elevate: Set language dropdown to:', savedLanguage || 'Auto', 'Normalized to:', normalizedLanguage, 'Select element value is now:', displayLanguageSelect.value);
        })();

        // Save language on change
        displayLanguageSelect.addEventListener('change', (e) => { void (async () => {
            const newLang = (e.target as HTMLSelectElement).value;

            const normalizeLangCode = (code: string) => {
                if (!code) return code;
                const parts = code.split('-');
                if (parts.length === 1) return parts[0].toLowerCase();
                if (parts.length === 2) return `${parts[0].toLowerCase()}-${parts[1].toUpperCase()}`;
                return code;
            };

            // Use the language code as-is, no special mapping
            const fullCultureCode = normalizeLangCode(newLang);

            // All dropdown options come from /JellyfinElevate/locales, so they are guaranteed valid
            const translationExists = true;

            // Save to settings.json (use base language code)
            (JE.currentSettings as any).displayLanguage = newLang;
            await JE.saveUserSettings!('settings.json', JE.currentSettings);

            // Save to localStorage (use the same code)
            if (fullCultureCode) {
                localStorage.setItem(languageKey, fullCultureCode);
            } else {
                // Set empty value instead of removing key
                localStorage.setItem(languageKey, '');
            }

            if (newLang && !translationExists) {
                toast(`${JE.icon!(JE.IconName!.WARNING)} Translation file not available for selected language. Falling back to English.`);
            } else {
                toast(JE.t!('toast_language_changed'));
            }
            setTimeout(() => window.location.reload(), 1500);
        })(); });
    }

    // Clear translation cache button
    const clearTranslationCacheButton = document.getElementById('clearTranslationCacheButton');
    if (clearTranslationCacheButton) {
        clearTranslationCacheButton.addEventListener('click', () => {
            const cacheKeys = [];
            const CACHE_PREFIX = 'JE_translation_';
            const CACHE_TIMESTAMP_PREFIX = 'JE_translation_ts_';

            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && (key.startsWith(CACHE_PREFIX) || key.startsWith(CACHE_TIMESTAMP_PREFIX))) {
                    cacheKeys.push(key);
                }
            }

            cacheKeys.forEach(key => localStorage.removeItem(key));

            toast(JE.t!('toast_translation_cache_cleared', { count: cacheKeys.length }));
            setTimeout(() => window.location.reload(), 2000);
            resetAutoCloseTimer();
        });
    }
}
