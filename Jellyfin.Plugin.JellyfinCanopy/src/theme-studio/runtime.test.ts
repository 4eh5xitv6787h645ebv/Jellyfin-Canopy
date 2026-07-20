import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import { createTestFeatureScope, type TestFeatureScope } from '../test/feature-scope';
import { themeConfiguration } from '../test/theme-studio-fixture';
import type { ApiApi } from '../types/jc';
import { ThemeStudioRuntime } from './runtime';
import { COMMITTED_STYLE_ID, PREVIEW_STYLE_ID } from './styles';

interface MutableMediaQueryList extends MediaQueryList {
    setMatches(value: boolean): void;
}

function mediaHarness(): {
    matchMedia: (query: string) => MediaQueryList;
    set(query: string, matches: boolean): void;
} {
    const lists = new Map<string, MutableMediaQueryList>();
    const matchMedia = (query: string): MediaQueryList => {
        const existing = lists.get(query);
        if (existing) return existing;
        let matches = query === '(prefers-color-scheme: dark)' || query === '(hover: hover)';
        const listeners = new Set<(event: MediaQueryListEvent) => void>();
        const list = {
            media: query,
            get matches() { return matches; },
            onchange: null,
            addEventListener: (_name: string, listener: EventListenerOrEventListenerObject) => {
                listeners.add(listener as (event: MediaQueryListEvent) => void);
            },
            removeEventListener: (_name: string, listener: EventListenerOrEventListenerObject) => {
                listeners.delete(listener as (event: MediaQueryListEvent) => void);
            },
            addListener: (listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
            removeListener: (listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
            dispatchEvent: () => true,
            setMatches(value: boolean) {
                matches = value;
                const event = { matches, media: query } as MediaQueryListEvent;
                for (const listener of listeners) listener(event);
            },
        } as unknown as MutableMediaQueryList;
        lists.set(query, list);
        return list;
    };
    return {
        matchMedia,
        set(query, matches) { (matchMedia(query) as MutableMediaQueryList).setMatches(matches); },
    };
}

function eventsHarness(): JellyfinEvents {
    const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
    return {
        on(_target, name, handler) {
            const set = handlers.get(name) ?? new Set();
            set.add(handler);
            handlers.set(name, set);
        },
        off(_target, name, handler) { handlers.get(name)?.delete(handler); },
        trigger(_target, name, args = []) {
            for (const handler of handlers.get(name) ?? []) handler(...args);
        },
    };
}

const scopes: TestFeatureScope[] = [];
let originalApi: ApiApi | undefined;
let originalEvents: JellyfinEvents | undefined;
let originalRemember: typeof JC.rememberUserSettingsSnapshot;

beforeEach(() => {
    originalApi = JC.core.api;
    originalEvents = window.Events;
    originalRemember = JC.rememberUserSettingsSnapshot;
    window.Events = eventsHarness();
    const media = mediaHarness();
    vi.stubGlobal('matchMedia', media.matchMedia);
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true, writable: true });
    Object.defineProperty(window, 'innerHeight', { value: 844, configurable: true, writable: true });
    history.replaceState({}, '', '/web/#/home');
    document.documentElement.setAttribute('data-theme', 'dark');
    document.documentElement.classList.remove('layout-tv');
    document.body.className = '';
    JC.pluginConfig = {
        ThemeStudioEnabled: true,
        ThemeStudioDashboardEnabled: false,
        ThemeStudioAllowSeasonalScheduling: true,
    };
    JC.rememberUserSettingsSnapshot = vi.fn();
    (window as unknown as { __themeMedia: ReturnType<typeof mediaHarness> }).__themeMedia = media;
});

