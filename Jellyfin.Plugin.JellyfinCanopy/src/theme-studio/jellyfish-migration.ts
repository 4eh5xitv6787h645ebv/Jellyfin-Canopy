import { themeCssUrl } from '../core/asset-urls';
import { JC } from '../globals';
import type { IdentityContext, ThemeLegacyMigration, UserThemeConfiguration } from '../types/jc';
import { parseUserThemeConfiguration } from './schema';

const STORAGE_OWNER = 'theme-studio-jellyfish-migration';
const LEGACY_STORAGE_PREFIX = 'jc-theme:';
const ROLLBACK_VERSION = 1;
const ROLLBACK_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
const MAXIMUM_ROLLBACK_BYTES = 512;

export const JELLYFISH_THEMES = Object.freeze([
    { name: 'Aurora', file: 'aurora.css' },
    { name: 'Banana', file: 'banana.css' },
    { name: 'Coal', file: 'coal.css' },
    { name: 'Coral', file: 'coral.css' },
    { name: 'Forest', file: 'forest.css' },
    { name: 'Grass', file: 'grass.css' },
    { name: 'Jellyblue', file: 'jellyblue.css' },
    { name: 'Jellyflix', file: 'jellyflix.css' },
    { name: 'Jellypurple', file: 'jellypurple.css' },
    { name: 'Lavender', file: 'lavender.css' },
    { name: 'Midnight', file: 'midnight.css' },
    { name: 'Mint', file: 'mint.css' },
    { name: 'Ocean', file: 'ocean.css' },
    { name: 'Peach', file: 'peach.css' },
    { name: 'Watermelon', file: 'watermelon.css' },
] as const);

export type JellyfishThemeName = (typeof JELLYFISH_THEMES)[number]['name'];

interface CapturedLegacyValue {
    readonly key: string;
    readonly value: string;
    readonly keyLabel: string;
}

export interface JellyfishLegacySelection {
    readonly theme: JellyfishThemeName;
    readonly source: 'scoped' | 'compatibility' | 'mirrored';
    /** Exact values are retained in memory only so cleanup cannot erase a concurrent edit. */
    readonly captured: readonly CapturedLegacyValue[];
    readonly randomEnabled: boolean | null;
    readonly lastRandomDate: string | null;
}

interface JellyfishRollbackRecord {
    readonly version: 1;
    readonly theme: JellyfishThemeName;
    readonly randomEnabled: boolean | null;
    readonly lastRandomDate: string | null;
    readonly expiresAt: number;
}

export type JellyfishMigrationInspection =
    | Readonly<{ state: 'none' }>
    | Readonly<{ state: 'unrecognized' }>
    | Readonly<{ state: 'available'; selection: JellyfishLegacySelection }>
    | Readonly<{
        state: 'completed';
        theme: JellyfishThemeName;
        rollbackAvailable: boolean;
        rollbackExpiresAt: number | null;
    }>;

export interface JellyfishCleanupResult {
    readonly acknowledged: boolean;
    readonly rollbackAvailable: boolean;
    readonly cleanupComplete: boolean;
    readonly removedKeys: number;
    readonly removedStyles: number;
}

const THEME_BY_FILE = new Map<string, JellyfishThemeName>(
    JELLYFISH_THEMES.map(({ name, file }) => [file, name]),
);
const THEME_BY_NAME = new Map<string, JellyfishThemeName>(
    JELLYFISH_THEMES.map(({ name }) => [name.toLowerCase(), name]),
);

function canonicalTheme(value: string): JellyfishThemeName | null {
    return THEME_BY_NAME.get(value.toLowerCase()) ?? null;
}

function scopedKey(context: IdentityContext, suffix: string): string {
    return `${LEGACY_STORAGE_PREFIX}${context.serverId}:${context.userId}:${suffix}`;
}

function compatibilityKey(context: IdentityContext, suffix: string): string {
    return `${context.userId}-${suffix}`;
}

function rollbackKey(context: IdentityContext): string {
    return `${LEGACY_STORAGE_PREFIX}${context.serverId}:${context.userId}:jellyfish-rollback-v1`;
}

function importValue(file: string): string {
    return `@import url("${themeCssUrl(file)}");`;
}

