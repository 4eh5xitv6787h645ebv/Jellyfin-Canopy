import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import type { IdentityContext } from '../types/jc';
import './config';

const saveUserSettings = JC.saveUserSettings!;

function startSession(userId = 'test-user-id', serverId = 'test-server-id'): IdentityContext {
    JC.identity.transition('', '', 'test-logout');
    return JC.identity.transition(serverId, userId, 'test-login')!;
}

describe('identity-owned user settings', () => {
    beforeEach(() => {
        startSession();
        vi.spyOn(ApiClient, 'getCurrentUserId').mockReturnValue('test-user-id');
    });

    afterEach(() => {
        vi.restoreAllMocks();
        JC.pluginConfig = {};
        JC.state!.activeShortcuts = {};
    });

    it('rejects both unowned and stale payloads before ajax', async () => {
        const ajax = vi.spyOn(ApiClient, 'ajax').mockResolvedValue({});

        await expect(saveUserSettings('shortcuts.json', { Revision: 0, Shortcuts: [] })).rejects.toMatchObject({
            kind: 'cancelled'
        });

        const ownerA = JC.identity.capture()!;
        const stale = JC.identity.own({ Revision: 0, Shortcuts: [] }, ownerA);
        JC.identity.transition('test-server-id', 'user-b', 'account-switch');
        vi.spyOn(ApiClient, 'getCurrentUserId').mockReturnValue('user-b');
        await expect(saveUserSettings('shortcuts.json', stale)).rejects.toMatchObject({ kind: 'cancelled' });

        expect(ajax).not.toHaveBeenCalled();
    });

    it('refuses a current-owned same-user snapshot when the live client belongs to another server', async () => {
        const owner = JC.identity.capture()!;
        const payload = JC.identity.own({ Revision: 0, Shortcuts: [{ Name: 'A', Key: 'a' }] }, owner);
        const liveClient = ApiClient as JellyfinApiClient & { serverId: () => string };
        const serverId = vi.spyOn(liveClient, 'serverId').mockReturnValue('other-server-id');
        const ajax = vi.spyOn(ApiClient, 'ajax');
        await expect(saveUserSettings('shortcuts.json', payload)).rejects.toMatchObject({ kind: 'authorization' });

        expect(serverId).toHaveBeenCalled();
        expect(ajax).not.toHaveBeenCalled();
    });

    it('fails closed when both the owner and live client use the unresolved server fallback', async () => {
        const owner = startSession('test-user-id', 'unknown-server');
        const payload = JC.identity.own({ Revision: 0, Shortcuts: [{ Name: 'A', Key: 'a' }] }, owner);
        const liveClient = ApiClient as JellyfinApiClient & { serverId: () => string };
        vi.spyOn(liveClient, 'serverId').mockReturnValue('unknown-server');
        const ajax = vi.spyOn(ApiClient, 'ajax').mockResolvedValue({});
        await expect(saveUserSettings('shortcuts.json', payload)).rejects.toMatchObject({ kind: 'authorization' });

        expect(ajax).not.toHaveBeenCalled();
    });

    it('allows a save when getUrl supplies the concrete server fallback', async () => {
        const owner = startSession('test-user-id', 'http://jellyfin.test');
        const payload = JC.identity.own({
            Revision: 0,
            Shortcuts: [] as Array<{ Name: string; Key: string }>
        }, owner);
        JC.rememberUserSettingsSnapshot!('shortcuts.json', payload);
        payload.Shortcuts.push({ Name: 'A', Key: 'a' });
        const liveClient = ApiClient as JellyfinApiClient & { serverId: () => string };
        vi.spyOn(liveClient, 'serverId').mockReturnValue('unknown-server');
        const ajax = vi.spyOn(ApiClient, 'ajax').mockResolvedValue({
            success: true,
            file: 'shortcuts.json',
            revision: 1,
            contentHash: 'a'.repeat(64),
            data: { Revision: 1, Shortcuts: [{ Name: 'A', Key: 'A' }] }
        });
        const originalCoreApi = JC.core.api;
        delete JC.core.api;

        try {
            await saveUserSettings('shortcuts.json', payload);
        } finally {
            JC.core.api = originalCoreApi;
        }

        expect(ajax).toHaveBeenCalledTimes(1);
        expect(ajax).toHaveBeenCalledWith(expect.objectContaining({
            url: 'http://jellyfin.test/JellyfinCanopy/user-settings/testuserid/shortcuts.json'
        }));
    });

    it('does not publish an A acknowledgement into a later same-user epoch', async () => {
        let resolvePost!: (value: unknown) => void;
        const firstPost = new Promise((resolve) => { resolvePost = resolve; });
        const ack = {
            success: true,
            file: 'shortcuts.json',
            revision: 1,
            contentHash: 'b'.repeat(64),
            data: { Revision: 1, Shortcuts: [{ Name: 'Open', Key: 'O' }] }
        };
        const ajax = vi.spyOn(ApiClient, 'ajax')
            .mockReturnValueOnce(firstPost)
            .mockResolvedValueOnce(ack);
        const ownerA = JC.identity.capture()!;
        const payloadA = JC.identity.own({ Revision: 0, Shortcuts: [] as Array<{ Name: string; Key: string }> }, ownerA);
        JC.rememberUserSettingsSnapshot!('shortcuts.json', payloadA);
        payloadA.Shortcuts.push({ Name: 'Open', Key: 'o' });

        const pending = saveUserSettings('shortcuts.json', payloadA);
        expect(ajax).toHaveBeenCalledTimes(1);

        const ownerB = startSession();
        resolvePost(ack);
        await expect(pending).rejects.toMatchObject({ kind: 'cancelled' });

        const payloadB = JC.identity.own({ Revision: 0, Shortcuts: [] as Array<{ Name: string; Key: string }> }, ownerB);
        JC.rememberUserSettingsSnapshot!('shortcuts.json', payloadB);
        payloadB.Shortcuts.push({ Name: 'Open', Key: 'o' });
        await saveUserSettings('shortcuts.json', payloadB);

        expect(ajax).toHaveBeenCalledTimes(2);
    });

    it('returns a current-owned merge and excludes settings owned by A', () => {
        const ownerA = JC.identity.capture()!;
        const staleSettings = JC.identity.own({ accountAOnly: 'secret' }, ownerA);
        const ownerB = JC.identity.transition('test-server-id', 'user-b', 'account-switch')!;
        JC.userConfig = JC.identity.own({ settings: staleSettings }, ownerB);

        const merged = JC.loadSettings!();

        expect(merged).not.toHaveProperty('accountAOnly');
        expect(JC.identity.isOwned(merged, ownerB)).toBe(true);
    });

    it('replaces the shortcut map so A-only keys cannot survive B init', () => {
        JC.state!.activeShortcuts = { AccountAOnly: 'a' };
        JC.pluginConfig = { Shortcuts: [{ Name: 'Default', Key: 'd' }] };
        JC.userConfig = {
            shortcuts: { Shortcuts: [{ Name: 'UserB', Key: 'b' }] },
        };

        JC.initializeShortcuts!();

        expect(JC.state!.activeShortcuts).toEqual({ Default: 'D', UserB: 'B' });
    });
});
