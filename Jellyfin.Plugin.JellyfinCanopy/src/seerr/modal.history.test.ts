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
    adoptionToken: string | null;
}

function historyOwnerForTest(): TestHistoryOwner | undefined {
    return (window as unknown as Record<string, TestHistoryOwner | undefined>)[HISTORY_GLOBAL_KEY];
}

function markerOf(state: unknown): TestHistoryMarker | null {
    if (state === null || typeof state !== 'object') return null;
    return ((state as Record<string, unknown>)[HISTORY_STATE_KEY] as TestHistoryMarker | undefined) ?? null;
}

function dispatchPop(state: unknown, href = location.href): void {
    // A real traversal changes the active entry inside the browser. Bypass
    // instance-level replaceState observers when modelling that transition.
    History.prototype.replaceState.call(history, state, '', href);
    window.dispatchEvent(new PopStateEvent('popstate', { state }));
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
        expect(back).toHaveBeenCalledTimes(1);
        expect(shown.handle.modalElement.isConnected).toBe(true);

        JC.seerrModal!.closeAll();

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
        vi.spyOn(history, 'replaceState').mockImplementation(() => {
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
        const replace = vi.spyOn(history, 'replaceState').mockImplementation(() => {
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
        expect(back).toHaveBeenCalledTimes(1);
        history.replaceState(rejectedModalState, '', currentHref);
        if (oldOwner.listener) window.removeEventListener('popstate', oldOwner.listener, true);
        delete (window as unknown as Record<string, TestHistoryOwner | undefined>)[HISTORY_GLOBAL_KEY];

        vi.resetModules();
        const nextGeneration = await import('./modal');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const replace = vi.spyOn(history, 'replaceState').mockImplementation(() => {
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
