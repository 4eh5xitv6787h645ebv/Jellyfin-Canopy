import type { ClientFeatureDescriptor } from '../core/client-runtime';
import { JC } from '../globals';

function enabled(): boolean {
    return JC.pluginConfig?.SeerrEnabled === true;
}

function seerrRoute(routeKey: string): boolean {
    return /#\/(?:search|movies|tvshows|details|list)(?:[/?#]|$)/i.test(routeKey);
}

/**
 * Pure descriptor fragment for central-catalog integration. Keeping policy in
 * this tiny module prevents the catalog from importing any Seerr UI closure.
 */
export const seerrFeatureDescriptors: readonly ClientFeatureDescriptor[] = Object.freeze([
    {
        id: 'seerr-core',
        entry: 'seerr-core',
        scope: 'identity',
        restartOnConfigChange: true,
        isEnabled: (state) => Boolean(state.identity) && enabled(),
        isApplicable: (state) => seerrRoute(state.routeKey),
    },
    {
        id: 'seerr-search',
        entry: 'seerr-search',
        scope: 'navigation',
        dependsOn: ['seerr-core'],
        restartOnConfigChange: true,
        isEnabled: (state) => Boolean(state.identity)
            && enabled()
            && JC.pluginConfig?.SeerrShowSearchResults !== false,
        isApplicable: (state) => /#\/search(?:[/?#]|$)/i.test(state.routeKey),
    },
    {
        id: 'seerr-details',
        entry: 'seerr-details',
        scope: 'navigation',
        dependsOn: ['seerr-core'],
        restartOnConfigChange: true,
        isEnabled: (state) => Boolean(state.identity) && enabled(),
        isApplicable: (state) => /#\/details(?:[/?#]|$)/i.test(state.routeKey),
    },
    {
        id: 'seerr-discovery',
        entry: 'seerr-discovery',
        scope: 'navigation',
        dependsOn: ['seerr-core'],
        restartOnConfigChange: true,
        isEnabled: (state) => Boolean(state.identity) && enabled(),
        isApplicable: (state) => /#\/(?:details|list)(?:[/?#]|$)/i.test(state.routeKey),
    },
    {
        id: 'discovery-library',
        entry: 'discovery-library',
        scope: 'navigation',
        dependsOn: ['seerr-core'],
        restartOnConfigChange: true,
        isEnabled: (state) => Boolean(state.identity)
            && enabled()
            && JC.pluginConfig?.DiscoveryEnabled !== false
            && JC.pluginConfig?.DiscoveryLibraryTab !== false,
        isApplicable: (state) => /#\/(?:movies|tvshows)(?:[/?#]|$)/i.test(state.routeKey),
    },
]);
