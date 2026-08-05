// Individual shortcut disablement is a persisted three-tier policy, not a
// presentation-only toggle. This spec drives the real user editor and server,
// reloads the account, and then proves a disabled bare digit cannot fall
// through to Jellyfin 12's own document-bubble percentage seek handler.
import {
    test,
    expect,
    loginAs,
    showRoute,
    waitForHash,
    assertNoRuntimeErrors,
} from './fixtures/auth';
import type { Page } from 'playwright/test';

/* eslint-disable @typescript-eslint/no-explicit-any */

const PERCENTAGE_ACTION = 'JumpToPercentage';
const SHORTCUT_SAVE = /\/JellyfinCanopy\/user-settings\/.+\/shortcuts\.json(?:\?|$)/i;

async function waitReady(page: Page): Promise<void> {
    await page.waitForFunction(
        () => (window as any).JellyfinCanopy?.initialized === true
            && !!(window as any).JellyfinCanopy?.userConfig?.shortcuts,
        undefined,
        { timeout: 60_000 }
    );
}

function shortcutsSaved(page: Page): Promise<import('playwright/test').Response> {
    return page.waitForResponse(
        response => SHORTCUT_SAVE.test(response.url())
            && response.request().method() === 'POST',
        { timeout: 30_000 }
    );
}

