import { afterEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import { emit, LIVE } from './live';
import {
    detectRefreshSources,
    isHomeRoute,
    mayCommitRefresh,
    nextReloadBudget,
    normalizeRefreshState,
    refreshSafetyBlockReason,
    type ClientRefreshState,
} from './live-update';

const hash = (character: string): string => character.repeat(64);

function state(overrides: Partial<ClientRefreshState> = {}): ClientRefreshState {
    return {
        SchemaVersion: 1,
        CanopyBuildId: hash('a'),
        JellyfinGeneration: hash('b'),
        ConfigurationRevision: 1,
        ForceRevision: 0,
        Policy: {
            Mode: 'Smart',
            OnCanopyUpdate: true,
            OnJellyfinUpdate: true,
            OnConfigChange: true,
            PollSeconds: 30,
            IdleSeconds: 5,
        },
        ...overrides,
    };
}

describe('smart refresh state validation', () => {
    it('accepts the server contract and clamps hostile timing values', () => {
        const value = state({
            Policy: {
                Mode: 'Smart',
                OnCanopyUpdate: true,
                OnJellyfinUpdate: true,
                OnConfigChange: true,
                PollSeconds: 1,
                IdleSeconds: 999,
            },
        });

        expect(normalizeRefreshState(value)).toMatchObject({
            Policy: { PollSeconds: 5, IdleSeconds: 300 },
        });
    });

    it('rejects malformed fingerprints and revisions', () => {
        expect(normalizeRefreshState({ ...state(), CanopyBuildId: '2.0.0.0' })).toBeNull();
        expect(normalizeRefreshState({ ...state(), ConfigurationRevision: 1.5 })).toBeNull();
        expect(normalizeRefreshState({ error: 'unauthorized' })).toBeNull();
    });
});

describe('refresh source detection', () => {
    it('detects a same-version Canopy replacement by content build id on the first check', () => {
        const sources = detectRefreshSources(null, state(), hash('c'));
        expect([...sources]).toEqual(['canopy']);
    });

    it('keeps config and explicit admin signals independent within one server process', () => {
        const previous = state();
        const next = state({
            ConfigurationRevision: 2,
            ForceRevision: 1,
        });

        expect([...detectRefreshSources(previous, next, hash('a'))])
            .toEqual(['config', 'force']);
    });

    it('does not misclassify process-local revision resets after a Jellyfin restart', () => {
        const previous = state({ ConfigurationRevision: 9, ForceRevision: 4 });
        const restarted = state({
            JellyfinGeneration: hash('c'),
            ConfigurationRevision: 0,
            ForceRevision: 0,
        });

        expect([...detectRefreshSources(previous, restarted, hash('a'))])
            .toEqual(['jellyfin']);
    });
});

describe('safe-point policy', () => {
    afterEach(() => {
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    it('recognizes both Jellyfin Home route dialects', () => {
        expect(isHomeRoute('https://server/web/#/home.html')).toBe(true);
        expect(isHomeRoute('https://server/web/home?tab=0')).toBe(true);
        expect(isHomeRoute('https://server/web/details?id=1')).toBe(false);
    });

    it('requires safety and idleness, and limits HomeOnly to Home', () => {
        expect(mayCommitRefresh('Smart', false, true, false, true)).toBe(true);
        expect(mayCommitRefresh('Smart', false, true, false, false)).toBe(false);
        expect(mayCommitRefresh('HomeOnly', false, true, false, true)).toBe(false);
        expect(mayCommitRefresh('HomeOnly', false, true, true, true)).toBe(true);
        expect(mayCommitRefresh('Notify', false, true, true, true)).toBe(false);
        expect(mayCommitRefresh('Disabled', false, true, true, true)).toBe(false);
        expect(mayCommitRefresh('Disabled', true, true, false, true)).toBe(true);
    });

    it('blocks both playing and paused media until the playback element ends', () => {
        const video = document.createElement('video');
        video.src = 'https://media.test/video.m3u8';
        Object.defineProperty(video, 'readyState', { configurable: true, value: 2 });
        Object.defineProperty(video, 'currentTime', { configurable: true, value: 30 });
        Object.defineProperty(video, 'paused', { configurable: true, value: false });
        document.body.appendChild(video);

        expect(refreshSafetyBlockReason(document, 'https://server/web/home')).toBe('media-element');

        Object.defineProperty(video, 'paused', { configurable: true, value: true });
        expect(refreshSafetyBlockReason(document, 'https://server/web/home')).toBe('media-element');

        Object.defineProperty(video, 'ended', { configurable: true, value: true });
        expect(refreshSafetyBlockReason(document, 'https://server/web/home')).toBeNull();
    });

    it('blocks the player route, config editors, and open dialogs', () => {
        expect(refreshSafetyBlockReason(document, 'https://server/web/home', true)).toBe('background');
        expect(refreshSafetyBlockReason(document, 'https://server/web/video?id=1')).toBe('playback-route');
        expect(refreshSafetyBlockReason(document, 'https://server/web/#/configurationpage?name=Canopy'))
            .toBe('editing-route');
        expect(refreshSafetyBlockReason(document, 'https://server/web/#/mypreferencesmenu.html'))
            .toBe('editing-route');
        expect(refreshSafetyBlockReason(document, 'https://server/web/#/mypreferenceshome'))
            .toBe('editing-route');
        expect(refreshSafetyBlockReason(document, 'https://server/web/#/settings'))
            .toBe('editing-route');

        document.body.innerHTML = '<div class="dialog opened"></div>';
        expect(refreshSafetyBlockReason(document, 'https://server/web/home')).toBe('dialog');

        document.body.innerHTML = '<div role="dialog"></div>';
        expect(refreshSafetyBlockReason(document, 'https://server/web/home')).toBe('dialog');

        document.body.innerHTML = '<div aria-hidden="true"><div role="dialog"></div></div>';
        expect(refreshSafetyBlockReason(document, 'https://server/web/home')).toBeNull();
    });

    it('blocks an actively edited field on an otherwise safe route', () => {
        const input = document.createElement('input');
        document.body.appendChild(input);
        input.focus();

        expect(refreshSafetyBlockReason(document, 'https://server/web/home')).toBe('active-editor');
    });
});

describe('reload-loop budget', () => {
    it('allows three reloads per minute and blocks the fourth', () => {
        const first = nextReloadBudget([], 1_000);
        const second = nextReloadBudget(first.history, 2_000);
        const third = nextReloadBudget(second.history, 3_000);
        const fourth = nextReloadBudget(third.history, 4_000);

        expect(first.allowed).toBe(true);
        expect(third.allowed).toBe(true);
        expect(fourth.allowed).toBe(false);
    });

    it('recovers when the old window expires', () => {
        expect(nextReloadBudget([1_000, 2_000, 3_000], 70_000).allowed).toBe(true);
    });
});

describe('foreground lifecycle checks', () => {
    afterEach(() => {
        document.getElementById('jc-client-refresh-notice')?.remove();
        vi.restoreAllMocks();
    });

    it('does no background request and checks immediately when a mobile WebView resumes', async () => {
        const original = JC.identity.capture()!;
        let hidden = true;
        vi.spyOn(document, 'visibilityState', 'get').mockImplementation(
            () => hidden ? 'hidden' : 'visible',
        );
        const plugin = vi.fn().mockResolvedValue(state());
        JC.core.api = { plugin } as unknown as NonNullable<typeof JC.core.api>;

        const next = JC.identity.transition('resume-server', 'resume-user', 'resume-test')!;
        await JC.identity.activate(next);
        expect(plugin).not.toHaveBeenCalled();

        hidden = false;
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(1));

        hidden = true;
        document.dispatchEvent(new Event('visibilitychange'));
        emit(LIVE.CONFIG_CHANGED, {});
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(plugin).toHaveBeenCalledTimes(1);

        hidden = false;
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(2));

        JC.identity.transition(original.serverId, original.userId, 'resume-test-restore');
    });

    it('queues one follow-up when a foreground signal lands during a state check', async () => {
        const original = JC.identity.capture()!;
        let resolveFirst: (value: ClientRefreshState) => void = () => undefined;
        const first = new Promise<ClientRefreshState>((resolve) => { resolveFirst = resolve; });
        const plugin = vi.fn()
            .mockImplementationOnce(() => first)
            .mockResolvedValue(state());
        JC.core.api = { plugin } as unknown as NonNullable<typeof JC.core.api>;

        const next = JC.identity.transition('race-server', 'race-user', 'race-test')!;
        await JC.identity.activate(next);
        expect(plugin).toHaveBeenCalledTimes(1);

        window.dispatchEvent(new Event('focus'));
        resolveFirst(state());
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(2));

        JC.identity.transition(original.serverId, original.userId, 'race-test-restore');
    });

    it('treats Cordova pause as background even when WebView visibility stays visible', async () => {
        const original = JC.identity.capture()!;
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
        const plugin = vi.fn().mockResolvedValue(state({
            Policy: { ...state().Policy, Mode: 'Notify' },
        }));
        JC.core.api = { plugin } as unknown as NonNullable<typeof JC.core.api>;

        const next = JC.identity.transition('cordova-server', 'cordova-user', 'cordova-test')!;
        await JC.identity.activate(next);
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(1));

        document.dispatchEvent(new Event('pause'));
        emit(LIVE.CONFIG_CHANGED, {});
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(plugin).toHaveBeenCalledTimes(1);

        document.dispatchEvent(new Event('resume'));
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(2));

        JC.identity.transition(original.serverId, original.userId, 'cordova-test-restore');
    });

    it('renders the Ask-mode reload action after a live config revision changes', async () => {
        const original = JC.identity.capture()!;
        const first = state({
            Policy: { ...state().Policy, Mode: 'Notify' },
        });
        const changed = state({
            ConfigurationRevision: 2,
            Policy: { ...state().Policy, Mode: 'Notify' },
        });
        const plugin = vi.fn()
            .mockResolvedValueOnce(first)
            .mockResolvedValue(changed);
        JC.core.api = { plugin } as unknown as NonNullable<typeof JC.core.api>;

        const next = JC.identity.transition('notify-server', 'notify-user', 'notify-test')!;
        await JC.identity.activate(next);
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(1));
        await new Promise((resolve) => setTimeout(resolve, 0));

        emit(LIVE.CONFIG_CHANGED, {});
        await vi.waitFor(() => {
            expect(plugin).toHaveBeenCalledTimes(2);
            expect(document.getElementById('jc-client-refresh-notice')).not.toBeNull();
        });
        expect(document.getElementById('jc-client-refresh-notice')?.textContent)
            .toMatch(/server settings changed/i);
        document.dispatchEvent(new Event('pointerdown', { bubbles: true }));

        const video = document.createElement('video');
        video.src = 'https://media.test/paused.m3u8';
        Object.defineProperty(video, 'readyState', { configurable: true, value: 2 });
        Object.defineProperty(video, 'currentTime', { configurable: true, value: 30 });
        Object.defineProperty(video, 'paused', { configurable: true, value: true });
        document.body.appendChild(video);
        document.querySelector<HTMLButtonElement>('#jc-client-refresh-notice button')?.click();
        expect(document.getElementById('jc-client-refresh-notice')?.textContent)
            .toMatch(/media element is clear/i);

        JC.identity.transition(original.serverId, original.userId, 'notify-test-restore');
        expect(document.getElementById('jc-client-refresh-notice')).toBeNull();
    });

    it('drops an already-pending source when a newer policy disables it', async () => {
        const original = JC.identity.capture()!;
        const first = state({
            Policy: { ...state().Policy, Mode: 'Notify' },
        });
        const pending = state({
            ConfigurationRevision: 2,
            Policy: { ...state().Policy, Mode: 'Notify' },
        });
        const disabled = state({
            ConfigurationRevision: 3,
            Policy: {
                ...state().Policy,
                Mode: 'Notify',
                OnConfigChange: false,
            },
        });
        const plugin = vi.fn()
            .mockResolvedValueOnce(first)
            .mockResolvedValueOnce(pending)
            .mockResolvedValue(disabled);
        JC.core.api = { plugin } as unknown as NonNullable<typeof JC.core.api>;

        const next = JC.identity.transition('toggle-server', 'toggle-user', 'toggle-test')!;
        await JC.identity.activate(next);
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(1));

        emit(LIVE.CONFIG_CHANGED, {});
        await vi.waitFor(() => {
            expect(plugin).toHaveBeenCalledTimes(2);
            expect(document.getElementById('jc-client-refresh-notice')).not.toBeNull();
        });

        emit(LIVE.CONFIG_CHANGED, {});
        await vi.waitFor(() => {
            expect(plugin).toHaveBeenCalledTimes(3);
            expect(document.getElementById('jc-client-refresh-notice')).toBeNull();
        });

        JC.identity.transition(original.serverId, original.userId, 'toggle-test-restore');
    });
});
