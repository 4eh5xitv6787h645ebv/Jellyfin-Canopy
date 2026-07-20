import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import { themeConfiguration } from '../../test/theme-studio-fixture';
import type {
    ApiApi,
    IdentityContext,
    ThemeStudioPreviewOptions,
    ThemeStudioRuntimeApi,
    UserThemeConfiguration,
} from '../../types/jc';
import type { UserSettingsSaveResult } from '../config';
import type { PanelContext } from './panel';
import { wireThemeStudioEditor } from './theme-editor';

let identity: IdentityContext;
let panel: HTMLElement;
let cleanups: Array<() => void>;
let preview: ReturnType<typeof vi.fn<(value: unknown, options?: ThemeStudioPreviewOptions) => boolean>>;
let cancelPreview: ReturnType<typeof vi.fn<() => void>>;
let adoptAcknowledged: ReturnType<typeof vi.fn<(value: unknown) => boolean>>;
let reload: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
let resetAutoCloseTimer: ReturnType<typeof vi.fn<() => void>>;
let setAutoCloseSuspended: ReturnType<typeof vi.fn<(suspended: boolean) => void>>;
let configuration: UserThemeConfiguration;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
const originalThemeStudio = JC.core.themeStudio;
const originalApi = JC.core.api;
const originalPluginConfig = JC.pluginConfig;
const originalSave = JC.saveUserSettings;
const originalT = JC.t;

function context(): PanelContext {
    return {
        help: panel,
        identityContext: identity,
        registerCleanup(cleanup) { cleanups.push(cleanup); },
        trackTimer: () => undefined,
        pluginShortcuts: [],
        resetAutoCloseTimer,
        setAutoCloseSuspended,
        panelBgColor: '#181818',
        headerFooterBg: '#202020',
        detailsBackground: '#202020',
        primaryAccentColor: '#00d4ff',
        toggleAccentColor: '#2f80ff',
        kbdBackground: '#303030',
        presetBoxBackground: '#303030',
        githubButtonBg: '#303030',
        releaseNotesTextColor: '#fff',
        logoUrl: '',
        brandGradient: 'linear-gradient(#00d4ff,#2f80ff)',
    };
}

function button(action: string, value?: string): HTMLButtonElement {
    const suffix = value ? `[data-value="${value}"]` : '';
    return panel.querySelector<HTMLButtonElement>(`button[data-action="${action}"]${suffix}`)!;
}

function flushFrames(): void {
    const pending = [...frames.entries()];
    frames.clear();
    for (const [, callback] of pending) callback(16);
}

function acknowledgedTheme(
    value: UserThemeConfiguration,
    revision: number,
    contentHash = 'a'.repeat(64),
): UserSettingsSaveResult {
    const data = structuredClone(value);
    data.Revision = revision;
    return {
        acknowledged: true,
        deduplicated: false,
        file: 'theme.json',
        revision,
        contentHash,
        data: data as unknown as Record<string, unknown>,
    };
}

interface MutableMediaQueryList extends MediaQueryList {
    setMatches(value: boolean): void;
}

function editorMediaHarness(): {
    matchMedia: (query: string) => MediaQueryList;
    set(query: string, matches: boolean): void;
} {
    const lists = new Map<string, MutableMediaQueryList>();
    const matchMedia = (query: string): MediaQueryList => {
        const existing = lists.get(query);
        if (existing) return existing;
        let matches = false;
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

beforeEach(() => {
    vi.useFakeTimers();
    frames = new Map();
    nextFrame = 1;
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
        const id = nextFrame++;
        frames.set(id, callback);
        return id;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => { frames.delete(id); }));
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-layout');
    document.documentElement.classList.remove('layout-tv');
    document.body.classList.remove('layout-tv');
    JC.identity.transition('', '', 'theme-editor-test-logout');
    identity = JC.identity.transition('server-a', 'user-a', 'theme-editor-test-login')!;
    JC.pluginConfig = { ...JC.pluginConfig, ThemeStudioAllowProfileImport: true };
    configuration = JC.identity.own(themeConfiguration(), identity);
    preview = vi.fn<(value: unknown, options?: ThemeStudioPreviewOptions) => boolean>(() => true);
    cancelPreview = vi.fn<() => void>();
    adoptAcknowledged = vi.fn(() => true);
    reload = vi.fn().mockResolvedValue(true);
    resetAutoCloseTimer = vi.fn<() => void>();
    setAutoCloseSuspended = vi.fn<(suspended: boolean) => void>();
    JC.core.themeStudio = {
        preview,
        cancelPreview,
        getConfiguration: () => JC.identity.own(structuredClone(configuration), identity),
        whenReady: vi.fn().mockResolvedValue(true),
        hasPendingAuthoritativeLoad: () => false,
        reload,
        adoptAcknowledged,
        refresh: vi.fn<() => void>(),
        getDiagnostics: () => ({
            status: 'active', revision: configuration.Revision, profileId: configuration.ActiveProfileId,
            breakpoint: 'desktop', mode: 'dark',
        }),
    } satisfies ThemeStudioRuntimeApi;
    JC.t = (key: string, params?: Record<string, unknown>) => {
        let result = key;
        for (const [name, value] of Object.entries(params ?? {})) {
            result = result.replaceAll(`{${name}}`, String(value));
        }
        return result;
    };
    cleanups = [];
    panel = document.createElement('div');
    panel.id = 'jellyfin-canopy-panel';
    panel.innerHTML = '<section data-pane="theme-studio"><div data-theme-editor-root></div></section>';
    const backdrop = document.createElement('div');
    backdrop.id = 'jellyfin-canopy-panel-backdrop';
    document.body.append(backdrop, panel);
});

