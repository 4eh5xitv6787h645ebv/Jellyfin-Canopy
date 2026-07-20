import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import '../enhanced/config';
import { installElsewhere, resetElsewhereIdentity } from './elsewhere';

const realSaveUserSettings = JC.saveUserSettings!;
const realCoreApi = JC.core.api;

describe('Elsewhere account ownership', () => {
    let disposeInstall: (() => void) | undefined;
    let unregisterReset: (() => void) | undefined;

    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = '';
        disposeInstall = installElsewhere();
        unregisterReset = JC.identity.registerReset(
            'elsewhere-identity-test',
            resetElsewhereIdentity,
        );
        JC.identity.transition('', '', 'test-logout');
        const context = JC.identity.transition('test-server-id', 'test-user-id', 'test-login')!;
        const elsewhere = JC.identity.own({ Region: 'US', Regions: [], Services: [] }, context);
        JC.userConfig = JC.identity.own({ elsewhere }, context);
        JC.pluginConfig = {
            ElsewhereEnabled: true,
            TmdbEnabled: true,
            DEFAULT_REGION: 'US',
        };
        JC.t = (key: string) => key;
        vi.spyOn(ApiClient, 'getCurrentUserId').mockReturnValue('test-user-id');
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            text: () => Promise.resolve('US\tUnited States'),
        }));
        vi.stubGlobal('requestIdleCallback', undefined);
    });

    afterEach(() => {
        JC.identity.transition('', '', 'elsewhere-identity-test-cleanup');
        unregisterReset?.();
        unregisterReset = undefined;
        disposeInstall?.();
        disposeInstall = undefined;
        resetElsewhereIdentity();
        JC.saveUserSettings = realSaveUserSettings;
        JC.core.api = realCoreApi;
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        document.body.innerHTML = '';
    });

    it('makes a retained A modal completely inert after B becomes current', async () => {
        const ajax = vi.spyOn(ApiClient, 'ajax').mockResolvedValue({});
        const save = vi.fn();
        JC.saveUserSettings = save;

        (JC as typeof JC & { initializeElsewhereScript: () => void }).initializeElsewhereScript();
        await Promise.resolve();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(2_000);
        const staleModal = document.getElementById('streaming-settings-modal')!;
        expect(staleModal).not.toBeNull();
        const staleSaveButton = document.getElementById('save-settings')!;

        JC.identity.transition('test-server-id', 'user-b', 'account-switch');
        vi.spyOn(ApiClient, 'getCurrentUserId').mockReturnValue('user-b');
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        expect(document.getElementById('streaming-settings-modal')).toBeNull();
        // Even if a host/client race reattaches the detached A modal, its own
        // handlers must be inert. Relying on the central writer to reject an
        // A-owned payload is too late: stale UI is not allowed to act as B.
        document.body.appendChild(staleModal);
        staleSaveButton.click();
        await Promise.resolve();

        expect(save).not.toHaveBeenCalled();
        expect(ajax).not.toHaveBeenCalled();
    });

    it('does not let detached A search/settings controls act on B UI', async () => {
        document.body.innerHTML = `
            <div class="detailSectionContent">
                <a href="https://www.themoviedb.org/movie/123">TMDB</a>
            </div>`;
        const fetchMock = vi.fn((input: RequestInfo | URL) => {
            const url = input instanceof Request
                ? input.url
                : input instanceof URL ? input.href : input;
            const text = url.includes('providers.txt')
                    ? 'Netflix'
                    : 'US\tUnited States';
            return Promise.resolve({
                ok: true,
                status: 200,
                text: () => Promise.resolve(text),
                clone() { return this; },
            } as unknown as Response);
        });
        vi.stubGlobal('fetch', fetchMock);
        const apiFetch = vi.fn().mockResolvedValue({ results: { US: { flatrate: [] } } });
        JC.core.api = { fetch: apiFetch } as unknown as typeof JC.core.api;

        (JC as typeof JC & { initializeElsewhereScript: () => void }).initializeElsewhereScript();
        await vi.advanceTimersByTimeAsync(2_500);
        await Promise.resolve();
        await Promise.resolve();

        const staleSettings = document.querySelector<HTMLButtonElement>('.elsewhere-settings-button')!;
        const staleSearch = document.querySelector<HTMLButtonElement>('.elsewhere-search-button')!;
        expect(staleSettings).not.toBeNull();
        expect(staleSearch).not.toBeNull();
        const requestsBeforeSwitch = apiFetch.mock.calls.length;

        JC.identity.transition('test-server-id', 'user-b', 'account-switch');
        vi.spyOn(ApiClient, 'getCurrentUserId').mockReturnValue('user-b');
        const bModal = document.createElement('div');
        bModal.id = 'streaming-settings-modal';
        bModal.style.display = 'none';
        document.body.appendChild(bModal);

        staleSettings.click();
        staleSearch.click();
        await Promise.resolve();

        expect(bModal.style.display).toBe('none');
        expect(staleSearch.disabled).toBe(false);
        expect(apiFetch).toHaveBeenCalledTimes(requestsBeforeSwitch);
    });

    it('moves focus into settings, traps Tab, closes on Escape, and restores the opener', async () => {
        document.body.innerHTML = `
            <div class="detailSectionContent">
                <a href="https://www.themoviedb.org/movie/123">TMDB</a>
            </div>`;
        vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
            const url = input instanceof Request
                ? input.url
                : input instanceof URL ? input.href : input;
            const text = url.includes('providers.txt') ? 'Netflix' : 'US\tUnited States';
            return Promise.resolve({
                ok: true,
                status: 200,
                text: () => Promise.resolve(text),
                clone() { return this; },
            } as unknown as Response);
        }));
        JC.core.api = {
            fetch: vi.fn().mockResolvedValue({ results: { US: { flatrate: [] } } }),
        } as unknown as typeof JC.core.api;

        (JC as typeof JC & { initializeElsewhereScript: () => void }).initializeElsewhereScript();
        await vi.advanceTimersByTimeAsync(2_500);
        await Promise.resolve();
        await Promise.resolve();

        const settingsButton = document.querySelector<HTMLButtonElement>('.elsewhere-settings-button')!;
        const modal = document.getElementById('streaming-settings-modal')!;
        const dialog = modal.querySelector<HTMLElement>('.streaming-settings-dialog')!;
        const regionSelect = dialog.querySelector<HTMLSelectElement>('#region-select')!;
        const saveButton = dialog.querySelector<HTMLButtonElement>('#save-settings')!;
        expect(settingsButton).not.toBeNull();
        expect(modal.getAttribute('aria-hidden')).toBe('true');

        settingsButton.focus();
        settingsButton.click();
        expect(modal.style.display).toBe('flex');
        expect(modal.hasAttribute('aria-hidden')).toBe(false);
        expect(dialog.getAttribute('role')).toBe('dialog');
        expect(dialog.getAttribute('aria-modal')).toBe('true');
        expect(dialog.getAttribute('aria-label')).toBe('elsewhere_settings_title');
        expect(document.activeElement).toBe(regionSelect);
        expect(document.body.classList).toContain('jc-modal-open');

        saveButton.focus();
        saveButton.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Tab',
            bubbles: true,
            cancelable: true,
        }));
        expect(document.activeElement).toBe(regionSelect);

        regionSelect.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
        }));
        expect(modal.style.display).toBe('none');
        expect(modal.getAttribute('aria-hidden')).toBe('true');
        expect(document.activeElement).toBe(settingsButton);
        expect(document.body.classList).not.toContain('jc-modal-open');
    });
});
