import type { ClientFeatureDescriptor } from '../core/client-runtime';
import { JC } from '../globals';

function cardTagsEnabled(): boolean {
    const settings = JC.currentSettings;
    return settings?.qualityTagsEnabled === true
        || settings?.genreTagsEnabled === true
        || settings?.ratingTagsEnabled === true
        || settings?.languageTagsEnabled === true
        || settings?.peopleTagsEnabled === true;
}

function cardTagsApplicable(routeKey: string): boolean {
    const settings = JC.currentSettings;
    const posterTags = settings?.qualityTagsEnabled === true
        || settings?.genreTagsEnabled === true
        || settings?.ratingTagsEnabled === true
        || settings?.languageTagsEnabled === true;
    if (posterTags) return true;
    const route = routeKey.toLowerCase();
    return settings?.peopleTagsEnabled === true
        && (route.includes('details') || route.includes('item'));
}

function homeRoute(routeKey: string): boolean {
    const route = routeKey.toLowerCase();
    return /#\/home(?:\.html)?(?:[/?#]|$)/.test(route)
        || /(?:^|\/)home(?:[?#]|$)/.test(route);
}

/**
 * Boot-only policy catalog. Predicates deliberately duplicate tiny config
 * reads instead of importing feature entries, which keeps disabled closures
 * absent from the boot graph.
 */
export const builtInFeatureDescriptors: readonly ClientFeatureDescriptor[] = Object.freeze([
    {
        id: 'card-tags',
        entry: 'card-tags',
        scope: 'identity',
        restartOnConfigChange: true,
        isEnabled: (state) => Boolean(state.identity) && cardTagsEnabled(),
        isApplicable: (state) => cardTagsApplicable(state.routeKey),
    },
    {
        id: 'active-streams',
        entry: 'active-streams',
        scope: 'identity',
        restartOnConfigChange: true,
        isEnabled: (state) => Boolean(state.identity)
            && JC.pluginConfig?.ActiveStreamsEnabled === true,
        isApplicable: () => true,
    },
    {
        id: 'plugin-icons',
        entry: 'plugin-icons',
        scope: 'identity',
        restartOnConfigChange: true,
        isEnabled: (state) => Boolean(state.identity)
            && JC.pluginConfig?.PluginIconsEnabled === true,
        isApplicable: () => true,
    },
    {
        id: 'activity-icons',
        entry: 'activity-icons',
        scope: 'navigation',
        restartOnConfigChange: true,
        isEnabled: (state) => Boolean(state.identity)
            && JC.pluginConfig?.ColoredActivityIconsEnabled === true,
        isApplicable: (state) => {
            const route = state.routeKey.toLowerCase();
            return route.includes('#/dashboard/activity') || route.includes('#/configurationpage');
        },
    },
    {
        id: 'hide-favorites-tab',
        entry: 'hide-favorites-tab',
        scope: 'navigation',
        restartOnConfigChange: true,
        isEnabled: (state) => Boolean(state.identity)
            && JC.currentSettings?.hideFavoritesTab === true,
        isApplicable: (state) => homeRoute(state.routeKey),
    },
]);
