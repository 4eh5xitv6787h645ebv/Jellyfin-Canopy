// src/core/live-config.ts
//
// Config hot-reload — the client half of the live config channel.
//
// The server (Services/LiveNotifierService) pushes a JC-marked "config-changed"
// GeneralCommand whenever an admin saves plugin config; src/core/live.ts fans it
// out as the CONFIG_CHANGED event. This module reacts: it refetches
// /JellyfinCanopy/public-config (+ private-config for admins), merges the fresh
// values into JC.pluginConfig IN PLACE (so modules that captured the object by
// reference see the update), then nudges the features that can re-render live —
// a legacy `jc:config-changed` DOM event for unmigrated modules and a tag
// pipeline rescan. The net effect: an admin toggling a setting updates open
// browser sessions with no reload.
//
// Honest limits: not every feature re-initialises from a config change alone —
// some still need a navigation/refresh to fully rebuild their DOM. This module
// updates JC.pluginConfig live and re-runs the cheap, idempotent surfaces; the
// heavy per-page injectors re-read the fresh config on their next mount.

import { JC } from '../globals';
import { LIVE, on } from './live';
import type { PluginConfig } from '../types/jc';

const logPrefix = '🪼 Jellyfin Canopy: Live Config:';

// (CORE-9) Monotonic refresh counter — only the LAST-INITIATED refresh may
// mutate JC.pluginConfig, so two rapid saves can't settle by completion order
// (last-to-finish, possibly the older snapshot). The key-set of the previous
// payload from each source lets us PRUNE keys that vanished server-side (plain
// Object.assign never deletes).
let refreshSeq = 0;
let lastPublicKeys: string[] = [];
let lastPrivateKeys: string[] = [];

const TAG_PROJECTION_POLICY_KEYS = [
    'TagCacheServerMode',
    'SpoilerBlurEnabled',
    'SpoilerStripTags',
    'SpoilerStripRatings',
    'SpoilerReplaceTitle',
    'SpoilerStripOverview',
] as const;

/** Stable snapshot of admin fields that change tag-cache privacy projection. */
function tagProjectionPolicyFingerprint(): string {
    return JSON.stringify(TAG_PROJECTION_POLICY_KEYS.map((key) => JC.pluginConfig?.[key]));
}

/** Prune keys that the previous payload from this source owned but the new one dropped. */
function prunePayloadKeys(previousKeys: string[], next: object): void {
    const config = JC.pluginConfig as Record<string, unknown>;
    for (const key of previousKeys) {
        if (!(key in next)) delete config[key];
    }
}

/**
 * Refetch the plugin config from the server and merge it into JC.pluginConfig.
 * Merges IN PLACE (Object.assign) to preserve the object's reference identity —
 * js/plugin.js and many modules hold JC.pluginConfig by reference, matching the
 * loader's own `Object.assign(JC.pluginConfig, privateConfig)` pattern. Guards
 * against out-of-order settle (CORE-9), prunes vanished keys per source, and
 * re-applies the delivery-flag sanitization so a hot-reload can't resurface
 * stale *UseCustomTabs/*UsePluginPages flags (INIT-1).
 */
async function refreshPluginConfig(): Promise<void> {
    const api = JC.core.api;
    if (!api) {
        console.warn(`${logPrefix} JC.core.api unavailable — cannot refetch config.`);
        return;
    }

    const seq = ++refreshSeq; // (CORE-9) last-initiated wins

    // Cache-buster: bypass any intermediary/browser caching so the very next
    // read reflects the admin's just-saved values.
    const bust = `?_je=${Date.now()}`;

    try {
        const pub = await api.plugin(`/public-config${bust}`, { skipCache: true });
        if (seq !== refreshSeq) return; // superseded by a newer refresh
        if (pub && typeof pub === 'object') {
            prunePayloadKeys(lastPublicKeys, pub); // (CORE-9) drop vanished public keys
            Object.assign(JC.pluginConfig, pub as PluginConfig);
            lastPublicKeys = Object.keys(pub);
            // (INIT-1/LC-1) Re-zero the stale UseCustomTabs/UsePluginPages flags
            // IMMEDIATELY — the public payload we just merged re-wrote them to
            // their pre-uninstall `true`. Deferring the sanitize to the end of the
            // refresh leaves a /private-config round-trip window where a drawer
            // rebuild would observe them true and skip re-injecting the nav item.
        }
    } catch (err) {
        console.error(`${logPrefix} failed to refetch public-config:`, err);
        return;
    }

    // Admins additionally get sensitive fields; non-admins receive {} (the
    // endpoint returns an empty object rather than 403), so this is best-effort.
    try {
        const priv = await api.plugin(`/private-config${bust}`, { skipCache: true });
        if (seq !== refreshSeq) return;
        if (priv && typeof priv === 'object') {
            prunePayloadKeys(lastPrivateKeys, priv);
            Object.assign(JC.pluginConfig, priv as Record<string, unknown>);
            lastPrivateKeys = Object.keys(priv);
        }
    } catch (err) {
        console.debug(`${logPrefix} private-config not available (non-admin?):`, err);
    }

    // (INIT-1) Re-force stale UseCustomTabs/UsePluginPages flags back to false for
    // any delivery plugin that is not installed — the raw server payload we just
    // merged still stores the pre-uninstall `true`.
}

on(LIVE.CONFIG_CHANGED, () => {
    void (async () => {
        const previousTagPolicy = tagProjectionPolicyFingerprint();
        await refreshPluginConfig();

        // Let unmigrated modules and any feature reinit hooks react to the fresh
        // config without this module having to know about each of them.
        try {
            window.dispatchEvent(new CustomEvent('jc:config-changed'));
        } catch { /* CustomEvent unsupported — ignore */ }

        // Policy changes alter the actual per-user cache bytes, so a rescan of
        // already-processed cards is insufficient. Unrelated config changes retain
        // the cheap scan path.
        try {
            if (previousTagPolicy !== tagProjectionPolicyFingerprint()
                && JC.tagPipeline?.invalidateServerCache) {
                await JC.tagPipeline.invalidateServerCache();
            } else {
                JC.tagPipeline?.scheduleScan?.();
            }
        } catch { /* pipeline not loaded — ignore */ }

        console.log(`${logPrefix} plugin config hot-reloaded from server push`);
    })();
});

console.log(`${logPrefix} initialized`);
