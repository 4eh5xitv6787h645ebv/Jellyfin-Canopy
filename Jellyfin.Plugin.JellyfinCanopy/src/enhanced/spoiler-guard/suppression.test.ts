// src/enhanced/spoiler-guard/suppression.test.ts
import { describe, expect, it } from 'vitest';
import {
    shouldSuppressRatingTag, decideReviewSuppression,
    type RatingSuppressionConfig, type ReviewSuppressionConfig,
} from './suppression';

const GUARDED = 'series-1';
const GUARDED_MOVIE = 'movie-1';
function ratingCfg(over: Partial<RatingSuppressionConfig> = {}): RatingSuppressionConfig {
    return {
        spoilerBlurEnabled: true,
        stripRatings: true,
        hideRatings: true,
        loadOk: true,
        isSeriesEnabled: (id) => id === GUARDED,
        isMovieEnabled: (id) => id === GUARDED_MOVIE,
        ...over,
    };
}
function reviewCfg(over: Partial<ReviewSuppressionConfig> = {}): ReviewSuppressionConfig {
    return {
        spoilerBlurEnabled: true,
        stripReviews: true,
        hideReviews: true,
        loadOk: true,
        isMovieEnabled: (id) => id === GUARDED_MOVIE,
        isSeriesEnabled: (id) => id === GUARDED,
        hasEnabledCollections: false,
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
        expect(shouldSuppressRatingTag({ Type: 'Season', SeriesId: GUARDED }, ratingCfg({ hideRatings: false }))).toBe(false);
    });
    it('fails CLOSED on a guardable surface while state is not authoritative', () => {
        expect(shouldSuppressRatingTag({ Type: 'Series', Id: GUARDED }, ratingCfg({ loadOk: false }))).toBe(true);
        expect(shouldSuppressRatingTag({ Type: 'Season', SeriesId: 'anything' }, ratingCfg({ loadOk: false }))).toBe(true);
    });
    it('suppresses a guarded Movie, reveals an unguarded one', () => {
        expect(shouldSuppressRatingTag({ Type: 'Movie', Id: GUARDED_MOVIE }, ratingCfg())).toBe(true);
        expect(shouldSuppressRatingTag({ Type: 'Movie', Id: 'other-movie' }, ratingCfg())).toBe(false);
    });
    it('fails CLOSED on a guarded-Movie surface while state is not authoritative', () => {
        expect(shouldSuppressRatingTag({ Type: 'Movie', Id: 'any-movie' }, ratingCfg({ loadOk: false }))).toBe(true);
    });
    it('a Movie with no Id is not suppressed', () => {
        expect(shouldSuppressRatingTag({ Type: 'Movie' }, ratingCfg())).toBe(false);
    });
    it('ignores non-guardable types and nullish items', () => {
        expect(shouldSuppressRatingTag({ Type: 'BoxSet', Id: 'm' }, ratingCfg())).toBe(false);
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

    describe('movie guarded via collection (server scope)', () => {
        it('does not consult scope when no collection is opted in', () => {
            // hasEnabledCollections defaults to false → non-enabled movie reveals,
            // even if a scope object was (wrongly) supplied.
            expect(decideReviewSuppression({ Id: 'movie-x' }, 'Movie',
                reviewCfg({ movieScope: { inScope: true, played: false } }))).toBe(false);
        });
        it('suppresses when scope says in-scope and unplayed', () => {
            expect(decideReviewSuppression({ Id: 'movie-x' }, 'Movie',
                reviewCfg({ hasEnabledCollections: true, movieScope: { inScope: true, played: false } }))).toBe(true);
        });
        it('reveals when in-scope but already played', () => {
            expect(decideReviewSuppression({ Id: 'movie-x' }, 'Movie',
                reviewCfg({ hasEnabledCollections: true, movieScope: { inScope: true, played: true } }))).toBe(false);
        });
        it('reveals when the movie is not in any guarded collection', () => {
            expect(decideReviewSuppression({ Id: 'movie-x' }, 'Movie',
                reviewCfg({ hasEnabledCollections: true, movieScope: { inScope: false, played: false } }))).toBe(false);
        });
        it('fails CLOSED (suppress) when the scope lookup failed (null)', () => {
            expect(decideReviewSuppression({ Id: 'movie-x' }, 'Movie',
                reviewCfg({ hasEnabledCollections: true, movieScope: null }))).toBe(true);
        });
        it('reveals when no lookup applied (undefined) despite a collection opted in', () => {
            // undefined = caller decided no lookup was needed (e.g. directly enabled
            // path already handled, or gate short-circuited) → do not suppress.
            expect(decideReviewSuppression({ Id: 'movie-x' }, 'Movie',
                reviewCfg({ hasEnabledCollections: true, movieScope: undefined }))).toBe(false);
        });
        it('a directly-enabled movie suppresses without needing scope', () => {
            expect(decideReviewSuppression({ Id: GUARDED_MOVIE }, 'Movie',
                reviewCfg({ hasEnabledCollections: true, movieScope: null }))).toBe(true);
        });
    });
});
