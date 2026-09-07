import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import '../../core/lifecycle';
import '../../core/navigation';
import '../../core/dom-observer';
import type { PageDescriptor } from './types';
import { registerPage } from './registry';
import {
    adoptOrRefreshCurrent, adoptedPageId, currentPageOwner, drain,
    initFallbackHost, lateAdoptIfOnPage,
} from './fallback-host';

describe('routed page document lifetime', () => {
    let signals: AbortSignal[];
    let clicks: ReturnType<typeof vi.fn<() => void>>;
    let hides: ReturnType<typeof vi.fn<() => void>>;
    let unregister: () => void;
    let descriptor: PageDescriptor;

    function navigate(hash: string): void {
        window.location.hash = hash;
        window.dispatchEvent(new Event('hashchange'));
    }

    function transition(type: 'pagehide' | 'pageshow', persisted: boolean): void {
        // Native window page transitions use Document as their target. Bubble
        // from it here to reach the window listener with that browser shape.
        document.dispatchEvent(new PageTransitionEvent(type, { persisted, bubbles: true }));
    }

    function mount(): HTMLElement {
        const host = document.createElement('div');
        host.id = 'fallbackPage';
        document.body.append(host);
        lateAdoptIfOnPage();
        return host;
    }

    beforeAll(() => initFallbackHost());

    beforeEach(() => {
        navigate('#/home');
        transition('pageshow', true);
        signals = [];
        clicks = vi.fn();
        hides = vi.fn();
        descriptor = {
            id: 'document-test', route: '/document-test', titleKey: 'document-test',
            titleFallback: 'Document test', icon: 'calendar_today', isEnabled: () => true,
            render({ host, handle, signal }) {
                signals.push(signal);
                const button = document.createElement('button');
                button.textContent = 'Owned control';
                host.append(button);
                handle.addListener(button, 'click', clicks);
            },
            onHide: hides,
        };
        unregister = registerPage(descriptor);
        navigate('#/document-test');
    });

    afterEach(() => {
        unregister();
        navigate('#/home');
        drain('test-cleanup');
        document.getElementById('fallbackPage')?.remove();
        transition('pageshow', true);
        vi.restoreAllMocks();
    });

    it.each([false, true])('retires request and listener ownership on pagehide (persisted=%s)', (persisted) => {
        const host = mount();
        const button = host.querySelector('button')!;
        const owner = currentPageOwner(descriptor.id);
        button.click();
        expect(clicks).toHaveBeenCalledTimes(1);

        transition('pagehide', persisted);

        expect(signals[0].aborted).toBe(true);
        expect(adoptedPageId()).toBeNull();
        expect(currentPageOwner(descriptor.id)).not.toBe(owner);
        expect(hides).toHaveBeenCalledTimes(1);
        expect(host.childElementCount).toBe(0);
        button.click();
        expect(clicks).toHaveBeenCalledTimes(1);
        transition('pagehide', persisted);
        expect(hides).toHaveBeenCalledTimes(1);
    });

    it('does not retire a page on cancellable beforeunload or ordinary pageshow', () => {
        const host = mount();
        const owner = currentPageOwner(descriptor.id);
        window.dispatchEvent(new Event('beforeunload', { cancelable: true }));
        host.dispatchEvent(new PageTransitionEvent('pagehide', { bubbles: true, persisted: true }));
        transition('pageshow', false);
        expect(currentPageOwner(descriptor.id)).toBe(owner);
        expect(signals[0].aborted).toBe(false);
        expect(hides).not.toHaveBeenCalled();
    });

    it('blocks mutation, navigation and lazy activation from reviving a retired document', async () => {
        const host = mount();
        transition('pagehide', true);
        // Teardown or an already-queued producer can mutate the still-connected
        // host before Chromium freezes it. None may create a replacement owner.
        host.replaceChildren(document.createElement('span'));
        host.classList.remove('jc-page-host');
        host.dispatchEvent(new CustomEvent('viewbeforeshow', { bubbles: true }));
        navigate('#/home');
        navigate('#/document-test');
        lateAdoptIfOnPage();
        adoptOrRefreshCurrent(descriptor);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(signals).toHaveLength(1);
        expect(adoptedPageId()).toBeNull();

        transition('pageshow', false);
        host.dispatchEvent(new PageTransitionEvent('pageshow', { bubbles: true, persisted: true }));
        expect(signals).toHaveLength(1);
    });

    it('restores a persisted document with fresh work and controls, without writing history', () => {
        const host = mount();
        const oldOwner = currentPageOwner(descriptor.id);
        const oldButton = host.querySelector('button')!;
        transition('pagehide', true);
        const push = vi.spyOn(window.history, 'pushState');
        const replace = vi.spyOn(window.history, 'replaceState');

        transition('pageshow', true);

        expect(signals).toHaveLength(2);
        expect(signals[0].aborted).toBe(true);
        expect(signals[1].aborted).toBe(false);
        expect(currentPageOwner(descriptor.id)).not.toBe(oldOwner);
        oldButton.click();
        expect(clicks).not.toHaveBeenCalled();
        host.querySelector('button')!.click();
        expect(clicks).toHaveBeenCalledTimes(1);
        transition('pageshow', true);
        expect(signals).toHaveLength(2);
        expect(push).not.toHaveBeenCalled();
        expect(replace).not.toHaveBeenCalled();

        transition('pagehide', true);
        transition('pageshow', true);
        expect(signals).toHaveLength(3);
        expect(signals[1].aborted).toBe(true);
        expect(signals[2].aborted).toBe(false);
        host.querySelector('button')!.click();
        expect(clicks).toHaveBeenCalledTimes(2);
        expect(hides).toHaveBeenCalledTimes(2);
    });

    it('resolves the current descriptor and config again when a persisted document returns', () => {
        const host = mount();
        transition('pagehide', true);
        const replacementRender = vi.fn();
        let enabled = false;
        const removeReplacement = registerPage({ ...descriptor,
            render: replacementRender, isEnabled: () => enabled,
        });
        try {
            transition('pageshow', true);
            expect(adoptedPageId()).toBeNull();
            expect(replacementRender).not.toHaveBeenCalled();
            expect(host.childElementCount).toBe(0);
            enabled = true;
            lateAdoptIfOnPage();
            expect(replacementRender).toHaveBeenCalledTimes(1);
            expect(signals).toHaveLength(1);
        } finally {
            removeReplacement();
        }
    });

    it('does not revive an unregistered route after persisted pagehide', () => {
        mount();
        transition('pagehide', true);
        unregister();
        transition('pageshow', true);
        expect(adoptedPageId()).toBeNull();
        expect(signals).toHaveLength(1);
    });

    it('waits for a new host if the restored document no longer contains the old one', () => {
        const host = mount();
        transition('pagehide', true);
        host.remove();
        transition('pageshow', true);
        expect(adoptedPageId()).toBeNull();
        mount();
        expect(signals).toHaveLength(2);
        expect(signals[1].aborted).toBe(false);
    });

    it('uses the signed-out shell when authentication is absent on restoration', () => {
        const host = mount();
        transition('pagehide', true);
        vi.spyOn(window.ApiClient, 'getCurrentUserId').mockReturnValue('');
        transition('pageshow', true);
        expect(host.querySelector('.jc-page-signin')).not.toBeNull();
        expect(signals).toHaveLength(1);
    });

    it('discards administrator content when elevation is absent on restoration', () => {
        const previousUser = JC.currentUser;
        descriptor.adminOnly = true;
        try {
            JC.currentUser = { Policy: { IsAdministrator: true } };
            const host = mount();
            expect(signals).toHaveLength(1);
            transition('pagehide', true);
            JC.currentUser = { Policy: { IsAdministrator: false } };
            transition('pageshow', true);
            expect(adoptedPageId()).toBeNull();
            expect(signals).toHaveLength(1);
            expect(host.childElementCount).toBe(0);
        } finally {
            JC.currentUser = previousUser;
        }
    });
});
