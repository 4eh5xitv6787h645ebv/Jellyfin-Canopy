import { describe, expect, it } from 'vitest';
import { isUserThemeConfiguration, parseUserThemeConfiguration, THEME_TOKEN_RULES } from './schema';
import { themeConfiguration } from '../test/theme-studio-fixture';

describe('Theme Studio browser schema boundary', () => {
    it('accepts the server-shaped v1 document and returns an isolated clone', () => {
        const source = themeConfiguration();
        const parsed = parseUserThemeConfiguration(source);
        expect(parsed).toEqual(source);
        expect(parsed).not.toBe(source);
        expect(parsed?.Profiles[0]).not.toBe(source.Profiles[0]);

        source.Profiles[0].Name = 'Changed after validation';
        expect(parsed?.Profiles[0]?.Name).toBe('Default');
    });

    it('mirrors the full server token vocabulary and rejects arbitrary CSS-bearing keys', () => {
        expect(THEME_TOKEN_RULES.size).toBeGreaterThan(70);
        const valid = themeConfiguration();
        valid.Profiles[0].Tokens = {
            'color.primary': '#AABBCCDD',
            'shape.card-radius': 'pill',
            'effects.blur': 48,
            'motion.page-transition': false,
        };
        expect(isUserThemeConfiguration(valid)).toBe(true);

        for (const [name, value] of [
            ['raw.css', 'body{display:none}'],
            ['background.url', 'url(https://example.invalid/x)'],
            ['color.primary', 'red;--owned:1'],
            ['shape.card-radius', '1px}body{display:none'],
        ] as const) {
            const attack = themeConfiguration();
            attack.Profiles[0].Tokens = { [name]: value };
            expect(parseUserThemeConfiguration(attack), name).toBeNull();
        }
    });

    it('rejects unknown fields at every envelope and invalid migration evidence', () => {
        const cases: unknown[] = [];
        const root = themeConfiguration() as unknown as Record<string, unknown>;
        root.RawCss = '*{}';
        cases.push(root);
        const profile = themeConfiguration();
        (profile.Profiles[0] as unknown as Record<string, unknown>).Url = 'https://example.invalid';
        cases.push(profile);
        const responsive = themeConfiguration();
        (responsive.Profiles[0].Responsive as unknown as Record<string, unknown>).Watch = {};
        cases.push(responsive);
        const migration = themeConfiguration();
        migration.LegacyMigration = { JellyfishTheme: 'UnknownTheme', Completed: true };
        cases.push(migration);
        const inconsistent = themeConfiguration();
        inconsistent.LegacyMigration = { JellyfishTheme: '', Completed: true };
        cases.push(inconsistent);
        for (const value of cases) expect(parseUserThemeConfiguration(value)).toBeNull();

        const migrated = themeConfiguration();
        migrated.LegacyMigration = { JellyfishTheme: 'Ocean', Completed: true };
        expect(parseUserThemeConfiguration(migrated)).not.toBeNull();
    });

    it('enforces identifiers, references, capacities, finite numbers, and the byte ceiling', () => {
        const duplicate = themeConfiguration();
        duplicate.Profiles.push(structuredClone(duplicate.Profiles[0]));
        expect(parseUserThemeConfiguration(duplicate)).toBeNull();

        const missing = themeConfiguration();
        missing.ActiveProfileId = 'missing';
        expect(parseUserThemeConfiguration(missing)).toBeNull();

        const invalidNumber = themeConfiguration();
        invalidNumber.Profiles[0].Tokens = { 'effects.blur': Number.NaN };
        expect(parseUserThemeConfiguration(invalidNumber)).toBeNull();

        const tooMany = themeConfiguration();
        tooMany.Profiles = Array.from({ length: 25 }, (_, index) => ({
            ...structuredClone(tooMany.Profiles[0]),
            Id: `profile-${index}`,
        }));
        expect(parseUserThemeConfiguration(tooMany)).toBeNull();

        const oversized = themeConfiguration();
        oversized.Profiles[0].Name = 'x'.repeat(129 * 1024);
        expect(parseUserThemeConfiguration(oversized)).toBeNull();
    });
});
