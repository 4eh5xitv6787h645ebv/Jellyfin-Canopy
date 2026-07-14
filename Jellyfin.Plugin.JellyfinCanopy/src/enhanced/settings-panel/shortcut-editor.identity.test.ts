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
});