function allowedImportUrl(raw: string): string | null {
    if (!raw || /[\u0000-\u0020\u007f]/.test(raw)) return null;
    let parsed: URL;
    try { parsed = new URL(raw, window.location.href); } catch { return null; }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;

    for (const { file } of JELLYFISH_THEMES) {
        let current: URL | null = null;
        let local: URL | null = null;
        try { current = new URL(themeCssUrl(file), window.location.href); } catch { /* unavailable host URL */ }
        try {
            local = new URL(ApiClient.getUrl(`/JellyfinCanopy/assets/themes/${file}`), window.location.href);
        } catch { /* unavailable host URL */ }
        if (current?.href === parsed.href || local?.href === parsed.href) return file;

        if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'cdn.jsdelivr.net') continue;
        const paths = [
            `/gh/n00bcodr/Jellyfish/colors/${file}`,
            `/gh/n00bcodr/jellyfish/colors/${file}`,
            `/gh/n00bcodr/Jellyfish@main/colors/${file}`,
            `/gh/n00bcodr/jellyfish@main/colors/${file}`,
        ];
        if (paths.includes(parsed.pathname)) return file;
    }
    return null;
}

/**
 * Maps only an entire, single known Jellyfish colour import. Mixed CSS,
 * filenames, javascript/data URLs, unknown hosts and unknown variants fail closed.
 */
export function parseLegacyJellyfishImport(value: string): JellyfishThemeName | null {
    const match = /^\s*@import\s+url\(\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s'"()]+))\s*\)\s*;\s*$/i.exec(value);
    if (!match) return null;
    const file = allowedImportUrl(match[1] ?? match[2] ?? match[3] ?? '');
    return file ? THEME_BY_FILE.get(file) ?? null : null;
}

function readString(key: string, keyLabel: string): string | null | undefined {
    const result = JC.storage.local.read(STORAGE_OWNER, key, keyLabel);
    if (result.state === 'Valid') return result.value;
    if (result.state === 'Missing') return null;
    return undefined;
}

function capturedOptional(
    context: IdentityContext,
    suffix: 'randomThemeEnabled' | 'lastRandomThemeDate',
): readonly CapturedLegacyValue[] {
    const entries: CapturedLegacyValue[] = [];
    for (const [key, label] of [
        [scopedKey(context, suffix), `scoped-${suffix}`],
        [compatibilityKey(context, suffix), `compatibility-${suffix}`],
    ] as const) {
        const value = readString(key, label);
        if (typeof value === 'string') entries.push({ key, value, keyLabel: label });
    }
    return entries;
}

function validRandomValue(entries: readonly CapturedLegacyValue[]): boolean | null {
    const values = new Set(entries.map(({ value }) => value));
    if (values.size !== 1) return null;
    const value = entries[0]?.value;
    return value === 'true' ? true : value === 'false' ? false : null;
}

function isCanonicalDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validRandomDate(entries: readonly CapturedLegacyValue[]): string | null {
    const values = new Set(entries.map(({ value }) => value));
    if (values.size !== 1) return null;
    const value = entries[0]?.value ?? '';
    return isCanonicalDate(value) ? value : null;
}

function isRollbackRecord(value: unknown): value is JellyfishRollbackRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some((key) => ![
        'version', 'theme', 'randomEnabled', 'lastRandomDate', 'expiresAt',
    ].includes(key))) return false;
    return record.version === ROLLBACK_VERSION
        && typeof record.theme === 'string'
        && canonicalTheme(record.theme) === record.theme
        && (record.randomEnabled === null || typeof record.randomEnabled === 'boolean')
        && (record.lastRandomDate === null
            || (typeof record.lastRandomDate === 'string' && isCanonicalDate(record.lastRandomDate)))
        && typeof record.expiresAt === 'number'
        && Number.isSafeInteger(record.expiresAt)
        && record.expiresAt > 0;
}

function readRollback(context: IdentityContext, now = Date.now()): JellyfishRollbackRecord | null {
    const key = rollbackKey(context);
    const result = JC.storage.local.readJson(STORAGE_OWNER, key, isRollbackRecord, 'rollback-record');
    if (result.state !== 'Valid') return null;
    if (!Number.isSafeInteger(now) || now < 0
        || result.value.expiresAt <= now
        || result.value.expiresAt - now > ROLLBACK_WINDOW_MS) {
        JC.storage.local.remove(STORAGE_OWNER, key, 'rollback-record');
        return null;
    }
    return result.value;
}

function completedInspection(
    context: IdentityContext,
    migration: ThemeLegacyMigration,
): JellyfishMigrationInspection {
    const theme = canonicalTheme(migration.JellyfishTheme);
    if (!migration.Completed || !theme) return { state: 'none' };
    const rollback = readRollback(context);
    return {
        state: 'completed',
        theme,
        rollbackAvailable: rollback?.theme === theme,
        rollbackExpiresAt: rollback?.theme === theme ? rollback.expiresAt : null,
    };
}

