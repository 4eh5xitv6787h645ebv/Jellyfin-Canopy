// Spoiler Guard: the per-user, opt-in unwatched-content protection feature.
//
// Content-independent by design so the same suite is meaningful on BOTH the
// shared dev server (:8099, 1000+ series, feature already enabled) and the
// disposable docker seed (:8100, the single "Guard Test Show"): a target series
// with an unwatched episode is chosen VIA the REST API in beforeAll and the UI
// is driven against its detail page. When the admin master switch
// (SpoilerBlurEnabled) is off on the target server, every test SKIPs — mirroring
// the tmdbReady()/seerr guards in the other specs.
//
// Coverage:
//   a. non-admin toggle ON  → aria-pressed flips, toast, API state + episode
//      metadata stripped (Name → "Season X, Episode Y"), no broken card images
//   b. toggle OFF           → the disable-confirm dialog, then state cleared +
//      episode Name restored to its real value
//   c. per-user isolation   → the admin's API view keeps the real episode Name
//      while the non-admin has the guard ON
//   d. settings panel       → the Spoiler Guard override section renders and one
//      override checkbox persists through GET /spoiler-blur/user-prefs
//
// Every test asserts a clean console/net and restores ALL state it changes
// (guard off, prefs back) in a finally block, even on failure.
import { test, expect, loginAs, assertNoRuntimeErrors } from './fixtures/auth';
import { authenticate, api, apiRaw, type Session } from './fixtures/api';
import type { Page } from 'playwright/test';

/* eslint-disable @typescript-eslint/no-explicit-any */

const BASE = process.env.JF_BASE_URL || 'http://localhost:8099';
const SEED_SERIES = 'Guard Test Show';

// The deterministic, content-independent signal: an unwatched episode of a
// guarded series has its title replaced with exactly this shape server-side.
const STRIPPED_NAME = /^Season \d+, Episode \d+$/;
// The admin default overview placeholder (PluginConfiguration.SpoilerOverviewPlaceholder).
const OVERVIEW_PLACEHOLDER = 'Spoiler Guard activated';

interface EpisodeInfo {
    id: string;
    name: string;
    overview: string;
    played: boolean;
    hasImage: boolean;
}

interface Target {
    seriesId: string; // dashed form, as returned by /Items (used for #/details nav)
    seriesName: string;
    unwatched: EpisodeInfo; // an unwatched episode of the series (guard target)
    watched: EpisodeInfo | null; // a watched episode, when the server has one
}

/** Normalize a Jellyfin id to the "N" form the server stores guard keys in. */
function norm(id: string): string {
    return id.replace(/-/g, '').toLowerCase();
}

// Opening a SERIES detail page fires the Seerr issue-indicator feature
// (jellyseerr/api.ts fetchIssuesForMedia → GET /JellyfinCanopy/jellyseerr/issue).
// On the shared dev server (:8099) Seerr is configured but that endpoint returns
// 403 for the non-admin token, so JC logs a caught "Failed to fetch issues" error
// and the response is a 403 — both entirely unrelated to Spoiler Guard, and both
// absent on the :8100 seed (no Seerr → the indicator never runs). Scope exactly
// that pair out here (like settings-persist.spec's DASHBOARD_CHROME) so the check
// still catches any REAL Spoiler Guard console error or plugin 4xx.
const SEERR_ISSUE_NOISE_TEXT = /Seerr API: Failed to fetch issues/i;
const SEERR_ISSUE_NOISE_URL = /\/JellyfinCanopy\/jellyseerr\/issue/i;

function assertNoSpoilerRuntimeErrors(consoleErrors: {
    real(): string[];
    unexpected4xx(): { url: string; status: number }[];
}): void {
    const real = consoleErrors.real().filter((t) => !SEERR_ISSUE_NOISE_TEXT.test(t));
    expect(real, 'unexpected console errors (excluding the shared-server Seerr issue-indicator)').toEqual([]);
    const bad4xx = consoleErrors.unexpected4xx().filter((r) => !SEERR_ISSUE_NOISE_URL.test(r.url));
    expect(bad4xx, 'unexpected 4xx responses (excluding the Seerr issue-indicator)').toEqual([]);
}

