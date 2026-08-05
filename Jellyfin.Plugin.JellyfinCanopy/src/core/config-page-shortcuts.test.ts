import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';

const TEST_FILE_PATH = decodeURIComponent(new URL(import.meta.url).pathname);
const SRC_ROOT = TEST_FILE_PATH.replace(/\/core\/[^/]+$/, '/');
const CONFIG_PAGE_JS = SRC_ROOT.replace(/src\/$/, 'Configuration/config-page.js');
const CONFIG_PAGE_HTML = SRC_ROOT.replace(/src\/$/, 'Configuration/configPage.html');

function read(path: string): string {
    const source = ts.sys.readFile(path);
    expect(source, `missing source: ${path}`).toBeTruthy();
    return source!;
}

function productionFunction(source: string, name: string): string {
    const match = source.match(new RegExp(
        `^ {8}function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^ {8}\\}`,
        'm',
    ));
    expect(match, `missing production helper: ${name}`).toBeTruthy();
    return match![0];
}

interface Shortcut {
    Name: string;
    Key: string;
    Label?: string;
    [key: string]: unknown;
}

interface Helpers {
    normalize(value: unknown): string;
    conflict(left: unknown, right: unknown): boolean;
    effective(defaults: Shortcut[], overrides: Shortcut[]): Shortcut[];
    setOverride(overrides: Shortcut[], defaults: Shortcut[], action: string, binding: string | null): Shortcut[];
    findConflict(defaults: Shortcut[], overrides: Shortcut[], action: string, binding: string): Shortcut | undefined;
    merge(defaults: Shortcut[], overrides: Shortcut[], persisted: Shortcut[]): Shortcut[];
}

function loadHelpers(source: string): Helpers {
    const names = [
        'jcNormalizeAdminShortcut',
        'jcAdminShortcutBindingsConflict',
        'jcAdminEffectiveShortcuts',
        'jcSetAdminShortcutOverride',
        'jcAdminShortcutConflict',
        'jcMergeAdminShortcutRows',
    ];
    // Execute only closed helpers extracted from checked-in production source.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const factory = new Function([
        ...names.map(name => productionFunction(source, name)),
        `return {
            normalize: jcNormalizeAdminShortcut,
            conflict: jcAdminShortcutBindingsConflict,
            effective: jcAdminEffectiveShortcuts,
            setOverride: jcSetAdminShortcutOverride,
            findConflict: jcAdminShortcutConflict,
            merge: jcMergeAdminShortcutRows
        };`,
    ].join('\n')) as () => Helpers;
    return factory();
}

describe('admin shortcut configuration contract', () => {
    const js = read(CONFIG_PAGE_JS);
    const html = read(CONFIG_PAGE_HTML);
    const helpers = loadHelpers(js);
    const defaults: Shortcut[] = [
        { Name: 'Play', Key: 'P', Label: 'Play' },
        { Name: 'JumpToPercentage', Key: '0-9', Label: 'Jump' },
    ];

    it('renders the full action list with deliberate Disable and Reset semantics', () => {
        expect(js).toContain('jcAdminEffectiveShortcuts(defaultShortcuts, shortcutOverrides)');
        expect(js).toContain("shortcut.Name === 'JumpToPercentage'");
        expect(js).toContain("stateBtn.textContent = isDisabled && isGroup ? 'Enable' : 'Disable'");
        expect(js).toContain("resetBtn.textContent = 'Reset'");
        expect(html).toContain('Clearing a text field does not disable an action');
    });

    it('normalizes modifiers and reserves only bare digits for the group', () => {
        expect(helpers.normalize('shift+ctrl+k')).toBe('Ctrl+Shift+K');
        expect(helpers.normalize('ctrl+ ')).toBe('Ctrl+Space');
        expect(helpers.conflict('0-9', '5')).toBe(true);
        expect(helpers.conflict('0-9', 'Ctrl+5')).toBe(false);
        expect(helpers.conflict('', '5')).toBe(false);
    });

    it('calculates conflicts from the effective map rather than disabled defaults', () => {
        expect(helpers.findConflict(defaults, [], 'Play', '5')?.Name).toBe('JumpToPercentage');
        const disabledGroup = [{ Name: 'JumpToPercentage', Key: '', Label: 'Jump' }];
        expect(helpers.findConflict(defaults, disabledGroup, 'Play', '5')).toBeUndefined();
        expect(helpers.findConflict(defaults, [], 'Play', 'Ctrl+5')).toBeUndefined();
    });

    it('uses one last-wins override and Reset removes every duplicate', () => {
        const duplicates = [
            { Name: 'Play', Key: 'X', Earlier: true },
            { Name: 'Play', Key: 'Y', Future: { owner: 'last' } },
        ];
        expect(helpers.setOverride(duplicates, defaults, 'Play', '')).toEqual([
            { Name: 'Play', Key: '', Label: 'Play', Future: { owner: 'last' } },
        ]);
        expect(helpers.setOverride(duplicates, defaults, 'Play', null)).toEqual([]);
    });

    it('persists empty keys while preserving known and unknown row metadata', () => {
        const persisted = [
            { Name: 'Play', Key: 'P', Future: { exact: 9007199254740993n.toString() } },
            { Name: 'FutureAction', Key: '', Opaque: { keep: true } },
        ];
        const overrides = [
            { Name: 'Play', Key: '', Label: 'Play' },
            { Name: 'FutureAction', Key: '', Opaque: { keep: true } },
        ];

        expect(helpers.merge(defaults, overrides, persisted)).toEqual([
            {
                Name: 'Play', Key: '', Label: 'Play',
                Future: { exact: '9007199254740993' },
            },
            { Name: 'JumpToPercentage', Key: '0-9', Label: 'Jump' },
            { Name: 'FutureAction', Key: '', Opaque: { keep: true } },
        ]);
    });

    it('preserves JavaScript prototype names as ordinary shortcut rows', () => {
        const poisonNames = ['__proto__', 'constructor', 'toString'];
        const poisonDefaults = poisonNames.map(Name => ({ Name, Key: 'P', Label: Name }));
        const overrides = poisonNames.map(Name => ({ Name, Key: '', Opaque: { Name } }));
        const persisted = poisonNames.map(Name => ({ Name, Key: 'X', Future: { Name } }));

        expect(helpers.effective(poisonDefaults, overrides)).toEqual(
            poisonNames.map(Name => ({ Name, Key: '', Label: Name, Opaque: { Name } })),
        );
        expect(helpers.merge(poisonDefaults, overrides, persisted)).toEqual(
            poisonNames.map(Name => ({
                Name,
                Key: '',
                Label: Name,
                Future: { Name },
                Opaque: { Name },
            })),
        );
        expect(helpers.effective([], overrides).map(row => row.Name)).toEqual(poisonNames);
    });
});
