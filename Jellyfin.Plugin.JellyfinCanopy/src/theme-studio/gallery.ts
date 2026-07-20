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

const SHA256_ROUND_CONSTANTS = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, amount: number): number {
    return (value >>> amount) | (value << (32 - amount));
}

/** Small local SHA-256 fallback for ordinary HTTP LAN Jellyfin origins without SubtleCrypto. */
function sha256Fallback(bytes: Uint8Array): string {
    const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
    const padded = new Uint8Array(paddedLength);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    const bitLength = bytes.length * 8;
    view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
    view.setUint32(paddedLength - 4, bitLength >>> 0, false);

    const hash = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    const words = new Uint32Array(64);
    for (let offset = 0; offset < paddedLength; offset += 64) {
        for (let index = 0; index < 16; index += 1) {
            words[index] = view.getUint32(offset + (index * 4), false);
        }
        for (let index = 16; index < 64; index += 1) {
            const previous15 = words[index - 15];
            const previous2 = words[index - 2];
            const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
            const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
            words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
        }

        let [a, b, c, d, e, f, g, h] = hash;
        for (let index = 0; index < 64; index += 1) {
            const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
            const choose = (e & f) ^ (~e & g);
            const temporary1 = (h + sum1 + choose + SHA256_ROUND_CONSTANTS[index] + words[index]) >>> 0;
            const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
            const majority = (a & b) ^ (a & c) ^ (b & c);
            const temporary2 = (sum0 + majority) >>> 0;
            h = g;
            g = f;
            f = e;
            e = (d + temporary1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (temporary1 + temporary2) >>> 0;
        }
        hash[0] = (hash[0] + a) >>> 0;
        hash[1] = (hash[1] + b) >>> 0;
        hash[2] = (hash[2] + c) >>> 0;
        hash[3] = (hash[3] + d) >>> 0;
        hash[4] = (hash[4] + e) >>> 0;
        hash[5] = (hash[5] + f) >>> 0;
        hash[6] = (hash[6] + g) >>> 0;
        hash[7] = (hash[7] + h) >>> 0;
    }
    return [...hash].map((word) => word.toString(16).padStart(8, '0')).join('');
}

export async function sha256Hex(
    value: string,
    subtle: Pick<SubtleCrypto, 'digest'> | null = globalThis.crypto?.subtle ?? null,
): Promise<string> {
    const bytes = new TextEncoder().encode(value);
    if (subtle) {
        try {
            const digest = await subtle.digest('SHA-256', bytes);
            return [...new Uint8Array(digest)]
                .map((byte) => byte.toString(16).padStart(2, '0')).join('');
        } catch {
            // Non-secure HTTP origins may expose crypto without a usable SubtleCrypto implementation.
        }
    }
    return sha256Fallback(bytes);
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

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unknownArray(value: unknown): value is unknown[] {
    return Array.isArray(value);
}

function validEntry(value: unknown, sourceIds: ReadonlySet<string>): value is CuratedThemeGalleryEntry {
    if (!record(value)) return false;
    const rawSourceIds: unknown = value.sourceIds;
    if (!unknownArray(rawSourceIds)) return false;
    const validatedSourceIds: string[] = [];
    for (const source of rawSourceIds) {
        if (typeof source !== 'string') return false;
        validatedSourceIds.push(source);
    }
    const entry = value;
    return typeof entry.id === 'string'
        && /^[a-z][a-z0-9-]{0,63}$/.test(entry.id)
        && typeof entry.version === 'number'
        && Number.isSafeInteger(entry.version) && entry.version > 0
        && typeof entry.name === 'string'
        && entry.name.trim() === entry.name && entry.name.length > 0 && [...entry.name].length <= 80
        && typeof entry.description === 'string'
        && entry.description.trim() === entry.description && entry.description.length > 0
        && typeof entry.presetId === 'string'
        && THEME_PRESET_IDS.includes(entry.presetId)
        && typeof entry.presetVersion === 'number'
        && Number.isSafeInteger(entry.presetVersion) && entry.presetVersion > 0
        && typeof entry.paletteId === 'string'
        && THEME_PALETTE_IDS.includes(entry.paletteId)
        && typeof entry.accentId === 'string'
        && THEME_ACCENT_IDS.includes(entry.accentId)
        && typeof entry.mode === 'string'
        && ['system', 'dark', 'light'].includes(entry.mode)
        && validatedSourceIds.length > 0 && validatedSourceIds.every((source) => sourceIds.has(source))
        && typeof entry.checksum === 'string'
        && /^[a-f0-9]{64}$/.test(entry.checksum);
}

const parsedManifest: unknown = manifest;
const provenanceIds = new Set(THEME_PROVENANCE.sources.map((source) => source.id));
if (!record(parsedManifest) || parsedManifest.schemaVersion !== 1 || !unknownArray(parsedManifest.entries)) {
    throw new TypeError('Curated Theme Studio gallery manifest is invalid');
}
const manifestEntries = parsedManifest.entries;
if (manifestEntries.length === 0 || manifestEntries.length > 32
    || !manifestEntries.every((entry): entry is CuratedThemeGalleryEntry => validEntry(entry, provenanceIds))) {
    throw new TypeError('Curated Theme Studio gallery manifest is invalid');
}
const curatedEntries: readonly CuratedThemeGalleryEntry[] = manifestEntries;
if (new Set(curatedEntries.map((entry) => entry.id)).size !== curatedEntries.length) {
    throw new TypeError('Curated Theme Studio gallery manifest is invalid');
}

export const CURATED_THEME_GALLERY: readonly CuratedThemeGalleryEntry[] = freeze(
    curatedEntries.map((entry) => ({ ...entry, sourceIds: [...entry.sourceIds] })),
);

export async function verifyCuratedGalleryEntry(entry: CuratedThemeGalleryEntry): Promise<boolean> {
    try {
        const actual = await sha256Hex(galleryIntegrityPayload(entry));
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
