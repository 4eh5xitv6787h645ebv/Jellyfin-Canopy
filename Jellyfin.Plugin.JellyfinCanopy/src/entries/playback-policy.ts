import type { FeatureLoaderState } from '../core/feature-loader';
import { JC } from '../globals';

/** Both Jellyfin 12 route dialects used by the video player. */
export function isVideoPlaybackRoute(state: FeatureLoaderState): boolean {
    return /(?:#\/|\/)video(?:[/?#]|$)/i.test(state.routeKey);
}

export function isPlaybackControlsEnabled(state: FeatureLoaderState): boolean {
    return Boolean(state.identity);
}

export function isSubtitleStylesEnabled(state: FeatureLoaderState): boolean {
    return Boolean(state.identity) && JC.currentSettings?.disableCustomSubtitleStyles !== true;
}

export function isOsdRatingEnabled(state: FeatureLoaderState): boolean {
    return Boolean(state.identity) && JC.pluginConfig?.ShowRatingInPlayer !== false;
}

export function isPauseScreenEnabled(state: FeatureLoaderState): boolean {
    return Boolean(state.identity) && JC.currentSettings?.pauseScreenEnabled === true;
}

export function isBookmarksRuntimeEnabled(state: FeatureLoaderState): boolean {
    return Boolean(state.identity) && JC.pluginConfig?.BookmarksEnabled === true;
}

/** Bookmark CRUD is also required by its route-only management page. */
export function isBookmarksRuntimeApplicable(state: FeatureLoaderState): boolean {
    return isVideoPlaybackRoute(state) || /#\/bookmarks(?:[?#]|$)/i.test(state.routeKey);
}
