/**
 * Mirror the production Discovery library configuration contract for the
 * Node-side exploratory readiness decision. The source-contract regression
 * ties this helper to the two real browser consumers.
 *
 * @param {Readonly<Record<string, unknown>> | null | undefined} config
 * @returns {{ available: true, reason: null } | { available: false, reason: string }}
 */
export function discoveryLibraryAvailability(config) {
    if (config?.DiscoveryEnabled === false) {
        return { available: false, reason: 'Discovery is disabled on this server' };
    }
    if (config?.DiscoveryLibraryTab === false) {
        return { available: false, reason: 'Discovery library placement is disabled on this server' };
    }
    if (config?.SeerrEnabled !== true) {
        return { available: false, reason: 'Discovery library placement requires Seerr' };
    }
    return { available: true, reason: null };
}
