export type OfficialJellyfinThemeMode = 'dark' | 'light';

// Keep the six values needed at runtime independent from the larger audit
// manifest. Tests prove this map remains identical to the pinned, machine-
// readable Jellyfin Web contract without shipping its hashes/inventory in the
// authenticated browser closure.
const BUILT_IN_THEME_MODES: Readonly<Record<string, OfficialJellyfinThemeMode>> = Object.freeze({
    appletv: 'light',
    blueradiance: 'dark',
    dark: 'dark',
    light: 'light',
    purplehaze: 'dark',
    wmc: 'dark',
});

/** Exact built-in Jellyfin 12 theme mode; future or custom ids remain caller-owned. */
export function officialJellyfinThemeMode(themeId: string): OfficialJellyfinThemeMode | null {
    return BUILT_IN_THEME_MODES[themeId.trim().toLowerCase()] ?? null;
}
