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
// window.JellyfinEnhanced.pluginConfig once the plugin has booted.
import type { Page } from 'playwright/test';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Read a boolean flag off the booted plugin's public-config. */
async function publicConfigFlag(page: Page, key: string): Promise<boolean> {
    return page.evaluate((k) => {
        const cfg = (window as any).JellyfinEnhanced?.pluginConfig;
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
