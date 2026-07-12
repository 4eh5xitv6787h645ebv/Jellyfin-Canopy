import { beforeEach, describe, expect, it } from 'vitest';

import { migrateLegacyClientStorage } from './legacy-storage-migration';

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
});
