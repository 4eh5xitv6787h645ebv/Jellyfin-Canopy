// Unit test for the auto-skip watcher (ENH-3 / R3 restore).
//
// The v12 client mounts the intro/outro skip button at document.body level
// (jellyfin-web src/components/playback/skipsegment.ts:
// `document.body.insertAdjacentHTML('beforeend', …)`), OUTSIDE
// .videoPlayerContainer. The earlier R3 fix scoped the observer to the player
// container, so it never saw the button and auto-skip stopped firing at all.
// The watcher now rides the shared structural body multiplexer (childList only —
// no body-wide attribute observation, R3) to detect the button, and attaches an
// attribute observer SCOPED to the button node for the show/hide class toggle.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type JEWin = Record<string, any>;

function jeWin(): JEWin {
    return window.JellyfinEnhanced;
}

async function loadPlayback(): Promise<void> {
    await import('../core/dom-observer');
    await import('./playback');
}

function mountSkipButton(text: string, opts: { hidden?: boolean } = {}): HTMLButtonElement {
    const cls = ['skip-button', 'emby-button'];
    if (opts.hidden) cls.push('hide', 'skip-button-hidden');
    document.body.insertAdjacentHTML(
        'beforeend',
        `<div class="skip-button-container"><button is="emby-button" class="${cls.join(' ')}">${text}</button></div>`
    );
    return document.body.querySelector('button.skip-button') as HTMLButtonElement;
}

describe('auto-skip watcher (R3-compliant restore)', () => {
    beforeEach(() => {
        vi.resetModules();
        const JE = jeWin();
        JE.state = { skipToastShown: false };
        JE.currentSettings = { autoSkipIntro: true, autoSkipOutro: true };
        JE.t = (k: string) => k;
        document.body.innerHTML = '';
        document.body.className = '';
    });

    afterEach(() => {
        jeWin().stopAutoSkip?.();
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    it('REGRESSION: fires auto-skip for a skip button mounted at document.body (outside the player container)', async () => {
        const container = document.createElement('div');
        container.className = 'videoPlayerContainer'; // present, but the button is NOT inside it
        document.body.appendChild(container);

        await loadPlayback();
        jeWin().initializeAutoSkipObserver();

        // v12 mounts the (already-visible) skip button at body level.
        const button = mountSkipButton('Skip Intro');
        const clickSpy = vi.spyOn(button, 'click');

        await vi.waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
        expect(jeWin().state.skipToastShown).toBe(true);
    });

    it('fires when the button is inserted hidden and later activated by a class toggle', async () => {
        await loadPlayback();
        jeWin().initializeAutoSkipObserver();

        const button = mountSkipButton('Skip Outro', { hidden: true });
        const clickSpy = vi.spyOn(button, 'click');

        // The watcher is wired, but the button still carries hide/skip-button-hidden.
        await vi.waitFor(() => expect(jeWin().core.dom.getBodySubscriberCount()).toBeGreaterThan(0));
        expect(clickSpy).not.toHaveBeenCalled();

        // The client reveals it — a class attribute toggle on the button node.
        button.classList.remove('hide');
        button.classList.remove('skip-button-hidden');

        await vi.waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
        expect(jeWin().state.skipToastShown).toBe(true);
    });

    it('R3: never observes document.body with attributes; scopes class observation to the button node', async () => {
        const observeSpy = vi.spyOn(MutationObserver.prototype, 'observe');
        await loadPlayback();
        jeWin().initializeAutoSkipObserver();

        const button = mountSkipButton('Skip Intro', { hidden: true });
        await vi.waitFor(() =>
            expect(observeSpy.mock.calls.some(([, o]) => (o as MutationObserverInit)?.attributeFilter)).toBe(true)
        );

        // No body-wide attribute observation anywhere (R3).
        const bodyAttr = observeSpy.mock.calls.find(([t, o]) =>
            t === document.body
            && !!((o as MutationObserverInit)?.attributes || (o as MutationObserverInit)?.attributeFilter));
        expect(bodyAttr).toBeUndefined();

        // The attribute observer is scoped to the skip button node, class-only.
        const attrCall = observeSpy.mock.calls.find(([, o]) => (o as MutationObserverInit)?.attributeFilter);
        expect(attrCall?.[0]).toBe(button);
        expect((attrCall?.[1] as MutationObserverInit).attributeFilter).toEqual(['class']);
        expect((attrCall?.[1] as MutationObserverInit).attributeFilter).not.toContain('style');
    });

    it('stopAutoSkip tears down the body subscriber and the scoped observer', async () => {
        await loadPlayback();
        const dom = jeWin().core.dom;
        const before = dom.getBodySubscriberCount();

        jeWin().initializeAutoSkipObserver();
        mountSkipButton('Skip Intro', { hidden: true });
        await vi.waitFor(() => expect(dom.getBodySubscriberCount()).toBe(before + 1));

        jeWin().stopAutoSkip();
        expect(dom.getBodySubscriberCount()).toBe(before);
    });
});
