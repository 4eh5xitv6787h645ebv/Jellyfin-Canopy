import { describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import { wireShortcutEditor } from './shortcut-editor';
import type { PanelContext } from './panel';

describe('settings shortcut editor identity ownership', () => {
    it('does not let a retained A key control mutate B shortcuts', () => {
        JC.identity.transition('server-a', 'user-a', 'shortcut-test-start');
        const contextA = JC.identity.capture()!;
        const help = document.createElement('div');
        help.innerHTML = '<span class="shortcut-key" data-action="play">P</span><span></span>';
        const key = help.querySelector<HTMLElement>('.shortcut-key')!;
        JC.pluginConfig = { DisableAllShortcuts: false };
        JC.state = { activeShortcuts: { play: 'P' } } as unknown as NonNullable<typeof JC.state>;
        JC.userConfig = { shortcuts: { Shortcuts: [] } };
        const save = vi.fn().mockResolvedValue(undefined);
        JC.saveUserSettings = save;
        wireShortcutEditor({
            help,
            pluginShortcuts: [{ Name: 'play', Key: 'P' }],
            primaryAccentColor: '#0ff',
            kbdBackground: '#111',
            identityContext: contextA,
            trackTimer: vi.fn(),
        } as unknown as PanelContext);

        JC.identity.transition('server-a', 'user-b', 'account-switch');
        const bShortcuts = { Shortcuts: [] as Array<{ Name: string; Key: string }> };
        JC.userConfig = { shortcuts: bShortcuts };
        key.dispatchEvent(new KeyboardEvent('keydown', { key: 'X', bubbles: true }));

        expect(bShortcuts.Shortcuts).toEqual([]);
        expect(save).not.toHaveBeenCalled();
    });

    it('rejects a duplicate semantic binding regardless of legacy modifier order', () => {
        JC.identity.transition('server-a', 'user-a', 'shortcut-conflict-test-start');
        const context = JC.identity.capture()!;
        const help = document.createElement('div');
        help.innerHTML = [
            '<span class="shortcut-key" data-action="first">Ctrl+Shift+K</span><span></span>',
            '<span class="shortcut-key" data-action="second">Alt+K</span><span></span>',
        ].join('');
        const second = help.querySelectorAll<HTMLElement>('.shortcut-key')[1];
        JC.pluginConfig = { DisableAllShortcuts: false };
        JC.state = {
            // Put the edited action first to prove conflict detection does not
            // stop at its own matching binding before checking other actions.
            activeShortcuts: { second: 'Ctrl+Shift+K', first: 'shift+CTRL+k' },
        } as unknown as NonNullable<typeof JC.state>;
        JC.userConfig = { shortcuts: { Shortcuts: [] } };
        const save = vi.fn().mockResolvedValue(undefined);
        JC.saveUserSettings = save;

        wireShortcutEditor({
            help,
            pluginShortcuts: [
                { Name: 'first', Key: 'Ctrl+Shift+K' },
                { Name: 'second', Key: 'Alt+K' },
            ],
            primaryAccentColor: '#0ff',
            kbdBackground: '#111',
            identityContext: context,
            trackTimer: vi.fn(),
        } as unknown as PanelContext);

        second.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'k', ctrlKey: true, shiftKey: true, bubbles: true,
        }));

        expect(second.classList.contains('shake-error')).toBe(true);
        expect(save).not.toHaveBeenCalled();
        expect(JC.userConfig.shortcuts!.Shortcuts).toEqual([]);
    });

    it('captures Meta independently and saves every entry in canonical form', async () => {
        JC.identity.transition('server-a', 'user-a', 'shortcut-meta-test-start');
        const context = JC.identity.capture()!;
        const help = document.createElement('div');
        help.innerHTML = '<span class="shortcut-key" data-action="play">P</span><span></span>';
        const key = help.querySelector<HTMLElement>('.shortcut-key')!;
        JC.pluginConfig = { DisableAllShortcuts: false };
        JC.state = { activeShortcuts: { play: 'P', other: 'Alt+O' } } as unknown as NonNullable<typeof JC.state>;
        JC.userConfig = {
            shortcuts: {
                Shortcuts: [{ Name: 'other', Key: 'alt+o' }],
            },
        };
        const save = vi.fn().mockResolvedValue(undefined);
        JC.saveUserSettings = save;

        wireShortcutEditor({
            help,
            pluginShortcuts: [{ Name: 'play', Key: 'P' }],
            primaryAccentColor: '#0ff',
            kbdBackground: '#111',
            identityContext: context,
            trackTimer: vi.fn(),
        } as unknown as PanelContext);

        key.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'k', metaKey: true, ctrlKey: true, bubbles: true,
        }));

        expect(JC.userConfig.shortcuts!.Shortcuts).toEqual([
            { Name: 'other', Key: 'Alt+O' },
            { Name: 'play', Key: 'Meta+Ctrl+K' },
        ]);
        expect(save).toHaveBeenCalledWith('shortcuts.json', JC.userConfig.shortcuts);
        await vi.waitFor(() => expect(JC.state!.activeShortcuts.play).toBe('Meta+Ctrl+K'));
    });
});
