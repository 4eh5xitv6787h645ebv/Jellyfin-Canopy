// Real-browser acceptance for mobile double-tap seek. The ordinary taps use
// Playwright's browser input pipeline (including compatibility mouse events),
// while the sequential two-finger probe exercises the installed document
// listeners with each engine's native Touch/TouchEvent implementation.
import { test, expect, loginAs, showRoute, waitForHash, assertNoRuntimeErrors } from './fixtures/auth';
import { api, authenticate, type Session } from './fixtures/api';
import {
    preservePrimaryError,
    resetAutoSkipPlaybackState,
    type PlaybackStateApiClient,
} from '../scripts/e2e/auto-skip-fixture';
import type { Page } from 'playwright/test';

/* eslint-disable @typescript-eslint/no-explicit-any */

test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
});

interface VideoPoint {
    x: number;
    y: number;
}

interface UserData {
    PlaybackPositionTicks?: number;
    PlayedPercentage?: number;
    Played?: boolean;
}

function playbackStateApi(baseURL: string, session: Session): PlaybackStateApiClient {
    return {
        markUnplayed: (itemId) => api<UserData>(
            baseURL,
            `/UserPlayedItems/${encodeURIComponent(itemId)}?userId=${encodeURIComponent(session.userId)}`,
            session.token,
            { method: 'DELETE' }
        ),
        getUserData: (itemId) => api<UserData>(
            baseURL,
            `/UserItems/${encodeURIComponent(itemId)}/UserData?userId=${encodeURIComponent(session.userId)}`,
            session.token
        ),
    };
}

async function openSeededVideo(page: Page): Promise<{ itemId: string; point: VideoPoint }> {
    const itemId = await page.evaluate(async () => {
        const apiClient = (window as any).ApiClient;
        const url = apiClient.getUrl(
            `/Items?Recursive=true&SearchTerm=${encodeURIComponent('JC Auto-Skip E2E Fixture')}`
            + `&IncludeItemTypes=Movie&Limit=1&userId=${apiClient.getCurrentUserId()}`
        );
        const result = await apiClient.ajax({ type: 'GET', url, dataType: 'json' });
        return String(result.Items?.[0]?.Id || '');
    });
    expect(itemId, 'the seeded mobile gesture movie exists').not.toBe('');

    await showRoute(page, `/details?id=${itemId}`);
    const playButton = page.locator('.page:not(.hide) .mainDetailButtons .btnPlay').first();
    await expect(playButton).toBeVisible({ timeout: 30_000 });
    await playButton.click();
    await waitForHash(page, '/video');
    await page.waitForFunction(
        () => {
            const video = document.querySelector('video');
            return !!video && Number.isFinite(video.duration) && video.duration > 30;
        },
        undefined,
        { timeout: 30_000 }
    );

    const point = await page.evaluate(async () => {
        const video = document.querySelector('video')!;
        const JC = (window as any).JellyfinCanopy;
        JC.currentSettings.doubleTapSeekEnabled = true;
        JC.currentSettings.longPress2xEnabled = false;
        JC.currentSettings.autoSkipIntro = false;
        JC.currentSettings.autoSkipOutro = false;
        video.playbackRate = 1;
        video.currentTime = Math.min(video.duration - 15, Math.max(15, video.duration / 2));
        await video.play();

        const trace = { clicks: [] as Array<{ x: number; y: number }>, seeks: 0 };
        (window as any).__jcMobileTapTrace = trace;
        document.addEventListener('click', (event) => {
            trace.clicks.push({ x: event.clientX, y: event.clientY });
        });
        video.addEventListener('seeking', () => { trace.seeks += 1; });

        const bounds = video.getBoundingClientRect();
        return {
            x: Math.round(bounds.left + bounds.width * 0.25),
            y: Math.round(bounds.top + bounds.height * 0.25),
        };
    });
    return { itemId, point };
}

async function videoState(page: Page): Promise<{
    time: number;
    rate: number;
    clicks: number;
    seeks: number;
}> {
    return page.evaluate(() => {
        const video = document.querySelector('video')!;
        const trace = (window as any).__jcMobileTapTrace;
        return {
            time: video.currentTime,
            rate: video.playbackRate,
            clicks: trace.clicks.length,
            seeks: trace.seeks,
        };
    });
}

async function dispatchTouchList(
    page: Page,
    type: 'touchstart' | 'touchend',
    point: VideoPoint,
    activeIds: number[],
    changedIds: number[]
): Promise<void> {
    await page.evaluate(({ eventType, at, active, changed }) => {
        const target = document.elementFromPoint(at.x, at.y);
        if (!target) throw new Error('mobile gesture target disappeared');
        const makeTouch = (identifier: number): Touch => new Touch({
            identifier,
            target,
            clientX: at.x + identifier,
            clientY: at.y,
            pageX: at.x + identifier,
            pageY: at.y,
            screenX: at.x + identifier,
            screenY: at.y,
            radiusX: 1,
            radiusY: 1,
            rotationAngle: 0,
            force: 1,
        });
        target.dispatchEvent(new TouchEvent(eventType, {
            bubbles: true,
            cancelable: true,
            composed: true,
            touches: active.map(makeTouch),
            targetTouches: active.map(makeTouch),
            changedTouches: changed.map(makeTouch),
        }));
    }, { eventType: type, at: point, active: activeIds, changed: changedIds });
}