async function openShortcutPanel(page: Page): Promise<ReturnType<Page['locator']>> {
    await page.evaluate(() => { (window as any).JellyfinCanopy.showEnhancedPanel(); });
    const panel = page.locator('#jellyfin-canopy-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    const tab = panel.locator('.tab-button[data-tab="shortcuts"]');
    await expect(tab).toBeVisible();
    await tab.click();
    await expect(panel.locator('.jc-pane[data-pane="shortcuts"]')).toBeVisible();
    return panel;
}

async function setVideoPosition(page: Page, ratio: number): Promise<{ duration: number; baseline: number }> {
    return page.evaluate(async (targetRatio) => {
        const video = document.querySelector('video');
        if (!video || !Number.isFinite(video.duration) || video.duration <= 0) {
            throw new Error('the real Jellyfin video element is not seekable');
        }
        video.pause();
        const target = video.duration * targetRatio;
        if (Math.abs(video.currentTime - target) > 0.05) {
            await new Promise<void>((resolve, reject) => {
                const timeout = window.setTimeout(
                    () => reject(new Error('timed out positioning the Jellyfin video')),
                    10_000
                );
                video.addEventListener('seeked', () => {
                    window.clearTimeout(timeout);
                    resolve();
                }, { once: true });
                video.currentTime = target;
            });
        }
        return { duration: video.duration, baseline: video.currentTime };
    }, ratio);
}

test.describe('individual shortcut disablement', () => {
    test('a disabled percentage group survives reload and blocks Jellyfin 12 native digit seeking', async ({
        page,
        consoleErrors,
    }) => {
        test.slow();
        await loginAs(page, 'user', consoleErrors);
        const originalRows = await page.evaluate(() => JSON.parse(JSON.stringify(
            (window as any).JellyfinCanopy.userConfig.shortcuts.Shortcuts || []
        )));

        try {
            let panel = await openShortcutPanel(page);
            let stateButton = panel.locator(
                `.shortcut-state-button[data-action="${PERCENTAGE_ACTION}"]`
            );
            await expect(stateButton).toBeVisible();

            // A dirty shared test server may already hold a disabled row. Make
            // the enabled precondition explicit through the real control, then
            // exercise Disable from that known state.
            if (await stateButton.getAttribute('data-operation') === 'enable') {
                const [response] = await Promise.all([
                    shortcutsSaved(page),
                    stateButton.click(),
                ]);
                expect(response.ok(), 'precondition enable is acknowledged').toBe(true);
                await page.waitForFunction(
                    (action) => (window as any).JellyfinCanopy.state.activeShortcuts[action] === '0-9',
                    PERCENTAGE_ACTION
                );
            }

            const [disabledResponse] = await Promise.all([
                shortcutsSaved(page),
                stateButton.click(),
            ]);
            expect(disabledResponse.ok(), 'Disable is acknowledged by the real user endpoint').toBe(true);
            await page.waitForFunction(
                (action) => (window as any).JellyfinCanopy.state.activeShortcuts[action] === '',
                PERCENTAGE_ACTION
            );

            await page.reload({ waitUntil: 'domcontentloaded' });
            await waitReady(page);
            const persisted = await page.evaluate((action) => {
                const JC = (window as any).JellyfinCanopy;
                const rows = (JC.userConfig.shortcuts.Shortcuts || [])
                    .filter((row: any) => row?.Name === action);
                return {
                    active: JC.state.activeShortcuts[action],
                    keys: rows.map((row: any) => row.Key),
                };
            }, PERCENTAGE_ACTION);
            expect(persisted, 'reload retains one intentional empty override').toEqual({
                active: '',
                keys: [''],
            });

            panel = await openShortcutPanel(page);
            const preview = panel.locator(
                `.shortcut-key[data-action="${PERCENTAGE_ACTION}"]`
            );
            stateButton = panel.locator(
                `.shortcut-state-button[data-action="${PERCENTAGE_ACTION}"]`
            );
            const disabledLabel = await page.evaluate(() =>
                (window as any).JellyfinCanopy.t('status_disabled')
            );
            await expect(preview).toHaveClass(/shortcut-disabled/);
            await expect(preview).toHaveText(disabledLabel);
            await expect(preview).toHaveAttribute('tabindex', '-1');
            await expect(stateButton).toHaveAttribute('data-operation', 'enable');
            await page.keyboard.press('Escape');
            await expect(panel).toHaveCount(0);

            const itemId = await page.evaluate(async () => {
                const apiClient = (window as any).ApiClient;
                const url = apiClient.getUrl(
                    `/Items?Recursive=true&SearchTerm=${encodeURIComponent('Alpha Adventure')}`
                    + `&IncludeItemTypes=Movie&Limit=1&userId=${apiClient.getCurrentUserId()}`
                );
                const result = await apiClient.ajax({ type: 'GET', url, dataType: 'json' });
                return String(result.Items?.[0]?.Id || '');
            });
            expect(itemId, 'the seeded movie used for the native-key proof exists').not.toBe('');

            await showRoute(page, `/details?id=${itemId}`);
            const playButton = page.locator('.page:not(.hide) .mainDetailButtons .btnPlay').first();
            await expect(playButton).toBeVisible({ timeout: 30_000 });
            await playButton.click();
            await waitForHash(page, '/video');
            await page.waitForFunction(
                () => {
                    const video = document.querySelector('video');
                    return !!video && Number.isFinite(video.duration) && video.duration > 3;
                },
                undefined,
                { timeout: 30_000 }
            );

            const positioned = await setVideoPosition(page, 0.2);
            expect(positioned.duration).toBeGreaterThan(3);
            await page.evaluate(() => {
                const video = document.querySelector('video')!;
                const trace = {
                    baseline: video.currentTime,
                    positions: [] as number[],
                    done: false,
                };
                (window as any).__jcDisabledDigitTrace = trace;
                const onSeeking = (): void => { trace.positions.push(video.currentTime); };
                video.addEventListener('seeking', onSeeking);
                window.setTimeout(() => {
                    video.removeEventListener('seeking', onSeeking);
                    trace.done = true;
                }, 750);
                (document.activeElement as HTMLElement | null)?.blur?.();
            });

            await page.keyboard.press('8');
            await page.waitForFunction(
                () => (window as any).__jcDisabledDigitTrace?.done === true,
                undefined,
                { timeout: 5_000 }
            );
            const digitTrace = await page.evaluate(() => {
                const video = document.querySelector('video')!;
                return {
                    ...(window as any).__jcDisabledDigitTrace,
                    final: video.currentTime,
                    paused: video.paused,
                };
            });
            expect(digitTrace.positions, 'neither Canopy nor Jellyfin 12 seeks for disabled digits').toEqual([]);
            expect(digitTrace.paused, 'the deterministic native-key probe remains paused').toBe(true);
            expect(
                Math.abs(digitTrace.final - digitTrace.baseline),
                'the native Jellyfin document-bubble digit handler was intercepted'
            ).toBeLessThan(0.1);
        } finally {
            await page.evaluate(async (rows) => {
                const video = document.querySelector('video');
                if (video) {
                    video.pause();
                    video.removeAttribute('src');
                    video.load();
                }
                const JC = (window as any).JellyfinCanopy;
                const shortcuts = JC.userConfig?.shortcuts;
                if (!shortcuts) throw new Error('shortcut cleanup lost its owned payload');
                shortcuts.Shortcuts = JSON.parse(JSON.stringify(rows));
                await JC.saveUserSettings('shortcuts.json', shortcuts);
            }, originalRows);
        }

        assertNoRuntimeErrors(consoleErrors);
    });
});
