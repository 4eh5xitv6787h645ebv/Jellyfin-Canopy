// src/core/fetch-error.ts
//
// Shared classification for a rejected coreFetch/HttpError so data-fetch
// callers can tell "the backend returned a structured error" from "the result
// is genuinely empty". The transport layer (core/api-client.ts) deliberately
// captures a failed response's body onto HttpError.responseText /
// HttpError.responseJSON; the helpers below let a caught rejection drive an
// ERROR state instead of the "No X found" empty state (CRIT-2 / W4-ERR-*).
//
// This is the paved-road sink for surfacing a fetch failure to the user:
//   - describeFetchError(error, fallback) → a short, sanitized message.
//   - isStructuredServerError(error)      → true when the rejection carries a
//                                            structured server error body.

import type { HttpError } from '../types/jc';

/**
 * Extract a human-facing message from a rejected coreFetch/HttpError, sanitized.
 * Only a short, single-line upstream message is surfaced — never a stack trace,
 * an HTML error page, or a URL-bearing blob (which could leak an internal Seerr
 * address). Anything failing those checks falls back to the caller's string.
 */
export function describeFetchError(error: unknown, fallback: string): string {
    const e = error as HttpError | undefined;
    const j = e?.responseJSON as { message?: string; error?: string } | undefined;
    const raw = (j?.message || j?.error || '').trim();
    if (raw && raw.length <= 200 && !/https?:\/\//i.test(raw) && !/[<>]/.test(raw)) {
        return raw;
    }
    return fallback;
}

/**
 * True when a rejection carries a structured server error body (a JSON error
 * envelope or an HTTP status >= 400) rather than a bare network drop. Callers
 * use it to decide whether an empty result reflects a real backend failure.
 */
export function isStructuredServerError(error: unknown): boolean {
    const e = error as HttpError | undefined;
    return !!(e && (e.responseJSON != null || (typeof e.status === 'number' && e.status >= 400)));
}
