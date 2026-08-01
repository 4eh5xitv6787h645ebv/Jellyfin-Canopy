import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAnyModalOpen } from '../core/modal-a11y';
import { JC } from '../globals';
import { installSeerrModal } from './modal';

const HISTORY_STATE_KEY = '__jellyfinCanopySeerrModal';
const HISTORY_LEDGER_KEY = 'jellyfin-canopy:seerr-modal-history:v2';
const HISTORY_GLOBAL_KEY = '__jellyfinCanopySeerrModalHistoryOwnerV2';

interface TestHistoryMarker {
    owner: 'jellyfin-canopy/seerr-modal';
    version: 2;
    token: string;
    hostState: unknown;
    traversal: 'terminal' | 'bidirectional';
    nextDirection: 'back' | 'forward';
    hostNavigationKey?: string;
}

interface ShownModal {
    handle: ReturnType<NonNullable<typeof JC.seerrModal>['create']>;
    modalState: Record<string, unknown>;
    baseState: unknown;
    marker: TestHistoryMarker;
}

interface TestHistoryOwner {
    listener: EventListener | null;
    records: Map<string, unknown>;
    knownTokens: string[];
    pendingBidirectional: Map<string, 'back' | 'forward'>;
    pendingBaseExit: {
        token: string;
        nextDirectionAfterBack: 'forward' | null;
        releaseReplaceStateWatch?: (() => void) | null;
    } | null;
    pendingOwnedTraversal: {
        token: string;
        phase: 'queued' | 'issued' | 'superseded-queued' | 'superseded-issued' | 'superseded-reactive-push' | 'recovering-forward';
        hostState: unknown;
        hostHref: string;
        recoveringMarkerCrossed: boolean;
    } | null;
    adoptionToken: string | null;
    historyObserver: ((mutation: {
        source: 'pushState' | 'replaceState' | 'HISTORY_UPDATE';
        state: unknown;
        href: string;
        action?: 'PUSH' | 'REPLACE' | 'POP';
        entryKey?: string;
    }) => void) | null;
}

function historyOwnerForTest(): TestHistoryOwner | undefined {
    return (window as unknown as Record<string, TestHistoryOwner | undefined>)[HISTORY_GLOBAL_KEY];
}

function markerOf(state: unknown): TestHistoryMarker | null {
    if (state === null || typeof state !== 'object') return null;
    return ((state as Record<string, unknown>)[HISTORY_STATE_KEY] as TestHistoryMarker | undefined) ?? null;
}

function dispatchPop(state: unknown, href = location.href): void {
    // close() intentionally defers its Back until the current JS task ends so
    // a same-task host write can win ownership without being traversed over.
    vi.advanceTimersByTime(0);
    // A real traversal changes the active entry inside the browser. Bypass
    // instance-level replaceState observers when modelling that transition.
    History.prototype.replaceState.call(history, state, '', href);
    window.dispatchEvent(new PopStateEvent('popstate', { state }));
}

function withWindowEvent<T>(event: Event, run: () => T): T {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'event');
    Object.defineProperty(window, 'event', { configurable: true, value: event });
    try {
        return run();
    } finally {
        if (descriptor) Object.defineProperty(window, 'event', descriptor);
        else Reflect.deleteProperty(window, 'event');
    }
}

function installObservedReplaceState(owner: TestHistoryOwner): () => void {
    const descriptor = Object.getOwnPropertyDescriptor(history, 'replaceState');
    const wrapped = function(
        this: History,
        data: unknown,
        unused: string,
        url?: string | URL | null
    ): void {
        const before = location.href;
        History.prototype.replaceState.call(this, data, unused, url);
        owner.historyObserver?.({
            source: 'replaceState',
            action: 'REPLACE',
            state: history.state,
            href: location.href,
        });
        if (location.href !== before) window.dispatchEvent(new Event('jc:navigate'));
    };
    Object.defineProperty(history, 'replaceState', {
        configurable: true,
        writable: true,
        value: wrapped,
    });
    return () => {
        if (descriptor) Object.defineProperty(history, 'replaceState', descriptor);
        else Reflect.deleteProperty(history, 'replaceState');
    };
}

function baseFor(modalState: Record<string, unknown>): unknown {
    const marker = markerOf(modalState);
    if (!marker) throw new Error('expected a tagged modal history state');
    return marker.hostState;
}

