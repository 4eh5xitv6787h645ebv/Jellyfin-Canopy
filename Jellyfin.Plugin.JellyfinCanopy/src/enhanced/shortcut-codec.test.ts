import { describe, expect, it } from 'vitest';
import {
    canonicalizeShortcut,
    formatShortcut,
    normalizeShortcutEntries,
    shortcutFromEvent,
    shortcutsEqual,
} from './shortcut-codec';

const MODIFIERS = ['Meta', 'Ctrl', 'Alt', 'Shift'] as const;

function permutations(values: readonly string[]): string[][] {
    if (values.length <= 1) return [Array.from(values)];
    return values.flatMap((value, index) => permutations([
        ...values.slice(0, index),
        ...values.slice(index + 1),
    ]).map(rest => [value, ...rest]));
}

describe('canonical shortcut codec', () => {
    it('normalizes every modifier pair, triple, and quad permutation and casing', () => {
        for (let mask = 0; mask < (1 << MODIFIERS.length); mask += 1) {
            const selected = MODIFIERS.filter((_modifier, index) => (mask & (1 << index)) !== 0);
            if (selected.length < 2) continue;
            const canonical = `${MODIFIERS.filter(modifier => selected.includes(modifier)).join('+')}+K`;
            for (const permutation of permutations(selected)) {
                const legacy = `${permutation.map(modifier => modifier.toLowerCase()).join('+')}+k`;
                expect(canonicalizeShortcut(legacy)).toBe(canonical);
            }
            expect(shortcutFromEvent({
                key: 'k',
                metaKey: selected.includes('Meta'),
                ctrlKey: selected.includes('Ctrl'),
                altKey: selected.includes('Alt'),
                shiftKey: selected.includes('Shift'),
            })).toBe(canonical);
        }
    });

    it('preserves Meta semantics while accepting Cmd/Command legacy spellings', () => {
        expect(canonicalizeShortcut('cmd+shift+k')).toBe('Meta+Shift+K');
        expect(canonicalizeShortcut('Control+Command+Option+k')).toBe('Meta+Ctrl+Alt+K');
        expect(shortcutsEqual('Meta+Ctrl+K', 'ctrl+CMD+k')).toBe(true);
        expect(shortcutsEqual('Meta+K', 'Ctrl+K')).toBe(false);
    });

    it.each([
        ['h', 'H'],
        ['shift+h', 'Shift+H'],
        ['/', '/'],
        ['+', '+'],
        ['ctrl++', 'Ctrl++'],
        ['ctrl+shift++', 'Ctrl++'],
        ['-', '-'],
        [',', ','],
        ['.', '.'],
        ['arrowleft', 'ArrowLeft'],
        ['ESC', 'Escape'],
        [' ', 'Space'],
        ['ctrl+ ', 'Ctrl+Space'],
        ['ctrl+shift+ ', 'Ctrl+Shift+Space'],
        ['ctrl++ ', 'Ctrl++'],
        ['f12', 'F12'],
        ['ß', 'ß'],
    ])('keeps single-modifier and special key %j compatible', (stored, expected) => {
        expect(canonicalizeShortcut(stored)).toBe(expected);
        expect(formatShortcut(stored)).toBe(expected);
        expect(canonicalizeShortcut(expected)).toBe(expected);
    });

    it('treats Shift used to type a punctuation glyph as part of that key', () => {
        expect(shortcutFromEvent({
            key: '+', metaKey: false, ctrlKey: false, altKey: false, shiftKey: true,
        })).toBe('+');
        expect(shortcutFromEvent({
            key: '+', metaKey: false, ctrlKey: true, altKey: false, shiftKey: true,
        })).toBe('Ctrl++');
        expect(shortcutFromEvent({
            key: 'ArrowUp', metaKey: false, ctrlKey: false, altKey: false, shiftKey: true,
        })).toBe('Shift+ArrowUp');
    });

    it('rejects modifier-only and ambiguous bindings', () => {
        expect(canonicalizeShortcut('Shift')).toBe('');
        expect(canonicalizeShortcut('Ctrl+Alt')).toBe('');
        expect(canonicalizeShortcut('A+B')).toBe('');
        expect(shortcutFromEvent({ key: 'Meta', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false })).toBe('');
    });

    it('matches legacy modified-Space persistence to the physical event', () => {
        const event = shortcutFromEvent({
            key: ' ', metaKey: false, ctrlKey: true, altKey: false, shiftKey: true,
        });
        expect(event).toBe('Ctrl+Shift+Space');
        expect(shortcutsEqual('shift+ctrl+ ', event)).toBe(true);
    });

    it('normalizes loaded entries deterministically without changing unrelated fields', () => {
        const entries = [
            { Name: 'First', Key: 'shift+CTRL+k', Label: 'First' },
            { Name: 'Second', Key: 'cmd+alt+ArrowLeft', Extra: true },
            { Name: 'Empty', Key: '' },
        ];
        expect(normalizeShortcutEntries(entries)).toBe(true);
        expect(entries).toEqual([
            { Name: 'First', Key: 'Ctrl+Shift+K', Label: 'First' },
            { Name: 'Second', Key: 'Meta+Alt+ArrowLeft', Extra: true },
            { Name: 'Empty', Key: '' },
        ]);
        expect(normalizeShortcutEntries(entries)).toBe(false);
    });

    it('detects duplicate semantic bindings independent of legacy spelling', () => {
        expect(shortcutsEqual('Ctrl+Shift+K', 'shift+ctrl+k')).toBe(true);
        expect(shortcutsEqual('Ctrl+K', 'Ctrl+Shift+K')).toBe(false);
        expect(shortcutsEqual('', '')).toBe(false);
    });
});
