import { expect, type Page } from '@playwright/test';
import { assertNoRuntimeErrors, loginAs, showRoute, test } from './fixtures/auth';

/* eslint-disable @typescript-eslint/no-explicit-any */

async function waitForModalApi(page: Page): Promise<void> {
    await page.waitForFunction(() => {
        const jc = (window as any).JellyfinCanopy;
        return location.hash === '#/search'
            && typeof jc?.seerrModal?.create === 'function'
            && jc.identity?.getPendingInitializationCount?.() === 0;
    }, undefined, { timeout: 30_000 });
}

async function prepareModalRoute(page: Page): Promise<void> {
    await page.waitForFunction(() => {
        const jc = (window as any).JellyfinCanopy;
        return jc?.initialized === true
            && jc.identity?.getPendingInitializationCount?.() === 0;
    }, undefined, { timeout: 30_000 });
    await showRoute(page, '/search');
    await waitForModalApi(page);
}

test.describe('Seerr modal history ownership', () => {
    test('synthetic success consumes its own entry before the next real Back', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);
        await prepareModalRoute(page);

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
        await prepareModalRoute(page);

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
        await expect(modals.nth(0)).toHaveAccessibleName('Outer Escape proof');
        await expect(modals.nth(1)).toHaveAccessibleName('Inner Escape proof');
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
        await prepareModalRoute(page);

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

    test('same-task host push cancels a queued modal Back without losing either route', async ({
        page,
        consoleErrors,
    }) => {
        await loginAs(page, 'admin', consoleErrors);
        await prepareModalRoute(page);

        await page.evaluate(() => {
            const documentPath = `${location.pathname}${location.search}`;
            History.prototype.replaceState.call(
                history,
                { jcHistoryProof: 'race-route-a' },
                '',
                `${documentPath}#/search?jcHistoryProof=race-route-a`
            );
            const jc = (window as any).JellyfinCanopy;
            const handle = jc.seerrModal.create({
                title: 'Same-task close race proof',
                subtitle: 'Route B must win ownership',
                bodyHtml: '<p>Close queues traversal before the host writes B.</p>',
                onSave: () => undefined,
            });
            handle.show();
            handle.close();
            history.pushState(
                { jcHistoryProof: 'race-route-b' },
                '',
                `${documentPath}#/search?jcHistoryProof=race-route-b`
            );
        });

        await page.waitForFunction(() => {
            return (history.state as { jcHistoryProof?: string } | null)?.jcHistoryProof === 'race-route-b'
                && !document.querySelector('.seerr-season-modal')
                && !document.body.classList.contains('jc-modal-open')
                && !document.body.classList.contains('seerr-modal-is-open');
        }, undefined, { timeout: 30_000 });

        await page.evaluate(() => history.back());
        await page.waitForFunction(
            () => (history.state as { jcHistoryProof?: string } | null)?.jcHistoryProof === 'race-route-a',
            undefined,
            { timeout: 30_000 }
        );
        await page.evaluate(() => history.forward());
        await page.waitForFunction(
            () => (history.state as { jcHistoryProof?: string } | null)?.jcHistoryProof === 'race-route-b',
            undefined,
            { timeout: 30_000 }
        );

        assertNoRuntimeErrors(consoleErrors);
    });

    test('late host push repairs an issued Back at the capped history boundary', async ({
        page,
        consoleErrors,
    }) => {
        await loginAs(page, 'admin', consoleErrors);
        await prepareModalRoute(page);

        await page.evaluate(() => {
            const documentPath = `${location.pathname}${location.search}`;
            for (let index = 0; index < 60; index++) {
                History.prototype.pushState.call(
                    history,
                    { jcHistoryFiller: index },
                    '',
                    `${documentPath}#/search?jcHistoryFiller=${index}`
                );
            }
            History.prototype.replaceState.call(
                history,
                { jcHistoryProof: 'late-cap-route-a' },
                '',
                `${documentPath}#/search?jcHistoryProof=late-cap-route-a`
            );
            const proof: string[] = [];
            const jc = (window as any).JellyfinCanopy;
            const handle = jc.seerrModal.create({
                title: 'Late capped close race proof',
                subtitle: 'Route B must survive an already-issued Back',
                bodyHtml: '<p>The host write runs in the next timer.</p>',
                onSave: () => undefined,
                onClose: () => proof.push('closed'),
            });
            handle.show();
            (window as any).__jcLateCapProof = {
                lengthBeforeClose: history.length,
                phaseAtBack: null as string | null,
                proof,
                pushRuns: 0,
            };

            const owner = (window as any).__jellyfinCanopySeerrModalHistoryOwnerV2;
            const ownBackDescriptor = Object.getOwnPropertyDescriptor(history, 'back');
            const originalBack = history.back.bind(history);
            const restoreBack = () => {
                if (ownBackDescriptor) {
                    Object.defineProperty(history, 'back', ownBackDescriptor);
                } else {
                    delete (history as { back?: () => void }).back;
                }
            };
            Object.defineProperty(history, 'back', {
                configurable: true,
                writable: true,
                value: () => {
                    restoreBack();
                    (window as any).__jcLateCapProof.phaseAtBack =
                        owner.pendingOwnedTraversal?.phase ?? null;
                    originalBack();
                    (window as any).__jcLateCapProof.pushRuns += 1;
                    History.prototype.pushState.call(
                        history,
                        {
                            jcHistoryProof: 'late-cap-route-b',
                            payload: new Blob(
                                ['capped-target'],
                                { type: 'application/octet-stream' }
                            ),
                        },
                        '',
                        `${documentPath}#/search?jcHistoryProof=late-cap-route-b`
                    );
                    owner.historyObserver?.({
                        source: 'pushState',
                        state: history.state,
                        href: location.href,
                    });
                },
            });

            handle.close();
        });

        await page.waitForFunction(() => {
            const owner = (window as any).__jellyfinCanopySeerrModalHistoryOwnerV2;
            return location.hash === '#/search?jcHistoryProof=late-cap-route-b'
                && !owner?.pendingOwnedTraversal
                && !document.querySelector('.seerr-season-modal')
                && !document.body.classList.contains('jc-modal-open')
                && !document.body.classList.contains('seerr-modal-is-open');
        }, undefined, { timeout: 30_000 });
        const capProof = await page.evaluate(() => ({
            proof: [...(window as any).__jcLateCapProof.proof],
            lengthBeforeClose: (window as any).__jcLateCapProof.lengthBeforeClose,
            phaseAtBack: (window as any).__jcLateCapProof.phaseAtBack,
            pushRuns: (window as any).__jcLateCapProof.pushRuns,
            isFirefox: navigator.userAgent.includes('Firefox/'),
        }));
        expect(capProof.proof).toEqual(['closed']);
        expect(capProof.phaseAtBack).toBe('issued');
        expect(capProof.pushRuns).toBe(1);
        expect(capProof.lengthBeforeClose).toBeGreaterThanOrEqual(50);
        if (!capProof.isFirefox) expect(capProof.lengthBeforeClose).toBe(50);

        await page.evaluate(() => {
            const proof = {
                arrivals: [] as Array<{ marker: boolean; route: string | null }>,
                genuineASeen: false,
                stableSince: null as number | null,
            };
            const listener = (event: PopStateEvent) => {
                const state = event.state as {
                    __jellyfinCanopySeerrModal?: unknown;
                    jcHistoryProof?: string;
                } | null;
                const marker = Boolean(state?.__jellyfinCanopySeerrModal);
                const route = state?.jcHistoryProof ?? null;
                proof.arrivals.push({ marker, route });
                if (route === 'late-cap-route-a' && !marker) proof.genuineASeen = true;
            };
            window.addEventListener('popstate', listener);
            (window as any).__jcLateCapTraversalProof = {
                proof,
                release: () => window.removeEventListener('popstate', listener),
            };
            history.back();
        });
        await page.waitForFunction(() => {
            const owner = (window as any).__jellyfinCanopySeerrModalHistoryOwnerV2;
            const proof = (window as any).__jcLateCapTraversalProof.proof as {
                genuineASeen: boolean;
                stableSince: number | null;
            };
            const state = history.state as {
                __jellyfinCanopySeerrModal?: unknown;
                jcHistoryProof?: string;
            } | null;
            const stable = proof.genuineASeen
                && state?.jcHistoryProof === 'late-cap-route-a'
                && !state.__jellyfinCanopySeerrModal
                && !owner?.pendingOwnedTraversal;
            if (!stable) {
                proof.stableSince = null;
                return false;
            }
            proof.stableSince ??= performance.now();
            return performance.now() - proof.stableSince >= 100;
        }, undefined, { polling: 25, timeout: 30_000 });
        await page.evaluate(() => (window as any).__jcLateCapTraversalProof.release());
        await page.evaluate(() => history.forward());
        await page.waitForFunction(
            () => location.hash === '#/search?jcHistoryProof=late-cap-route-b',
            undefined,
            { timeout: 30_000 }
        );

        assertNoRuntimeErrors(consoleErrors);
    });

    for (const scheduler of ['setTimeout', 'MessageChannel', 'requestAnimationFrame'] as const) {
        test(`async stale-A canonicalization via ${scheduler} keeps B and releases recovery`, async ({
            page,
            consoleErrors,
        }) => {
            await loginAs(page, 'admin', consoleErrors);
            await prepareModalRoute(page);

            await page.evaluate((asyncScheduler) => {
                const stableHref = location.href;
                History.prototype.replaceState.call(
                    history,
                    { jcHistoryProof: 'async-canonical-route-a' },
                    '',
                    stableHref
                );
                const jc = (window as any).JellyfinCanopy;
                const handle = jc.seerrModal.create({
                    title: `Async ${asyncScheduler} canonicalization proof`,
                    subtitle: 'The saved B target must survive stale A',
                    bodyHtml: '<p>Recovery must clear before later user traversal.</p>',
                    onSave: () => undefined,
                });
                handle.show();

                const owner = (window as any).__jellyfinCanopySeerrModalHistoryOwnerV2;
                const modalListener = owner.listener as EventListener;
                window.removeEventListener('popstate', modalListener, true);
                const proof = {
                    laterStates: [] as Array<string | null>,
                    rewriteRuns: 0,
                    rewriteSettled: false,
                };
                const originalForward = history.forward.bind(history);
                const retainedMessageChannels = new Set<MessageChannel>();
                let queuedRecoveryForward = false;
                history.forward = () => {
                    if (proof.rewriteRuns > 0 && !proof.rewriteSettled) {
                        // Hold the exact recovery traversal until the selected
                        // scheduler has canonicalized stale A. Without this
                        // interleaving control, a slow task can legitimately run
                        // after B is already current and become an ordinary B
                        // replacement rather than a recovery-time rewrite.
                        queuedRecoveryForward = true;
                        return;
                    }
                    originalForward();
                };
                (window as any).__jcAsyncCanonicalProof = proof;
                window.addEventListener('popstate', (event) => {
                    if (proof.rewriteRuns > 0
                        || (event.state as { jcHistoryProof?: string } | null)?.jcHistoryProof
                            !== 'async-canonical-route-a') return;
                    proof.rewriteRuns += 1;
                    const rewrite = () => {
                        history.replaceState(
                            {
                                ...(event.state as Record<string, unknown>),
                                canonicalizedBy: asyncScheduler,
                            },
                            '',
                            stableHref
                        );
                        proof.rewriteSettled = true;
                        if (queuedRecoveryForward) {
                            queuedRecoveryForward = false;
                            originalForward();
                        }
                    };
                    if (asyncScheduler === 'setTimeout') {
                        setTimeout(rewrite, 0);
                    } else if (asyncScheduler === 'MessageChannel') {
                        const channel = new MessageChannel();
                        retainedMessageChannels.add(channel);
                        channel.port1.addEventListener('message', () => {
                            try {
                                rewrite();
                            } finally {
                                channel.port1.close();
                                channel.port2.close();
                                retainedMessageChannels.delete(channel);
                            }
                        }, { once: true });
                        channel.port1.start();
                        channel.port2.postMessage(undefined);
                    } else {
                        requestAnimationFrame(rewrite);
                    }
                }, { capture: true });
                window.addEventListener('popstate', modalListener, { capture: true });
                window.addEventListener('popstate', (event) => {
                    proof.laterStates.push(
                        (event.state as { jcHistoryProof?: string } | null)?.jcHistoryProof ?? null
                    );
                });

                handle.close();
                setTimeout(() => {
                    history.pushState(
                        { jcHistoryProof: 'async-canonical-route-b' },
                        '',
                        stableHref
                    );
                }, 0);
            }, scheduler);

            await page.waitForFunction(() => {
                const owner = (window as any).__jellyfinCanopySeerrModalHistoryOwnerV2;
                const proof = (window as any).__jcAsyncCanonicalProof;
                return (history.state as { jcHistoryProof?: string } | null)?.jcHistoryProof
                        === 'async-canonical-route-b'
                    && proof?.rewriteSettled === true
                    && !owner?.pendingOwnedTraversal
                    && !document.querySelector('.seerr-season-modal')
                    && !document.body.classList.contains('jc-modal-open');
            }, undefined, { polling: 50, timeout: 30_000 });
            expect(await page.evaluate(() => (window as any).__jcAsyncCanonicalProof)).toEqual({
                laterStates: ['async-canonical-route-b'],
                rewriteRuns: 1,
                rewriteSettled: true,
            });

            await page.evaluate(() => history.back());
            await page.waitForFunction(() => {
                const proof = (window as any).__jcAsyncCanonicalProof;
                return proof.laterStates.at(-1) === 'async-canonical-route-a'
                    && !(window as any).__jellyfinCanopySeerrModalHistoryOwnerV2.pendingOwnedTraversal;
            }, undefined, { timeout: 30_000 });
            await page.evaluate(() => history.forward());
            await page.waitForFunction(() => {
                const proof = (window as any).__jcAsyncCanonicalProof;
                return proof.laterStates.at(-1) === 'async-canonical-route-b'
                    && !(window as any).__jellyfinCanopySeerrModalHistoryOwnerV2.pendingOwnedTraversal;
            }, undefined, { timeout: 30_000 });
            expect(await page.evaluate(
                () => (window as any).__jcAsyncCanonicalProof.laterStates
            )).toEqual([
                'async-canonical-route-b',
                'async-canonical-route-a',
                'async-canonical-route-b',
            ]);

            assertNoRuntimeErrors(consoleErrors);
        });
    }

    test('sync recovered-B canonicalization clears recovery and reaches later routers', async ({
        page,
        consoleErrors,
    }) => {
        await loginAs(page, 'admin', consoleErrors);
        await prepareModalRoute(page);

        await page.evaluate(() => {
            const stableHref = location.href;
            History.prototype.replaceState.call(
                history,
                { jcHistoryProof: 'sync-canonical-route-a' },
                '',
                stableHref
            );
            const jc = (window as any).JellyfinCanopy;
            const handle = jc.seerrModal.create({
                title: 'Recovered B canonicalization proof',
                subtitle: 'The immutable B pop must settle recovery',
                bodyHtml: '<p>The canonical host state must remain current.</p>',
                onSave: () => undefined,
            });
            handle.show();

            const owner = (window as any).__jellyfinCanopySeerrModalHistoryOwnerV2;
            const modalListener = owner.listener as EventListener;
            window.removeEventListener('popstate', modalListener, true);
            const proof = {
                laterStates: [] as Array<string | null>,
                phaseAtBack: null as string | null,
                pushRuns: 0,
                rewriteRuns: 0,
            };
            (window as any).__jcSyncCanonicalProof = proof;
            window.addEventListener('popstate', (event) => {
                if (proof.rewriteRuns > 0
                    || (event.state as { jcHistoryProof?: string } | null)?.jcHistoryProof
                        !== 'sync-canonical-route-b') return;
                proof.rewriteRuns += 1;
                history.replaceState(
                    {
                        ...(event.state as Record<string, unknown>),
                        canonicalized: true,
                    },
                    '',
                    stableHref
                );
            }, { capture: true });
            window.addEventListener('popstate', modalListener, { capture: true });
            window.addEventListener('popstate', (event) => {
                proof.laterStates.push(
                    (event.state as { jcHistoryProof?: string } | null)?.jcHistoryProof ?? null
                );
            });

            // The close owner deliberately defers its Back to a zero-delay
            // timer. A second zero-delay timer is not a deterministic way to
            // place B after that Back was issued but before its asynchronous
            // pop: the browser may run the traversal task between the two timer
            // tasks, making the later push too late for canonicalization.
            // Interpose exactly one real history.back call so the adversarial
            // push happens synchronously after Back is issued. Restore the
            // instance method first and preserve any host-owned wrapper.
            const ownBackDescriptor = Object.getOwnPropertyDescriptor(history, 'back');
            const originalBack = history.back.bind(history);
            const restoreBack = () => {
                if (ownBackDescriptor) {
                    Object.defineProperty(history, 'back', ownBackDescriptor);
                } else {
                    delete (history as { back?: () => void }).back;
                }
            };
            Object.defineProperty(history, 'back', {
                configurable: true,
                writable: true,
                value: () => {
                    restoreBack();
                    proof.phaseAtBack = owner.pendingOwnedTraversal?.phase ?? null;
                    originalBack();
                    proof.pushRuns += 1;
                    history.pushState(
                        { jcHistoryProof: 'sync-canonical-route-b' },
                        '',
                        stableHref
                    );
                },
            });

            handle.close();
        });

        await page.waitForFunction(() => {
            const owner = (window as any).__jellyfinCanopySeerrModalHistoryOwnerV2;
            const state = history.state as {
                jcHistoryProof?: string;
                canonicalized?: boolean;
            } | null;
            return state?.jcHistoryProof === 'sync-canonical-route-b'
                && state.canonicalized === true
                && !owner?.pendingOwnedTraversal
                && !document.querySelector('.seerr-season-modal');
        }, undefined, { polling: 50, timeout: 30_000 });
        expect(await page.evaluate(() => (window as any).__jcSyncCanonicalProof)).toEqual({
            laterStates: ['sync-canonical-route-b'],
            phaseAtBack: 'issued',
            pushRuns: 1,
            rewriteRuns: 1,
        });

        await page.evaluate(() => history.back());
        await page.waitForFunction(() => {
            const proof = (window as any).__jcSyncCanonicalProof;
            return proof.laterStates.at(-1) === 'sync-canonical-route-a'
                && !(window as any).__jellyfinCanopySeerrModalHistoryOwnerV2.pendingOwnedTraversal;
        }, undefined, { timeout: 30_000 });
        await page.evaluate(() => history.forward());
        await page.waitForFunction(() => {
            const proof = (window as any).__jcSyncCanonicalProof;
            return proof.laterStates.at(-1) === 'sync-canonical-route-b'
                && !(window as any).__jellyfinCanopySeerrModalHistoryOwnerV2.pendingOwnedTraversal;
        }, undefined, { timeout: 30_000 });
        expect(await page.evaluate(
            () => (window as any).__jcSyncCanonicalProof.laterStates
        )).toEqual([
            'sync-canonical-route-b',
            'sync-canonical-route-a',
            'sync-canonical-route-b',
        ]);

        assertNoRuntimeErrors(consoleErrors);
    });

    for (const direction of ['back', 'forward'] as const) {
        for (const rewriteCase of [
            { channel: 'setTimeout', shape: 'copy' },
            { channel: 'MessageChannel', shape: 'copy' },
            { channel: 'requestAnimationFrame', shape: 'copy' },
        ] as const) {
            test(`deferred ${rewriteCase.channel} ${rewriteCase.shape} rewrite stays private on retired-marker ${direction}`, async ({
                page,
                consoleErrors,
            }) => {
                await loginAs(page, 'admin', consoleErrors);
                await prepareModalRoute(page);

                await page.evaluate(({ crossingDirection, channel, shape }) => {
                    const stableHref = location.href;
                    History.prototype.replaceState.call(
                        history,
                        { jcHistoryProof: 'marker-rewrite-route-a' },
                        '',
                        stableHref
                    );
                    const jc = (window as any).JellyfinCanopy;
                    const handle = jc.seerrModal.create({
                        title: `Retired marker ${crossingDirection} rewrite proof`,
                        subtitle: `${channel} must not publish a ghost route`,
                        bodyHtml: '<p>The private entry must be restored until traversal lands.</p>',
                        onSave: () => undefined,
                    });
                    handle.show();
                    const markerToken = (history.state as any).__jellyfinCanopySeerrModal.token;
                    const owner = (window as any).__jellyfinCanopySeerrModalHistoryOwnerV2;
                    const modalListener = owner.listener as EventListener;
                    window.removeEventListener('popstate', modalListener, true);
                    const proof = {
                        enabled: crossingDirection === 'back',
                        laterStates: [] as Array<string | null>,
                        rewriteRuns: 0,
                        rewriteSettled: false,
                    };
                    const retainedMessageChannels = new Set<MessageChannel>();
                    (window as any).__jcMarkerRewriteProof = proof;
                    window.addEventListener('popstate', (event) => {
                        const marker = (event.state as any)?.__jellyfinCanopySeerrModal;
                        if (!proof.enabled || proof.rewriteRuns > 0 || marker?.token !== markerToken) return;
                        proof.rewriteRuns += 1;
                        const rewrite = () => {
                            const replacement = shape === 'copy'
                                ? { ...(event.state as Record<string, unknown>), copiedRewrite: channel }
                                : { jcHistoryProof: 'marker-rewrite-ghost', channel };
                            history.replaceState(replacement, '', stableHref);
                            proof.rewriteSettled = true;
                        };
                        if (channel === 'setTimeout') {
                            setTimeout(rewrite, 0);
                        } else if (channel === 'MessageChannel') {
                            const messageChannel = new MessageChannel();
                            retainedMessageChannels.add(messageChannel);
                            messageChannel.port1.addEventListener('message', () => {
                                try {
                                    rewrite();
                                } finally {
                                    messageChannel.port1.close();
                                    messageChannel.port2.close();
                                    retainedMessageChannels.delete(messageChannel);
                                }
                            }, { once: true });
                            messageChannel.port1.start();
                            messageChannel.port2.postMessage(undefined);
                        } else {
                            requestAnimationFrame(rewrite);
                        }
                    }, { capture: true });
                    window.addEventListener('popstate', modalListener, { capture: true });
                    window.addEventListener('popstate', (event) => {
                        proof.laterStates.push(
                            (event.state as { jcHistoryProof?: string } | null)?.jcHistoryProof ?? null
                        );
                    });

                    history.pushState({ jcHistoryProof: 'marker-rewrite-route-b' }, '', stableHref);
                    handle.close();
                }, {
                    crossingDirection: direction,
                    channel: rewriteCase.channel,
                    shape: rewriteCase.shape,
                });

                if (direction === 'forward') {
                    await page.evaluate(() => history.back());
                    await page.waitForFunction(() => {
                        const proof = (window as any).__jcMarkerRewriteProof;
                        return proof.laterStates.at(-1) === 'marker-rewrite-route-a'
                            && !(window as any).__jellyfinCanopySeerrModalHistoryOwnerV2.pendingOwnedTraversal;
                    }, undefined, { timeout: 30_000 });
                    await page.evaluate(() => {
                        const proof = (window as any).__jcMarkerRewriteProof;
                        proof.laterStates.length = 0;
                        proof.enabled = true;
                    });
                    await page.evaluate(() => history.forward());
                } else {
                    await page.evaluate(() => history.back());
                }

                const firstTarget = direction === 'back'
                    ? 'marker-rewrite-route-a'
                    : 'marker-rewrite-route-b';
                await page.waitForFunction((target) => {
                    const proof = (window as any).__jcMarkerRewriteProof;
                    return proof.rewriteSettled === true
                        && proof.laterStates.at(-1) === target
                        && (history.state as { jcHistoryProof?: string } | null)?.jcHistoryProof === target
                        && !(window as any).__jellyfinCanopySeerrModalHistoryOwnerV2.pendingOwnedTraversal;
                }, firstTarget, { timeout: 30_000 });

                if (direction === 'back') {
                    await page.evaluate(() => history.forward());
                } else {
                    await page.evaluate(() => history.back());
                }
                const secondTarget = direction === 'back'
                    ? 'marker-rewrite-route-b'
                    : 'marker-rewrite-route-a';
                await page.waitForFunction((target) => {
                    const proof = (window as any).__jcMarkerRewriteProof;
                    return proof.laterStates.at(-1) === target
                        && (history.state as { jcHistoryProof?: string } | null)?.jcHistoryProof === target
                        && !(window as any).__jellyfinCanopySeerrModalHistoryOwnerV2.pendingOwnedTraversal;
                }, secondTarget, { timeout: 30_000 });
                expect(await page.evaluate(() => (window as any).__jcMarkerRewriteProof)).toEqual({
                    enabled: true,
                    laterStates: [firstTarget, secondTarget],
                    rewriteRuns: 1,
                    rewriteSettled: true,
                });

                assertNoRuntimeErrors(consoleErrors);
            });
        }
    }

    for (const direction of ['back', 'forward'] as const) {
            test(`microtask PUSH from retired-marker ${direction} keeps G and native go(-2) Forward`, async ({
            page,
            consoleErrors,
        }) => {
            await loginAs(page, 'admin', consoleErrors);
            await prepareModalRoute(page);

            await page.evaluate((crossingDirection) => {
                const stableHref = location.href;
                History.prototype.replaceState.call(
                    history,
                    { jcHistoryProof: 'marker-push-route-a' },
                    '',
                    stableHref
                );
                const jc = (window as any).JellyfinCanopy;
                const handle = jc.seerrModal.create({
                    title: `Retired marker ${crossingDirection} PUSH proof`,
                    subtitle: 'G must win without a stale private stop',
                    bodyHtml: '<p>Recovery must remain two-way after go(-2).</p>',
                    onSave: () => undefined,
                });
                handle.show();
                const markerToken = (history.state as any).__jellyfinCanopySeerrModal.token;
                const owner = (window as any).__jellyfinCanopySeerrModalHistoryOwnerV2;
                const modalListener = owner.listener as EventListener;
                window.removeEventListener('popstate', modalListener, true);
                const proof = {
                    enabled: crossingDirection === 'back',
                    laterStates: [] as Array<string | null>,
                    pushRuns: 0,
                };
                (window as any).__jcMarkerPushProof = proof;
                window.addEventListener('popstate', (event) => {
                    const marker = (event.state as any)?.__jellyfinCanopySeerrModal;
                    if (!proof.enabled || proof.pushRuns > 0 || marker?.token !== markerToken) return;
                    proof.pushRuns += 1;
                    queueMicrotask(() => {
                        history.pushState({ jcHistoryProof: 'marker-push-route-g' }, '', stableHref);
                    });
                }, { capture: true });
                window.addEventListener('popstate', modalListener, { capture: true });
                window.addEventListener('popstate', (event) => {
                    proof.laterStates.push(
                        (event.state as { jcHistoryProof?: string } | null)?.jcHistoryProof ?? null
                    );
                });

                history.pushState({ jcHistoryProof: 'marker-push-route-b' }, '', stableHref);
                handle.close();
            }, direction);

            if (direction === 'forward') {
                await page.evaluate(() => history.back());
                await page.waitForFunction(() => {
                    const proof = (window as any).__jcMarkerPushProof;
                    return proof.laterStates.at(-1) === 'marker-push-route-a'
                        && !(window as any).__jellyfinCanopySeerrModalHistoryOwnerV2.pendingOwnedTraversal;
                }, undefined, { timeout: 30_000 });
                await page.evaluate(() => {
                    const proof = (window as any).__jcMarkerPushProof;
                    proof.laterStates.length = 0;
                    proof.enabled = true;
                    history.forward();
                });
            } else {
                await page.evaluate(() => history.back());
            }

            await page.waitForFunction(() => {
                const proof = (window as any).__jcMarkerPushProof;
                return proof.pushRuns === 1
                    && (history.state as { jcHistoryProof?: string } | null)?.jcHistoryProof
                        === 'marker-push-route-g'
                    && !(window as any).__jellyfinCanopySeerrModalHistoryOwnerV2.pendingOwnedTraversal;
            }, undefined, { timeout: 30_000 });

            await page.evaluate(() => history.go(-2));
            await page.waitForFunction(() => {
                const proof = (window as any).__jcMarkerPushProof;
                return proof.laterStates.at(-1) === 'marker-push-route-a'
                    && !(window as any).__jellyfinCanopySeerrModalHistoryOwnerV2.pendingOwnedTraversal;
            }, undefined, { timeout: 30_000 });
            await page.evaluate(() => history.forward());
            await page.waitForFunction(() => {
                const proof = (window as any).__jcMarkerPushProof;
                return proof.laterStates.at(-1) === 'marker-push-route-g'
                    && !(window as any).__jellyfinCanopySeerrModalHistoryOwnerV2.pendingOwnedTraversal;
            }, undefined, { timeout: 30_000 });
            const laterStates = await page.evaluate(
                () => (window as any).__jcMarkerPushProof.laterStates as Array<string | null>
            );
            expect(laterStates.slice(-2)).toEqual([
                'marker-push-route-a',
                'marker-push-route-g',
            ]);
            expect(laterStates.every(
                (state) => state === 'marker-push-route-a' || state === 'marker-push-route-g'
            )).toBe(true);

            assertNoRuntimeErrors(consoleErrors);
        });
    }

    test('sync PUSH from reached inner marker keeps the older live modal', async ({
        page,
        consoleErrors,
    }) => {
        await loginAs(page, 'admin', consoleErrors);
        await prepareModalRoute(page);

        await page.evaluate(() => {
            const stableHref = location.href;
            const jc = (window as any).JellyfinCanopy;
            const proof: string[] = [];
            const outer = jc.seerrModal.create({
                title: 'Older live modal after PUSH',
                subtitle: 'Must remain open',
                bodyHtml: '<p>Outer modal</p>',
                onSave: () => undefined,
                onClose: () => proof.push('outer'),
            });
            outer.show();
            const inner = jc.seerrModal.create({
                title: 'Reached inner marker PUSH',
                subtitle: 'Must close once',
                bodyHtml: '<p>Inner modal</p>',
                onSave: () => undefined,
                onClose: () => proof.push('inner'),
            });
            inner.show();
            const innerToken = (history.state as any).__jellyfinCanopySeerrModal.token;
            const owner = (window as any).__jellyfinCanopySeerrModalHistoryOwnerV2;
            const modalListener = owner.listener as EventListener;
            window.removeEventListener('popstate', modalListener, true);
            const state = { proof, laterStates: [] as unknown[] };
            (window as any).__jcSyncMarkerPushProof = state;
            window.addEventListener('popstate', (event) => {
                const marker = (event.state as any)?.__jellyfinCanopySeerrModal;
                if (marker?.token !== innerToken) return;
                history.pushState({ jcHistoryProof: 'sync-marker-push-g' }, '', stableHref);
            }, { capture: true, once: true });
            window.addEventListener('popstate', modalListener, { capture: true });
            window.addEventListener('popstate', (event) => state.laterStates.push(event.state));
            history.pushState({ jcHistoryProof: 'sync-marker-push-b' }, '', stableHref);
        });

        await page.evaluate(() => history.back());
        await page.waitForFunction(() => {
            const owner = (window as any).__jellyfinCanopySeerrModalHistoryOwnerV2;
            const modals = document.querySelectorAll('.seerr-season-modal');
            return (history.state as { jcHistoryProof?: string } | null)?.jcHistoryProof
                    === 'sync-marker-push-g'
                && !owner.pendingOwnedTraversal
                && modals.length === 1;
        }, undefined, { timeout: 30_000 });
        await expect(page.locator('.seerr-season-modal')).toHaveAccessibleName('Older live modal after PUSH');
        expect(await page.evaluate(() => (window as any).__jcSyncMarkerPushProof)).toEqual({
            proof: ['inner'],
            laterStates: [],
        });

        assertNoRuntimeErrors(consoleErrors);
    });

    test('reactive push during the stale pop settles at D without exposing A or overshooting', async ({
        page,
        consoleErrors,
    }) => {
        await loginAs(page, 'admin', consoleErrors);
        await prepareModalRoute(page);

        await page.evaluate(() => {
            const stableHref = location.href;
            History.prototype.replaceState.call(
                history,
                { jcHistoryProof: 'reactive-route-a' },
                '',
                stableHref
            );
            const jc = (window as any).JellyfinCanopy;
            const handle = jc.seerrModal.create({
                title: 'Reactive stale-pop proof',
                subtitle: 'The router PUSH to D wins',
                bodyHtml: '<p>No stale A event may reach later routers.</p>',
                onSave: () => undefined,
            });
            handle.show();

            const owner = (window as any).__jellyfinCanopySeerrModalHistoryOwnerV2;
            const modalListener = owner.listener as EventListener;
            window.removeEventListener('popstate', modalListener, true);
            const proof = { laterStates: [] as unknown[], reactiveRuns: 0 };
            (window as any).__jcReactivePushProof = proof;
            window.addEventListener('popstate', () => {
                proof.reactiveRuns += 1;
                History.prototype.pushState.call(
                    history,
                    { jcHistoryProof: 'reactive-route-d' },
                    '',
                    stableHref
                );
                owner.historyObserver?.({
                    source: 'HISTORY_UPDATE',
                    action: 'PUSH',
                    entryKey: 'reactive-route-d',
                    state: history.state,
                    href: location.href,
                });
            }, { capture: true, once: true });
            window.addEventListener('popstate', modalListener, { capture: true });
            window.addEventListener('popstate', (event) => proof.laterStates.push(event.state));

            handle.close();
            setTimeout(() => {
                History.prototype.pushState.call(
                    history,
                    { jcHistoryProof: 'reactive-route-b' },
                    '',
                    stableHref
                );
                owner.historyObserver?.({
                    source: 'pushState',
                    action: 'PUSH',
                    state: history.state,
                    href: location.href,
                });
            }, 0);
        });

        await page.waitForFunction(() => {
            const owner = (window as any).__jellyfinCanopySeerrModalHistoryOwnerV2;
            return (history.state as { jcHistoryProof?: string } | null)?.jcHistoryProof === 'reactive-route-d'
                && !document.querySelector('.seerr-season-modal')
                && !document.body.classList.contains('jc-modal-open')
                && !owner.pendingOwnedTraversal;
        }, undefined, { polling: 50, timeout: 30_000 });
        expect(await page.evaluate(() => (window as any).__jcReactivePushProof)).toEqual({
            laterStates: [],
            reactiveRuns: 1,
        });

        await page.evaluate(() => history.back());
        await page.waitForFunction(
            () => ((window as any).__jcReactivePushProof.laterStates.at(-1) as {
                jcHistoryProof?: string;
            } | null)?.jcHistoryProof === 'reactive-route-a',
            undefined,
            { timeout: 30_000 }
        );
        await page.evaluate(() => history.forward());
        await page.waitForFunction(
            () => ((window as any).__jcReactivePushProof.laterStates.at(-1) as {
                jcHistoryProof?: string;
            } | null)?.jcHistoryProof === 'reactive-route-d',
            undefined,
            { timeout: 30_000 }
        );

        assertNoRuntimeErrors(consoleErrors);
    });

    test('late copied-marker replace preserves host state and repairs directly to B', async ({
        page,
        consoleErrors,
    }) => {
        await loginAs(page, 'admin', consoleErrors);
        await prepareModalRoute(page);

        await page.evaluate(() => {
            const stableHref = location.href;
            const proof = { arrivals: [] as string[], writeState: null as unknown };
            (window as any).__jcLateReplaceProof = proof;
            window.addEventListener('popstate', (event) => {
                const value = (event.state as { jcHistoryProof?: unknown } | null)?.jcHistoryProof;
                if (typeof value === 'string') proof.arrivals.push(value);
            });
            History.prototype.replaceState.call(
                history,
                { jcHistoryProof: 'late-replace-route-a', preservedA: { exact: 23 } },
                '',
                stableHref
            );
            const jc = (window as any).JellyfinCanopy;
            const handle = jc.seerrModal.create({
                title: 'Late copied replace proof',
                subtitle: 'Only the private field may be stripped',
                bodyHtml: '<p>Host state must survive byte-for-byte structurally.</p>',
                onSave: () => undefined,
            });
            handle.show();
            handle.close();
            setTimeout(() => {
                History.prototype.replaceState.call(
                    history,
                    {
                        ...(history.state as Record<string, unknown>),
                        jcHistoryProof: 'late-replace-route-b',
                        preservedB: { exact: 29 },
                        usr: null,
                    },
                    '',
                    stableHref
                );
                (window as any).__jellyfinCanopySeerrModalHistoryOwnerV2.historyObserver?.({
                    source: 'replaceState',
                    action: 'REPLACE',
                    state: history.state,
                    href: location.href,
                });
                proof.writeState = structuredClone(history.state);
            }, 0);
        });

        await page.waitForFunction(() => {
            const owner = (window as any).__jellyfinCanopySeerrModalHistoryOwnerV2;
            return (window as any).__jcLateReplaceProof.arrivals.at(-1) === 'late-replace-route-b'
                && !document.querySelector('.seerr-season-modal')
                && !owner.pendingOwnedTraversal;
        }, undefined, { polling: 50, timeout: 30_000 });
        expect(await page.evaluate(() => (window as any).__jcLateReplaceProof.writeState)).toEqual({
            jcHistoryProof: 'late-replace-route-b',
            preservedA: { exact: 23 },
            preservedB: { exact: 29 },
            usr: null,
        });

        await page.evaluate(() => history.back());
        await page.waitForFunction(
            () => (window as any).__jcLateReplaceProof.arrivals.at(-1) === 'late-replace-route-a',
            undefined,
            { timeout: 30_000 }
        );
        await page.evaluate(() => history.forward());
        await page.waitForFunction(
            () => (window as any).__jcLateReplaceProof.arrivals.at(-1) === 'late-replace-route-b',
            undefined,
            { timeout: 30_000 }
        );

        assertNoRuntimeErrors(consoleErrors);
    });

    test('Blob base state cannot strand modal UI when a browser reports a null pop state', async ({
        page,
        consoleErrors,
    }) => {
        await loginAs(page, 'admin', consoleErrors);
        await prepareModalRoute(page);

        await page.evaluate(() => {
            const documentPath = `${location.pathname}${location.search}`;
            History.prototype.replaceState.call(
                history,
                {
                    jcHistoryProof: 'blob-base-route-a',
                    payload: new Blob(['history-owner'], { type: 'application/octet-stream' }),
                },
                '',
                `${documentPath}#/search?jcHistoryProof=blob-base-route-a`
            );
            const proof: string[] = [];
            const jc = (window as any).JellyfinCanopy;
            const handle = jc.seerrModal.create({
                title: 'Blob base close proof',
                subtitle: 'The owned Back identifies the pop even if state is null',
                bodyHtml: '<p>No modal ownership may remain.</p>',
                onSave: () => undefined,
                onClose: () => proof.push('closed'),
            });
            (window as any).__jcBlobCloseProof = proof;
            handle.show();
            handle.close();
        });

        await page.waitForFunction(() => {
            const owner = (window as any).__jellyfinCanopySeerrModalHistoryOwnerV2;
            return location.hash === '#/search?jcHistoryProof=blob-base-route-a'
                && !document.querySelector('.seerr-season-modal')
                && !document.body.classList.contains('jc-modal-open')
                && !document.body.classList.contains('seerr-modal-is-open')
                && owner.records.size === 0
                && !owner.pendingOwnedTraversal;
        }, undefined, { timeout: 30_000 });
        expect(await page.evaluate(() => [...(window as any).__jcBlobCloseProof])).toEqual(['closed']);

        assertNoRuntimeErrors(consoleErrors);
    });

    test('M2 closes at B without consuming buried M1 and A to B stays reversible', async ({
        page,
        consoleErrors,
    }) => {
        await loginAs(page, 'admin', consoleErrors);
        await prepareModalRoute(page);

        await page.evaluate(() => {
            const stableHref = location.href;
            const arrivals: string[] = [];
            window.addEventListener('popstate', (event) => {
                const value = (event.state as { jcHistoryProof?: unknown } | null)?.jcHistoryProof;
                if (typeof value === 'string') arrivals.push(value);
            });
            History.prototype.replaceState.call(
                history,
                { jcHistoryProof: 'two-modal-route-a' },
                '',
                stableHref
            );
            const proof: string[] = [];
            const jc = (window as any).JellyfinCanopy;
            const first = jc.seerrModal.create({
                title: 'Route A modal M1',
                subtitle: 'Must survive the M2 base pop',
                bodyHtml: '<p>First modal.</p>',
                onSave: () => undefined,
                onClose: () => proof.push('m1'),
            });
            first.show();
            History.prototype.pushState.call(
                history,
                { jcHistoryProof: 'two-modal-route-b' },
                '',
                stableHref
            );
            (window as any).__jellyfinCanopySeerrModalHistoryOwnerV2.historyObserver?.({
                source: 'pushState',
                action: 'PUSH',
                state: history.state,
                href: location.href,
            });
            const second = jc.seerrModal.create({
                title: 'Route B modal M2',
                subtitle: 'Its exact base is B',
                bodyHtml: '<p>Second modal.</p>',
                onSave: () => undefined,
                onClose: () => proof.push('m2'),
            });
            second.show();
            (window as any).__jcTwoModalProof = { first, second, proof, arrivals };
            second.close();
        });

        const modals = page.locator('.seerr-season-modal');
        await page.waitForFunction(
            () => (window as any).__jcTwoModalProof.arrivals.at(-1) === 'two-modal-route-b',
            undefined,
            { timeout: 30_000 }
        );
        await expect(modals).toHaveCount(1, { timeout: 30_000 });
        await expect(modals).toHaveAccessibleName('Route A modal M1');
        expect(await page.evaluate(
            () => [...((window as any).__jcTwoModalProof.proof as string[])]
        )).toEqual(['m2']);

        await page.evaluate(() => (window as any).__jcTwoModalProof.first.close());
        await expect(modals).toHaveCount(0, { timeout: 30_000 });
        expect(await page.evaluate(
            () => [...((window as any).__jcTwoModalProof.proof as string[])]
        )).toEqual(['m2', 'm1']);

        await page.evaluate(() => history.back());
        await page.waitForFunction(
            () => (window as any).__jcTwoModalProof.arrivals.at(-1) === 'two-modal-route-a',
            undefined,
            { timeout: 30_000 }
        );
        await page.evaluate(() => history.forward());
        await page.waitForFunction(
            () => (window as any).__jcTwoModalProof.arrivals.at(-1) === 'two-modal-route-b',
            undefined,
            { timeout: 30_000 }
        );

        assertNoRuntimeErrors(consoleErrors);
    });

    test('nested late push recovers through retired M2 without closing live M1', async ({
        page,
        consoleErrors,
    }) => {
        await loginAs(page, 'admin', consoleErrors);
        await prepareModalRoute(page);

        await page.evaluate(() => {
            const stableHref = location.href;
            const arrivals: string[] = [];
            window.addEventListener('popstate', (event) => {
                const value = (event.state as { jcHistoryProof?: unknown } | null)?.jcHistoryProof;
                if (typeof value === 'string') arrivals.push(value);
            });
            History.prototype.replaceState.call(
                history,
                { jcHistoryProof: 'nested-late-route-a' },
                '',
                stableHref
            );
            const proof: string[] = [];
            const jc = (window as any).JellyfinCanopy;
            const outer = jc.seerrModal.create({
                title: 'Nested late outer M1',
                subtitle: 'Must remain live throughout M2 recovery',
                bodyHtml: '<p>Outer modal.</p>',
                onSave: () => undefined,
                onClose: () => proof.push('m1'),
            });
            outer.show();
            const inner = jc.seerrModal.create({
                title: 'Nested late inner M2',
                subtitle: 'The late host push retires only this modal',
                bodyHtml: '<p>Inner modal.</p>',
                onSave: () => undefined,
                onClose: () => proof.push('m2'),
            });
            inner.show();
            (window as any).__jcNestedLateProof = { outer, proof, arrivals };
            inner.close();
            setTimeout(() => {
                History.prototype.pushState.call(
                    history,
                    { jcHistoryProof: 'nested-late-route-b' },
                    '',
                    stableHref
                );
                (window as any).__jellyfinCanopySeerrModalHistoryOwnerV2.historyObserver?.({
                    source: 'pushState',
                    action: 'PUSH',
                    state: history.state,
                    href: location.href,
                });
            }, 0);
        });

        const modals = page.locator('.seerr-season-modal');
        await page.waitForFunction(() => {
            const owner = (window as any).__jellyfinCanopySeerrModalHistoryOwnerV2;
            return (window as any).__jcNestedLateProof.arrivals.at(-1) === 'nested-late-route-b'
                && !owner.pendingOwnedTraversal;
        }, undefined, { polling: 50, timeout: 30_000 });
        await expect(modals).toHaveCount(1);
        await expect(modals).toHaveAccessibleName('Nested late outer M1');
        expect(await page.evaluate(
            () => [...((window as any).__jcNestedLateProof.proof as string[])]
        )).toEqual(['m2']);

        await page.evaluate(() => (window as any).__jcNestedLateProof.outer.close());
        await expect(modals).toHaveCount(0, { timeout: 30_000 });
        expect(await page.evaluate(
            () => [...((window as any).__jcNestedLateProof.proof as string[])]
        )).toEqual(['m2', 'm1']);

        await page.evaluate(() => history.back());
        await page.waitForFunction(
            () => (window as any).__jcNestedLateProof.arrivals.at(-1) === 'nested-late-route-a',
            undefined,
            { timeout: 30_000 }
        );
        await page.evaluate(() => history.forward());
        await page.waitForFunction(
            () => (window as any).__jcNestedLateProof.arrivals.at(-1) === 'nested-late-route-b',
            undefined,
            { timeout: 30_000 }
        );

        assertNoRuntimeErrors(consoleErrors);
    });

    test('direct multi-entry traversal keeps the reached outer modal and skips the crossed inner', async ({
        page,
        consoleErrors,
    }) => {
        await loginAs(page, 'admin', consoleErrors);
        await prepareModalRoute(page);

        await page.evaluate(() => {
            const stableHref = location.href;
            const arrivals: string[] = [];
            window.addEventListener('popstate', (event) => {
                const value = (event.state as { jcHistoryProof?: unknown } | null)?.jcHistoryProof;
                if (typeof value === 'string') arrivals.push(value);
            });
            History.prototype.replaceState.call(
                history,
                { jcHistoryProof: 'multi-route-a' },
                '',
                stableHref
            );
            const proof: string[] = [];
            const jc = (window as any).JellyfinCanopy;
            const outer = jc.seerrModal.create({
                title: 'Multi-entry outer modal',
                subtitle: 'The direct traversal lands here',
                bodyHtml: '<p>Outer modal.</p>',
                onSave: () => undefined,
                onClose: () => proof.push('outer'),
            });
            outer.show();
            const inner = jc.seerrModal.create({
                title: 'Multi-entry inner modal',
                subtitle: 'The direct traversal skips this marker',
                bodyHtml: '<p>Inner modal.</p>',
                onSave: () => undefined,
                onClose: () => proof.push('inner'),
            });
            inner.show();
            History.prototype.pushState.call(
                history,
                { jcHistoryProof: 'multi-route-b' },
                '',
                stableHref
            );
            (window as any).__jellyfinCanopySeerrModalHistoryOwnerV2.historyObserver?.({
                source: 'pushState',
                action: 'PUSH',
                state: history.state,
                href: location.href,
            });
            (window as any).__jcMultiModalProof = { proof, arrivals };
            history.go(-2);
        });

        const modals = page.locator('.seerr-season-modal');
        await expect(modals).toHaveCount(1, { timeout: 30_000 });
        await expect(modals).toHaveAccessibleName('Multi-entry outer modal');
        expect(await page.evaluate(
            () => [...((window as any).__jcMultiModalProof.proof as string[])]
        )).toEqual(['inner']);

        await page.evaluate(() => history.forward());
        await page.waitForFunction(
            () => (window as any).__jcMultiModalProof.arrivals.at(-1) === 'multi-route-b',
            undefined,
            { timeout: 30_000 }
        );
        await expect(modals).toHaveCount(0, { timeout: 30_000 });
        expect(await page.evaluate(
            () => [...((window as any).__jcMultiModalProof.proof as string[])]
        )).toEqual(['inner', 'outer']);

        await page.evaluate(() => history.back());
        await page.waitForFunction(
            () => (window as any).__jcMultiModalProof.arrivals.at(-1) === 'multi-route-a',
            undefined,
            { timeout: 30_000 }
        );
        await page.evaluate(() => history.forward());
        await page.waitForFunction(
            () => (window as any).__jcMultiModalProof.arrivals.at(-1) === 'multi-route-b',
            undefined,
            { timeout: 30_000 }
        );

        assertNoRuntimeErrors(consoleErrors);
    });

    test('full reload on a private marker retires it before the next real Back', async ({
        page,
        consoleErrors,
    }) => {
        await loginAs(page, 'admin', consoleErrors);
        await prepareModalRoute(page);

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
