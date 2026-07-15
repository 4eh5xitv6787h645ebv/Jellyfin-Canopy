// Canonical keyboard-shortcut codec shared by capture, persistence, display,
// conflict detection, and dispatch. Persisted modifiers always use this order;
// aliases and legacy permutations normalize to the same semantic binding.

const MODIFIER_ORDER = ['Meta', 'Ctrl', 'Alt', 'Shift'] as const;
type Modifier = typeof MODIFIER_ORDER[number];

const MODIFIER_ALIASES: Readonly<Record<string, Modifier>> = {
    meta: 'Meta',
    cmd: 'Meta',
    command: 'Meta',
    os: 'Meta',
    super: 'Meta',
    win: 'Meta',
    windows: 'Meta',
    ctrl: 'Ctrl',
    control: 'Ctrl',
    alt: 'Alt',
    option: 'Alt',
    shift: 'Shift',
};

const NAMED_KEYS: Readonly<Record<string, string>> = {
    altgraph: 'AltGraph',
    arrowdown: 'ArrowDown',
    arrowleft: 'ArrowLeft',
    arrowright: 'ArrowRight',
    arrowup: 'ArrowUp',
    backspace: 'Backspace',
    browserback: 'BrowserBack',
    browserfavorites: 'BrowserFavorites',
    browserforward: 'BrowserForward',
    browserhome: 'BrowserHome',
    browserrefresh: 'BrowserRefresh',
    browsersearch: 'BrowserSearch',
    browserstop: 'BrowserStop',
    capslock: 'CapsLock',
    clear: 'Clear',
    contextmenu: 'ContextMenu',
    dead: 'Dead',
    delete: 'Delete',
    end: 'End',
    enter: 'Enter',
    escape: 'Escape',
    esc: 'Escape',
    execute: 'Execute',
    help: 'Help',
    home: 'Home',
    insert: 'Insert',
    launchapplication1: 'LaunchApplication1',
    launchapplication2: 'LaunchApplication2',
    launchmail: 'LaunchMail',
    mediapause: 'MediaPause',
    mediaplay: 'MediaPlay',
    mediaplaypause: 'MediaPlayPause',
    mediastop: 'MediaStop',
    mediatracknext: 'MediaTrackNext',
    mediatrackprevious: 'MediaTrackPrevious',
    numlock: 'NumLock',
    pagedown: 'PageDown',
    pageup: 'PageUp',
    pause: 'Pause',
    printscreen: 'PrintScreen',
    scrolllock: 'ScrollLock',
    select: 'Select',
    space: 'Space',
    spacebar: 'Space',
    tab: 'Tab',
    unidentified: 'Unidentified',
    audiovolumedown: 'AudioVolumeDown',
    audiovolumemute: 'AudioVolumeMute',
    audiovolumeup: 'AudioVolumeUp',
    zoomin: 'ZoomIn',
    zoomout: 'ZoomOut',
};

export interface ShortcutEntryLike {
    Key?: unknown;
    [key: string]: unknown;
}

export interface ShortcutKeyboardEvent {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
}

function modifierFor(token: string): Modifier | undefined {
    return MODIFIER_ALIASES[token.trim().toLowerCase()];
}

function canonicalKey(rawKey: string): string {
    if (rawKey === ' ') return 'Space';
    const key = rawKey.trim();
    if (!key) return '';
    if (key === '+') return '+';
    if ([...key].length === 1) return /^[a-z]$/i.test(key) ? key.toUpperCase() : key;
    const functionKey = key.match(/^f([1-9]|1[0-9]|2[0-4])$/i);
    if (functionKey) return `F${functionKey[1]}`;
    return NAMED_KEYS[key.toLowerCase()] || key.toLowerCase();
}

function serialize(modifiers: ReadonlySet<Modifier>, key: string): string {
    return [...MODIFIER_ORDER.filter(modifier => modifiers.has(modifier)), key].join('+');
}

function keyAlreadyEncodesShift(key: string): boolean {
    return [...key].length === 1 && !/[\p{L}\p{N}]/u.test(key) && key !== ' ';
}

/** Convert any supported persisted spelling/order into one stable wire/display value. */
export function canonicalizeShortcut(value: unknown): string {
    if (typeof value !== 'string') return '';
    if (value === ' ') return 'Space';
    // The legacy editor concatenated KeyboardEvent.key directly, so a
    // modified Space was persisted as (for example) `Ctrl+ `. Preserve that
    // trailing literal key without confusing a whitespace-padded `Ctrl++`.
    const legacySpacePrefix = value.endsWith('+ ') ? value.slice(0, -1) : '';
    const legacySpaceTokens = legacySpacePrefix.endsWith('+')
        ? legacySpacePrefix.slice(0, -1).split('+').map(token => token.trim())
        : [];
    const hasLegacySpaceKey = legacySpaceTokens.length > 0
        && legacySpaceTokens.every(token => token !== '' && modifierFor(token) !== undefined);
    const source = hasLegacySpaceKey ? `${legacySpacePrefix}Space` : value.trim();
    if (!source) return '';

    let tokens: string[];
    if (source.endsWith('+')) {
        tokens = source.slice(0, -1).split('+').map(token => token.trim()).filter(Boolean);
        tokens.push('+');
    } else {
        tokens = source.split('+').map(token => token.trim()).filter(Boolean);
    }

    const modifiers = new Set<Modifier>();
    const keys: string[] = [];
    for (const token of tokens) {
        const modifier = modifierFor(token);
        if (modifier) modifiers.add(modifier);
        else keys.push(token);
    }
    if (keys.length !== 1) return '';
    const key = canonicalKey(keys[0]);
    if (keyAlreadyEncodesShift(key)) modifiers.delete('Shift');
    return key ? serialize(modifiers, key) : '';
}

/** Canonicalize a physical event without depending on the event's modifier-key order. */
export function shortcutFromEvent(event: ShortcutKeyboardEvent): string {
    if (modifierFor(event.key)) return '';
    const key = canonicalKey(event.key);
    if (!key) return '';
    const modifiers = new Set<Modifier>();
    if (event.metaKey) modifiers.add('Meta');
    if (event.ctrlKey) modifiers.add('Ctrl');
    if (event.altKey) modifiers.add('Alt');
    // Printable punctuation already identifies the shifted glyph (`+`, `?`,
    // `<`, ...). Retaining Shift as a second semantic modifier would make the
    // built-in `+` shortcut impossible to trigger on ordinary keyboards.
    if (event.shiftKey && !keyAlreadyEncodesShift(event.key)) modifiers.add('Shift');
    return serialize(modifiers, key);
}

/** Empty/invalid bindings never conflict; every valid permutation compares semantically. */
export function shortcutsEqual(left: unknown, right: unknown): boolean {
    const canonicalLeft = canonicalizeShortcut(left);
    return canonicalLeft !== '' && canonicalLeft === canonicalizeShortcut(right);
}

/** Display uses the same representation that persistence and dispatch consume. */
export function formatShortcut(value: unknown): string {
    return canonicalizeShortcut(value);
}

/** Normalize a loaded payload in place so its next save migrates legacy values. */
export function normalizeShortcutEntries(entries: unknown): boolean {
    if (!Array.isArray(entries)) return false;
    let changed = false;
    for (const candidate of entries) {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
        const entry = candidate as ShortcutEntryLike;
        if (typeof entry.Key !== 'string') continue;
        const normalized = canonicalizeShortcut(entry.Key);
        if (normalized && normalized !== entry.Key) {
            entry.Key = normalized;
            changed = true;
        }
    }
    return changed;
}
