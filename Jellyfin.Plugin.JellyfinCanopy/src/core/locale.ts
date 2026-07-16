// src/core/locale.ts
//
// Single source of truth for the user's date/number formatting locale. Every
// translated surface (calendar, requests) formats dates through here so all
// dates in a session share ONE locale — the plugin's displayLanguage — instead
// of a mix of 'en-GB', the browser default, and hardcoded English ordinals
// (CRIT-3). A non-English user must never see a British-formatted date in one
// place and an English-ordinal-on-localized-month in another.

import { JC } from '../globals';

/** Normalise a loose code ("pt_br", "PT-br") to BCP-47 ("pt-BR"). */
function normalize(code: string): string {
    const parts = code.replace('_', '-').split('-');
    if (parts.length === 1) return parts[0].toLowerCase();
    return `${parts[0].toLowerCase()}-${parts[1].toUpperCase()}`;
}

/**
 * Resolve the display locale, in priority order:
 *   1. JC.currentSettings.displayLanguage (the plugin's per-user language setting)
 *   2. the Jellyfin per-user `${userId}-language` localStorage key
 *   3. document.documentElement.lang (Jellyfin web sets this)
 *   4. navigator.language
 *   5. 'en'
 * @returns A BCP-47 string safe to pass to Intl / toLocale* APIs.
 */
export function getDisplayLocale(): string {
    try {
        const settingLang = JC.currentSettings?.displayLanguage;
        if (typeof settingLang === 'string' && settingLang) return normalize(settingLang);

        const userId = (typeof ApiClient !== 'undefined' && ApiClient.getCurrentUserId)
            ? ApiClient.getCurrentUserId() : null;
        if (userId) {
            const stored = JC.storage.local.read('locale', `${userId}-language`, 'host-language');
            if (stored.state === 'Valid' && stored.value) return normalize(stored.value);
        }

        const docLang = document.documentElement.lang;
        if (docLang) return normalize(docLang);

        if (typeof navigator !== 'undefined' && navigator.language) return navigator.language;
    } catch {
        /* fall through to default */
    }
    return 'en';
}

/** Format a date through the resolved display locale. */
export function formatDate(date: Date, options: Intl.DateTimeFormatOptions): string {
    return date.toLocaleDateString(getDisplayLocale(), options);
}

/** Format a time through the resolved display locale. */
export function formatTime(date: Date, options: Intl.DateTimeFormatOptions): string {
    return date.toLocaleTimeString(getDisplayLocale(), options);
}

/**
 * English-style ordinal superscript, applied ONLY for English locales; other
 * locales get an empty suffix (they don't use "1st/2nd" ornamentation). Callers
 * should prefer a fully-localized date for non-English and reserve this for the
 * English decorative path.
 */
export function ordinalSuffix(day: number, locale = getDisplayLocale()): string {
    if (!locale.toLowerCase().startsWith('en')) return '';
    if (day > 3 && day < 21) return '<sup>th</sup>';
    switch (day % 10) {
        case 1: return '<sup>st</sup>';
        case 2: return '<sup>nd</sup>';
        case 3: return '<sup>rd</sup>';
        default: return '<sup>th</sup>';
    }
}
