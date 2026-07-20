import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import { createTestFeatureScope, type TestFeatureScope } from '../test/feature-scope';
import { themeConfiguration } from '../test/theme-studio-fixture';
import type { ApiApi } from '../types/jc';
import { DYNAMIC_ACCENT_STYLE_ID } from './dynamic-color';
import { MOBILE_ENVIRONMENT_STYLE_ID } from './mobile';
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
let originalAcknowledgedSnapshot: typeof JC.getAcknowledgedUserSettingsSnapshot;
let originalDom: typeof JC.core.dom;

beforeEach(() => {
    originalApi = JC.core.api;
    originalEvents = window.Events;
    originalRemember = JC.rememberUserSettingsSnapshot;
    originalAcknowledgedSnapshot = JC.getAcknowledgedUserSettingsSnapshot;
    originalDom = JC.core.dom;
    JC.getAcknowledgedUserSettingsSnapshot = undefined;
    window.Events = eventsHarness();
    const media = mediaHarness();
    vi.stubGlobal('matchMedia', media.matchMedia);
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true, writable: true });
    Object.defineProperty(window, 'innerHeight', { value: 844, configurable: true, writable: true });
    history.replaceState({}, '', '/web/#/home');
    document.documentElement.setAttribute('data-theme', 'dark');
    document.documentElement.classList.remove('jc-legacy-layout', 'layout-tv');
    document.documentElement.classList.add('jc-modern-layout');
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
    JC.getAcknowledgedUserSettingsSnapshot = originalAcknowledgedSnapshot;
    JC.core.dom = originalDom;
    delete (window as unknown as { __themeMedia?: unknown }).__themeMedia;
    delete JC.core.themeStudio;
    document.getElementById(COMMITTED_STYLE_ID)?.remove();
    document.getElementById(PREVIEW_STYLE_ID)?.remove();
    document.getElementById(MOBILE_ENVIRONMENT_STYLE_ID)?.remove();
    document.getElementById(DYNAMIC_ACCENT_STYLE_ID)?.remove();
    document.body.replaceChildren();
    for (const name of [...document.documentElement.attributes].map((item) => item.name)) {
        if (name.startsWith('data-jc-theme-')) document.documentElement.removeAttribute(name);
    }
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.classList.remove('jc-modern-layout', 'jc-legacy-layout', 'layout-tv');
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

    it('imports a cached save acknowledgement before a replacement runtime initial read fails', async () => {
        const plugin = vi.fn().mockRejectedValue(new Error('server unavailable'));
        JC.core.api = { plugin } as unknown as ApiApi;
        const acknowledged = themeConfiguration();
        acknowledged.Revision = 5;
        acknowledged.Profiles[0].BasePreset = 'studio';
        JC.getAcknowledgedUserSettingsSnapshot = vi.fn(() =>
            JC.identity.own(structuredClone(acknowledged), JC.identity.capture()));

        const { runtime } = createRuntime();
        await expect(runtime.whenReady()).resolves.toBe(true);

        expect(JC.getAcknowledgedUserSettingsSnapshot).toHaveBeenCalledWith('theme.json');
        expect(plugin).toHaveBeenCalledOnce();
        expect(runtime.getConfiguration()).toMatchObject({
            Revision: 5,
            Profiles: [expect.objectContaining({ BasePreset: 'studio' })],
        });
        expect(runtime.getDiagnostics()).toMatchObject({ status: 'active', revision: 5 });
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

    it('does not report a failed reload as successful when an acknowledgement is retained', async () => {
        const committed = themeConfiguration();
        const plugin = vi.fn()
            .mockResolvedValueOnce(committed)
            .mockRejectedValueOnce(new Error('server unavailable'));
        JC.core.api = { plugin } as unknown as ApiApi;
        const { runtime } = createRuntime();
        await runtime.load();
        const acknowledged = themeConfiguration();
        acknowledged.Revision = 8;
        acknowledged.Profiles[0].BasePreset = 'studio';
        expect(runtime.adoptAcknowledged(acknowledged)).toBe(true);
        const changed = vi.fn();
        window.addEventListener('jc:theme-studio-runtime-changed', changed);

        await expect(runtime.reload()).resolves.toBe(false);

        expect(runtime.getConfiguration()).toMatchObject({
            Revision: 8,
            Profiles: [expect.objectContaining({ BasePreset: 'studio' })],
        });
        expect(runtime.getDiagnostics()).toMatchObject({ status: 'active', revision: 8 });
        expect(changed).not.toHaveBeenCalled();
        window.removeEventListener('jc:theme-studio-runtime-changed', changed);
    });

    it('keeps a newer acknowledgement that arrives while a recovery reload fails', async () => {
        const committed = themeConfiguration();
        let rejectReload: (reason: unknown) => void = () => undefined;
        const plugin = vi.fn()
            .mockResolvedValueOnce(committed)
            .mockImplementationOnce(() => new Promise<unknown>((_resolve, reject) => {
                rejectReload = reject;
            }));
        JC.core.api = { plugin } as unknown as ApiApi;
        const { runtime } = createRuntime();
        await runtime.load();

        const reloadRequest = runtime.reload();
        const acknowledged = themeConfiguration();
        acknowledged.Revision = 8;
        acknowledged.Profiles[0].BasePreset = 'studio';
        expect(runtime.adoptAcknowledged(acknowledged)).toBe(true);
        rejectReload(new Error('server unavailable'));

        await expect(reloadRequest).resolves.toBe(false);
        expect(runtime.getConfiguration()).toMatchObject({
            Revision: 8,
            Profiles: [expect.objectContaining({ BasePreset: 'studio' })],
        });
        expect(runtime.getDiagnostics()).toMatchObject({ status: 'active', revision: 8 });
        expect(document.documentElement.getAttribute('data-jc-theme-preset')).toBe('studio');
    });

    it('accepts a supported store reset as a new authoritative revision generation', async () => {
        const committed = themeConfiguration();
        committed.Revision = 9;
        committed.Profiles[0].BasePreset = 'studio';
        const reset = themeConfiguration();
        reset.Revision = 0;
        reset.Profiles[0].BasePreset = 'material';
        const plugin = vi.fn().mockResolvedValueOnce(committed).mockResolvedValueOnce(reset);
        JC.core.api = { plugin } as unknown as ApiApi;
        const { runtime } = createRuntime();
        await runtime.load();

        await expect(runtime.reload()).resolves.toBe(true);

        expect(runtime.getConfiguration()).toMatchObject({
            Revision: 0,
            Profiles: [expect.objectContaining({ BasePreset: 'material' })],
        });
        expect(document.documentElement.getAttribute('data-jc-theme-preset')).toBe('material');
        expect(JC.rememberUserSettingsSnapshot).toHaveBeenLastCalledWith(
            'theme.json', expect.objectContaining({ Revision: 0 }),
        );
    });

    it('keeps a newer acknowledgement that arrives during a recovery reload', async () => {
        const committed = themeConfiguration();
        committed.Revision = 9;
        let resolveReset!: (value: unknown) => void;
        const plugin = vi.fn()
            .mockResolvedValueOnce(committed)
            .mockImplementationOnce(() => new Promise<unknown>((resolve) => { resolveReset = resolve; }));
        JC.core.api = { plugin } as unknown as ApiApi;
        const { runtime } = createRuntime();
        await runtime.load();
        const reload = runtime.reload();
        const acknowledged = themeConfiguration();
        acknowledged.Revision = 10;
        acknowledged.Profiles[0].BasePreset = 'studio';
        expect(runtime.adoptAcknowledged(acknowledged)).toBe(true);
        const reset = themeConfiguration();
        reset.Revision = 0;
        reset.Profiles[0].BasePreset = 'material';
        resolveReset(reset);

        await expect(reload).resolves.toBe(true);

        expect(runtime.getConfiguration()).toMatchObject({
            Revision: 10,
            Profiles: [expect.objectContaining({ BasePreset: 'studio' })],
        });
        expect(document.documentElement.getAttribute('data-jc-theme-preset')).toBe('studio');
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

    it('never lets an obsolete reload restore its snapshot over a newer reload', async () => {
        const committed = themeConfiguration();
        committed.Revision = 7;
        let resolveOlder!: (value: unknown) => void;
        let resolveNewer!: (value: unknown) => void;
        const plugin = vi.fn()
            .mockResolvedValueOnce(committed)
            .mockImplementationOnce(() => new Promise<unknown>((resolve) => { resolveOlder = resolve; }))
            .mockImplementationOnce(() => new Promise<unknown>((resolve) => { resolveNewer = resolve; }));
        JC.core.api = { plugin } as unknown as ApiApi;
        const { runtime } = createRuntime();
        await runtime.load();

        const olderReload = runtime.reload();
        const newerReload = runtime.reload();
        const newer = themeConfiguration();
        newer.Revision = 12;
        newer.Profiles[0].Palette = 'neutral';
        resolveNewer(newer);
        await expect(newerReload).resolves.toBe(true);
        const older = themeConfiguration();
        older.Revision = 8;
        older.Profiles[0].Palette = 'vivid';
        resolveOlder(older);
        await expect(olderReload).resolves.toBe(false);

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
        expect(runtime.hasPendingAuthoritativeLoad()).toBe(true);
        expect(runtime.getDiagnostics().status).toBe('active');

        const newer = themeConfiguration();
        newer.Revision = 5;
        newer.Profiles[0].Palette = 'vivid';
        resolveLoad(newer);
        await load;

        expect(runtime.getConfiguration()).toMatchObject({ Revision: 5 });
        expect(runtime.hasPendingAuthoritativeLoad()).toBe(false);
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
        expectRootThemeState({
            density: 'cozy',
            navigation: 'bottom',
            'home-hero': 'compact',
            details: 'classic',
            seasons: 'list',
            'card-actions': 'always',
            'poster-ratio': 'auto',
            'cast-shape': 'circle',
            'progress-position': 'bottom',
            'watched-indicator': 'check',
            'unwatched-indicator': 'corner',
            'player-osd-density': 'standard',
            'player-control-material': 'translucent',
            'player-pause-screen-material': 'translucent',
            'player-subtitle-backdrop': 'shadow',
            'player-trickplay-shape': 'rounded',
        });
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
        expect(document.documentElement.hasAttribute('data-jc-theme-breakpoint')).toBe(false);
        expect(document.getElementById(COMMITTED_STYLE_ID)).toBeNull();
        expect(runtime.getDiagnostics()).toMatchObject({ status: 'inactive', breakpoint: null, revision: 3 });

        window.innerWidth = 844;
        window.innerHeight = 390;
        media.set('(pointer: coarse)', true);
        media.set('(orientation: landscape) and (max-height: 599px) and (max-width: 999px) and (pointer: coarse)', true);
        expect(document.documentElement.getAttribute('data-jc-theme-breakpoint')).toBe('phone');
        expect(document.getElementById(COMMITTED_STYLE_ID)).not.toBeNull();
    });

    it('publishes capped effect and holiday schedule state with one bounded calendar timer', async () => {
        window.innerWidth = 1366;
        window.innerHeight = 768;
        vi.stubGlobal('CSS', { supports: vi.fn(() => true) });
        JC.pluginConfig.ThemeStudioMaximumEffectsLevel = 'balanced';
        JC.pluginConfig.ThemeStudioAllowDynamicColor = false;
        const configuration = themeConfiguration();
        configuration.ScheduleTimeZone = 'utc';
        configuration.Profiles[0].Tokens = {
            'effects.level': 'full',
            'effects.material': 'glass',
            'effects.image-treatment': 'blur',
            'motion.profile': 'expressive',
            'color.dynamic-source': 'poster',
        };
        configuration.Schedule = [{
            Id: 'year-round-holiday', ProfileId: 'default', Kind: 'holiday',
            StartMonthDay: '01-01', EndMonthDay: '12-31', Priority: 1, Enabled: true,
        }];
        const timeout = vi.spyOn(window, 'setTimeout');
        const clearTimeout = vi.spyOn(window, 'clearTimeout');
        apiReturning(configuration);
        const { runtime, harness } = createRuntime();
        await runtime.load();

        expectRootThemeState({
            breakpoint: 'desktop',
            'effects-level': 'balanced',
            'effects-material': 'glass',
            'image-treatment': 'gradient',
            'motion-profile': 'calm',
            'dynamic-source': 'off',
            'dynamic-accent': 'off',
            schedule: 'year-round-holiday',
            'schedule-kind': 'holiday',
            'schedule-time-zone': 'utc',
        });
        const calendarTimers = timeout.mock.calls.filter((call) =>
            typeof call[1] === 'number' && call[1] >= 1_000 && call[1] <= 6 * 60 * 60 * 1_000);
        expect(calendarTimers).toHaveLength(1);

        await harness.dispose();
        expect(clearTimeout).toHaveBeenCalled();
        expect(document.documentElement.hasAttribute('data-jc-theme-effects-level')).toBe(false);
    });

    it('derives one post-paint local accent, reuses one subscriber, and tears it down exactly', async () => {
        window.innerWidth = 1366;
        window.innerHeight = 768;
        vi.stubGlobal('CSS', { supports: vi.fn(() => true) });
        JC.pluginConfig.ThemeStudioMaximumEffectsLevel = 'full';
        JC.pluginConfig.ThemeStudioAllowDynamicColor = true;
        const unsubscribe = vi.fn();
        const onBodyMutation = vi.fn(() => ({ unsubscribe, disconnect: unsubscribe }));
        JC.core.dom = { onBodyMutation } as unknown as typeof JC.core.dom;
        const close = vi.fn();
        vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.resolve({ close })));
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { 'content-type': 'image/png', 'content-length': '3' },
        }))));
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
            drawImage: vi.fn(),
            getImageData: vi.fn(() => ({ data: new Uint8ClampedArray([
                230, 40, 80, 255, 230, 40, 80, 255, 230, 40, 80, 255,
            ]) })),
        } as unknown as CanvasRenderingContext2D);
        document.body.innerHTML = '<img src="/Items/private-item/Images/Primary?tag=private-tag">';
        const configuration = themeConfiguration();
        configuration.Profiles[0].Tokens = {
            'effects.level': 'full',
            'color.dynamic-source': 'poster',
            'color.dynamic-strength': 1,
        };
        apiReturning(configuration);
        const { runtime, harness } = createRuntime();
        await runtime.load();

        await vi.waitFor(() => expect(document.documentElement.getAttribute('data-jc-theme-dynamic-accent'))
            .toBe('active'));
        expect(onBodyMutation).toHaveBeenCalledOnce();
        runtime.refresh();
        runtime.refresh();
        expect(onBodyMutation).toHaveBeenCalledOnce();
        const css = document.getElementById(DYNAMIC_ACCENT_STYLE_ID)?.textContent ?? '';
        expect(css).toContain('--jf-palette-primary-main: #E62850');
        expect(css).not.toContain('/Items/');
        expect(css).not.toContain('private-tag');
        expect(close).toHaveBeenCalledOnce();

        await harness.dispose();
        expect(unsubscribe).toHaveBeenCalledOnce();
        expect(document.getElementById(DYNAMIC_ACCENT_STYLE_ID)).toBeNull();
    });

    it('bounds failed dynamic analysis to three backoff attempts despite noisy body mutations', async () => {
        window.innerWidth = 1366;
        window.innerHeight = 768;
        vi.stubGlobal('CSS', { supports: vi.fn(() => true) });
        JC.pluginConfig.ThemeStudioMaximumEffectsLevel = 'full';
        JC.pluginConfig.ThemeStudioAllowDynamicColor = true;
        let notifyMutation = (): void => undefined;
        JC.core.dom = {
            onBodyMutation: vi.fn((_key: string, callback: () => void) => {
                notifyMutation = callback;
                return { unsubscribe: vi.fn(), disconnect: vi.fn() };
            }),
        } as unknown as typeof JC.core.dom;
        const clockStart = Date.now();
        const retryHandlers: Array<() => void> = [];
        const nativeSetTimeout = window.setTimeout.bind(window);
        const isTimerCallback = (value: TimerHandler): value is (...args: unknown[]) => void =>
            typeof value === 'function';
        vi.spyOn(window, 'setTimeout').mockImplementation((handler, delay) => {
            if ((delay === 1_000 || delay === 5_000) && isTimerCallback(handler)) {
                retryHandlers.push(() => { handler(); });
                return 9_000 + retryHandlers.length;
            }
            return nativeSetTimeout(handler, delay);
        });
        const fetchMock = vi.fn(() => Promise.reject(new TypeError('temporary local image failure')));
        vi.stubGlobal('createImageBitmap', vi.fn());
        vi.stubGlobal('fetch', fetchMock);
        document.body.innerHTML = '<img src="/Items/private-item/Images/Primary?tag=private-tag">';
        const configuration = themeConfiguration();
        configuration.Profiles[0].Tokens = {
            'effects.level': 'full',
            'color.dynamic-source': 'poster',
        };
        apiReturning(configuration);
        createRuntime();
        await JC.core.themeStudio?.whenReady();

        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        expect(retryHandlers).toHaveLength(1);
        for (let index = 0; index < 100; index += 1) notifyMutation();
        await Promise.resolve();
        expect(fetchMock).toHaveBeenCalledTimes(1);

        const dateNow = vi.spyOn(Date, 'now').mockReturnValue(clockStart + 10_000);
        retryHandlers[0]();
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        expect(retryHandlers).toHaveLength(2);
        for (let index = 0; index < 100; index += 1) notifyMutation();
        await Promise.resolve();
        expect(fetchMock).toHaveBeenCalledTimes(2);

        dateNow.mockReturnValue(clockStart + 20_000);
        retryHandlers[1]();
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
        for (let index = 0; index < 100; index += 1) notifyMutation();
        await new Promise<void>((resolve) => nativeSetTimeout(resolve, 20));
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(retryHandlers).toHaveLength(2);
        expect(document.documentElement.getAttribute('data-jc-theme-dynamic-accent')).toBe('fallback');
    });

    it('leaves legacy and TV layouts untouched and reactivates only on a supported modern surface', async () => {
        apiReturning(themeConfiguration());
        const { runtime } = createRuntime();
        await runtime.load();
        const hostTheme = document.documentElement.getAttribute('data-theme');
        expect(document.getElementById(COMMITTED_STYLE_ID)).not.toBeNull();

        document.documentElement.classList.remove('jc-modern-layout');
        document.documentElement.classList.add('jc-legacy-layout');
        await vi.waitFor(() => expect(document.getElementById(COMMITTED_STYLE_ID)).toBeNull());
        expect(document.documentElement.hasAttribute('data-jc-theme-active')).toBe(false);
        expect(runtime.getDiagnostics()).toMatchObject({ status: 'inactive', breakpoint: null });
        expect(runtime.preview(themeConfiguration())).toBe(false);
        expect(document.documentElement.getAttribute('data-theme')).toBe(hostTheme);

        document.documentElement.classList.remove('jc-legacy-layout');
        document.documentElement.classList.add('jc-modern-layout', 'layout-tv');
        await Promise.resolve();
        runtime.refresh();
        expect(document.getElementById(COMMITTED_STYLE_ID)).toBeNull();
        expect(document.documentElement.hasAttribute('data-jc-theme-active')).toBe(false);

        document.documentElement.classList.remove('layout-tv');
        runtime.refresh();
        expect(document.getElementById(COMMITTED_STYLE_ID)).not.toBeNull();
        expect(document.documentElement.getAttribute('data-jc-theme-breakpoint')).toBe('phone');
    });

    it('tracks visual viewport and capability state only for the modern phone breakpoint', async () => {
        const viewport = Object.assign(new EventTarget(), { height: 500, offsetTop: 0, scale: 1 });
        vi.stubGlobal('visualViewport', viewport);
        vi.stubGlobal('CSS', undefined);
        apiReturning(themeConfiguration());
        const { runtime } = createRuntime();

        const input = document.createElement('input');
        document.body.append(input);
        input.focus();

        await runtime.load();

        expectRootThemeState({
            breakpoint: 'phone',
            orientation: 'portrait',
            keyboard: 'open',
            performance: 'reduced',
        });
        expect(document.getElementById(MOBILE_ENVIRONMENT_STYLE_ID)?.textContent).toContain(
            '--jc-visual-viewport-height: 500px',
        );
        expect(document.getElementById(MOBILE_ENVIRONMENT_STYLE_ID)?.textContent).toContain(
            '--jc-keyboard-inset: 344px',
        );
        expect(document.getElementById(MOBILE_ENVIRONMENT_STYLE_ID)?.textContent).toContain(
            '[data-jc-theme-breakpoint="phone"][data-jc-theme-route]',
        );

        const refresh = vi.spyOn(runtime, 'refresh');
        const started = performance.now();
        viewport.height = 480;
        for (let index = 0; index < 100; index += 1) viewport.dispatchEvent(new Event('scroll'));
        await vi.waitFor(() => expect(document.getElementById(MOBILE_ENVIRONMENT_STYLE_ID)?.textContent)
            .toContain('--jc-visual-viewport-height: 480px'));
        expect(refresh).not.toHaveBeenCalled();
        expect(performance.now() - started).toBeLessThan(250);

        viewport.height = 300;
        viewport.scale = 2;
        viewport.dispatchEvent(new Event('resize'));
        await vi.waitFor(() => expect(document.documentElement.getAttribute('data-jc-theme-keyboard'))
            .toBe('closed'));
        expect(document.getElementById(MOBILE_ENVIRONMENT_STYLE_ID)?.textContent).toContain(
            '--jc-keyboard-inset: 0px',
        );

        window.innerWidth = 1366;
        window.innerHeight = 768;
        viewport.height = 768;
        viewport.scale = 1;
        window.dispatchEvent(new Event('resize'));
        await vi.waitFor(() => expect(document.documentElement.getAttribute('data-jc-theme-breakpoint'))
            .toBe('desktop'));
        expect(refresh).toHaveBeenCalledTimes(1);
        expectRootThemeState({
            orientation: 'landscape', keyboard: 'closed', performance: 'full',
        });
        expect(document.getElementById(MOBILE_ENVIRONMENT_STYLE_ID)).toBeNull();
        input.remove();
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
            Tokens: {
                'shape.card-radius': 'pill',
                'layout.home-hero': 'cinematic',
                'layout.details': 'compact',
                'layout.seasons': 'grid',
                'layout.poster-ratio': 'square',
                'layout.cast-shape': 'rounded',
                'progress.position': 'floating',
                'progress.watched-indicator': 'floating',
                'progress.unwatched-indicator': 'none',
                'player.osd-density': 'cinematic',
                'player.control-material': 'glass',
                'player.pause-screen-material': 'solid',
                'player.subtitle-backdrop': 'box',
                'player.trickplay-shape': 'pill',
            },
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
            'home-hero': 'cinematic',
            details: 'compact',
            seasons: 'grid',
            'poster-ratio': 'square',
            'cast-shape': 'rounded',
            'progress-position': 'floating',
            'watched-indicator': 'floating',
            'unwatched-indicator': 'none',
            'player-osd-density': 'cinematic',
            'player-control-material': 'glass',
            'player-pause-screen-material': 'solid',
            'player-subtitle-backdrop': 'box',
            'player-trickplay-shape': 'pill',
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
            'home-hero': 'compact',
            details: 'classic',
            seasons: 'list',
            'poster-ratio': 'auto',
            'cast-shape': 'circle',
            'progress-position': 'bottom',
            'watched-indicator': 'check',
            'unwatched-indicator': 'corner',
            'player-osd-density': 'standard',
            'player-control-material': 'translucent',
            'player-pause-screen-material': 'translucent',
            'player-subtitle-backdrop': 'shadow',
            'player-trickplay-shape': 'rounded',
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
            ':root.jc-modern-layout[data-jc-theme-active="true"]:not([data-jc-theme-preview="true"])',
        )).toBe(false);

        JC.core.themeStudio?.cancelPreview();
        expectRootThemeState({ motion: 'reduced' });
        expect(document.documentElement.matches(
            ':root.jc-modern-layout[data-jc-theme-active="true"]:not([data-jc-theme-preview="true"])',
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
