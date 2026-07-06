// src/enhanced/spoiler-guard/identity.ts
//
// Per-browser identity cookie (je-spoiler-uid=<currentUserId>) so the
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

const logPrefix = '🪼 Jellyfin Enhanced [SpoilerGuard]:';

/** Write the identity cookie for the current user, if one is available. */
export function setIdentityCookie(): void {
    try {
        const uid = (typeof ApiClient !== 'undefined' && typeof ApiClient.getCurrentUserId === 'function')
            ? ApiClient.getCurrentUserId()
            : null;
        if (uid) {
            document.cookie = `je-spoiler-uid=${encodeURIComponent(uid)}; path=/; SameSite=Lax`;
        }
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
let primed = false;

/** Write the cookie now, then retry briefly until a user id is available. */
export function primeIdentityCookieEarly(): void {
    if (primed) return;
    primed = true;
    setIdentityCookie();
    let tries = 0;
    try {
        const iv = setInterval(() => {
            const uid = (typeof ApiClient !== 'undefined' && typeof ApiClient.getCurrentUserId === 'function')
                ? ApiClient.getCurrentUserId()
                : null;
            if (uid) {
                setIdentityCookie();
                clearInterval(iv);
            } else if (++tries >= PRIME_MAX_TRIES) {
                clearInterval(iv);
            }
        }, PRIME_INTERVAL_MS);
    } catch {
        /* setInterval unavailable — init() still sets the cookie once. */
    }
}