/** Fetch the admin-exposed public config once (unauthenticated is fine). */
async function spoilerBlurEnabled(): Promise<boolean> {
    try {
        const res = await fetch(`${BASE}/JellyfinCanopy/public-config`);
        if (!res.ok) return false;
        const cfg = (await res.json()) as { SpoilerBlurEnabled?: boolean };
        return cfg.SpoilerBlurEnabled === true;
    } catch {
        return false;
    }
}

/** List a page's worth of episodes for a series as the given user. */
async function listEpisodes(user: Session, seriesId: string): Promise<EpisodeInfo[]> {
    const res = (await api(
        BASE,
        `/Shows/${seriesId}/Episodes?userId=${user.userId}&fields=Overview`,
        user.token
    )) as { Items?: any[] } | null;
    return (res?.Items ?? []).map((e) => ({
        id: e.Id as string,
        name: (e.Name ?? '') as string,
        overview: (e.Overview ?? '') as string,
        played: e.UserData?.Played === true,
        hasImage: !!e.ImageTags?.Primary,
    }));
}

/**
 * Pick a target series with at least one unwatched episode. Prefers the seed
 * series and, within a series, an unwatched episode that has a primary image so
 * the image-strip is exercised where the server provides one. Iterates a bounded
 * set of series sequentially (no heavy parallel fan-out) and stops at the first
 * usable one.
 */
async function pickTarget(user: Session): Promise<Target | null> {
    const list = (await api(
        BASE,
        `/Items?IncludeItemTypes=Series&Recursive=true&Limit=40&SortBy=SortName&userId=${user.userId}&fields=Name`,
        user.token
    )) as { Items?: any[] } | null;
    const series = list?.Items ?? [];
    // Try the seed series first, then the rest in the server's order.
    series.sort((a, b) => Number(b.Name === SEED_SERIES) - Number(a.Name === SEED_SERIES));

    for (const s of series) {
        const eps = await listEpisodes(user, s.Id as string);
        if (eps.length === 0) continue;
        const unwatched = eps.find((e) => !e.played && e.hasImage) ?? eps.find((e) => !e.played);
        if (!unwatched) continue;
        const watched = eps.find((e) => e.played) ?? null;
        return { seriesId: s.Id as string, seriesName: s.Name as string, unwatched, watched };
    }
    return null;
}

/** Set (POST) or clear (DELETE) the series guard for a user, server-side. */
async function setSeriesGuard(user: Session, seriesId: string, on: boolean): Promise<void> {
    await apiRaw(
        BASE,
        `/JellyfinCanopy/spoiler-blur/series/${norm(seriesId)}`,
        user.token,
        { method: on ? 'POST' : 'DELETE' }
    );
}

/** The set of guarded series ids (normalized) for a user. */
async function guardedSeriesIds(user: Session): Promise<Set<string>> {
    const state = (await api(BASE, '/JellyfinCanopy/spoiler-blur/series', user.token)) as
        | { Series?: Record<string, unknown> }
        | null;
    return new Set(Object.keys(state?.Series ?? {}).map((k) => norm(k)));
}

/** Read a single user's override prefs. */
async function getUserPrefs(user: Session): Promise<Record<string, unknown>> {
    return ((await api(BASE, '/JellyfinCanopy/spoiler-blur/user-prefs', user.token)) ?? {}) as Record<
        string,
        unknown
    >;
}

