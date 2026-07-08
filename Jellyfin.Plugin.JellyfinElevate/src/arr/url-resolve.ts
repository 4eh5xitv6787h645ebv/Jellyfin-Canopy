// src/arr/url-resolve.ts
//
// Shared, pure resolution of the browser-facing base URL for a Sonarr/Radarr/Bazarr
// deep link. This is the client-side half of the internal/external URL split
// (upstream "split URLs" requests): the Jellyfin server always fetches over the
// INTERNAL url, while user-clickable links resolve here with precedence
//
//   1. a URL Mapping whose Jellyfin side matches the current access URL  (most specific)
//   2. the optional EXTERNAL/public URL, when set
//   3. the INTERNAL url                                                  (fallback)
//
// An empty external URL therefore reproduces the previous behaviour exactly
// (mapping-or-internal), so existing single-URL setups are unchanged.

export interface UrlMapping {
    jellyfinUrl: string;
    arrUrl: string;
}

/** Parses newline-separated "jellyfin_url|arr_url" mapping lines into pairs. */
export function parseUrlMappings(mappingsString: string | undefined | null): UrlMapping[] {
    const mappings: UrlMapping[] = [];
    if (!mappingsString) return mappings;

    mappingsString.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (!trimmed) return;

        const parts = trimmed.split('|').map(p => p.trim());
        if (parts.length === 2 && parts[0] && parts[1]) {
            mappings.push({ jellyfinUrl: parts[0], arrUrl: parts[1] });
        }
    });

    return mappings;
}

/**
 * Pure base-URL resolver. Given the internal URL, the optional external URL, the
 * parsed mappings and the current Jellyfin access URL, returns the base a browser
 * link should use — or null when nothing is configured. Trailing slashes on the
 * chosen base are trimmed; callers append the item path (e.g. `/series/<slug>`),
 * so a base-URL/subpath (`https://host/sonarr`) is preserved.
 */
export function resolveMappedBase(
    internalUrl: string | null | undefined,
    externalUrl: string | null | undefined,
    mappings: UrlMapping[],
    currentServerUrl: string
): string | null {
    // 1. A matching URL mapping wins — it is the per-access-URL override.
    if (mappings.length > 0) {
        const currentUrl = (currentServerUrl || '').replace(/\/+$/, '').toLowerCase();
        for (const mapping of mappings) {
            const normalizedJellyfinUrl = mapping.jellyfinUrl.replace(/\/+$/, '').toLowerCase();
            if (currentUrl && currentUrl === normalizedJellyfinUrl) {
                return mapping.arrUrl.replace(/\/+$/, '');
            }
        }
    }

    // 2. The explicit external/public URL, when set. 3. Otherwise the internal URL.
    const external = externalUrl ? externalUrl.trim() : '';
    const base = external || (internalUrl ? internalUrl.trim() : '');
    return base ? base.replace(/\/+$/, '') : null;
}

/** The current Jellyfin server address a browser is using, lowercased comparisons aside. */
function currentServerAddress(): string {
    return (typeof ApiClient !== 'undefined' && ApiClient.serverAddress)
        ? (ApiClient.serverAddress as () => string)()
        : window.location.origin;
}

/**
 * Convenience wrapper used by arr-links: resolves the browser-facing base URL for a
 * service from its internal URL, optional external URL and raw mappings string,
 * reading the live Jellyfin server address.
 */
export function resolveArrLinkBase(
    internalUrl: string | null | undefined,
    externalUrl: string | null | undefined,
    mappingsString: string | undefined | null
): string | null {
    return resolveMappedBase(
        internalUrl,
        externalUrl,
        parseUrlMappings(mappingsString),
        currentServerAddress()
    );
}
