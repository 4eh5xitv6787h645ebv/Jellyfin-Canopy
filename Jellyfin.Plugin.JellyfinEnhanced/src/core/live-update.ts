// src/core/live-update.ts
//
// Plugin self-update detection.
//
// When an admin updates the JellyfinEnhanced DLL while browser sessions stay
// open, those sessions keep running the OLD client bundle until a manual reload.
// This module compares the version the session loaded (JE.pluginVersion, set by
// js/plugin.js from /JellyfinEnhanced/version at boot) against the server's
// currently-reported version, and shows a one-time toast prompting a refresh
// when the server has moved ahead.
//
// Three triggers, all converging on the same one-shot notifier:
//   1. an on-load check (covers a session that opened after the server updated),
//   2. the Version the server stamps into every config-changed push (an update
//      is frequently followed by a config save), and
//   3. a low-frequency, visibility-gated re-check for long-lived sessions.
//
// Fails soft everywhere: a failed version fetch or a missing toast is a no-op.

import { JE } from '../globals';
import { register } from './lifecycle';
import { LIVE, on } from './live';

const logPrefix = '🪼 Jellyfin Enhanced: Self-Update:';

// The version this session actually loaded. Captured once — it never changes for
// the life of the page.
const loadedVersion = JE.pluginVersion;

// Re-check cadence for long-lived sessions (visibility-gated).
const RECHECK_INTERVAL_MS = 15 * 60 * 1000;

let notified = false;

/**
 * Compare dotted numeric version strings (e.g. "1.2.3.0").
 * @returns 1 if a > b, -1 if a < b, 0 if equal, NaN if either is unparseable.
 */
export function compareVersions(a: string, b: string): number {
    const pa = a.split('.');
    const pb = b.split('.');
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const x = i < pa.length ? Number(pa[i]) : 0;
        const y = i < pb.length ? Number(pb[i]) : 0;
        if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
        if (x > y) return 1;
        if (x < y) return -1;
    }
    return 0;
}

/**
 * Toast once if `serverVersion` is strictly newer than the loaded version.
 * Only fires on a confidently-parsed, strictly-greater comparison to avoid
 * false prompts.
 */
export function notifyIfNewer(serverVersion: string | null | undefined): void {
    if (notified) return;
    if (!serverVersion || !loadedVersion) return;
    if (serverVersion === 'unknown' || loadedVersion === 'unknown') return;
    if (serverVersion === loadedVersion) return;
    if (compareVersions(serverVersion, loadedVersion) !== 1) return;

    notified = true;
    const message = 'Jellyfin Enhanced updated — refresh to load the new version';
    try {
        // Prefer the canonical core toast; fall back to the frozen JE.toast alias.
        if (JE.core.ui?.toast) {
            JE.core.ui.toast(message, 8000);
        } else if (JE.toast) {
            JE.toast(message, 8000);
        }
    } catch (err) {
        console.warn(`${logPrefix} toast failed:`, err);
    }
    console.log(`${logPrefix} server ${serverVersion} newer than loaded ${loadedVersion} — prompted refresh`);
}

/** Fetch the server's current plugin version (plain text) and compare. */
async function checkNow(): Promise<void> {
    if (notified || typeof ApiClient === 'undefined') return;
    try {
        const res = await fetch(ApiClient.getUrl(`/JellyfinEnhanced/version?_je=${Date.now()}`));
        if (!res.ok) return;
        const serverVersion = (await res.text()).trim();
        notifyIfNewer(serverVersion);
    } catch (err) {
        console.debug(`${logPrefix} version check failed:`, err);
    }
}

// (2) The server stamps its current version into every config-changed push; a
// mismatch there means the DLL was updated under this open session.
on(LIVE.CONFIG_CHANGED, (data) => {
    notifyIfNewer((data as { Version?: string } | undefined)?.Version);
});

// (1) + (3): an initial check shortly after load, then a visibility-gated
// re-check for sessions that stay open across an update. Tracked on a lifecycle
// handle so teardownAll disposes the interval.
const handle = register('live-update');
const initialCheck = setTimeout(() => { void checkNow(); }, 5000);
handle.onTeardown(() => clearTimeout(initialCheck));

const recheck = setInterval(() => {
    if (notified) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    void checkNow();
}, RECHECK_INTERVAL_MS);
handle.track(recheck);

console.log(`${logPrefix} initialized`);
