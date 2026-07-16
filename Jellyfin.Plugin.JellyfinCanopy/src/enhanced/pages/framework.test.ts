// Framework state-machine tests: adoption, teardown, page→page swap, the
// disconnect backstop, late-adopt idempotence, ghost-killing, gating, and
// registry resolution — driven through the REAL document events and hash
// changes the framework wires itself to, not by poking private handlers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import '../../core/lifecycle';
import '../../core/navigation';
import '../../core/dom-observer';
import { registerPage, resolvePage, orderedPages } from './registry';
import { initFallbackHost, adoptedPageId, drain, lateAdoptIfOnPage } from './fallback-host';

/* eslint-disable @typescript-eslint/no-explicit-any */

let renders: string[] = [];
let disposes: string[] = [];
let hides: string[] = [];

function makeDescriptor(id: string, enabled: () => boolean = () => true) {
    return {
        id,
        route: `/${id}`,
        titleKey: `${id}_title`,
        titleFallback: id.toUpperCase(),
        icon: 'extension',
        isEnabled: enabled,
        render({ host, handle }: any) {
            renders.push(id);
            const marker = document.createElement('div');
            marker.className = `jc-test-${id}`;
            marker.textContent = `${id} content`;
            host.appendChild(marker);
            handle.track(() => disposes.push(id));
        },
        onHide() { hides.push(id); }
    };
}

function mountFallback(): HTMLElement {
    document.getElementById('fallbackPage')?.remove();
    const el = document.createElement('div');
    el.id = 'fallbackPage';
    el.className = 'page mainAnimatedPage';
    el.innerHTML = '<h1>Page not found</h1>';
    document.body.appendChild(el);
    return el;
}

function fireViewBeforeShow(el: Element): void {
    el.dispatchEvent(new CustomEvent('viewbeforeshow', { bubbles: true }));
}

function setHash(hash: string): void {
    window.location.hash = hash;
    // jsdom does not reliably fire hashchange for programmatic hash writes in
    // all versions — dispatch explicitly like the browser would.
    window.dispatchEvent(new Event('hashchange'));
}

let wired = false;

