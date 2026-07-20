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
            'color.dynamic-source': 'backdrop',
            'color.dynamic-strength': 1,
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

    it('normalizes legacy schedule defaults and rejects invalid new schedule and dynamic-color fields', () => {
        const legacy = themeConfiguration();
        delete legacy.ScheduleTimeZone;
        legacy.Schedule = [{
            Id: 'winter',
            ProfileId: 'default',
            StartMonthDay: '12-01',
            EndMonthDay: '02-28',
            Priority: 20,
            Enabled: true,
        }];
        expect(parseUserThemeConfiguration(legacy)).toMatchObject({
            ScheduleTimeZone: 'local',
            Schedule: [{ Kind: 'season' }],
        });

        const badZone = themeConfiguration();
        (badZone as unknown as { ScheduleTimeZone: string }).ScheduleTimeZone = 'browser-script';
        expect(parseUserThemeConfiguration(badZone)).toBeNull();

        const badKind = themeConfiguration();
        badKind.Schedule = [{
            Id: 'event', ProfileId: 'default', Kind: 'festival' as 'season',
            StartMonthDay: '01-01', EndMonthDay: '01-01', Priority: 1, Enabled: true,
        }];
        expect(parseUserThemeConfiguration(badKind)).toBeNull();

        for (const [token, value] of [
            ['color.dynamic-source', 'remote'],
            ['color.dynamic-strength', -0.01],
            ['color.dynamic-strength', 1.01],
        ] as const) {
            const invalid = themeConfiguration();
            invalid.Profiles[0].Tokens = { [token]: value };
            expect(parseUserThemeConfiguration(invalid), token).toBeNull();
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

    it('requires the migrated schema-two browser contract', () => {
        const obsolete = themeConfiguration() as unknown as Record<string, unknown>;
        obsolete.SchemaVersion = 1;
        expect(parseUserThemeConfiguration(obsolete)).toBeNull();
        expect(parseUserThemeConfiguration(themeConfiguration())?.SchemaVersion).toBe(2);
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

        const invalidPalette = themeConfiguration();
        invalidPalette.Profiles[0].Palette = 'remote-gallery-theme';
        expect(parseUserThemeConfiguration(invalidPalette)).toBeNull();

        const invalidAccent = themeConfiguration();
        invalidAccent.Profiles[0].Accent = 'javascript';
        expect(parseUserThemeConfiguration(invalidAccent)).toBeNull();

        const controlName = themeConfiguration();
        controlName.Profiles[0].Name = 'Living\u0085room';
        expect(parseUserThemeConfiguration(controlName)).toBeNull();

        const curated = themeConfiguration();
        curated.Profiles[0].Palette = 'catppuccin';
        curated.Profiles[0].Accent = 'palette';
        expect(parseUserThemeConfiguration(curated)).not.toBeNull();

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