afterEach(() => {
    for (const cleanup of cleanups.reverse()) cleanup();
    panel.remove();
    document.getElementById('jellyfin-canopy-panel-backdrop')?.remove();
    JC.core.themeStudio = originalThemeStudio;
    JC.core.api = originalApi;
    JC.pluginConfig = originalPluginConfig;
    JC.saveUserSettings = originalSave;
    JC.t = originalT;
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('Theme Studio responsive settings editor', () => {
    it('renders the split workflow and frame-coalesces valid live preview changes', () => {
        wireThemeStudioEditor(context());
        expect(panel.querySelector('.jc-theme-studio')).not.toBeNull();
        expect(panel.querySelectorAll('.jc-theme-preset')).toHaveLength(9);
        expect(panel.querySelector('.jc-theme-preset-grid')?.getAttribute('role')).toBe('group');
        expect(button('preset', 'canopy').getAttribute('role')).toBeNull();
        expect(button('apply').disabled).toBe(true);
        const initialPreview = panel.querySelector<HTMLElement>('.jc-theme-preview-card')!;
        const initialColors = [
            initialPreview.style.getPropertyValue('--jc-preview-canvas'),
            initialPreview.style.getPropertyValue('--jc-preview-surface'),
            initialPreview.style.getPropertyValue('--jc-preview-primary'),
        ];
        expect(initialPreview.querySelector('button')).toBeNull();
        expect(initialPreview.querySelector('.jc-theme-preview-action')?.tagName).toBe('SPAN');
        const search = panel.querySelector<HTMLInputElement>('[data-field="preset-search"]')!;
        search.focus();
        search.value = 'oled';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        expect(document.activeElement).toBe(search);
        expect(panel.querySelectorAll('.jc-theme-preset:not([hidden])')).toHaveLength(1);
        search.value = '';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        expect(panel.querySelectorAll('.jc-theme-preset:not([hidden])')).toHaveLength(9);

        button('preset', 'oled').focus();
        button('preset', 'oled').click();
        expect(document.activeElement).toBe(button('preset', 'oled'));
        const palette = panel.querySelector<HTMLSelectElement>('[data-field="palette"]')!;
        palette.focus();
        palette.value = 'neutral';
        palette.dispatchEvent(new Event('change', { bubbles: true }));
        expect(document.activeElement).toBe(panel.querySelector('[data-field="palette"]'));
        const stagedPreview = panel.querySelector<HTMLElement>('.jc-theme-preview-card')!;
        const stagedColors = [
            stagedPreview.style.getPropertyValue('--jc-preview-canvas'),
            stagedPreview.style.getPropertyValue('--jc-preview-surface'),
            stagedPreview.style.getPropertyValue('--jc-preview-primary'),
        ];
        expect(stagedColors).not.toEqual(initialColors);
        expect(stagedColors.every((color) => /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(color))).toBe(true);
        const accent = panel.querySelector<HTMLSelectElement>('[data-field="accent"]')!;
        const palettePrimary = stagedPreview.style.getPropertyValue('--jc-preview-primary');
        accent.value = 'red';
        accent.dispatchEvent(new Event('change', { bubbles: true }));
        expect(panel.querySelector<HTMLElement>('.jc-theme-preview-card')?.style
            .getPropertyValue('--jc-preview-primary')).not.toBe(palettePrimary);
        button('mode', 'dark').click();
        const darkCanvas = panel.querySelector<HTMLElement>('.jc-theme-preview-card')?.style
            .getPropertyValue('--jc-preview-canvas');
        button('mode', 'light').click();
        expect(panel.querySelector<HTMLElement>('.jc-theme-preview-card')?.style
            .getPropertyValue('--jc-preview-canvas')).not.toBe(darkCanvas);

        expect(preview).not.toHaveBeenCalled();
        expect(frames).toHaveLength(1);
        flushFrames();
        expect(preview).toHaveBeenCalledOnce();
        expect(preview).toHaveBeenCalledWith(expect.objectContaining({
            Profiles: [expect.objectContaining({ BasePreset: 'oled', Palette: 'neutral' })],
        }), { allowScheduling: false });
        expect(button('apply').disabled).toBe(false);
    });

    it('refreshes the preview card for responsive, system-scheme, and host-theme changes', async () => {
        const media = editorMediaHarness();
        vi.stubGlobal('matchMedia', media.matchMedia);
        vi.stubGlobal('innerWidth', 1200);
        vi.stubGlobal('innerHeight', 800);
        document.documentElement.removeAttribute('data-theme');
        configuration.Profiles[0].Accent = 'palette';
        configuration.Profiles[0].Responsive.Desktop = { Tokens: { 'color.primary': '#222222' } };
        configuration.Profiles[0].Responsive.Phone = { Tokens: { 'color.primary': '#111111' } };
        configuration.Profiles[0].Responsive.Tv = { Tokens: { 'color.primary': '#333333' } };
        wireThemeStudioEditor(context());
        const color = (name: string): string => panel.querySelector<HTMLElement>('.jc-theme-preview-card')!
            .style.getPropertyValue(name);
        expect(color('--jc-preview-primary')).toBe('#222222');
        const lightCanvas = color('--jc-preview-canvas');

        window.innerWidth = 390;
        window.innerHeight = 844;
        window.dispatchEvent(new Event('resize'));
        expect(frames).toHaveLength(1);
        flushFrames();
        expect(color('--jc-preview-primary')).toBe('#111111');

        media.set('(prefers-color-scheme: dark)', true);
        expect(frames).toHaveLength(1);
        flushFrames();
        expect(color('--jc-preview-canvas')).not.toBe(lightCanvas);

        document.documentElement.setAttribute('data-theme', 'light');
        await Promise.resolve();
        expect(frames).toHaveLength(1);
        flushFrames();
        expect(color('--jc-preview-canvas')).toBe(lightCanvas);

        document.documentElement.setAttribute('data-layout', 'tv');
        await Promise.resolve();
        expect(frames).toHaveLength(1);
        flushFrames();
        expect(color('--jc-preview-primary')).toBe('#333333');
    });

    it('keeps page preview reachable on phones and removes it on Cancel and teardown', () => {
        const media = editorMediaHarness();
        vi.stubGlobal('matchMedia', media.matchMedia);
        media.set('(max-width:760px), (orientation:landscape) and (max-height:599px) and (max-width:999px) and (pointer:coarse)', true);
        wireThemeStudioEditor(context());
        const styles = panel.querySelector('style')?.textContent ?? '';
        expect(styles.indexOf('#jellyfin-canopy-panel.jc-theme-preview-only .jc-theme-return'))
            .toBeGreaterThan(-1);
        expect(styles.indexOf('#jellyfin-canopy-panel.jc-theme-preview-only .jc-theme-return'))
            .toBeLessThan(styles.indexOf('@media'));
        expect(styles.indexOf('#jellyfin-canopy-panel.jc-theme-preview-only .jc-theme-studio'))
            .toBeLessThan(styles.indexOf('@media'));
        button('preset', 'glass').click();
        flushFrames();
        button('preview-only').focus();
        button('preview-only').click();
        expect(panel.classList.contains('jc-theme-preview-only')).toBe(true);
        expect(document.activeElement).toBe(button('return-editor'));
        expect(document.getElementById('jellyfin-canopy-panel-backdrop')?.classList
            .contains('jc-theme-preview-backdrop-hidden')).toBe(true);
        button('return-editor').click();
        expect(panel.classList.contains('jc-theme-preview-only')).toBe(false);
        expect(document.activeElement).toBe(button('preview-only'));
        expect(document.getElementById('jellyfin-canopy-panel-backdrop')?.classList
            .contains('jc-theme-preview-backdrop-hidden')).toBe(false);

        button('cancel').click();
        expect(cancelPreview).toHaveBeenCalledOnce();
        expect(button('apply').disabled).toBe(true);
        cleanups[0]();
        expect(cancelPreview).toHaveBeenCalledTimes(2);
        expect(panel.classList.contains('jc-theme-preview-only')).toBe(false);
    });

    it('cancels a queued preview frame before discarding the draft', () => {
        wireThemeStudioEditor(context());
        button('preset', 'glass').click();
        expect(frames).toHaveLength(1);

        button('cancel').click();
        expect(frames).toHaveLength(0);
        flushFrames();

        expect(preview).not.toHaveBeenCalled();
        expect(cancelPreview).toHaveBeenCalledOnce();
        expect(button('apply').disabled).toBe(true);
    });

    it('clears staged preview state when Undo returns exactly to the baseline', () => {
        wireThemeStudioEditor(context());
        button('preset', 'studio').click();
        flushFrames();
        expect(preview).toHaveBeenCalledOnce();

        button('undo').click();
        flushFrames();

        expect(preview).toHaveBeenCalledOnce();
        expect(cancelPreview).toHaveBeenCalledOnce();
        expect(button('apply').disabled).toBe(true);
        expect(panel.textContent).toContain('theme_studio_ready');
        expect(panel.textContent).not.toContain('theme_studio_unsaved');
    });

    it('stages an undoable reset to validated administrator defaults without saving', () => {
        JC.pluginConfig.ThemeStudioDefaultPreset = 'material';
        JC.pluginConfig.ThemeStudioDefaultPalette = 'neutral';
        JC.saveUserSettings = vi.fn().mockResolvedValue({});
        wireThemeStudioEditor(context());

        button('reset-profile').click();
        flushFrames();

        expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({
            Profiles: [expect.objectContaining({
                Id: 'default', Name: 'Default', BasePreset: 'material', Palette: 'neutral',
                Accent: 'palette', Mode: 'system', Tokens: {},
            })],
        }), { allowScheduling: false });
        expect(panel.textContent).toContain('theme_studio_reset_done');
        expect(button('apply').disabled).toBe(false);
        expect(JC.saveUserSettings).not.toHaveBeenCalled();

        button('undo').click();
        flushFrames();
        expect(button('preset', 'canopy').getAttribute('aria-pressed')).toBe('true');
        expect(button('apply').disabled).toBe(true);
        expect(cancelPreview).toHaveBeenCalledOnce();
    });

    it('commits a valid staged profile name before reset and keeps it when reset is undone', () => {
        JC.pluginConfig.ThemeStudioDefaultPreset = 'material';
        wireThemeStudioEditor(context());
        let input = panel.querySelector<HTMLInputElement>('[data-role="profile-name"]')!;
        input.value = 'Living room';
        input.dispatchEvent(new Event('input', { bubbles: true }));

        button('reset-profile').click();
        flushFrames();

        input = panel.querySelector<HTMLInputElement>('[data-role="profile-name"]')!;
        expect(input.value).toBe('Living room');
        expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({
            Profiles: [expect.objectContaining({ Name: 'Living room', BasePreset: 'material' })],
        }), { allowScheduling: false });

        button('undo').click();
        input = panel.querySelector<HTMLInputElement>('[data-role="profile-name"]')!;
        expect(input.value).toBe('Living room');
        expect(button('preset', 'canopy').getAttribute('aria-pressed')).toBe('true');
        expect(button('apply').disabled).toBe(false);
    });

    it('preserves workspace and Expert JSON scrolling across full editor rerenders', () => {
        wireThemeStudioEditor(context());
        let studio = panel.querySelector<HTMLElement>('.jc-theme-studio')!;
        studio.scrollTop = 231;
        studio.scrollLeft = 17;
        const palette = panel.querySelector<HTMLSelectElement>('[data-field="palette"]')!;
        palette.value = 'neutral';
        palette.dispatchEvent(new Event('change', { bubbles: true }));

        studio = panel.querySelector<HTMLElement>('.jc-theme-studio')!;
        expect(studio.scrollTop).toBe(231);
        expect(studio.scrollLeft).toBe(17);

        button('editor-mode', 'expert').click();
        studio = panel.querySelector<HTMLElement>('.jc-theme-studio')!;
        const expert = panel.querySelector<HTMLTextAreaElement>('[data-field="expert-json"]')!;
        studio.scrollTop = 319;
        expert.scrollTop = 143;
        expert.scrollLeft = 29;
        expert.value = `${expert.value}\n`;
        expert.dispatchEvent(new Event('input', { bubbles: true }));
        vi.advanceTimersByTime(250);

        studio = panel.querySelector<HTMLElement>('.jc-theme-studio')!;
        const renderedExpert = panel.querySelector<HTMLTextAreaElement>('[data-field="expert-json"]')!;
        expect(studio.scrollTop).toBe(319);
        expect(renderedExpert.scrollTop).toBe(143);
        expect(renderedExpert.scrollLeft).toBe(29);
    });

    it('preserves an in-progress profile name across mobile preview rerenders', () => {
        const viewport = Object.assign(new EventTarget(), { height: 412, offsetTop: 177 });
        vi.stubGlobal('visualViewport', viewport);
        wireThemeStudioEditor(context());
        let input = panel.querySelector<HTMLInputElement>('[data-role="profile-name"]')!;
        input.focus();
        input.value = 'Phone living room';
        input.setSelectionRange(7, 7);
        input.dispatchEvent(new Event('input', { bubbles: true }));

        viewport.height = 360;
        viewport.offsetTop = 201;
        viewport.dispatchEvent(new Event('resize'));
        flushFrames();

        input = panel.querySelector<HTMLInputElement>('[data-role="profile-name"]')!;
        expect(input.value).toBe('Phone living room');
        expect(document.activeElement).toBe(input);
        expect(input.selectionStart).toBe(7);
        expect(button('apply').disabled).toBe(false);
        expect(setAutoCloseSuspended).toHaveBeenLastCalledWith(true);
        expect(preview).not.toHaveBeenCalled();
    });

    it('surfaces invalid profile names and bounds localized duplicate names', () => {
        JC.t = (key: string, params?: Record<string, unknown>) => {
            const name = typeof params?.name === 'string' ? params.name : '';
            return key === 'theme_studio_copy_name' ? `${name} copy` : key;
        };
        wireThemeStudioEditor(context());
        let input = panel.querySelector<HTMLInputElement>('[data-role="profile-name"]')!;
        input.value = '   ';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        button('rename-profile').click();

        input = panel.querySelector<HTMLInputElement>('[data-role="profile-name"]')!;
        expect(input.getAttribute('aria-invalid')).toBe('true');
        expect(panel.querySelector<HTMLElement>('[data-role="profile-name-error"]')?.hidden).toBe(false);
        expect(panel.textContent).toContain('theme_studio_profile_name_invalid');
        expect(button('apply').disabled).toBe(true);

        input.value = 'N'.repeat(80);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        button('add-profile').click();
        flushFrames();

        const duplicated = preview.mock.lastCall?.[0] as UserThemeConfiguration;
        expect(duplicated.Profiles).toHaveLength(2);
        expect([...duplicated.Profiles[1].Name]).toHaveLength(80);
        expect(duplicated.Profiles[1].Name).toMatch(/ copy$/);
        expect(panel.querySelector('[aria-invalid="true"]')).toBeNull();
    });

    it('accepts the full rune-based profile-name limit for non-BMP characters', () => {
        wireThemeStudioEditor(context());
        const input = panel.querySelector<HTMLInputElement>('[data-role="profile-name"]')!;
        const name = '🎥'.repeat(80);

        expect(input.maxLength).toBe(-1);
        input.value = name;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        button('rename-profile').click();
        flushFrames();

        expect(panel.querySelector<HTMLInputElement>('[data-role="profile-name"]')?.value).toBe(name);
        expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({
            Profiles: [expect.objectContaining({ Name: name })],
        }), { allowScheduling: false });
        expect(button('apply').disabled).toBe(false);
    });

    it('normalizes a no-op profile rename without reporting a clean draft as unsaved', () => {
        wireThemeStudioEditor(context());
        const input = panel.querySelector<HTMLInputElement>('[data-role="profile-name"]')!;
        input.value = `  ${configuration.Profiles[0].Name}  `;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(panel.textContent).toContain('theme_studio_unsaved');

        button('rename-profile').click();

        expect(panel.querySelector<HTMLInputElement>('[data-role="profile-name"]')?.value)
            .toBe(configuration.Profiles[0].Name);
        expect(panel.textContent).toContain('theme_studio_ready');
        expect(panel.textContent).not.toContain('theme_studio_unsaved');
        expect(button('apply').disabled).toBe(true);
        expect(preview).not.toHaveBeenCalled();
    });

    it('blocks deletion of profiles referenced by dormant schedules until scheduling is enabled', () => {
        JC.pluginConfig.ThemeStudioAllowSeasonalScheduling = false;
        configuration.Profiles.push({
            ...structuredClone(configuration.Profiles[0]),
            Id: 'spare',
            Name: 'Spare',
        });
        configuration.Schedule = [{
            Id: 'winter', ProfileId: configuration.ActiveProfileId,
            StartMonthDay: '12-01', EndMonthDay: '02-28', Priority: 10, Enabled: true,
        }];
        wireThemeStudioEditor(context());

        expect(button('delete-profile').disabled).toBe(true);
        expect(panel.querySelectorAll('[data-field="profile"] option')).toHaveLength(2);

        JC.pluginConfig.ThemeStudioAllowSeasonalScheduling = true;
        window.dispatchEvent(new CustomEvent('jc:config-changed'));

        expect(button('delete-profile').disabled).toBe(false);
    });

    it('adopts the exact acknowledgement when a joined saver leaves this target untouched', async () => {
        const authoritative = themeConfiguration();
        authoritative.Profiles[0].BasePreset = 'studio';
        authoritative.Profiles[0].Name = 'Renamed elsewhere';
        authoritative.Schedule = [{
            Id: 'remote-schedule', ProfileId: 'default', StartMonthDay: '01-01', EndMonthDay: '12-31',
            Priority: 5, Enabled: true,
        }];
        JC.saveUserSettings = vi.fn((): Promise<UserSettingsSaveResult> => Promise.resolve(
            acknowledgedTheme(authoritative, 4),
        ));
        wireThemeStudioEditor(context());
        button('preset', 'studio').click();
        flushFrames();
        expect(JC.saveUserSettings).not.toHaveBeenCalled();

        button('apply').click();
        await vi.waitFor(() => expect(adoptAcknowledged).toHaveBeenCalledOnce());
        expect(JC.saveUserSettings).toHaveBeenCalledOnce();
        expect(JC.saveUserSettings).toHaveBeenCalledWith(
            'theme.json', expect.objectContaining({ Revision: 3, Profiles: [expect.objectContaining({ BasePreset: 'studio' })] }),
        );
        expect(adoptAcknowledged).toHaveBeenCalledWith(expect.objectContaining({
            Revision: 4,
            Profiles: [expect.objectContaining({ Name: 'Renamed elsewhere' })],
            Schedule: [expect.objectContaining({ Id: 'remote-schedule' })],
        }));
        expect(panel.querySelector<HTMLInputElement>('[data-role="profile-name"]')?.value)
            .toBe('Renamed elsewhere');
        expect(button('apply').disabled).toBe(true);
    });

    it('accepts an exact acknowledgement while the runtime is between live-config generations', async () => {
        let resolveSave: (result: UserSettingsSaveResult) => void = () => undefined;
        JC.saveUserSettings = vi.fn(() => new Promise<UserSettingsSaveResult>((resolve) => {
            resolveSave = resolve;
        }));
        const replacementRuntime = JC.core.themeStudio!;
        wireThemeStudioEditor(context());
        button('preset', 'studio').click();
        button('apply').click();

        delete JC.core.themeStudio;
        window.dispatchEvent(new CustomEvent('jc:theme-studio-runtime-changed', {
            detail: { reason: 'disposed' },
        }));
        const authoritative = themeConfiguration();
        authoritative.Revision = 4;
        authoritative.Profiles[0].BasePreset = 'studio';
        configuration = JC.identity.own(structuredClone(authoritative), identity);
        resolveSave(acknowledgedTheme(authoritative, 4, 'e'.repeat(64)));

        await vi.waitFor(() => expect(panel.textContent).toContain('theme_studio_saved'));
        expect(panel.textContent).not.toContain('theme_studio_error_protocol');
        expect(button('apply').disabled).toBe(true);

        const replacementAdopt = vi.fn(() => true);
        JC.core.themeStudio = { ...replacementRuntime, adoptAcknowledged: replacementAdopt };
        window.dispatchEvent(new CustomEvent('jc:theme-studio-runtime-changed', {
            detail: { reason: 'installed' },
        }));

        await vi.waitFor(() => expect(replacementAdopt).toHaveBeenCalledWith(
            expect.objectContaining({ Revision: 4, Profiles: [expect.objectContaining({ BasePreset: 'studio' })] }),
        ));
        await vi.waitFor(() => expect(panel.textContent).toContain('theme_studio_ready'));
        expect(button('apply').disabled).toBe(true);
    });

    it('freezes every draft mutation while Apply is awaiting acknowledgement', async () => {
        let resolveSave: (result: UserSettingsSaveResult) => void = () => undefined;
        JC.saveUserSettings = vi.fn(() => new Promise<UserSettingsSaveResult>((resolve) => {
            resolveSave = resolve;
        }));
        wireThemeStudioEditor(context());
        button('preset', 'studio').click();
        button('apply').click();

        expect(panel.querySelector<HTMLFieldSetElement>('.jc-theme-workspace')?.disabled).toBe(true);
        button('preset', 'oled').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const authoritative = themeConfiguration();
        authoritative.Profiles[0].BasePreset = 'studio';
        resolveSave(acknowledgedTheme(authoritative, 3, 'b'.repeat(64)));
        await vi.waitFor(() => expect(adoptAcknowledged).toHaveBeenCalledOnce());

        expect(JC.saveUserSettings).toHaveBeenCalledWith(
            'theme.json', expect.objectContaining({
                Profiles: [expect.objectContaining({ BasePreset: 'studio' })],
            }),
        );
        expect(panel.querySelector<HTMLFieldSetElement>('.jc-theme-workspace')?.disabled).toBe(false);
    });

    it('flushes the final expert edit synchronously when Apply is pressed', async () => {
        JC.saveUserSettings = vi.fn((_file, payload): Promise<UserSettingsSaveResult> => Promise.resolve(
            acknowledgedTheme(
                payload as UserThemeConfiguration,
                (payload as UserThemeConfiguration).Revision,
                'c'.repeat(64),
            ),
        ));
        wireThemeStudioEditor(context());
        button('preset', 'studio').click();
        button('editor-mode', 'expert').click();
        const editor = panel.querySelector<HTMLTextAreaElement>('[data-field="expert-json"]')!;
        const finalDraft = JSON.parse(editor.value) as UserThemeConfiguration;
        finalDraft.Profiles[0].BasePreset = 'glass';
        editor.value = JSON.stringify(finalDraft, null, 2);
        editor.setSelectionRange(12, 12);
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        button('apply').click();

        await vi.waitFor(() => expect(JC.saveUserSettings).toHaveBeenCalledOnce());
        expect(JC.saveUserSettings).toHaveBeenCalledWith(
            'theme.json', expect.objectContaining({
                Profiles: [expect.objectContaining({ BasePreset: 'glass' })],
            }),
        );
    });

    it('flushes pending Expert JSON before another draft mutation', () => {
        wireThemeStudioEditor(context());
        button('editor-mode', 'expert').click();
        const editor = panel.querySelector<HTMLTextAreaElement>('[data-field="expert-json"]')!;
        const pending = JSON.parse(editor.value) as UserThemeConfiguration;
        pending.Profiles[0].Palette = 'neutral';
        editor.value = JSON.stringify(pending, null, 2);
        editor.dispatchEvent(new Event('input', { bubbles: true }));

        button('add-profile').click();
        flushFrames();

        expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({
            Profiles: [
                expect.objectContaining({ Palette: 'neutral' }),
                expect.objectContaining({ Palette: 'neutral' }),
            ],
        }), { allowScheduling: false });
    });

    it('carries a staged profile name when Expert JSON switches the active profile', () => {
        const bedroom = structuredClone(configuration.Profiles[0]);
        bedroom.Id = 'bedroom';
        bedroom.Name = 'Bedroom';
        configuration.Profiles.push(bedroom);
        wireThemeStudioEditor(context());
        let name = panel.querySelector<HTMLInputElement>('[data-role="profile-name"]')!;
        name.value = 'Living room';
        name.dispatchEvent(new Event('input', { bubbles: true }));
        button('editor-mode', 'expert').click();
        let editor = panel.querySelector<HTMLTextAreaElement>('[data-field="expert-json"]')!;
        const switched = JSON.parse(editor.value) as UserThemeConfiguration;
        switched.ActiveProfileId = 'bedroom';
        editor.value = JSON.stringify(switched, null, 2);
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        vi.advanceTimersByTime(250);
        flushFrames();

        const switchedPreview = preview.mock.lastCall?.[0] as UserThemeConfiguration;
        expect(switchedPreview.ActiveProfileId).toBe('bedroom');
        expect(switchedPreview.Profiles).toEqual(expect.arrayContaining([
            expect.objectContaining({ Id: 'default', Name: 'Living room' }),
            expect.objectContaining({ Id: 'bedroom', Name: 'Bedroom' }),
        ]));
        expect(preview.mock.lastCall?.[1]).toEqual({ allowScheduling: false });
        editor = panel.querySelector<HTMLTextAreaElement>('[data-field="expert-json"]')!;
        expect((JSON.parse(editor.value) as UserThemeConfiguration).Profiles).toEqual(expect.arrayContaining([
            expect.objectContaining({ Id: 'default', Name: 'Living room' }),
        ]));

        button('editor-mode', 'beginner').click();
        name = panel.querySelector<HTMLInputElement>('[data-role="profile-name"]')!;
        expect(name.value).toBe('Bedroom');
        name.value = 'Projector';
        name.dispatchEvent(new Event('input', { bubbles: true }));
        button('rename-profile').click();
        flushFrames();
        const renamedPreview = preview.mock.lastCall?.[0] as UserThemeConfiguration;
        expect(renamedPreview.Profiles).toEqual(expect.arrayContaining([
            expect.objectContaining({ Id: 'default', Name: 'Living room' }),
            expect.objectContaining({ Id: 'bedroom', Name: 'Projector' }),
        ]));
        expect(preview.mock.lastCall?.[1]).toEqual({ allowScheduling: false });
    });

    it('keeps keyboard draft activity alive by resetting panel auto-close', () => {
        wireThemeStudioEditor(context());
        button('editor-mode', 'expert').click();
        resetAutoCloseTimer.mockClear();
        const editor = panel.querySelector<HTMLTextAreaElement>('[data-field="expert-json"]')!;
        editor.value = editor.value.replace('canopy-night', 'neutral');
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));

        expect(resetAutoCloseTimer).toHaveBeenCalledTimes(2);
    });

    it('suspends panel auto-close for staged and pending Expert drafts until Cancel', () => {
        wireThemeStudioEditor(context());
        setAutoCloseSuspended.mockClear();

        button('preset', 'glass').click();
        expect(setAutoCloseSuspended).toHaveBeenLastCalledWith(true);
        button('cancel').click();
        expect(setAutoCloseSuspended).toHaveBeenLastCalledWith(false);

        button('editor-mode', 'expert').click();
        setAutoCloseSuspended.mockClear();
        const editor = panel.querySelector<HTMLTextAreaElement>('[data-field="expert-json"]')!;
        editor.value = editor.value.replace('canopy-night', 'neutral');
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        expect(setAutoCloseSuspended).toHaveBeenCalledOnce();
        expect(setAutoCloseSuspended).toHaveBeenCalledWith(true);
    });

    it('validates portable imports on the server and includes schedule differences', async () => {
        const imported = themeConfiguration();
        imported.Profiles[0].Palette = 'neutral';
        imported.Schedule = [{
            Id: 'summer', ProfileId: 'default', StartMonthDay: '12-01', EndMonthDay: '02-28',
            Priority: 10, Enabled: true,
        }];
        const portable = {
            SchemaVersion: imported.SchemaVersion,
            ActiveProfileId: imported.ActiveProfileId,
            Profiles: imported.Profiles,
            Schedule: imported.Schedule,
        };
        const plugin = vi.fn().mockResolvedValue({ valid: true, data: portable });
        JC.core.api = { plugin } as unknown as ApiApi;
        wireThemeStudioEditor(context());
        const input = panel.querySelector<HTMLInputElement>('[data-field="import-file"]')!;
        const file = new File([JSON.stringify(portable)], 'portable-theme.json', { type: 'application/json' });
        Object.defineProperty(input, 'files', { configurable: true, value: [file] });
        input.dispatchEvent(new Event('change', { bubbles: true }));

        await vi.waitFor(() => expect(plugin).toHaveBeenCalledOnce());
        expect(plugin).toHaveBeenCalledWith(
            `/user-settings/${identity.userId}/theme.json/validate`,
            expect.objectContaining({ method: 'POST', body: portable, skipCache: true, skipRetry: true }),
        );
        await vi.waitFor(() => expect(panel.textContent).toContain('theme_studio_import_schedule_added'));
        expect(panel.textContent).toContain('summer');
        button('accept-import').click();
        flushFrames();
        expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({
            Revision: 3,
            LegacyMigration: { JellyfishTheme: '', Completed: false },
            Schedule: [expect.objectContaining({ Id: 'summer' })],
        }), { allowScheduling: false });
    });

    it.each(['preset', 'profile-name', 'expert-json'] as const)(
        'invalidates a reviewed import after a later %s draft edit',
        async (edit) => {
            const imported = themeConfiguration();
            imported.Profiles[0].Palette = 'neutral';
            const portable = {
                SchemaVersion: imported.SchemaVersion,
                ActiveProfileId: imported.ActiveProfileId,
                Profiles: imported.Profiles,
                Schedule: imported.Schedule,
            };
            JC.core.api = {
                plugin: vi.fn().mockResolvedValue({ valid: true, data: portable }),
            } as unknown as ApiApi;
            wireThemeStudioEditor(context());
            const input = panel.querySelector<HTMLInputElement>('[data-field="import-file"]')!;
            Object.defineProperty(input, 'files', {
                configurable: true,
                value: [new File([JSON.stringify(portable)], 'reviewed.json', { type: 'application/json' })],
            });
            input.dispatchEvent(new Event('change', { bubbles: true }));
            await vi.waitFor(() => expect(panel.querySelector('.jc-theme-import-diff')).not.toBeNull());

            if (edit === 'preset') {
                button('preset', 'studio').click();
            } else if (edit === 'profile-name') {
                const name = panel.querySelector<HTMLInputElement>('[data-role="profile-name"]')!;
                name.value = 'Edited after review';
                name.dispatchEvent(new Event('input', { bubbles: true }));
            } else {
                button('editor-mode', 'expert').click();
                const expert = panel.querySelector<HTMLTextAreaElement>('[data-field="expert-json"]')!;
                const draft = JSON.parse(expert.value) as UserThemeConfiguration;
                draft.Profiles[0].Accent = 'red';
                expert.value = JSON.stringify(draft, null, 2);
                expert.dispatchEvent(new Event('input', { bubbles: true }));
            }

            expect(panel.querySelector('.jc-theme-import-diff')).toBeNull();
            expect(panel.querySelector('[data-action="accept-import"]')).toBeNull();
            expect(panel.textContent).not.toContain('theme_studio_import_ready');
        },
    );

    it('does not publish an import review when the draft changes during validation', async () => {
        let resolveValidation: (value: unknown) => void = () => undefined;
        const plugin = vi.fn(() => new Promise<unknown>((resolve) => { resolveValidation = resolve; }));
        JC.core.api = { plugin } as unknown as ApiApi;
        const portable = {
            SchemaVersion: configuration.SchemaVersion,
            ActiveProfileId: configuration.ActiveProfileId,
            Profiles: configuration.Profiles,
            Schedule: configuration.Schedule,
        };
        wireThemeStudioEditor(context());
        const input = panel.querySelector<HTMLInputElement>('[data-field="import-file"]')!;
        Object.defineProperty(input, 'files', {
            configurable: true,
            value: [new File([JSON.stringify(portable)], 'pending-draft.json', { type: 'application/json' })],
        });
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledOnce());

        button('preset', 'studio').click();
        resolveValidation({ valid: true, data: portable });
        await vi.advanceTimersByTimeAsync(1);

        expect(panel.querySelector('.jc-theme-import-diff')).toBeNull();
        expect(panel.querySelector('[data-action="accept-import"]')).toBeNull();
        expect(button('preset', 'studio').getAttribute('aria-pressed')).toBe('true');
    });

    it.each(['replacement', 'cancel', 'teardown'] as const)(
        'aborts pending import validation on %s',
        async (retirement) => {
            const signals: AbortSignal[] = [];
            const plugin = vi.fn((_path: string, options?: { signal?: AbortSignal }) =>
                new Promise<unknown>((_resolve, reject) => {
                    const signal = options?.signal;
                    if (!signal) return;
                    signals.push(signal);
                    signal.addEventListener('abort', () => {
                        reject(new DOMException('Import validation retired', 'AbortError'));
                    }, { once: true });
                }));
            JC.core.api = { plugin } as unknown as ApiApi;
            const portable = {
                SchemaVersion: configuration.SchemaVersion,
                ActiveProfileId: configuration.ActiveProfileId,
                Profiles: configuration.Profiles,
                Schedule: configuration.Schedule,
            };
            wireThemeStudioEditor(context());
            const chooseFile = (name: string): void => {
                const input = panel.querySelector<HTMLInputElement>('[data-field="import-file"]')!;
                Object.defineProperty(input, 'files', {
                    configurable: true,
                    value: [new File([JSON.stringify(portable)], name, { type: 'application/json' })],
                });
                input.dispatchEvent(new Event('change', { bubbles: true }));
            };

            chooseFile('first.json');
            await vi.waitFor(() => expect(signals).toHaveLength(1));
            if (retirement === 'replacement') {
                chooseFile('second.json');
                await vi.waitFor(() => expect(signals).toHaveLength(2));
            } else if (retirement === 'cancel') {
                button('cancel').click();
            } else {
                cleanups[0]();
            }

            expect(signals[0].aborted).toBe(true);
            if (retirement === 'replacement') expect(signals[1].aborted).toBe(false);
        },
    );

    it('returns to the current draft status after accepting a no-op import', async () => {
        const portable = {
            SchemaVersion: configuration.SchemaVersion,
            ActiveProfileId: configuration.ActiveProfileId,
            Profiles: configuration.Profiles,
            Schedule: configuration.Schedule,
        };
        JC.core.api = {
            plugin: vi.fn().mockResolvedValue({ valid: true, data: portable }),
        } as unknown as ApiApi;
        wireThemeStudioEditor(context());
        const input = panel.querySelector<HTMLInputElement>('[data-field="import-file"]')!;
        Object.defineProperty(input, 'files', {
            configurable: true,
            value: [new File([JSON.stringify(portable)], 'same.json', { type: 'application/json' })],
        });
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await vi.waitFor(() => expect(panel.textContent).toContain('theme_studio_import_no_changes'));

        button('accept-import').click();

        expect(panel.querySelector('.jc-theme-import-diff')).toBeNull();
        expect(panel.textContent).toContain('theme_studio_ready');
        expect(panel.textContent).not.toContain('theme_studio_import_ready');
        expect(button('apply').disabled).toBe(true);
    });

    it('retains dormant schedules while importing profiles when scheduling is disabled', async () => {
        JC.pluginConfig.ThemeStudioAllowSeasonalScheduling = false;
        configuration.Schedule = [{
            Id: 'winter', ProfileId: 'default', StartMonthDay: '12-01', EndMonthDay: '02-28',
            Priority: 10, Enabled: true,
        }];
        const imported = themeConfiguration();
        imported.Profiles[0].Palette = 'neutral';
        imported.Schedule = structuredClone(configuration.Schedule);
        const portable = {
            SchemaVersion: imported.SchemaVersion,
            ActiveProfileId: imported.ActiveProfileId,
            Profiles: imported.Profiles,
            Schedule: imported.Schedule,
        };
        const plugin = vi.fn((_path: string, options: { body?: unknown }) => Promise.resolve({
            valid: true,
            data: options.body,
        }));
        JC.core.api = { plugin } as unknown as ApiApi;
        wireThemeStudioEditor(context());
        const input = panel.querySelector<HTMLInputElement>('[data-field="import-file"]')!;
        Object.defineProperty(input, 'files', {
            configurable: true,
            value: [new File([JSON.stringify(portable)], 'profiles.json', { type: 'application/json' })],
        });
        input.dispatchEvent(new Event('change', { bubbles: true }));

        await vi.waitFor(() => expect(panel.textContent).toContain('theme_studio_import_ready'));
        expect(plugin).toHaveBeenCalledWith(
            `/user-settings/${identity.userId}/theme.json/validate`,
            expect.objectContaining({ body: { ...portable, Schedule: [] } }),
        );
        expect(panel.textContent).not.toContain('theme_studio_import_schedule_removed');
        // Acceptance must use the policy captured for this validation, even
        // if the live config object changes before its event is delivered.
        JC.pluginConfig.ThemeStudioAllowSeasonalScheduling = true;
        button('accept-import').click();
        flushFrames();

        expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({
            Profiles: [expect.objectContaining({ Palette: 'neutral' })],
            Schedule: [expect.objectContaining({ Id: 'winter', ProfileId: 'default' })],
        }), { allowScheduling: false });
        expect(button('apply').disabled).toBe(false);
    });

    it.each(['validation', 'review'] as const)(
        'invalidates an import during %s when scheduling policy changes live',
        async (phase) => {
            JC.pluginConfig.ThemeStudioAllowSeasonalScheduling = false;
            let resolveValidation: (value: unknown) => void = () => undefined;
            const plugin = vi.fn(() => new Promise<unknown>((resolve) => { resolveValidation = resolve; }));
            JC.core.api = { plugin } as unknown as ApiApi;
            const portable = {
                SchemaVersion: configuration.SchemaVersion,
                ActiveProfileId: configuration.ActiveProfileId,
                Profiles: configuration.Profiles,
                Schedule: configuration.Schedule,
            };
            wireThemeStudioEditor(context());
            const input = panel.querySelector<HTMLInputElement>('[data-field="import-file"]')!;
            Object.defineProperty(input, 'files', {
                configurable: true,
                value: [new File([JSON.stringify(portable)], 'pending-policy.json', { type: 'application/json' })],
            });
            input.dispatchEvent(new Event('change', { bubbles: true }));
            await vi.waitFor(() => expect(plugin).toHaveBeenCalledOnce());
            if (phase === 'review') {
                resolveValidation({ valid: true, data: { ...portable, Schedule: [] } });
                await vi.waitFor(() => expect(panel.textContent).toContain('theme_studio_import_ready'));
            }

            JC.pluginConfig.ThemeStudioAllowSeasonalScheduling = true;
            window.dispatchEvent(new CustomEvent('jc:config-changed'));
            if (phase === 'validation') {
                resolveValidation({ valid: true, data: { ...portable, Schedule: [] } });
                await vi.advanceTimersByTimeAsync(1);
            }

            expect(panel.textContent).not.toContain('theme_studio_import_ready');
            expect(panel.querySelector('[data-action="accept-import"]')).toBeNull();
            expect(button('apply').disabled).toBe(true);
        },
    );

    it.each(['cancel', 'reload'] as const)(
        'does not resurrect pending import validation after %s discards the draft',
        async (discardAction) => {
            let resolveValidation: (value: unknown) => void = () => undefined;
            const plugin = vi.fn(() => new Promise<unknown>((resolve) => { resolveValidation = resolve; }));
            JC.core.api = { plugin } as unknown as ApiApi;
            if (discardAction === 'reload') {
                JC.saveUserSettings = vi.fn().mockRejectedValue(
                    Object.assign(new Error('conflict'), { kind: 'conflict' }),
                );
            }
            wireThemeStudioEditor(context());
            if (discardAction === 'reload') {
                button('preset', 'cinematic').click();
                button('apply').click();
                await vi.waitFor(() => expect(panel.textContent).toContain('theme_studio_error_conflict'));
            }

            const portable = {
                SchemaVersion: configuration.SchemaVersion,
                ActiveProfileId: configuration.ActiveProfileId,
                Profiles: configuration.Profiles,
                Schedule: configuration.Schedule,
            };
            const input = panel.querySelector<HTMLInputElement>('[data-field="import-file"]')!;
            Object.defineProperty(input, 'files', {
                configurable: true,
                value: [new File([JSON.stringify(portable)], 'pending-theme.json', { type: 'application/json' })],
            });
            input.dispatchEvent(new Event('change', { bubbles: true }));
            await vi.waitFor(() => expect(plugin).toHaveBeenCalledOnce());

            button(discardAction).click();
            if (discardAction === 'reload') {
                await vi.waitFor(() => expect(panel.textContent).toContain('theme_studio_reloaded'));
            } else {
                expect(panel.textContent).toContain('theme_studio_cancelled');
            }
            resolveValidation({ valid: true, data: portable });
            await vi.advanceTimersByTimeAsync(1);

            expect(panel.textContent).toContain(
                discardAction === 'reload' ? 'theme_studio_reloaded' : 'theme_studio_cancelled',
            );
            expect(panel.textContent).not.toContain('theme_studio_import_ready');
            expect(panel.querySelector('[data-action="accept-import"]')).toBeNull();
        },
    );

    it('exports the portable document without revision or migration internals', async () => {
        let exported: Blob | null = null;
        vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
            if (!(blob instanceof Blob)) throw new TypeError('Theme export must be a Blob');
            exported = blob;
            return 'blob:theme-export';
        });
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
        wireThemeStudioEditor(context());
        button('export').click();

        expect(exported).not.toBeNull();
        const parsed: unknown = JSON.parse(await exported!.text());
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new TypeError('Theme export must be an object');
        }
        const documentValue = parsed as Record<string, unknown>;
        expect(documentValue.SchemaVersion).toBe(2);
        expect(documentValue.ActiveProfileId).toBe('default');
        expect(Array.isArray(documentValue.Profiles)).toBe(true);
        expect(Array.isArray(documentValue.Schedule)).toBe(true);
        expect(documentValue).not.toHaveProperty('Revision');
        expect(documentValue).not.toHaveProperty('LegacyMigration');
    });

    it('hides disabled imports and rejects oversized files before reading them', () => {
        JC.pluginConfig.ThemeStudioAllowProfileImport = false;
        wireThemeStudioEditor(context());
        expect(panel.querySelector('[data-field="import-file"]')).toBeNull();
        expect(panel.querySelector('[data-action="import"]')).toBeNull();

        for (const cleanup of cleanups.reverse()) cleanup();
        cleanups = [];
        JC.pluginConfig.ThemeStudioAllowProfileImport = true;
        wireThemeStudioEditor(context());
        const input = panel.querySelector<HTMLInputElement>('[data-field="import-file"]')!;
        const openPicker = vi.spyOn(input, 'click');
        const importButton = button('import');
        expect(importButton.tabIndex).toBe(0);
        importButton.click();
        expect(openPicker).toHaveBeenCalledOnce();
        const text = vi.fn().mockResolvedValue('{}');
        Object.defineProperty(input, 'files', {
            configurable: true,
            value: [{ size: 1024 * 1024 + 1, text }],
        });
        input.dispatchEvent(new Event('change', { bubbles: true }));
        expect(text).not.toHaveBeenCalled();
        expect(panel.textContent).toContain('theme_studio_import_invalid');
    });

    it('hydrates after a runtime is installed after the editor opens', async () => {
        const readyRuntime = JC.core.themeStudio!;
        delete JC.core.themeStudio;
        wireThemeStudioEditor(context());
        expect(panel.textContent).toContain('theme_studio_unavailable');

        JC.core.themeStudio = readyRuntime;
        window.dispatchEvent(new CustomEvent('jc:theme-studio-runtime-changed', {
            detail: { reason: 'installed' },
        }));
        await vi.waitFor(() => expect(panel.querySelectorAll('.jc-theme-preset')).toHaveLength(9));
        expect(panel.textContent).toContain('theme_studio_ready');
    });

    it('reconciles provisional state after an in-flight authoritative load settles', async () => {
        let resolveReady!: (ready: boolean) => void;
        const ready = new Promise<boolean>((resolve) => { resolveReady = resolve; });
        const authoritative = themeConfiguration();
        authoritative.Revision = configuration.Revision + 1;
        authoritative.Profiles[0].BasePreset = 'studio';
        const runtime = JC.core.themeStudio!;
        JC.core.themeStudio = {
            ...runtime,
            getConfiguration: () => JC.identity.own(structuredClone(configuration), identity),
            whenReady: vi.fn(() => ready),
            hasPendingAuthoritativeLoad: () => true,
            getDiagnostics: () => ({
                status: 'active', revision: configuration.Revision,
                profileId: configuration.ActiveProfileId, breakpoint: 'desktop', mode: 'dark',
            }),
        } satisfies ThemeStudioRuntimeApi;

        wireThemeStudioEditor(context());
        expect(button('preset', 'canopy').getAttribute('aria-pressed')).toBe('true');
        configuration = JC.identity.own(authoritative, identity);
        resolveReady(true);

        await vi.waitFor(() => {
            expect(button('preset', 'studio').getAttribute('aria-pressed')).toBe('true');
        });
        expect(button('apply').disabled).toBe(true);
        expect(panel.textContent).toContain('theme_studio_ready');
    });

    it('adopts a late acknowledgement that lands after this clean editor opens', async () => {
        wireThemeStudioEditor(context());
        expect(button('preset', 'canopy').getAttribute('aria-pressed')).toBe('true');

        const acknowledged = themeConfiguration();
        acknowledged.Revision = 8;
        acknowledged.Profiles[0].BasePreset = 'studio';
        configuration = JC.identity.own(acknowledged, identity);
        window.dispatchEvent(new CustomEvent('jc:theme-studio-runtime-changed', {
            detail: { reason: 'acknowledged' },
        }));

        await vi.waitFor(() => {
            expect(button('preset', 'studio').getAttribute('aria-pressed')).toBe('true');
        });
        expect(button('apply').disabled).toBe(true);
        expect(panel.textContent).toContain('theme_studio_ready');
    });

    it('preserves and re-previews a draft when a replacement runtime has the same baseline', async () => {
        wireThemeStudioEditor(context());
        button('preset', 'cinematic').click();
        flushFrames();
        const previousRuntime = JC.core.themeStudio!;
        const replacementPreview = vi.fn(() => true);
        JC.core.themeStudio = {
            ...previousRuntime,
            preview: replacementPreview,
            getConfiguration: () => JC.identity.own(structuredClone(configuration), identity),
            whenReady: vi.fn().mockResolvedValue(true),
        } satisfies ThemeStudioRuntimeApi;

        window.dispatchEvent(new CustomEvent('jc:theme-studio-runtime-changed', {
            detail: { reason: 'installed' },
        }));

        await vi.waitFor(() => expect(button('preset', 'cinematic').getAttribute('aria-pressed')).toBe('true'));
        expect(button('apply').disabled).toBe(false);
        expect(panel.textContent).toContain('theme_studio_unsaved');
        expect(panel.textContent).not.toContain('theme_studio_error_conflict');
        flushFrames();
        expect(replacementPreview).toHaveBeenCalledWith(expect.objectContaining({
            Profiles: [expect.objectContaining({ BasePreset: 'cinematic' })],
        }), { allowScheduling: false });
    });

    it('flushes pending Expert JSON before replacement-runtime hydration', async () => {
        wireThemeStudioEditor(context());
        button('editor-mode', 'expert').click();
        const editor = panel.querySelector<HTMLTextAreaElement>('[data-field="expert-json"]')!;
        const pending = JSON.parse(editor.value) as UserThemeConfiguration;
        pending.Profiles[0].Palette = 'neutral';
        editor.value = JSON.stringify(pending, null, 2);
        editor.dispatchEvent(new Event('input', { bubbles: true }));

        const previousRuntime = JC.core.themeStudio!;
        const replacementPreview = vi.fn(() => true);
        JC.core.themeStudio = {
            ...previousRuntime,
            preview: replacementPreview,
            getConfiguration: () => JC.identity.own(structuredClone(configuration), identity),
            whenReady: vi.fn().mockResolvedValue(true),
        } satisfies ThemeStudioRuntimeApi;
        window.dispatchEvent(new CustomEvent('jc:theme-studio-runtime-changed', {
            detail: { reason: 'installed' },
        }));

        await vi.waitFor(() => expect(button('apply').disabled).toBe(false));
        const hydrated = JSON.parse(
            panel.querySelector<HTMLTextAreaElement>('[data-field="expert-json"]')!.value,
        ) as UserThemeConfiguration;
        expect(hydrated.Profiles[0].Palette).toBe('neutral');
        expect(panel.textContent).toContain('theme_studio_unsaved');
        flushFrames();
        expect(replacementPreview).toHaveBeenCalledWith(expect.objectContaining({
            Profiles: [expect.objectContaining({ Palette: 'neutral' })],
        }), { allowScheduling: false });
    });

    it('tracks the visual viewport so the mobile action bar stays above keyboards', () => {
        const viewport = Object.assign(new EventTarget(), { height: 412, offsetTop: 177 });
        vi.stubGlobal('visualViewport', viewport);
        wireThemeStudioEditor(context());
        expect(panel.style.getPropertyValue('--jc-panel-visual-height')).toBe('412px');
        expect(panel.style.getPropertyValue('--jc-panel-visual-top')).toBe('177px');

        viewport.height = 360;
        viewport.offsetTop = 201;
        viewport.dispatchEvent(new Event('resize'));
        expect(panel.style.getPropertyValue('--jc-panel-visual-height')).toBe('360px');
        expect(panel.style.getPropertyValue('--jc-panel-visual-top')).toBe('201px');
        cleanups[0]();
        expect(panel.style.getPropertyValue('--jc-panel-visual-height')).toBe('');
    });

    it('preserves a conflicting draft and reloads only after an explicit recovery action', async () => {
        JC.saveUserSettings = vi.fn().mockRejectedValue(Object.assign(new Error('conflict'), { kind: 'conflict' }));
        wireThemeStudioEditor(context());
        button('preset', 'cinematic').click();
        button('apply').click();
        await vi.waitFor(() => expect(JC.saveUserSettings).toHaveBeenCalledOnce());
        expect(button('apply').disabled).toBe(true);
        expect(panel.textContent).toContain('theme_studio_error_conflict');
        expect(reload).not.toHaveBeenCalled();

        button('preset', 'oled').click();
        expect(button('preset', 'oled').getAttribute('aria-pressed')).toBe('true');
        expect(button('apply').disabled).toBe(true);
        expect(panel.textContent).toContain('theme_studio_error_conflict');
        expect(panel.textContent).not.toContain('theme_studio_unsaved');

        // Conflict recovery is deliberately explicit; the user can export the
        // preserved draft before accepting authoritative server state.
        button('reload').click();
        await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    });

    it('freezes draft mutations while an authoritative Reload is in flight', async () => {
        let resolveReload: (loaded: boolean) => void = () => undefined;
        reload.mockImplementation(() => new Promise<boolean>((resolve) => { resolveReload = resolve; }));
        JC.saveUserSettings = vi.fn().mockRejectedValue(Object.assign(new Error('conflict'), { kind: 'conflict' }));
        wireThemeStudioEditor(context());
        button('preset', 'cinematic').click();
        button('apply').click();
        await vi.waitFor(() => expect(panel.textContent).toContain('theme_studio_error_conflict'));

        button('reload').click();
        expect(panel.querySelector<HTMLFieldSetElement>('.jc-theme-workspace')?.disabled).toBe(true);
        button('preset', 'oled').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        resolveReload(true);
        await vi.waitFor(() => expect(panel.textContent).toContain('theme_studio_reloaded'));

        expect(button('preset', 'canopy').getAttribute('aria-pressed')).toBe('true');
        expect(button('apply').disabled).toBe(true);
    });

    it('cancels a queued draft preview before an explicit Reload yields', async () => {
        let resolveReload: (loaded: boolean) => void = () => undefined;
        reload.mockImplementation(() => new Promise<boolean>((resolve) => { resolveReload = resolve; }));
        JC.saveUserSettings = vi.fn().mockRejectedValue(Object.assign(new Error('conflict'), { kind: 'conflict' }));
        wireThemeStudioEditor(context());
        button('preset', 'cinematic').click();
        expect(frames.size).toBeGreaterThan(0);
        button('apply').click();
        await vi.waitFor(() => expect(panel.textContent).toContain('theme_studio_error_conflict'));

        button('reload').click();
        flushFrames();

        expect(preview).not.toHaveBeenCalled();
        resolveReload(true);
        await vi.waitFor(() => expect(panel.textContent).toContain('theme_studio_reloaded'));
        flushFrames();
        expect(preview).not.toHaveBeenCalled();
        expect(button('apply').disabled).toBe(true);
    });

    it('cancels pending Expert draft work before an explicit Reload yields', async () => {
        let resolveReload: (loaded: boolean) => void = () => undefined;
        reload.mockImplementation(() => new Promise<boolean>((resolve) => { resolveReload = resolve; }));
        JC.saveUserSettings = vi.fn().mockRejectedValue(Object.assign(new Error('conflict'), { kind: 'conflict' }));
        wireThemeStudioEditor(context());
        button('preset', 'cinematic').click();
        button('apply').click();
        await vi.waitFor(() => expect(panel.textContent).toContain('theme_studio_error_conflict'));
        flushFrames();
        preview.mockClear();
        button('editor-mode', 'expert').click();
        const editor = panel.querySelector<HTMLTextAreaElement>('[data-field="expert-json"]')!;
        editor.value = editor.value.replace('canopy-night', 'neutral');
        editor.dispatchEvent(new Event('input', { bubbles: true }));

        button('reload').click();
        vi.advanceTimersByTime(250);

        expect(preview).not.toHaveBeenCalled();
        resolveReload(true);
        await vi.waitFor(() => expect(panel.textContent).toContain('theme_studio_reloaded'));
        flushFrames();
        expect(preview).not.toHaveBeenCalled();
        expect(button('apply').disabled).toBe(true);
    });

    it('adopts an acknowledged Apply even if the panel closes while saving', async () => {
        let resolveSave: (result: UserSettingsSaveResult) => void = () => undefined;
        JC.saveUserSettings = vi.fn(() => new Promise<UserSettingsSaveResult>((resolve) => {
            resolveSave = resolve;
        }));
        wireThemeStudioEditor(context());
        button('preset', 'studio').click();
        button('apply').click();
        cleanups[0]();
        const authoritative = themeConfiguration();
        authoritative.Profiles[0].BasePreset = 'studio';
        resolveSave(acknowledgedTheme(authoritative, 3, 'd'.repeat(64)));

        await vi.waitFor(() => expect(adoptAcknowledged).toHaveBeenCalledOnce());
    });

    it('never previews or enables Apply for invalid expert JSON', () => {
        wireThemeStudioEditor(context());
        button('editor-mode', 'expert').click();
        const editor = panel.querySelector<HTMLTextAreaElement>('[data-field="expert-json"]')!;
        editor.value = '{ invalid';
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        vi.advanceTimersByTime(250);

        expect(panel.querySelector('[data-field="expert-json"]')?.getAttribute('aria-invalid')).toBe('true');
        expect(preview).not.toHaveBeenCalled();
        expect(button('apply').disabled).toBe(true);
        expect(panel.textContent).toContain('theme_studio_invalid');
    });

    it('clears an Expert validation error after a valid no-op correction', () => {
        wireThemeStudioEditor(context());
        button('editor-mode', 'expert').click();
        let editor = panel.querySelector<HTMLTextAreaElement>('[data-field="expert-json"]')!;
        const original = editor.value;
        editor.value = '{ invalid';
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        vi.advanceTimersByTime(250);
        expect(panel.textContent).toContain('theme_studio_invalid');

        editor = panel.querySelector<HTMLTextAreaElement>('[data-field="expert-json"]')!;
        editor.value = original;
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        vi.advanceTimersByTime(250);

        expect(panel.querySelector('[data-field="expert-json"]')?.getAttribute('aria-invalid')).toBe('false');
        expect(panel.textContent).toContain('theme_studio_ready');
        expect(panel.textContent).not.toContain('theme_studio_invalid');
        expect(button('apply').disabled).toBe(true);
    });

    it('accepts formatting-only Expert JSON without reporting a clean draft as unsaved', () => {
        wireThemeStudioEditor(context());
        button('editor-mode', 'expert').click();
        const editor = panel.querySelector<HTMLTextAreaElement>('[data-field="expert-json"]')!;
        editor.value = JSON.stringify(configuration);
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        expect(panel.textContent).toContain('theme_studio_unsaved');

        vi.advanceTimersByTime(250);

        expect(panel.textContent).toContain('theme_studio_ready');
        expect(panel.textContent).not.toContain('theme_studio_unsaved');
        expect(button('apply').disabled).toBe(true);
        expect(preview).not.toHaveBeenCalled();
    });

    it('preserves a buffered profile-name draft across a formatting-only Expert edit', () => {
        wireThemeStudioEditor(context());
        const name = panel.querySelector<HTMLInputElement>('[data-role="profile-name"]')!;
        name.value = 'Buffered name';
        name.dispatchEvent(new Event('input', { bubbles: true }));
        button('editor-mode', 'expert').click();
        const editor = panel.querySelector<HTMLTextAreaElement>('[data-field="expert-json"]')!;
        editor.value = JSON.stringify(configuration);
        editor.dispatchEvent(new Event('input', { bubbles: true }));

        vi.advanceTimersByTime(250);

        expect(panel.textContent).toContain('theme_studio_unsaved');
        expect(panel.textContent).not.toContain('theme_studio_ready');
        expect(button('apply').disabled).toBe(false);
        expect(preview).not.toHaveBeenCalled();
    });
});
