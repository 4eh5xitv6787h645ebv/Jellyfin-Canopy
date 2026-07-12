// Unit tests for src/core/locale.ts — the single source of truth for the user's
// date/number display locale (CRIT-3). Every translated surface formats dates
// through here so a session never mixes 'en-GB', browser default and hardcoded
// English ordinals.
import { afterEach, describe, expect, it } from 'vitest';
import { JC } from '../globals';
import { formatDate, getDisplayLocale, ordinalSuffix } from './locale';

afterEach(() => {
    JC.currentSettings = undefined;
    document.documentElement.lang = '';
    try { window.localStorage.removeItem('test-user-id-language'); } catch { /* ignore */ }
});

describe('getDisplayLocale', () => {
    it('prefers the plugin displayLanguage and normalizes it to BCP-47', () => {
        JC.currentSettings = { displayLanguage: 'pt_br' };
        expect(getDisplayLocale()).toBe('pt-BR');
    });

    it('falls back to document.documentElement.lang when no plugin language is set', () => {
        JC.currentSettings = { displayLanguage: '' };
        window.localStorage.removeItem('test-user-id-language');
        document.documentElement.lang = 'fr';
        expect(getDisplayLocale()).toBe('fr');
    });

    it('falls back to navigator.language as the last resolved source', () => {
        JC.currentSettings = { displayLanguage: '' };
        window.localStorage.removeItem('test-user-id-language');
        document.documentElement.lang = '';
        expect(getDisplayLocale()).toBe(window.navigator.language);
    });
});

describe('formatDate', () => {
    it('formats the month name in the resolved display locale', () => {
        const date = new Date('2026-02-14T12:00:00Z');
        JC.currentSettings = { displayLanguage: 'en' };
        expect(formatDate(date, { month: 'long', day: 'numeric' })).toContain('February');
        JC.currentSettings = { displayLanguage: 'de' };
        const german = formatDate(date, { month: 'long', day: 'numeric' });
        // "Februar" is a prefix of "February", so also assert the English full
        // form is absent — otherwise an en-locale result would pass falsely.
        expect(german).toContain('Februar');
        expect(german).not.toContain('February');
    });
});

describe('ordinalSuffix', () => {
    it('decorates English days and stays empty for other locales', () => {
        expect(ordinalSuffix(2, 'en')).toBe('<sup>nd</sup>');
        expect(ordinalSuffix(2, 'fr')).toBe('');
    });
});
