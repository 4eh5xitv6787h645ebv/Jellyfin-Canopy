/* eslint-disable @typescript-eslint/require-await -- async API fakes mirror the production contract */
/* eslint-disable @typescript-eslint/unbound-method -- tests preserve host methods and assert Vitest mocks */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JC } from '../../globals';
import type { ApiApi } from '../../types/jc';

const ACTOR = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TARGET = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const originalApi = JC.core.api;
const originalGetCurrentUser = ApiClient.getCurrentUser;
const originalGetCurrentUserId = ApiClient.getCurrentUserId;
const originalServerId = ApiClient.serverId;
const originalTransform = JC.transformUserFileCase;
let resetPanel: (() => void) | null = null;
let showPanel: ((launch?: unknown) => Promise<void>) | null = null;

function convert(value: unknown, pascal: boolean): unknown {
    if (Array.isArray(value)) return value.map(item => convert(item, pascal));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        pascal ? key.charAt(0).toUpperCase() + key.slice(1) : key.charAt(0).toLowerCase() + key.slice(1),
        convert(child, pascal),
    ]));
}

function response(file: string, revision: number, data: Record<string, unknown>) {
    return {
        Success: true,
        File: file,
        Revision: revision,
        ContentHash: (file === 'settings.json' ? 'a' : 'b').repeat(64),
        Data: { ...data, Revision: revision },
        TargetUserId: TARGET,
        TargetDisplayName: 'Target User',
    };
}

