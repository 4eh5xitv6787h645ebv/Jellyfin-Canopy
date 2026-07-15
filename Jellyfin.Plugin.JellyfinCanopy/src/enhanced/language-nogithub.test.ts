// Unit test for the language dropdown locale source (ENH-5 / R6).
//
// Opening the language control used to fetch api.github.com on every open
// (wrong upstream key set, client IP leak, 60/hr rate limit → 403). The server
// /JellyfinCanopy/locales endpoint is authoritative — no GitHub call at all.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { wireLanguageControls } from './settings-panel/language';
import type { PanelContext } from './settings-panel/panel';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('language control locale source', () => {
    afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); });

    it('never fetches api.github.com when populating the language dropdown', async () => {
        const select = document.createElement('select');
        select.id = 'displayLanguageSelect';
        document.body.appendChild(select);

        const JC = window.JellyfinCanopy as unknown as Record<string, any>;
        JC.currentSettings = {};
        JC.t = (k: string) => k;

        const plugin = vi.fn().mockResolvedValue(['en', 'fr', 'de']);
        const jf = vi.fn().mockResolvedValue([]);
        JC.core.api = { plugin, jf };

        const fetchSpy = vi.fn((_url?: unknown) => Promise.resolve({ ok: false, json: () => Promise.resolve([]) }));
        (globalThis as Record<string, any>).fetch = fetchSpy;

        wireLanguageControls({ resetAutoCloseTimer: () => { /* no-op */ } } as unknown as PanelContext);
        await flush();
        await flush();

        const githubCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).includes('api.github.com'));
        expect(githubCalls.length).toBe(0);
        // The server locale endpoint WAS used.
        expect(plugin).toHaveBeenCalledWith('/locales');
        expect(jf).toHaveBeenCalledWith('/Localization/Cultures');
        expect(Array.from(select.options, option => option.value).sort()).toEqual(['de', 'fr']);
    });
});
