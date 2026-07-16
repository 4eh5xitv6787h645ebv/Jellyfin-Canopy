import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import './translations';

const originalFetch = globalThis.fetch;
const response = (ok: boolean, body: Record<string, string> = {}): Response => new Response(
    JSON.stringify(body),
    { status: ok ? 200 : 404, headers: { 'Content-Type': 'application/json' } },
);
const requestUrl = (input: RequestInfo | URL): string => {
    if (typeof input === 'string') return input;
    return input instanceof URL ? input.href : input.url;
};
const loadTranslations = (): Promise<Record<string, string>> => {
    const load = window.JellyfinCanopy.loadTranslations;
    if (!load) throw new Error('translations bootstrap did not install loadTranslations');
    return load();
};

describe('translation loader deployment ownership', () => {
    beforeEach(() => {
        localStorage.clear();
        document.documentElement.lang = '';
        window.JellyfinCanopy.pluginVersion = '2.0.0.0';
        window.JellyfinCanopy.pluginConfig = {};
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-17T00:00:00Z'));
    });

    afterEach(() => {
        localStorage.clear();
        globalThis.fetch = originalFetch;
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('short-circuits on the installed bundled locale without contacting GitHub', async () => {
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(true, { greeting: 'bundled' }));
        globalThis.fetch = fetchMock;

        await expect(loadTranslations()).resolves.toEqual({ greeting: 'bundled' });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls.map(([input]) => requestUrl(input))).toEqual([
            'http://jellyfin.test/JellyfinCanopy/locales/en.json',
        ]);
    });

    it('keeps the default failure path offline and permits GitHub only when explicitly enabled', async () => {
        const offlineFetch = vi.fn<typeof fetch>().mockResolvedValue(response(false));
        globalThis.fetch = offlineFetch;

        await expect(loadTranslations()).resolves.toEqual({});
        expect(offlineFetch.mock.calls.some(([input]) => requestUrl(input).includes('raw.githubusercontent.com'))).toBe(false);

        window.JellyfinCanopy.pluginConfig = { AssetCacheEnabled: false };
        const fallbackFetch = vi.fn<typeof fetch>((input) => Promise.resolve(
            requestUrl(input).includes('raw.githubusercontent.com')
                ? response(true, { greeting: 'remote fallback' })
                : response(false)
        ));
        globalThis.fetch = fallbackFetch;

        await expect(loadTranslations()).resolves.toEqual({ greeting: 'remote fallback' });
        expect(fallbackFetch.mock.calls.map(([input]) => requestUrl(input))).toEqual([
            'http://jellyfin.test/JellyfinCanopy/locales/en.json',
            expect.stringContaining('4eh5xitv6787h645ebv/Jellyfin-Canopy/main/'),
        ]);
    });

    it('uses a 24-hour plugin-version cache and retires entries from older builds', async () => {
        localStorage.setItem('JC_translation_en_1.9.0.0', JSON.stringify({ greeting: 'old build' }));
        localStorage.setItem('JC_translation_ts_en_1.9.0.0', String(Date.now()));
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(true, { greeting: 'current build' }));
        globalThis.fetch = fetchMock;

        await expect(loadTranslations()).resolves.toEqual({ greeting: 'current build' });
        expect(localStorage.getItem('JC_translation_en_1.9.0.0')).toBeNull();
        expect(localStorage.getItem('JC_translation_ts_en_1.9.0.0')).toBeNull();
        expect(JSON.parse(localStorage.getItem('JC_translation_en_2.0.0.0')!)).toEqual({ greeting: 'current build' });

        fetchMock.mockClear();
        vi.setSystemTime(new Date('2026-07-17T23:59:59Z'));
        await expect(loadTranslations()).resolves.toEqual({ greeting: 'current build' });
        expect(fetchMock).not.toHaveBeenCalled();

        vi.setSystemTime(new Date('2026-07-18T00:00:01Z'));
        fetchMock.mockResolvedValue(response(true, { greeting: 'refreshed' }));
        await expect(loadTranslations()).resolves.toEqual({ greeting: 'refreshed' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
