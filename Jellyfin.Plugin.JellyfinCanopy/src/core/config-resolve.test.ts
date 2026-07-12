// src/core/config-resolve.test.ts
//
// Unit tests for the admin-default normalizer (ENH-4). toCamelKey lowercases the
// first char; adminDefaultsView builds a shallow camelCase view of the PascalCase
// plugin config so loadSettings can resolve the admin tier against camelCase keys.
import { describe, expect, it } from 'vitest';
import { toCamelKey, adminDefaultsView } from './config-resolve';

describe('toCamelKey', () => {
    it('lowercases only the first character', () => {
        expect(toCamelKey('PeopleTagsEnabled')).toBe('peopleTagsEnabled');
        expect(toCamelKey('TagsCacheTtlDays')).toBe('tagsCacheTtlDays');
        expect(toCamelKey('DEFAULT_REGION')).toBe('dEFAULT_REGION');
    });

    it('is a no-op for the empty string', () => {
        expect(toCamelKey('')).toBe('');
    });
});

describe('adminDefaultsView', () => {
    it('camelCases every top-level key', () => {
        expect(adminDefaultsView({ PeopleTagsEnabled: true, TagsCacheTtlDays: 7 }))
            .toEqual({ peopleTagsEnabled: true, tagsCacheTtlDays: 7 });
    });

    it('preserves nested values by reference without deep-mangling keys', () => {
        const shortcuts = [{ Name: 'a', Key: 'b' }];
        const view = adminDefaultsView({ Shortcuts: shortcuts });
        expect(view.shortcuts).toBe(shortcuts); // shallow: same array, keys untouched
    });

    it('returns an empty object for null/undefined', () => {
        expect(adminDefaultsView(null)).toEqual({});
        expect(adminDefaultsView(undefined)).toEqual({});
    });
});
