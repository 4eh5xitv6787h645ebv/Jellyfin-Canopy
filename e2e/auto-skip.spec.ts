// Auto-Skip v2 — end-to-end proof against a live Jellyfin 12.
//
// Single perspective (admin): auto-skip is a per-user playback behavior with no
// role gating — an admin and a non-admin drive identical engine code — so one
// perspective is sufficient.
//
// The clean seed has no media-segment provider, so GET /MediaSegments/{id}
// returns empty. We inject one known intro through the plugin's real fetch path;
// everything downstream (the shipped engine, real H.264/AAC playback, exact-end
// seek, native-parity seek-back guard, and localized toast) runs for real.
import { test, expect, loginAs, showRoute } from './fixtures/auth';
import { api, authenticate, type Session } from './fixtures/api';
import {
    AUTO_SKIP_FIXTURE,
    PLAYWRIGHT_DEVICE_PROFILE,
    TICKS_PER_SECOND,
    resolveAutoSkipFixture,
    type FixtureApiClient,
    type JellyfinItem,
    type PlaybackInfo,
} from '../scripts/e2e/auto-skip-fixture';

const OVERRIDE_ITEM_ID = process.env.JF_AUTOSKIP_ITEM || '';
const START_SEC = AUTO_SKIP_FIXTURE.segmentStartSeconds;
const END_SEC = AUTO_SKIP_FIXTURE.segmentEndSeconds;
const HEBREW_AUTO_SKIP_TEXT = 'פתיח דולג אוטומטי';

interface ItemList {
    Items?: JellyfinItem[];
}

interface UserData {
    PlaybackPositionTicks?: number;
    PlayedPercentage?: number;
    Played?: boolean;
    [key: string]: unknown;
}

interface SeekRecord {
    from: number;
    to: number;
}

interface AutoSkipTrace {
    lastStableTime: number;
    seeks: SeekRecord[];
    timeUpdates: number[];
}

function queryString(options: Record<string, unknown>): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) {
        if (value !== undefined && value !== null) params.set(key, String(value));
    }
    return params.toString();
}

function fixtureApi(baseURL: string, session: Session): FixtureApiClient {
    return {
        getCurrentUserId: () => session.userId,
        getItems: async (userId, options) =>
            (await api<ItemList>(
                baseURL,
                `/Items?${queryString({ ...options, UserId: userId })}`,
                session.token
            )) ?? { Items: [] },
        getItem: async (userId, itemId) => {
            const item = await api<JellyfinItem>(
                baseURL,
                `/Users/${encodeURIComponent(userId)}/Items/${encodeURIComponent(itemId)}?Fields=MediaSources,Path`,
                session.token
            );
            if (!item) throw new Error(`item ${itemId} returned an empty response`);
            return item;
        },
        getPlaybackInfo: async (itemId, options, deviceProfile) => {
            const info = await api<PlaybackInfo>(
                baseURL,
                `/Items/${encodeURIComponent(itemId)}/PlaybackInfo`,
                session.token,
                {
                    method: 'POST',
                    body: JSON.stringify({ ...options, DeviceProfile: deviceProfile }),
                }
            );
            if (!info) throw new Error(`PlaybackInfo for ${itemId} returned an empty response`);
            return info;
        },
    };
}

async function resetPlaybackState(
    baseURL: string,
    session: Session,
    itemId: string
): Promise<void> {
    const path = `/UserItems/${encodeURIComponent(itemId)}/UserData?userId=${encodeURIComponent(session.userId)}`;
    const existing = (await api<UserData>(baseURL, path, session.token)) ?? {};
    await api<UserData>(baseURL, path, session.token, {
        method: 'POST',
        body: JSON.stringify({
            ...existing,
            PlaybackPositionTicks: 0,
            PlayedPercentage: 0,
            Played: false,
        }),
    });
    const verified = await api<UserData>(baseURL, path, session.token);
    const position = Number(verified?.PlaybackPositionTicks);
    const percentage = verified?.PlayedPercentage;
    if (!verified
        || !Number.isFinite(position)
        || position !== 0
        || (percentage !== null && percentage !== undefined && Number(percentage) !== 0)
        || verified.Played !== false) {
        throw new Error(
            `Auto-Skip fixture ${itemId} playback reset failed: `
            + `PlaybackPositionTicks=${String(verified?.PlaybackPositionTicks)}, `
            + `PlayedPercentage=${String(percentage)}, `
            + `Played=${String(verified?.Played)}`
        );
    }
}