export function inspectJellyfishMigration(
    context: IdentityContext,
    migration: ThemeLegacyMigration,
): JellyfishMigrationInspection {
    if (!JC.identity.isCurrent(context)) return { state: 'none' };
    if (migration.Completed) return completedInspection(context, migration);

    const scoped = readString(scopedKey(context, 'customCss'), 'scoped-custom-css');
    const compatibility = readString(compatibilityKey(context, 'customCss'), 'compatibility-custom-css');
    if (scoped === undefined || compatibility === undefined) return { state: 'unrecognized' };
    const values = [
        typeof scoped === 'string' && scoped !== ''
            ? { key: scopedKey(context, 'customCss'), value: scoped, keyLabel: 'scoped-custom-css' }
            : null,
        typeof compatibility === 'string' && compatibility !== ''
            ? { key: compatibilityKey(context, 'customCss'), value: compatibility, keyLabel: 'compatibility-custom-css' }
            : null,
    ].filter((value): value is CapturedLegacyValue => value !== null);
    if (values.length === 0) return { state: 'none' };
    const themes = values.map(({ value }) => parseLegacyJellyfishImport(value));
    if (themes.some((theme) => theme === null) || new Set(themes).size !== 1) return { state: 'unrecognized' };

    const randomEntries = capturedOptional(context, 'randomThemeEnabled');
    const dateEntries = capturedOptional(context, 'lastRandomThemeDate');
    const randomEnabled = validRandomValue(randomEntries);
    const lastRandomDate = validRandomDate(dateEntries);
    return {
        state: 'available',
        selection: Object.freeze({
            theme: themes[0]!,
            source: values.length === 2 ? 'mirrored' : scoped ? 'scoped' : 'compatibility',
            // Unknown/mismatched optional values are neither interpreted nor
            // deleted. Arbitrary legacy data must not enter the bounded
            // rollback record, but it also must not be lost.
            captured: Object.freeze([
                ...values,
                ...(randomEnabled === null ? [] : randomEntries),
                ...(lastRandomDate === null ? [] : dateEntries),
            ]),
            randomEnabled,
            lastRandomDate,
        }),
    };
}

/** Validates the server mapping, then applies it to the active profile without dropping other profiles/schedules. */
export function mergeStagedJellyfishMigration(
    response: unknown,
    current: UserThemeConfiguration,
    expectedTheme: JellyfishThemeName,
): UserThemeConfiguration | null {
    const envelope = response as { valid?: unknown; data?: unknown } | null;
    const staged = envelope?.valid === true ? parseUserThemeConfiguration(envelope.data) : null;
    const stagedProfile = staged?.Profiles.find((profile) => profile.Id === staged.ActiveProfileId);
    if (!staged || !stagedProfile
        || staged.LegacyMigration.Completed !== true
        || staged.LegacyMigration.JellyfishTheme !== expectedTheme
        || stagedProfile.Palette !== `jellyfish-${expectedTheme.toLowerCase()}`
        || stagedProfile.Accent !== 'palette') return null;

    const candidate = structuredClone(current);
    const active = candidate.Profiles.find((profile) => profile.Id === candidate.ActiveProfileId);
    if (!active) return null;
    const id = active.Id;
    const name = active.Name;
    Object.assign(active, structuredClone(stagedProfile), { Id: id, Name: name });
    candidate.Revision = current.Revision;
    candidate.LegacyMigration = structuredClone(staged.LegacyMigration);
    return parseUserThemeConfiguration(candidate);
}

function removeCaptured(selection: JellyfishLegacySelection): { complete: boolean; count: number } {
    let complete = true;
    let count = 0;
    for (const entry of selection.captured) {
        const current = JC.storage.local.read(STORAGE_OWNER, entry.key, entry.keyLabel);
        if (current.state === 'Missing') continue;
        if (current.state !== 'Valid' || current.value !== entry.value) {
            complete = false;
            continue;
        }
        const removed = JC.storage.local.remove(STORAGE_OWNER, entry.key, entry.keyLabel);
        if (removed.state === 'Valid') count += 1;
        else complete = false;
    }
    return { complete, count };
}

export function removeAcknowledgedJellyfishStyles(theme: JellyfishThemeName): number {
    let count = 0;
    for (const style of document.querySelectorAll<HTMLStyleElement>('style')) {
        if (style.dataset.jcOwner === 'theme-studio') continue;
        if (parseLegacyJellyfishImport(style.textContent ?? '') !== theme) continue;
        style.remove();
        count += 1;
    }
    return count;
}

/**
 * The authoritative acknowledgement is the commit point. A rollback record is
 * durably written first; only then are still-unchanged legacy keys and exact
 * recognized style nodes removed.
 */
