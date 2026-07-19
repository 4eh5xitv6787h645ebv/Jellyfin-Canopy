import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import { themeConfiguration } from '../../test/theme-studio-fixture';
import type { IdentityContext, ThemeStudioRuntimeApi, UserThemeConfiguration } from '../../types/jc';
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
let configuration: UserThemeConfiguration;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
const originalThemeStudio = JC.core.themeStudio;
const originalSave = JC.saveUserSettings;
const originalT = JC.t;

function context(): PanelContext {
    return {
        help: panel,
        identityContext: identity,
        registerCleanup(cleanup) { cleanups.push(cleanup); },
        trackTimer: () => undefined,
        pluginShortcuts: [],
        resetAutoCloseTimer: () => undefined,
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
    JC.identity.transition('', '', 'theme-editor-test-logout');
    identity = JC.identity.transition('server-a', 'user-a', 'theme-editor-test-login')!;
    configuration = JC.identity.own(themeConfiguration(), identity);
    preview = vi.fn(() => true);
    cancelPreview = vi.fn<() => void>();
    adoptAcknowledged = vi.fn(() => true);
    reload = vi.fn().mockResolvedValue(true);
    JC.core.themeStudio = {
        preview,
        cancelPreview,
        getConfiguration: () => JC.identity.own(structuredClone(configuration), identity),
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
        expect(button('apply').disabled).toBe(true);
        const search = panel.querySelector<HTMLInputElement>('[data-field="preset-search"]')!;
        search.focus();
        search.value = 'oled';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        expect(document.activeElement).toBe(search);
        expect(panel.querySelectorAll('.jc-theme-preset:not([hidden])')).toHaveLength(1);
        search.value = '';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        expect(panel.querySelectorAll('.jc-theme-preset:not([hidden])')).toHaveLength(9);

        button('preset', 'oled').click();
        const palette = panel.querySelector<HTMLSelectElement>('[data-field="palette"]')!;
        palette.value = 'neutral';
        palette.dispatchEvent(new Event('change', { bubbles: true }));

        expect(preview).not.toHaveBeenCalled();
        expect(frames).toHaveLength(1);
        flushFrames();
        expect(preview).toHaveBeenCalledOnce();
        expect(preview).toHaveBeenCalledWith(expect.objectContaining({
            Profiles: [expect.objectContaining({ BasePreset: 'oled', Palette: 'neutral' })],
        }));
        expect(button('apply').disabled).toBe(false);
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

    it('writes only on Apply and adopts the exact acknowledged revision', async () => {
        JC.saveUserSettings = vi.fn((_file, payload): Promise<UserSettingsSaveResult> => {
            (payload as UserThemeConfiguration).Revision = 4;
            return Promise.resolve({
                acknowledged: true, deduplicated: false, file: 'theme.json', revision: 4,
                contentHash: 'a'.repeat(64),
            });
        });
        wireThemeStudioEditor(context());
        button('preset', 'studio').click();
        flushFrames();
        expect(JC.saveUserSettings).not.toHaveBeenCalled();

        button('apply').click();
        await vi.waitFor(() => expect(adoptAcknowledged).toHaveBeenCalledOnce());
        expect(JC.saveUserSettings).toHaveBeenCalledOnce();
        expect(JC.saveUserSettings).toHaveBeenCalledWith(
            'theme.json', expect.objectContaining({ Revision: 4, Profiles: [expect.objectContaining({ BasePreset: 'studio' })] }),
        );
        expect(adoptAcknowledged).toHaveBeenCalledWith(expect.objectContaining({ Revision: 4 }));
        expect(button('apply').disabled).toBe(true);
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

    it('never previews or enables Apply for invalid expert JSON', () => {
        wireThemeStudioEditor(context());
        button('editor-mode', 'expert').click();
        const editor = panel.querySelector<HTMLTextAreaElement>('[data-field="expert-json"]')!;
        editor.value = '{ invalid';
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        vi.advanceTimersByTime(250);

        expect(editor.getAttribute('aria-invalid')).toBe('true');
        expect(preview).not.toHaveBeenCalled();
        expect(button('apply').disabled).toBe(true);
        expect(panel.textContent).toContain('theme_studio_invalid');
    });
});
