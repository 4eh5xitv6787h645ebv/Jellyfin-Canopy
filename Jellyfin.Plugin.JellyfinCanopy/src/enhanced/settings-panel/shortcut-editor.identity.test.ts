import { afterEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import { wireShortcutEditor } from './shortcut-editor';
import type { PanelContext } from './panel';
import type { PanelEditorContext } from './editor-context';

describe('settings shortcut editor identity ownership', () => {
    const ownedTimers = new Set<number>();
    const trackTimer = (timer: number): void => {
        ownedTimers.add(timer);
    };
    const retireTimers = (): void => {
        for (const timer of ownedTimers) window.clearTimeout(timer);
        ownedTimers.clear();
    };

    afterEach(() => {
        // Mirror the panel lifecycle owner: no production callback may survive
        // long enough to observe Vitest tearing down its jsdom environment.
        retireTimers();
        document.body.innerHTML = '';
        if (vi.isFakeTimers()) {
            vi.clearAllTimers();
            vi.useRealTimers();
        }
    });

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
            trackTimer,
        } as unknown as PanelContext);

        JC.identity.transition('server-a', 'user-b', 'account-switch');
        const bShortcuts = { Shortcuts: [] as Array<{ Name: string; Key: string }> };
        JC.userConfig = { shortcuts: bShortcuts };
        key.dispatchEvent(new KeyboardEvent('keydown', { key: 'X', bubbles: true }));

        expect(bShortcuts.Shortcuts).toEqual([]);
        expect(save).not.toHaveBeenCalled();
    });

    it('rejects a duplicate semantic binding regardless of legacy modifier order', () => {
        vi.useFakeTimers();
        JC.identity.transition('server-a', 'user-a', 'shortcut-conflict-test-start');
        const context = JC.identity.capture()!;
        const help = document.createElement('div');
        help.innerHTML = [
            '<span class="shortcut-key" data-action="first">Ctrl+Shift+K</span><span></span>',
            '<span class="shortcut-key" data-action="second">Alt+K</span><span></span>',
        ].join('');
        document.body.appendChild(help);
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
            trackTimer,
        } as unknown as PanelContext);

        second.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'k', ctrlKey: true, shiftKey: true, bubbles: true,
        }));

        expect(second.classList.contains('shake-error')).toBe(true);
        expect(save).not.toHaveBeenCalled();
        expect(JC.userConfig.shortcuts!.Shortcuts).toEqual([]);

        expect(ownedTimers.size).toBe(1);
        const removeFeedback = vi.spyOn(second.classList, 'remove');
        retireTimers();
        help.remove();
        vi.advanceTimersByTime(500);

        expect(help.isConnected).toBe(false);
        expect(ownedTimers.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        expect(removeFeedback).not.toHaveBeenCalled();
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
            trackTimer,
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

    it('publishes an acknowledged self shortcut after its panel lease ends', async () => {
        JC.identity.transition('server-a', 'user-a', 'shortcut-panel-close');
        const actor = JC.identity.capture()!;
        const help = document.createElement('div');
        help.innerHTML = '<span class="shortcut-key" data-action="play">P</span><span></span>';
        const key = help.querySelector<HTMLElement>('.shortcut-key')!;
        const shortcuts = { Shortcuts: [] as Array<{ Name: string; Key: string }> };
        const activeShortcuts = { play: 'P' };
        JC.pluginConfig = { DisableAllShortcuts: false };
        JC.state = { activeShortcuts } as unknown as NonNullable<typeof JC.state>;
        let resolveSave!: () => void;
        const saving = new Promise<{
            acknowledged: true;
            deduplicated: false;
            file: string;
            revision: number;
            contentHash: string;
        }>(resolve => {
            resolveSave = () => resolve({
                acknowledged: true,
                deduplicated: false,
                file: 'shortcuts.json',
                revision: 2,
                contentHash: 'a'.repeat(64),
            });
        });
        let panelCurrent = true;
        const editor: PanelEditorContext = {
            mode: 'self',
            actor,
            targetUserId: actor.userId,
            targetDisplayName: '',
            appliesToActor: true,
            settings: {},
            shortcuts,
            activeShortcuts,
            isCurrent: () => panelCurrent && JC.identity.isCurrent(actor),
            saveSettings: () => saving,
            saveShortcuts: () => saving,
        };
        wireShortcutEditor({
            help,
            pluginShortcuts: [{ Name: 'play', Key: 'P' }],
            primaryAccentColor: '#0ff',
            kbdBackground: '#111',
            identityContext: actor,
            editor,
            trackTimer,
        } as unknown as PanelContext);

        key.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'k',
            ctrlKey: true,
            bubbles: true,
        }));
        panelCurrent = false;
        resolveSave();

        await vi.waitFor(() => expect(JC.state!.activeShortcuts.play).toBe('Ctrl+K'));
        expect(key.textContent).toBe('P');
        expect(JC.identity.isCurrent(actor)).toBe(true);
    });

    it('disables one action explicitly, removes duplicate rows, and preserves last-row metadata', async () => {
        JC.identity.transition('server-a', 'user-a', 'shortcut-disable');
        const actor = JC.identity.capture()!;
        const help = document.createElement('div');
        help.innerHTML = `
            <div class="jc-shortcut-row">
                <span class="shortcut-key" tabindex="0" data-action="play" data-label="Play">P</span>
                <span><span class="modified-indicator">•</span>Play</span>
                <button class="shortcut-state-button" data-action="play" data-operation="disable">Disabled</button>
                <button class="shortcut-reset-button" data-action="play">Reset</button>
            </div>`;
        const shortcuts = {
            Shortcuts: [
                { Name: 'play', Key: 'X', Earlier: true },
                { Name: 'play', Key: 'Y', FutureMetadata: { owner: 'last' } },
            ],
        };
        const activeShortcuts = { play: 'Y' };
        const save = vi.fn().mockResolvedValue(undefined);
        JC.pluginConfig = { DisableAllShortcuts: false };
        JC.t = (key: string) => ({
            status_disabled: 'Disabled', shortcut_enable: 'Enable', shortcut_disable: 'Disable',
        })[key] || key;
        const editor: PanelEditorContext = {
            mode: 'self', actor, targetUserId: actor.userId, targetDisplayName: '', appliesToActor: true,
            settings: {}, shortcuts, activeShortcuts,
            isCurrent: () => JC.identity.isCurrent(actor), saveSettings: save, saveShortcuts: save,
        };
        wireShortcutEditor({
            help, editor, pluginShortcuts: [{ Name: 'play', Key: 'P' }],
            primaryAccentColor: '#0ff', kbdBackground: '#111', identityContext: actor, trackTimer,
        } as unknown as PanelContext);

        help.querySelector<HTMLButtonElement>('.shortcut-state-button')!.click();

        expect(shortcuts.Shortcuts).toEqual([
            { Name: 'play', Key: '', FutureMetadata: { owner: 'last' } },
        ]);
        await vi.waitFor(() => expect(activeShortcuts.play).toBe(''));
        expect(help.querySelector('.shortcut-key')!.textContent).toBe('Disabled');
        expect(help.querySelector('.shortcut-key')!.classList.contains('shortcut-disabled')).toBe(true);
        expect(help.querySelector('.shortcut-key')!.getAttribute('aria-label')).toBe('Play: Disabled');
        expect(help.querySelector<HTMLButtonElement>('.shortcut-state-button')).toMatchObject({
            textContent: 'Enable', disabled: true,
        });
        expect(help.querySelector<HTMLButtonElement>('.shortcut-state-button')!.dataset.operation).toBe('enable');
        expect(help.querySelector<HTMLButtonElement>('.shortcut-state-button')!.getAttribute('aria-label'))
            .toBe('Enable: Play');
        expect(help.querySelector<HTMLButtonElement>('.shortcut-reset-button')!.disabled).toBe(false);
    });

    it('resets a disabled override to the current admin value', async () => {
        JC.identity.transition('server-a', 'user-a', 'shortcut-reset');
        const actor = JC.identity.capture()!;
        const help = document.createElement('div');
        help.innerHTML = `
            <div class="jc-shortcut-row">
                <span class="shortcut-key shortcut-disabled" tabindex="0" data-action="play" data-label="Play">Disabled</span>
                <span><span class="modified-indicator">•</span>Play</span>
                <button class="shortcut-state-button" data-action="play" data-operation="enable" disabled>Enabled</button>
                <button class="shortcut-reset-button" data-action="play">Reset</button>
            </div>`;
        const shortcuts = { Shortcuts: [{ Name: 'play', Key: '' }] };
        const activeShortcuts = { play: '' };
        const save = vi.fn().mockResolvedValue(undefined);
        JC.pluginConfig = { DisableAllShortcuts: false };
        JC.t = (key: string) => ({
            status_disabled: 'Disabled', shortcut_enable: 'Enable', shortcut_disable: 'Disable',
        })[key] || key;
        const editor: PanelEditorContext = {
            mode: 'self', actor, targetUserId: actor.userId, targetDisplayName: '', appliesToActor: true,
            settings: {}, shortcuts, activeShortcuts,
            isCurrent: () => JC.identity.isCurrent(actor), saveSettings: save, saveShortcuts: save,
        };
        wireShortcutEditor({
            help, editor, pluginShortcuts: [{ Name: 'play', Key: 'Ctrl+P' }],
            primaryAccentColor: '#0ff', kbdBackground: '#111', identityContext: actor, trackTimer,
        } as unknown as PanelContext);

        help.querySelector<HTMLButtonElement>('.shortcut-reset-button')!.click();

        expect(shortcuts.Shortcuts).toEqual([]);
        await vi.waitFor(() => expect(activeShortcuts.play).toBe('Ctrl+P'));
        expect(help.querySelector('.shortcut-key')!.getAttribute('aria-label')).toBe('Play: Ctrl+P');
        expect(help.querySelector<HTMLButtonElement>('.shortcut-state-button')).toMatchObject({
            textContent: 'Disable', disabled: false,
        });
        expect(help.querySelector<HTMLButtonElement>('.shortcut-state-button')!.dataset.operation).toBe('disable');
        expect(help.querySelector<HTMLButtonElement>('.shortcut-state-button')!.getAttribute('aria-label'))
            .toBe('Disable: Play');
        expect(help.querySelector('.modified-indicator')).toBeNull();
        expect(help.querySelector<HTMLButtonElement>('.shortcut-reset-button')!.disabled).toBe(true);
    });

    it('keeps the percentage group static and rejects enabling it across a bare-digit binding', () => {
        vi.useFakeTimers();
        JC.identity.transition('server-a', 'user-a', 'shortcut-group-conflict');
        const actor = JC.identity.capture()!;
        const help = document.createElement('div');
        help.innerHTML = `
            <div class="jc-shortcut-row">
                <span class="shortcut-key shortcut-group-key shortcut-disabled" data-action="JumpToPercentage">Disabled</span>
                <span>Jump</span>
                <button class="shortcut-state-button" data-action="JumpToPercentage" data-operation="enable">Enabled</button>
                <button class="shortcut-reset-button" data-action="JumpToPercentage" disabled>Reset</button>
            </div>`;
        const shortcuts = { Shortcuts: [] as Array<{ Name: string; Key: string }> };
        const activeShortcuts = { JumpToPercentage: '', Other: '5' };
        const save = vi.fn().mockResolvedValue(undefined);
        JC.pluginConfig = { DisableAllShortcuts: false };
        const editor: PanelEditorContext = {
            mode: 'self', actor, targetUserId: actor.userId, targetDisplayName: '', appliesToActor: true,
            settings: {}, shortcuts, activeShortcuts,
            isCurrent: () => JC.identity.isCurrent(actor), saveSettings: save, saveShortcuts: save,
        };
        wireShortcutEditor({
            help, editor,
            pluginShortcuts: [{ Name: 'JumpToPercentage', Key: '0-9' }, { Name: 'Other', Key: '5' }],
            primaryAccentColor: '#0ff', kbdBackground: '#111', identityContext: actor, trackTimer,
        } as unknown as PanelContext);

        const groupKey = help.querySelector<HTMLElement>('.shortcut-group-key')!;
        groupKey.dispatchEvent(new KeyboardEvent('keydown', { key: 'X', bubbles: true }));
        help.querySelector<HTMLButtonElement>('.shortcut-state-button')!.click();

        expect(groupKey.classList.contains('shake-error')).toBe(true);
        expect(shortcuts.Shortcuts).toEqual([]);
        expect(save).not.toHaveBeenCalled();
    });

    it('re-enables the percentage group over an admin-disabled value when only modified digits exist', async () => {
        JC.identity.transition('server-a', 'user-a', 'shortcut-group-enable');
        const actor = JC.identity.capture()!;
        const help = document.createElement('div');
        help.innerHTML = `
            <div class="jc-shortcut-row">
                <span class="shortcut-key shortcut-group-key shortcut-disabled" data-action="JumpToPercentage">Disabled</span>
                <span>Jump</span>
                <button class="shortcut-state-button" data-action="JumpToPercentage" data-operation="enable">Enabled</button>
                <button class="shortcut-reset-button" data-action="JumpToPercentage" disabled>Reset</button>
            </div>`;
        const shortcuts = { Shortcuts: [] as Array<{ Name: string; Key: string }> };
        const activeShortcuts = { JumpToPercentage: '', Other: 'Ctrl+5' };
        const save = vi.fn().mockResolvedValue(undefined);
        JC.pluginConfig = { DisableAllShortcuts: false };
        JC.t = (key: string) => ({ status_disabled: 'Disabled', status_enabled: 'Enabled' })[key] || key;
        const editor: PanelEditorContext = {
            mode: 'self', actor, targetUserId: actor.userId, targetDisplayName: '', appliesToActor: true,
            settings: {}, shortcuts, activeShortcuts,
            isCurrent: () => JC.identity.isCurrent(actor), saveSettings: save, saveShortcuts: save,
        };
        wireShortcutEditor({
            help, editor,
            pluginShortcuts: [{ Name: 'JumpToPercentage', Key: '' }, { Name: 'Other', Key: 'Ctrl+5' }],
            primaryAccentColor: '#0ff', kbdBackground: '#111', identityContext: actor, trackTimer,
        } as unknown as PanelContext);

        help.querySelector<HTMLButtonElement>('.shortcut-state-button')!.click();

        // pluginShortcuts is the effective admin tier; enabling always writes
        // the reserved user sentinel, even when that tier is disabled.
        expect(shortcuts.Shortcuts).toEqual([{ Name: 'JumpToPercentage', Key: '0-9' }]);
        await vi.waitFor(() => expect(activeShortcuts.JumpToPercentage).toBe('0-9'));
    });

    it('updates only an admin-target editor map when disabling a shortcut', async () => {
        JC.identity.transition('server-a', 'admin-a', 'shortcut-target-disable');
        const actor = JC.identity.capture()!;
        const help = document.createElement('div');
        help.innerHTML = `
            <div class="jc-shortcut-row">
                <span class="shortcut-key" data-action="play">P</span><span>Play</span>
                <button class="shortcut-state-button" data-action="play" data-operation="disable">Disabled</button>
                <button class="shortcut-reset-button" data-action="play" disabled>Reset</button>
            </div>`;
        const targetShortcuts = { Shortcuts: [] as Array<{ Name: string; Key: string }> };
        const targetActive = { play: 'P' };
        const actorActive = { play: 'A' };
        JC.state = { activeShortcuts: actorActive } as unknown as NonNullable<typeof JC.state>;
        JC.pluginConfig = { DisableAllShortcuts: false };
        const save = vi.fn().mockResolvedValue(undefined);
        const editor: PanelEditorContext = {
            mode: 'admin-target', actor, targetUserId: 'target', targetDisplayName: 'Target', appliesToActor: false,
            settings: {}, shortcuts: targetShortcuts, activeShortcuts: targetActive,
            isCurrent: () => JC.identity.isCurrent(actor), saveSettings: save, saveShortcuts: save,
        };
        wireShortcutEditor({
            help, editor, pluginShortcuts: [{ Name: 'play', Key: 'P' }],
            primaryAccentColor: '#0ff', kbdBackground: '#111', identityContext: actor, trackTimer,
        } as unknown as PanelContext);

        help.querySelector<HTMLButtonElement>('.shortcut-state-button')!.click();

        await vi.waitFor(() => expect(targetActive.play).toBe(''));
        expect(actorActive.play).toBe('A');
        expect(JC.state.activeShortcuts).toBe(actorActive);
    });
});
