import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import './config';

const persistUserSettings = JC.saveUserSettings!;

describe('shortcut configuration migration', () => {
    beforeEach(() => {
        JC.identity.transition('', '', 'shortcut-config-test-reset');
        const context = JC.identity.transition('shortcut-server', 'shortcut-user', 'shortcut-config-test-start')!;
        JC.pluginConfig = {
            Shortcuts: [
                { Name: 'Default', Key: 'shift+ctrl+d' },
                { Name: 'Legacy', Key: 'L' },
            ],
        };
        JC.state = {
            activeShortcuts: {},
            removeContext: null,
            pauseScreenClickTimer: null,
        };
        JC.userConfig = {
            shortcuts: JC.identity.own({
                Revision: 4,
                Shortcuts: [
                    { Name: 'Legacy', Key: 'shift+CTRL+k' },
                    { Name: 'LegacySpace', Key: 'ctrl+ ' },
                ],
            }, context),
        };
        JC.saveUserSettings = persistUserSettings;
        vi.spyOn(ApiClient, 'getCurrentUserId').mockReturnValue('shortcut-user');
        vi.spyOn(ApiClient as JellyfinApiClient & { serverId: () => string }, 'serverId')
            .mockReturnValue('shortcut-server');
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('publishes canonical bindings and stages a loaded legacy permutation for the next save', () => {
        const save = vi.fn();
        JC.saveUserSettings = save;

        JC.initializeShortcuts!();

        expect(JC.state!.activeShortcuts).toEqual({
            Default: 'Ctrl+Shift+D',
            Legacy: 'Ctrl+Shift+K',
            LegacySpace: 'Ctrl+Space',
        });
        expect(JC.userConfig!.shortcuts!.Shortcuts).toEqual([
            { Name: 'Legacy', Key: 'Ctrl+Shift+K' },
            { Name: 'LegacySpace', Key: 'Ctrl+Space' },
        ]);
        expect(save).not.toHaveBeenCalled();

        JC.initializeShortcuts!();
        expect(save).not.toHaveBeenCalled();
    });

    it('canonicalizes the wire payload for every shortcut persistence caller', async () => {
        const payload = JC.userConfig!.shortcuts!;
        JC.rememberUserSettingsSnapshot!('shortcuts.json', payload);
        const ajax = vi.spyOn(ApiClient, 'ajax').mockResolvedValue({
            success: true,
            file: 'shortcuts.json',
            revision: 5,
            contentHash: 'a'.repeat(64),
            data: {
                Revision: 5,
                Shortcuts: [
                    { Name: 'Legacy', Key: 'Ctrl+Shift+K' },
                    { Name: 'LegacySpace', Key: 'Ctrl+Space' },
                ],
            },
        });

        await persistUserSettings('shortcuts.json', payload);

        expect(JSON.parse(String(ajax.mock.calls[0][0].data))).toEqual({
            Revision: 4,
            Shortcuts: [
                { Name: 'Legacy', Key: 'Ctrl+Shift+K' },
                { Name: 'LegacySpace', Key: 'Ctrl+Space' },
            ],
        });
    });

    it('treats an empty named row as an intentional user disable', () => {
        JC.pluginConfig = {
            Shortcuts: [
                { Name: 'Play', Key: 'P' },
                { Name: 'JumpToPercentage', Key: '0-9' },
            ],
        };
        JC.userConfig = {
            shortcuts: {
                Revision: 8,
                Shortcuts: [
                    { Name: 'Play', Key: '' },
                    { Name: 'JumpToPercentage', Key: '' },
                ],
            },
        };

        JC.initializeShortcuts!();

        expect(JC.state!.activeShortcuts).toEqual({
            Play: '',
            JumpToPercentage: '',
        });
        expect(JC.userConfig.shortcuts!.Shortcuts).toEqual([
            { Name: 'Play', Key: '' },
            { Name: 'JumpToPercentage', Key: '' },
        ]);
    });

    it('allows a user sentinel to re-enable an admin-disabled percentage group', () => {
        JC.pluginConfig = { Shortcuts: [{ Name: 'JumpToPercentage', Key: '' }] };
        JC.userConfig = {
            shortcuts: { Shortcuts: [{ Name: 'JumpToPercentage', Key: '0-9' }] },
        };

        JC.initializeShortcuts!();

        expect(JC.state!.activeShortcuts.JumpToPercentage).toBe('0-9');
    });

    it('replaces A-only disabled and custom bindings when account B initializes', () => {
        JC.pluginConfig = { Shortcuts: [{ Name: 'Play', Key: 'P' }] };
        JC.userConfig = {
            shortcuts: {
                Shortcuts: [
                    { Name: 'Play', Key: '' },
                    { Name: 'OnlyA', Key: 'A' },
                ],
            },
        };
        JC.initializeShortcuts!();
        expect(JC.state!.activeShortcuts).toEqual({ Play: '', OnlyA: 'A' });

        JC.userConfig = { shortcuts: { Shortcuts: [] } };
        JC.initializeShortcuts!();

        expect(JC.state!.activeShortcuts).toEqual({ Play: 'P' });
    });
});
