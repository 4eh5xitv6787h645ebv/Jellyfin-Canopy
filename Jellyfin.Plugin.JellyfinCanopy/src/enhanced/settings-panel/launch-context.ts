// Pure route parsing for the lazy Canopy User Settings panel. Click-time actor,
// navigation, and view ownership are captured by the lightweight launcher so
// this parser does not add another module to the authenticated cold graph.

import type { IdentityContext } from '../../types/jc';

export interface SettingsRouteLocation {
    readonly pathname: string;
    readonly search: string;
    readonly hash: string;
}

export type SettingsPreferencesRoute =
    | { readonly kind: 'not-preferences' }
    | { readonly kind: 'malformed-target' }
    | {
        readonly kind: 'preferences';
        /** Canonical N-format Jellyfin user id, or null for the actor's route. */
        readonly targetUserId: string | null;
    };

/**
 * Immutable click-time contract passed from the lightweight launcher to the
 * lazy panel.  A null target means normal self-editing, including an explicit
 * `userId` equal to the actor.
 */
export interface SettingsPanelLaunchContext {
    readonly actor: IdentityContext;
    readonly url: string;
}

const N_USER_ID = /^[0-9a-f]{32}$/i;
const D_USER_ID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeUserId(value: string): string | null {
    if (!N_USER_ID.test(value) && !D_USER_ID.test(value)) return null;
    return value.replace(/-/g, '').toLowerCase();
}

function effectiveRouteParts(location: SettingsRouteLocation): {
    pathname: string;
    search: string;
} {
    // Hash routing owns both the route and its query.  In particular, never
    // combine a hash route's target with the outer document search string.
    if (location.hash.startsWith('#/') || location.hash.startsWith('#!/')) {
        const route = location.hash.startsWith('#!/')
            ? location.hash.slice(2)
            : location.hash.slice(1);
        const queryIndex = route.indexOf('?');
        return queryIndex < 0
            ? { pathname: route, search: '' }
            : {
                pathname: route.slice(0, queryIndex),
                search: route.slice(queryIndex),
            };
    }
    return {
        pathname: location.pathname,
        search: location.search,
    };
}

/**
 * Parse Jellyfin's modern or hash-based user-preferences route.
 *
 * Proxy prefixes and the optional legacy `.html` suffix are accepted.  A
 * target id must be one exact N- or D-format GUID; duplicate/case-variant
 * `userId` parameters fail closed.
 */
export function parseSettingsPreferencesRoute(
    location: SettingsRouteLocation = window.location,
): SettingsPreferencesRoute {
    const route = effectiveRouteParts(location);
    const segments = route.pathname.replace(/\/+$/, '').split('/');
    const page = (segments.at(-1) || '').replace(/\.html$/i, '').toLowerCase();
    if (page !== 'mypreferencesmenu') return { kind: 'not-preferences' };

    let userIdValues: string[];
    try {
        userIdValues = [...new URLSearchParams(route.search).entries()]
            .filter(([key]) => key.toLowerCase() === 'userid')
            .map(([, value]) => value);
    } catch {
        return { kind: 'malformed-target' };
    }

    if (userIdValues.length === 0) {
        return { kind: 'preferences', targetUserId: null };
    }
    if (userIdValues.length !== 1) return { kind: 'malformed-target' };

    const targetUserId = normalizeUserId(userIdValues[0]);
    return targetUserId
        ? { kind: 'preferences', targetUserId }
        : { kind: 'malformed-target' };
}
