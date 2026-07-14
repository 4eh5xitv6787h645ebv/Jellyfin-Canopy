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
import type { IdentityContext, PluginConfig } from '../types/jc';

const logPrefix = '🪼 Jellyfin Canopy: Live Config:';

// (CORE-9) Monotonic refresh counter — only the LAST-INITIATED refresh may
// mutate JC.pluginConfig, so two rapid saves can't settle by completion order
// (last-to-finish, possibly the older snapshot). The key-set of the previous
// payload from each source lets us PRUNE keys that vanished server-side (plain
// Object.assign never deletes).
let refreshSeq = 0;
let lastPublicKeys: string[] = [];
let lastPrivateKeys: string[] = [];

interface ConfigRefreshResult {
    seq: number;
    tagPolicyFingerprint: string;
}

interface TagPolicyState {
    identityKey: string;
    lastObservedFingerprint: string;
    observationGeneration: number;
    lastInvalidatedFingerprint: string;
    lastInvalidatedGeneration: number;
    lastInvalidatedSeq: number;
    pendingInvalidations: Map<string, PendingTagPolicyInvalidation>;
}

interface PendingTagPolicyInvalidation {
    observationGeneration: number;
    maxSeq: number;
    promise: Promise<void>;
}

// The baseline advances only after cache invalidation succeeds. A rejected
// invalidation therefore leaves the policy dirty for the next push, while the
// pending map lets equivalent overlapping pushes share one invalidation.
let tagPolicyState: TagPolicyState | null = null;

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

function identityKey(context: IdentityContext): string {
    return `${context.serverId}:${context.userId}:${context.epoch}`;
}

function beginTagPolicyRefresh(context: IdentityContext): TagPolicyState {
    const key = identityKey(context);
    if (!tagPolicyState || tagPolicyState.identityKey !== key) {
        tagPolicyState = {
            identityKey: key,
            // The config present when an identity becomes active is its known
            // cache-policy baseline. Later changes advance this only after a
            // successful invalidation.
            lastObservedFingerprint: tagProjectionPolicyFingerprint(),
            observationGeneration: 0,
            lastInvalidatedFingerprint: tagProjectionPolicyFingerprint(),
            lastInvalidatedGeneration: 0,
            lastInvalidatedSeq: refreshSeq,
            pendingInvalidations: new Map()
        };
    }
    return tagPolicyState;
}

function observeTagPolicy(state: TagPolicyState, fingerprint: string): number {
    if (state.lastObservedFingerprint !== fingerprint) {
        state.lastObservedFingerprint = fingerprint;
        state.observationGeneration += 1;
    }
    return state.observationGeneration;
}

