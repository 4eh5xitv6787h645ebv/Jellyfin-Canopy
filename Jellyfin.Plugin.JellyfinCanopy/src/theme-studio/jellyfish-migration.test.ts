import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import { themeConfiguration } from '../test/theme-studio-fixture';
import type { IdentityContext } from '../types/jc';
import {
    finalizeAcknowledgedJellyfishMigration,
    inspectJellyfishMigration,
    JELLYFISH_THEMES,
    mergeStagedJellyfishMigration,
    parseLegacyJellyfishImport,
    restoreJellyfishCompatibilityKeys,
} from './jellyfish-migration';

const NOW = Date.UTC(2026, 6, 21, 0, 0, 0);
let context: IdentityContext;

function scoped(suffix: string, owner = context): string {
    return `jc-theme:${owner.serverId}:${owner.userId}:${suffix}`;
}

function compatibility(suffix: string, owner = context): string {
    return `${owner.userId}-${suffix}`;
}

function rollback(owner = context): string {
    return `jc-theme:${owner.serverId}:${owner.userId}:jellyfish-rollback-v1`;
}

function localImport(file: string): string {
    return `@import url("http://jellyfin.test/JellyfinCanopy/assets/themes/${file}");`;
}

function migrated(theme: string) {
    const value = themeConfiguration();
    value.LegacyMigration = { JellyfishTheme: theme, Completed: true };
    value.Profiles[0].Palette = `jellyfish-${theme.toLowerCase()}`;
    value.Profiles[0].Accent = 'palette';
    return value;
}

beforeEach(() => {
    localStorage.clear();
    document.querySelectorAll('style').forEach((style) => style.remove());
    JC.identity.transition('', '', 'jellyfish-migration-test-logout');
    context = JC.identity.transition('server-a', 'user-a', 'jellyfish-migration-test-login')!;
    JC.pluginConfig = { ...JC.pluginConfig, AssetCacheEnabled: true };
});

afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    document.querySelectorAll('style').forEach((style) => style.remove());
});

describe('Jellyfish legacy import recognition', () => {
    it('maps every current selector choice from local and documented CDN forms', () => {
        for (const { name, file } of JELLYFISH_THEMES) {
            expect(parseLegacyJellyfishImport(localImport(file))).toBe(name);
            expect(parseLegacyJellyfishImport(
                `@import url('https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfish/colors/${file}');`,
            )).toBe(name);
            expect(parseLegacyJellyfishImport(
                ` @IMPORT url(https://cdn.jsdelivr.net/gh/n00bcodr/jellyfish@main/colors/${file}); `,
            )).toBe(name);
        }
    });

    it.each([
        '@import url("https://example.invalid/ocean.css");',
        '@import url("javascript:alert(1)");',
        '@import url("data:text/css,body{}")',
        '@import url("https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfish/colors/unknown.css");',
        '@import url("https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfish/colors/ocean.css?x=1");',
        '@import url("https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfish/colors/ocean.css"); body{}',
        'ocean.css',
        '',
    ])('fails closed for unknown or mixed input: %s', (value) => {
        expect(parseLegacyJellyfishImport(value)).toBeNull();
    });
});

