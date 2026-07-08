// Unit tests for the release-row formatters.
import { describe, expect, it } from 'vitest';
import { formatSize, formatAge } from './format';

describe('formatSize', () => {
    it('formats bytes across units with sensible precision', () => {
        expect(formatSize(0)).toBe('—');
        expect(formatSize(512)).toBe('512 B');
        expect(formatSize(2048)).toBe('2 KB');
        expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB');
        expect(formatSize(1.5 * 1024 * 1024 * 1024)).toBe('1.50 GB');
        expect(formatSize(21128010988)).toBe('19.68 GB');
    });

    it('returns a dash for missing/negative sizes', () => {
        expect(formatSize(-1)).toBe('—');
        expect(formatSize(NaN)).toBe('—');
    });
});

describe('formatAge', () => {
    it('formats hours into compact human ages', () => {
        expect(formatAge(5)).toBe('5h');
        expect(formatAge(30)).toBe('1d');
        expect(formatAge(24 * 10)).toBe('10d');
        expect(formatAge(24 * 21)).toBe('3w');
        expect(formatAge(24 * 90)).toBe('3mo');
        expect(formatAge(24 * 400)).toBe('1.1y');
    });

    it('returns a dash for missing ages', () => {
        expect(formatAge(0)).toBe('—');
        expect(formatAge(-3)).toBe('—');
    });
});
