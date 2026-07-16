// src/bootstrap/translations.ts
//
// Out-of-band loader: compiled to its own dist/translations.js IIFE and served
// separately (js/plugin.js fetches it before the component stage / pre-login).
// It is not part of the authenticated ESM graph — it must be individually fetchable so the
// loader can pull translations before the main bundle exists.
//
// Attaches JC.loadTranslations to the shared namespace. Behaviour is identical
// to the former js/enhanced/translations.js; this is a typed port.

import type { JEGlobal } from '../types/jc';
import localeManifest from '../../locale-manifest.json';

(function (JC: JEGlobal) {
    'use strict';

    // The v12 fork's locales — the upstream repo (n00bcodr/main) is a different
    // codebase whose key set differs, so its JSON would introduce missing/mismatched
    // strings. Only used as the last-resort fallback when AssetCacheEnabled === false.
    const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/main/Jellyfin.Plugin.JellyfinCanopy/js/locales';
    const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
    const SUPPORTED_LOCALES = new Set(localeManifest.locales);

    type LangResult = { translations: Record<string, string>; usedLang: string };

    function isTranslationRecord(value: unknown): value is Record<string, string> {
        return value !== null && typeof value === 'object' && !Array.isArray(value)
            && Object.values(value as Record<string, unknown>).every((entry) => typeof entry === 'string');
    }

    function normalizeLangCode(code: string | null | undefined): string {
        if (!code) return '';
        const parts = code.split('-');
        if (parts.length === 1) return parts[0].toLowerCase();
        if (parts.length === 2) return `${parts[0].toLowerCase()}-${parts[1].toUpperCase()}`;
        return code;
    }

    function buildLanguageChain(primaryLang: string): string[] {
        const normalizedLang = normalizeLangCode(primaryLang);
        const langCodes: string[] = [];

        if (normalizedLang && SUPPORTED_LOCALES.has(normalizedLang)) {
            langCodes.push(normalizedLang);
        }

        if (normalizedLang && normalizedLang.includes('-')) {
            const baseLang = normalizedLang.split('-')[0];
            if (SUPPORTED_LOCALES.has(baseLang) && !langCodes.includes(baseLang)) {
                langCodes.push(baseLang);
            }
        }

        if (langCodes[langCodes.length - 1] !== localeManifest.baseLocale) {
            langCodes.push(localeManifest.baseLocale);
        }

        return Array.from(new Set(langCodes.filter(Boolean)));
    }

    async function getPluginVersion(): Promise<string> {
        let pluginVersion = JC?.pluginVersion;
        if (pluginVersion && pluginVersion !== 'unknown') return pluginVersion;

        try {
            const versionResponse = await fetch(ApiClient.getUrl('/JellyfinCanopy/version'));
            if (versionResponse.ok) {
                pluginVersion = await versionResponse.text();
                if (JC) {
                    JC.pluginVersion = pluginVersion;
                }
                return pluginVersion;
            }
        } catch (e) {
            console.warn('🪼 Jellyfin Canopy: Failed to fetch plugin version', e);
        }

        return 'unknown';
    }

    function cleanOldTranslationCache(pluginVersion: string): void {
        const storedKeys = JC.storage.local.keys('translations', 'translation-cache-prefix');
        for (const key of storedKeys.value || []) {
            if (key.startsWith('JC_translation_') || key.startsWith('JC_translation_ts_')) {
                if (!key.includes(`_${pluginVersion}`)) {
                    JC.storage.local.remove('translations', key, 'translation-cache-entry');
                    console.log(`🪼 Jellyfin Canopy: Removed old translation cache: ${key}`);
                }
            }
        }
    }

    async function tryLoadSingleLanguage(code: string, pluginVersion: string): Promise<LangResult> {
        const cacheKey = `JC_translation_${code}_${pluginVersion}`;
        const timestampKey = `JC_translation_ts_${code}_${pluginVersion}`;
        const cachedTranslations = JC.storage.local.readJson(
            'translations', cacheKey, isTranslationRecord, 'translation-cache-payload',
        );
        const cachedTimestamp = JC.storage.local.readNumber(
            'translations', timestampKey, (value) => value >= 0, 'translation-cache-timestamp',
        );

        if (cachedTranslations.state === 'Valid' && cachedTimestamp.state === 'Valid') {
            const age = Date.now() - cachedTimestamp.value;
            if (age < CACHE_DURATION) {
                console.log(`🪼 Jellyfin Canopy: Using cached translations for ${code} (age: ${Math.round(age / 1000 / 60)} minutes, version: ${pluginVersion})`);
                return { translations: cachedTranslations.value, usedLang: code };
            }
        }

        console.log(`🪼 Jellyfin Canopy: Loading bundled translations for ${code}...`);
        try {
            const bundledResponse = await fetch(ApiClient.getUrl(`/JellyfinCanopy/locales/${code}.json`));
            if (bundledResponse.ok) {
                const translations = await bundledResponse.json() as Record<string, string>;
                JC.storage.local.write('translations', cacheKey, JSON.stringify(translations), 'translation-cache-payload');
                JC.storage.local.write('translations', timestampKey, Date.now().toString(), 'translation-cache-timestamp');
                console.log(`🪼 Jellyfin Canopy: Successfully loaded and cached bundled translations for ${code} (version: ${pluginVersion})`);
                return { translations, usedLang: code };
            }
        } catch (bundledError) {
            console.warn('🪼 Jellyfin Canopy: Bundled translations failed, falling back to GitHub:', (bundledError as Error).message);
        }

        // PERF(R6): no remote assets — with the asset cache enabled (default; also the
        // pre-config assumption, since this loader can run before public-config)
        // the GitHub-raw fallback is skipped so the browser never contacts a
        // third-party host: the server already fell back base-language → English
        // for bundled locales, and the final bundled retries below still run.
        const cdnFallbackAllowed = JC.pluginConfig?.AssetCacheEnabled === false;

        try {
            if (!cdnFallbackAllowed) {
                throw new Error('GitHub locale fallback disabled (asset cache active)');
            }

            console.log(`🪼 Jellyfin Canopy: Fetching translations for ${code} from GitHub...`);
            const githubResponse = await fetch(`${GITHUB_RAW_BASE}/${code}.json`, {
                method: 'GET',
                cache: 'no-cache',
                headers: { 'Accept': 'application/json' }
            });

            if (githubResponse.ok) {
                const translations = await githubResponse.json() as Record<string, string>;
                const payloadWrite = JC.storage.local.write('translations', cacheKey, JSON.stringify(translations), 'translation-cache-payload');
                const timestampWrite = JC.storage.local.write('translations', timestampKey, Date.now().toString(), 'translation-cache-timestamp');
                if (payloadWrite.state === 'Valid' && timestampWrite.state === 'Valid') {
                    console.log(`🪼 Jellyfin Canopy: Successfully fetched and cached translations for ${code} from GitHub (version: ${pluginVersion})`);
                }
                return { translations, usedLang: code };
            }

            if (githubResponse.status === 404 && code !== 'en') {
                console.warn(`🪼 Jellyfin Canopy: Language ${code} not found on GitHub, falling back to English`);
                const englishResponse = await fetch(`${GITHUB_RAW_BASE}/en.json`, {
                    method: 'GET',
                    cache: 'no-cache',
                    headers: { 'Accept': 'application/json' }
                });

                if (englishResponse.ok) {
                    const translations = await englishResponse.json() as Record<string, string>;
                    const enCacheKey = `JC_translation_en_${pluginVersion}`;
                    const enTimestampKey = `JC_translation_ts_en_${pluginVersion}`;
                    JC.storage.local.write('translations', enCacheKey, JSON.stringify(translations), 'translation-cache-payload');
                    JC.storage.local.write('translations', enTimestampKey, Date.now().toString(), 'translation-cache-timestamp');
                    return { translations, usedLang: 'en' };
                }
            }

            if (githubResponse.status === 403) {
                console.warn('🪼 Jellyfin Canopy: GitHub rate limit detected, using bundled fallback');
            } else if (githubResponse.status >= 500) {
                console.warn(`🪼 Jellyfin Canopy: GitHub server error (${githubResponse.status}), using bundled fallback`);
            }

            throw new Error(`GitHub fetch failed with status ${githubResponse.status}`);
        } catch (githubError) {
            console.warn('🪼 Jellyfin Canopy: GitHub fetch failed, falling back to bundled translations:', (githubError as Error).message);
        }

        console.log(`🪼 Jellyfin Canopy: Loading bundled translations for ${code}...`);
        let response = await fetch(ApiClient.getUrl(`/JellyfinCanopy/locales/${code}.json`));

        if (response.ok) {
            const translations = await response.json() as Record<string, string>;
            JC.storage.local.write('translations', cacheKey, JSON.stringify(translations), 'translation-cache-payload');
            JC.storage.local.write('translations', timestampKey, Date.now().toString(), 'translation-cache-timestamp');
            return { translations, usedLang: code };
        }

        console.warn(`🪼 Jellyfin Canopy: Bundled ${code} not found, falling back to bundled English`);
        response = await fetch(ApiClient.getUrl('/JellyfinCanopy/locales/en.json'));
        if (response.ok) {
            return { translations: await response.json() as Record<string, string>, usedLang: 'en' };
        }

        throw new Error('Failed to load English fallback translations');
    }

    JC.loadTranslations = async function (): Promise<Record<string, string>> {
        try {
            const pluginVersion = await getPluginVersion();

            let user: unknown = ApiClient.getCurrentUser ? ApiClient.getCurrentUser() : null;
            if (user instanceof Promise) {
                user = await user;
            }

            const userId = (user as { Id?: string } | null)?.Id;
            let lang = 'en';
            if (userId) {
                const storageKey = `${userId}-language`;
                const storedLang = JC.storage.local.read('translations', storageKey, 'host-language');
                if (storedLang.state === 'Valid' && storedLang.value) {
                    lang = normalizeLangCode(storedLang.value);
                } else {
                    // Fall back to the HTML lang attribute set by Jellyfin's web client.
                    // This covers the Android app and other clients where the localStorage
                    // key may not exist but Jellyfin has already resolved the user's
                    // preferred language from server-side settings.
                    const docLang = document.documentElement.lang;
                    if (docLang) {
                        lang = normalizeLangCode(docLang);
                    }
                }
            }

            cleanOldTranslationCache(pluginVersion);

            const langCodes = buildLanguageChain(lang);
            for (const code of langCodes) {
                try {
                    const result = await tryLoadSingleLanguage(code, pluginVersion);
                    if (result && result.translations) {
                        return result.translations;
                    }
                } catch (e) {
                    console.warn(`🪼 Jellyfin Canopy: Failed to load translations for ${code}`, e);
                }
            }

            console.error('🪼 Jellyfin Canopy: Failed to load translations from any source');
            return {};
        } catch (error) {
            console.error('🪼 Jellyfin Canopy: Failed to load translations:', error);
            return {};
        }
    };
})(window.JellyfinCanopy);