export function finalizeAcknowledgedJellyfishMigration(
    context: IdentityContext,
    configuration: UserThemeConfiguration,
    now = Date.now(),
): JellyfishCleanupResult {
    if (!JC.identity.isCurrent(context)) {
        return { acknowledged: false, rollbackAvailable: false, cleanupComplete: false, removedKeys: 0, removedStyles: 0 };
    }
    const theme = configuration.LegacyMigration.Completed
        ? canonicalTheme(configuration.LegacyMigration.JellyfishTheme)
        : null;
    if (!theme) {
        return { acknowledged: false, rollbackAvailable: false, cleanupComplete: false, removedKeys: 0, removedStyles: 0 };
    }

    const inspection = inspectJellyfishMigration(context, { JellyfishTheme: '', Completed: false });
    if (inspection.state !== 'available' || inspection.selection.theme !== theme) {
        const rollback = readRollback(context, now);
        return {
            acknowledged: true,
            rollbackAvailable: rollback?.theme === theme,
            cleanupComplete: inspection.state === 'none' || inspection.state === 'completed',
            removedKeys: 0,
            removedStyles: removeAcknowledgedJellyfishStyles(theme),
        };
    }

    const record: JellyfishRollbackRecord = {
        version: ROLLBACK_VERSION,
        theme,
        randomEnabled: inspection.selection.randomEnabled,
        lastRandomDate: inspection.selection.lastRandomDate,
        expiresAt: now + ROLLBACK_WINDOW_MS,
    };
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(record.expiresAt)) {
        return { acknowledged: true, rollbackAvailable: false, cleanupComplete: false, removedKeys: 0, removedStyles: 0 };
    }
    const serialized = JSON.stringify(record);
    if (new TextEncoder().encode(serialized).byteLength > MAXIMUM_ROLLBACK_BYTES
        || JC.storage.local.write(STORAGE_OWNER, rollbackKey(context), serialized, 'rollback-record').state !== 'Valid') {
        return { acknowledged: true, rollbackAvailable: false, cleanupComplete: false, removedKeys: 0, removedStyles: 0 };
    }
    const removed = removeCaptured(inspection.selection);
    return {
        acknowledged: true,
        rollbackAvailable: true,
        cleanupComplete: removed.complete,
        removedKeys: removed.count,
        removedStyles: removeAcknowledgedJellyfishStyles(theme),
    };
}

/** Restores only generated, bundled values. The legacy import is never executed by this function. */
export function restoreJellyfishCompatibilityKeys(
    context: IdentityContext,
    expectedTheme: JellyfishThemeName,
    now = Date.now(),
): boolean {
    if (!JC.identity.isCurrent(context)) return false;
    const rollback = readRollback(context, now);
    if (!rollback || rollback.theme !== expectedTheme) return false;
    const descriptor = JELLYFISH_THEMES.find(({ name }) => name === rollback.theme);
    if (!descriptor) return false;
    const values: Array<readonly [string, string, string]> = [
        [scopedKey(context, 'customCss'), importValue(descriptor.file), 'scoped-custom-css'],
        [compatibilityKey(context, 'customCss'), importValue(descriptor.file), 'compatibility-custom-css'],
    ];
    if (rollback.randomEnabled !== null) {
        values.push(
            [scopedKey(context, 'randomThemeEnabled'), String(rollback.randomEnabled), 'scoped-random-enabled'],
            [compatibilityKey(context, 'randomThemeEnabled'), String(rollback.randomEnabled), 'compatibility-random-enabled'],
        );
    }
    if (rollback.lastRandomDate !== null) {
        values.push(
            [scopedKey(context, 'lastRandomThemeDate'), rollback.lastRandomDate, 'scoped-random-date'],
            [compatibilityKey(context, 'lastRandomThemeDate'), rollback.lastRandomDate, 'compatibility-random-date'],
        );
    }
    // A rollback must never overwrite data written after migration. Browser
    // storage operations are synchronous, so preflight every destination
    // before beginning the bounded write set.
    for (const [key, , label] of values) {
        if (JC.storage.local.read(STORAGE_OWNER, key, label).state !== 'Missing') return false;
    }
    const written: Array<readonly [string, string, string]> = [];
    const undoWritten = () => {
        for (const [key, value, label] of written.reverse()) {
            const current = JC.storage.local.read(STORAGE_OWNER, key, label);
            if (current.state === 'Valid' && current.value === value) {
                JC.storage.local.remove(STORAGE_OWNER, key, label);
            }
        }
    };
    for (const [key, value, label] of values) {
        if (JC.storage.local.write(STORAGE_OWNER, key, value, label).state !== 'Valid') {
            undoWritten();
            return false;
        }
        written.push([key, value, label]);
    }
    if (JC.storage.local.remove(STORAGE_OWNER, rollbackKey(context), 'rollback-record').state !== 'Valid') {
        undoWritten();
        return false;
    }
    return true;
}
