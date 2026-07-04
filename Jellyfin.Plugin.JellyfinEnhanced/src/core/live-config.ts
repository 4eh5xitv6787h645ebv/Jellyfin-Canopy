// src/core/live-config.ts
//
// Config hot-reload — the client half of the live config channel.
//
// The server (Services/LiveNotifierService) pushes a JE-marked "config-changed"
// GeneralCommand whenever an admin saves plugin config; src/core/live.ts fans it
// out as the CONFIG_CHANGED event. This module reacts: it refetches
// /JellyfinEnhanced/public-config (+ private-config for admins), merges the fresh
// values into JE.pluginConfig IN PLACE (so modules that captured the object by
// reference see the update), then nudges the features that can re-render live —
// a legacy `je:config-changed` DOM event for unmigrated modules and a tag
// pipeline rescan. The net effect: an admin toggling a setting updates open
// browser sessions with no reload.
//
// Honest limits: not every feature re-initialises from a config change alone —
// some still need a navigation/refresh to fully rebuild their DOM. This module
// updates JE.pluginConfig live and re-runs the cheap, idempotent surfaces; the
// heavy per-page injectors re-read the fresh config on their next mount.

import { JE } from '../globals';
import { LIVE, on } from './live';
import type { PluginConfig } from '../types/je';

const logPrefix = '🪼 Jellyfin Enhanced: Live Config:';

/**
 * Refetch the plugin config from the server and merge it into JE.pluginConfig.
 * Merges IN PLACE (Object.assign) to preserve the object's reference identity —
 * js/plugin.js and many modules hold JE.pluginConfig by reference, matching the
 * loader's own `Object.assign(JE.pluginConfig, privateConfig)` pattern.
 */
async function refreshPluginConfig(): Promise<void> {
    const api = JE.core.api;
    if (!api) {
        console.warn(`${logPrefix} JE.core.api unavailable — cannot refetch config.`);
        return;
    }

    // Cache-buster: bypass any intermediary/browser caching so the very next
    // read reflects the admin's just-saved values.
    const bust = `?_je=${Date.now()}`;

    try {
        const pub = await api.plugin(`/public-config${bust}`, { skipCache: true });
        if (pub && typeof pub === 'object') {
            Object.assign(JE.pluginConfig, pub as PluginConfig);
        }
    } catch (err) {
        console.error(`${logPrefix} failed to refetch public-config:`, err);
        return;
    }

    // Admins additionally get sensitive fields; non-admins receive {} (the
    // endpoint returns an empty object rather than 403), so this is best-effort.
    try {
        const priv = await api.plugin(`/private-config${bust}`, { skipCache: true });
        if (priv && typeof priv === 'object') {
            Object.assign(JE.pluginConfig, priv as Record<string, unknown>);
        }
    } catch (err) {
        console.debug(`${logPrefix} private-config not available (non-admin?):`, err);
    }
}

on(LIVE.CONFIG_CHANGED, () => {
    void (async () => {
        await refreshPluginConfig();

        // Let unmigrated modules and any feature reinit hooks react to the fresh
        // config without this module having to know about each of them.
        try {
            window.dispatchEvent(new CustomEvent('je:config-changed'));
        } catch { /* CustomEvent unsupported — ignore */ }

        // Tag pipeline: re-scan visible cards so tag-related toggles apply live.
        try {
            JE.tagPipeline?.scheduleScan?.();
        } catch { /* pipeline not loaded — ignore */ }

        console.log(`${logPrefix} plugin config hot-reloaded from server push`);
    })();
});

console.log(`${logPrefix} initialized`);
