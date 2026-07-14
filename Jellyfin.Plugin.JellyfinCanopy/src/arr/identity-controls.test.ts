import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from './arr-globals';
import type { ApiApi, UserSettings } from '../types/jc';

const originalApi = JC.core.api;
const originalSave = JC.saveUserSettings;
const originalLoad = JC.loadSettings;
let plugin: ReturnType<typeof vi.fn>;

describe('Arr page control identity ownership', () => {
    beforeEach(() => {
        vi.resetModules();
        document.body.innerHTML = '';
        JC.identity.transition('', '', 'arr-controls-logout');
        JC.identity.transition('server-a', 'user-a', 'arr-controls-a');
        JC.pluginConfig = {
            CalendarPageEnabled: true,
            DownloadsPageEnabled: true,
            DownloadsPagePollingEnabled: false,
            DownloadsPageShowIssues: true,
            SeerrEnabled: true,
            ShowDownloadsInRequests: true,
        };
        plugin = vi.fn().mockResolvedValue({ requests: [], results: [], totalPages: 1 });
        JC.core.api = { plugin } as unknown as ApiApi;
        JC.saveUserSettings = vi.fn().mockResolvedValue(undefined);
        JC.loadSettings = vi.fn((): UserSettings => ({}));
    });

    afterEach(() => {
        JC.core.lifecycle?.get('arr-controls-requests')?.teardown();
        JC.core.api = originalApi;
        JC.saveUserSettings = originalSave;
        JC.loadSettings = originalLoad;
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    it('keeps a retained A calendar view control from persisting B settings', async () => {
        const { state } = await import('./calendar/data');
        const { handleEventClick } = await import('./calendar/actions');
        const ownerA = JC.identity.capture()!;
        const container = document.createElement('div');
        container.id = 'jc-calendar-container';
        JC.identity.own(container, ownerA);
        const staleView = document.createElement('button');
        staleView.dataset.calendarView = 'day';
        container.appendChild(staleView);
        document.body.appendChild(container);
        staleView.addEventListener('click', (event) => handleEventClick(event as MouseEvent));

        JC.identity.transition('server-a', 'user-b', 'arr-controls-b');
        const ownerB = JC.identity.capture()!;
        JC.currentSettings = JC.identity.own({ calendarDefaultViewMode: 'month' }, ownerB);
        state.viewMode = 'month';
        const save = JC.saveUserSettings as ReturnType<typeof vi.fn>;

        staleView.click();

        expect(state.viewMode).toBe('month');
        expect(JC.currentSettings.calendarDefaultViewMode).toBe('month');
        expect(save).not.toHaveBeenCalled();
        expect(staleView.getAttribute('onclick')).toBeNull();
    });

    it('routes live Requests controls through one adoption and drains retained A controls', async () => {
        await import('../core/lifecycle');
        await import('./requests/page');
        const { getPage } = await import('../enhanced/pages/registry');
        const { state } = await import('./requests/data');
        const { renderPage } = await import('./requests/render');
        const descriptor = getPage('downloads')!;
        const handle = JC.core.lifecycle!.register('arr-controls-requests');
        handle.teardown();
        const host = document.createElement('div');
        document.body.appendChild(host);
        const controller = new AbortController();
        controller.abort();

        await descriptor.render({ host, handle, signal: controller.signal });
        renderPage();
        const liveFilter = host.querySelector<HTMLButtonElement>('[data-requests-filter="pending"]')!;
        expect(liveFilter).not.toBeNull();
        expect(host.querySelector('[onclick]')).toBeNull();

        liveFilter.click();
        expect(state.requestsFilter).toBe('pending');
        await Promise.resolve();

        const staleFilter = liveFilter;
        const callsBeforeSwitch = plugin.mock.calls.length;
        handle.teardown();
        JC.identity.transition('server-b', 'user-a', 'arr-controls-server-switch');
        state.requestsFilter = 'all';

        staleFilter.click();
        await Promise.resolve();

        expect(state.requestsFilter).toBe('all');
        expect(plugin).toHaveBeenCalledTimes(callsBeforeSwitch);
    });
});
