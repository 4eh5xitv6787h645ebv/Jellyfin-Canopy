// src/arr/arr-globals.ts
//
// Typed view of the shared JE global for the arr area. The base JEGlobal
// contract (src/types/je.ts) only types the core surface; the arr modules
// also touch legacy feature surfaces (translations, helpers, hidden-content
// filtering, ...) and own a few public members of their own
// (JE.initializeArrLinksScript, JE.downloadsPage, JE.calendarPage, ...).
// This module widens the '../globals' export with exactly those members so
// the converted arr modules stay fully typed without editing the frozen
// core contract. Everything here refers to the SAME runtime object.

import { JE as JEBase } from '../globals';
import type { JEGlobal, ObserverProxy, PluginConfig, UserSettings } from '../types/je';

/** One entry of the SonarrInstances / RadarrInstances config arrays. */
export interface ArrInstanceConfig {
    Name?: string;
    Url?: string;
    UrlMappings?: string;
    Enabled?: boolean;
}

/** The plugin-config keys the arr modules read, typed. */
export interface ArrPluginConfig extends PluginConfig {
    ArrLinksEnabled?: boolean;
    ArrLinksShowStatusSingle?: boolean;
    ShowArrLinksAsText?: boolean;
    SonarrInstancesCorrupt?: boolean;
    RadarrInstancesCorrupt?: boolean;
    SonarrInstances?: ArrInstanceConfig[];
    RadarrInstances?: ArrInstanceConfig[];
    SonarrUrl?: string;
    SonarrUrlMappings?: string;
    RadarrUrl?: string;
    RadarrUrlMappings?: string;
    BazarrUrl?: string;
    BazarrUrlMappings?: string;
}

/** The per-user settings keys the arr modules read/write, typed. */
export interface ArrUserSettings extends UserSettings {
    isAdmin?: boolean;
    calendarDefaultViewMode?: string;
    calendarDisplayMode?: string;
}

/** Minimal shape of a Jellyfin user object (admin check in arr-links). */
export interface JellyfinUser {
    Policy?: { IsAdministrator?: boolean };
}

/** Minimal shape of a Jellyfin library item as the arr modules read it. */
export interface JellyfinItem {
    Type?: string;
    Name?: string;
    Tags?: string[];
    ProviderIds?: Record<string, string | undefined>;
}

/** Options accepted by the helpers.js createExternalLink helper. */
export interface ExternalLinkOptions {
    text?: string;
    title?: string;
    className?: string;
}

/**
 * Legacy helper surface (js/enhanced/helpers.js) the arr modules call.
 * Optional members: helpers.js still lives in the legacy half of the bundle
 * and loads after src/, so anything touched at module-eval time must keep
 * its runtime fallback.
 */
export interface ArrLegacyHelpers {
    getItemCached?: (itemId: string) => Promise<unknown>;
    escHtml?: (s: unknown) => string;
    createExternalLink?: (url: string, options?: ExternalLinkOptions) => HTMLAnchorElement;
    createObserver?: (
        id: string,
        callback: MutationCallback,
        target: Node,
        config: MutationObserverInit
    ) => MutationObserver | ObserverProxy;
    onNavigate?: (callback: () => void) => () => void;
    [key: string]: unknown;
}

/** Theme variables as arr modules consume them (adds textColor). */
export interface ArrThemeVariables {
    secondaryBg?: string;
    primaryAccent?: string;
    blur?: string;
    textColor?: string;
}

/** The JE global as seen from the arr area. */
export interface ArrJE extends JEGlobal {
    pluginConfig: ArrPluginConfig;
    currentSettings?: ArrUserSettings;
    helpers?: ArrLegacyHelpers;
    themer?: {
        getThemeVariables?: () => ArrThemeVariables;
        [key: string]: unknown;
    };
    /** Translation lookup (js/enhanced/translations.js — loaded before the bundle). */
    t?: (key: string) => string;
    /** Full user object pre-fetched by js/plugin.js during init (Stage 2). */
    currentUser?: JellyfinUser | null;
    loadSettings?(): ArrUserSettings;
    saveUserSettings?(file: string, settings: unknown): Promise<unknown>;
    /** Hidden-content filtering surface (js/enhanced/hidden-content-*). */
    hiddenContent?: {
        filterRequestItems?<T>(items: T[]): T[];
        filterCalendarEvents?<T>(events: T[]): T[];
        [key: string]: unknown;
    };

    // ── Public surfaces OWNED by the arr area (frozen contracts: js/plugin.js
    //    Stage 6 and the PluginPages HTML files call these by name) ──────────
    initializeArrLinksScript?: () => Promise<void>;
    _arrLinksObserver?: MutationObserver | ObserverProxy | null;
}

/**
 * The shared window.JellyfinEnhanced namespace, widened for the arr area.
 * Same object as '../globals' JE — only the compile-time view differs.
 */
export const JE: ArrJE = JEBase;
