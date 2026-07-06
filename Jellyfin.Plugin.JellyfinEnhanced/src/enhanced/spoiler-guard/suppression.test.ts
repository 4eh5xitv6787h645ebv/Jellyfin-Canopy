// src/enhanced/spoiler-guard/suppression.test.ts
import { describe, expect, it } from 'vitest';
import {
    shouldSuppressRatingTag, decideReviewSuppression,
    type RatingSuppressionConfig, type ReviewSuppressionConfig,
} from './suppression';

const GUARDED = 'series-1';
function ratingCfg(over: Partial<RatingSuppressionConfig> = {}): RatingSuppressionConfig {
    return {
        spoilerBlurEnabled: true,
        stripRatings: true,
        hideRatings: true,
        loadOk: true,
        isSeriesEnabled: (id) => id === GUARDED,
        ...over,
    };
}
function reviewCfg(over: Partial<ReviewSuppressionConfig> = {}): ReviewSuppressionConfig {
    return {
        spoilerBlurEnabled: true,
        stripReviews: true,
        hideReviews: true,
        loadOk: true,
        isMovieEnabled: (id) => id === 'movie-1',
        isSeriesEnabled: (id) => id === GUARDED,
        ...over,
    };
}

describe('shouldSuppressRatingTag', () => {
    it('suppresses a guarded Series, reveals an unguarded one', () => {
        expect(shouldSuppressRatingTag({ Type: 'Series', Id: GUARDED }, ratingCfg())).toBe(true);
        expect(shouldSuppressRatingTag({ Type: 'Series', Id: 'other' }, ratingCfg())).toBe(false);
    });
    it('suppresses guarded Season / unwatched Episode via parent series', () => {
        expect(shouldSuppressRatingTag({ Type: 'Season', SeriesId: GUARDED }, ratingCfg())).toBe(true);
        expect(shouldSuppressRatingTag({ Type: 'Episode', SeriesId: GUARDED }, ratingCfg())).toBe(true);
    });
    it('reveals a WATCHED episode rating even when guarded', () => {
        expect(shouldSuppressRatingTag(
            { Type: 'Episode', SeriesId: GUARDED, UserData: { Played: true } }, ratingCfg(),
        )).toBe(false);
    });
    it('respects the gates: feature off / strip off / user opt-out', () => {
        expect(shouldSuppressRatingTag({ Type: 'Series', Id: GUARDED }, ratingCfg({ spoilerBlurEnabled: false }))).toBe(false);
        expect(shouldSuppressRatingTag({ Type: 'Series', Id: GUARDED }, ratingCfg({ stripRatings: false }))).toBe(false);
        expect(shouldSuppressRatingTag({ Type: 'Series', Id: GUARDED }, ratingCfg({ hideRatings: false }))).toBe(false);
    });
    it('fails CLOSED on a guardable surface while state is not authoritative', () => {
        expect(shouldSuppressRatingTag({ Type: 'Series', Id: GUARDED }, ratingCfg({ loadOk: false }))).toBe(true);
        expect(shouldSuppressRatingTag({ Type: 'Season', SeriesId: 'anything' }, ratingCfg({ loadOk: false }))).toBe(true);
    });
    it('ignores non-guardable types and nullish items', () => {
        expect(shouldSuppressRatingTag({ Type: 'Movie', Id: 'm' }, ratingCfg())).toBe(false);
        expect(shouldSuppressRatingTag(null, ratingCfg())).toBe(false);
    });
    it('fails CLOSED when the accessor throws (unexpected error) and the feature is on', () => {
        const cfg = ratingCfg({ isSeriesEnabled: () => { throw new Error('boom'); } });
        expect(shouldSuppressRatingTag({ Type: 'Series', Id: GUARDED }, cfg)).toBe(true);
    });
});

describe('decideReviewSuppression', () => {
    it('suppresses a guarded Movie / Series and its child pages', () => {
        expect(decideReviewSuppression({ Id: 'movie-1' }, 'Movie', reviewCfg())).toBe(true);
        expect(decideReviewSuppression({ Id: GUARDED }, 'Series', reviewCfg())).toBe(true);
        expect(decideReviewSuppression({ SeriesId: GUARDED }, 'Season', reviewCfg())).toBe(true);
        expect(decideReviewSuppression({ SeriesId: GUARDED }, 'Episode', reviewCfg())).toBe(true);
    });
    it('does not suppress unguarded items or unrelated media types', () => {
        expect(decideReviewSuppression({ Id: 'movie-x' }, 'Movie', reviewCfg())).toBe(false);
        expect(decideReviewSuppression({ Id: GUARDED }, 'Person', reviewCfg())).toBe(false);
    });
    it('respects the gates: feature off / strip off / user opt-out', () => {
        expect(decideReviewSuppression({ Id: GUARDED }, 'Series', reviewCfg({ spoilerBlurEnabled: false }))).toBe(false);
        expect(decideReviewSuppression({ Id: GUARDED }, 'Series', reviewCfg({ stripReviews: false }))).toBe(false);
        expect(decideReviewSuppression({ Id: GUARDED }, 'Series', reviewCfg({ hideReviews: false }))).toBe(false);
    });
    it('fails CLOSED (suppress) when state load failed, on a guardable surface', () => {
        expect(decideReviewSuppression({ Id: 'movie-x' }, 'Movie', reviewCfg({ loadOk: false }))).toBe(true);
        // ...but not for a non-guardable media type.
        expect(decideReviewSuppression({ Id: 'x' }, 'Person', reviewCfg({ loadOk: false }))).toBe(false);
    });
});
