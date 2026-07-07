// src/core/config-resolve.ts
//
// Single normalization point for admin-default (PluginConfiguration) resolution.
//
// JE.pluginConfig is PascalCase (the raw GetPublicConfig/GetPrivateConfig
// payload — descriptor keys == PluginConfiguration property names), whereas the
// per-user settings and the client's hardcoded defaults are camelCase. Any
// consumer that wants to resolve the admin tier (notably enhanced/config.ts's
// loadSettings) reads it through the shallow camelCase VIEW built here, instead
// of the dead `pluginConfig[camelKey]` read that always missed against the
// PascalCase object (the root of ENH-4).

/**
 * PascalCase admin key → camelCase settings key (first char only, matching the
 * loader's JE.toCamelCase for top-level scalars).
 * @param key PascalCase descriptor/property key.
 * @returns The camelCased key.
 */
export function toCamelKey(key: string): string {
    return key.length ? key.charAt(0).toLowerCase() + key.slice(1) : key;
}

/**
 * Shallow camelCase view of the PascalCase plugin config, for admin-default
 * resolution. Deliberately shallow (not the deep JE.toCamelCase): only top-level
 * scalars are read for defaulting, and nested blobs (Shortcuts, instance arrays)
 * must not be deep-copied or key-mangled. loadSettings is not a hot path (session
 * init + CONFIG_CHANGED only), so the single allocation is fine.
 * @param pluginConfig The raw PascalCase plugin config (or null/undefined).
 * @returns A new object keyed by the camelCased top-level keys.
 */
export function adminDefaultsView(
    pluginConfig: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
    const view: Record<string, unknown> = {};
    if (!pluginConfig) return view;
    for (const key of Object.keys(pluginConfig)) {
        view[toCamelKey(key)] = pluginConfig[key];
    }
    return view;
}
