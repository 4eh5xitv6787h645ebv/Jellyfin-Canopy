// src/enhanced/spoiler-guard/image-refresh.ts
//
// In-place refresh of every Jellyfin item-image URL on the page. Triggered
// after a Spoiler Guard toggle (and on a watched-state push) so the visible
// blur/clear state flips without an F5. Appends `_sbcb=<timestamp>` to bust
// the browser HTTP cache; the server image filter then re-runs against the
// user's current state and returns the right bytes (blurred / clear / hide).
//
// The pure rewrite helpers (bustUrl / rewriteSrcset) are exported so the
// cache-buster logic is unit-testable without a DOM.

/** Matches a Jellyfin item-image path, e.g. /Items/{id}/Images/Primary. */
export const IMG_PATH_RE = /\/Items\/[a-f0-9-]+\/Images\//i;

/**
 * Append/replace the `_sbcb` cache-buster on a single URL. No-op for URLs
 * that don't reference a Jellyfin item image. Strips any prior `_sbcb` param
 * first so successive toggles don't grow the query string unbounded.
 * @param url - Candidate URL.
 * @param cb - Cache-buster fragment, e.g. `_sbcb=1699999999999`.
 */
export function bustUrl(url: string, cb: string): string {
    if (typeof url !== 'string' || !url) return url;
    if (!IMG_PATH_RE.test(url)) return url;
    const cleaned = url.replace(/([?&])_sbcb=\d+&?/g, '$1').replace(/[?&]$/, '');
    return cleaned + (cleaned.indexOf('?') === -1 ? '?' : '&') + cb;
}

/**
 * Rewrite each candidate URL inside a srcset string, busting only the ones
 * that reference a Jellyfin item image and leaving descriptors (`2x`, widths)
 * and separators intact.
 * @param srcset - Raw srcset attribute value.
 * @param cb - Cache-buster fragment.
 */
export function rewriteSrcset(srcset: string, cb: string): string {
    return srcset.replace(/([^\s,]+)(?=\s*[\d.]+x|\s*,|\s*$)/g, (u) =>
        IMG_PATH_RE.test(u) ? bustUrl(u, cb) : u
    );
}

/**
 * Rewrite `url(...)` references inside an inline-style string.
 * @param style - Raw style attribute value.
 * @param cb - Cache-buster fragment.
 */
export function rewriteStyleUrls(style: string, cb: string): string {
    return style.replace(/url\((["']?)([^"')]+)\1\)/gi, (_m, q, u) => `url(${q}${bustUrl(u, cb)}${q})`);
}

/**
 * Bust every Jellyfin item-image URL currently in the DOM: img[src],
 * img[srcset], source[srcset] and inline-style url(...) backgrounds. Scoped
 * selectors (`*="/Items/"`) keep the walk off the whole DOM.
 */
export function refreshSpoilerableImages(): void {
    const cb = `_sbcb=${Date.now()}`;

    const imgs = document.querySelectorAll<HTMLImageElement>('img[src*="/Items/"]');
    for (const img of imgs) {
        const orig = img.getAttribute('src') || '';
        if (IMG_PATH_RE.test(orig)) img.setAttribute('src', bustUrl(orig, cb));
        const ss = img.getAttribute('srcset');
        if (ss && IMG_PATH_RE.test(ss)) img.setAttribute('srcset', rewriteSrcset(ss, cb));
    }

    const sources = document.querySelectorAll<HTMLSourceElement>('source[srcset*="/Items/"]');
    for (const s of sources) {
        const sss = s.getAttribute('srcset') || '';
        if (IMG_PATH_RE.test(sss)) s.setAttribute('srcset', rewriteSrcset(sss, cb));
    }

    // background-image on inline styles. Walk only nodes whose style attribute
    // references /Items/ to avoid scanning the whole DOM.
    const bgEls = document.querySelectorAll<HTMLElement>('[style*="/Items/"]');
    for (const el of bgEls) {
        const st = el.getAttribute('style') || '';
        if (IMG_PATH_RE.test(st)) {
            const newSt = rewriteStyleUrls(st, cb);
            if (newSt !== st) el.setAttribute('style', newSt);
        }
    }
}
