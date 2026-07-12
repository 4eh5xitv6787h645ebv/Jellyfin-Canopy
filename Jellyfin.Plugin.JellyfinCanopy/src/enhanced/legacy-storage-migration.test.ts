import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migrateLegacyClientStorage } from './legacy-storage-migration';
import { getUserRowIds } from '../discovery/prefs';

describe('migrateLegacyClientStorage', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('adopts the legacy clear-marker so a processed admin clear does not re-fire', () => {
        localStorage.setItem('jellyfinElevateLastCleared', '1749990000000');

        migrateLegacyClientStorage();

        expect(localStorage.getItem('jellyfinCanopyLastCleared')).toBe('1749990000000');
        expect(localStorage.getItem('jellyfinElevateLastCleared')).toBeNull();
    });

    it('never overwrites an existing Canopy clear-marker', () => {
        localStorage.setItem('jellyfinCanopyLastCleared', '1750000000000');
        localStorage.setItem('jellyfinElevateLastCleared', '1749990000000');

        migrateLegacyClientStorage();

        expect(localStorage.getItem('jellyfinCanopyLastCleared')).toBe('1750000000000');
        expect(localStorage.getItem('jellyfinElevateLastCleared')).toBeNull();
    });

    it('drops the dead legacy settings blob', () => {
        localStorage.setItem('jellyfinElevateSettings', '{"themeName":"Ocean"}');

        migrateLegacyClientStorage();

        expect(localStorage.getItem('jellyfinElevateSettings')).toBeNull();
        // Nothing reads the blob any more, so it must NOT be carried over.
        expect(localStorage.getItem('jellyfinCanopySettings')).toBeNull();
    });

    it('adopts an active legacy hide-confirm suppression window', () => {
        localStorage.setItem('je_hide_confirm_suppressed_until', '9999999999999');

        migrateLegacyClientStorage();

        expect(localStorage.getItem('jc_hide_confirm_suppressed_until')).toBe('9999999999999');
        expect(localStorage.getItem('je_hide_confirm_suppressed_until')).toBeNull();
    });

    it('never overwrites an existing Canopy suppression window', () => {
        localStorage.setItem('jc_hide_confirm_suppressed_until', '1000');
        localStorage.setItem('je_hide_confirm_suppressed_until', '2000');

        migrateLegacyClientStorage();

        expect(localStorage.getItem('jc_hide_confirm_suppressed_until')).toBe('1000');
        expect(localStorage.getItem('je_hide_confirm_suppressed_until')).toBeNull();
    });

    it('is a no-op when no legacy keys exist', () => {
        migrateLegacyClientStorage();

        expect(localStorage.getItem('jellyfinCanopyLastCleared')).toBeNull();
        expect(localStorage.getItem('jellyfinCanopySettings')).toBeNull();
    });

    describe('discovery row preferences (dynamic per-user keys)', () => {
        afterEach(() => {
            vi.unstubAllGlobals();
        });

        it('adopts customized rows and the real consumer reads them back', () => {
            vi.stubGlobal('ApiClient', { getCurrentUserId: () => 'user-1' });
            localStorage.setItem('je-discovery-rows:user-1:movies', JSON.stringify(['trending', 'upcoming']));

            migrateLegacyClientStorage();

            expect(getUserRowIds('movies' as never)).toEqual(['trending', 'upcoming']);
            expect(localStorage.getItem('je-discovery-rows:user-1:movies')).toBeNull();
        });

        it('preserves an explicitly-empty customization (hidden-everything is a choice)', () => {
            vi.stubGlobal('ApiClient', { getCurrentUserId: () => 'user-1' });
            localStorage.setItem('je-discovery-rows:user-1:tv', '[]');

            migrateLegacyClientStorage();

            expect(getUserRowIds('tv' as never)).toEqual([]);
        });

        it('never overwrites rows a Canopy build already wrote', () => {
            localStorage.setItem('jc-discovery-rows:user-2:movies', JSON.stringify(['new']));
            localStorage.setItem('je-discovery-rows:user-2:movies', JSON.stringify(['old']));

            migrateLegacyClientStorage();

            expect(localStorage.getItem('jc-discovery-rows:user-2:movies')).toBe(JSON.stringify(['new']));
            expect(localStorage.getItem('je-discovery-rows:user-2:movies')).toBeNull();
        });
    });

    it('drops legacy self-rebuilding caches without adopting them', () => {
        localStorage.setItem('JellyfinElevate-peopleTagsCache', '{"p1":{}}');
        localStorage.setItem('JE_translation_fr_1.0.0.0', '{"k":"v"}');
        localStorage.setItem('je_conn_test_sonarr', '{"ok":true}');

        migrateLegacyClientStorage();

        expect(localStorage.getItem('JellyfinElevate-peopleTagsCache')).toBeNull();
        expect(localStorage.getItem('JE_translation_fr_1.0.0.0')).toBeNull();
        expect(localStorage.getItem('je_conn_test_sonarr')).toBeNull();
        expect(localStorage.getItem('JellyfinCanopy-peopleTagsCache')).toBeNull();
    });

    it('leaves unrelated keys untouched', () => {
        localStorage.setItem('jellyfin_credentials', '{"Servers":[]}');
        localStorage.setItem('user-1-language', 'fr-FR');

        migrateLegacyClientStorage();

        expect(localStorage.getItem('jellyfin_credentials')).toBe('{"Servers":[]}');
        expect(localStorage.getItem('user-1-language')).toBe('fr-FR');
    });
});
