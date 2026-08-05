import { describe, expect, it } from 'vitest';
import { normalizeCriticPercent, ratingsAreMissing } from './critic-rating';

describe('Jellyfin critic percentage contract (#682)', () => {
    it.each([
        [0, 0],
        [-0, 0],
        [7, 7],
        [10, 10],
        [10.1, 10],
        [72, 72],
        [99.5, 100],
        [100, 100],
    ])('keeps direct 0–100 values on their native scale (%s → %s)', (raw, expected) => {
        expect(normalizeCriticPercent(raw)).toBe(expected);
    });

    it.each([
        null,
        undefined,
        '',
        '7',
        true,
        false,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        -1,
        -0.1,
        100.1,
        101,
    ])('rejects missing, coerced, non-finite, or out-of-range input (%s)', (raw) => {
        expect(normalizeCriticPercent(raw)).toBeNull();
    });

    it('inherits only when both raw child fields are nullish', () => {
        expect(ratingsAreMissing({})).toBe(true);
        expect(ratingsAreMissing({ CommunityRating: null, CriticRating: undefined })).toBe(true);
        expect(ratingsAreMissing({ CommunityRating: 0, CriticRating: null })).toBe(false);
        expect(ratingsAreMissing({ CommunityRating: null, CriticRating: 0 })).toBe(false);
        expect(ratingsAreMissing({ CommunityRating: null, CriticRating: 7 })).toBe(false);
        expect(ratingsAreMissing({ CommunityRating: null, CriticRating: -1 })).toBe(false);
    });
});
