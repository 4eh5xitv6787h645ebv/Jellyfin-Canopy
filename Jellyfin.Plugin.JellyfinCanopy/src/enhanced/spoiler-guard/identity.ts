// src/enhanced/spoiler-guard/identity.ts
//
// Per-browser identity cookie (jc-spoiler-uid=<currentUserId>) so the
// server-side image filter can attribute anonymous <img>/CSS-background image
// requests to the right user.
//
// Why a cookie and not a URL param: on Jellyfin 12 the image endpoint no longer
// accepts the api_key query param for USER identity (only an Authorization
// header authenticates, and <img> tags can't send headers). An earlier build
// globally rewrote HTMLImageElement.src to append api_key; that both stopped
// working for identity on v12 AND, because it mutated URLs after the browser had
// begun loading them, double-fetched every card image (native → BlurHash →
// api_key → BlurHash) — a visible flicker on EVERY show. A cookie rides along
// automatically with same-origin image requests without touching the URL, so
// there is no re-fetch and no flicker.
//
// Trust model: this is an identity HINT, not an auth token — no secret rides in
// it. The server (SpoilerUserResolver) trusts it ONLY to pick between users that
// already have an active session from the request IP, so a forged/stale value
// can't impersonate an absent user. Session-scoped (clears on browser close) and
// refreshed on every load, so switching accounts updates it. Do NOT reintroduce
// image-URL rewriting here.

import { JC } from '../../globals';
import type { IdentityContext } from '../../types/jc';

const logPrefix = '🪼 Jellyfin Canopy [SpoilerGuard]:';

function clearIdentityCookie(): void {
    try {
        document.cookie = 'jc-spoiler-uid=; path=/; SameSite=Lax; Max-Age=0';
    } catch {
        /* no document cookie surface */
    }
}

/** Write the identity cookie for the captured current user, if available. */
export function setIdentityCookie(context: IdentityContext | null = JC.identity.capture()): void {
    try {
        if (!context || !JC.identity.isCurrent(context)) return;
        document.cookie = `jc-spoiler-uid=${encodeURIComponent(context.userId)}; path=/; SameSite=Lax`;
    } catch (e) {
        console.warn(`${logPrefix} identity cookie set failed:`, e);
    }
}

// Bounded cookie-priming retry. PERF(R5): this is the one sanctioned standing
// timer in the module — NOT DOM polling and NOT unbounded. It fires at most 20
// times at 250ms and clears itself the instant ApiClient reports a user. It
// exists so the cookie beats the first wave of card <img> requests on a cold
// start (init() runs late in bundle boot, after those images may already be
// in flight); the cookie also persists across the SPA's account-switch reload,
// so this closes the window where a stale previous-user value would ride along
// with the new user's early image requests.
const PRIME_INTERVAL_MS = 250;
const PRIME_MAX_TRIES = 20;
let primedEpoch: number | null = null;
let primeInterval: number | null = null;

function stopPriming(): void {
    if (primeInterval !== null) {
        clearInterval(primeInterval);
        primeInterval = null;
    }
}

/** Drop A's hint synchronously before any B image request can inherit it. */
export function resetIdentityCookie(): void {
    stopPriming();
    primedEpoch = null;
    clearIdentityCookie();
}

/** Write the cookie now, then retry briefly until a user id is available. */
export function primeIdentityCookieEarly(context: IdentityContext | null = JC.identity.capture()): void {
    if (!context || !JC.identity.isCurrent(context)) return;
    if (primedEpoch === context.epoch) return;
    stopPriming();
    primedEpoch = context.epoch;
    setIdentityCookie(context);
    let tries = 0;
    try {
        primeInterval = window.setInterval(() => {
            if (!JC.identity.isCurrent(context)) {
                stopPriming();
                return;
            }
            const uid = (typeof ApiClient !== 'undefined' && typeof ApiClient.getCurrentUserId === 'function')
                ? ApiClient.getCurrentUserId()
                : null;
            const normalizedUid = String(uid || '').replace(/-/g, '').toLowerCase();
            if (normalizedUid === context.userId) {
                setIdentityCookie(context);
                stopPriming();
            } else if (++tries >= PRIME_MAX_TRIES) {
                stopPriming();
            }
        }, PRIME_INTERVAL_MS);
    } catch {
        /* setInterval unavailable — init() still sets the cookie once. */
    }
}

JC.identity.registerReset('spoiler-identity-cookie', resetIdentityCookie);
JC.identity.registerActivate('spoiler-identity-cookie', primeIdentityCookieEarly);
