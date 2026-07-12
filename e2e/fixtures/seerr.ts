// Readiness probes for the Seerr / TMDB integration specs.
//
// The reproducible docker seed (e2e/docker/seed.sh) boots WITHOUT a TMDB key or
// a Jellyseerr connection unless the optional TMDB_API_KEY / JELLYSEERR_* env
// vars are supplied at seed time. The parental / reviews / requests specs need
// a live TMDB or Seerr backend, so they read the plugin's OWN public-config
// (the TmdbEnabled / JellyseerrEnabled projections) to decide whether to run:
//   - a deliberately-bare env SKIPS cleanly instead of timing out on a
//     precondition that can never be met, and
//   - a configured CI/dev run RUNS the guard.
//
// Probes must be called AFTER loginAs — public-config lands on
// window.JellyfinCanopy.pluginConfig once the plugin has booted.
import type { Page } from 'playwright/test';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Read a boolean flag off the booted plugin's public-config. */
async function publicConfigFlag(page: Page, key: string): Promise<boolean> {
    return page.evaluate((k) => {
        const cfg = (window as any).JellyfinCanopy?.pluginConfig;
        return !!(cfg && cfg[k] === true);
    }, key);
}

/**
 * True when a TMDB API key is configured (TmdbEnabled projected `true`), so the
 * TMDB passthrough, reviews and release-date surfaces work.
 */
export async function tmdbReady(page: Page): Promise<boolean> {
    return publicConfigFlag(page, 'TmdbEnabled');
}

/**
 * True when a Jellyseerr connection is configured (JellyseerrEnabled projected
 * `true`), so the search / detail / request proxy works.
 */
export async function seerrReady(page: Page): Promise<boolean> {
    return publicConfigFlag(page, 'JellyseerrEnabled');
}

/**
 * Resolve a Jellyfin user's id by name from an ADMIN session (needs /Users).
 * Shared by the parental-rating specs so each drives the SAME restricted
 * account whose per-user policy the server resolves the limit from.
 */
export async function findRestrictedUserId(page: Page, username: string): Promise<string> {
    return page.evaluate(async (name: string) => {
        const api = (window as any).ApiClient;
        const users = await api.getJSON(api.getUrl('/Users'));
        const match = (users || []).find((u: any) => u.Name === name);
        if (!match) throw new Error(`user ${name} not found`);
        return match.Id as string;
    }, username);
}

/**
 * Set (score) or clear (null) a user's MaxParentalRating via the Jellyfin
 * policy API from an ADMIN session. The plugin's parental filter reads this
 * per-user limit server-side, so flipping it is how the specs prove the gate
 * is the CALLER's own, not a fixed one.
 */
export async function setMaxParentalRating(page: Page, userId: string, score: number | null): Promise<void> {
    await page.evaluate(async (args: { userId: string; score: number | null }) => {
        const api = (window as any).ApiClient;
        const user = await api.getJSON(api.getUrl(`/Users/${args.userId}`));
        const policy = user.Policy;
        policy.MaxParentalRating = args.score;
        await api.ajax({
            type: 'POST',
            url: api.getUrl(`/Users/${args.userId}/Policy`),
            data: JSON.stringify(policy),
            contentType: 'application/json',
        });
    }, { userId, score });
}

/**
 * Set (list) or clear (empty array) a user's tag-based parental controls via
 * the Jellyfin policy API from an ADMIN session. The plugin's tag branch reads
 * BlockedTags/AllowedTags per caller server-side.
 */
export async function setParentalTags(
    page: Page,
    userId: string,
    blockedTags: string[],
    allowedTags: string[] = []
): Promise<void> {
    await page.evaluate(async (args: { userId: string; blockedTags: string[]; allowedTags: string[] }) => {
        const api = (window as any).ApiClient;
        const user = await api.getJSON(api.getUrl(`/Users/${args.userId}`));
        const policy = user.Policy;
        policy.BlockedTags = args.blockedTags;
        policy.AllowedTags = args.allowedTags;
        await api.ajax({
            type: 'POST',
            url: api.getUrl(`/Users/${args.userId}/Policy`),
            data: JSON.stringify(policy),
            contentType: 'application/json',
        });
    }, { userId, blockedTags, allowedTags });
}
