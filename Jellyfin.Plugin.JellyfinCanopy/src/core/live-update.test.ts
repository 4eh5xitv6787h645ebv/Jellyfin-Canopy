import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import { emit, LIVE } from './live';
import {
    acquireRefreshSafetyHold,
    isEditingRoute,
} from './lifecycle';
import {
    beginReloadAttempt,
    detectConservativeFirstStateSources,
    detectRefreshSources,
    isHomeRoute,
    isMonotonicRefreshTransition,
    mayCommitRefresh,
    nextReloadBudget,
    normalizeRefreshState,
    refreshStateBelongsToServer,
    refreshSafetyBlockReason,
    reserveReload,
    type ClientRefreshState,
} from './live-update';

const hash = (character: string): string => character.repeat(64);
let defaultGenerationCharacter = 'b';
let defaultServerId = 'test-server-id';

function state(overrides: Partial<ClientRefreshState> = {}): ClientRefreshState {
    return {
        SchemaVersion: 1,
        ServerId: defaultServerId,
        CanopyBuildId: hash('a'),
        JellyfinGeneration: hash(defaultGenerationCharacter),
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
    it('accepts the exact bounded server contract', () => {
        expect(normalizeRefreshState(state())).toEqual(state());
    });

    it('rejects malformed fingerprints, revisions, and policy fields instead of repairing them', () => {
        expect(normalizeRefreshState({ ...state(), ServerId: '' })).toBeNull();
        expect(normalizeRefreshState({ ...state(), CanopyBuildId: '2.0.0.0' })).toBeNull();
        expect(normalizeRefreshState({ ...state(), ConfigurationRevision: 1.5 })).toBeNull();
        expect(normalizeRefreshState({ ...state(), ConfigurationRevision: -1 })).toBeNull();
        expect(normalizeRefreshState({ ...state(), ForceRevision: -1 })).toBeNull();
        expect(normalizeRefreshState({ error: 'unauthorized' })).toBeNull();

        const validPolicy = state().Policy;
        for (const Policy of [
            { ...validPolicy, Mode: 'Automatic' },
            { ...validPolicy, OnCanopyUpdate: 'true' },
            { ...validPolicy, OnJellyfinUpdate: null },
            { ...validPolicy, OnConfigChange: 1 },
            { ...validPolicy, PollSeconds: 4 },
            { ...validPolicy, PollSeconds: 30.5 },
            { ...validPolicy, PollSeconds: 3601 },
            { ...validPolicy, IdleSeconds: -1 },
            { ...validPolicy, IdleSeconds: 300.5 },
            { ...validPolicy, IdleSeconds: 301 },
        ]) {
            expect(normalizeRefreshState({ ...state(), Policy })).toBeNull();
        }
    });

    it('binds state to its source Jellyfin server without case sensitivity', () => {
        expect(refreshStateBelongsToServer(state(), 'TEST-SERVER-ID')).toBe(true);
        expect(refreshStateBelongsToServer(
            { ...state(), ServerId: '00112233-4455-6677-8899-aabbccddeeff' },
            '00112233445566778899aabbccddeeff',
        )).toBe(true);
        expect(refreshStateBelongsToServer(state(), 'remote-server-id')).toBe(false);
    });

    it('binds a legacy authenticated schema-1 response to its transport server only when absent', () => {
        const legacy = { ...state() } as Partial<ClientRefreshState>;
        delete legacy.ServerId;

        expect(normalizeRefreshState(legacy)).toBeNull();
        expect(normalizeRefreshState(legacy, 'legacy-server-id')?.ServerId)
            .toBe('legacyserverid');
        expect(normalizeRefreshState({ ...legacy, ServerId: '' }, 'legacy-server-id'))
            .toBeNull();
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

    it('preserves an explicit admin refresh requested after the restarted process came up', () => {
        const previous = state({ ConfigurationRevision: 9, ForceRevision: 4 });
        const restartedAndForced = state({
            JellyfinGeneration: hash('c'),
            ConfigurationRevision: 0,
            ForceRevision: 1,
        });

        expect([...detectRefreshSources(previous, restartedAndForced, hash('a'))])
            .toEqual(['jellyfin', 'force']);
    });

    it('detects config and force edges against the pre-runtime document bootstrap', () => {
        const bootstrap = state({ ConfigurationRevision: 1, ForceRevision: 0 });
        const firstPoll = state({ ConfigurationRevision: 2, ForceRevision: 1 });

        expect([...detectRefreshSources(bootstrap, firstPoll, hash('a'))])
            .toEqual(['config', 'force']);
    });

    it('treats generation and positive revisions as edges after a failed pre-runtime capture', () => {
        expect([...detectConservativeFirstStateSources(
            state({ ConfigurationRevision: 1, ForceRevision: 1 }),
            hash('a'),
        )]).toEqual(['jellyfin', 'config', 'force']);
        expect([...detectConservativeFirstStateSources(
            state({ ConfigurationRevision: 0, ForceRevision: 0 }),
            hash('a'),
        )]).toEqual(['jellyfin']);
    });

    it('rejects revision rollback within a process but permits reset on generation change', () => {
        const previous = state({ ConfigurationRevision: 5, ForceRevision: 3 });
        expect(isMonotonicRefreshTransition(
            previous,
            state({ ConfigurationRevision: 4, ForceRevision: 3 }),
        )).toBe(false);
        expect(isMonotonicRefreshTransition(
            previous,
            state({
                JellyfinGeneration: hash('c'),
                ConfigurationRevision: 0,
                ForceRevision: 0,
            }),
        )).toBe(true);
    });
});

describe('safe-point policy', () => {
    afterEach(() => {
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    it('recognizes both Jellyfin Home route dialects', () => {
        expect(isHomeRoute('https://server/web/#/home.html')).toBe(true);
        expect(isHomeRoute('https://server/web/#!/home.html?tab=1')).toBe(true);
        expect(isHomeRoute('https://server/web/home?tab=0')).toBe(true);
        expect(isHomeRoute('https://server/web/home.html?tab=0')).toBe(true);
        expect(isHomeRoute('https://server/web/details?id=1')).toBe(false);
        expect(isHomeRoute('https://server/web/#/details?id=1&returnUrl=/home')).toBe(false);
        expect(isHomeRoute('https://server/web/details?next=/home#tab')).toBe(false);
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

    it('blocks both playing and paused-at-zero media until the playback element ends', () => {
        const video = document.createElement('video');
        video.src = 'https://media.test/video.m3u8';
        Object.defineProperty(video, 'readyState', { configurable: true, value: 2 });
        Object.defineProperty(video, 'currentTime', { configurable: true, value: 0 });
        Object.defineProperty(video, 'paused', { configurable: true, value: false });
        document.body.appendChild(video);

        expect(refreshSafetyBlockReason(document, 'https://server/web/home')).toBe('media-element');

        Object.defineProperty(video, 'paused', { configurable: true, value: true });
        expect(refreshSafetyBlockReason(document, 'https://server/web/home')).toBe('media-element');

        Object.defineProperty(video, 'ended', { configurable: true, value: true });
        expect(refreshSafetyBlockReason(document, 'https://server/web/home')).toBeNull();
    });

    it('blocks unpaused media before metadata while ignoring an untouched paused source', () => {
        const audio = document.createElement('audio');
        audio.src = 'https://media.test/slow-start.m3u8';
        Object.defineProperty(audio, 'readyState', { configurable: true, value: 0 });
        Object.defineProperty(audio, 'paused', { configurable: true, value: false });
        document.body.appendChild(audio);

        expect(refreshSafetyBlockReason(document, 'https://server/web/home')).toBe('media-element');

        Object.defineProperty(audio, 'paused', { configurable: true, value: true });
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
        expect(refreshSafetyBlockReason(document, 'https://server/web/#!/video?id=1'))
            .toBe('playback-route');
        expect(refreshSafetyBlockReason(document, 'https://server/web/#!/configurationpage?name=Canopy'))
            .toBe('editing-route');
        expect(refreshSafetyBlockReason(document, 'https://server/web/#!/mypreferencesmenu.html'))
            .toBe('editing-route');
        expect(refreshSafetyBlockReason(document, 'https://server/web/dashboard/libraries'))
            .toBe('editing-route');
        expect(refreshSafetyBlockReason(document, 'https://server/jellyfin/web/dashboard/plugins'))
            .toBe('editing-route');
        expect(refreshSafetyBlockReason(document, 'https://server/dashboard/networking'))
            .toBe('editing-route');

        for (const route of [
            'userprofile',
            'mypreferencescontrols',
            'mypreferencesdisplay',
            'mypreferencesplayback',
            'mypreferencessubtitles',
        ]) {
            expect(isEditingRoute(`https://server/web/#/${route}.html?tab=1`)).toBe(true);
            expect(isEditingRoute(`https://server/base/web/${route}?tab=1`)).toBe(true);
        }
        expect(isEditingRoute('https://server/web/#/userprofiles')).toBe(false);
        expect(isEditingRoute('https://server/web/#/mypreferences')).toBe(false);

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
    afterEach(() => {
        vi.restoreAllMocks();
        JC.storage.session.remove('live-update-test', 'jc-smart-refresh-budget-v1');
        JC.storage.local.remove('live-update-test', 'jc-smart-refresh-budget-v1');
    });

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

    it('uses durable local storage when session storage is unavailable', () => {
        vi.spyOn(JC.storage.session, 'readJson').mockReturnValue({
            state: 'Unavailable',
            value: null,
        });
        vi.spyOn(Date, 'now')
            .mockReturnValueOnce(1_000)
            .mockReturnValueOnce(2_000)
            .mockReturnValueOnce(3_000)
            .mockReturnValueOnce(4_000);

        expect(reserveReload()).toBe(true);
        expect(reserveReload()).toBe(true);
        expect(reserveReload()).toBe(true);
        expect(reserveReload()).toBe(false);
    });

    it('fails closed when neither durable storage backend can reserve the budget', () => {
        vi.spyOn(JC.storage.session, 'readJson').mockReturnValue({
            state: 'Unavailable',
            value: null,
        });
        vi.spyOn(JC.storage.local, 'readJson').mockReturnValue({
            state: 'QuotaFailure',
            value: null,
        });

        expect(reserveReload()).toBe(false);
    });

    it('fails closed when storage accepts a write but silently drops it', () => {
        for (const storage of [JC.storage.session, JC.storage.local]) {
            vi.spyOn(storage, 'readJson').mockReturnValue({
                state: 'Missing',
                value: null,
            });
            vi.spyOn(storage, 'write').mockReturnValue({
                state: 'Valid',
                value: '[]',
            });
        }

        expect(reserveReload()).toBe(false);
    });

    it('recovers when a reload throws or leaves the same document alive', async () => {
        vi.useFakeTimers();
        const survived = vi.fn();
        const noOpTimer = beginReloadAttempt(() => undefined, survived, 250);
        expect(noOpTimer).not.toBeNull();
        await vi.advanceTimersByTimeAsync(249);
        expect(survived).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(survived).toHaveBeenCalledTimes(1);

        const synchronousFailure = vi.fn();
        expect(beginReloadAttempt(
            () => { throw new Error('WebView rejected reload'); },
            synchronousFailure,
            250,
        )).toBeNull();
        expect(synchronousFailure).toHaveBeenCalledTimes(1);
        vi.useRealTimers();
    });
});

describe('foreground lifecycle checks', () => {
    let generationIndex = 0;

    beforeEach(() => {
        const testIndex = generationIndex++;
        defaultGenerationCharacter = String((testIndex % 9) + 1);
        defaultServerId = `smart-refresh-server-${testIndex}`;
        document.body.innerHTML = '';
        document.dispatchEvent(new Event('resume'));
    });

    afterEach(() => {
        document.body.innerHTML = '';
        document.dispatchEvent(new Event('resume'));
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

        const next = JC.identity.transition(defaultServerId, 'resume-user', 'resume-test')!;
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

        const next = JC.identity.transition(defaultServerId, 'race-user', 'race-test')!;
        await JC.identity.activate(next);
        expect(plugin).toHaveBeenCalledTimes(1);

        window.dispatchEvent(new Event('focus'));
        resolveFirst(state());
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(2));

        JC.identity.transition(original.serverId, original.userId, 'race-test-restore');
    });

    it('adopts the active-server boot watermark and catches a remote first-poll config edge', async () => {
        const original = JC.identity.capture()!;
        const remoteBootstrap = state({
            ServerId: 'remote-server-id',
            Policy: { ...state().Policy, Mode: 'Notify' },
        });
        const remoteFirst = state({
            ...remoteBootstrap,
            ConfigurationRevision: 2,
        });
        JC.clientRefreshBootstrap = remoteBootstrap;
        const plugin = vi.fn().mockResolvedValue(remoteFirst);
        JC.core.api = { plugin } as unknown as NonNullable<typeof JC.core.api>;

        try {
            const remote = JC.identity.transition(
                'remote-server-id',
                'remote-user',
                'remote-source-test',
            )!;
            await JC.identity.activate(remote);
            await vi.waitFor(() => {
                expect(plugin).toHaveBeenCalledTimes(1);
                expect(document.getElementById('jc-client-refresh-notice')?.textContent)
                    .toMatch(/server settings changed/i);
            });
        } finally {
            JC.identity.transition(original.serverId, original.userId, 'remote-source-restore');
            JC.clientRefreshBootstrap = undefined;
        }
    });

    it('does not absorb a remote first-poll force edge into the baseline', async () => {
        const original = JC.identity.capture()!;
        const remoteBootstrap = state({
            ServerId: 'remote-force-server-id',
            Policy: {
                ...state().Policy,
                Mode: 'Disabled',
                OnConfigChange: false,
            },
        });
        const remoteFirst = state({
            ...remoteBootstrap,
            ConfigurationRevision: 2,
            ForceRevision: 1,
        });
        JC.clientRefreshBootstrap = remoteBootstrap;
        const plugin = vi.fn().mockResolvedValue(remoteFirst);
        JC.core.api = { plugin } as unknown as NonNullable<typeof JC.core.api>;
        const releaseModal = acquireRefreshSafetyHold('modal');

        try {
            const remote = JC.identity.transition(
                'remote-force-server-id',
                'remote-user',
                'remote-force-source-test',
            )!;
            await JC.identity.activate(remote);
            await vi.waitFor(() => {
                expect(plugin).toHaveBeenCalledTimes(1);
                expect(document.getElementById('jc-client-refresh-notice')?.textContent)
                    .toMatch(/wait until dialog is clear/i);
            });
        } finally {
            JC.identity.transition(original.serverId, original.userId, 'remote-force-source-restore');
            JC.clientRefreshBootstrap = undefined;
            releaseModal();
        }
    });

    it('conservatively surfaces the first valid state after remote baseline capture failed', async () => {
        const original = JC.identity.capture()!;
        const remoteFirst = state({
            ServerId: 'remote-unbaselined-server-id',
            ConfigurationRevision: 1,
            ForceRevision: 0,
            Policy: { ...state().Policy, Mode: 'Notify' },
        });
        JC.clientRefreshBootstrap = undefined;
        JC.clientRefreshBootstrapUnavailableServerId = 'remote-unbaselined-server-id';
        const plugin = vi.fn().mockResolvedValue(remoteFirst);
        JC.core.api = { plugin } as unknown as NonNullable<typeof JC.core.api>;

        try {
            const remote = JC.identity.transition(
                'remote-unbaselined-server-id',
                'remote-user',
                'remote-unbaselined-source-test',
            )!;
            await JC.identity.activate(remote);
            await vi.waitFor(() => {
                expect(plugin).toHaveBeenCalledTimes(1);
                expect(document.getElementById('jc-client-refresh-notice')?.textContent)
                    .toMatch(/server settings changed/i);
            });
            expect(JC.clientRefreshBootstrapUnavailableServerId).toBe('');
        } finally {
            JC.identity.transition(
                original.serverId,
                original.userId,
                'remote-unbaselined-source-restore',
            );
            JC.clientRefreshBootstrap = undefined;
            JC.clientRefreshBootstrapUnavailableServerId = '';
        }
    });

    it('does not absorb an unknown generation when revisions are zero', async () => {
        const original = JC.identity.capture()!;
        const remoteFirst = state({
            ServerId: 'remote-unknown-generation-server-id',
            ConfigurationRevision: 0,
            ForceRevision: 0,
            Policy: {
                ...state().Policy,
                Mode: 'Notify',
                OnJellyfinUpdate: true,
                OnConfigChange: false,
            },
        });
        JC.clientRefreshBootstrap = undefined;
        JC.clientRefreshBootstrapUnavailableServerId =
            'remote-unknown-generation-server-id';
        const plugin = vi.fn().mockResolvedValue(remoteFirst);
        JC.core.api = { plugin } as unknown as NonNullable<typeof JC.core.api>;

        try {
            const remote = JC.identity.transition(
                'remote-unknown-generation-server-id',
                'remote-user',
                'remote-unknown-generation-source-test',
            )!;
            await JC.identity.activate(remote);
            await vi.waitFor(() => {
                expect(plugin).toHaveBeenCalledTimes(1);
                expect(document.getElementById('jc-client-refresh-notice')?.textContent)
                    .toMatch(/Jellyfin restarted or updated/i);
            });
            expect(JC.clientRefreshBootstrapUnavailableServerId).toBe('');
        } finally {
            JC.identity.transition(
                original.serverId,
                original.userId,
                'remote-unknown-generation-source-restore',
            );
            JC.clientRefreshBootstrap = undefined;
            JC.clientRefreshBootstrapUnavailableServerId = '';
        }
    });

    it('keeps Cordova pause authoritative across an identity transition', async () => {
        const original = JC.identity.capture()!;
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
        const plugin = vi.fn().mockResolvedValue(state({
            Policy: { ...state().Policy, Mode: 'Notify' },
        }));
        JC.core.api = { plugin } as unknown as NonNullable<typeof JC.core.api>;

        const next = JC.identity.transition(defaultServerId, 'cordova-user', 'cordova-test')!;
        await JC.identity.activate(next);
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(1));

        document.dispatchEvent(new Event('pause'));
        emit(LIVE.CONFIG_CHANGED, {});
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(plugin).toHaveBeenCalledTimes(1);

        const switched = JC.identity.transition(
            defaultServerId,
            'cordova-user-switched',
            'cordova-paused-switch',
        )!;
        await JC.identity.activate(switched);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(plugin).toHaveBeenCalledTimes(1);

        document.dispatchEvent(new Event('resume'));
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(2));

        JC.identity.transition(original.serverId, original.userId, 'cordova-test-restore');
    });

    it('waits for the newest foreground policy before evaluating pending intent', async () => {
        const original = JC.identity.capture()!;
        const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
        const first = state();
        const pending = state({ ConfigurationRevision: 2 });
        const disabled = state({
            ConfigurationRevision: 3,
            Policy: {
                ...state().Policy,
                Mode: 'Disabled',
                OnConfigChange: false,
            },
        });
        let resolveDisabled: (value: ClientRefreshState) => void = () => undefined;
        const disabledResponse = new Promise<ClientRefreshState>((resolve) => {
            resolveDisabled = resolve;
        });
        const plugin = vi.fn()
            .mockResolvedValueOnce(first)
            .mockResolvedValueOnce(pending)
            .mockImplementationOnce(() => disabledResponse);
        JC.core.api = { plugin } as unknown as NonNullable<typeof JC.core.api>;

        const next = JC.identity.transition(defaultServerId, 'policy-user', 'policy-test')!;
        await JC.identity.activate(next);
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(1));

        const releaseInteraction = acquireRefreshSafetyHold('interaction');
        emit(LIVE.CONFIG_CHANGED, {});
        await vi.waitFor(() => {
            expect(plugin).toHaveBeenCalledTimes(2);
            expect(document.getElementById('jc-client-refresh-notice')).not.toBeNull();
        });

        const budgetWrite = vi.spyOn(JC.storage.session, 'write');
        now.mockReturnValue(10_000);
        releaseInteraction();
        window.dispatchEvent(new Event('focus'));
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(3));
        await Promise.resolve();
        expect(budgetWrite).not.toHaveBeenCalled();

        resolveDisabled(disabled);
        await vi.waitFor(() =>
            expect(document.getElementById('jc-client-refresh-notice')).toBeNull());

        JC.identity.transition(original.serverId, original.userId, 'policy-test-restore');
    });

    it('lets a target interaction acquire its write hold before zero-idle evaluation', async () => {
        const original = JC.identity.capture()!;
        const first = state({
            Policy: { ...state().Policy, IdleSeconds: 0 },
        });
        const changed = state({
            ConfigurationRevision: 2,
            Policy: { ...state().Policy, IdleSeconds: 0 },
        });
        const plugin = vi.fn()
            .mockResolvedValueOnce(first)
            .mockResolvedValue(changed);
        JC.core.api = { plugin } as unknown as NonNullable<typeof JC.core.api>;

        const next = JC.identity.transition(defaultServerId, 'capture-user', 'capture-test')!;
        await JC.identity.activate(next);
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(1));

        const releaseGate = acquireRefreshSafetyHold('interaction');
        emit(LIVE.CONFIG_CHANGED, {});
        await vi.waitFor(() => {
            expect(plugin).toHaveBeenCalledTimes(2);
            expect(document.getElementById('jc-client-refresh-notice')).not.toBeNull();
        });

        const budgetWrite = vi.spyOn(JC.storage.session, 'write');
        const button = document.createElement('button');
        const writeHold: { release: (() => void) | null } = { release: null };
        button.addEventListener('pointerdown', () => {
            writeHold.release = acquireRefreshSafetyHold('pending-write');
        });
        document.body.appendChild(button);

        releaseGate();
        button.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(budgetWrite).not.toHaveBeenCalled();

        JC.identity.transition(original.serverId, original.userId, 'capture-test-restore');
        writeHold.release?.();
    });

    it('gives Jellyfin-owned click mutations a dispatch grace when idle policy is zero', async () => {
        const original = JC.identity.capture()!;
        const first = state({
            Policy: { ...state().Policy, IdleSeconds: 0 },
        });
        const changed = state({
            ConfigurationRevision: 2,
            Policy: { ...state().Policy, IdleSeconds: 0 },
        });
        const plugin = vi.fn()
            .mockResolvedValueOnce(first)
            .mockResolvedValue(changed);
        JC.core.api = { plugin } as unknown as NonNullable<typeof JC.core.api>;

        const next = JC.identity.transition(defaultServerId, 'host-click-user', 'host-click-test')!;
        await JC.identity.activate(next);
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(1));

        const releaseGate = acquireRefreshSafetyHold('interaction');
        emit(LIVE.CONFIG_CHANGED, {});
        await vi.waitFor(() => {
            expect(plugin).toHaveBeenCalledTimes(2);
            expect(document.getElementById('jc-client-refresh-notice')).not.toBeNull();
        });

        const budgetWrite = vi.spyOn(JC.storage.session, 'write');
        const button = document.createElement('button');
        let rawMutationStarted = false;
        let settleMutation!: () => void;
        const rawMutation = new Promise<void>((resolve) => { settleMutation = resolve; });
        button.addEventListener('click', () => {
            rawMutationStarted = true;
            void rawMutation;
        });
        document.body.appendChild(button);

        releaseGate();
        button.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        // A real click is a later task; the pointerdown decision must not reload
        // before Jellyfin's target click handler can even start its raw request.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(budgetWrite).not.toHaveBeenCalled();
        button.dispatchEvent(new Event('pointerup', { bubbles: true }));
        button.dispatchEvent(new Event('click', { bubbles: true }));
        expect(rawMutationStarted).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(budgetWrite).not.toHaveBeenCalled();

        settleMutation();
        await rawMutation;
        JC.identity.transition(original.serverId, original.userId, 'host-click-test-restore');
    });

    it('counts a click-only accessibility activation as fresh interaction', async () => {
        const original = JC.identity.capture()!;
        const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
        const first = state({
            Policy: { ...state().Policy, IdleSeconds: 0 },
        });
        const changed = state({
            ConfigurationRevision: 2,
            Policy: { ...state().Policy, IdleSeconds: 0 },
        });
        const plugin = vi.fn()
            .mockResolvedValueOnce(first)
            .mockResolvedValue(changed);
        JC.core.api = { plugin } as unknown as NonNullable<typeof JC.core.api>;

        const next = JC.identity.transition(defaultServerId, 'click-only-user', 'click-only-test')!;
        await JC.identity.activate(next);
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(1));

        const releaseGate = acquireRefreshSafetyHold('interaction');
        emit(LIVE.CONFIG_CHANGED, {});
        await vi.waitFor(() => {
            expect(plugin).toHaveBeenCalledTimes(2);
            expect(document.getElementById('jc-client-refresh-notice')).not.toBeNull();
        });

        const budgetWrite = vi.spyOn(JC.storage.session, 'write');
        const button = document.createElement('button');
        let rawMutationStarted = false;
        button.addEventListener('click', () => {
            rawMutationStarted = true;
        });
        document.body.appendChild(button);

        now.mockReturnValue(10_000);
        releaseGate();
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(rawMutationStarted).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(budgetWrite).not.toHaveBeenCalled();

        JC.identity.transition(original.serverId, original.userId, 'click-only-test-restore');
    });

    it.each(['ended', 'emptied'] as const)(
        'lets Jellyfin settle final media state after a captured %s event',
        async (eventType) => {
            const original = JC.identity.capture()!;
            const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
            const first = state({
                Policy: { ...state().Policy, IdleSeconds: 0 },
            });
            const changed = state({
                ConfigurationRevision: 2,
                Policy: { ...state().Policy, IdleSeconds: 0 },
            });
            const plugin = vi.fn()
                .mockResolvedValueOnce(first)
                .mockResolvedValue(changed);
            JC.core.api = { plugin } as unknown as NonNullable<typeof JC.core.api>;

            const next = JC.identity.transition(
                defaultServerId,
                `${eventType}-media-user`,
                `${eventType}-media-test`,
            )!;
            await JC.identity.activate(next);
            await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(1));

            const audio = document.createElement('audio');
            audio.src = 'https://media.test/background.m3u8';
            Object.defineProperties(audio, {
                currentTime: { configurable: true, value: 42 },
                ended: { configurable: true, value: false },
                paused: { configurable: true, value: false },
                readyState: { configurable: true, value: 2 },
            });
            document.body.appendChild(audio);

            emit(LIVE.CONFIG_CHANGED, {});
            await vi.waitFor(() => {
                expect(plugin).toHaveBeenCalledTimes(2);
                expect(document.getElementById('jc-client-refresh-notice')).not.toBeNull();
            });

            const budgetWrite = vi.spyOn(JC.storage.session, 'write');
            let finalMutationStarted = false;
            audio.addEventListener(eventType, () => {
                finalMutationStarted = true;
            });
            now.mockReturnValue(10_000);
            Object.defineProperties(audio, {
                currentTime: { configurable: true, value: eventType === 'ended' ? 42 : 0 },
                ended: { configurable: true, value: eventType === 'ended' },
                paused: { configurable: true, value: true },
                readyState: { configurable: true, value: eventType === 'ended' ? 2 : 0 },
            });

            audio.dispatchEvent(new Event(eventType));
            expect(finalMutationStarted).toBe(true);
            await new Promise((resolve) => setTimeout(resolve, 10));
            expect(budgetWrite).not.toHaveBeenCalled();

            JC.identity.transition(original.serverId, original.userId, `${eventType}-media-restore`);
        },
    );

    it('resets the idle deadline during continuous scrolling and dragging', async () => {
        const original = JC.identity.capture()!;
        const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
        const first = state();
        const changed = state({ ConfigurationRevision: 2 });
        const plugin = vi.fn()
            .mockResolvedValueOnce(first)
            .mockResolvedValue(changed);
        JC.core.api = { plugin } as unknown as NonNullable<typeof JC.core.api>;

        const next = JC.identity.transition(defaultServerId, 'scroll-user', 'scroll-test')!;
        await JC.identity.activate(next);
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(1));

        const releaseGate = acquireRefreshSafetyHold('interaction');
        emit(LIVE.CONFIG_CHANGED, {});
        await vi.waitFor(() => {
            expect(plugin).toHaveBeenCalledTimes(2);
            expect(document.getElementById('jc-client-refresh-notice')).not.toBeNull();
        });

        const budgetWrite = vi.spyOn(JC.storage.session, 'write');
        now.mockReturnValue(7_000);
        document.dispatchEvent(new Event('scroll'));
        now.mockReturnValue(11_000);
        document.dispatchEvent(new Event('wheel'));
        now.mockReturnValue(15_000);
        document.dispatchEvent(new Event('pointermove'));
        releaseGate();
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(budgetWrite).not.toHaveBeenCalled();

        JC.identity.transition(original.serverId, original.userId, 'scroll-test-restore');
    });

    it('marks a Cordova document pause before captured media reevaluation', async () => {
        const original = JC.identity.capture()!;
        const first = state({
            Policy: { ...state().Policy, IdleSeconds: 0 },
        });
        const changed = state({
            ConfigurationRevision: 2,
            Policy: { ...state().Policy, IdleSeconds: 0 },
        });
        const plugin = vi.fn()
            .mockResolvedValueOnce(first)
            .mockResolvedValue(changed);
        JC.core.api = { plugin } as unknown as NonNullable<typeof JC.core.api>;

        const next = JC.identity.transition(defaultServerId, 'pause-order-user', 'pause-order-test')!;
        await JC.identity.activate(next);
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(1));

        const releaseGate = acquireRefreshSafetyHold('interaction');
        emit(LIVE.CONFIG_CHANGED, {});
        await vi.waitFor(() => {
            expect(plugin).toHaveBeenCalledTimes(2);
            expect(document.getElementById('jc-client-refresh-notice')).not.toBeNull();
        });

        const budgetWrite = vi.spyOn(JC.storage.session, 'write');
        releaseGate();
        document.dispatchEvent(new Event('pause'));
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(budgetWrite).not.toHaveBeenCalled();

        JC.identity.transition(original.serverId, original.userId, 'pause-order-test-restore');
    });

    it('retains the document baseline across logout and detects a restart on login', async () => {
        const original = JC.identity.capture()!;
        const first = state({
            JellyfinGeneration: hash('a'),
            Policy: { ...state().Policy, Mode: 'Notify' },
        });
        const restarted = state({
            JellyfinGeneration: hash('f'),
            ConfigurationRevision: 0,
            ForceRevision: 0,
            Policy: { ...state().Policy, Mode: 'Notify' },
        });
        const plugin = vi.fn()
            .mockResolvedValueOnce(first)
            .mockResolvedValue(restarted);
        JC.core.api = { plugin } as unknown as NonNullable<typeof JC.core.api>;

        const firstIdentity = JC.identity.transition(
            defaultServerId,
            'logout-restart-user',
            'logout-restart-start',
        )!;
        await JC.identity.activate(firstIdentity);
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(1));

        JC.identity.transition('', '', 'logout-restart-logout');
        expect(document.getElementById('jc-client-refresh-notice')).toBeNull();

        const signedBackIn = JC.identity.transition(
            defaultServerId,
            'logout-restart-user',
            'logout-restart-login',
        )!;
        await JC.identity.activate(signedBackIn);
        await vi.waitFor(() => {
            expect(plugin).toHaveBeenCalledTimes(2);
            expect(document.getElementById('jc-client-refresh-notice')?.textContent)
                .toMatch(/Jellyfin restarted or updated/i);
        });

        JC.identity.transition(original.serverId, original.userId, 'logout-restart-restore');
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

        const next = JC.identity.transition(defaultServerId, 'notify-user', 'notify-test')!;
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

        const next = JC.identity.transition(defaultServerId, 'toggle-user', 'toggle-test')!;
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

    it('drops stale Canopy intent when a later poll returns to the loaded build', async () => {
        const original = JC.identity.capture()!;
        const refreshPolicy = {
            ...state().Policy,
            OnJellyfinUpdate: false,
            OnConfigChange: false,
            IdleSeconds: 0,
        };
        const loaded = state({ Policy: refreshPolicy });
        const replacement = state({
            CanopyBuildId: hash('f'),
            Policy: refreshPolicy,
        });
        const plugin = vi.fn()
            .mockResolvedValueOnce(loaded)
            .mockResolvedValueOnce(replacement)
            .mockResolvedValue(loaded);
        JC.core.api = { plugin } as unknown as NonNullable<typeof JC.core.api>;

        const next = JC.identity.transition(defaultServerId, 'rollback-user', 'rollback-test')!;
        await JC.identity.activate(next);
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(1));

        const releaseGate = acquireRefreshSafetyHold('interaction');
        emit(LIVE.CONFIG_CHANGED, {});
        await vi.waitFor(() => {
            expect(plugin).toHaveBeenCalledTimes(2);
            expect(document.getElementById('jc-client-refresh-notice')).not.toBeNull();
        });

        const budgetWrite = vi.spyOn(JC.storage.session, 'write');
        emit(LIVE.CONFIG_CHANGED, {});
        await vi.waitFor(() => {
            expect(plugin).toHaveBeenCalledTimes(3);
            expect(document.getElementById('jc-client-refresh-notice')).toBeNull();
        });

        releaseGate();
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(budgetWrite).not.toHaveBeenCalled();

        JC.identity.transition(original.serverId, original.userId, 'rollback-test-restore');
    });
});
