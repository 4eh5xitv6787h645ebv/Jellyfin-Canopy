// src/core/url-safe.ts
//
// The single client-side authority for "is this value safe to use as a browser
// LINK BASE?" — shared by the arr link resolver (src/arr/url-resolve.ts) and the
// Seerr link resolver (src/seerr/api.ts). The server-side twin is
// Helpers/ServiceUrlResolver.IsWellFormedHttpUrl; keep their rules in sync.

/**
 * True when a value is safe to use as a browser LINK BASE: an absolute http(s)
 * URL without embedded credentials and without a query string or fragment
 * (item paths are appended by concatenation, so `?x=1` would corrupt the URL).
 *
 * Applied at use time to the two caller-overridable sources — URL-mapping
 * targets and external URLs — as defence-in-depth on top of save validation
 * (a direct config POST bypasses the config page). Internal-URL fallbacks are
 * deliberately NOT re-checked by callers: they have always been used raw for
 * links, and rejecting them at use time could break existing working setups.
 */
export function isSafeLinkBase(value: string | null | undefined): boolean {
    if (!value) return false;
    try {
        const u = new URL(value.trim());
        return (u.protocol === 'http:' || u.protocol === 'https:')
            && !u.username && !u.password
            && !u.search && !u.hash;
    } catch {
        return false;
    }
}
