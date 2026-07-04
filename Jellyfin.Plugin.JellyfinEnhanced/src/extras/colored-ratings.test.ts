// Unit tests for src/extras/colored-ratings.ts — the mutation gate that
// replaced the permanent 1Hz polling interval and the characterData body
// observer (PERF fix). Only batches that can actually contain rating elements
// may schedule the full-document processing pass.
import { describe, expect, it } from 'vitest';
import { mutationsTouchRatings } from './colored-ratings';

function record(partial: Partial<MutationRecord>): MutationRecord {
    return {
        type: 'childList',
        addedNodes: [] as unknown as NodeList,
        removedNodes: [] as unknown as NodeList,
        target: document.body,
        ...partial
    } as MutationRecord;
}

describe('mutationsTouchRatings', () => {
    it('matches a directly added rating element', () => {
        const rating = document.createElement('div');
        rating.className = 'mediaInfoOfficialRating';

        const batch = [record({ addedNodes: [rating] as unknown as NodeList })];
        expect(mutationsTouchRatings(batch)).toBe(true);
    });

    it('matches a rating element nested inside an added subtree', () => {
        const wrapper = document.createElement('div');
        wrapper.innerHTML = '<span class="mediaInfoOfficialRating">PG-13</span>';

        const batch = [record({ addedNodes: [wrapper] as unknown as NodeList })];
        expect(mutationsTouchRatings(batch)).toBe(true);
    });

    it('matches a childList change whose target is a rating element (text swap)', () => {
        const rating = document.createElement('div');
        rating.className = 'mediaInfoOfficialRating';
        document.body.appendChild(rating);

        const batch = [record({ target: rating })];
        expect(mutationsTouchRatings(batch)).toBe(true);
        rating.remove();
    });

    it('ignores unrelated structural churn (e.g. streamed cards)', () => {
        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = '<div class="cardBox">title</div>';

        const batch = [
            record({ addedNodes: [card] as unknown as NodeList }),
            record({ target: card })
        ];
        expect(mutationsTouchRatings(batch)).toBe(false);
    });

    it('ignores non-childList records and text nodes', () => {
        const text = document.createTextNode('12:34');
        const batch = [
            record({ type: 'attributes' }),
            record({ addedNodes: [text] as unknown as NodeList })
        ];
        expect(mutationsTouchRatings(batch)).toBe(false);
    });
});
