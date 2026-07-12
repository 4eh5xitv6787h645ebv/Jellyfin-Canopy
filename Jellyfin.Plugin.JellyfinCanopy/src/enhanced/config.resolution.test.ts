// src/enhanced/config.resolution.test.ts
//
// Regression tests for ENH-4: loadSettings must resolve user → admin → hardcoded.
// The admin tier was DEAD because it read camelCase keys off the PascalCase
// JC.pluginConfig; it now resolves through the shared camelCase adminDefaultsView.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JC } from '../globals';
import './config'; // registers JC.loadSettings

// Renamed / seed-only settings that deliberately DON'T resolve through the
// generic admin view (they reach the client via UserSettings seeding or a
// renamed PluginConfiguration property), so the class guard skips them.
const NON_GENERIC_KEYS = new Set([
    'displayLanguage', 'lastOpenedTab', 'isAdmin',
    'watchProgressMode', 'watchProgressTimeFormat', 'pauseScreenDelaySeconds',
]);

function pascal(key: string): string {
    return key.charAt(0).toUpperCase() + key.slice(1);
}

function loadWith(settings: Record<string, unknown>, pluginConfig: Record<string, unknown>): Record<string, unknown> {
    JC.userConfig = { settings };
    JC.pluginConfig = pluginConfig;
    return JC.loadSettings!();
}

describe('loadSettings admin-default resolution (ENH-4)', () => {
    beforeEach(() => {
        JC.userConfig = { settings: {} };
        JC.pluginConfig = {};
    });

    afterEach(() => {
        JC.userConfig = { settings: {} };
        JC.pluginConfig = {};
    });

    it('resolves an admin default (PascalCase) for a user who never set it', () => {
        // hardcoded default for peopleTagsEnabled is false.
        expect(loadWith({}, { PeopleTagsEnabled: true }).peopleTagsEnabled).toBe(true);
    });

    it('lets an explicit user value beat the admin default', () => {
        expect(loadWith({ peopleTagsEnabled: false }, { PeopleTagsEnabled: true }).peopleTagsEnabled).toBe(false);
    });

    it('falls back to the hardcoded default when neither user nor admin set it', () => {
        expect(loadWith({}, {}).peopleTagsEnabled).toBe(false);
    });

    it('CLASS GUARD: every generic hardcoded key resolves from a distinctive PascalCase admin default', () => {
        // Enumerate the hardcoded default set + its values from an empty load.
        const hardcoded = loadWith({}, {});

        const pluginConfig: Record<string, unknown> = {};
        const expected: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(hardcoded)) {
            if (NON_GENERIC_KEYS.has(key)) continue;
            let adminValue: unknown;
            if (typeof value === 'boolean') adminValue = !value;
            else if (typeof value === 'number') adminValue = value + 123;
            else if (typeof value === 'string') adminValue = `admin-${key}`;
            else continue; // skip undefined / object / null defaults
            pluginConfig[pascal(key)] = adminValue;
            expected[key] = adminValue;
        }

        // Sanity: the guard must actually exercise a meaningful number of keys.
        expect(Object.keys(expected).length).toBeGreaterThan(20);

        const resolved = loadWith({}, pluginConfig);
        for (const [key, value] of Object.entries(expected)) {
            expect(resolved[key], `admin default for ${key} must win over hardcoded`).toEqual(value);
        }
    });
});
