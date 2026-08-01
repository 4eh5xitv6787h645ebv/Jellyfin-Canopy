import { expect } from '@playwright/test';
import { assertNoRuntimeErrors, loginAs, showRoute, test } from './fixtures/auth';

/* eslint-disable @typescript-eslint/no-explicit-any */

test.describe('Seerr modal history ownership', () => {
    test('synthetic success consumes its own entry before the next real Back', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);
        await showRoute(page, '/search?query=history-owner');
        await page.waitForFunction(
            () => typeof (window as any).JellyfinCanopy?.seerrModal?.create === 'function',
            undefined,
            { timeout: 30_000 }
        );

        await page.evaluate(() => {
            const documentPath = `${location.pathname}${location.search}`;
            // Build a deterministic real predecessor without notifying the SPA
            // router: this spec owns only browser-history behavior.
            History.prototype.replaceState.call(
                history,
                { jcHistoryProof: 'previous' },
                '',
                `${documentPath}#/search?jcHistoryProof=previous`
            );
            History.prototype.pushState.call(
                history,
                { jcHistoryProof: 'current' },
                '',
                `${documentPath}#/search?jcHistoryProof=current`
            );
        });

        // Repeating the production success path proves that the modal-owned
        // entry is consumed each time instead of accumulating invisible Back
        // stops across a request session.
        for (let iteration = 0; iteration < 3; iteration++) {
            await page.evaluate((sequence) => {
                const jc = (window as any).JellyfinCanopy;
                const handle = jc.seerrModal.create({
                    title: `Synthetic history proof ${sequence}`,
                    subtitle: 'No upstream request is sent',
                    bodyHtml: '<p>Close through the production success callback.</p>',
                    onSave: (_modal: HTMLElement, _button: HTMLButtonElement, close: () => void) => close(),
                });
                handle.show();
            }, iteration + 1);

            const modal = page.locator('.seerr-season-modal');
            await expect(modal).toBeVisible();
            await modal.locator('.seerr-modal-button-primary').click();

            await page.waitForFunction(() => {
                return location.hash === '#/search?jcHistoryProof=current'
                    && !document.querySelector('.seerr-season-modal')
                    && !document.body.classList.contains('jc-modal-open')
                    && !document.body.classList.contains('seerr-modal-is-open');
            }, undefined, { timeout: 30_000 });
        }

        await page.evaluate(() => history.back());
        await page.waitForFunction(
            () => location.hash === '#/search?jcHistoryProof=previous',
            undefined,
            { timeout: 30_000 }
        );
        expect(await page.evaluate(() => location.hash)).toBe('#/search?jcHistoryProof=previous');

        assertNoRuntimeErrors(consoleErrors);
    });

    test('one Escape closes only the topmost nested modal and keeps the shortcut gate', async ({
        page,
        consoleErrors,
    }) => {
        await loginAs(page, 'admin', consoleErrors);
        await showRoute(page, '/search?query=history-owner-nested-escape');
        await page.waitForFunction(
            () => typeof (window as any).JellyfinCanopy?.seerrModal?.create === 'function',
            undefined,
            { timeout: 30_000 }
        );

        await page.evaluate(() => {
            const proof: string[] = [];
            (window as any).__jcNestedModalCloseProof = proof;
            const jc = (window as any).JellyfinCanopy;
            const outer = jc.seerrModal.create({
                title: 'Outer Escape proof',
                subtitle: 'Must remain after the first Escape',
                bodyHtml: '<p>Outer modal</p>',
                onSave: () => undefined,
                onClose: () => proof.push('outer'),
            });
            outer.show();
            const inner = jc.seerrModal.create({
                title: 'Inner Escape proof',
                subtitle: 'Must close first',
                bodyHtml: '<p>Inner modal</p>',
                onSave: () => undefined,
                onClose: () => proof.push('inner'),
            });
            inner.show();
        });

        const modals = page.locator('.seerr-season-modal');
        await expect(modals).toHaveCount(2);
        await page.keyboard.press('Escape');
        await expect.poll(() => page.evaluate(
            () => [...((window as any).__jcNestedModalCloseProof as string[])]
        )).toEqual(['inner']);
        await expect(modals).toHaveCount(1);
        await expect(modals).toHaveAccessibleName('Outer Escape proof');
        expect(await page.evaluate(() => document.body.classList.contains('jc-modal-open'))).toBe(true);

        await page.keyboard.press('Escape');
        await expect.poll(() => page.evaluate(
            () => [...((window as any).__jcNestedModalCloseProof as string[])]
        )).toEqual(['inner', 'outer']);
        await expect(modals).toHaveCount(0);
        expect(await page.evaluate(() => document.body.classList.contains('jc-modal-open'))).toBe(false);

        assertNoRuntimeErrors(consoleErrors);
    });

    test('intervening SPA history preserves one-step Back and Forward around a retired modal', async ({
        page,
        consoleErrors,
    }) => {
        await loginAs(page, 'admin', consoleErrors);
        await showRoute(page, '/search?query=history-owner-navigation');
        await page.waitForFunction(
            () => typeof (window as any).JellyfinCanopy?.seerrModal?.create === 'function',
            undefined,
            { timeout: 30_000 }
        );

        await page.evaluate(() => {
            const documentPath = `${location.pathname}${location.search}`;
            History.prototype.replaceState.call(
                history,
                { jcHistoryProof: 'route-a' },
                '',
                `${documentPath}#/search?jcHistoryProof=route-a`
            );
            const jc = (window as any).JellyfinCanopy;
            const handle = jc.seerrModal.create({
                title: 'Buried modal history proof',
                subtitle: 'No upstream request is sent',
                bodyHtml: '<p>The next host route owns the current entry.</p>',
                onSave: () => undefined,
            });
            handle.show();
            History.prototype.pushState.call(
                history,
                { jcHistoryProof: 'route-b' },
                '',
                `${documentPath}#/search?jcHistoryProof=route-b`
            );
            handle.close();
        });

        await page.waitForFunction(() => {
            return location.hash === '#/search?jcHistoryProof=route-b'
                && !document.querySelector('.seerr-season-modal');
        }, undefined, { timeout: 30_000 });

        // A single real Back skips the buried modal marker and lands on A.
        await page.evaluate(() => history.back());
        await page.waitForFunction(
            () => location.hash === '#/search?jcHistoryProof=route-a',
            undefined,
            { timeout: 30_000 }
        );
        expect(await page.evaluate(() => location.hash)).toBe('#/search?jcHistoryProof=route-a');

        // Forward must cross the same retired marker in the other direction;
        // it may never bounce back and strand the newer host route.
        await page.evaluate(() => history.forward());
        await page.waitForFunction(
            () => location.hash === '#/search?jcHistoryProof=route-b',
            undefined,
            { timeout: 30_000 }
        );
        expect(await page.evaluate(() => location.hash)).toBe('#/search?jcHistoryProof=route-b');

        assertNoRuntimeErrors(consoleErrors);
    });

    test('full reload on a private marker retires it before the next real Back', async ({
        page,
        consoleErrors,
    }) => {
        await loginAs(page, 'admin', consoleErrors);
        await showRoute(page, '/search?query=history-owner-reload');
        await page.waitForFunction(
            () => typeof (window as any).JellyfinCanopy?.seerrModal?.create === 'function',
            undefined,
            { timeout: 30_000 }
        );

        await page.evaluate(() => {
            const documentPath = `${location.pathname}${location.search}`;
            History.prototype.replaceState.call(
                history,
                { jcHistoryProof: 'reload-previous' },
                '',
                `${documentPath}#/search?jcHistoryProof=reload-previous`
            );
            History.prototype.pushState.call(
                history,
                { jcHistoryProof: 'reload-current' },
                '',
                `${documentPath}#/search?jcHistoryProof=reload-current`
            );
            const jc = (window as any).JellyfinCanopy;
            const handle = jc.seerrModal.create({
                title: 'Reload adoption proof',
                subtitle: 'This DOM intentionally disappears during reload',
                bodyHtml: '<p>The private marker must not become a real route.</p>',
                onSave: () => undefined,
            });
            handle.show();
        });

        await expect(page.locator('.seerr-season-modal')).toBeVisible();
        expect(await page.evaluate(() => {
            return Boolean((history.state as Record<string, unknown> | null)?.__jellyfinCanopySeerrModal);
        })).toBe(true);

        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => {
            const state = history.state as Record<string, unknown> | null;
            return typeof (window as any).JellyfinCanopy?.seerrModal?.create === 'function'
                && state?.jcHistoryProof === 'reload-current'
                && !state?.__jellyfinCanopySeerrModal
                && !document.querySelector('.seerr-season-modal');
        }, undefined, { timeout: 30_000 });

        await page.evaluate(() => history.back());
        await page.waitForFunction(
            () => (history.state as { jcHistoryProof?: string } | null)?.jcHistoryProof === 'reload-previous',
            undefined,
            { timeout: 30_000 }
        );
        expect(await page.evaluate(() => location.hash)).toBe('#/search?jcHistoryProof=reload-previous');

        assertNoRuntimeErrors(consoleErrors);
    });

    test('direct-boot modal success survives its same-URL sentinel pop and clears on real navigation', async ({
        page,
        consoleErrors,
    }) => {
        await loginAs(page, 'admin', consoleErrors);
        await page.evaluate(() => {
            const documentPath = `${location.pathname}${location.search}`;
            History.prototype.replaceState.call(
                history,
                { jcHistoryProof: 'direct-boot-base' },
                '',
                `${documentPath}#/search?query=history-owner-direct-boot`
            );
        });

        // Reboot the plugin on the target route. This is the direct/deep-link
        // shape where navigation's initial dedup key used to be unseeded. The
        // native replace above deliberately avoided every SPA navigation hook.
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => {
            const jc = (window as any).JellyfinCanopy;
            return jc?.initialized === true
                && typeof jc?.seerrModal?.create === 'function'
                && typeof jc?.toast === 'function'
                && location.hash.includes('history-owner-direct-boot');
        }, undefined, { timeout: 30_000 });

        await page.evaluate(() => {
            const jc = (window as any).JellyfinCanopy;
            (window as any).__jcDirectBootUrl = location.href;
            (window as any).__jcDirectBootNavigations = 0;
            (window as any).__jcDirectBootOffNavigate = jc.core.navigation.onNavigate(() => {
                (window as any).__jcDirectBootNavigations += 1;
            });
            const handle = jc.seerrModal.create({
                title: 'Direct-boot notification proof',
                subtitle: 'No upstream request is sent',
                bodyHtml: '<p>Save, announce success, then consume the modal sentinel.</p>',
                onSave: (_modal: HTMLElement, _button: HTMLButtonElement, close: () => void) => {
                    // Match the real season/collection success consumers: they
                    // publish through the legacy facade immediately before close.
                    jc.toast('Direct-boot request saved', 60_000, 'success');
                    close();
                },
            });
            handle.show();
        });

        const modal = page.locator('.seerr-season-modal');
        await expect(modal).toBeVisible();
        expect(await page.evaluate(() => Boolean(
            (history.state as Record<string, unknown> | null)?.__jellyfinCanopySeerrModal
        ))).toBe(true);
        await modal.locator('.seerr-modal-button-primary').click();
        await expect(modal).toHaveCount(0, { timeout: 30_000 });
        expect(await page.evaluate(() => ({
            marker: Boolean(
                (history.state as Record<string, unknown> | null)?.__jellyfinCanopySeerrModal
            ),
            navigations: (window as any).__jcDirectBootNavigations,
            sameUrl: location.href === (window as any).__jcDirectBootUrl,
        }))).toEqual({ marker: false, navigations: 0, sameUrl: true });
        await expect(page.locator('.jellyfin-canopy-toast')).toHaveText('Direct-boot request saved');

        // A genuine host route change remains observable and owns notification
        // teardown; only the same-URL sentinel transition is suppressed.
        await showRoute(page, '/home?jc-notification-proof=direct-boot');
        await page.waitForFunction(
            () => location.hash.includes('jc-notification-proof=direct-boot'),
            undefined,
            { timeout: 30_000 }
        );
        await expect(page.locator('.jc-notification')).toHaveCount(0);
        expect(await page.evaluate(() => (window as any).__jcDirectBootNavigations)).toBe(1);
        await page.evaluate(() => {
            (window as any).__jcDirectBootOffNavigate();
            delete (window as any).__jcDirectBootOffNavigate;
        });

        assertNoRuntimeErrors(consoleErrors);
    });
});
