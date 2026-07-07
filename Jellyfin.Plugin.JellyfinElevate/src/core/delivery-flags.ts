// src/core/delivery-flags.ts
//
// Single source of truth for zeroing the delivery-plugin flags when the Custom
// Tabs / Plugin Pages delivery plugins are not installed. Settings persist after
// a delivery plugin is uninstalled, so the server still reports stale `true`
// flags; leaving them set makes sidebar/nav re-injection bail (INIT-1).
//
// js/plugin.js does the same zeroing inline at boot (it runs before the bundle
// is guaranteed loaded and cannot import this module — see the load-order note in
// settings-config-resolution.md) and caches the installed state on JE. This
// module re-applies the sanitization on the bundle side, notably after every
// live-config merge so a hot-reload cannot resurface the stale flags.

import { JE } from '../globals';

/** Installed state of the two delivery plugins, cached on JE by js/plugin.js at boot. */
export interface DeliveryPluginsInstalled {
    customTabs: boolean;
    pluginPages: boolean;
}

const CUSTOM_TABS_FLAGS = [
    'BookmarksUseCustomTabs', 'CalendarUseCustomTabs',
    'HiddenContentUseCustomTabs', 'DownloadsUseCustomTabs',
] as const;

const PLUGIN_PAGES_FLAGS = [
    'BookmarksUsePluginPages', 'HiddenContentUsePluginPages',
    'DownloadsUsePluginPages', 'CalendarUsePluginPages',
] as const;

/**
 * Force the delivery flags to false for any delivery plugin that is not
 * installed. Pure — mutates only the passed config object.
 * @param config The plugin config object to sanitize (no-op when falsy).
 * @param installed Which delivery plugins are installed.
 */
export function sanitizeDeliveryPluginFlags(
    config: Record<string, unknown> | null | undefined,
    installed: DeliveryPluginsInstalled,
): void {
    if (!config) return;
    if (!installed.customTabs) for (const flag of CUSTOM_TABS_FLAGS) config[flag] = false;
    if (!installed.pluginPages) for (const flag of PLUGIN_PAGES_FLAGS) config[flag] = false;
}

/**
 * Re-apply {@link sanitizeDeliveryPluginFlags} to JE.pluginConfig using the
 * boot-cached installed state. No-op when the state is unknown (the /Plugins list
 * was unavailable at boot) — matches the pre-fix behavior of leaving flags as-is.
 */
export function applyDeliveryFlagSanitization(): void {
    const installed = JE._deliveryPluginsInstalled;
    if (!installed) return;
    sanitizeDeliveryPluginFlags(JE.pluginConfig, installed);
}