async function invalidateTagPolicy(
    state: TagPolicyState,
    refreshed: ConfigRefreshResult,
    observationGeneration: number,
    invalidateServerCache: () => Promise<void>
): Promise<void> {
    const fingerprint = refreshed.tagPolicyFingerprint;
    let pending = state.pendingInvalidations.get(fingerprint);
    if (pending?.observationGeneration === observationGeneration) {
        pending.maxSeq = Math.max(pending.maxSeq, refreshed.seq);
    } else {
        const next: PendingTagPolicyInvalidation = {
            observationGeneration,
            maxSeq: refreshed.seq,
            promise: Promise.resolve()
        };
        next.promise = (async () => {
            await invalidateServerCache();
            // Different policy invalidations may overlap. Never let an older
            // completion roll the successful baseline back from a newer one.
            if (next.observationGeneration === state.observationGeneration
                && (next.observationGeneration > state.lastInvalidatedGeneration
                    || (next.observationGeneration === state.lastInvalidatedGeneration
                        && next.maxSeq >= state.lastInvalidatedSeq))) {
                state.lastInvalidatedFingerprint = fingerprint;
                state.lastInvalidatedGeneration = next.observationGeneration;
                state.lastInvalidatedSeq = next.maxSeq;
            }
        })();
        state.pendingInvalidations.set(fingerprint, next);
        pending = next;
    }

    try {
        await pending.promise;
    } finally {
        if (state.pendingInvalidations.get(fingerprint) === pending) {
            state.pendingInvalidations.delete(fingerprint);
        }
    }
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
 * against out-of-order settle (CORE-9) and prunes vanished keys per source.
 */
async function refreshPluginConfig(context: IdentityContext): Promise<ConfigRefreshResult | null> {
    if (!JC.identity.isCurrent(context)) return null;
    const api = JC.core.api;
    if (!api) {
        console.warn(`${logPrefix} JC.core.api unavailable — cannot refetch config.`);
        return null;
    }

    const seq = ++refreshSeq; // (CORE-9) last-initiated wins

    // Cache-buster: bypass any intermediary/browser caching so the very next
    // read reflects the admin's just-saved values.
    const bust = `?_je=${Date.now()}`;

    try {
        const pub = await api.plugin(`/public-config${bust}`, { skipCache: true });
        if (seq !== refreshSeq || !JC.identity.isCurrent(context)) return null;
        if (pub && typeof pub === 'object') {
            prunePayloadKeys(lastPublicKeys, pub); // (CORE-9) drop vanished public keys
            Object.assign(JC.pluginConfig, pub as PluginConfig);
            lastPublicKeys = Object.keys(pub);
        }
    } catch (err) {
        if (seq !== refreshSeq || !JC.identity.isCurrent(context)) return null;
        console.error(`${logPrefix} failed to refetch public-config:`, err);
        return null;
    }

    // Admins additionally get sensitive fields; non-admins receive {} (the
    // endpoint returns an empty object rather than 403), so this is best-effort.
    try {
        const priv = await api.plugin(`/private-config${bust}`, { skipCache: true });
        if (seq !== refreshSeq || !JC.identity.isCurrent(context)) return null;
        if (priv && typeof priv === 'object') {
            prunePayloadKeys(lastPrivateKeys, priv);
            Object.assign(JC.pluginConfig, priv as Record<string, unknown>);
            lastPrivateKeys = Object.keys(priv);
        }
    } catch (err) {
        if (seq !== refreshSeq || !JC.identity.isCurrent(context)) return null;
        console.debug(`${logPrefix} private-config not available (non-admin?):`, err);
    }

    if (seq !== refreshSeq || !JC.identity.isCurrent(context)) return null;
    return { seq, tagPolicyFingerprint: tagProjectionPolicyFingerprint() };
}

on(LIVE.CONFIG_CHANGED, () => {
    const context = JC.identity.capture();
    if (!context) return;
    const policyState = beginTagPolicyRefresh(context);
    void (async () => {
        const refreshed = await refreshPluginConfig(context);
        if (!refreshed || refreshed.seq !== refreshSeq || !JC.identity.isCurrent(context)) return;

        const observationGeneration = observeTagPolicy(
            policyState,
            refreshed.tagPolicyFingerprint
        );
        const policyChanged = policyState.lastInvalidatedFingerprint !== refreshed.tagPolicyFingerprint
            || policyState.lastInvalidatedGeneration < observationGeneration;

        // Let unmigrated modules and any feature reinit hooks react to the fresh
        // config without this module having to know about each of them.
        try {
            window.dispatchEvent(new CustomEvent('jc:config-changed'));
        } catch { /* CustomEvent unsupported — ignore */ }
        // DOM dispatch is synchronous and feature listeners are arbitrary. A
        // listener may accept a newer host identity, so A must not continue
        // into the now-current B pipeline after the callback stack unwinds.
        if (!JC.identity.isCurrent(context)) return;

        // Policy changes alter the actual per-user cache bytes, so a rescan of
        // already-processed cards is insufficient. Unrelated config changes retain
        // the cheap scan path.
        try {
            const pipeline = JC.tagPipeline;
            if (policyChanged && pipeline?.invalidateServerCache) {
                await invalidateTagPolicy(
                    policyState,
                    refreshed,
                    observationGeneration,
                    () => pipeline.invalidateServerCache!()
                );
            } else {
                pipeline?.scheduleScan?.();
            }
        } catch { /* pipeline not loaded or invalidation failed — retry next push */ }

        if (JC.identity.isCurrent(context)) {
            console.log(`${logPrefix} plugin config hot-reloaded from server push`);
        }
    })();
});

console.log(`${logPrefix} initialized`);