describe('admin target panel integration', () => {
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];

    beforeEach(async () => {
        document.body.innerHTML = '<button id="before">before</button>';
        posts.length = 0;
        JC.identity.transition('server-a', ACTOR, 'target-panel-integration');
        const actor = JC.identity.capture()!;
        ApiClient.getCurrentUserId = () => ACTOR;
        ApiClient.serverId = () => 'server-a';
        ApiClient.getCurrentUser = () => Promise.resolve({
            Id: ACTOR,
            Policy: { IsAdministrator: true },
        });
        JC.transformUserFileCase = (_file, value, direction) =>
            convert(value, direction === 'save');
        JC.currentSettings = JC.identity.own({
            actorOnly: 'unchanged',
            autoPauseEnabled: false,
            lastOpenedTab: 'about',
        }, actor);
        JC.userConfig = JC.identity.own({
            settings: JC.identity.own({ ActorOnly: 'unchanged', Revision: 9 }, actor),
            shortcuts: JC.identity.own({ Shortcuts: [{ Name: 'play', Key: 'A' }], Revision: 4 }, actor),
        }, actor);
        JC.state = {
            activeShortcuts: { play: 'A' },
        } as unknown as NonNullable<typeof JC.state>;
        JC.pluginConfig = {
            DisableAllShortcuts: true,
            Shortcuts: [],
            AnimeFillerWarningsEnabled: false,
        };
        JC.t = (key: string, params?: Record<string, unknown>) => {
            if (key === 'panel_title') return 'Canopy User Settings';
            if (key === 'panel_admin_target_banner') return `Editing settings for ${String(params?.name)}`;
            return key;
        };
        JC.icon = () => '';
        JC.IconName = {
            PLAYBACK: 'playback', SKIP: 'skip', SUBTITLES: 'subtitles', PAINT: 'paint',
            RANDOM: 'random', UI: 'ui', EYE: 'eye', MASK: 'mask', LANGUAGE: 'language',
            QUESTION: 'question', WARNING: 'warning',
        };
        Object.assign(JC, {
            subtitlePresets: [],
            fontSizePresets: [],
            fontFamilyPresets: [],
            themer: {
                getThemeVariables: () => ({
                    panelBg: '#181818',
                    secondaryBg: '#222',
                    altAccent: '#333',
                    blur: '0px',
                    textColor: '#fff',
                    logo: '',
                }),
            },
        });
        JC.CONFIG = { ...JC.CONFIG, HELP_PANEL_AUTOCLOSE_DELAY: 60_000 };
        vi.stubGlobal('matchMedia', vi.fn((query: string): MediaQueryList => {
            const target = new EventTarget();
            return Object.assign(target, {
                matches: false,
                media: query,
                onchange: null,
                addListener: () => undefined,
                removeListener: () => undefined,
            }) as MediaQueryList;
        }));
        const plugin = vi.fn(async (path: string, options?: Record<string, unknown>) => {
            if (path === '/locales') return [];
            if (options?.method === 'POST') {
                const body = options.body as Record<string, unknown>;
                posts.push({ path, body });
                return response(path.endsWith('shortcuts.json') ? 'shortcuts.json' : 'settings.json',
                    Number(body.Revision) + 1, body);
            }
            if (path.includes(`/admin/user-settings/${TARGET}/settings.json`)) {
                return response('settings.json', 1, {
                    AutoPauseEnabled: true,
                    LastOpenedTab: 'playback',
                });
            }
            if (path.includes(`/admin/user-settings/${TARGET}/shortcuts.json`)) {
                return response('shortcuts.json', 2, { Shortcuts: [] });
            }
            throw new Error(`unexpected plugin path ${path}`);
        });
        JC.core.api = {
            plugin,
            jf: vi.fn().mockResolvedValue([]),
        } as unknown as ApiApi;

        const panel = await import('./panel');
        showPanel = panel.showEnhancedPanel as (launch?: unknown) => Promise<void>;
        resetPanel = panel.resetSettingsPanel;
        resetPanel();
    });

    afterEach(() => {
        resetPanel?.();
        resetPanel = null;
        showPanel = null;
        JC.core.api = originalApi;
        ApiClient.getCurrentUser = originalGetCurrentUser;
        ApiClient.getCurrentUserId = originalGetCurrentUserId;
        ApiClient.serverId = originalServerId;
        JC.transformUserFileCase = originalTransform;
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        document.body.innerHTML = '';
    });

    function launch() {
        return {
            actor: JC.identity.capture()!,
            url: `http://localhost/web/#/mypreferencesmenu?userId=${TARGET}`,
        };
    }

    it('labels the target and does not persist target LastOpenedTab during pane navigation', async () => {
        const actorSnapshot = JSON.stringify({
            settings: JC.currentSettings,
            userConfig: JC.userConfig,
            shortcuts: JC.state!.activeShortcuts,
        });
        await showPanel!(launch());

        const panel = document.getElementById('jellyfin-canopy-panel')!;
        expect(panel.textContent).toContain('Editing settings for Target User');
        const about = [...panel.querySelectorAll<HTMLButtonElement>('.tab-button')]
            .find(button => button.textContent?.includes('panel_about_title'))!;
        about.click();

        expect(posts).toEqual([]);
        expect(JSON.stringify({
            settings: JC.currentSettings,
            userConfig: JC.userConfig,
            shortcuts: JC.state!.activeShortcuts,
        })).toBe(actorSnapshot);
    });

    it('posts a target toggle and keeps a retained control inert after its launch lease expires', async () => {
        const actorSnapshot = JSON.stringify(JC.currentSettings);
        await showPanel!(launch());
        const toggle = document.getElementById('autoPauseToggle') as HTMLInputElement;
        toggle.checked = false;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));
        await vi.waitFor(() => expect(posts).toHaveLength(1));

        expect(posts[0].path).toBe(`/admin/user-settings/${TARGET}/settings.json`);
        expect(posts[0].body).toMatchObject({ AutoPauseEnabled: false, Revision: 1 });
        expect(JSON.stringify(JC.currentSettings)).toBe(actorSnapshot);

        resetPanel!();
        toggle.checked = true;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));
        await Promise.resolve();
        expect(posts).toHaveLength(1);
    });

    it('silently discards a malformed target read completed after the opening panel closes', async () => {
        let resolveSettings: ((value: unknown) => void) | null = null;
        JC.core.api = {
            plugin: vi.fn(async (path: string) => {
                if (path.includes(`/admin/user-settings/${TARGET}/settings.json`)) {
                    return new Promise(resolve => { resolveSettings = resolve; });
                }
                if (path.includes(`/admin/user-settings/${TARGET}/shortcuts.json`)) {
                    return response('shortcuts.json', 2, { Shortcuts: [] });
                }
                if (path === '/locales') return [];
                throw new Error(`unexpected plugin path ${path}`);
            }),
            jf: vi.fn().mockResolvedValue([]),
        } as unknown as ApiApi;

        const opening = showPanel!(launch());
        await vi.waitFor(() => expect(resolveSettings).not.toBeNull());
        resetPanel!();
        resolveSettings!({ Success: true, File: 'settings.json' });
        await opening;

        expect(document.getElementById('jellyfin-canopy-panel')).toBeNull();
        expect(document.querySelector('.jellyfin-canopy-toast')).toBeNull();
    });

    it('aborts a deferred target save and stays silent after a stale 503 completion', async () => {
        let rejectPost: ((reason: unknown) => void) | null = null;
        let postObserved: Promise<void> | null = null;
        let postSignal: AbortSignal | null = null;
        JC.core.api = {
            plugin: vi.fn(async (path: string, options?: Record<string, unknown>) => {
                if (options?.method === 'POST') {
                    postSignal = options.signal as AbortSignal;
                    const request = new Promise<unknown>((_resolve, reject) => {
                        rejectPost = reject;
                    });
                    postObserved = request.then(() => undefined, () => undefined);
                    return request;
                }
                if (path === '/locales') return [];
                if (path.includes(`/admin/user-settings/${TARGET}/settings.json`)) {
                    return response('settings.json', 1, { AutoPauseEnabled: true });
                }
                if (path.includes(`/admin/user-settings/${TARGET}/shortcuts.json`)) {
                    return response('shortcuts.json', 2, { Shortcuts: [] });
                }
                throw new Error(`unexpected plugin path ${path}`);
            }),
            jf: vi.fn().mockResolvedValue([]),
        } as unknown as ApiApi;
        const actorSnapshot = JSON.stringify({
            settings: JC.currentSettings,
            userConfig: JC.userConfig,
            shortcuts: JC.state!.activeShortcuts,
        });
        const saveError = vi.fn();
        document.addEventListener('jc:admin-target-settings-save-error', saveError);
        await showPanel!(launch());

        const toggle = document.getElementById('autoPauseToggle') as HTMLInputElement;
        toggle.checked = false;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));
        await vi.waitFor(() => expect(rejectPost).not.toBeNull());
        resetPanel!();
        expect((postSignal as AbortSignal | null)?.aborted).toBe(true);
        rejectPost!(Object.assign(new Error('late unavailable'), { status: 503 }));
        await Promise.resolve(postObserved);
        for (let turn = 0; turn < 10; turn++) await Promise.resolve();

        expect(saveError).not.toHaveBeenCalled();
        expect(document.querySelector('.jellyfin-canopy-toast')).toBeNull();
        expect(document.getElementById('jellyfin-canopy-panel')).toBeNull();
        expect(JSON.stringify({
            settings: JC.currentSettings,
            userConfig: JC.userConfig,
            shortcuts: JC.state!.activeShortcuts,
        })).toBe(actorSnapshot);
        document.removeEventListener('jc:admin-target-settings-save-error', saveError);
    });
});
