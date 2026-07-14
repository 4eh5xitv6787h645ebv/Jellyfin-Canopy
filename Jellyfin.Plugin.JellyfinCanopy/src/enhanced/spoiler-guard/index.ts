// src/enhanced/spoiler-guard/index.ts
//
// Spoiler Guard client feature — barrel + init/wiring.
//
// Assigns the JC.spoilerGuard public surface unconditionally (so consumers —
// ratingtags, reviews, the Seerr modal — can feature-detect and call
// whenLoaded()/isEnabledFor safely even when the admin switch is off; whenLoaded
// short-circuits without a network call in that case). The network load, the
// identity cookie, the CSS and the watched-state subscription are gated on the
// admin master switch inside init(), which runs at import time (the v12 paved
// road: modules self-wire rather than waiting to be called from js/plugin.js).
// A LIVE.CONFIG_CHANGED handler re-runs init so an admin enabling the feature
// takes effect without a reload.

import { JC } from '../../globals';
import { on, LIVE } from '../../core/live';
import { addSpoilerBlurButton } from './detail-button';
import {
    loadState, resetState, whenLoaded, isLoadOk,
    isEnabledFor, isMovieEnabledFor, isCollectionEnabledFor,
    hasEnabledCollections, fetchMovieScope,
    enableForSeries, disableForSeries,
    enableForMovie, disableForMovie,
    enableForCollection, disableForCollection,
    isTmdbEnabled, enableForTmdb, disableForTmdb,
    getUserPrefs, setUserPrefs,
} from './state';
import { confirmDisableSpoiler } from './dialog';
import { injectSpoilerGuardCss } from './styles';
import { primeIdentityCookieEarly, setIdentityCookie } from './identity';
import { installWatchedRefresh } from './watched-refresh';
import type { IdentityContext } from '../../types/jc';

const logPrefix = '🪼 Jellyfin Canopy [SpoilerGuard]:';

let inited = false;
let activeEpoch: number | null = null;

/**
 * Boot the client feature. Gated on the admin master switch. Idempotent: safe
 * to re-run on LIVE.CONFIG_CHANGED (re-fetches state; the cookie / CSS / live
 * subscription install once).
 */
function init(context: IdentityContext | null = JC.identity.capture()): void {
    if (JC.pluginConfig?.SpoilerBlurEnabled !== true) return;
    if (!context || !JC.identity.isCurrent(context)) return;
    setIdentityCookie(context);
    primeIdentityCookieEarly(context);
    if (!inited) {
        inited = true;
        injectSpoilerGuardCss();
    }
    installWatchedRefresh();
    if (activeEpoch === context.epoch) return;
    activeEpoch = context.epoch;
    void loadState();
}

JC.spoilerGuard = {
    init,
    addSpoilerBlurButton,
    isEnabledFor,
    isMovieEnabledFor,
    isCollectionEnabledFor,
    hasEnabledCollections,
    fetchMovieScope,
    enableForSeries,
    disableForSeries,
    enableForMovie,
    disableForMovie,
    enableForCollection,
    disableForCollection,
    isTmdbEnabled,
    enableForTmdb,
    disableForTmdb,
    whenLoaded,
    isLoadOk,
    confirmDisableSpoiler,
    getUserPrefs,
    setUserPrefs,
};

// Write the identity cookie as EARLY as possible — before the first wave of
// card <img> requests — with a bounded retry until ApiClient reports a user.
primeIdentityCookieEarly();

JC.identity.registerReset('spoiler-guard', () => {
    activeEpoch = null;
});
JC.identity.registerActivate('spoiler-guard', (context) => {
    init(context);
});

// Boot now, and re-boot when an admin saves config (re-init instead of reload).
init();
on(LIVE.CONFIG_CHANGED, () => {
    try {
        if (JC.pluginConfig?.SpoilerBlurEnabled === true) {
            resetState();
            activeEpoch = null;
            init();
        }
    } catch (e) {
        console.warn(`${logPrefix} re-init on config change failed:`, e);
    }
});
