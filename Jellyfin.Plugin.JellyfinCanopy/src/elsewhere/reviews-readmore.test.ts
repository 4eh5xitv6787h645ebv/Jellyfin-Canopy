// MISC-4: the TMDB review "read more" toggle resolved the review by comparing
// escapeHtml(author) to the card's DECODED textContent — a mismatch for any
// author with ' & < > " (e.g. "O'Brien"), so those reviews could never expand.
// The resolver now keys off a stable data-review-index on the card.
import { describe, expect, it } from 'vitest';
import { resolveReviewByCard } from './reviews';

interface Review { author: string; content: string; }

/** Build a card exactly as createReviewElement does: index in dataset, DECODED author text. */
function cardFor(index: number, author: string): HTMLElement {
    const card = document.createElement('div');
    card.className = 'tmdb-review-card';
    card.dataset.reviewIndex = String(index);
    const strong = document.createElement('strong');
    strong.className = 'tmdb-review-author';
    strong.textContent = author; // rendered decoded, e.g. O'Brien
    card.appendChild(strong);
    return card;
}

describe('review read-more resolution (MISC-4)', () => {
    const reviews: Review[] = [
        { author: 'Ada', content: 'first' },
        { author: "O'Brien", content: 'apostrophe author expands' },
        { author: 'A & B <c> "d"', content: 'all the escape-sensitive chars' },
    ];

    it('resolves an apostrophe author ("O\'Brien") by its stable index', () => {
        const review = resolveReviewByCard(reviews, cardFor(1, "O'Brien"));
        expect(review).toBe(reviews[1]);
        expect(review!.content).toBe('apostrophe author expands');
    });

    it('resolves an author with & < > " by index', () => {
        expect(resolveReviewByCard(reviews, cardFor(2, 'A & B <c> "d"'))).toBe(reviews[2]);
    });

    it('returns undefined when the card carries no index', () => {
        const card = document.createElement('div');
        expect(resolveReviewByCard(reviews, card)).toBeUndefined();
    });

    it('the old escaped-author-vs-textContent comparison would have failed for these authors', () => {
        // Demonstrates the defect the index fix removes: escapeHtml rewrites the
        // apostrophe (&#039;) while the card's textContent is decoded, so equality
        // never held and the review never resolved.
        const escapeHtml = (s: string): string =>
            s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
        const card = cardFor(1, "O'Brien");
        const author = card.querySelector('.tmdb-review-author')!.textContent;
        const legacyMatch = reviews.find(r => escapeHtml(r.author) === author);
        expect(legacyMatch).toBeUndefined();
    });
});