test.describe('mobile double-tap seek', () => {
    test('real touch input preserves host taps, blocks chrome, and cancels a sequential second finger', async ({
        page,
        browserName,
        consoleErrors,
        baseURL,
    }) => {
        test.slow();
        expect(['chromium', 'webkit'], 'the acceptance proxy is a current Chromium or Safari engine')
            .toContain(browserName);
        if (!baseURL) throw new Error('mobile double-tap E2E requires a configured baseURL');
        const session = await authenticate(
            baseURL,
            process.env.JF_USER_NAME || 'jc_arruser',
            process.env.JF_USER_PASS || 'Test669Pw!x'
        );
        const resetApi = playbackStateApi(baseURL, session);
        let itemId = '';
        let testBodyError: unknown;

        try {
            await loginAs(page, 'user', consoleErrors);
            const fixture = await openSeededVideo(page);
            itemId = fixture.itemId;
            const { point } = fixture;

            const before = await videoState(page);
            await page.touchscreen.tap(point.x, point.y);
            await page.waitForTimeout(100);
            const afterFirst = await videoState(page);
            expect(afterFirst.clicks - before.clicks, 'the first tap reaches Jellyfin host click handling').toBe(1);
            expect(afterFirst.seeks - before.seeks, 'the first tap does not seek').toBe(0);

            await page.touchscreen.tap(point.x + 2, point.y);
            await page.waitForTimeout(50);
            const afterDouble = await videoState(page);
            expect(afterDouble.time - afterFirst.time, 'the recognized left double tap seeks back ten seconds')
                .toBeLessThan(-8);
            expect(afterDouble.clicks, 'the successful second tap owns its compatibility click')
                .toBe(afterFirst.clicks);

            await page.touchscreen.tap(point.x + 2, point.y);
            await page.waitForTimeout(50);
            const afterThird = await videoState(page);
            expect(afterThird.clicks - afterDouble.clicks, 'the immediately following single tap reaches Jellyfin')
                .toBe(1);
            expect(afterThird.seeks, 'the following single tap does not inherit a stale pair')
                .toBe(afterDouble.seeks);

            const blockedClasses = [
                'osdControls',
                'pause-screen-active',
                'jellyfin-canopy-panel',
                'dialogContainer',
                'actionSheetContent',
            ];
            for (const className of blockedClasses) {
                await page.evaluate(({ name, at }) => {
                    const blocker = document.createElement('div');
                    blocker.id = 'jc-mobile-gesture-blocker';
                    blocker.className = name;
                    blocker.style.cssText = `position:fixed;left:${at.x - 20}px;top:${at.y - 20}px;`
                        + 'width:40px;height:40px;z-index:2147483647;pointer-events:auto';
                    document.body.appendChild(blocker);
                    (window as any).__jcMobileTapTrace.seeks = 0;
                }, { name: className, at: point });
                await page.touchscreen.tap(point.x, point.y);
                await page.waitForTimeout(75);
                await page.touchscreen.tap(point.x, point.y);
                await page.waitForTimeout(25);
                expect((await videoState(page)).seeks, `${className} owns both touches`).toBe(0);
                await page.locator('#jc-mobile-gesture-blocker').evaluate(element => element.remove());
            }

            await page.evaluate(() => {
                const JC = (window as any).JellyfinCanopy;
                const video = document.querySelector('video')!;
                JC.currentSettings.longPress2xEnabled = true;
                video.playbackRate = 1;
                (window as any).__jcMobileTapTrace.seeks = 0;
            });
            await dispatchTouchList(page, 'touchstart', point, [1], [1]);
            await page.waitForTimeout(50);
            await dispatchTouchList(page, 'touchstart', point, [1, 2], [2]);
            await page.waitForTimeout(600);
            const duringMultitouch = await videoState(page);
            expect(duringMultitouch.rate, 'a sequential second finger cancels the 2x hold timer').toBe(1);
            expect(duringMultitouch.seeks, 'multi-touch cannot become a double tap').toBe(0);
            await dispatchTouchList(page, 'touchend', point, [2], [1]);
            await dispatchTouchList(page, 'touchend', point, [], [2]);

            assertNoRuntimeErrors(consoleErrors);
        } catch (error) {
            testBodyError = error;
        }

        const cleanupErrors: unknown[] = [];
        await page.evaluate(() => {
            const video = document.querySelector('video');
            if (video) {
                video.currentTime = 0;
                video.pause();
                video.dispatchEvent(new Event('timeupdate'));
            }
        }).catch(error => cleanupErrors.push(error));
        await page.goto('about:blank', { waitUntil: 'load' })
            .catch(error => cleanupErrors.push(error));
        if (itemId) {
            await resetAutoSkipPlaybackState(resetApi, itemId)
                .catch(error => cleanupErrors.push(error));
        }

        if (testBodyError) throw preservePrimaryError(testBodyError, cleanupErrors);
        if (cleanupErrors.length > 0) {
            throw preservePrimaryError(cleanupErrors[0], cleanupErrors.slice(1));
        }
    });
});
