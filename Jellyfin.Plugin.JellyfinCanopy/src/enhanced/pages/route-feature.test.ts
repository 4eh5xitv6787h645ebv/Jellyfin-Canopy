import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../arr/arr-globals';
import { createTestFeatureScope } from '../../test/feature-scope';
import { getPage } from './registry';
import { activateRoutePage } from './route-feature';
import { adoptedPageId, drain, initFallbackHost } from './fallback-host';
import '../../core/lifecycle';
import '../../core/navigation';
import './facades';

describe('route-only page feature activation', () => {
    beforeAll(() => { initFallbackHost(); });

    beforeEach(() => {
        drain('test-reset');
        document.getElementById('fallbackPage')?.remove();
        window.location.hash = '#/home';
        window.dispatchEvent(new Event('hashchange'));
        JC.pluginConfig = { CalendarPageEnabled: true };
    });

    it('rejects a stale scope without registration, facade attachment, or cleanup', () => {
        const catalog = getPage('calendar');
        const feature = createTestFeatureScope();
        feature.setCurrent(false);
        const refresh = vi.fn(() => Promise.resolve());
        activateRoutePage(feature.scope, {
            ...catalog!, id: 'calendar', render: vi.fn(), onHide: vi.fn(),
        }, { refresh });

        expect(getPage('calendar')).toBe(catalog);
        expect(feature.cleanups).toHaveLength(0);
        void JC.calendarPage?.refresh();
        expect(refresh).not.toHaveBeenCalled();
    });

    it('attaches behind the stable facade and disposes every attachment exactly once', async () => {
        const stableFacade = JC.calendarPage;
        const stableRefresh = stableFacade?.refresh;
        const catalog = getPage('calendar');
        const reset = vi.fn();
        const refresh = vi.fn(() => Promise.resolve());
        const feature = createTestFeatureScope();
        activateRoutePage(feature.scope, {
            ...catalog!, id: 'calendar', render: vi.fn(), onHide: reset,
        }, { refresh });

        expect(getPage('calendar')).not.toBe(catalog);
        expect(JC.calendarPage).toBe(stableFacade);
        expect(Object.isFrozen(JC.calendarPage)).toBe(true);
        expect(JC.calendarPage?.refresh).toBe(stableRefresh);
        await JC.calendarPage?.refresh();
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(feature.cleanups).toHaveLength(1);

        await feature.dispose();
        await feature.dispose();
        expect(getPage('calendar')).toBe(catalog);
        expect(JC.calendarPage).toBe(stableFacade);
        expect(JC.calendarPage?.refresh).toBe(stableRefresh);
        expect(reset).toHaveBeenCalledTimes(1);
        await JC.calendarPage?.refresh();
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('adopts a fallback that rendered before the delayed route feature activated', async () => {
        const catalog = getPage('calendar');
        const feature = createTestFeatureScope();
        const render = vi.fn(({ host }: { host: HTMLElement }) => {
            const content = document.createElement('section');
            content.id = 'late-calendar-content';
            host.appendChild(content);
        });

        window.location.hash = '#/calendar';
        window.dispatchEvent(new Event('hashchange'));
        const fallback = document.createElement('div');
        fallback.id = 'fallbackPage';
        fallback.textContent = 'Page not found';
        document.body.appendChild(fallback);

        activateRoutePage(feature.scope, {
            ...catalog!, id: 'calendar', render,
        }, {});

        expect(adoptedPageId()).toBe('calendar');
        expect(render).toHaveBeenCalledTimes(1);
        expect(fallback.querySelector('#late-calendar-content')).not.toBeNull();
        expect(fallback.textContent).not.toContain('Page not found');

        await feature.dispose();
    });

    it('never adopts when the generation scope turns stale during attachment', () => {
        const catalog = getPage('calendar');
        const feature = createTestFeatureScope();
        let checks = 0;
        feature.scope.isCurrent = () => ++checks === 1;
        const reset = vi.fn();
        const render = vi.fn();

        window.location.hash = '#/calendar';
        window.dispatchEvent(new Event('hashchange'));
        const fallback = document.createElement('div');
        fallback.id = 'fallbackPage';
        fallback.textContent = 'Page not found';
        document.body.appendChild(fallback);

        activateRoutePage(feature.scope, {
            ...catalog!, id: 'calendar', render, onHide: reset,
        }, {});

        expect(getPage('calendar')).toBe(catalog);
        expect(reset).toHaveBeenCalledTimes(1);
        expect(adoptedPageId()).toBeNull();
        expect(render).not.toHaveBeenCalled();
        expect(fallback.textContent).toBe('Page not found');
    });

    it('navigation drains adoption resources and cluster state exactly once', async () => {
        const catalog = getPage('calendar');
        const feature = createTestFeatureScope();
        const reset = vi.fn();
        const adoptionCleanup = vi.fn();
        activateRoutePage(feature.scope, {
            ...catalog!,
            id: 'calendar',
            render: ({ host, handle }) => {
                host.appendChild(document.createElement('section'));
                handle.track(adoptionCleanup);
            },
            onHide: reset,
        }, {});

        window.location.hash = '#/calendar';
        window.dispatchEvent(new Event('hashchange'));
        const fallback = document.createElement('div');
        fallback.id = 'fallbackPage';
        document.body.appendChild(fallback);
        fallback.dispatchEvent(new CustomEvent('viewbeforeshow', { bubbles: true }));
        expect(fallback.querySelector('section')).not.toBeNull();

        window.location.hash = '#/home';
        window.dispatchEvent(new Event('hashchange'));
        expect(adoptionCleanup).toHaveBeenCalledTimes(1);
        expect(reset).toHaveBeenCalledTimes(1);

        await feature.dispose();
        expect(adoptionCleanup).toHaveBeenCalledTimes(1);
        expect(reset).toHaveBeenCalledTimes(1);
    });
});
