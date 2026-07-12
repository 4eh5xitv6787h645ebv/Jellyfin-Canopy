// src/facade.ts
//
// The single typed home for the STABLE, FROZEN public surface of
// window.JellyfinCanopy — the members that external consumers depend on and
// that therefore must never be removed or renamed:
//
//   - user scripts (third-party snippets people paste into their server) read
//     JC.core.*, JC.t, JC.toast, JC.pluginConfig, JC.currentSettings, etc.
//   - Configuration/config-page.js drives JC.customPlugins.refresh() and mirrors
//     JC.toast semantics.
//   - automation / E2E waits on JC.initialized.
//   - the out-of-band bootstrap loaders (src/bootstrap/*) attach the splash /
//     login-image / translations entry points read by js/plugin.js.
//
// This is documentation-as-types, not a narrowing: JEGlobal (src/types/jc.ts)
// EXTENDS this interface, so the compiler proves the live namespace always
// carries the frozen surface, while JEGlobal remains free to expose additional
// (internal, still-typed-incrementally) members on top. Removing or renaming
// any member here is a breaking change to the public contract.

import type { JECore, PluginConfig, UserSettings } from './types/jc';

/**
 * The frozen public API of window.JellyfinCanopy. Signatures here MUST match
 * the corresponding JEGlobal members exactly (JEGlobal extends this interface).
 */
export interface JellyfinCanopyPublicApi {
    /** Shared core layer: navigation, lifecycle, dom, ui, api, tagRenderer. */
    core: JECore;
    /** Admin plugin configuration (public-config + private-config for admins). */
    pluginConfig: PluginConfig;
    /** Per-user resolved settings (camelCased by the loader). */
    currentSettings?: UserSettings;
    /** Active translation table (key -> localized string). */
    translations: Record<string, string>;
    /** Plugin version string (cache-buster + display). */
    pluginVersion: string;
    /** Boot-complete marker: true once every enabled feature has initialized. */
    initialized?: boolean;
    /** Escapes HTML special characters for safe interpolation. */
    escapeHtml: (value: unknown) => string;
    /** Translation lookup — returns the key itself when no translation exists. */
    t?: (key: string, params?: Record<string, unknown>) => string;
    /** Shows a transient toast notification. */
    toast?: (html: string, duration?: number) => void;
    /** Custom sidebar plugin links (config-page.js calls .refresh() to preview). */
    customPlugins?: { refresh: () => void };

    // ── Out-of-band bootstrap surfaces (src/bootstrap/*) ────────────────────
    /** splashscreen: builds/shows the boot splash. */
    initializeSplashScreen?: () => void;
    /** splashscreen: hides the boot splash. */
    hideSplashScreen?: () => void;
    /** login-image: wires the login-page profile-image behaviour. */
    initializeLoginImage?: () => void;
    /** translations: loads the active language table (GitHub + bundled fallback). */
    loadTranslations?: () => Promise<Record<string, string>>;
}