describe('pages framework', () => {
    beforeEach(() => {
        renders = [];
        disposes = [];
        hides = [];
        (JC.pluginConfig as any).PagesOrder = '';
        registerPage(makeDescriptor('alpha'));
        registerPage(makeDescriptor('beta'));
        registerPage(makeDescriptor('gated', () => false));
        if (!wired) {
            wired = true;
            initFallbackHost();
        }
        setHash('#/home');
        drain('test-reset');
    });

    afterEach(() => {
        drain('test-reset');
        document.getElementById('fallbackPage')?.remove();
    });

    it('adopts the fallback element for a registered route and renders into it', () => {
        setHash('#/alpha');
        const fallback = mountFallback();
        fireViewBeforeShow(fallback);

        expect(adoptedPageId()).toBe('alpha');
        expect(renders).toEqual(['alpha']);
        expect(fallback.querySelector('.jc-test-alpha')).not.toBeNull();
        expect(fallback.textContent).not.toContain('Page not found');
        expect(fallback.getAttribute('data-title')).toBe('ALPHA');
    });

    it('adopts a fallback mounted after navigation without viewbeforeshow', async () => {
        setHash('#/alpha');
        const fallback = mountFallback();

        await vi.waitFor(() => expect(adoptedPageId()).toBe('alpha'));
        expect(renders).toEqual(['alpha']);
        expect(fallback.querySelector('.jc-test-alpha')).not.toBeNull();
        expect(fallback.textContent).not.toContain('Page not found');
    });

    it('rejects a deferred fallback after its page route becomes stale', async () => {
        setHash('#/alpha');
        const fallback = mountFallback();
        setHash('#/home');

        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(adoptedPageId()).toBeNull();
        expect(renders).toEqual([]);
        expect(fallback.textContent).toContain('Page not found');
    });

    it('never adopts for a disabled page or an unregistered route', () => {
        setHash('#/gated');
        const fallback = mountFallback();
        fireViewBeforeShow(fallback);
        expect(adoptedPageId()).toBeNull();
        expect(fallback.textContent).toContain('Page not found');

        setHash('#/nonsense');
        fireViewBeforeShow(fallback);
        expect(adoptedPageId()).toBeNull();
    });

    it('route matching is exact — a prefixed URL is not the page', () => {
        setHash('#/alphabetical');
        expect(resolvePage()).toBeNull();
    });

    it('drains when another view shows: dispose + onHide run, ghost content cannot survive', () => {
        setHash('#/alpha');
        const fallback = mountFallback();
        fireViewBeforeShow(fallback);
        expect(adoptedPageId()).toBe('alpha');

        // Navigate away; the router would normally detach the element — the
        // drain must still clear it even when that never happens (the exact
        // ghost-page failure mode this framework exists to kill).
        setHash('#/home');
        const incoming = document.createElement('div');
        incoming.id = 'indexPage';
        document.body.appendChild(incoming);
        fireViewBeforeShow(incoming);

        expect(adoptedPageId()).toBeNull();
        expect(disposes).toEqual(['alpha']);
        expect(hides).toEqual(['alpha']);
        expect(fallback.querySelector('.jc-test-alpha')).toBeNull();
        incoming.remove();
    });

    it('page→page: the URL swap re-renders in place on the SAME element, draining the old page', () => {
        setHash('#/alpha');
        const fallback = mountFallback();
        fireViewBeforeShow(fallback);
        expect(adoptedPageId()).toBe('alpha');

        setHash('#/beta');

        expect(adoptedPageId()).toBe('beta');
        expect(disposes).toEqual(['alpha']);
        expect(renders).toEqual(['alpha', 'beta']);
        expect(fallback.querySelector('.jc-test-alpha')).toBeNull();
        expect(fallback.querySelector('.jc-test-beta')).not.toBeNull();
    });

    it('disconnect backstop: a wholesale element detach drains without any event', async () => {
        setHash('#/alpha');
        const fallback = mountFallback();
        fireViewBeforeShow(fallback);
        expect(adoptedPageId()).toBe('alpha');

        fallback.remove();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(disposes).toEqual(['alpha']);
        expect(adoptedPageId()).toBeNull();
    });

    it('DOM is the truth: a stale adoption never wedges the next open (the showPage-no-op bug)', () => {
        setHash('#/alpha');
        const first = mountFallback();
        fireViewBeforeShow(first);
        expect(adoptedPageId()).toBe('alpha');

        // The React shell replaces the element with no event and no URL change.
        first.remove();
        const second = mountFallback();
        fireViewBeforeShow(second);

        expect(adoptedPageId()).toBe('alpha');
        expect(second.querySelector('.jc-test-alpha')).not.toBeNull();
        expect(renders).toEqual(['alpha', 'alpha']);
    });

    it('late-adopt is idempotent and never navigates', () => {
        setHash('#/alpha');
        mountFallback();
        const pushSpy = vi.spyOn(window.history, 'pushState');
        const hashBefore = window.location.hash;

        lateAdoptIfOnPage();
        expect(adoptedPageId()).toBe('alpha');
        expect(renders).toEqual(['alpha']);

        lateAdoptIfOnPage();
        lateAdoptIfOnPage();
        expect(renders).toEqual(['alpha']);
        expect(pushSpy).not.toHaveBeenCalled();
        expect(window.location.hash).toBe(hashBefore);
        pushSpy.mockRestore();
    });

    it('renders the signed-out shell instead of content when no session exists', () => {
        const original = window.ApiClient.getCurrentUserId.bind(window.ApiClient);
        (window.ApiClient as any).getCurrentUserId = () => '';
        try {
            setHash('#/alpha');
            const fallback = mountFallback();
            fireViewBeforeShow(fallback);
            expect(adoptedPageId()).toBe('alpha');
            expect(renders).toEqual([]);
            expect(fallback.querySelector('.jc-page-signin')).not.toBeNull();
        } finally {
            (window.ApiClient as any).getCurrentUserId = original;
        }
    });

    it('PagesOrder orders known ids, drops unknown ones, appends missing ones', () => {
        (JC.pluginConfig as any).PagesOrder = 'beta,ghost,alpha';
        const ids = orderedPages().map((d) => d.id);
        expect(ids.indexOf('beta')).toBeLessThan(ids.indexOf('alpha'));
        expect(ids).not.toContain('ghost');
        expect(ids).toContain('gated');
    });
});