afterEach(async () => {
    while (scopes.length > 0) await scopes.pop()?.dispose();
    JC.core.api = originalApi;
    window.Events = originalEvents;
    JC.rememberUserSettingsSnapshot = originalRemember;
    delete (window as unknown as { __themeMedia?: unknown }).__themeMedia;
    delete JC.core.themeStudio;
    document.getElementById(COMMITTED_STYLE_ID)?.remove();
    document.getElementById(PREVIEW_STYLE_ID)?.remove();
    for (const name of [...document.documentElement.attributes].map((item) => item.name)) {
        if (name.startsWith('data-jc-theme-')) document.documentElement.removeAttribute(name);
    }
    document.documentElement.removeAttribute('data-theme');
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

function apiReturning(value: unknown): ReturnType<typeof vi.fn> {
    const plugin = vi.fn().mockResolvedValue(value);
    JC.core.api = { plugin } as unknown as ApiApi;
    return plugin;
}

function expectRootThemeState(expected: Readonly<Record<string, string>>): void {
    for (const [name, value] of Object.entries(expected)) {
        expect(document.documentElement.getAttribute(`data-jc-theme-${name}`), name).toBe(value);
    }
}

function createRuntime(): { runtime: ThemeStudioRuntime; harness: TestFeatureScope } {
    const harness = createTestFeatureScope();
    scopes.push(harness);
    const runtime = new ThemeStudioRuntime(harness.scope);
    harness.scope.track(runtime);
    runtime.install();
    return { runtime, harness };
}

describe('Theme Studio identity-owned runtime', () => {
    it('exposes isolated editor state and adopts only validated acknowledged documents', async () => {
        apiReturning(themeConfiguration());
        const { runtime } = createRuntime();
        await runtime.load();

        const editorCopy = runtime.getConfiguration();
        const identity = JC.identity.capture();
        expect(editorCopy).not.toBeNull();
        expect(JC.identity.isOwned(editorCopy, identity)).toBe(true);
        editorCopy!.Profiles[0].BasePreset = 'oled';
        expect(runtime.getConfiguration()?.Profiles[0].BasePreset).toBe('canopy');

        expect(runtime.adoptAcknowledged({ invalid: true })).toBe(false);
        expect(runtime.getConfiguration()?.Profiles[0].BasePreset).toBe('canopy');
        editorCopy!.Revision = 4;
        const changed = vi.fn();
        window.addEventListener('jc:theme-studio-runtime-changed', changed);
        expect(runtime.adoptAcknowledged(editorCopy)).toBe(true);
        expect(changed).toHaveBeenCalledOnce();
        window.removeEventListener('jc:theme-studio-runtime-changed', changed);
        expect(runtime.getConfiguration()).toMatchObject({ Revision: 4, ActiveProfileId: 'default' });
        expect(document.documentElement.getAttribute('data-jc-theme-preset')).toBe('oled');
        expect(JC.rememberUserSettingsSnapshot).toHaveBeenLastCalledWith(
            'theme.json', expect.objectContaining({ Revision: 4 }),
        );
    });

    it('still performs its initial authoritative read after an early acknowledgement', async () => {
        const server = themeConfiguration();
        server.Revision = 6;
        server.Profiles[0].Palette = 'neutral';
        const plugin = apiReturning(server);
        const { runtime } = createRuntime();
        const acknowledged = themeConfiguration();
        acknowledged.Revision = 5;
        acknowledged.Profiles[0].BasePreset = 'studio';

        expect(runtime.adoptAcknowledged(acknowledged)).toBe(true);
        await expect(runtime.whenReady()).resolves.toBe(true);

        expect(plugin).toHaveBeenCalledOnce();
        expect(runtime.getConfiguration()).toMatchObject({
            Revision: 6,
            Profiles: [expect.objectContaining({ BasePreset: 'canopy', Palette: 'neutral' })],
        });
    });

    it.each([
        ['fails', new Error('server unavailable')],
        ['returns malformed data', { invalid: true }],
    ])('keeps an early acknowledgement when its initial read %s', async (_label, outcome) => {
        const plugin = vi.fn();
        if (outcome instanceof Error) plugin.mockRejectedValue(outcome);
        else plugin.mockResolvedValue(outcome);
        JC.core.api = { plugin } as unknown as ApiApi;
        const { runtime } = createRuntime();
        const acknowledged = themeConfiguration();
        acknowledged.Revision = 5;
        acknowledged.Profiles[0].BasePreset = 'studio';

        expect(runtime.adoptAcknowledged(acknowledged)).toBe(true);
        await expect(runtime.whenReady()).resolves.toBe(true);

        expect(plugin).toHaveBeenCalledOnce();
        expect(runtime.getConfiguration()).toMatchObject({
            Revision: 5,
            Profiles: [expect.objectContaining({ BasePreset: 'studio' })],
        });
        expect(runtime.getDiagnostics()).toMatchObject({ status: 'active', revision: 5 });
        expect(document.documentElement.getAttribute('data-jc-theme-preset')).toBe('studio');
    });

    it('reloads authoritative state through the existing abortable owner', async () => {
        const first = themeConfiguration();
        const second = themeConfiguration();
        second.Revision = 9;
        second.Profiles[0].Palette = 'neutral';
        const plugin = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
        JC.core.api = { plugin } as unknown as ApiApi;
        const { runtime } = createRuntime();
        await runtime.load();
        const changed = vi.fn();
        window.addEventListener('jc:theme-studio-runtime-changed', changed);
        const preview = themeConfiguration();
        preview.Profiles[0].BasePreset = 'glass';
        expect(runtime.preview(preview)).toBe(true);

        await expect(runtime.reload()).resolves.toBe(true);
        expect(plugin).toHaveBeenCalledTimes(2);
        expect(runtime.getConfiguration()).toMatchObject({ Revision: 9 });
        expect(document.documentElement.getAttribute('data-jc-theme-preview')).toBeNull();
        expect(document.documentElement.getAttribute('data-jc-theme-palette')).toBe('neutral');
        expect(changed).toHaveBeenCalledOnce();
        expect((changed.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ reason: 'reloaded' });
        window.removeEventListener('jc:theme-studio-runtime-changed', changed);
    });

    it('keeps the last validated committed theme when an authoritative reload fails', async () => {
        const committed = themeConfiguration();
        committed.Revision = 7;
        committed.Profiles[0].Palette = 'neutral';
        const plugin = vi.fn()
            .mockResolvedValueOnce(committed)
            .mockRejectedValueOnce(new Error('server unavailable'));
        JC.core.api = { plugin } as unknown as ApiApi;
        const { runtime } = createRuntime();
        await runtime.load();
        const preview = themeConfiguration();
        preview.Profiles[0].BasePreset = 'glass';
        expect(runtime.preview(preview)).toBe(true);
        const changed = vi.fn();
        window.addEventListener('jc:theme-studio-runtime-changed', changed);

        await expect(runtime.reload()).resolves.toBe(false);

        expect(runtime.getConfiguration()).toMatchObject({ Revision: 7 });
        expect(document.documentElement.getAttribute('data-jc-theme-preview')).toBeNull();
        expect(document.documentElement.getAttribute('data-jc-theme-palette')).toBe('neutral');
        expect(document.getElementById(COMMITTED_STYLE_ID)).not.toBeNull();
        expect(runtime.getDiagnostics()).toMatchObject({ status: 'active', revision: 7 });
        expect(changed).not.toHaveBeenCalled();
        window.removeEventListener('jc:theme-studio-runtime-changed', changed);
    });

    it('rejects a late acknowledgement older than the loaded authoritative revision', async () => {
        const loaded = themeConfiguration();
        loaded.Revision = 9;
        loaded.Profiles[0].Palette = 'neutral';
        apiReturning(loaded);
        const { runtime } = createRuntime();
        await runtime.load();
        vi.mocked(JC.rememberUserSettingsSnapshot!).mockClear();
        const changed = vi.fn();
        window.addEventListener('jc:theme-studio-runtime-changed', changed);
        const stale = themeConfiguration();
        stale.Revision = 8;
        stale.Profiles[0].Palette = 'vivid';

        expect(runtime.adoptAcknowledged(stale)).toBe(false);

        expect(runtime.getConfiguration()).toMatchObject({ Revision: 9 });
        expect(document.documentElement.getAttribute('data-jc-theme-palette')).toBe('neutral');
        expect(JC.rememberUserSettingsSnapshot).not.toHaveBeenCalled();
        expect(changed).not.toHaveBeenCalled();
        window.removeEventListener('jc:theme-studio-runtime-changed', changed);
    });

    it('never lets an older overlapping load overwrite a newer reload', async () => {
        let resolveOlder: (value: unknown) => void = () => undefined;
        let resolveNewer: (value: unknown) => void = () => undefined;
        const plugin = vi.fn()
            .mockImplementationOnce(() => new Promise<unknown>((resolve) => { resolveOlder = resolve; }))
            .mockImplementationOnce(() => new Promise<unknown>((resolve) => { resolveNewer = resolve; }));
        JC.core.api = { plugin } as unknown as ApiApi;
        const { runtime } = createRuntime();
        const olderLoad = runtime.load();
        const newerLoad = runtime.reload();
        const newer = themeConfiguration();
        newer.Revision = 12;
        newer.Profiles[0].Palette = 'neutral';
        resolveNewer(newer);
        await expect(newerLoad).resolves.toBe(true);
        expect(runtime.getConfiguration()).toMatchObject({ Revision: 12 });

        const older = themeConfiguration();
        older.Revision = 4;
        older.Profiles[0].Palette = 'vivid';
        resolveOlder(older);
        await olderLoad;
        expect(runtime.getConfiguration()).toMatchObject({ Revision: 12 });
        expect(document.documentElement.getAttribute('data-jc-theme-palette')).toBe('neutral');
    });

    it('lets an in-flight authoritative load supersede an older acknowledgement', async () => {
        let resolveLoad: (value: unknown) => void = () => undefined;
        const plugin = vi.fn(() => new Promise<unknown>((resolve) => { resolveLoad = resolve; }));
        JC.core.api = { plugin } as unknown as ApiApi;
        const { runtime } = createRuntime();
        const load = runtime.load();
        const acknowledged = themeConfiguration();
        acknowledged.Revision = 4;
        acknowledged.Profiles[0].Palette = 'neutral';

        expect(runtime.adoptAcknowledged(acknowledged)).toBe(true);
        expect(runtime.getConfiguration()).toMatchObject({ Revision: 4 });

        const newer = themeConfiguration();
        newer.Revision = 5;
        newer.Profiles[0].Palette = 'vivid';
        resolveLoad(newer);
        await load;

        expect(runtime.getConfiguration()).toMatchObject({ Revision: 5 });
        expect(document.documentElement.getAttribute('data-jc-theme-palette')).toBe('vivid');
        expect(JC.rememberUserSettingsSnapshot).toHaveBeenLastCalledWith(
            'theme.json', expect.objectContaining({ Revision: 5 }),
        );
    });

    it('loads once, applies one committed layer, and follows host theme/media changes live', async () => {
        const plugin = apiReturning(themeConfiguration());
        const { runtime } = createRuntime();
        await runtime.load();

        const expectedRequestOptions: Record<string, unknown> = {
            skipCache: true,
            timeoutMs: 10_000,
            signal: expect.any(AbortSignal),
        };
        expect(plugin).toHaveBeenCalledOnce();
        expect(plugin).toHaveBeenCalledWith(
            '/user-settings/user-a/theme.json',
            expect.objectContaining(expectedRequestOptions),
        );
        expect(document.querySelectorAll(`#${COMMITTED_STYLE_ID}`)).toHaveLength(1);
        expect(document.getElementById(PREVIEW_STYLE_ID)).toBeNull();
        expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
        expect(document.documentElement.getAttribute('data-jc-theme-active')).toBe('true');
        expect(document.documentElement.getAttribute('data-jc-theme-breakpoint')).toBe('phone');
        expect(document.documentElement.getAttribute('data-jc-theme-preset-version')).toBe('1');
        expect(document.documentElement.getAttribute('data-jc-theme-preset-fallback')).toBe('false');
        expect(document.documentElement.getAttribute('data-jc-theme-route')).toBe('home');
        expect(document.getElementById(COMMITTED_STYLE_ID)?.textContent)
            .toContain('--jf-palette-background-default: #0B0B12');
        expect(JC.rememberUserSettingsSnapshot).toHaveBeenCalledWith(
            'theme.json', expect.objectContaining({ Revision: 3 }),
        );

        document.documentElement.setAttribute('data-theme', 'light');
        window.Events?.trigger(document, 'THEME_CHANGE');
        expect(document.documentElement.getAttribute('data-jc-theme-mode')).toBe('light');
        expect(document.documentElement.getAttribute('data-theme')).toBe('light');

        const media = (window as unknown as { __themeMedia: ReturnType<typeof mediaHarness> }).__themeMedia;
        media.set('(prefers-reduced-motion: reduce)', true);
        expect(document.documentElement.getAttribute('data-jc-theme-motion')).toBe('reduced');
        expect(document.getElementById(COMMITTED_STYLE_ID)?.textContent)
            .toContain('animation-duration: 0.01ms !important');

        window.innerWidth = 800;
        window.innerHeight = 600;
        media.set('(min-width: 600px) and (max-width: 1023px)', true);
        expect(document.documentElement.getAttribute('data-jc-theme-breakpoint')).toBe('tablet');
        expect(runtime.getDiagnostics()).toMatchObject({ status: 'active', breakpoint: 'tablet', revision: 3 });

        window.innerWidth = 844;
        window.innerHeight = 390;
        media.set('(pointer: coarse)', true);
        media.set('(orientation: landscape) and (max-height: 599px) and (max-width: 999px) and (pointer: coarse)', true);
        expect(document.documentElement.getAttribute('data-jc-theme-breakpoint')).toBe('phone');
    });

    it('owns a later preview layer and cancels it without disturbing committed state', async () => {
        apiReturning(themeConfiguration());
        const { runtime } = createRuntime();
        await runtime.load();
        const currentApi = JC.core.themeStudio;
        const preview = themeConfiguration();
        preview.Profiles.push({
            ...structuredClone(preview.Profiles[0]),
            Id: 'preview',
            Name: 'Preview',
            BasePreset: 'minimal',
            Palette: 'vivid',
            Mode: 'light',
            Tokens: { 'shape.card-radius': 'pill' },
            Accessibility: {
                ...preview.Profiles[0].Accessibility,
                Motion: 'off',
                Contrast: 'on',
                Transparency: 'off',
            },
        });
        preview.ActiveProfileId = 'preview';
        expect(JC.core.themeStudio?.preview(preview)).toBe(true);
        expect(document.querySelectorAll(`#${PREVIEW_STYLE_ID}`)).toHaveLength(1);
        expect(document.documentElement.getAttribute('data-jc-theme-preview')).toBe('true');
        expect(document.getElementById(PREVIEW_STYLE_ID)?.textContent)
            .toContain('--jf-card-borderRadius: 999px');
        expectRootThemeState({
            profile: 'preview',
            preset: 'minimal',
            palette: 'vivid',
            mode: 'light',
            motion: 'reduced',
            contrast: 'more',
            transparency: 'reduced',
        });
        expect(JC.core.themeStudio?.getDiagnostics().status).toBe('preview');

        JC.core.themeStudio?.cancelPreview();
        expect(document.getElementById(PREVIEW_STYLE_ID)).toBeNull();
        expect(document.documentElement.hasAttribute('data-jc-theme-preview')).toBe(false);
        expect(document.getElementById(COMMITTED_STYLE_ID)).not.toBeNull();
        expectRootThemeState({
            profile: 'default',
            preset: 'canopy',
            palette: 'canopy-night',
            mode: 'dark',
            motion: 'full',
            contrast: 'standard',
            transparency: 'full',
        });
        expect(JC.core.themeStudio?.getDiagnostics().status).toBe('active');
        expect(currentApi).toBe(JC.core.themeStudio);
    });

    it('lets editor previews target ActiveProfileId while committed presentation remains scheduled', async () => {
        const scheduled = themeConfiguration();
        scheduled.Profiles.push({
            ...structuredClone(scheduled.Profiles[0]),
            Id: 'seasonal',
            Name: 'Seasonal',
            BasePreset: 'cinematic',
            Palette: 'vivid',
        });
        scheduled.Schedule = [{
            Id: 'year-round', ProfileId: 'seasonal', StartMonthDay: '01-01', EndMonthDay: '12-31',
            Priority: 10, Enabled: true,
        }];
        apiReturning(scheduled);
        const { runtime } = createRuntime();
        await runtime.load();
        expectRootThemeState({ profile: 'seasonal', preset: 'cinematic', palette: 'vivid' });

        const draft = structuredClone(scheduled);
        draft.Profiles[0].BasePreset = 'glass';
        expect(JC.core.themeStudio?.preview(draft, { allowScheduling: false })).toBe(true);
        expectRootThemeState({ profile: 'default', preset: 'glass', palette: 'canopy-night' });

        JC.core.themeStudio?.cancelPreview();
        expectRootThemeState({ profile: 'seasonal', preset: 'cinematic', palette: 'vivid' });
    });

    it('suspends committed reduced-motion adapters while a full-motion preview is active', async () => {
        const committed = themeConfiguration();
        committed.Profiles[0].Accessibility.Motion = 'off';
        apiReturning(committed);
        const { runtime } = createRuntime();
        await runtime.load();

        const committedCss = document.getElementById(COMMITTED_STYLE_ID)?.textContent ?? '';
        expect(committedCss).toContain('animation-duration: 0.01ms !important');
        expect(committedCss).toContain(':not([data-jc-theme-preview="true"])');

        const preview = themeConfiguration();
        preview.Profiles[0].Accessibility.Motion = 'on';
        expect(JC.core.themeStudio?.preview(preview)).toBe(true);
        expectRootThemeState({ motion: 'full' });
        expect(document.getElementById(PREVIEW_STYLE_ID)?.textContent)
            .not.toContain('animation-duration: 0.01ms !important');
        expect(document.documentElement.matches(
            ':root[data-jc-theme-active="true"]:not([data-jc-theme-preview="true"])',
        )).toBe(false);

        JC.core.themeStudio?.cancelPreview();
        expectRootThemeState({ motion: 'reduced' });
        expect(document.documentElement.matches(
            ':root[data-jc-theme-active="true"]:not([data-jc-theme-preview="true"])',
        )).toBe(true);
    });

    it('keeps the dashboard as an unthemed recovery space unless explicitly enabled', async () => {
        history.replaceState({}, '', '/web/#/dashboard');
        apiReturning(themeConfiguration());
        const { runtime } = createRuntime();
        await runtime.load();
        expect(document.getElementById(COMMITTED_STYLE_ID)).toBeNull();
        expect(document.documentElement.hasAttribute('data-jc-theme-active')).toBe(false);
        expect(runtime.getDiagnostics().status).toBe('inactive');

        JC.pluginConfig.ThemeStudioDashboardEnabled = true;
        runtime.refresh();
        expect(document.getElementById(COMMITTED_STYLE_ID)).not.toBeNull();
        expect(document.documentElement.getAttribute('data-jc-theme-active')).toBe('true');
    });

    it('forgets a cancelled dashboard preview before later navigation', async () => {
        history.replaceState({}, '', '/web/#/dashboard');
        apiReturning(themeConfiguration());
        const { runtime } = createRuntime();
        await runtime.load();
        const preview = themeConfiguration();
        preview.Profiles[0].BasePreset = 'glass';

        expect(runtime.preview(preview)).toBe(false);
        runtime.cancelPreview();
        history.replaceState({}, '', '/web/#/home');
        runtime.refresh();

        expect(document.documentElement.getAttribute('data-jc-theme-preset')).toBe('canopy');
        expect(document.documentElement.getAttribute('data-jc-theme-preview')).toBeNull();
    });

    it('removes presentation synchronously on identity reset and read/validation failure', async () => {
        apiReturning(themeConfiguration());
        const first = createRuntime();
        await first.runtime.load();
        const hostTheme = document.documentElement.getAttribute('data-theme');
        JC.identity.transition('runtime-server', `runtime-user-${Math.random()}`, 'runtime-test');
        expect(document.getElementById(COMMITTED_STYLE_ID)).toBeNull();
        expect(document.documentElement.hasAttribute('data-jc-theme-active')).toBe(false);
        expect(document.documentElement.getAttribute('data-theme')).toBe(hostTheme);
        expect(JC.core.themeStudio).toBeUndefined();

        const stale = document.createElement('style');
        stale.id = COMMITTED_STYLE_ID;
        document.head.append(stale);
        document.documentElement.setAttribute('data-jc-theme-active', 'true');
        apiReturning({ ...themeConfiguration(), RawCss: '*{}' });
        const second = createRuntime();
        expect(document.getElementById(COMMITTED_STYLE_ID)).toBeNull();
        await second.runtime.load();
        expect(second.runtime.getDiagnostics().status).toBe('error');
        expect(document.getElementById(COMMITTED_STYLE_ID)).toBeNull();
        expect(document.documentElement.hasAttribute('data-jc-theme-active')).toBe(false);
        expect(document.documentElement.getAttribute('data-theme')).toBe(hostTheme);
    });

    it('rejects late obsolete responses without applying user presentation', async () => {
        let resolveRequest: (value: unknown) => void = () => undefined;
        const plugin = vi.fn(() => new Promise<unknown>((resolve) => { resolveRequest = resolve; }));
        JC.core.api = { plugin } as unknown as ApiApi;
        const { runtime, harness } = createRuntime();
        const load = runtime.load();
        harness.setCurrent(false);
        resolveRequest(themeConfiguration());
        await load;
        expect(document.getElementById(COMMITTED_STYLE_ID)).toBeNull();
        expect(document.documentElement.hasAttribute('data-jc-theme-active')).toBe(false);
        expect(JC.core.themeStudio).toBeUndefined();
    });

    it('prevents a retained obsolete API from clearing its successor presentation', async () => {
        apiReturning(themeConfiguration());
        const first = createRuntime();
        await first.runtime.load();
        const staleApi = JC.core.themeStudio;
        first.runtime.dispose();

        const second = createRuntime();
        await second.runtime.load();
        const successorCss = document.getElementById(COMMITTED_STYLE_ID)?.textContent;
        expect(successorCss).toBeTruthy();
        expect(JC.core.themeStudio).not.toBe(staleApi);

        staleApi?.refresh();
        staleApi?.cancelPreview();
        first.runtime.dispose();

        expect(document.getElementById(COMMITTED_STYLE_ID)?.textContent).toBe(successorCss);
        expect(document.documentElement.getAttribute('data-jc-theme-active')).toBe('true');
        expect(second.runtime.getDiagnostics().status).toBe('active');
    });
});
