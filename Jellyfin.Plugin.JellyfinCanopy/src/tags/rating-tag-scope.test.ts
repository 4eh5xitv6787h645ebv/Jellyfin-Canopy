import { beforeEach, describe, expect, it } from 'vitest';
import { JC } from '../globals';
import {
    RATING_TAG_ITEM_TYPES,
    RATING_TAG_SURFACES,
    normalizeRatingTagScopePolicy,
    resolveRatingTagRenderScope,
    shouldRenderRatingTag,
    type RatingTagItemType,
    type RatingTagSurface,
} from './rating-tag-scope';

function scope(itemType: RatingTagItemType, surface: RatingTagSurface) {
    return { itemType, surface, signature: `${surface}:test`, resolved: true } as const;
}

function policy(
    disabledItemTypes: readonly RatingTagItemType[] = [],
    disabledSurfaces: readonly RatingTagSurface[] = [],
) {
    return { Version: 1, DisabledItemTypes: [...disabledItemTypes], DisabledSurfaces: [...disabledSurfaces] };
}

describe('rating tag scope policy v1', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        JC.identity.transition('rating-scope-server', `rating-scope-${Date.now()}-${Math.random()}`, 'test');
    });

    it('preserves every existing type/surface combination for absent legacy policies', () => {
        for (const itemType of RATING_TAG_ITEM_TYPES) {
            for (const surface of RATING_TAG_SURFACES) {
                expect(shouldRenderRatingTag(scope(itemType, surface), {}, {})).toBe(true);
            }
        }
        expect(normalizeRatingTagScopePolicy(null)).toEqual({
            version: 1,
            disabledItemTypes: [],
            disabledSurfaces: [],
        });
        expect(normalizeRatingTagScopePolicy({ Version: 0 })).toEqual({
            version: 1,
            disabledItemTypes: [],
            disabledSurfaces: [],
        });
    });

    it('applies every media and surface deny independently across the full decision table', () => {
        for (const deniedType of RATING_TAG_ITEM_TYPES) {
            for (const itemType of RATING_TAG_ITEM_TYPES) {
                expect(shouldRenderRatingTag(
                    scope(itemType, 'Other'),
                    { RatingTagScopePolicy: policy([deniedType]) },
                    { ratingTagScopeOverrides: policy() },
                )).toBe(itemType !== deniedType);
            }
        }
        for (const deniedSurface of RATING_TAG_SURFACES) {
            for (const surface of RATING_TAG_SURFACES) {
                expect(shouldRenderRatingTag(
                    scope('Movie', surface),
                    { RatingTagScopePolicy: policy([], [deniedSurface]) },
                    { ratingTagScopeOverrides: policy() },
                )).toBe(surface !== deniedSurface);
            }
        }
    });

    it('unions administrator and user denies so a user cannot exceed the ceiling', () => {
        const admin = { RatingTagScopePolicy: policy(['Episode'], ['NextUp']) };
        const user = { ratingTagScopeOverrides: policy(['Season'], ['ContinueWatching']) };
        expect(shouldRenderRatingTag(scope('Episode', 'Other'), admin, user)).toBe(false);
        expect(shouldRenderRatingTag(scope('Season', 'Other'), admin, user)).toBe(false);
        expect(shouldRenderRatingTag(scope('Movie', 'NextUp'), admin, user)).toBe(false);
        expect(shouldRenderRatingTag(scope('Movie', 'ContinueWatching'), admin, user)).toBe(false);
        expect(shouldRenderRatingTag(scope('Movie', 'Other'), admin, user)).toBe(true);
    });

    it('fails closed for malformed policy and only unresolved surfaces that have an active deny', () => {
        const bad = [
            { Version: 2, DisabledItemTypes: [], DisabledSurfaces: [] },
            { Version: 1, DisabledItemTypes: ['Selector:.card'], DisabledSurfaces: [] },
            { Version: 1, DisabledItemTypes: [], DisabledSurfaces: ['Next Up'] },
            { Version: 1, DisabledItemTypes: [...RATING_TAG_ITEM_TYPES, 'Movie'], DisabledSurfaces: [] },
        ];
        for (const value of bad) {
            expect(normalizeRatingTagScopePolicy(value)).toBeNull();
            expect(shouldRenderRatingTag(
                scope('Movie', 'Other'),
                { RatingTagScopePolicy: value },
                {},
            )).toBe(false);
        }
        const unresolved = {
            itemType: 'Movie',
            surface: null,
            signature: 'pending',
            resolved: false,
        } as const;
        expect(shouldRenderRatingTag(unresolved, {}, {})).toBe(true);
        expect(shouldRenderRatingTag(
            unresolved,
            { RatingTagScopePolicy: policy([], ['NextUp']) },
            {},
        )).toBe(false);
        expect(shouldRenderRatingTag(
            { ...unresolved, itemType: 'Episode' },
            { RatingTagScopePolicy: policy(['Episode']) },
            {},
        )).toBe(false);
    });

    it('uses locale-independent home row identities and exposes a reuse signature', () => {
        const next = document.createElement('section');
        next.id = 'nextUpItemsSection';
        next.innerHTML = '<h2>任意の翻訳</h2><div class="card" data-type="Episode"><div class="cardImageContainer"></div></div>';
        document.body.appendChild(next);
        const image = next.querySelector('.cardImageContainer')!;
        expect(resolveRatingTagRenderScope(image)).toMatchObject({
            itemType: 'Episode',
            surface: 'NextUp',
            resolved: true,
        });
        expect(resolveRatingTagRenderScope(image).signature).toContain('NextUp:');
    });
});
