import { describe, expect, it } from 'vitest';
import { themeConfiguration } from '../test/theme-studio-fixture';
import {
    applyCuratedGalleryEntry,
    CURATED_THEME_GALLERY,
    galleryIntegrityPayload,
    galleryProvenance,
    verifyCuratedGalleryEntry,
} from './gallery';

describe('Theme Studio curated gallery', () => {
    it('ships unique, immutable, accessible entries with verified SHA-256 integrity and provenance', async () => {
        expect(CURATED_THEME_GALLERY).toHaveLength(9);
        expect(new Set(CURATED_THEME_GALLERY.map((entry) => entry.id)).size).toBe(9);
        for (const entry of CURATED_THEME_GALLERY) {
            expect(Object.isFrozen(entry), entry.id).toBe(true);
            expect(entry.description.length, entry.id).toBeGreaterThan(40);
            expect(entry.checksum).toMatch(/^[a-f0-9]{64}$/);
            expect(galleryIntegrityPayload(entry)).not.toContain(entry.checksum);
            await expect(verifyCuratedGalleryEntry(entry), entry.id).resolves.toBe(true);
            expect(galleryProvenance(entry).length, entry.id).toBeGreaterThan(0);
            expect(galleryProvenance(entry).every((source) => source.name && source.license)).toBe(true);
        }
    });

    it('fails a modified entry closed and applies only typed profile fields', async () => {
        const entry = CURATED_THEME_GALLERY[2];
        await expect(verifyCuratedGalleryEntry({ ...entry, paletteId: 'neutral' })).resolves.toBe(false);
        const profile = themeConfiguration().Profiles[0];
        profile.Tokens['color.primary'] = '#123456';
        applyCuratedGalleryEntry(profile, entry);
        expect(profile).toMatchObject({
            BasePreset: entry.presetId,
            PresetVersion: entry.presetVersion,
            FreezePresetVersion: true,
            Palette: entry.paletteId,
            Accent: entry.accentId,
            Mode: entry.mode,
            Tokens: {},
        });
        expect(JSON.stringify(profile)).not.toMatch(/css|url|script|html/i);
    });
});
