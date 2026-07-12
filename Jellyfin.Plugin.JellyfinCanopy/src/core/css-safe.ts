// src/core/css-safe.ts
//
// The paved-road sink for config-derived values entering a CSS context —
// parallel to escapeHtml for HTML. escapeHtml is NOT sufficient inside a
// `style="..."` attribute or a stylesheet rule: it neutralizes HTML breakout
// but passes a `red;background-image:url(https://attacker/beacon)` CSS payload
// unchanged (THEME-1 / THEME-2). Route any config/user-derived colour through
// cssColorOr before interpolating it into insertRule / style / color-mix / var.

/**
 * True if the browser accepts `v` as a CSS <color> (safe inside
 * insertRule/style/color-mix/var). Falls back to a permissive check only where
 * the CSS API is unavailable (non-browser/test env without CSS.supports).
 */
export function isCssColor(v: unknown): boolean {
    if (typeof v !== 'string' || v.trim() === '') return false;
    if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') return true;
    return CSS.supports('color', v.trim());
}

/**
 * Return `v` when it is a valid CSS colour, else `fallback`. The single sink
 * for config→CSS colour interpolation: a malicious value (e.g. one carrying an
 * extra `;background-image:url(...)` declaration) fails isCssColor and is
 * replaced by the trusted fallback.
 */
export function cssColorOr(v: unknown, fallback: string): string {
    return isCssColor(v) ? (v as string).trim() : fallback;
}
