// src/enhanced/spoiler-guard/snooze.ts
//
// Disable-confirm snooze: when the user opts in via the checkbox in the
// confirm dialog, skip the dialog for 15 minutes. Scoped per Jellyfin user so
// multi-user clients don't share the suppression — when the user id is
// unavailable (pre-init, post-logout transient) we treat the request as
// "never snoozed; never persist" rather than collapsing into a shared bucket.

const logPrefix = '🪼 Jellyfin Canopy [SpoilerGuard]:';

export const SNOOZE_MS = 15 * 60 * 1000;
/** Sanity cap for a parsed expiry — reject anything further out (corruption/skew). */
export const MAX_SNOOZE_FUTURE_MS = 24 * 60 * 60 * 1000;

let emptyUidWarned = false;

/**
 * Pure validation of a stored snooze expiry against "now".
 * @param expiry - Parsed expiry timestamp (ms epoch).
 * @param now - Current time (ms epoch).
 * @returns 'active' (still snoozed), 'expired' (past — remove), or
 *          'invalid' (non-finite / non-positive / absurd future — remove).
 */
export function classifySnoozeExpiry(expiry: number, now: number): 'active' | 'expired' | 'invalid' {
    if (!Number.isFinite(expiry) || expiry <= 0) return 'invalid';
    if (expiry > now + MAX_SNOOZE_FUTURE_MS) return 'invalid';
    if (now < expiry) return 'active';
    return 'expired';
}

/**
 * The current Jellyfin user id, or null when unavailable. Returning null
 * (never a shared empty-string bucket) means snooze is disabled for the call.
 */
export function snoozeUid(): string | null {
    try {
        if (typeof ApiClient !== 'undefined' && typeof ApiClient.getCurrentUserId === 'function') {
            const uid = ApiClient.getCurrentUserId();
            if (typeof uid === 'string' && uid.length > 0) return uid;
        }
    } catch { /* fall through */ }
    if (!emptyUidWarned) {
        emptyUidWarned = true;
        console.warn(`${logPrefix} snooze: user id unavailable, snooze disabled this call`);
    }
    return null;
}

/** Per-user localStorage key for the snooze expiry. */
export function snoozeStorageKey(uid: string): string {
    return `jc-spoiler-disable-snooze:${uid}`;
}

/** True when the disable-confirm dialog is currently snoozed for this user. */
export function isDisableSnoozed(): boolean {
    const uid = snoozeUid();
    if (!uid) return false;
    const key = snoozeStorageKey(uid);
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return false;
        const verdict = classifySnoozeExpiry(Number(raw), Date.now());
        if (verdict === 'active') return true;
        // 'expired' or 'invalid' — drop the stale key.
        localStorage.removeItem(key);
    } catch (e) {
        console.warn(`${logPrefix} snooze read failed:`, e);
    }
    return false;
}

/** Persist a fresh 15-minute snooze for the current user. */
export function setDisableSnooze(): void {
    const uid = snoozeUid();
    if (!uid) return;
    try {
        localStorage.setItem(snoozeStorageKey(uid), String(Date.now() + SNOOZE_MS));
    } catch (e) {
        console.warn(`${logPrefix} snooze persist failed:`, e);
    }
}
