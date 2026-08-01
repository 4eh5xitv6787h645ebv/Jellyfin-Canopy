// Boot invariants: the plugin initializes, the typed core namespaces are all
// present, and a full authenticated boot produces zero real console errors.
import { test, expect, loginAs, assertNoRuntimeErrors } from './fixtures/auth';

/* eslint-disable @typescript-eslint/no-explicit-any */

test.describe('boot', () => {
    test('initializes with all core namespaces and no real console errors', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);

        const state = await page.evaluate(() => {
            const JC = (window as any).JellyfinCanopy;
            return {
                initialized: JC.initialized === true,
                pluginVersion: typeof JC.pluginVersion === 'string' && JC.pluginVersion.length > 0,
                pluginConfig: !!JC.pluginConfig && typeof JC.pluginConfig === 'object',
                core: {
                    navigation: !!JC.core?.navigation,
                    lifecycle: !!JC.core?.lifecycle,
                    dom: !!JC.core?.dom,
                    ui: !!JC.core?.ui,
                    api: !!JC.core?.api,
                    live: !!JC.core?.live,
                },
                // Frozen public facade members user scripts rely on.
                facade: {
                    t: typeof JC.t === 'function',
                    toast: typeof JC.toast === 'function',
                    escapeHtml: typeof JC.escapeHtml === 'function',
                },
            };
        });

        expect(state.initialized).toBe(true);
        expect(state.pluginVersion).toBe(true);
        expect(state.pluginConfig).toBe(true);
        expect(state.core).toEqual({
            navigation: true,
            lifecycle: true,
            dom: true,
            ui: true,
            api: true,
            live: true,
        });
        expect(state.facade).toEqual({ t: true, toast: true, escapeHtml: true });

        // Cover late boot work (home sections, tag pipeline) with a CONCRETE
        // signal, not a blind sleep: when any tag family is enabled wait for the
        // pipeline to have processed a card; otherwise settle on network idle.
        // Then the shared console/4xx/5xx assertion covers it.
        await page.waitForSelector('#indexPage .card', { timeout: 60_000 });
        const anyTagsEnabled = await page.evaluate(() => {
            const settings = (window as any).JellyfinCanopy?.currentSettings || {};
            return ['qualityTagsEnabled', 'genreTagsEnabled', 'languageTagsEnabled', 'ratingTagsEnabled']
                .some((key) => settings[key] === true);
        });
        if (anyTagsEnabled) {
            await page.waitForFunction(
                () => document.querySelectorAll(
                    '[data-jc-quality-tagged],[data-jc-genre-tagged],[data-jc-language-tagged],[data-jc-rating-tagged]'
                ).length > 0,
                undefined,
                { timeout: 60_000 }
            );
        } else {
            await page.waitForLoadState('networkidle');
        }
        assertNoRuntimeErrors(consoleErrors);
    });

    test('shared notifications are accessible, stacked, exact-once, and route-owned', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);

        const initial = await page.evaluate(() => {
            const ui = (window as any).JellyfinCanopy.core.ui;
            const ownerBefore = document.getElementById('jc-notification-owner');
            (window as any).__jcNotificationActions = [];
            (window as any).__jcNotificationAnnouncements = [];
            const announcementObserver = new MutationObserver((mutations) => {
                for (const mutation of mutations) {
                    const target = mutation.target instanceof Element
                        ? mutation.target
                        : mutation.target.parentElement;
                    const lane = target?.closest<HTMLElement>('[data-jc-announcer]');
                    if (lane?.textContent) {
                        (window as any).__jcNotificationAnnouncements.push(lane.textContent);
                    }
                }
            });
            if (ownerBefore) {
                announcementObserver.observe(ownerBefore, { subtree: true, childList: true, characterData: true });
            }
            const first = ui.notifyAction({
                message: 'First item hidden',
                actionAvailableAnnouncement: 'First item hidden. Undo first is available.',
                severity: 'success',
                duration: 8_000,
                actionLabel: 'Undo first',
                onAction: () => (window as any).__jcNotificationActions.push('first'),
            });
            ui.notifyAction({
                message: 'Second item hidden',
                actionAvailableAnnouncement: 'Second item hidden. Undo second is available.',
                severity: 'success',
                duration: 8_000,
                actionLabel: 'Undo second',
                onAction: () => (window as any).__jcNotificationActions.push('second'),
            });
            (window as any).__jcRetainedNotificationButton = first.element.querySelector('button');
            const owner = document.getElementById('jc-notification-owner');
            const buttons = Array.from(owner?.querySelectorAll<HTMLButtonElement>('.jc-notification-action') || []);
            return {
                ownerPreinstalled: !!ownerBefore,
                owners: document.querySelectorAll('#jc-notification-owner').length,
                cards: owner?.querySelectorAll('.jc-notification').length,
                politeRegions: owner?.querySelectorAll('[aria-live="polite"]').length,
                assertiveRegions: owner?.querySelectorAll('[aria-live="assertive"]').length,
                visualLiveValues: Array.from(owner?.querySelectorAll('.jc-notification') || [])
                    .map((node) => node.getAttribute('aria-live')),
                buttonTypes: buttons.map((button) => button.type),
            };
        });

        expect(initial).toEqual({
            ownerPreinstalled: true,
            owners: 1,
            cards: 2,
            politeRegions: 1,
            assertiveRegions: 1,
            visualLiveValues: ['off', 'off'],
            buttonTypes: ['button', 'button'],
        });
        await expect.poll(() => page.evaluate(() => (window as any).__jcNotificationAnnouncements))
            .toEqual([
                'First item hidden. Undo first is available.',
                'Second item hidden. Undo second is available.',
            ]);
        await page.evaluate(() => {
            const buttons = document.querySelectorAll<HTMLButtonElement>('.jc-notification-action');
            buttons[1]?.click();
            buttons[1]?.click();
        });
        await expect.poll(() => page.evaluate(() => (window as any).__jcNotificationActions))
            .toEqual(['second']);

        await page.evaluate(() => (window as any).JellyfinCanopy.core.ui.notify({
            message: 'Urgent save failure',
            severity: 'error',
            duration: 8_000,
            dedupeKey: 'e2e:urgent-save-failure',
        }));
        await expect.poll(() => page.locator('[data-jc-announcer="assertive"]').textContent())
            .toBe('Urgent save failure');

        await page.evaluate(() => history.pushState({}, '', '#/home?jc-notification-proof=1'));
        await expect(page.locator('.jc-notification')).toHaveCount(0);
        await page.evaluate(() => (window as any).__jcRetainedNotificationButton.click());
        expect(await page.evaluate(() => (window as any).__jcNotificationActions)).toEqual(['second']);
        await expect(page.locator('#jc-notification-owner')).toHaveCount(1);
        assertNoRuntimeErrors(consoleErrors);
    });
});
