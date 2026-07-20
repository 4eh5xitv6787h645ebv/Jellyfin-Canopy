import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import { themeConfiguration } from '../../test/theme-studio-fixture';
import type { ApiApi, IdentityContext, ThemeStudioRuntimeApi, UserThemeConfiguration } from '../../types/jc';
import type { UserSettingsSaveResult } from '../config';
import type { PanelContext } from './panel';
import { wireThemeStudioEditor } from './theme-editor';

let identity: IdentityContext;
let panel: HTMLElement;
let cleanups: Array<() => void>;
let preview: ReturnType<typeof vi.fn<(value: unknown) => boolean>>;
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
    document.documentElement.classList.remove('layout-tv');
    document.body.classList.remove('layout-tv');
    JC.identity.transition('', '', 'theme-editor-test-logout');
    identity = JC.identity.transition('server-a', 'user-a', 'theme-editor-test-login')!;
    JC.pluginConfig = { ...JC.pluginConfig, ThemeStudioAllowProfileImport: true };
    configuration = JC.identity.own(themeConfiguration(), identity);
    preview = vi.fn(() => true);
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
        }));
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
    });

    it('keeps page preview reachable on phones and removes it on Cancel and teardown', () => {
        wireThemeStudioEditor(context());
        button('preset', 'glass').click();
        flushFrames();
        button('preview-only').click();
        expect(panel.classList.contains('jc-theme-preview-only')).toBe(true);
        expect(document.getElementById('jellyfin-canopy-panel-backdrop')?.classList
            .contains('jc-theme-preview-backdrop-hidden')).toBe(true);
        button('return-editor').click();
        expect(panel.classList.contains('jc-theme-preview-only')).toBe(false);
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

    it('adopts the exact acknowledgement when a joined saver leaves this target untouched', async () => {
        JC.saveUserSettings = vi.fn((): Promise<UserSettingsSaveResult> => Promise.resolve({
            acknowledged: true, deduplicated: false, file: 'theme.json', revision: 4,
            contentHash: 'a'.repeat(64),
        }));
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
        expect(adoptAcknowledged).toHaveBeenCalledWith(expect.objectContaining({ Revision: 4 }));
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
        resolveSave({
            acknowledged: true, deduplicated: false, file: 'theme.json', revision: 3,
            contentHash: 'b'.repeat(64),
        });
        await vi.waitFor(() => expect(adoptAcknowledged).toHaveBeenCalledOnce());

        expect(JC.saveUserSettings).toHaveBeenCalledWith(
            'theme.json', expect.objectContaining({
                Profiles: [expect.objectContaining({ BasePreset: 'studio' })],
            }),
        );
        expect(panel.querySelector<HTMLFieldSetElement>('.jc-theme-workspace')?.disabled).toBe(false);
    });

    it('flushes the final expert edit synchronously when Apply is pressed', async () => {
        JC.saveUserSettings = vi.fn((_file, payload): Promise<UserSettingsSaveResult> => Promise.resolve({
            acknowledged: true, deduplicated: false, file: 'theme.json',
            revision: (payload as UserThemeConfiguration).Revision,
            contentHash: 'c'.repeat(64),
        }));
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
        }));
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
        }));
    });

    it('retains dormant schedules while importing profiles when scheduling is disabled', async () => {
        JC.pluginConfig.ThemeStudioAllowSeasonalScheduling = false;
        configuration.Schedule = [{
            Id: 'winter', ProfileId: 'default', StartMonthDay: '12-01', EndMonthDay: '02-28',
            Priority: 10, Enabled: true,
        }];
        const imported = themeConfiguration();
        imported.Profiles[0].Palette = 'neutral';
        imported.Schedule = [];
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
            value: [new File([JSON.stringify(portable)], 'profiles.json', { type: 'application/json' })],
        });
        input.dispatchEvent(new Event('change', { bubbles: true }));

        await vi.waitFor(() => expect(panel.textContent).toContain('theme_studio_import_ready'));
        expect(panel.textContent).not.toContain('theme_studio_import_schedule_removed');
        button('accept-import').click();
        flushFrames();

        expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({
            Profiles: [expect.objectContaining({ Palette: 'neutral' })],
            Schedule: [expect.objectContaining({ Id: 'winter', ProfileId: 'default' })],
        }));
        expect(button('apply').disabled).toBe(false);
    });

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
        }));
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
        }));
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

    it('adopts an acknowledged Apply even if the panel closes while saving', async () => {
        let resolveSave: (result: UserSettingsSaveResult) => void = () => undefined;
        JC.saveUserSettings = vi.fn(() => new Promise<UserSettingsSaveResult>((resolve) => {
            resolveSave = resolve;
        }));
        wireThemeStudioEditor(context());
        button('preset', 'studio').click();
        button('apply').click();
        cleanups[0]();
        resolveSave({
            acknowledged: true, deduplicated: false, file: 'theme.json', revision: 3,
            contentHash: 'd'.repeat(64),
        });

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
});