/** Open the item detail page for an id and wait for the Spoiler Guard button. */
async function openDetailWithButton(page: Page, seriesId: string): Promise<void> {
    // Let jellyfin-web's home tab controller finish initializing before we
    // navigate away — navigating mid-init races its own hometab.chunk.js and
    // emits a core "[Home] failed to get tab controller" error unrelated to the
    // plugin. Waiting for a rendered home card proves the controller settled.
    await page.waitForSelector('#indexPage .card', { timeout: 60_000 }).catch(() => {
        /* an empty home is fine; the settle wait is best-effort */
    });
    await page.evaluate((id) => {
        window.location.hash = `#/details?id=${id}`;
    }, seriesId);
    await page.waitForSelector('#itemDetailPage:not(.hide) .jc-spoiler-blur-btn', { timeout: 60_000 });
}

/** The visible detail page's Spoiler Guard toggle button. */
function guardButton(page: Page) {
    return page.locator('#itemDetailPage:not(.hide) .jc-spoiler-blur-btn').first();
}

/** Arm a one-shot observer that records when a JC toast is appended. */
async function armToastWatcher(page: Page): Promise<void> {
    await page.evaluate(() => {
        (window as any).__jeToastSeen = false;
        const obs = new MutationObserver((muts) => {
            for (const m of muts) {
                for (const n of Array.from(m.addedNodes)) {
                    if (n instanceof HTMLElement && n.classList.contains('jellyfin-canopy-toast')) {
                        (window as any).__jeToastSeen = true;
                    }
                }
            }
        });
        obs.observe(document.body, { childList: true });
        (window as any).__jeToastObs = obs;
    });
}

async function toastWasSeen(page: Page): Promise<void> {
    await page.waitForFunction(() => (window as any).__jeToastSeen === true, undefined, { timeout: 15_000 });
}

/** Assert no <img> that has a src on the visible detail page is broken. */
async function noBrokenDetailImages(page: Page): Promise<number> {
    return page.evaluate(() => {
        const imgs = Array.from(
            document.querySelectorAll<HTMLImageElement>('#itemDetailPage:not(.hide) img')
        ).filter((img) => !!img.currentSrc || !!img.getAttribute('src'));
        const broken = imgs.filter((img) => img.complete && img.naturalWidth === 0);
        if (broken.length > 0) throw new Error(`${broken.length} broken detail image(s)`);
        return imgs.length;
    });
}

let admin: Session;
let user: Session;
let enabled = false;
let target: Target | null = null;

test.beforeAll(async () => {
    enabled = await spoilerBlurEnabled();
    if (!enabled) return;
    admin = await authenticate(BASE, process.env.JF_ADMIN_USER || 'jc_arradmin', process.env.JF_ADMIN_PASS || 'Test669Pw!x');
    user = await authenticate(BASE, process.env.JF_USER_NAME || 'jc_arruser', process.env.JF_USER_PASS || 'Test669Pw!x');
    target = await pickTarget(user);
});