describe('Seerr request modal history ownership', () => {
    let uninstall: () => void;

    beforeEach(() => {
        vi.useFakeTimers();
        document.body.replaceChildren();
        document.body.className = '';
        sessionStorage.removeItem(HISTORY_LEDGER_KEY);
        history.replaceState(
            { host: 'details', nested: { itemId: 'history-owner' } },
            '',
            '/web/index.html?layout=modern#/details?id=history-owner'
        );
        JC.t = (key: string) => key;
        JC.identity.transition('history-server', 'history-user', 'history test setup');
        uninstall = installSeerrModal();
    });

    afterEach(() => {
        // A failed assertion must not strand modal-a11y state in this worker.
        JC.seerrModal?.closeAll();
        const marker = markerOf(history.state);
        if (marker) dispatchPop(marker.hostState);
        uninstall();
        vi.runAllTimers();
        const owner = historyOwnerForTest();
        owner?.records?.clear?.();
        if (owner) {
            owner.knownTokens = [];
            owner.pendingBidirectional?.clear?.();
            owner.pendingBaseExit?.releaseReplaceStateWatch?.();
            owner.pendingBaseExit = null;
            owner.pendingOwnedTraversal = null;
            (owner as TestHistoryOwner & { markerPopPushWinner?: unknown }).markerPopPushWinner = null;
            owner.adoptionToken = null;
        }
        sessionStorage.removeItem(HISTORY_LEDGER_KEY);
        vi.useRealTimers();
        vi.restoreAllMocks();
        document.body.replaceChildren();
        document.body.className = '';
    });

    function showModal(onClose = vi.fn()): ShownModal {
        const handle = JC.seerrModal!.create({
            title: 'Request movie',
            subtitle: 'History owner',
            bodyHtml: '<p>Request options</p>',
            onSave: vi.fn(),
            onClose,
        });
        handle.show();
        const currentState: unknown = history.state;
        const modalState = currentState as Record<string, unknown>;
        const marker = markerOf(modalState);
        if (!marker) throw new Error('show() did not publish a modal marker');
        return { handle, modalState, baseState: baseFor(modalState), marker };
    }

    function observeCurrentHistoryMutation(
        source: 'pushState' | 'replaceState' | 'HISTORY_UPDATE' = 'pushState',
        action?: 'PUSH' | 'REPLACE' | 'POP',
        entryKey?: string
    ): void {
        historyOwnerForTest()?.historyObserver?.({
            source,
            state: history.state,
            href: location.href,
            ...(action ? { action } : {}),
            ...(entryKey ? { entryKey } : {}),
        });
    }

    it('programmatic success close consumes only its tagged entry and restores host state, URL, a11y, and focus', () => {
        const originalState: unknown = history.state;
        const originalHref = location.href;
        const trigger = document.createElement('button');
        document.body.appendChild(trigger);
        trigger.focus();
        const onClose = vi.fn();
        const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
        const shown = showModal(onClose);

        expect(shown.modalState).toMatchObject({ host: 'details' });
        expect(shown.marker.hostState).toEqual(originalState);
        expect(location.href).toBe(originalHref);
        expect(isAnyModalOpen()).toBe(true);

        shown.handle.close();
        shown.handle.close();
        vi.advanceTimersByTime(0);
        expect(back).toHaveBeenCalledTimes(1);
        expect(onClose).not.toHaveBeenCalled();

        dispatchPop(shown.baseState, originalHref);
        vi.advanceTimersByTime(300);

        expect(history.state).toEqual(originalState);
        expect(location.href).toBe(originalHref);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(shown.handle.modalElement.isConnected).toBe(false);
        expect(isAnyModalOpen()).toBe(false);
        expect(document.body.classList.contains('seerr-modal-is-open')).toBe(false);
        expect(document.body.classList.contains('jc-modal-open')).toBe(false);
        expect(document.activeElement).toBe(trigger);
    });

    it.each(['cancel', 'backdrop', 'escape'] as const)(
        '%s uses the same one-shot owned-entry close path',
        (trigger) => {
            const onClose = vi.fn();
            const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
            const shown = showModal(onClose);

            if (trigger === 'cancel') {
                shown.handle.modalElement
                    .querySelector<HTMLButtonElement>('.seerr-modal-button-secondary')!
                    .click();
            } else if (trigger === 'backdrop') {
                shown.handle.modalElement.click();
            } else {
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            }

            vi.advanceTimersByTime(0);
            expect(back).toHaveBeenCalledTimes(1);
            dispatchPop(shown.baseState);
            dispatchPop(shown.baseState); // duplicate/stale pop cannot double-close
            expect(onClose).toHaveBeenCalledTimes(1);
            expect(isAnyModalOpen()).toBe(false);
        }
    );

    it('browser Back closes from the base pop without recursively going Back again', () => {
        const onClose = vi.fn();
        const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
        const shown = showModal(onClose);

        dispatchPop(shown.baseState);

        expect(back).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(isAnyModalOpen()).toBe(false);
    });

    it('keeps transient modal-marker pops private from the host router', () => {
        const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
        const shown = showModal();
        const hostRouter = vi.fn();
        window.addEventListener('popstate', hostRouter);

        try {
            dispatchPop(shown.modalState);
            expect(back).toHaveBeenCalledTimes(1);
            expect(hostRouter).not.toHaveBeenCalled();
        } finally {
            window.removeEventListener('popstate', hostRouter);
        }
    });

    it('retags a transient marker that an earlier host router replaced', () => {
        const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
        const shown = showModal();

        // event.state is the immutable traversal snapshot, while history.state
        // reflects a host listener that already replaced the current entry.
        history.replaceState({ usr: null, key: 'host-router-key' }, '', location.href);
        window.dispatchEvent(new PopStateEvent('popstate', { state: shown.modalState }));

        expect(back).toHaveBeenCalledTimes(1);
        expect(markerOf(history.state)).toMatchObject({
            token: shown.marker.token,
        });
    });

    it.each(['back', 'forward'] as const)(
        'lets a synchronous router PUSH win an ordinary retired-marker %s pop',
        (direction) => {
            const routeAState: unknown = history.state;
            const routeAHref = location.href;
            const owner = historyOwnerForTest()!;
            if (owner.listener) window.removeEventListener('popstate', owner.listener, true);
            owner.listener = null;
            let targetToken = '';
            let pushEnabled = false;
            let pushed = false;
            const routeGState = { host: `sync-marker-push-${direction}` };
            const routeGHref = `/web/index.html#/sync-marker-push-${direction}`;
            const earlierRouter = (event: PopStateEvent) => {
                if (!pushEnabled || pushed || markerOf(event.state)?.token !== targetToken) return;
                pushed = true;
                withWindowEvent(event, () => {
                    History.prototype.pushState.call(history, routeGState, '', routeGHref);
                    owner.historyObserver?.({
                        source: 'pushState',
                        action: 'PUSH',
                        state: history.state,
                        href: location.href,
                    });
                });
            };
            const laterRouter = vi.fn();
            window.addEventListener('popstate', earlierRouter, { capture: true });
            uninstall();
            uninstall = installSeerrModal();
            window.addEventListener('popstate', laterRouter);
            const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
            const forward = vi.spyOn(history, 'forward').mockImplementation(() => undefined);
            const shown = showModal();
            targetToken = shown.marker.token;

            try {
                shown.handle.close();
                history.pushState(
                    { host: `sync-marker-route-b-${direction}` },
                    '',
                    `/web/index.html#/sync-marker-route-b-${direction}`
                );
                const routeBState: unknown = history.state;
                const routeBHref = location.href;
                vi.advanceTimersByTime(0);

                let markerForCrossing: unknown = shown.modalState;
                if (direction === 'forward') {
                    dispatchPop(shown.modalState, routeAHref);
                    markerForCrossing = history.state;
                    dispatchPop(routeAState, routeAHref);
                    laterRouter.mockClear();
                }

                pushEnabled = true;
                dispatchPop(markerForCrossing, routeAHref);

                expect(history.state).toEqual(routeGState);
                expect(location.href).toBe(new URL(routeGHref, location.origin).href);
                expect(historyOwnerForTest()?.pendingOwnedTraversal).toBeNull();
                expect(laterRouter).not.toHaveBeenCalled();

                // G owns the newer side. A later Back/Forward pair crosses only
                // the still-private marker and never exposes its stale event.
                dispatchPop(markerForCrossing, routeAHref);
                const markerTowardForward: unknown = history.state;
                dispatchPop(routeAState, routeAHref);
                expect(laterRouter).toHaveBeenCalledTimes(1);
                dispatchPop(markerTowardForward, routeAHref);
                dispatchPop(routeGState, routeGHref);
                expect(laterRouter.mock.calls.map(([event]) => (event as PopStateEvent).state)).toEqual([
                    routeAState,
                    routeGState,
                ]);
                expect(back).toHaveBeenCalled();
                expect(forward).toHaveBeenCalled();
                expect(history.state).toEqual(routeGState);
                expect(routeBState).not.toEqual(routeGState);
                expect(routeBHref).not.toBe(routeGHref);
            } finally {
                window.removeEventListener('popstate', earlierRouter, { capture: true });
                window.removeEventListener('popstate', laterRouter);
            }
        }
    );

    it('a synchronous PUSH from a reached inner marker closes only that modal', () => {
        const owner = historyOwnerForTest()!;
        if (owner.listener) window.removeEventListener('popstate', owner.listener, true);
        owner.listener = null;
        let innerToken = '';
        const earlierRouter = (event: PopStateEvent) => {
            if (markerOf(event.state)?.token !== innerToken) return;
            withWindowEvent(event, () => {
                History.prototype.pushState.call(
                    history,
                    { host: 'nested-marker-push-winner' },
                    '',
                    '/web/index.html#/nested-marker-push-winner'
                );
                owner.historyObserver?.({
                    source: 'pushState',
                    action: 'PUSH',
                    state: history.state,
                    href: location.href,
                });
            });
        };
        const laterRouter = vi.fn();
        window.addEventListener('popstate', earlierRouter, { capture: true });
        uninstall();
        uninstall = installSeerrModal();
        window.addEventListener('popstate', laterRouter);
        const outerClose = vi.fn();
        const innerClose = vi.fn();
        const outer = showModal(outerClose);
        const inner = showModal(innerClose);
        innerToken = inner.marker.token;

        try {
            history.pushState(
                { host: 'nested-marker-route-b' },
                '',
                '/web/index.html#/nested-marker-route-b'
            );
            dispatchPop(inner.modalState);

            expect(innerClose).toHaveBeenCalledTimes(1);
            expect(outerClose).not.toHaveBeenCalled();
            expect(inner.handle.modalElement.classList.contains('show')).toBe(false);
            expect(outer.handle.modalElement.isConnected).toBe(true);
            expect(historyOwnerForTest()?.records.size).toBe(1);
            expect(historyOwnerForTest()?.records.has(outer.marker.token)).toBe(true);
            expect(history.state).toEqual({ host: 'nested-marker-push-winner' });
            expect(laterRouter).not.toHaveBeenCalled();
        } finally {
            window.removeEventListener('popstate', earlierRouter, { capture: true });
            window.removeEventListener('popstate', laterRouter);
        }
    });

    it.each([
        ['back', 'setTimeout', 'drop'],
        ['back', 'MessageChannel', 'drop'],
        ['back', 'requestAnimationFrame', 'drop'],
        ['forward', 'setTimeout', 'drop'],
        ['forward', 'MessageChannel', 'drop'],
        ['forward', 'requestAnimationFrame', 'drop'],
        ['back', 'setTimeout', 'copy'],
        ['forward', 'setTimeout', 'copy'],
    ] as const)(
        'restores a deferred %s marker %s rewrite while that marker remains current (%s marker)',
        async (direction, channel, replacementShape) => {
            const routeAState: unknown = history.state;
            const routeAHref = location.href;
            const owner = historyOwnerForTest()!;
            if (owner.listener) window.removeEventListener('popstate', owner.listener, true);
            owner.listener = null;
            let targetToken = '';
            let rewriteEnabled = false;
            let rewriteScheduled = false;
            let rewriteSettled = Promise.resolve();
            const messageChannels: MessageChannel[] = [];
            const earlierRouter = (event: PopStateEvent) => {
                if (!rewriteEnabled
                    || rewriteScheduled
                    || markerOf(event.state)?.token !== targetToken) return;
                rewriteScheduled = true;
                rewriteSettled = new Promise<void>((resolve) => {
                    const rewrite = () => {
                        const replacement = replacementShape === 'copy'
                            ? { ...(event.state as Record<string, unknown>), hostRewrite: channel }
                            : { host: `ghost-${direction}-${channel}` };
                        history.replaceState(
                            replacement,
                            '',
                            `/web/index.html#/ghost-${direction}-${channel}`
                        );
                        for (const pendingChannel of messageChannels.splice(0)) {
                            pendingChannel.port1.close();
                            pendingChannel.port2.close();
                        }
                        resolve();
                    };
                    if (channel === 'setTimeout') {
                        setTimeout(rewrite, 0);
                    } else if (channel === 'MessageChannel') {
                        const pendingChannel = new MessageChannel();
                        messageChannels.push(pendingChannel);
                        pendingChannel.port1.addEventListener('message', rewrite, { once: true });
                        pendingChannel.port1.start();
                        pendingChannel.port2.postMessage(undefined);
                    } else if (typeof window.requestAnimationFrame === 'function') {
                        window.requestAnimationFrame(rewrite);
                    } else {
                        setTimeout(rewrite, 16);
                    }
                });
            };
            const laterRouter = vi.fn();
            const navigate = vi.fn();
            const releaseReplace = installObservedReplaceState(owner);
            window.addEventListener('jc:navigate', navigate);
            window.addEventListener('popstate', earlierRouter, { capture: true });
            uninstall();
            uninstall = installSeerrModal();
            window.addEventListener('popstate', laterRouter);
            vi.spyOn(history, 'back').mockImplementation(() => undefined);
            vi.spyOn(history, 'forward').mockImplementation(() => undefined);
            const shown = showModal();
            targetToken = shown.marker.token;

            try {
                shown.handle.close();
                history.pushState(
                    { host: `deferred-marker-route-b-${direction}-${channel}` },
                    '',
                    `/web/index.html#/deferred-marker-route-b-${direction}-${channel}`
                );
                const routeBState: unknown = history.state;
                const routeBHref = location.href;
                vi.advanceTimersByTime(0);

                let markerForCrossing: unknown = shown.modalState;
                if (direction === 'forward') {
                    dispatchPop(shown.modalState, routeAHref);
                    markerForCrossing = history.state;
                    dispatchPop(routeAState, routeAHref);
                    laterRouter.mockClear();
                }

                rewriteEnabled = true;
                navigate.mockClear();
                dispatchPop(markerForCrossing, routeAHref);
                const expectedMarker = markerOf(history.state);
                expect(expectedMarker?.token).toBe(shown.marker.token);
                if (channel === 'setTimeout') {
                    await vi.advanceTimersByTimeAsync(0);
                } else if (channel === 'requestAnimationFrame') {
                    await vi.advanceTimersByTimeAsync(16);
                }
                await rewriteSettled;

                expect(markerOf(history.state)).toEqual(expectedMarker);
                expect(location.href).toBe(routeAHref);
                expect(navigate).not.toHaveBeenCalled();
                const restoredMarkerState: unknown = history.state;
                expect(laterRouter).not.toHaveBeenCalled();
                if (direction === 'back') {
                    dispatchPop(routeAState, routeAHref);
                } else {
                    dispatchPop(routeBState, routeBHref);
                }
                expect(historyOwnerForTest()?.pendingOwnedTraversal).toBeNull();

                if (direction === 'back') {
                    dispatchPop(restoredMarkerState, routeAHref);
                    dispatchPop(routeBState, routeBHref);
                    expect(history.state).toEqual(routeBState);
                } else {
                    dispatchPop(restoredMarkerState, routeAHref);
                    dispatchPop(routeAState, routeAHref);
                    expect(history.state).toEqual(routeAState);
                }
                expect(laterRouter.mock.calls.every(
                    ([event]) => markerOf((event as PopStateEvent).state) === null
                )).toBe(true);
            } finally {
                for (const pendingChannel of messageChannels) {
                    pendingChannel.port1.close();
                    pendingChannel.port2.close();
                }
                window.removeEventListener('popstate', earlierRouter, { capture: true });
                window.removeEventListener('popstate', laterRouter);
                window.removeEventListener('jc:navigate', navigate);
                releaseReplace();
            }
        }
    );

    it.each(['back', 'forward'] as const)(
        'recovers an async router PUSH that supersedes a retired-marker %s traversal',
        (direction) => {
            const routeAState: unknown = history.state;
            const routeAHref = location.href;
            const owner = historyOwnerForTest()!;
            if (owner.listener) window.removeEventListener('popstate', owner.listener, true);
            owner.listener = null;
            let targetToken = '';
            let pushEnabled = false;
            let pushScheduled = false;
            const routeGState = { host: `async-marker-push-${direction}` };
            const routeGHref = `/web/index.html#/async-marker-push-${direction}`;
            const earlierRouter = (event: PopStateEvent) => {
                if (!pushEnabled
                    || pushScheduled
                    || markerOf(event.state)?.token !== targetToken) return;
                pushScheduled = true;
                setTimeout(() => {
                    History.prototype.pushState.call(history, routeGState, '', routeGHref);
                    owner.historyObserver?.({
                        source: 'pushState',
                        action: 'PUSH',
                        state: history.state,
                        href: location.href,
                    });
                }, 0);
            };
            const laterRouter = vi.fn();
            window.addEventListener('popstate', earlierRouter, { capture: true });
            uninstall();
            uninstall = installSeerrModal();
            window.addEventListener('popstate', laterRouter);
            vi.spyOn(history, 'back').mockImplementation(() => undefined);
            const go = vi.spyOn(history, 'go').mockImplementation(() => undefined);
            const forward = vi.spyOn(history, 'forward').mockImplementation(() => undefined);
            const shown = showModal();
            targetToken = shown.marker.token;

            try {
                shown.handle.close();
                history.pushState(
                    { host: `async-marker-route-b-${direction}` },
                    '',
                    `/web/index.html#/async-marker-route-b-${direction}`
                );
                vi.advanceTimersByTime(0);

                let markerForCrossing: unknown = shown.modalState;
                if (direction === 'forward') {
                    dispatchPop(shown.modalState, routeAHref);
                    markerForCrossing = history.state;
                    dispatchPop(routeAState, routeAHref);
                    laterRouter.mockClear();
                }

                pushEnabled = true;
                dispatchPop(markerForCrossing, routeAHref);
                const markerAfterIssue: unknown = history.state;
                expect(historyOwnerForTest()?.pendingOwnedTraversal?.phase).toBe('issued');
                vi.advanceTimersByTime(0);

                expect(history.state).toEqual(routeGState);
                if (direction === 'forward') {
                    // PUSH from the current marker truncates the complete
                    // Forward chain, so G is already the stable winner and no
                    // owned pop can arrive to settle the transaction.
                    expect(historyOwnerForTest()?.pendingOwnedTraversal).toBeNull();
                    expect(go).not.toHaveBeenCalled();
                    history.go(-2);
                    dispatchPop(routeAState, routeAHref);
                    dispatchPop(markerAfterIssue, routeAHref);
                    dispatchPop(routeGState, routeGHref);
                    expect(history.state).toEqual(routeGState);
                    expect(historyOwnerForTest()?.pendingOwnedTraversal).toBeNull();
                    expect(forward).toHaveBeenCalled();
                    expect(laterRouter.mock.calls.map(
                        ([event]) => (event as PopStateEvent).state
                    )).toEqual([routeAState, routeGState]);
                    return;
                }
                expect(historyOwnerForTest()?.pendingOwnedTraversal?.phase).toBe('superseded-issued');
                expect(go).toHaveBeenCalledWith(-2);

                // The exact classic handshake reaches A, then returns through
                // the retained M to the PUSH winner G in both crossing directions.
                dispatchPop(routeAState, routeAHref);
                expect(historyOwnerForTest()?.pendingOwnedTraversal?.phase).toBe('recovering-forward');
                dispatchPop(markerAfterIssue, routeAHref);
                const markerAfterRecovery: unknown = history.state;
                dispatchPop(routeGState, routeGHref);
                expect(historyOwnerForTest()?.pendingOwnedTraversal).toBeNull();
                expect(laterRouter.mock.calls.map(([event]) => (event as PopStateEvent).state)).toEqual([
                    routeGState,
                ]);

                history.go(-2);
                dispatchPop(routeAState, routeAHref);
                dispatchPop(markerAfterRecovery, routeAHref);
                dispatchPop(routeGState, routeGHref);
                expect(history.state).toEqual(routeGState);
                expect(historyOwnerForTest()?.pendingOwnedTraversal).toBeNull();
                expect(forward).toHaveBeenCalled();
            } finally {
                window.removeEventListener('popstate', earlierRouter, { capture: true });
                window.removeEventListener('popstate', laterRouter);
            }
        }
    );

    it('quarantines a copied marker rewrite after Forward already reached its host target', async () => {
        const routeAState: unknown = history.state;
        const routeAHref = location.href;
        const owner = historyOwnerForTest()!;
        if (owner.listener) window.removeEventListener('popstate', owner.listener, true);
        owner.listener = null;
        let targetToken = '';
        let rewriteEnabled = false;
        let rewriteRuns = 0;
        const earlierRouter = (event: PopStateEvent) => {
            if (!rewriteEnabled
                || rewriteRuns > 0
                || markerOf(event.state)?.token !== targetToken) return;
            rewriteRuns += 1;
            window.requestAnimationFrame(() => {
                history.replaceState(
                    { ...(event.state as Record<string, unknown>), copiedAfterFrame: true },
                    '',
                    '/web/index.html#/copied-marker-after-forward'
                );
            });
        };
        const laterRouter = vi.fn();
        const navigate = vi.fn();
        const releaseReplace = installObservedReplaceState(owner);
        window.addEventListener('jc:navigate', navigate);
        window.addEventListener('popstate', earlierRouter, { capture: true });
        uninstall();
        uninstall = installSeerrModal();
        window.addEventListener('popstate', laterRouter);
        vi.spyOn(history, 'back').mockImplementation(() => undefined);
        const forward = vi.spyOn(history, 'forward').mockImplementation(() => undefined);
        const shown = showModal();
        targetToken = shown.marker.token;

        try {
            shown.handle.close();
            history.pushState(
                { host: 'copied-marker-target-b' },
                '',
                '/web/index.html#/copied-marker-target-b'
            );
            const routeBState: unknown = history.state;
            const routeBHref = location.href;
            vi.advanceTimersByTime(0);

            dispatchPop(shown.modalState, routeAHref);
            const markerTowardA: unknown = history.state;
            dispatchPop(routeAState, routeAHref);
            laterRouter.mockClear();

            rewriteEnabled = true;
            dispatchPop(markerTowardA, routeAHref);
            const markerTowardB: unknown = history.state;
            expect(historyOwnerForTest()?.pendingOwnedTraversal?.phase).toBe('issued');

            // Chromium can complete the queued Forward before the frame that
            // an earlier marker listener scheduled. The later copied marker
            // must not replace the already-current real B entry.
            dispatchPop(routeBState, routeBHref);
            expect(historyOwnerForTest()?.pendingOwnedTraversal).toBeNull();
            navigate.mockClear();
            await vi.advanceTimersByTimeAsync(16);

            expect(rewriteRuns).toBe(1);
            expect(history.state).toEqual(routeBState);
            expect(location.href).toBe(routeBHref);
            expect(markerOf(history.state)).toBeNull();
            expect(navigate).not.toHaveBeenCalled();
            expect(laterRouter.mock.calls.map(
                ([event]) => (event as PopStateEvent).state
            )).toEqual([routeBState]);

            history.go(-2);
            dispatchPop(routeAState, routeAHref);
            dispatchPop(markerTowardB, routeAHref);
            dispatchPop(routeBState, routeBHref);
            expect(history.state).toEqual(routeBState);
            expect(historyOwnerForTest()?.pendingOwnedTraversal).toBeNull();
            expect(forward).toHaveBeenCalled();
        } finally {
            window.removeEventListener('jc:navigate', navigate);
            releaseReplace();
            window.removeEventListener('popstate', earlierRouter, { capture: true });
            window.removeEventListener('popstate', laterRouter);
        }
    });

    it('settles an async PUSH that truncates an issued retired-marker Forward target', () => {
        const originalNavigation = Object.getOwnPropertyDescriptor(window, 'navigation');
        const navigation = { currentEntry: { key: 'async-forward-route-a' } };
        Object.defineProperty(window, 'navigation', {
            configurable: true,
            value: navigation,
        });
        const routeAState: unknown = history.state;
        const routeAHref = location.href;
        const owner = historyOwnerForTest()!;
        if (owner.listener) window.removeEventListener('popstate', owner.listener, true);
        owner.listener = null;
        let targetToken = '';
        let pushEnabled = false;
        let pushScheduled = false;
        const routeGState = { host: 'async-forward-route-g' };
        const routeGHref = '/web/index.html#/async-forward-route-g';
        const earlierRouter = (event: PopStateEvent) => {
            if (!pushEnabled
                || pushScheduled
                || markerOf(event.state)?.token !== targetToken) return;
            pushScheduled = true;
            setTimeout(() => {
                History.prototype.pushState.call(history, routeGState, '', routeGHref);
                navigation.currentEntry.key = 'async-forward-route-g';
                owner.historyObserver?.({
                    source: 'pushState',
                    action: 'PUSH',
                    state: history.state,
                    href: location.href,
                });
            }, 0);
        };
        const laterRouter = vi.fn();
        window.addEventListener('popstate', earlierRouter, { capture: true });
        uninstall();
        uninstall = installSeerrModal();
        window.addEventListener('popstate', laterRouter);
        vi.spyOn(history, 'back').mockImplementation(() => undefined);
        const go = vi.spyOn(history, 'go').mockImplementation(() => undefined);
        const forward = vi.spyOn(history, 'forward').mockImplementation(() => undefined);

        try {
            const shown = showModal();
            targetToken = shown.marker.token;
            navigation.currentEntry.key = 'async-forward-modal-marker';
            shown.handle.close();
            History.prototype.pushState.call(
                history,
                { host: 'async-forward-route-b' },
                '',
                '/web/index.html#/async-forward-route-b'
            );
            navigation.currentEntry.key = 'async-forward-route-b';
            owner.historyObserver?.({
                source: 'pushState',
                action: 'PUSH',
                state: history.state,
                href: location.href,
            });
            vi.advanceTimersByTime(0);

            navigation.currentEntry.key = 'async-forward-modal-marker';
            dispatchPop(shown.modalState, routeAHref);
            const markerTowardA: unknown = history.state;
            navigation.currentEntry.key = 'async-forward-route-a';
            dispatchPop(routeAState, routeAHref);
            laterRouter.mockClear();

            pushEnabled = true;
            navigation.currentEntry.key = 'async-forward-modal-marker';
            dispatchPop(markerTowardA, routeAHref);
            const markerTowardG: unknown = history.state;
            expect(historyOwnerForTest()?.pendingOwnedTraversal?.phase).toBe('issued');
            vi.advanceTimersByTime(0);

            expect(history.state).toEqual(routeGState);
            expect(location.href).toBe(new URL(routeGHref, location.origin).href);
            expect(historyOwnerForTest()?.pendingOwnedTraversal).toBeNull();
            expect(go).not.toHaveBeenCalled();
            expect(laterRouter).not.toHaveBeenCalled();

            history.go(-2);
            navigation.currentEntry.key = 'async-forward-route-a';
            dispatchPop(routeAState, routeAHref);
            navigation.currentEntry.key = 'async-forward-modal-marker';
            dispatchPop(markerTowardG, routeAHref);
            navigation.currentEntry.key = 'async-forward-route-g';
            dispatchPop(routeGState, routeGHref);

            expect(history.state).toEqual(routeGState);
            expect(historyOwnerForTest()?.pendingOwnedTraversal).toBeNull();
            expect(forward).toHaveBeenCalled();
            expect(laterRouter.mock.calls.map(
                ([event]) => (event as PopStateEvent).state
            )).toEqual([routeAState, routeGState]);
        } finally {
            window.removeEventListener('popstate', earlierRouter, { capture: true });
            window.removeEventListener('popstate', laterRouter);
            if (originalNavigation) {
                Object.defineProperty(window, 'navigation', originalNavigation);
            } else {
                Reflect.deleteProperty(window, 'navigation');
            }
        }
    });

    it('a popstate-versus-success race closes once and never consumes the preceding route', () => {
        const onClose = vi.fn();
        const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
        const shown = showModal(onClose);

        dispatchPop(shown.baseState);
        shown.handle.close();
        dispatchPop(shown.baseState);

        expect(back).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(isAnyModalOpen()).toBe(false);
    });

    it('identity reset retires controls synchronously while its pending Back restores history once', () => {
        const onClose = vi.fn();
        const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
        const forward = vi.spyOn(history, 'forward').mockImplementation(() => undefined);
        const shown = showModal(onClose);

        JC.identity.transition('history-server-b', 'history-user-b', 'account switch');
        vi.advanceTimersByTime(0);

        expect(back).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(shown.handle.modalElement.isConnected).toBe(false);
        expect(isAnyModalOpen()).toBe(false);

        dispatchPop(shown.baseState);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(back).toHaveBeenCalledTimes(1);
        expect(historyOwnerForTest()?.knownTokens).not.toContain(shown.marker.token);
        expect(historyOwnerForTest()?.pendingBidirectional.has(shown.marker.token)).toBe(false);

        // Reinstalling at the base must not promote the terminal forward entry.
        // Every later Forward encounter remains a one-way bounce to the base.
        uninstall();
        uninstall = installSeerrModal();
        dispatchPop(shown.modalState);
        expect(back).toHaveBeenCalledTimes(2);
        dispatchPop(shown.baseState);
        dispatchPop(shown.modalState);
        expect(back).toHaveBeenCalledTimes(3);
        expect(forward).not.toHaveBeenCalled();
    });

    it('closeAll retires controls synchronously when a user close already has Back pending', () => {
        const onClose = vi.fn();
        const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
        const shown = showModal(onClose);

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(back).not.toHaveBeenCalled();
        expect(shown.handle.modalElement.isConnected).toBe(true);

        JC.seerrModal!.closeAll();
        vi.advanceTimersByTime(0);

        expect(back).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(shown.handle.modalElement.isConnected).toBe(false);
        expect(isAnyModalOpen()).toBe(false);
        expect(historyOwnerForTest()?.knownTokens).not.toContain(shown.marker.token);
        expect(historyOwnerForTest()?.pendingBidirectional.has(shown.marker.token)).toBe(false);
        dispatchPop(shown.baseState);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(back).toHaveBeenCalledTimes(1);
    });

    it('identity teardown upgrades an already-settled animated close to synchronous removal', () => {
        const onClose = vi.fn();
        const shown = showModal(onClose);

        // The owned history entry has settled, so interaction/a11y ownership is
        // already released while the visual 300 ms removal remains pending.
        dispatchPop(shown.baseState);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(shown.handle.modalElement.isConnected).toBe(true);
        expect(isAnyModalOpen()).toBe(false);

        JC.identity.transition('history-server-b', 'history-user-b', 'account switch');

        expect(shown.handle.modalElement.isConnected).toBe(false);
        expect(document.body.classList.contains('seerr-modal-is-open')).toBe(false);
        expect(onClose).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(300);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('closeAll drains nested retired entries without closing an unrelated route', () => {
        const originalState: unknown = history.state;
        const originalHref = location.href;
        const firstClose = vi.fn();
        const secondClose = vi.fn();
        const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
        const first = showModal(firstClose);
        const second = showModal(secondClose);

        JC.seerrModal!.closeAll();
        vi.advanceTimersByTime(0);

        expect(back).toHaveBeenCalledTimes(1);
        expect(firstClose).toHaveBeenCalledTimes(1);
        expect(secondClose).toHaveBeenCalledTimes(1);
        expect(isAnyModalOpen()).toBe(false);

        dispatchPop(second.baseState, originalHref);
        expect(back).toHaveBeenCalledTimes(2);
        dispatchPop(first.baseState, originalHref);

        expect(history.state).toEqual(originalState);
        expect(firstClose).toHaveBeenCalledTimes(1);
        expect(secondClose).toHaveBeenCalledTimes(1);
        expect(back).toHaveBeenCalledTimes(2);
    });

    it('keeps nested retired markers directionally aligned between routes A and B', () => {
        const originalState: unknown = history.state;
        const originalHref = location.href;
        const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
        const forward = vi.spyOn(history, 'forward').mockImplementation(() => undefined);
        const first = showModal();
        const second = showModal();
        history.pushState({ host: 'newer-route' }, '', '/web/index.html#/newer');
        const newerState: unknown = history.state;
        const newerHref = location.href;

        JC.seerrModal!.closeAll();
        expect(back).not.toHaveBeenCalled();

        // One user Back from B starts a complete drain through both retired
        // markers and lands on A.
        dispatchPop(second.modalState, originalHref);
        const promotedSecondState: unknown = history.state;
        dispatchPop(second.baseState, originalHref);
        const promotedFirstState: unknown = history.state;
        dispatchPop(first.baseState, originalHref);
        expect(back).toHaveBeenCalledTimes(2);
        expect(history.state).toEqual(originalState);

        // One user Forward from A must automatically cross both markers and
        // reach B; neither marker may bounce backward because the closeAll
        // drain crossed it without a direct modal pop.
        dispatchPop(promotedFirstState, originalHref);
        expect(back).toHaveBeenCalledTimes(2);
        expect(forward).toHaveBeenCalledTimes(1);
        dispatchPop(promotedSecondState, originalHref);
        expect(forward).toHaveBeenCalledTimes(2);
        dispatchPop(newerState, newerHref);
        expect(history.state).toEqual(newerState);
        expect(location.href).toBe(newerHref);
    });

    it('keeps an externally retired outer modal traversable around a live inner modal', () => {
        const originalState: unknown = history.state;
        const originalHref = location.href;
        const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
        const forward = vi.spyOn(history, 'forward').mockImplementation(() => undefined);
        const outer = showModal();
        const inner = showModal();

        // Retire only the buried outer UI while the inner modal still owns the
        // current entry, then let a newer SPA route bury both modal pairs.
        outer.handle.close();
        vi.advanceTimersByTime(300);
        expect(inner.handle.modalElement.isConnected).toBe(true);
        history.pushState({ host: 'newer-route' }, '', '/web/index.html#/newer');
        const newerState: unknown = history.state;
        const newerHref = location.href;
        inner.handle.close();
        vi.advanceTimersByTime(300);
        expect(back).not.toHaveBeenCalled();

        // One Back traversal drains both retired entries to A.
        dispatchPop(inner.modalState, originalHref);
        const promotedInnerState: unknown = history.state;
        dispatchPop(inner.baseState, originalHref);
        const promotedOuterState: unknown = history.state;
        dispatchPop(outer.baseState, originalHref);
        expect(back).toHaveBeenCalledTimes(2);
        expect(history.state).toEqual(originalState);

        // One Forward traversal must cross both retired entries and recover B.
        dispatchPop(promotedOuterState, originalHref);
        dispatchPop(promotedInnerState, originalHref);
        dispatchPop(newerState, newerHref);
        expect(forward).toHaveBeenCalledTimes(2);
        expect(back).toHaveBeenCalledTimes(2);
        expect(history.state).toEqual(newerState);
        expect(location.href).toBe(newerHref);
    });

    it('closing an inner modal leaves its still-live outer modal in place', () => {
        const firstClose = vi.fn();
        const secondClose = vi.fn();
        const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
        const first = showModal(firstClose);
        const second = showModal(secondClose);

        second.handle.close();
        dispatchPop(second.baseState);
        vi.advanceTimersByTime(300);

        expect(back).toHaveBeenCalledTimes(1);
        expect(secondClose).toHaveBeenCalledTimes(1);
        expect(second.handle.modalElement.isConnected).toBe(false);
        expect(firstClose).not.toHaveBeenCalled();
        expect(first.handle.modalElement.isConnected).toBe(true);
        expect(history.state).toEqual(first.modalState);

        first.handle.close();
        dispatchPop(first.baseState);
        vi.advanceTimersByTime(300);
        expect(back).toHaveBeenCalledTimes(2);
        expect(firstClose).toHaveBeenCalledTimes(1);
    });

    it('one Escape closes only the topmost nested modal', () => {
        const outerClose = vi.fn();
        const innerClose = vi.fn();
        const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
        const outer = showModal(outerClose);
        const inner = showModal(innerClose);

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        vi.advanceTimersByTime(0);

        expect(back).toHaveBeenCalledTimes(1);
        expect(outerClose).not.toHaveBeenCalled();
        expect(innerClose).not.toHaveBeenCalled();
        dispatchPop(inner.baseState);
        vi.advanceTimersByTime(300);

        expect(innerClose).toHaveBeenCalledTimes(1);
        expect(outerClose).not.toHaveBeenCalled();
        expect(inner.handle.modalElement.isConnected).toBe(false);
        expect(outer.handle.modalElement.isConnected).toBe(true);
        expect(history.state).toEqual(outer.modalState);
        expect(isAnyModalOpen()).toBe(true);
        expect(document.body.classList.contains('jc-modal-open')).toBe(true);

        outer.handle.close();
        dispatchPop(outer.baseState);
        vi.advanceTimersByTime(300);
        expect(back).toHaveBeenCalledTimes(2);
        expect(outerClose).toHaveBeenCalledTimes(1);
        expect(isAnyModalOpen()).toBe(false);
    });

    it('skips a retired marker in both directions between real routes A and B', () => {
        const originalState: unknown = history.state;
        const originalHref = location.href;
        const onClose = vi.fn();
        const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
        const forward = vi.spyOn(history, 'forward').mockImplementation(() => undefined);
        const shown = showModal(onClose);

        history.pushState({ host: 'home' }, '', '/web/index.html#/home');
        const newerState: unknown = history.state;
        const newerHref = location.href;
        shown.handle.close();
        vi.advanceTimersByTime(300);

        expect(back).not.toHaveBeenCalled();
        expect(history.state).toEqual({ host: 'home' });
        expect(location.hash).toBe('#/home');
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(isAnyModalOpen()).toBe(false);

        // A later real Back first reaches the buried modal marker.  The
        // singleton owner skips exactly that marker, then restores its base.
        dispatchPop(shown.modalState, originalHref);
        const promotedModalState: unknown = history.state;
        expect(back).toHaveBeenCalledTimes(1);
        dispatchPop(shown.baseState, originalHref);

        expect(history.state).toEqual(originalState);
        expect(location.href).toBe(originalHref);
        expect(onClose).toHaveBeenCalledTimes(1);

        // Forward from A must pass the same retired marker toward B, rather
        // than bouncing backward and making the real newer route unreachable.
        dispatchPop(promotedModalState, originalHref);
        expect(back).toHaveBeenCalledTimes(1);
        expect(forward).toHaveBeenCalledTimes(1);
        dispatchPop(newerState, newerHref);

        expect(history.state).toEqual(newerState);
        expect(location.href).toBe(newerHref);
    });

    it('settles only M2 at its B base and preserves M1 between routes A and B', () => {
        const routeAState: unknown = history.state;
        const routeAHref = location.href;
        const firstClose = vi.fn();
        const secondClose = vi.fn();
        const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
        const forward = vi.spyOn(history, 'forward').mockImplementation(() => undefined);
        const first = showModal(firstClose);

        history.pushState({ host: 'route-b' }, '', '/web/index.html#/route-b-two-modals');
        observeCurrentHistoryMutation();
        const routeBState: unknown = history.state;
        const routeBHref = location.href;
        const second = showModal(secondClose);

        second.handle.close();
        vi.advanceTimersByTime(0);
        expect(back).toHaveBeenCalledTimes(1);
        dispatchPop(second.baseState, routeBHref);
        vi.advanceTimersByTime(300);

        expect(secondClose).toHaveBeenCalledTimes(1);
        expect(second.handle.modalElement.isConnected).toBe(false);
        expect(firstClose).not.toHaveBeenCalled();
        expect(first.handle.modalElement.isConnected).toBe(true);
        expect(history.state).toEqual(routeBState);

        // M1 is buried beneath B, so closing it is local and must not Back over B.
        first.handle.close();
        vi.advanceTimersByTime(0);
        expect(back).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(300);
        expect(firstClose).toHaveBeenCalledTimes(1);

        dispatchPop(first.modalState, routeAHref);
        const promotedFirstState: unknown = history.state;
        expect(back).toHaveBeenCalledTimes(2);
        dispatchPop(routeAState, routeAHref);
        expect(history.state).toEqual(routeAState);

        dispatchPop(promotedFirstState, routeAHref);
        expect(forward).toHaveBeenCalledTimes(1);
        dispatchPop(routeBState, routeBHref);
        expect(history.state).toEqual(routeBState);
        expect(location.href).toBe(routeBHref);
    });

    it('preserves directions when a direct multi-entry traversal skips a buried inner marker', () => {
        const routeAState: unknown = history.state;
        const routeAHref = location.href;
        const outerClose = vi.fn();
        const innerClose = vi.fn();
        const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
        const forward = vi.spyOn(history, 'forward').mockImplementation(() => undefined);
        const outer = showModal(outerClose);
        const inner = showModal(innerClose);
        history.pushState({ host: 'route-b' }, '', '/web/index.html#/route-b-multi-entry');
        observeCurrentHistoryMutation();
        const routeBState: unknown = history.state;
        const routeBHref = location.href;

        // Model B→outer via history.go(-2): the browser emits no event for the
        // crossed inner marker. Outer remains the live target; inner retires.
        dispatchPop(outer.modalState, routeAHref);
        expect(innerClose).toHaveBeenCalledTimes(1);
        expect(outerClose).not.toHaveBeenCalled();
        expect(inner.handle.modalElement.isConnected).toBe(true);
        expect(outer.handle.modalElement.isConnected).toBe(true);
        expect(historyOwnerForTest()?.pendingBidirectional.get(inner.marker.token)).toBe('forward');
        expect(historyOwnerForTest()?.pendingBidirectional.get(outer.marker.token)).toBe('back');

        vi.advanceTimersByTime(300);
        expect(inner.handle.modalElement.isConnected).toBe(false);
        expect(outer.handle.modalElement.isConnected).toBe(true);

        // Forward from the live outer target crosses retired inner to B.
        dispatchPop(inner.modalState, routeAHref);
        const innerTowardOlderState: unknown = history.state;
        expect(outerClose).toHaveBeenCalledTimes(1);
        expect(forward).toHaveBeenCalledTimes(1);
        dispatchPop(routeBState, routeBHref);
        expect(history.state).toEqual(routeBState);

        // Later Back crosses both private entries to A; Forward recovers B.
        dispatchPop(innerTowardOlderState, routeAHref);
        const innerTowardNewerState: unknown = history.state;
        expect(back).toHaveBeenCalledTimes(1);
        dispatchPop(outer.modalState, routeAHref);
        const outerTowardNewerState: unknown = history.state;
        expect(back).toHaveBeenCalledTimes(2);
        dispatchPop(routeAState, routeAHref);

        dispatchPop(outerTowardNewerState, routeAHref);
        expect(forward).toHaveBeenCalledTimes(2);
        dispatchPop(innerTowardNewerState, routeAHref);
        expect(forward).toHaveBeenCalledTimes(3);
        dispatchPop(routeBState, routeBHref);
        expect(history.state).toEqual(routeBState);
        expect(location.href).toBe(routeBHref);
    });

    it('cancels a queued close Back when a same-task host push takes ownership', () => {
        const routeAState: unknown = history.state;
        const routeAHref = location.href;
        const onClose = vi.fn();
        const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
        const forward = vi.spyOn(history, 'forward').mockImplementation(() => undefined);
        const shown = showModal(onClose);

        shown.handle.close();
        history.pushState({ host: 'same-task-route-b' }, '', '/web/index.html#/same-task-route-b');
        const routeBState: unknown = history.state;
        const routeBHref = location.href;
        vi.advanceTimersByTime(0);

        expect(back).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(isAnyModalOpen()).toBe(false);
        expect(history.state).toEqual(routeBState);
        expect(historyOwnerForTest()?.pendingBidirectional.get(shown.marker.token)).toBe('back');
        vi.advanceTimersByTime(300);
        expect(shown.handle.modalElement.isConnected).toBe(false);

        dispatchPop(shown.modalState, routeAHref);
        const promotedModalState: unknown = history.state;
        expect(back).toHaveBeenCalledTimes(1);
        dispatchPop(routeAState, routeAHref);
        expect(history.state).toEqual(routeAState);

        dispatchPop(promotedModalState, routeAHref);
        expect(forward).toHaveBeenCalledTimes(1);
        dispatchPop(routeBState, routeBHref);
        expect(history.state).toEqual(routeBState);
        expect(location.href).toBe(routeBHref);
    });

    it('strips a copied marker from a same-URL host replace and preserves every host field', () => {
        const onClose = vi.fn();
        const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
        const shown = showModal(onClose);
        const copiedHostState = {
            ...shown.modalState,
            hostUpdate: { exact: true, sequence: 7 },
            usr: null,
        };

        shown.handle.close();
        history.replaceState(copiedHostState, '', location.href);
        observeCurrentHistoryMutation('replaceState');
        vi.advanceTimersByTime(0);

        expect(back).not.toHaveBeenCalled();
        expect(markerOf(history.state)).toBeNull();
        expect(history.state).toEqual({
            host: 'details',
            nested: { itemId: 'history-owner' },
            hostUpdate: { exact: true, sequence: 7 },
            usr: null,
        });
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(historyOwnerForTest()?.records.size).toBe(0);
        expect(isAnyModalOpen()).toBe(false);
    });

    it('strips a copied marker from a host push while retaining two-way A to B traversal', () => {
        const routeAState: unknown = history.state;
        const routeAHref = location.href;
        const onClose = vi.fn();
        const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
        const forward = vi.spyOn(history, 'forward').mockImplementation(() => undefined);
        const shown = showModal(onClose);

        shown.handle.close();
        history.pushState(
            { ...shown.modalState, host: 'copied-push-route-b', exactHostField: 11 },
            '',
            '/web/index.html#/copied-push-route-b'
        );
        observeCurrentHistoryMutation('pushState');
        const routeBState: unknown = history.state;
        const routeBHref = location.href;
        vi.advanceTimersByTime(0);

        expect(back).not.toHaveBeenCalled();
        expect(markerOf(routeBState)).toBeNull();
        expect(routeBState).toMatchObject({
            host: 'copied-push-route-b',
            exactHostField: 11,
        });
        expect(onClose).toHaveBeenCalledTimes(1);

        dispatchPop(shown.modalState, routeAHref);
        const markerTowardNewer: unknown = history.state;
        expect(back).toHaveBeenCalledTimes(1);
        dispatchPop(routeAState, routeAHref);
        dispatchPop(markerTowardNewer, routeAHref);
        expect(forward).toHaveBeenCalledTimes(1);
        dispatchPop(routeBState, routeBHref);
        expect(history.state).toEqual(routeBState);
    });

    it('uses the exact pending owned Back when Chromium reports null for a Blob base pop', () => {
        const hostState = {
            route: 'blob-base',
            payload: new Blob(['history-owner'], { type: 'application/octet-stream' }),
        };
        history.replaceState(hostState, '', '/web/index.html#/blob-base');
        const onClose = vi.fn();
        const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
        const shown = showModal(onClose);

        shown.handle.close();
        vi.advanceTimersByTime(0);
        expect(back).toHaveBeenCalledTimes(1);
        expect(historyOwnerForTest()?.pendingOwnedTraversal?.phase).toBe('issued');

        dispatchPop(null, '/web/index.html#/blob-base');
        vi.advanceTimersByTime(300);

        expect(onClose).toHaveBeenCalledTimes(1);
        expect(shown.handle.modalElement.isConnected).toBe(false);
        expect(historyOwnerForTest()?.records.size).toBe(0);
        expect(historyOwnerForTest()?.pendingOwnedTraversal).toBeNull();
        expect(isAnyModalOpen()).toBe(false);
        expect(document.body.classList.contains('seerr-modal-is-open')).toBe(false);
    });

    it('repairs a host push that arrives after owned Back dispatch without losing A or B', () => {
        const routeAState: unknown = history.state;
        const routeAHref = location.href;
        const onClose = vi.fn();
        const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
        const go = vi.spyOn(history, 'go').mockImplementation(() => undefined);
        const forward = vi.spyOn(history, 'forward').mockImplementation(() => undefined);
        const shown = showModal(onClose);

        shown.handle.close();
        vi.advanceTimersByTime(0);
        expect(back).toHaveBeenCalledTimes(1);

        history.pushState({ host: 'late-route-b' }, '', '/web/index.html#/late-route-b');
        observeCurrentHistoryMutation('pushState');
        const routeBState: unknown = history.state;
        const routeBHref = location.href;

        expect(onClose).toHaveBeenCalledTimes(1);
        expect(isAnyModalOpen()).toBe(false);
        expect(historyOwnerForTest()?.pendingOwnedTraversal?.phase).toBe('superseded-issued');
        expect(go).toHaveBeenCalledWith(-2);

        // Chromium now delivers the stale target selected by Back before B was
        // pushed. Keep A private for this transaction and recover through M.
        dispatchPop(routeAState, routeAHref);
        expect(forward).toHaveBeenCalledTimes(1);
        expect(historyOwnerForTest()?.pendingOwnedTraversal?.phase).toBe('recovering-forward');
        dispatchPop(shown.modalState, routeAHref);
        expect(forward).toHaveBeenCalledTimes(2);
        dispatchPop(routeBState, routeBHref);

        expect(history.state).toEqual(routeBState);
        expect(historyOwnerForTest()?.pendingOwnedTraversal).toBeNull();
        expect(historyOwnerForTest()?.records.size).toBe(0);
    });

    it('keeps an older live modal open while recovering through a retired nested marker', () => {
        const routeAHref = location.href;
        const outerClose = vi.fn();
        const innerClose = vi.fn();
        const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
        const go = vi.spyOn(history, 'go').mockImplementation(() => undefined);
        const forward = vi.spyOn(history, 'forward').mockImplementation(() => undefined);
        const outer = showModal(outerClose);
        const inner = showModal(innerClose);

        inner.handle.close();
        vi.advanceTimersByTime(0);
        expect(back).toHaveBeenCalledTimes(1);
        history.pushState({ host: 'nested-late-route-b' }, '', '/web/index.html#/nested-late-route-b');
        observeCurrentHistoryMutation('pushState');
        const routeBState: unknown = history.state;
        const routeBHref = location.href;

        expect(go).toHaveBeenCalledWith(-2);
        expect(innerClose).toHaveBeenCalledTimes(1);
        expect(outerClose).not.toHaveBeenCalled();

        // The exact -2 handshake first reaches the live outer marker. It is
        // below the retired inner marker and must remain the active modal.
        dispatchPop(outer.modalState, routeAHref);
        expect(forward).toHaveBeenCalledTimes(1);
        expect(outerClose).not.toHaveBeenCalled();
        expect(outer.handle.modalElement.isConnected).toBe(true);

        dispatchPop(inner.modalState, routeAHref);
        expect(forward).toHaveBeenCalledTimes(2);
        expect(outerClose).not.toHaveBeenCalled();
        expect(outer.handle.modalElement.isConnected).toBe(true);
        dispatchPop(routeBState, routeBHref);

        expect(historyOwnerForTest()?.pendingOwnedTraversal).toBeNull();
        expect(historyOwnerForTest()?.records.size).toBe(1);
        expect(outerClose).not.toHaveBeenCalled();
        expect(innerClose).toHaveBeenCalledTimes(1);
    });

    it('reissues the exact classic base delta once for every distinct late push', () => {
        const routeAState: unknown = history.state;
        const routeAHref = location.href;
        vi.spyOn(history, 'back').mockImplementation(() => undefined);
        const go = vi.spyOn(history, 'go').mockImplementation(() => undefined);
        const forward = vi.spyOn(history, 'forward').mockImplementation(() => undefined);
        const shown = showModal();

        shown.handle.close();
        vi.advanceTimersByTime(0);
        history.pushState({ host: 'late-route-b' }, '', '/web/index.html#/late-route-b');
        observeCurrentHistoryMutation('pushState');
        const routeBState: unknown = history.state;
        const routeBHref = location.href;
        history.pushState({ host: 'late-route-c' }, '', '/web/index.html#/late-route-c');
        observeCurrentHistoryMutation('pushState');
        const routeCState: unknown = history.state;
        const routeCHref = location.href;

        expect(go.mock.calls).toEqual([[-2], [-3]]);
        dispatchPop(routeAState, routeAHref);
        dispatchPop(shown.modalState, routeAHref);
        dispatchPop(routeBState, routeBHref);
        expect(forward).toHaveBeenCalledTimes(3);
        dispatchPop(routeCState, routeCHref);

        expect(history.state).toEqual(routeCState);
        expect(historyOwnerForTest()?.pendingOwnedTraversal).toBeNull();
    });

    it('deduplicates the patched PUSH and matching raw HISTORY_UPDATE handshake', () => {
        const go = vi.spyOn(history, 'go').mockImplementation(() => undefined);
        vi.spyOn(history, 'back').mockImplementation(() => undefined);
        const shown = showModal();

        shown.handle.close();
        vi.advanceTimersByTime(0);
        history.pushState(
            { location: { key: 'raw-push-entry-b' }, host: 'raw-push-route-b' },
            '',
            '/web/index.html#/raw-push-route-b'
        );
        observeCurrentHistoryMutation('pushState', 'PUSH', 'raw-push-entry-b');
        observeCurrentHistoryMutation('HISTORY_UPDATE', 'PUSH', 'raw-push-entry-b');
        observeCurrentHistoryMutation('HISTORY_UPDATE', 'POP', 'raw-push-entry-b');

        expect(go.mock.calls).toEqual([[-2]]);
        expect(historyOwnerForTest()?.pendingOwnedTraversal?.phase).toBe('superseded-issued');
    });

    it('settles at a reactive PUSH without overshooting or exposing the stale pop', () => {
        const routeAState: unknown = history.state;
        const routeAHref = location.href;
        const owner = historyOwnerForTest()!;
        if (owner.listener) window.removeEventListener('popstate', owner.listener, true);
        owner.listener = null;
        const routeDState = { host: 'reactive-pop-route-d' };
        const routeDHref = '/web/index.html#/reactive-pop-route-d';
        const earlierRouter = () => {
            History.prototype.pushState.call(history, routeDState, '', routeDHref);
            owner.historyObserver?.({
                source: 'HISTORY_UPDATE',
                action: 'PUSH',
                entryKey: 'reactive-route-d',
                state: history.state,
                href: location.href,
            });
        };
        const laterRouter = vi.fn();
        window.addEventListener('popstate', earlierRouter, { capture: true, once: true });
        uninstall();
        uninstall = installSeerrModal();
        window.addEventListener('popstate', laterRouter);
        vi.spyOn(history, 'back').mockImplementation(() => undefined);
        const go = vi.spyOn(history, 'go').mockImplementation(() => undefined);
        const shown = showModal();

        try {
            shown.handle.close();
            vi.advanceTimersByTime(0);
            history.pushState({ host: 'superseded-route-b' }, '', '/web/index.html#/superseded-route-b');
            observeCurrentHistoryMutation('pushState');
            expect(go.mock.calls).toEqual([[-2]]);

            dispatchPop(routeAState, routeAHref);

            expect(go.mock.calls).toEqual([[-2]]);
            expect(history.state).toEqual(routeDState);
            expect(location.href).toBe(new URL(routeDHref, location.origin).href);
            expect(historyOwnerForTest()?.pendingOwnedTraversal).toBeNull();
            expect(laterRouter).not.toHaveBeenCalled();
            expect(isAnyModalOpen()).toBe(false);
        } finally {
            window.removeEventListener('popstate', earlierRouter, { capture: true });
            window.removeEventListener('popstate', laterRouter);
        }
    });

    it('settles a classic late push before a later go(-2) and keeps Forward from A to B', () => {
        const routeAState: unknown = history.state;
        const routeAHref = location.href;
        const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
        const go = vi.spyOn(history, 'go').mockImplementation(() => undefined);
        const forward = vi.spyOn(history, 'forward').mockImplementation(() => undefined);
        const shown = showModal();

        shown.handle.close();
        vi.advanceTimersByTime(0);
        expect(back).toHaveBeenCalledTimes(1);
        history.pushState({ host: 'classic-canceled-route-b' }, '', '/web/index.html#/classic-canceled-route-b');
        observeCurrentHistoryMutation('pushState');
        const routeBState: unknown = history.state;
        const routeBHref = location.href;

        expect(go).toHaveBeenCalledWith(-2);
        expect(historyOwnerForTest()?.pendingOwnedTraversal?.phase).toBe('superseded-issued');

        // The exact PUSH-only handshake resolves the canceled/pending Back to
        // A and returns through M to B before a user traversal can begin.
        dispatchPop(routeAState, routeAHref);
        expect(forward).toHaveBeenCalledTimes(1);
        dispatchPop(shown.modalState, routeAHref);
        expect(forward).toHaveBeenCalledTimes(2);
        dispatchPop(routeBState, routeBHref);
        expect(historyOwnerForTest()?.pendingOwnedTraversal).toBeNull();
        expect(history.state).toEqual(routeBState);

        // Native Back-history selection now jumps B→A without a private pop.
        dispatchPop(routeAState, routeAHref);
        expect(history.state).toEqual(routeAState);
        expect(historyOwnerForTest()?.pendingBidirectional.get(shown.marker.token)).toBe('forward');
        dispatchPop(shown.modalState, routeAHref);
        expect(forward).toHaveBeenCalledTimes(3);
        dispatchPop(routeBState, routeBHref);
        expect(history.state).toEqual(routeBState);
    });

    it('does not replace B with an earlier-router rewrite of the stale owned base pop', () => {
        const routeAState: unknown = history.state;
        const routeAHref = location.href;
        const canonicalRouteAHref = '/web/index.html#/stale-route-a-canonical';
        const owner = historyOwnerForTest()!;
        if (owner.listener) window.removeEventListener('popstate', owner.listener, true);
        owner.listener = null;
        let rewritten = false;
        const earlierRouter = (event: PopStateEvent) => {
            if (rewritten) return;
            rewritten = true;
            History.prototype.replaceState.call(history, event.state, '', canonicalRouteAHref);
            owner.historyObserver?.({
                source: 'replaceState',
                state: history.state,
                href: location.href,
            });
        };
        window.addEventListener('popstate', earlierRouter, { capture: true });
        uninstall();
        uninstall = installSeerrModal();
        vi.spyOn(history, 'back').mockImplementation(() => undefined);
        const go = vi.spyOn(history, 'go').mockImplementation(() => undefined);
        const forward = vi.spyOn(history, 'forward').mockImplementation(() => undefined);
        const shown = showModal();

        try {
            shown.handle.close();
            vi.advanceTimersByTime(0);
            history.pushState({ host: 'stale-rewrite-route-b' }, '', '/web/index.html#/stale-rewrite-route-b');
            observeCurrentHistoryMutation('pushState');
            const routeBState: unknown = history.state;
            const routeBHref = location.href;

            dispatchPop(routeAState, routeAHref);
            expect(location.href).toBe(new URL(canonicalRouteAHref, location.origin).href);
            expect(historyOwnerForTest()?.pendingOwnedTraversal?.hostState).toEqual(routeBState);
            expect(historyOwnerForTest()?.pendingOwnedTraversal?.hostHref).toBe(routeBHref);
            expect(go).toHaveBeenCalledWith(-2);
            expect(forward).toHaveBeenCalledTimes(1);

            dispatchPop(shown.modalState, routeAHref);
            expect(forward).toHaveBeenCalledTimes(2);
            dispatchPop(routeBState, routeBHref);
            expect(history.state).toEqual(routeBState);
            expect(historyOwnerForTest()?.pendingOwnedTraversal).toBeNull();
        } finally {
            window.removeEventListener('popstate', earlierRouter, { capture: true });
        }
    });

    it.each(['setTimeout', 'MessageChannel', 'requestAnimationFrame'] as const)(
        'keeps the saved B target when an earlier router defers stale-A canonicalization through %s',
        async (channel) => {
            const routeAState: unknown = history.state;
            const routeAHref = location.href;
            const canonicalRouteAHref = `/web/index.html#/async-stale-a-${channel}`;
            const owner = historyOwnerForTest()!;
            if (owner.listener) window.removeEventListener('popstate', owner.listener, true);
            owner.listener = null;
            let rewriteScheduled = false;
            let rewriteSettled = Promise.resolve();
            const messageChannels: MessageChannel[] = [];
            const earlierRouter = (event: PopStateEvent) => {
                if (rewriteScheduled) return;
                rewriteScheduled = true;
                rewriteSettled = new Promise<void>((resolve) => {
                    const rewrite = () => {
                        History.prototype.replaceState.call(
                            history,
                            { ...(event.state as Record<string, unknown>), canonicalized: channel },
                            '',
                            canonicalRouteAHref
                        );
                        owner.historyObserver?.({
                            source: 'replaceState',
                            action: 'REPLACE',
                            state: history.state,
                            href: location.href,
                        });
                        for (const pendingChannel of messageChannels.splice(0)) {
                            pendingChannel.port1.close();
                            pendingChannel.port2.close();
                        }
                        resolve();
                    };
                    if (channel === 'setTimeout') {
                        setTimeout(rewrite, 0);
                    } else if (channel === 'MessageChannel') {
                        const pendingChannel = new MessageChannel();
                        messageChannels.push(pendingChannel);
                        pendingChannel.port1.addEventListener('message', rewrite, { once: true });
                        pendingChannel.port1.start();
                        pendingChannel.port2.postMessage(undefined);
                    } else if (typeof window.requestAnimationFrame === 'function') {
                        window.requestAnimationFrame(rewrite);
                    } else {
                        // jsdom has no visual frame clock; retain the same separate
                        // task boundary while the real-browser spec uses native rAF.
                        setTimeout(rewrite, 16);
                    }
                });
            };
            const laterRouter = vi.fn();
            window.addEventListener('popstate', earlierRouter, { capture: true });
            uninstall();
            uninstall = installSeerrModal();
            window.addEventListener('popstate', laterRouter);
            vi.spyOn(history, 'back').mockImplementation(() => undefined);
            const go = vi.spyOn(history, 'go').mockImplementation(() => undefined);
            const forward = vi.spyOn(history, 'forward').mockImplementation(() => undefined);
            const shown = showModal();

            try {
                shown.handle.close();
                vi.advanceTimersByTime(0);
                history.pushState(
                    { host: `async-rewrite-route-b-${channel}` },
                    '',
                    `/web/index.html#/async-rewrite-route-b-${channel}`
                );
                observeCurrentHistoryMutation('pushState');
                const routeBState: unknown = history.state;
                const routeBHref = location.href;

                expect(go).toHaveBeenCalledWith(-2);
                dispatchPop(routeAState, routeAHref);
                expect(historyOwnerForTest()?.pendingOwnedTraversal?.phase).toBe('recovering-forward');
                expect(forward).toHaveBeenCalledTimes(1);
                if (channel === 'setTimeout') {
                    await vi.advanceTimersByTimeAsync(0);
                } else if (channel === 'requestAnimationFrame') {
                    await vi.advanceTimersByTimeAsync(16);
                }
                await rewriteSettled;

                expect(location.href).toBe(new URL(canonicalRouteAHref, location.origin).href);
                const canonicalRouteAState: unknown = history.state;
                expect(canonicalRouteAState).not.toEqual(routeAState);
                expect(historyOwnerForTest()?.pendingOwnedTraversal?.hostState).toEqual(routeBState);
                expect(historyOwnerForTest()?.pendingOwnedTraversal?.hostHref).toBe(routeBHref);

                dispatchPop(shown.modalState, routeAHref);
                expect(forward).toHaveBeenCalledTimes(2);
                dispatchPop(routeBState, routeBHref);
                expect(historyOwnerForTest()?.pendingOwnedTraversal).toBeNull();
                expect(laterRouter.mock.calls.map(([event]) => (event as PopStateEvent).state)).toEqual([
                    routeBState,
                ]);

                // A native history-menu/direct multi-entry traversal bypasses M
                // and reaches canonicalized A. Forward must still skip only M
                // and recover B; no transaction state may leak into this trip.
                history.go(-2);
                expect(go).toHaveBeenLastCalledWith(-2);
                dispatchPop(canonicalRouteAState, canonicalRouteAHref);
                expect(historyOwnerForTest()?.pendingOwnedTraversal).toBeNull();
                expect(historyOwnerForTest()?.pendingBidirectional.get(shown.marker.token)).toBe('forward');
                dispatchPop(shown.modalState, routeAHref);
                expect(forward).toHaveBeenCalledTimes(3);
                dispatchPop(routeBState, routeBHref);
                expect(historyOwnerForTest()?.pendingOwnedTraversal).toBeNull();
                expect(laterRouter.mock.calls.map(([event]) => (event as PopStateEvent).state)).toEqual([
                    routeBState,
                    canonicalRouteAState,
                    routeBState,
                ]);
            } finally {
                for (const pendingChannel of messageChannels) {
                    pendingChannel.port1.close();
                    pendingChannel.port2.close();
                }
                window.removeEventListener('popstate', earlierRouter, { capture: true });
                window.removeEventListener('popstate', laterRouter);
            }
        }
    );

    it('settles recovered B when an earlier router synchronously canonicalizes that pop', () => {
        const routeAState: unknown = history.state;
        const routeAHref = location.href;
        const routeBState = { host: 'recovered-route-b' };
        const routeBHref = '/web/index.html#/recovered-route-b';
        const canonicalRouteBState = { ...routeBState, canonicalized: true };
        const canonicalRouteBHref = '/web/index.html#/recovered-route-b-canonical';
        const owner = historyOwnerForTest()!;
        if (owner.listener) window.removeEventListener('popstate', owner.listener, true);
        owner.listener = null;
        const earlierRouter = (event: PopStateEvent) => {
            if ((event.state as { host?: string } | null)?.host !== routeBState.host) return;
            History.prototype.replaceState.call(
                history,
                canonicalRouteBState,
                '',
                canonicalRouteBHref
            );
            owner.historyObserver?.({
                source: 'replaceState',
                action: 'REPLACE',
                state: history.state,
                href: location.href,
            });
        };
        const laterRouter = vi.fn();
        window.addEventListener('popstate', earlierRouter, { capture: true });
        uninstall();
        uninstall = installSeerrModal();
        window.addEventListener('popstate', laterRouter);
        vi.spyOn(history, 'back').mockImplementation(() => undefined);
        const forward = vi.spyOn(history, 'forward').mockImplementation(() => undefined);
        const shown = showModal();

        try {
            shown.handle.close();
            vi.advanceTimersByTime(0);
            history.pushState(routeBState, '', routeBHref);
            observeCurrentHistoryMutation('pushState');

            dispatchPop(routeAState, routeAHref);
            dispatchPop(shown.modalState, routeAHref);
            expect(forward).toHaveBeenCalledTimes(2);
            dispatchPop(routeBState, routeBHref);

            expect(historyOwnerForTest()?.pendingOwnedTraversal).toBeNull();
            expect(history.state).toEqual(canonicalRouteBState);
            expect(location.href).toBe(new URL(canonicalRouteBHref, location.origin).href);
            expect(laterRouter).toHaveBeenCalledTimes(1);
            expect((laterRouter.mock.calls[0][0] as PopStateEvent).state).toBe(routeBState);
        } finally {
            window.removeEventListener('popstate', earlierRouter, { capture: true });
            window.removeEventListener('popstate', laterRouter);
        }
    });

    it('does not mistake an earlier-router base-pop canonicalization for supersession', () => {
        const routeAState: unknown = history.state;
        const routeAHref = location.href;
        const canonicalRouteAHref = '/web/index.html#/owned-base-canonical';
        const owner = historyOwnerForTest()!;
        if (owner.listener) window.removeEventListener('popstate', owner.listener, true);
        owner.listener = null;
        const earlierRouter = (event: PopStateEvent) => {
            History.prototype.replaceState.call(history, event.state, '', canonicalRouteAHref);
            owner.historyObserver?.({
                source: 'replaceState',
                action: 'REPLACE',
                state: history.state,
                href: location.href,
            });
        };
        window.addEventListener('popstate', earlierRouter, { capture: true });
        uninstall();
        uninstall = installSeerrModal();
        const onClose = vi.fn();
        const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
        const forward = vi.spyOn(history, 'forward').mockImplementation(() => undefined);
        const shown = showModal(onClose);

        try {
            shown.handle.close();
            vi.advanceTimersByTime(0);
            expect(back).toHaveBeenCalledTimes(1);
            dispatchPop(routeAState, routeAHref);

            expect(forward).not.toHaveBeenCalled();
            expect(onClose).toHaveBeenCalledTimes(1);
            expect(historyOwnerForTest()?.pendingOwnedTraversal).toBeNull();
            expect(location.href).toBe(new URL(canonicalRouteAHref, location.origin).href);
        } finally {
            window.removeEventListener('popstate', earlierRouter, { capture: true });
        }
    });

    it('always treats the first untagged superseded pop as stale when A and B are indistinguishable', () => {
        const sameState = { route: 'same-url-same-state' };
        const sameHref = '/web/index.html#/same-url-same-state';
        history.replaceState(sameState, '', sameHref);
        vi.spyOn(history, 'back').mockImplementation(() => undefined);
        const go = vi.spyOn(history, 'go').mockImplementation(() => undefined);
        const forward = vi.spyOn(history, 'forward').mockImplementation(() => undefined);
        const shown = showModal();

        shown.handle.close();
        vi.advanceTimersByTime(0);
        history.pushState(structuredClone(sameState), '', sameHref);
        observeCurrentHistoryMutation('pushState');
        expect(go).toHaveBeenCalledWith(-2);

        dispatchPop(structuredClone(sameState), sameHref);
        expect(historyOwnerForTest()?.pendingOwnedTraversal?.phase).toBe('recovering-forward');
        expect(forward).toHaveBeenCalledTimes(1);
        dispatchPop(shown.modalState, sameHref);
        expect(forward).toHaveBeenCalledTimes(2);
        dispatchPop(structuredClone(sameState), sameHref);
        expect(historyOwnerForTest()?.pendingOwnedTraversal).toBeNull();
    });

    it('uses Navigation entry keys without an unnecessary classic go handshake', () => {
        const originalNavigation = Object.getOwnPropertyDescriptor(window, 'navigation');
        const navigation = { currentEntry: { key: 'navigation-route-a' } };
        Object.defineProperty(window, 'navigation', {
            configurable: true,
            value: navigation,
        });
        const routeAState: unknown = history.state;
        const routeAHref = location.href;
        vi.spyOn(history, 'back').mockImplementation(() => undefined);
        const go = vi.spyOn(history, 'go').mockImplementation(() => undefined);
        const forward = vi.spyOn(history, 'forward').mockImplementation(() => undefined);

        try {
            const shown = showModal();
            expect(shown.marker.hostNavigationKey).toBe('navigation-route-a');
            navigation.currentEntry.key = 'navigation-modal-marker';
            shown.handle.close();
            vi.advanceTimersByTime(0);

            navigation.currentEntry.key = 'navigation-route-b';
            history.pushState({ host: 'navigation-route-b' }, '', '/web/index.html#/navigation-route-b');
            observeCurrentHistoryMutation('pushState');
            const routeBState: unknown = history.state;
            const routeBHref = location.href;
            expect(go).not.toHaveBeenCalled();

            navigation.currentEntry.key = 'navigation-route-a';
            dispatchPop(routeAState, routeAHref);
            expect(forward).toHaveBeenCalledTimes(1);
            navigation.currentEntry.key = 'navigation-modal-marker';
            dispatchPop(shown.modalState, routeAHref);
            expect(forward).toHaveBeenCalledTimes(2);
            navigation.currentEntry.key = 'navigation-route-b';
            dispatchPop(routeBState, routeBHref);

            expect(historyOwnerForTest()?.pendingOwnedTraversal).toBeNull();
            expect(history.state).toEqual(routeBState);
        } finally {
            if (originalNavigation) {
                Object.defineProperty(window, 'navigation', originalNavigation);
            } else {
                Reflect.deleteProperty(window, 'navigation');
            }
        }
    });

    it('does not close a modal at a structurally identical newer entry when Navigation keys differ', () => {
        const originalNavigation = Object.getOwnPropertyDescriptor(window, 'navigation');
        const navigation = { currentEntry: { key: 'identical-route-a' } };
        Object.defineProperty(window, 'navigation', {
            configurable: true,
            value: navigation,
        });
        const sameState = { route: 'structurally-identical' };
        const sameHref = '/web/index.html#/structurally-identical';
        history.replaceState(sameState, '', sameHref);
        const onClose = vi.fn();

        try {
            const shown = showModal(onClose);
            navigation.currentEntry.key = 'identical-modal-marker';
            navigation.currentEntry.key = 'identical-route-b';
            history.pushState(structuredClone(sameState), '', sameHref);
            observeCurrentHistoryMutation('pushState');
            navigation.currentEntry.key = 'identical-route-c';
            history.pushState({ route: 'newer-c' }, '', '/web/index.html#/newer-c');
            observeCurrentHistoryMutation('pushState');

            navigation.currentEntry.key = 'identical-route-b';
            dispatchPop(structuredClone(sameState), sameHref);

            expect(onClose).not.toHaveBeenCalled();
            expect(shown.handle.modalElement.isConnected).toBe(true);
            expect(historyOwnerForTest()?.records.size).toBe(1);
        } finally {
            if (originalNavigation) {
                Object.defineProperty(window, 'navigation', originalNavigation);
            } else {
                Reflect.deleteProperty(window, 'navigation');
            }
        }
    });

    it('repairs a superseded owned Back when Chromium loses the Blob base state', () => {
        const originalNavigation = Object.getOwnPropertyDescriptor(window, 'navigation');
        const navigation = { currentEntry: { key: 'late-blob-route-a' } };
        Object.defineProperty(window, 'navigation', {
            configurable: true,
            value: navigation,
        });
        const routeAState = {
            route: 'late-blob-route-a',
            payload: new Blob(['late-race'], { type: 'application/octet-stream' }),
        };
        const routeAHref = '/web/index.html#/late-blob-route-a';
        history.replaceState(routeAState, '', routeAHref);
        const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
        const go = vi.spyOn(history, 'go').mockImplementation(() => undefined);
        const forward = vi.spyOn(history, 'forward').mockImplementation(() => undefined);
        try {
            const shown = showModal();
            navigation.currentEntry.key = 'late-blob-modal-marker';

            shown.handle.close();
            vi.advanceTimersByTime(0);
            expect(back).toHaveBeenCalledTimes(1);
            navigation.currentEntry.key = 'late-blob-route-b';
            history.pushState({
                host: 'late-blob-route-b',
                payload: new Blob(['late-target'], { type: 'application/octet-stream' }),
            }, '', '/web/index.html#/late-blob-route-b');
            observeCurrentHistoryMutation('pushState');
            const routeBHref = location.href;
            expect(go).not.toHaveBeenCalled();

            // Chromium emits null here even though the selected entry contained
            // a Blob. Its exact Navigation entry key still proves ownership.
            navigation.currentEntry.key = 'late-blob-route-a';
            dispatchPop(null, routeAHref);
            expect(forward).toHaveBeenCalledTimes(1);
            navigation.currentEntry.key = 'late-blob-modal-marker';
            dispatchPop(shown.modalState, routeAHref);
            expect(forward).toHaveBeenCalledTimes(2);
            navigation.currentEntry.key = 'late-blob-route-b';
            const canonicalRouteBHref = '/web/index.html#/late-blob-route-b-canonical';
            History.prototype.replaceState.call(
                history,
                { host: 'late-blob-route-b', canonicalized: true },
                '',
                canonicalRouteBHref
            );
            observeCurrentHistoryMutation('replaceState');
            window.dispatchEvent(new PopStateEvent('popstate', { state: null }));

            expect(historyOwnerForTest()?.pendingOwnedTraversal).toBeNull();
            expect(history.state).toEqual({ host: 'late-blob-route-b', canonicalized: true });
            expect(location.href).toBe(new URL(canonicalRouteBHref, location.origin).href);
            expect(isAnyModalOpen()).toBe(false);
            expect(routeBHref).toContain('#/late-blob-route-b');
        } finally {
            if (originalNavigation) {
                Object.defineProperty(window, 'navigation', originalNavigation);
            } else {
                Reflect.deleteProperty(window, 'navigation');
            }
        }
    });

    it('repairs a late copied-marker replace directly to its exact host target', () => {
        const routeAState: unknown = history.state;
        const routeAHref = location.href;
        const onClose = vi.fn();
        vi.spyOn(history, 'back').mockImplementation(() => undefined);
        const forward = vi.spyOn(history, 'forward').mockImplementation(() => undefined);
        const shown = showModal(onClose);

        shown.handle.close();
        vi.advanceTimersByTime(0);
        history.replaceState(
            { ...shown.modalState, host: 'late-replace-b', preserved: { value: 19 } },
            '',
            '/web/index.html#/late-replace-b'
        );
        observeCurrentHistoryMutation('replaceState');
        const routeBState: unknown = history.state;
        const routeBHref = location.href;

        expect(markerOf(routeBState)).toBeNull();
        expect(routeBState).toMatchObject({
            host: 'late-replace-b',
            preserved: { value: 19 },
        });
        expect(onClose).toHaveBeenCalledTimes(1);

        dispatchPop(routeAState, routeAHref);
        expect(forward).toHaveBeenCalledTimes(1);
        History.prototype.replaceState.call(
            history,
            routeBState,
            '',
            '/web/index.html#/late-replace-canonical'
        );
        window.dispatchEvent(new PopStateEvent('popstate', { state: routeBState }));

        expect(historyOwnerForTest()?.pendingOwnedTraversal).toBeNull();
        expect(history.state).toEqual(routeBState);
        expect(location.hash).toBe('#/late-replace-canonical');
        expect(forward).toHaveBeenCalledTimes(1);
        expect(isAnyModalOpen()).toBe(false);
        expect(routeBHref).toContain('#/late-replace-b');
    });

    it('retains an unresolved marker direction across a newer C to B host traversal', () => {
        const originalState: unknown = history.state;
        const originalHref = location.href;
        const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
        const forward = vi.spyOn(history, 'forward').mockImplementation(() => undefined);
        const shown = showModal();
        history.pushState({ host: 'route-b' }, '', '/web/index.html#/route-b');
        const routeBState: unknown = history.state;
        const routeBHref = location.href;
        shown.handle.close();
        vi.advanceTimersByTime(300);
        history.pushState({ host: 'route-c' }, '', '/web/index.html#/route-c');

        // C → B does not cross the private marker, so its pending direction
        // must survive until the following B → marker traversal.
        dispatchPop(routeBState, routeBHref);
        expect(historyOwnerForTest()?.pendingBidirectional.has(shown.marker.token)).toBe(true);
        dispatchPop(shown.modalState, originalHref);
        const promotedModalState: unknown = history.state;
        expect(back).toHaveBeenCalledTimes(1);
        dispatchPop(originalState, originalHref);

        dispatchPop(promotedModalState, originalHref);
        expect(forward).toHaveBeenCalledTimes(1);
        dispatchPop(routeBState, routeBHref);
        expect(history.state).toEqual(routeBState);
    });

    it('promotes a still-live marker reached by Back from a newer host route', () => {
        const originalState: unknown = history.state;
        const originalHref = location.href;
        const onClose = vi.fn();
        const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
        const forward = vi.spyOn(history, 'forward').mockImplementation(() => undefined);
        const shown = showModal(onClose);
        history.pushState({ host: 'route-b' }, '', '/web/index.html#/route-b');

        dispatchPop(shown.modalState, originalHref);
        const promotedModalState: unknown = history.state;
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(markerOf(promotedModalState)).toMatchObject({
            traversal: 'bidirectional',
            nextDirection: 'forward',
        });
        expect(back).toHaveBeenCalledTimes(1);
        dispatchPop(originalState, originalHref);

        dispatchPop(promotedModalState, originalHref);
        expect(forward).toHaveBeenCalledTimes(1);
    });

    it('does not Back over an intervening replace and restores the tagged base when reached', () => {
        const originalState: unknown = history.state;
        const originalHref = location.href;
        const onClose = vi.fn();
        const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
        const shown = showModal(onClose);

        history.replaceState({ host: 'replacement-route' }, '', '/web/index.html#/movies');
        shown.handle.close();
        vi.advanceTimersByTime(300);

        expect(back).not.toHaveBeenCalled();
        expect(history.state).toEqual({ host: 'replacement-route' });
        expect(location.hash).toBe('#/movies');

        dispatchPop(shown.baseState, originalHref);
        expect(history.state).toEqual(originalState);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(back).not.toHaveBeenCalled();
    });

    it('leaves no accumulating Back ghosts across repeated successful modals', () => {
        const originalState: unknown = history.state;
        const originalHref = location.href;
        const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
        const closeCallbacks = Array.from({ length: 5 }, () => vi.fn());

        for (const onClose of closeCallbacks) {
            const shown = showModal(onClose);
            shown.handle.close();
            dispatchPop(shown.baseState, originalHref);
            vi.advanceTimersByTime(300);
            expect(history.state).toEqual(originalState);
        }

        expect(back).toHaveBeenCalledTimes(5);
        for (const onClose of closeCallbacks) expect(onClose).toHaveBeenCalledTimes(1);
        expect(isAnyModalOpen()).toBe(false);
        expect(document.querySelectorAll('.seerr-season-modal')).toHaveLength(0);
    });

    it('skips every repeat Forward into a retired modal entry without reopening or double-closing', () => {
        const originalState: unknown = history.state;
        const originalHref = location.href;
        const onClose = vi.fn();
        const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
        const shown = showModal(onClose);
        shown.handle.close();
        dispatchPop(shown.baseState, originalHref);
        vi.advanceTimersByTime(300);

        dispatchPop(shown.modalState, originalHref); // browser Forward
        expect(back).toHaveBeenCalledTimes(2);
        dispatchPop(originalState, originalHref); // landing entry was untagged by the first close

        dispatchPop(shown.modalState, originalHref); // repeat Forward must skip again
        expect(back).toHaveBeenCalledTimes(3);
        dispatchPop(originalState, originalHref);

        expect(history.state).toEqual(originalState);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(shown.handle.modalElement.isConnected).toBe(false);
    });

    it.each([
        ['object', { route: 'details', nested: { id: 7 } }],
        ['null', null],
        ['string primitive', 'host-route'],
        ['number primitive', 42],
        ['array', ['route', { id: 7 }]],
    ] as const)('delivers the exact %s host state to routers installed before and after the owner', (_label, hostState) => {
        uninstall();
        history.replaceState(hostState, '', '/web/index.html#/host-state');
        const earlierStates: unknown[] = [];
        const laterStates: unknown[] = [];
        const earlierRouter = (event: PopStateEvent) => earlierStates.push(event.state);
        const laterRouter = (event: PopStateEvent) => laterStates.push(event.state);
        window.addEventListener('popstate', earlierRouter, { capture: true });
        uninstall = installSeerrModal();
        window.addEventListener('popstate', laterRouter);

        try {
            const shown = showModal();
            expect(shown.marker.hostState).toEqual(hostState);

            dispatchPop(hostState);

            expect(earlierStates).toEqual([hostState]);
            expect(laterStates).toEqual([hostState]);
            expect(history.state).toEqual(hostState);
        } finally {
            window.removeEventListener('popstate', earlierRouter, { capture: true });
            window.removeEventListener('popstate', laterRouter);
        }
    });

    it('matches a fresh structured clone of cyclic host state on Back', () => {
        const hostState: { route: string; self?: unknown } = { route: 'cyclic-host-state' };
        hostState.self = hostState;
        history.replaceState(hostState, '', '/web/index.html#/cyclic-host-state');
        const onClose = vi.fn();
        const shown = showModal(onClose);
        const traversalState = structuredClone(hostState);

        expect(traversalState).not.toBe(shown.baseState);
        expect(traversalState.self).toBe(traversalState);
        dispatchPop(traversalState);

        expect(onClose).toHaveBeenCalledTimes(1);
        expect(shown.handle.modalElement.isConnected).toBe(true);
        expect(history.state).toBe(traversalState);
        vi.advanceTimersByTime(300);
        expect(shown.handle.modalElement.isConnected).toBe(false);
    });

    it('matches immutable pop state after an earlier router canonicalizes the base URL', () => {
        const hostState = { route: 'pre-owner-router-base' };
        const originalHref = '/web/index.html#/pre-owner-router-base';
        const canonicalHref = '/web/index.html#/pre-owner-router-canonical';
        uninstall();
        history.replaceState(hostState, '', originalHref);
        const earlierRouter = (event: PopStateEvent) => {
            History.prototype.replaceState.call(history, event.state, '', canonicalHref);
        };
        window.addEventListener('popstate', earlierRouter, { capture: true });
        uninstall = installSeerrModal();
        const onClose = vi.fn();

        try {
            const shown = showModal(onClose);
            dispatchPop(structuredClone(hostState), originalHref);

            expect(onClose).toHaveBeenCalledTimes(1);
            expect(location.href).toBe(new URL(canonicalHref, location.origin).href);
            expect(history.state).toEqual(hostState);
            vi.advanceTimersByTime(300);
            expect(shown.handle.modalElement.isConnected).toBe(false);
        } finally {
            window.removeEventListener('popstate', earlierRouter, { capture: true });
        }
    });

    it('fully rolls back DOM, ownership, focus gates, and callbacks when pushState fails', () => {
        const originalState: unknown = history.state;
        const onClose = vi.fn();
        const handle = JC.seerrModal!.create({
            title: 'Rejected history marker',
            subtitle: 'History policy failure',
            bodyHtml: '<p>Must not strand a modal.</p>',
            onSave: vi.fn(),
            onClose,
        });
        vi.spyOn(history, 'pushState').mockImplementation(() => {
            throw new DOMException('History write denied', 'SecurityError');
        });

        expect(() => handle.show()).toThrow('History write denied');

        expect(history.state).toEqual(originalState);
        expect(handle.modalElement.isConnected).toBe(false);
        expect(document.body.classList.contains('seerr-modal-is-open')).toBe(false);
        expect(document.body.classList.contains('jc-modal-open')).toBe(false);
        expect(isAnyModalOpen()).toBe(false);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(historyOwnerForTest()?.records.size).toBe(0);
    });

    it('consumes the published marker and rolls back when later modal setup fails', () => {
        const onClose = vi.fn();
        const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
        vi.spyOn(JC.core.refreshSafety!, 'holdElement').mockImplementation(() => {
            throw new Error('modal accessibility setup failed');
        });
        const handle = JC.seerrModal!.create({
            title: 'Rejected setup',
            subtitle: 'History already published',
            bodyHtml: '<p>Must roll back.</p>',
            onSave: vi.fn(),
            onClose,
        });

        expect(() => handle.show()).toThrow('modal accessibility setup failed');
        vi.advanceTimersByTime(0);
        const marker = markerOf(history.state);
        expect(marker).not.toBeNull();
        expect(back).toHaveBeenCalledTimes(1);
        expect(handle.modalElement.isConnected).toBe(false);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(historyOwnerForTest()?.records.size).toBe(0);
        expect(isAnyModalOpen()).toBe(false);

        dispatchPop(marker!.hostState);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('keeps one-action predecessor traversal when setup cleanup cannot immediately go Back', () => {
        const currentState: unknown = history.state;
        const currentHref = location.href;
        const previousState = { host: 'setup-failure-predecessor' };
        const previousHref = '/web/index.html#/setup-failure-predecessor';
        history.replaceState(previousState, '', previousHref);
        history.pushState(currentState, '', currentHref);
        const onClose = vi.fn();
        vi.spyOn(JC.core.refreshSafety!, 'holdElement').mockImplementation(() => {
            throw new Error('modal accessibility setup failed');
        });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const back = vi.spyOn(history, 'back')
            .mockImplementationOnce(() => {
                throw new DOMException('History traversal denied', 'SecurityError');
            })
            .mockImplementation(() => undefined);
        const handle = JC.seerrModal!.create({
            title: 'Rejected setup and traversal',
            subtitle: 'History already published',
            bodyHtml: '<p>Must preserve the next real Back.</p>',
            onSave: vi.fn(),
            onClose,
        });

        expect(() => handle.show()).toThrow('modal accessibility setup failed');
        vi.advanceTimersByTime(0);
        const marker = markerOf(history.state);
        expect(marker).not.toBeNull();
        expect(handle.modalElement.isConnected).toBe(false);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(historyOwnerForTest()?.records.size).toBe(0);
        expect(historyOwnerForTest()?.pendingBaseExit?.token).toBe(marker!.token);

        history.back();
        dispatchPop(marker!.hostState, currentHref);
        expect(back).toHaveBeenCalledTimes(3);
        dispatchPop(previousState, previousHref);

        expect(history.state).toEqual(previousState);
        expect(location.href).toBe(new URL(previousHref, location.origin).href);
        expect(historyOwnerForTest()?.pendingBaseExit).toBeNull();
        expect(historyOwnerForTest()?.knownTokens).not.toContain(marker!.token);
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('keeps the modal owned when its Back is rejected so a real Back can consume it', () => {
        const currentState: unknown = history.state;
        const currentHref = location.href;
        const previousState = { host: 'previous-route' };
        const previousHref = '/web/index.html#/previous-route';
        history.replaceState(previousState, '', previousHref);
        history.pushState(currentState, '', currentHref);
        const onClose = vi.fn();
        const shown = showModal(onClose);
        vi.spyOn(history, 'back').mockImplementation(() => {
            throw new DOMException('History traversal denied', 'SecurityError');
        });

        shown.handle.close();
        vi.advanceTimersByTime(0);

        expect(history.state).toEqual(shown.modalState);
        expect(shown.handle.modalElement.isConnected).toBe(true);
        expect(onClose).not.toHaveBeenCalled();
        expect(historyOwnerForTest()?.records.size).toBe(1);
        expect(historyOwnerForTest()?.knownTokens).toContain(shown.marker.token);
        expect(historyOwnerForTest()?.pendingBidirectional.has(shown.marker.token)).toBe(false);
        expect(isAnyModalOpen()).toBe(true);

        // The first real browser Back consumes the still-owned marker and
        // closes the modal visibly; the following Back reaches the predecessor
        // instead of stopping on a marker rewritten to resemble the host.
        dispatchPop(currentState, currentHref);
        vi.advanceTimersByTime(300);
        expect(shown.handle.modalElement.isConnected).toBe(false);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(historyOwnerForTest()?.records.size).toBe(0);
        expect(historyOwnerForTest()?.knownTokens).not.toContain(shown.marker.token);
        expect(isAnyModalOpen()).toBe(false);

        dispatchPop(previousState, previousHref);
        expect(history.state).toEqual(previousState);
        expect(location.href).toBe(new URL(previousHref, location.origin).href);
    });

    it.each([
        ['closeAll', () => JC.seerrModal!.closeAll()],
        ['identity reset', () => JC.identity.transition(
            'history-server-b',
            'history-user-b',
            'rejected teardown traversal'
        )],
        ['config reset', () => window.dispatchEvent(new Event('jc:config-changed'))],
    ] as const)('%s teardown preserves one-action Back when its immediate traversal is rejected', (_label, teardown) => {
        const currentState: unknown = history.state;
        const currentHref = location.href;
        const previousState = { host: 'true-predecessor' };
        const previousHref = '/web/index.html#/true-predecessor';
        history.replaceState(previousState, '', previousHref);
        history.pushState(currentState, '', currentHref);
        const onClose = vi.fn();
        const shown = showModal(onClose);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const back = vi.spyOn(history, 'back')
            .mockImplementationOnce(() => {
                throw new DOMException('History traversal denied', 'SecurityError');
            })
            .mockImplementation(() => undefined);
        const hostRouter = vi.fn();
        window.addEventListener('popstate', hostRouter);

        try {
            teardown();
            vi.advanceTimersByTime(0);

            expect(back).toHaveBeenCalledTimes(1);
            expect(onClose).toHaveBeenCalledTimes(1);
            expect(shown.handle.modalElement.isConnected).toBe(false);
            expect(history.state).toEqual(shown.modalState);
            expect(historyOwnerForTest()?.records.size).toBe(0);
            expect(historyOwnerForTest()?.pendingBaseExit?.token).toBe(shown.marker.token);

            // One user Back first crosses the same-URL base. The retained owner
            // keeps that transient pop private and continues to the true route.
            history.back();
            dispatchPop(shown.baseState, currentHref);
            expect(back).toHaveBeenCalledTimes(3);
            expect(hostRouter).not.toHaveBeenCalled();
            dispatchPop(previousState, previousHref);

            expect(history.state).toEqual(previousState);
            expect(location.href).toBe(new URL(previousHref, location.origin).href);
            expect(hostRouter).toHaveBeenCalledTimes(1);
            expect(historyOwnerForTest()?.pendingBaseExit).toBeNull();
            expect(historyOwnerForTest()?.knownTokens).not.toContain(shown.marker.token);
            expect(onClose).toHaveBeenCalledTimes(1);
            expect(warn).toHaveBeenCalledTimes(1);
        } finally {
            window.removeEventListener('popstate', hostRouter);
        }
    });

    it('walks every retired nested marker after closeAll Back is rejected', () => {
        const currentState: unknown = history.state;
        const currentHref = location.href;
        const previousState = { host: 'nested-true-predecessor' };
        const previousHref = '/web/index.html#/nested-true-predecessor';
        history.replaceState(previousState, '', previousHref);
        history.pushState(currentState, '', currentHref);
        const outerClose = vi.fn();
        const innerClose = vi.fn();
        const outer = showModal(outerClose);
        const inner = showModal(innerClose);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const back = vi.spyOn(history, 'back')
            .mockImplementationOnce(() => {
                throw new DOMException('History traversal denied', 'SecurityError');
            })
            .mockImplementation(() => undefined);
        const hostRouter = vi.fn();
        window.addEventListener('popstate', hostRouter);

        try {
            JC.seerrModal!.closeAll();
            vi.advanceTimersByTime(0);

            expect(back).toHaveBeenCalledTimes(1);
            expect(outerClose).toHaveBeenCalledTimes(1);
            expect(innerClose).toHaveBeenCalledTimes(1);
            expect(outer.handle.modalElement.isConnected).toBe(false);
            expect(inner.handle.modalElement.isConnected).toBe(false);
            expect(historyOwnerForTest()?.pendingBaseExit?.token).toBe(inner.marker.token);

            history.back();
            dispatchPop(outer.modalState, currentHref);
            expect(back).toHaveBeenCalledTimes(3);
            expect(hostRouter).not.toHaveBeenCalled();
            expect(historyOwnerForTest()?.pendingBaseExit?.token).toBe(outer.marker.token);
            dispatchPop(outer.baseState, currentHref);
            expect(back).toHaveBeenCalledTimes(4);
            expect(hostRouter).not.toHaveBeenCalled();
            dispatchPop(previousState, previousHref);

            expect(history.state).toEqual(previousState);
            expect(location.href).toBe(new URL(previousHref, location.origin).href);
            expect(hostRouter).toHaveBeenCalledTimes(1);
            expect(historyOwnerForTest()?.pendingBaseExit).toBeNull();
            expect(historyOwnerForTest()?.knownTokens).not.toContain(inner.marker.token);
            expect(historyOwnerForTest()?.knownTokens).not.toContain(outer.marker.token);
            expect(warn).toHaveBeenCalledTimes(1);
        } finally {
            window.removeEventListener('popstate', hostRouter);
        }
    });

    it('does not continue a deferred base exit past an intervening real route', () => {
        const originalState: unknown = history.state;
        const originalHref = location.href;
        const onClose = vi.fn();
        const shown = showModal(onClose);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const back = vi.spyOn(history, 'back')
            .mockImplementationOnce(() => {
                throw new DOMException('History traversal denied', 'SecurityError');
            })
            .mockImplementation(() => undefined);
        const forward = vi.spyOn(history, 'forward').mockImplementation(() => undefined);
        const newerState = { host: 'intervening-newer-route' };
        const newerHref = '/web/index.html#/intervening-newer-route';
        const hostRouter = vi.fn();
        window.addEventListener('popstate', hostRouter);

        try {
            JC.seerrModal!.closeAll();
            vi.advanceTimersByTime(0);
            expect(historyOwnerForTest()?.pendingBaseExit?.token).toBe(shown.marker.token);
            history.pushState(newerState, '', newerHref);

            // Back from B reaches the marker rather than its expected base.
            // That mismatch cancels the deferred base exit and promotes the
            // marker for ordinary two-way skipping, so this action stops at A.
            history.back();
            dispatchPop(shown.modalState, originalHref);
            const promotedModalState: unknown = history.state;
            expect(back).toHaveBeenCalledTimes(3);
            expect(hostRouter).not.toHaveBeenCalled();
            dispatchPop(originalState, originalHref);

            expect(history.state).toEqual(originalState);
            expect(location.href).toBe(originalHref);
            expect(hostRouter).toHaveBeenCalledTimes(1);
            expect(historyOwnerForTest()?.pendingBaseExit).toBeNull();

            history.forward();
            dispatchPop(promotedModalState, originalHref);
            expect(forward).toHaveBeenCalledTimes(2);
            expect(hostRouter).toHaveBeenCalledTimes(1);
            dispatchPop(newerState, newerHref);

            expect(history.state).toEqual(newerState);
            expect(location.href).toBe(new URL(newerHref, location.origin).href);
            expect(hostRouter).toHaveBeenCalledTimes(2);
            expect(onClose).toHaveBeenCalledTimes(1);
            expect(warn).toHaveBeenCalledTimes(1);
        } finally {
            window.removeEventListener('popstate', hostRouter);
        }
    });

    it('cancels a deferred base exit when replaceState removes its current marker', () => {
        const currentState: unknown = history.state;
        const currentHref = location.href;
        const previousState = { host: 'replacement-true-predecessor' };
        const previousHref = '/web/index.html#/replacement-true-predecessor';
        history.replaceState(previousState, '', previousHref);
        history.pushState(currentState, '', currentHref);
        const shown = showModal();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const back = vi.spyOn(history, 'back')
            .mockImplementationOnce(() => {
                throw new DOMException('History traversal denied', 'SecurityError');
            })
            .mockImplementation(() => undefined);
        const replacementState = { host: 'replacement-route' };
        const replacementHref = '/web/index.html#/replacement-route';
        const hostRouter = vi.fn();
        window.addEventListener('popstate', hostRouter);

        try {
            JC.seerrModal!.closeAll();
            vi.advanceTimersByTime(0);
            expect(historyOwnerForTest()?.pendingBaseExit?.token).toBe(shown.marker.token);

            history.replaceState(replacementState, '', replacementHref);
            expect(historyOwnerForTest()?.pendingBaseExit).toBeNull();
            expect(historyOwnerForTest()?.knownTokens).not.toContain(shown.marker.token);

            history.back();
            dispatchPop(currentState, currentHref);

            expect(back).toHaveBeenCalledTimes(2);
            expect(history.state).toEqual(currentState);
            expect(location.href).toBe(currentHref);
            expect(hostRouter).toHaveBeenCalledTimes(1);
            expect(warn).toHaveBeenCalledTimes(1);
        } finally {
            window.removeEventListener('popstate', hostRouter);
        }
    });

    it('clears a bypassed marker replacement when a new generation installs', async () => {
        const currentState: unknown = history.state;
        const currentHref = location.href;
        const shown = showModal();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const back = vi.spyOn(history, 'back')
            .mockImplementationOnce(() => {
                throw new DOMException('History traversal denied', 'SecurityError');
            })
            .mockImplementation(() => undefined);
        const replacementState = { host: 'bypassed-replacement-route' };
        const replacementHref = '/web/index.html#/bypassed-replacement-route';

        JC.seerrModal!.closeAll();
        vi.advanceTimersByTime(0);
        expect(historyOwnerForTest()?.pendingBaseExit?.token).toBe(shown.marker.token);
        History.prototype.replaceState.call(history, replacementState, '', replacementHref);
        expect(historyOwnerForTest()?.pendingBaseExit?.token).toBe(shown.marker.token);

        vi.resetModules();
        const nextGeneration = await import('./modal');
        const uninstallNext = nextGeneration.installSeerrModal();
        try {
            expect(historyOwnerForTest()?.pendingBaseExit).toBeNull();

            history.back();
            dispatchPop(currentState, currentHref);

            expect(back).toHaveBeenCalledTimes(2);
            expect(history.state).toEqual(currentState);
            expect(location.href).toBe(currentHref);
            expect(warn).toHaveBeenCalledTimes(1);
        } finally {
            uninstallNext();
        }
    });

    it('still closes and skips a private marker when an earlier router makes retagging fail', () => {
        const onClose = vi.fn();
        const shown = showModal(onClose);
        const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
        history.replaceState({ host: 'router-replacement' }, '', location.href);
        vi.spyOn(History.prototype, 'replaceState').mockImplementation(() => {
            throw new DOMException('History replacement denied', 'SecurityError');
        });

        window.dispatchEvent(new PopStateEvent('popstate', { state: shown.modalState }));

        expect(back).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(isAnyModalOpen()).toBe(false);
        expect(historyOwnerForTest()?.records.size).toBe(0);
    });

    it('keeps Back and Forward reachable when marker retagging is rejected', () => {
        const originalState: unknown = history.state;
        const originalHref = location.href;
        const onClose = vi.fn();
        const shown = showModal(onClose);
        history.pushState({ host: 'newer-route' }, '', '/web/index.html#/newer-route');
        const newerState: unknown = history.state;
        const newerHref = location.href;
        const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
        const forward = vi.spyOn(history, 'forward').mockImplementation(() => undefined);

        // Model Back from B to the still-terminal private marker, then deny the
        // attempt to encode its opposite direction into that marker.
        history.replaceState(shown.modalState, '', originalHref);
        const replace = vi.spyOn(History.prototype, 'replaceState').mockImplementation(() => {
            throw new DOMException('History replacement denied', 'SecurityError');
        });
        window.dispatchEvent(new PopStateEvent('popstate', { state: shown.modalState }));

        expect(back).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(historyOwnerForTest()?.pendingBidirectional.get(shown.marker.token)).toBe('forward');

        replace.mockRestore();
        dispatchPop(originalState, originalHref);
        dispatchPop(shown.modalState, originalHref);

        expect(forward).toHaveBeenCalledTimes(1);
        expect(historyOwnerForTest()?.pendingBidirectional.has(shown.marker.token)).toBe(false);
        dispatchPop(newerState, newerHref);
        expect(history.state).toEqual(newerState);
        expect(location.href).toBe(newerHref);
    });

    it('closing a buried outer modal preserves focus and ownership of the live inner modal', () => {
        const trigger = document.createElement('button');
        trigger.textContent = 'Open outer';
        document.body.appendChild(trigger);
        trigger.focus();
        const outer = showModal();
        const outerControl = outer.handle.modalElement.querySelector<HTMLButtonElement>('.seerr-modal-button-secondary')!;
        expect(document.activeElement).toBe(outerControl);
        const inner = showModal();
        const innerControl = inner.handle.modalElement.querySelector<HTMLButtonElement>('.seerr-modal-button-secondary')!;
        expect(document.activeElement).toBe(innerControl);
        const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);

        outer.handle.close();

        expect(back).not.toHaveBeenCalled();
        expect(outer.handle.modalElement.isConnected).toBe(true);
        expect(inner.handle.modalElement.isConnected).toBe(true);
        expect(document.activeElement).toBe(innerControl);
        expect(isAnyModalOpen()).toBe(true);
        expect(document.body.classList.contains('jc-modal-open')).toBe(true);
        expect(document.body.classList.contains('seerr-modal-is-open')).toBe(true);

        inner.handle.close();
        dispatchPop(outer.modalState);
        dispatchPop(outer.baseState);
        expect(document.activeElement).toBe(trigger);
        vi.advanceTimersByTime(300);
        expect(outer.handle.modalElement.isConnected).toBe(false);
        expect(inner.handle.modalElement.isConnected).toBe(false);
        expect(isAnyModalOpen()).toBe(false);
    });

    it('never navigates over repeated host replacements and records their unresolved markers', () => {
        const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
        for (let iteration = 0; iteration < 12; iteration++) {
            const shown = showModal();
            history.replaceState({ host: 'replacement', iteration }, '', `#/replacement-${iteration}`);
            shown.handle.close();
            vi.advanceTimersByTime(300);
        }

        const persisted = JSON.parse(sessionStorage.getItem(HISTORY_LEDGER_KEY) ?? '{}') as {
            knownTokens?: unknown[];
            pending?: unknown[];
        };
        expect(back).not.toHaveBeenCalled();
        expect(historyOwnerForTest()?.knownTokens).toHaveLength(12);
        expect(historyOwnerForTest()?.pendingBidirectional.size).toBe(12);
        expect(persisted.knownTokens).toHaveLength(12);
        expect(persisted.pending).toHaveLength(12);
    });

    it('bounds both in-memory and persisted bidirectional ledgers under repeated buried modals', () => {
        for (let iteration = 0; iteration < 129; iteration++) {
            const shown = showModal();
            history.pushState({ host: 'newer-route', iteration }, '', `#/newer-${iteration}`);
            shown.handle.close();
            vi.advanceTimersByTime(300);
        }

        const persisted = JSON.parse(sessionStorage.getItem(HISTORY_LEDGER_KEY) ?? '{}') as {
            knownTokens?: unknown[];
            pending?: unknown[];
        };
        expect(historyOwnerForTest()?.records.size).toBe(0);
        expect(historyOwnerForTest()?.knownTokens).toHaveLength(128);
        expect(historyOwnerForTest()?.pendingBidirectional.size).toBe(128);
        expect(persisted.knownTokens).toHaveLength(128);
        expect(persisted.pending).toHaveLength(128);
    }, 30_000);

    it('normalizes a pre-invariant live record during hot-generation handoff', async () => {
        const onClose = vi.fn();
        const shown = showModal(onClose);
        const owner = historyOwnerForTest()!;
        const legacyRecord = owner.records.get(shown.marker.token) as Record<string, unknown>;
        Reflect.deleteProperty(legacyRecord, 'hostState');
        Reflect.deleteProperty(legacyRecord, 'hostStateFingerprint');
        Reflect.deleteProperty(legacyRecord, 'hostHref');
        Reflect.deleteProperty(legacyRecord, 'buriedByHost');
        Reflect.deleteProperty(legacyRecord, 'hostMutationObserved');
        Reflect.deleteProperty(legacyRecord, 'pendingOwnedBack');

        vi.resetModules();
        const nextGeneration = await import('./modal');
        const uninstallNext = nextGeneration.installSeerrModal();
        try {
            expect(legacyRecord.hostState).toEqual(shown.baseState);
            expect(legacyRecord.hostHref).toBe(location.href);
            expect(legacyRecord.buriedByHost).toBe(false);
            expect(legacyRecord.hostMutationObserved).toBe(false);
            expect(legacyRecord.pendingOwnedBack).toBe(false);

            dispatchPop(structuredClone(shown.baseState));
            expect(onClose).toHaveBeenCalledTimes(1);
            expect(owner.records.has(shown.marker.token)).toBe(false);
        } finally {
            uninstallNext();
        }
    });

    it('hands document-global records and the single popstate delegate to a hot chunk generation', async () => {
        const onClose = vi.fn();
        const shown = showModal(onClose);
        const oldOwner = historyOwnerForTest()!;
        const oldListener = oldOwner.listener;
        const removeListener = vi.spyOn(window, 'removeEventListener');
        const addListener = vi.spyOn(window, 'addEventListener');

        vi.resetModules();
        const nextGeneration = await import('./modal');
        const uninstallNext = nextGeneration.installSeerrModal();
        try {
            expect(historyOwnerForTest()).toBe(oldOwner);
            expect(historyOwnerForTest()?.listener).not.toBe(oldListener);
            expect(removeListener).toHaveBeenCalledWith('popstate', oldListener, true);
            expect(addListener.mock.calls.filter(([type]) => type === 'popstate')).toHaveLength(1);

            window.dispatchEvent(new Event('jc:config-changed'));

            expect(onClose).toHaveBeenCalledTimes(1);
            expect(shown.handle.modalElement.isConnected).toBe(false);
            expect(historyOwnerForTest()?.records.size).toBe(0);
            expect(isAnyModalOpen()).toBe(false);
        } finally {
            uninstallNext();
        }
    });

    it('does not let stale handles or teardown reclaim a newer chunk generation', async () => {
        const staleUnshownClose = vi.fn();
        const staleUnshown = JC.seerrModal!.create({
            title: 'Stale unshown modal',
            subtitle: 'Old generation',
            bodyHtml: '<p>Must remain retired.</p>',
            onSave: vi.fn(),
            onClose: staleUnshownClose,
        });

        vi.resetModules();
        const nextGeneration = await import('./modal');
        const uninstallNext = nextGeneration.installSeerrModal();
        const nextClose = vi.fn();
        const next = JC.seerrModal!.create({
            title: 'Current modal',
            subtitle: 'New generation',
            bodyHtml: '<p>Must remain owned.</p>',
            onSave: vi.fn(),
            onClose: nextClose,
        });
        next.show();
        const nextListener = historyOwnerForTest()?.listener;

        try {
            staleUnshown.show();
            expect(staleUnshown.modalElement.isConnected).toBe(false);
            expect(staleUnshownClose).toHaveBeenCalledTimes(1);
            expect(historyOwnerForTest()?.listener).toBe(nextListener);

            uninstall();

            expect(next.modalElement.isConnected).toBe(true);
            expect(nextClose).not.toHaveBeenCalled();
            expect(historyOwnerForTest()?.records.size).toBe(1);
            expect(historyOwnerForTest()?.listener).toBe(nextListener);
        } finally {
            uninstallNext();
        }
    });

    it('keeps the shared modal gate while an old generation closes beneath a newer modal', async () => {
        const oldClose = vi.fn();
        const old = showModal(oldClose);
        vi.spyOn(history, 'back').mockImplementation(() => undefined);

        vi.resetModules();
        const nextGeneration = await import('./modal');
        const nextA11y = await import('../core/modal-a11y');
        const uninstallNext = nextGeneration.installSeerrModal();
        const currentClose = vi.fn();
        const current = JC.seerrModal!.create({
            title: 'Current generation modal',
            subtitle: 'Shared accessibility owner',
            bodyHtml: '<p>The shortcut gate must remain active.</p>',
            onSave: vi.fn(),
            onClose: currentClose,
        });
        current.show();

        try {
            old.handle.close();
            vi.advanceTimersByTime(300);

            expect(oldClose).toHaveBeenCalledTimes(1);
            expect(old.handle.modalElement.isConnected).toBe(false);
            expect(currentClose).not.toHaveBeenCalled();
            expect(current.modalElement.isConnected).toBe(true);
            expect(isAnyModalOpen()).toBe(true);
            expect(nextA11y.isAnyModalOpen()).toBe(true);
            expect(document.body.classList.contains('jc-modal-open')).toBe(true);
        } finally {
            uninstallNext();
        }
    });

    it('adopts and retires a current marker after a document-generation reload', async () => {
        const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
        const shown = showModal();
        const oldOwner = historyOwnerForTest()!;

        // Model document teardown: the old DOM/closure is gone, while the
        // browser entry and session ledger survive into the next generation.
        JC.seerrModal!.closeAll();
        vi.advanceTimersByTime(0);
        expect(back).toHaveBeenCalledTimes(1);
        if (oldOwner.listener) window.removeEventListener('popstate', oldOwner.listener, true);
        delete (window as unknown as Record<string, TestHistoryOwner | undefined>)[HISTORY_GLOBAL_KEY];

        vi.resetModules();
        const nextGeneration = await import('./modal');
        const uninstallNext = nextGeneration.installSeerrModal();
        try {
            expect(back).toHaveBeenCalledTimes(2);
            dispatchPop(shown.baseState);
            expect(history.state).toEqual(shown.baseState);
            expect(historyOwnerForTest()?.records.size).toBe(0);
        } finally {
            uninstallNext();
        }
    });

    it('preserves one-action Back when reload adoption cannot retag or traverse', async () => {
        const currentState: unknown = history.state;
        const currentHref = location.href;
        const previousState = { host: 'reload-true-predecessor' };
        const previousHref = '/web/index.html#/reload-true-predecessor';
        history.replaceState(previousState, '', previousHref);
        history.pushState(currentState, '', currentHref);
        const back = vi.spyOn(history, 'back')
            .mockImplementationOnce(() => undefined)
            .mockImplementationOnce(() => {
                throw new DOMException('History traversal denied', 'SecurityError');
            })
            .mockImplementation(() => undefined);
        const forward = vi.spyOn(history, 'forward').mockImplementation(() => undefined);
        const shown = showModal();
        const oldOwner = historyOwnerForTest()!;
        const rejectedModalState = {
            ...shown.modalState,
            [HISTORY_STATE_KEY]: {
                ...shown.marker,
                traversal: 'bidirectional',
                nextDirection: 'back',
            },
        };
        const newerState = { host: 'reload-newer-route' };
        const newerHref = '/web/index.html#/reload-newer-route';

        // The old generation accepted its teardown request, but its async
        // traversal never arrived before reload. Model a bidirectional marker
        // so adoption must both retag and traverse it.
        JC.seerrModal!.closeAll();
        vi.advanceTimersByTime(0);
        expect(back).toHaveBeenCalledTimes(1);
        history.replaceState(rejectedModalState, '', currentHref);
        if (oldOwner.listener) window.removeEventListener('popstate', oldOwner.listener, true);
        delete (window as unknown as Record<string, TestHistoryOwner | undefined>)[HISTORY_GLOBAL_KEY];

        vi.resetModules();
        const nextGeneration = await import('./modal');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const replace = vi.spyOn(History.prototype, 'replaceState').mockImplementation(() => {
            throw new DOMException('History replacement denied', 'SecurityError');
        });
        const uninstallNext = nextGeneration.installSeerrModal();
        try {
            expect(back).toHaveBeenCalledTimes(2);
            expect(replace).toHaveBeenCalledTimes(1);
            expect(historyOwnerForTest()?.pendingBaseExit?.token).toBe(shown.marker.token);
            expect(historyOwnerForTest()?.pendingBaseExit?.nextDirectionAfterBack).toBe('forward');

            replace.mockRestore();
            history.back();
            dispatchPop(shown.baseState, currentHref);
            expect(back).toHaveBeenCalledTimes(4);
            dispatchPop(previousState, previousHref);

            expect(history.state).toEqual(previousState);
            expect(location.href).toBe(new URL(previousHref, location.origin).href);
            expect(historyOwnerForTest()?.pendingBaseExit).toBeNull();
            expect(historyOwnerForTest()?.knownTokens).toContain(shown.marker.token);
            expect(historyOwnerForTest()?.pendingBidirectional.get(shown.marker.token)).toBe('forward');
            expect(historyOwnerForTest()?.records.size).toBe(0);

            // The delayed successful Back must commit the opposite direction
            // even though retagging failed, so Forward can still cross M to B.
            dispatchPop(shown.baseState, currentHref);
            dispatchPop(rejectedModalState, currentHref);
            expect(forward).toHaveBeenCalledTimes(1);
            expect(historyOwnerForTest()?.knownTokens).not.toContain(shown.marker.token);
            expect(historyOwnerForTest()?.pendingBidirectional.has(shown.marker.token)).toBe(false);
            dispatchPop(newerState, newerHref);
            expect(history.state).toEqual(newerState);
            expect(location.href).toBe(new URL(newerHref, location.origin).href);
            expect(warn).toHaveBeenCalledTimes(2);
        } finally {
            uninstallNext();
        }
    });
});
