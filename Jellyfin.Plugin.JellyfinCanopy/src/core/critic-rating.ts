/** Minimal rating shape used by poster, pipeline, and player fallback decisions. */
export interface RatingPair {
    CommunityRating?: unknown;
    CriticRating?: unknown;
}

/**
 * Normalize Jellyfin's CriticRating contract to a display-ready percentage.
 * Jellyfin stores Rotten Tomatoes as a direct 0–100 number; single digits are
 * already percentages and must never be rescaled as a 0–10 score.
 */
export function normalizeCriticPercent(raw: unknown): number | null {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 100) {
        return null;
    }

    const rounded = Math.round(raw);
    return rounded === 0 ? 0 : rounded;
}

/** Parent ratings are eligible only when both child fields are genuinely absent. */
export function ratingsAreMissing(item: RatingPair): boolean {
    return item.CommunityRating == null && item.CriticRating == null;
}