test.describe('Spoiler Guard', () => {
    test('non-admin enables Spoiler Guard: toggle flips, toast shows, metadata + images strip', async ({ page, consoleErrors }) => {
        test.skip(!enabled, 'SpoilerBlurEnabled is off on the target server');
        test.skip(!target, 'no series with an unwatched episode available on the target server');
        const t = target!;

        // Start from a known-OFF baseline before boot so the client caches "off".
        await setSeriesGuard(user, t.seriesId, false);
        try {
            await loginAs(page, 'user', consoleErrors);
            await openDetailWithButton(page, t.seriesId);

            const btn = guardButton(page);
            await expect(btn).toHaveAttribute('aria-pressed', 'false');
            await expect(btn).toHaveAttribute('aria-label', 'Spoiler Guard: Off');
            expect(await btn.locator('.material-icons').textContent()).toBe('blur_off');

            await armToastWatcher(page);
            await btn.click();

            // aria flips, icon flips, tooltip flips, and a toast was shown.
            await expect(btn).toHaveAttribute('aria-pressed', 'true');
            await expect(btn).toHaveAttribute('aria-label', 'Spoiler Guard: On');
            expect(await btn.locator('.material-icons').textContent()).toBe('blur_on');
            await toastWasSeen(page);

            // Server state now lists the series for this user …
            expect(await guardedSeriesIds(user), 'series is now guarded for the user').toContain(norm(t.seriesId));

            // … and the unwatched episode's metadata is stripped in the user's API view.
            const eps = await listEpisodes(user, t.seriesId);
            const ep = eps.find((e) => e.id === t.unwatched.id);
            expect(ep, 'the target unwatched episode is still present').toBeTruthy();
            expect(ep!.name, 'unwatched episode title is replaced').toMatch(STRIPPED_NAME);
            expect(ep!.overview, 'unwatched episode overview is the placeholder').toBe(OVERVIEW_PLACEHOLDER);

            // A watched episode (when the server has one) passes through unstripped.
            if (t.watched) {
                const watchedNow = eps.find((e) => e.id === t.watched!.id);
                expect(watchedNow?.name, 'watched episode keeps its real title').not.toMatch(STRIPPED_NAME);
            }

            // Card/detail images still resolve (bytes replaced, never broken).
            await noBrokenDetailImages(page);

            assertNoSpoilerRuntimeErrors(consoleErrors);
        } finally {
            await setSeriesGuard(user, t.seriesId, false);
        }
    });

    test('disabling shows the confirm dialog and restores the episode title', async ({ page, consoleErrors }) => {
        test.skip(!enabled, 'SpoilerBlurEnabled is off on the target server');
        test.skip(!target, 'no series with an unwatched episode available on the target server');
        const t = target!;

        // Enable server-side BEFORE boot so the button loads in the ON state.
        await setSeriesGuard(user, t.seriesId, true);
        try {
            await loginAs(page, 'user', consoleErrors);
            await openDetailWithButton(page, t.seriesId);

            const btn = guardButton(page);
            await expect(btn).toHaveAttribute('aria-pressed', 'true');

            // Clicking OFF raises the native confirm dialog (default prefs: confirm on).
            await btn.click();
            const dialog = page.locator('.jc-spoiler-confirm-overlay .jc-spoiler-confirm-dialog');
            await expect(dialog).toBeVisible({ timeout: 15_000 });
            await expect(dialog.locator('#jc-spoiler-confirm-title')).toHaveText('Disable Spoiler Guard?');

            // Confirm the disable.
            await dialog.locator('.jc-spoiler-confirm-ok').click();
            await expect(page.locator('.jc-spoiler-confirm-overlay')).toHaveCount(0, { timeout: 10_000 });
            await expect(btn).toHaveAttribute('aria-pressed', 'false');

            // Server state cleared, and the episode title/overview are restored to
            // the admin's real (unstripped) values.
            expect(await guardedSeriesIds(user), 'series is no longer guarded').not.toContain(norm(t.seriesId));
            const [userEps, adminEps] = [await listEpisodes(user, t.seriesId), await listEpisodes(admin, t.seriesId)];
            const userEp = userEps.find((e) => e.id === t.unwatched.id);
            const adminEp = adminEps.find((e) => e.id === t.unwatched.id);
            expect(userEp!.name, 'episode title restored (not the placeholder shape)').not.toMatch(STRIPPED_NAME);
            expect(userEp!.name, 'restored title matches the admin real title').toBe(adminEp!.name);

            assertNoSpoilerRuntimeErrors(consoleErrors);
        } finally {
            await setSeriesGuard(user, t.seriesId, false);
        }
    });

    test('per-user isolation: the admin API view keeps the real title while the user is guarded', async ({ page, consoleErrors }) => {
        test.skip(!enabled, 'SpoilerBlurEnabled is off on the target server');
        test.skip(!target, 'no series with an unwatched episode available on the target server');
        const t = target!;

        // Capture the admin's real (never-guarded) title up front.
        const adminReal = (await listEpisodes(admin, t.seriesId)).find((e) => e.id === t.unwatched.id);
        expect(adminReal, 'admin can see the target episode').toBeTruthy();

        // Guard the series for the NON-admin only.
        await setSeriesGuard(user, t.seriesId, true);
        try {
            // Boot a clean non-admin session purely to prove no console/net errors
            // while the user is guarded (the isolation itself is asserted via API).
            await loginAs(page, 'user', consoleErrors);

            // The user's API view is stripped …
            const userEp = (await listEpisodes(user, t.seriesId)).find((e) => e.id === t.unwatched.id);
            expect(userEp!.name, 'the guarded user sees a stripped title').toMatch(STRIPPED_NAME);

            // … while the admin's view of the SAME episode is untouched.
            const adminEp = (await listEpisodes(admin, t.seriesId)).find((e) => e.id === t.unwatched.id);
            expect(adminEp!.name, 'the admin still sees the real title').toBe(adminReal!.name);
            expect(adminEp!.name, 'the admin title is not the placeholder shape').not.toMatch(STRIPPED_NAME);
            expect(await guardedSeriesIds(admin), 'the admin has no guard state for this series').not.toContain(
                norm(t.seriesId)
            );

            assertNoRuntimeErrors(consoleErrors);
        } finally {
            await setSeriesGuard(user, t.seriesId, false);
        }
    });

    test('settings panel: the Spoiler Guard override section renders and one override persists', async ({ page, consoleErrors }) => {
        test.skip(!enabled, 'SpoilerBlurEnabled is off on the target server');

        // Snapshot the user's prefs so we can restore them exactly.
        const original = await getUserPrefs(user);
        try {
            await loginAs(page, 'user', consoleErrors);

            // Open the panel → settings tab → the Spoiler Guard override <details>.
            await page.evaluate(() => {
                (window as any).JellyfinCanopy.showEnhancedPanel();
            });
            const panel = page.locator('#jellyfin-canopy-panel');
            await expect(panel).toBeVisible({ timeout: 15_000 });
            await panel.locator('.tab-button[data-tab="settings"]').click();

            // The section's checkboxes carry ids prefixed "sbPref" and a data-pref.
            const overrideBox = panel.locator('#sbPrefHideOverview');
            await expect(overrideBox).toHaveCount(1);
            expect(
                await panel.locator('input[type="checkbox"][id^="sbPref"][data-pref]').count(),
                'the Spoiler Guard override section rendered its checkboxes'
            ).toBeGreaterThanOrEqual(2);

            // Open the collapsed <details> so the control is interactable/visible.
            await page.evaluate(() => {
                document.getElementById('sbPrefHideOverview')?.closest('details')?.setAttribute('open', 'open');
            });
            await expect(overrideBox).toBeVisible({ timeout: 10_000 });

            // Default = checked (inherit admin). Unchecking opts the user OUT
            // (HideEpisodeDescriptions=false) and must persist server-side.
            const wasChecked = await overrideBox.isChecked();
            const [prefsResponse] = await Promise.all([
                page.waitForResponse(
                    (r) =>
                        /\/JellyfinCanopy\/spoiler-blur\/user-prefs$/.test(r.url()) &&
                        r.request().method() === 'POST',
                    { timeout: 30_000 }
                ),
                overrideBox.click(),
            ]);
            expect(prefsResponse.ok(), 'the user-prefs POST succeeded').toBe(true);

            const persisted = await getUserPrefs(user);
            const expectedValue = wasChecked ? false : null;
            expect(
                persisted.HideEpisodeDescriptions,
                'the toggled override persisted via GET /spoiler-blur/user-prefs'
            ).toBe(expectedValue);

            assertNoRuntimeErrors(consoleErrors);
        } finally {
            // Restore the exact prior prefs (POST replaces the whole prefs object).
            await api(BASE, '/JellyfinCanopy/spoiler-blur/user-prefs', user.token, {
                method: 'POST',
                body: JSON.stringify(original),
            });
        }
    });
});
