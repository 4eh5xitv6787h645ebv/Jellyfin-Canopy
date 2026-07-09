// Auto-Skip v2 — end-to-end proof against a live Jellyfin 12.
//
// Single perspective (admin): auto-skip is a per-user playback behavior with no
// role gating — an admin and a non-admin drive identical engine code — so one
// perspective is sufficient.
//
// The dev server ships no media-segment provider, so GET /MediaSegments/{id}
// returns empty (verified: an orphan DB row is dropped by the provider filter).
// We therefore inject a KNOWN intro segment through the plugin's REAL fetch path
// via route interception; everything downstream (the shipped engine's
// timeupdate-driven skip, exact-EndTicks seek, once/seek-back guards, localized
// toast) runs for real against real muted playback of a real long item.
import { test, expect, loginAs, showRoute, waitForHash } from './fixtures/auth';

const ITEM = process.env.JF_AUTOSKIP_ITEM || '14ba72cbe419e23f29d748060beef153';
const TPS = 10_000_000;
const START_SEC = 2;
const END_SEC = 25;

test.describe('Auto-Skip v2 (native media segments)', () => {
    test('skips an intro to the exact segment end, once, and never re-skips on seek-back', async ({
        page,
        consoleErrors,
    }) => {
        await page.route('**/MediaSegments/**', (route) =>
            route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    Items: [
                        {
                            Id: 'e2e-intro',
                            ItemId: ITEM,
                            Type: 'Intro',
                            StartTicks: START_SEC * TPS,
                            EndTicks: END_SEC * TPS,
                        },
                    ],
                    TotalRecordCount: 1,
                    StartIndex: 0,
                }),
            })
        );

        await loginAs(page, 'admin', consoleErrors);

        // Enable the intro quick-toggle the engine gates on, and record the
        // transient auto-skip toasts (they auto-dismiss ~1.5s).
        await page.evaluate(() => {
            /* eslint-disable @typescript-eslint/no-explicit-any */
            (window as any).JellyfinElevate.currentSettings.autoSkipIntro = true;
            (window as any).__jeToasts = [];
            const observer = new MutationObserver((mutations) => {
                for (const mutation of mutations) {
                    for (const node of mutation.addedNodes) {
                        if (node instanceof HTMLElement && node.classList.contains('jellyfin-elevate-toast')) {
                            (window as any).__jeToasts.push(node.textContent || '');
                        }
                    }
                }
            });
            observer.observe(document.body, { childList: true });
            /* eslint-enable @typescript-eslint/no-explicit-any */
        });

        // Open the item and start playback.
        await showRoute(page, `/details?id=${ITEM}`);
        await waitForHash(page, 'details');
        await page.waitForTimeout(2000);
        const clicked = await page.evaluate(() => {
            const el = document.querySelector<HTMLElement>('.page:not(.hide) .btnPlay');
            if (el) {
                el.click();
                return true;
            }
            return false;
        });
        expect(clicked, 'found and clicked the play button').toBe(true);

        // Wait for the player element, mute it, keep it playing.
        await page.waitForFunction(
            () => {
                const v = document.querySelector('video');
                return !!(v && v.currentSrc);
            },
            undefined,
            { timeout: 30_000 }
        );
        await page.evaluate(() => {
            const v = document.querySelector('video');
            if (v) {
                v.muted = true;
                void v.play?.().catch(() => undefined);
            }
        });

        // The engine seeks to the EXACT EndTicks once playback crosses the start.
        await page.waitForFunction(
            (end) => {
                const v = document.querySelector('video');
                return !!v && v.currentTime >= end - 2;
            },
            END_SEC,
            { timeout: 30_000 }
        );
        const afterSkip = await page.evaluate(() => document.querySelector('video')!.currentTime);
        expect(afterSkip, 'jumped to the segment end').toBeGreaterThanOrEqual(END_SEC - 2);
        expect(afterSkip, 'did not overshoot far past the end').toBeLessThan(END_SEC + 6);

        // Seek BACK into the segment — must NOT insta-re-skip.
        await page.evaluate(() => {
            const v = document.querySelector('video')!;
            v.pause();
            v.currentTime = 6;
        });
        await page.waitForTimeout(1500);
        const afterSeekBack = await page.evaluate(() => document.querySelector('video')!.currentTime);
        expect(afterSeekBack, 'stayed inside the segment, not re-skipped').toBeLessThan(END_SEC - 3);

        // The localized auto-skip toast was shown exactly once.
        const toasts = await page.evaluate(() => (window as { __jeToasts?: string[] }).__jeToasts ?? []);
        expect(toasts.filter((t) => /Auto-?Skipped Intro/i.test(t)).length, 'one intro toast').toBe(1);

        // Zero real console errors. For 4xx we scope to plugin endpoints: this is
        // the only spec that drives real media playback, whose core-server calls
        // (session/progress reporting, trickplay, subtitle probes) legitimately
        // 4xx in the headless test env and are outside the plugin's surface.
        expect(consoleErrors.real(), 'unexpected console errors').toEqual([]);
        const pluginFourxx = consoleErrors
            .unexpected4xx()
            .filter((r) => /\/JellyfinElevate\//i.test(r.url));
        expect(pluginFourxx, 'no 4xx from plugin endpoints').toEqual([]);
    });
});
