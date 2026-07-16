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

function detailsRoute(routeKey: string): boolean {
    return routeKey.toLowerCase().includes('details');
}

function arrSearchEnabled(): boolean {
    const config = JC.pluginConfig as undefined | {
        ArrSearchEnabled?: boolean;
        RadarrInstances?: Array<{ Enabled?: boolean; Url?: string }>;
        SonarrInstances?: Array<{ Enabled?: boolean; Url?: string }>;
        RadarrUrl?: string;
        SonarrUrl?: string;
    };
    if (config?.ArrSearchEnabled === false) return false;
    const admin = JC.currentUser?.Policy?.IsAdministrator === true
        || JC.currentSettings?.isAdmin === true;
    if (!admin) return false;
    const configured = [...(config?.RadarrInstances || []), ...(config?.SonarrInstances || [])]
        .some((instance) => instance.Enabled !== false && typeof instance.Url === 'string'
            && instance.Url.trim().length > 0);
    return configured || Boolean(config?.RadarrUrl?.trim() || config?.SonarrUrl?.trim());
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
    {
        id: 'random-button',
        entry: 'random-button',
        scope: 'identity',
        restartOnConfigChange: true,
        isEnabled: (state) => Boolean(state.identity)
            && JC.currentSettings?.randomButtonEnabled === true,
        isApplicable: () => true,
    },
    {
        id: 'remove-home-actions',
        entry: 'remove-home-actions',
        scope: 'navigation',
        restartOnConfigChange: true,
        isEnabled: (state) => Boolean(state.identity)
            && JC.currentSettings?.removeContinueWatchingEnabled === true,
        isApplicable: (state) => homeRoute(state.routeKey),
    },
    {
        id: 'calendar-page',
        entry: 'calendar-page',
        scope: 'navigation',
        isEnabled: (state) => Boolean(state.identity)
            && JC.pluginConfig?.CalendarPageEnabled === true,
        isApplicable: (state) => /#\/calendar(?:[?#]|$)/i.test(state.routeKey),
    },
    {
        id: 'requests-page',
        entry: 'requests-page',
        scope: 'navigation',
        isEnabled: (state) => Boolean(state.identity)
            && JC.pluginConfig?.DownloadsPageEnabled === true,
        isApplicable: (state) => /#\/downloads(?:[?#]|$)/i.test(state.routeKey),
    },
    {
        id: 'hidden-content-runtime',
        entry: 'hidden-content-runtime',
        scope: 'identity',
        restartOnConfigChange: true,
        isEnabled: (state) => Boolean(state.identity)
            && JC.pluginConfig?.HiddenContentEnabled === true,
        isApplicable: () => true,
    },
    {
        id: 'hidden-content-page',
        entry: 'hidden-content-page',
        scope: 'navigation',
        dependsOn: ['hidden-content-runtime'],
        isEnabled: (state) => Boolean(state.identity)
            && JC.pluginConfig?.HiddenContentEnabled === true,
        isApplicable: (state) => /#\/hidden-content(?:[?#]|$)/i.test(state.routeKey),
    },
    {
        id: 'bookmarks-page',
        entry: 'bookmarks-page',
        scope: 'navigation',
        isEnabled: (state) => Boolean(state.identity)
            && JC.pluginConfig?.BookmarksEnabled === true,
        isApplicable: (state) => /#\/bookmarks(?:[?#]|$)/i.test(state.routeKey),
    },
    {
        id: 'theme-selector',
        entry: 'theme-selector',
        scope: 'identity',
        restartOnConfigChange: true,
        isEnabled: (state) => Boolean(state.identity)
            && JC.pluginConfig?.ThemeSelectorEnabled === true,
        isApplicable: () => true,
    },
    {
        id: 'colored-ratings',
        entry: 'colored-ratings',
        scope: 'navigation',
        restartOnConfigChange: true,
        isEnabled: (state) => Boolean(state.identity)
            && JC.pluginConfig?.ColoredRatingsEnabled === true,
        isApplicable: (state) => {
            const route = state.routeKey.toLowerCase();
            return route.includes('details') || route.includes('/video') || route.includes('#/video');
        },
    },
    {
        id: 'details-enhancements',
        entry: 'details-enhancements',
        scope: 'navigation',
        restartOnConfigChange: true,
        isEnabled: (state) => Boolean(state.identity) && (
            JC.currentSettings?.showWatchProgress === true
            || JC.currentSettings?.showFileSizes === true
            || JC.currentSettings?.showAudioLanguages === true
            || (JC.pluginConfig?.ShowReleaseDates === true && JC.pluginConfig?.TmdbEnabled === true)
            || JC.pluginConfig?.HiddenContentEnabled === true
        ),
        isApplicable: (state) => detailsRoute(state.routeKey),
    },
    {
        id: 'elsewhere',
        entry: 'elsewhere',
        scope: 'navigation',
        restartOnConfigChange: true,
        isEnabled: (state) => Boolean(state.identity)
            && JC.pluginConfig?.ElsewhereEnabled === true
            && JC.pluginConfig?.TmdbEnabled === true,
        isApplicable: (state) => detailsRoute(state.routeKey),
    },
    {
        id: 'reviews',
        entry: 'reviews',
        scope: 'navigation',
        restartOnConfigChange: true,
        isEnabled: (state) => Boolean(state.identity) && (
            (JC.pluginConfig?.ShowReviews === true && JC.pluginConfig?.TmdbEnabled === true)
            || JC.pluginConfig?.ShowUserReviews === true
        ),
        isApplicable: (state) => detailsRoute(state.routeKey),
    },
    {
        id: 'arr-detail-links',
        entry: 'arr-detail-links',
        scope: 'navigation',
        restartOnConfigChange: true,
        isEnabled: (state) => Boolean(state.identity) && (
            JC.pluginConfig?.ArrLinksEnabled === true
            || JC.pluginConfig?.ArrTagsShowAsLinks === true
        ),
        isApplicable: (state) => detailsRoute(state.routeKey),
    },
    {
        id: 'arr-search',
        entry: 'arr-search',
        scope: 'identity',
        restartOnConfigChange: true,
        isEnabled: (state) => Boolean(state.identity) && arrSearchEnabled(),
        isApplicable: () => true,
    },
    {
        id: 'letterboxd-links',
        entry: 'letterboxd-links',
        scope: 'navigation',
        restartOnConfigChange: true,
        isEnabled: (state) => Boolean(state.identity)
            && JC.pluginConfig?.LetterboxdEnabled === true,
        isApplicable: (state) => detailsRoute(state.routeKey),
    },
]);
