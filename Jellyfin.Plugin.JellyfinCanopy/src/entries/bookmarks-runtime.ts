import type { FeatureModule, FeatureScope } from '../core/feature-loader';
import { initializeInstalledBookmarks, installBookmarks } from '../enhanced/bookmarks/bookmarks';

function isVideoRoute(routeKey: string): boolean {
    return /(?:#\/|\/)video(?:[/?#]|$)/i.test(routeKey);
}

/** Import-pure bookmark CRUD plus video-marker runtime entry. */
export const bookmarksRuntimeFeature: FeatureModule = Object.freeze({
    activate(scope: FeatureScope) {
        if (!scope.isCurrent()) return;
        const dispose = installBookmarks();
        if (!scope.isCurrent()) {
            dispose();
            return;
        }
        scope.track(dispose);
        if (isVideoRoute(scope.routeKey)) initializeInstalledBookmarks();
        if (!scope.isCurrent()) dispose();
    },
});

export const activate: FeatureModule['activate'] = (scope) => bookmarksRuntimeFeature.activate(scope);