describe('Jellyfish migration lifecycle', () => {
    it('detects an identity-scoped selection and refuses conflicting mirrors', () => {
        localStorage.setItem(scoped('customCss'), localImport('ocean.css'));
        expect(inspectJellyfishMigration(context, { JellyfishTheme: '', Completed: false }))
            .toMatchObject({ state: 'available', selection: { theme: 'Ocean', source: 'scoped' } });

        localStorage.setItem(compatibility('customCss'), localImport('mint.css'));
        expect(inspectJellyfishMigration(context, { JellyfishTheme: '', Completed: false }))
            .toEqual({ state: 'unrecognized' });
    });

    it('never adopts another active identity and never reads another server-scoped key', () => {
        localStorage.setItem(scoped('customCss'), localImport('ocean.css'));
        const previous = context;
        context = JC.identity.transition('server-b', 'user-a', 'jellyfish-migration-test-switch')!;

        expect(inspectJellyfishMigration(previous, { JellyfishTheme: '', Completed: false }))
            .toEqual({ state: 'none' });
        expect(inspectJellyfishMigration(context, { JellyfishTheme: '', Completed: false }))
            .toEqual({ state: 'none' });
        expect(localStorage.getItem(scoped('customCss', previous))).toContain('ocean.css');
    });

    it('validates the server mapping and preserves unrelated profiles, schedules, ids and revision', () => {
        const current = themeConfiguration();
        current.Revision = 17;
        current.Profiles[0].Id = 'hand-tuned';
        current.Profiles[0].Name = 'Hand tuned';
        current.ActiveProfileId = 'hand-tuned';
        current.Profiles.push({ ...structuredClone(current.Profiles[0]), Id: 'seasonal', Name: 'Seasonal' });
        current.Schedule.push({
            Id: 'winter', ProfileId: 'seasonal', Kind: 'season', StartMonthDay: '12-01',
            EndMonthDay: '02-28', Priority: 20, Enabled: true,
        });
        const response = { valid: true, data: migrated('Ocean') };

        const candidate = mergeStagedJellyfishMigration(response, current, 'Ocean');

        expect(candidate).toMatchObject({
            Revision: 17,
            ActiveProfileId: 'hand-tuned',
            LegacyMigration: { JellyfishTheme: 'Ocean', Completed: true },
            Profiles: [
                { Id: 'hand-tuned', Name: 'Hand tuned', BasePreset: 'canopy', Palette: 'jellyfish-ocean', Accent: 'palette' },
                { Id: 'seasonal', Name: 'Seasonal' },
            ],
            Schedule: [{ Id: 'winter', ProfileId: 'seasonal' }],
        });
        expect(mergeStagedJellyfishMigration(response, current, 'Mint')).toBeNull();
        expect(mergeStagedJellyfishMigration({ valid: true, data: { ...migrated('Ocean'), Extra: true } }, current, 'Ocean'))
            .toBeNull();
    });

    it('cleans exact legacy values only after acknowledgement and restores generated values in the rollback window', () => {
        localStorage.setItem(scoped('customCss'), localImport('ocean.css'));
        localStorage.setItem(compatibility('customCss'), localImport('ocean.css'));
        localStorage.setItem(scoped('randomThemeEnabled'), 'true');
        localStorage.setItem(compatibility('randomThemeEnabled'), 'true');
        localStorage.setItem(scoped('lastRandomThemeDate'), '2026-07-20');
        localStorage.setItem(compatibility('lastRandomThemeDate'), '2026-07-20');
        const style = document.createElement('style');
        style.textContent = localImport('ocean.css');
        document.head.append(style);

        expect(finalizeAcknowledgedJellyfishMigration(context, themeConfiguration(), NOW).acknowledged).toBe(false);
        expect(localStorage.getItem(scoped('customCss'))).not.toBeNull();
        expect(style.isConnected).toBe(true);

        const result = finalizeAcknowledgedJellyfishMigration(context, migrated('Ocean'), NOW);

        expect(result).toEqual({
            acknowledged: true,
            rollbackAvailable: true,
            cleanupComplete: true,
            removedKeys: 6,
            removedStyles: 1,
        });
        expect(localStorage.getItem(scoped('customCss'))).toBeNull();
        expect(localStorage.getItem(compatibility('customCss'))).toBeNull();
        expect(inspectJellyfishMigration(context, migrated('Ocean').LegacyMigration)).toMatchObject({
            state: 'completed', theme: 'Ocean', rollbackAvailable: true,
        });

        expect(restoreJellyfishCompatibilityKeys(context, 'Ocean', NOW + 1)).toBe(true);
        expect(localStorage.getItem(scoped('customCss'))).toBe(localImport('ocean.css'));
        expect(localStorage.getItem(compatibility('customCss'))).toBe(localImport('ocean.css'));
        expect(localStorage.getItem(scoped('randomThemeEnabled'))).toBe('true');
        expect(localStorage.getItem(scoped('lastRandomThemeDate'))).toBe('2026-07-20');
        // Restoration is storage-only and deliberately never executes the import.
        expect([...document.querySelectorAll('style')]).toHaveLength(0);
    });

    it('does not erase a concurrent or unrecognized custom CSS edit', () => {
        localStorage.setItem(scoped('customCss'), '@import url("https://example.invalid/private.css");');
        const result = finalizeAcknowledgedJellyfishMigration(context, migrated('Ocean'), NOW);

        expect(result.cleanupComplete).toBe(false);
        expect(result.rollbackAvailable).toBe(false);
        expect(localStorage.getItem(scoped('customCss'))).toContain('example.invalid');
    });

    it('expires rollback records and refuses restore for a different theme', () => {
        localStorage.setItem(scoped('customCss'), localImport('ocean.css'));
        expect(finalizeAcknowledgedJellyfishMigration(context, migrated('Ocean'), NOW).rollbackAvailable).toBe(true);

        expect(restoreJellyfishCompatibilityKeys(context, 'Mint', NOW + 1)).toBe(false);
        expect(restoreJellyfishCompatibilityKeys(context, 'Ocean', NOW + 31 * 24 * 60 * 60 * 1_000)).toBe(false);
        expect(localStorage.getItem(scoped('customCss'))).toBeNull();
    });

    it('does not overwrite a post-migration edit when restoring compatibility keys', () => {
        localStorage.setItem(scoped('customCss'), localImport('ocean.css'));
        expect(finalizeAcknowledgedJellyfishMigration(context, migrated('Ocean'), NOW).rollbackAvailable).toBe(true);
        localStorage.setItem(scoped('customCss'), 'body { color: rebeccapurple; }');

        expect(restoreJellyfishCompatibilityKeys(context, 'Ocean', NOW + 1)).toBe(false);
        expect(localStorage.getItem(scoped('customCss'))).toBe('body { color: rebeccapurple; }');
        expect(localStorage.getItem(compatibility('customCss'))).toBeNull();
        expect(localStorage.getItem(rollback())).not.toBeNull();
    });

    it('compensates already-written keys when a rollback write fails partway through', () => {
        localStorage.setItem(scoped('customCss'), localImport('ocean.css'));
        expect(finalizeAcknowledgedJellyfishMigration(context, migrated('Ocean'), NOW).rollbackAvailable).toBe(true);
        const write = JC.storage.local.write.bind(JC.storage.local);
        vi.spyOn(JC.storage.local, 'write').mockImplementation((feature, key, value, label) =>
            key === compatibility('customCss')
                ? { state: 'QuotaFailure', value: null }
                : write(feature, key, value, label));

        expect(restoreJellyfishCompatibilityKeys(context, 'Ocean', NOW + 1)).toBe(false);
        expect(localStorage.getItem(scoped('customCss'))).toBeNull();
        expect(localStorage.getItem(compatibility('customCss'))).toBeNull();
        expect(localStorage.getItem(rollback())).not.toBeNull();
    });

    it.each([
        { expiresAt: NOW + 31 * 24 * 60 * 60 * 1_000, lastRandomDate: null },
        { expiresAt: NOW + 24 * 60 * 60 * 1_000, lastRandomDate: '2026-02-31' },
    ])('quarantines forged or semantically invalid rollback records: %j', (record) => {
        localStorage.setItem(rollback(), JSON.stringify({
            version: 1,
            theme: 'Ocean',
            randomEnabled: null,
            ...record,
        }));

        expect(inspectJellyfishMigration(context, migrated('Ocean').LegacyMigration)).toEqual({
            state: 'completed',
            theme: 'Ocean',
            rollbackAvailable: false,
            rollbackExpiresAt: null,
        });
        expect(localStorage.getItem(rollback())).toBeNull();
    });
});
