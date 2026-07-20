import type { ThemeProfile } from '../types/jc';
import {
    THEME_ACCENT_IDS,
    THEME_PALETTE_IDS,
    THEME_PRESET_IDS,
    THEME_PROVENANCE,
} from './catalog';
import manifest from './curated-gallery.json';

export interface CuratedThemeGalleryEntry {
    readonly id: string;
    readonly version: number;
    readonly name: string;
    readonly description: string;
    readonly presetId: string;
    readonly presetVersion: number;
    readonly paletteId: string;
    readonly accentId: string;
    readonly mode: 'system' | 'dark' | 'light';
    readonly sourceIds: readonly string[];
    readonly checksum: string;
}

interface CuratedThemeGalleryManifest {
    readonly schemaVersion: number;
    readonly entries: readonly CuratedThemeGalleryEntry[];
}

function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

export function galleryIntegrityPayload(entry: CuratedThemeGalleryEntry): string {
    const { checksum: _checksum, ...payload } = entry;
    return canonical(payload);
}

function freeze<T>(value: T): Readonly<T> {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
    }
    return value;
}

function validEntry(entry: CuratedThemeGalleryEntry, sourceIds: ReadonlySet<string>): boolean {
    return /^[a-z][a-z0-9-]{0,63}$/.test(entry.id)
        && Number.isSafeInteger(entry.version) && entry.version > 0
        && entry.name.trim() === entry.name && entry.name.length > 0 && [...entry.name].length <= 80
        && entry.description.trim() === entry.description && entry.description.length > 0
        && THEME_PRESET_IDS.includes(entry.presetId)
        && Number.isSafeInteger(entry.presetVersion) && entry.presetVersion > 0
        && THEME_PALETTE_IDS.includes(entry.paletteId)
        && THEME_ACCENT_IDS.includes(entry.accentId)
        && ['system', 'dark', 'light'].includes(entry.mode)
        && entry.sourceIds.length > 0 && entry.sourceIds.every((source) => sourceIds.has(source))
        && /^[a-f0-9]{64}$/.test(entry.checksum);
}

const parsedManifest = manifest as CuratedThemeGalleryManifest;
const provenanceIds = new Set(THEME_PROVENANCE.sources.map((source) => source.id));
if (parsedManifest.schemaVersion !== 1 || !Array.isArray(parsedManifest.entries)
    || parsedManifest.entries.length === 0 || parsedManifest.entries.length > 32
    || !parsedManifest.entries.every((entry) => validEntry(entry, provenanceIds))
    || new Set(parsedManifest.entries.map((entry) => entry.id)).size !== parsedManifest.entries.length) {
    throw new TypeError('Curated Theme Studio gallery manifest is invalid');
}

export const CURATED_THEME_GALLERY: readonly CuratedThemeGalleryEntry[] = freeze(
    parsedManifest.entries.map((entry) => ({ ...entry, sourceIds: [...entry.sourceIds] })),
);

export async function verifyCuratedGalleryEntry(entry: CuratedThemeGalleryEntry): Promise<boolean> {
    try {
        const bytes = new TextEncoder().encode(galleryIntegrityPayload(entry));
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const actual = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
        return actual === entry.checksum;
    } catch {
        return false;
    }
}

export function galleryProvenance(entry: CuratedThemeGalleryEntry): readonly {
    readonly name: string;
    readonly license: string;
}[] {
    const selected = new Set(entry.sourceIds);
    return THEME_PROVENANCE.sources.filter((source) => selected.has(source.id))
        .map((source) => Object.freeze({ name: source.name, license: source.license }));
}

/** Applies only typed catalog identifiers; no gallery entry contains executable CSS. */
export function applyCuratedGalleryEntry(profile: ThemeProfile, entry: CuratedThemeGalleryEntry): void {
    profile.BasePreset = entry.presetId;
    profile.PresetVersion = entry.presetVersion;
    profile.FreezePresetVersion = true;
    profile.Palette = entry.paletteId;
    profile.Accent = entry.accentId;
    profile.Mode = entry.mode;
    profile.Tokens = {};
    profile.Responsive = { Phone: null, Tablet: null, Desktop: null, Wide: null, Tv: null };
    profile.Accessibility = {
        Motion: 'system',
        Contrast: 'system',
        Transparency: 'system',
        FocusEmphasis: 'system',
        UnderlineLinks: false,
    };
}