async function readTrace(page: import('playwright/test').Page): Promise<AutoSkipTrace> {
    return page.evaluate(() => {
        const trace = (window as unknown as { __jcAutoSkipTrace?: AutoSkipTrace }).__jcAutoSkipTrace;
        return trace ?? { lastStableTime: -1, seeks: [], timeUpdates: [] };
    });
}

function exactEndSeeks(trace: AutoSkipTrace): SeekRecord[] {
    return trace.seeks.filter((seek) =>
        seek.from >= START_SEC
        && seek.from < END_SEC - 2
        && Math.abs(seek.to - END_SEC) <= 0.75
    );
}

test.describe('Auto-Skip v2 (native media segments)', () => {
    test('resolves the clean-seed item, seeks to exact end once, and ignores direct seek-back', async ({
        page,
        consoleErrors,
        baseURL,
    }, testInfo) => {
        if (!baseURL) throw new Error('Auto-Skip E2E requires a configured baseURL');

        // Resolve and preflight through the server API before the browser ever
        // navigates. This turns missing/stale/short fixtures into fast,
        // diagnostic failures instead of a 30-second currentSrc timeout.
        const session = await authenticate(
            baseURL,
            process.env.JF_ADMIN_USER || 'jc_arradmin',
            process.env.JF_ADMIN_PASS || 'Test669Pw!x'
        );
        const resolved = await resolveAutoSkipFixture(fixtureApi(baseURL, session), OVERRIDE_ITEM_ID);
        testInfo.annotations.push({
            type: 'fixture',
            description: `${resolved.name}: ${resolved.id}, ${resolved.durationSeconds.toFixed(1)}s, ${resolved.playbackMode}`,
        });

        // Every Playwright retry starts with zero resume state. The finally
        // block repeats the reset so later local runs are isolated as well.
        await resetPlaybackState(baseURL, session, resolved.id);

        const requestedSegmentIds: string[] = [];
        await page.route('**/MediaSegments/**', async (route) => {
            const requestUrl = new URL(route.request().url());
            const requestId = decodeURIComponent(requestUrl.pathname.split('/').pop() || '');
            requestedSegmentIds.push(requestId);
            if (requestId.replaceAll('-', '').toLowerCase() !== resolved.id.replaceAll('-', '').toLowerCase()) {
                await route.continue();
                return;
            }
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    Items: [
                        {
                            Id: 'e2e-intro',
                            ItemId: resolved.id,
                            Type: 'Intro',
                            StartTicks: START_SEC * TICKS_PER_SECOND,
                            EndTicks: END_SEC * TICKS_PER_SECOND,
                        },
                    ],
                    TotalRecordCount: 1,
                    StartIndex: 0,
                }),
            });
        });

        // Force Jellyfin's Modern layout before its first boot read. Explicit
        // docker runs also set JF_LAYOUT_ENFORCEMENT=ForceExperimental; this
        // client-side seed keeps the committed CI path identical.
        await page.addInitScript((userId) => {
            window.localStorage.setItem('layout', 'experimental');
            window.localStorage.setItem(`${userId}-language`, 'he');
        }, session.userId);

        try {
            await loginAs(page, 'admin', consoleErrors);

            // Prove the rendered dialect, not merely the localStorage spelling.
            await page.waitForFunction(
                () => {
                    const toolbar = document.querySelector<HTMLElement>('.MuiAppBar-root .MuiToolbar-root');
                    const legacy = document.querySelector<HTMLElement>('.headerRight');
                    return !!toolbar && toolbar.getClientRects().length > 0
                        && (!legacy || legacy.offsetParent === null);
                },
                undefined,
                { timeout: 30_000 }
            );

            // Enable the intro quick-toggle, record transient localized toasts,
            // and attach seek instrumentation before the video element exists.
            await page.evaluate(() => {
                /* eslint-disable @typescript-eslint/no-explicit-any */
                (window as any).JellyfinCanopy.currentSettings.autoSkipIntro = true;
                (window as any).__jeToasts = [];
                (window as any).__jcAutoSkipTrace = { lastStableTime: 0, seeks: [], timeUpdates: [] };

                const attachVideoTrace = (video: HTMLVideoElement) => {
                    if (video.dataset.jcE2eSeekTrace === 'true') return;
                    video.dataset.jcE2eSeekTrace = 'true';
                    const trace = (window as any).__jcAutoSkipTrace as AutoSkipTrace;
                    trace.lastStableTime = video.currentTime;
                    video.addEventListener('timeupdate', () => {
                        trace.timeUpdates.push(video.currentTime);
                        if (!video.seeking && Number.isFinite(video.currentTime)) {
                            trace.lastStableTime = video.currentTime;
                        }
                    });
                    video.addEventListener('seeking', () => {
                        trace.seeks.push({ from: trace.lastStableTime, to: video.currentTime });
                    });
                };

                document.querySelectorAll<HTMLVideoElement>('video').forEach(attachVideoTrace);
                const observer = new MutationObserver((mutations) => {
                    for (const mutation of mutations) {
                        for (const node of mutation.addedNodes) {
                            if (!(node instanceof HTMLElement)) continue;
                            if (node instanceof HTMLVideoElement) attachVideoTrace(node);
                            node.querySelectorAll<HTMLVideoElement>('video').forEach(attachVideoTrace);
                            if (node.classList.contains('jellyfin-canopy-toast')) {
                                (window as any).__jeToasts.push(node.textContent || '');
                            }
                        }
                    }
                });
                observer.observe(document.body, { childList: true, subtree: true });
                /* eslint-enable @typescript-eslint/no-explicit-any */
            });
            const expectedLocalizedToast = await page.evaluate(() => {
                const html = (window as any).JellyfinCanopy.t('toast_auto_skipped_intro') as string;
                const host = document.createElement('div');
                host.innerHTML = html;
                return (host.textContent || '').trim();
            });
            expect(expectedLocalizedToast, 'localized toast text is not empty or a raw key').not.toBe('');
            expect(expectedLocalizedToast, 'localized toast is not the untranslated key').not.toBe('toast_auto_skipped_intro');
            expect(
                expectedLocalizedToast,
                'the forced Hebrew locale resolves the committed Auto-Skip translation'
            ).toContain(HEBREW_AUTO_SKIP_TEXT);

            await showRoute(page, `/details?id=${resolved.id}`);
            await page.waitForFunction(
                (itemId) => {
                    const route = `${window.location.pathname}${window.location.search}${window.location.hash}`;
                    return /details/i.test(route) && route.toLowerCase().includes(itemId.toLowerCase());
                },
                resolved.id,
                { timeout: 30_000 }
            );

            const playButton = page.locator('.btnPlay:visible').first();
            await expect(playButton, `play button for ${resolved.name} (${resolved.id})`).toBeVisible();
            await playButton.click();

            await page.waitForFunction(
                () => {
                    const video = document.querySelector('video');
                    return !!video?.currentSrc && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
                },
                undefined,
                { timeout: 30_000 }
            );
            await page.evaluate(() => {
                const video = document.querySelector('video');
                if (!video) return;
                video.muted = true;
                video.currentTime = 0;
                void video.play().catch(() => undefined);
            });

            // A currentTime threshold alone is vacuous: natural playback could
            // reach 25s. Require an actual seek whose prior clock was inside the
            // intro and whose target is the exact EndTicks boundary.
            await expect
                .poll(async () => exactEndSeeks(await readTrace(page)).length, {
                    message: `actual ${START_SEC}s -> ${END_SEC}s Auto-Skip seek for ${resolved.id}`,
                    timeout: 30_000,
                })
                .toBe(1);
            const firstTrace = await readTrace(page);
            const [firstSkip] = exactEndSeeks(firstTrace);
            expect(firstSkip.to, 'seek target equals the segment EndTicks').toBeCloseTo(END_SEC, 1);

            expect(requestedSegmentIds.length, 'MediaSegments was requested').toBeGreaterThan(0);
            expect(
                requestedSegmentIds.every((id) =>
                    id.replaceAll('-', '').toLowerCase() === resolved.id.replaceAll('-', '').toLowerCase()
                ),
                'every intercepted MediaSegments request used the discovered current-seed ID'
            ).toBe(true);

            // Seek directly back INTO the segment. Native parity keeps this
            // backward entry inert; only replaying from before Start can skip
            // again. Keep playback paused so natural time cannot blur the proof.
            const skipCountBeforeRewind = exactEndSeeks(firstTrace).length;
            const timeUpdatesBeforeRewind = firstTrace.timeUpdates.length;
            await page.evaluate(async () => {
                const video = document.querySelector('video')!;
                video.pause();
                await new Promise<void>((resolve, reject) => {
                    const timeout = window.setTimeout(
                        () => reject(new Error('seek-back did not emit seeked within 5 seconds')),
                        5000
                    );
                    video.addEventListener('seeked', () => {
                        window.clearTimeout(timeout);
                        resolve();
                    }, { once: true });
                    video.currentTime = 6;
                });
                // Explicitly deliver the event that drives the engine. This
                // makes the no-re-skip assertion fail if its guard is broken,
                // even on a browser that omits timeupdate for a paused seek.
                video.dispatchEvent(new Event('timeupdate'));
            });
            await page.waitForTimeout(500);
            const afterRewind = await page.evaluate(() => document.querySelector('video')!.currentTime);
            expect(afterRewind, 'stayed inside the segment, not re-skipped').toBeLessThan(END_SEC - 3);
            const rewindTrace = await readTrace(page);
            expect(
                rewindTrace.timeUpdates.length,
                'the engine received a post-rewind timeupdate'
            ).toBeGreaterThan(timeUpdatesBeforeRewind);
            expect(
                exactEndSeeks(rewindTrace).length,
                'direct seek-back did not cause a second Auto-Skip seek'
            ).toBe(skipCountBeforeRewind);

            const toasts = await page.evaluate(
                () => (window as unknown as { __jeToasts?: string[] }).__jeToasts ?? []
            );
            expect(
                toasts.filter((text) => text.trim() === expectedLocalizedToast).length,
                `one localized intro toast (${expectedLocalizedToast})`
            ).toBe(1);
            expect(
                toasts.filter((text) => text.includes(HEBREW_AUTO_SKIP_TEXT)).length,
                'the observed toast contains the independent Hebrew locale phrase'
            ).toBe(1);

            // Real media playback may legitimately produce core-server probe
            // 4xx responses in headless Chromium; plugin endpoints may not.
            expect(consoleErrors.unexpected5xx(), 'unexpected 5xx responses').toEqual([]);
            expect(consoleErrors.real(), 'unexpected console errors').toEqual([]);
            const pluginFourxx = consoleErrors
                .unexpected4xx()
                .filter((response) => /\/JellyfinCanopy\//i.test(response.url));
            expect(pluginFourxx, 'no 4xx from plugin endpoints').toEqual([]);
        } finally {
            await page.evaluate(() => {
                const video = document.querySelector('video');
                if (!video) return;
                video.pause();
                video.currentTime = 0;
            }).catch(() => undefined);
            await resetPlaybackState(baseURL, session, resolved.id);
        }
    });
});
