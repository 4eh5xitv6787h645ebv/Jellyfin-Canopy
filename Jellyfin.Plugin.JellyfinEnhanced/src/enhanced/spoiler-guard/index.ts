// src/enhanced/spoiler-guard/index.ts
//
// Spoiler Guard client feature — barrel + init/wiring.
//
// Assigns the JE.spoilerGuard public surface unconditionally (so consumers —
// ratingtags, reviews, the Seerr modal — can feature-detect and call
// whenLoaded()/isEnabledFor safely even when the admin switch is off; whenLoaded
// short-circuits without a network call in that case). The network load, the
// identity cookie, the CSS and the watched-state subscription are gated on the
// admin master switch inside init(), which runs at import time (the v12 paved
// road: modules self-wire rather than waiting to be called from js/plugin.js).
// A LIVE.CONFIG_CHANGED handler re-runs init so an admin enabling the feature
// takes effect without a reload.

import { JE } from '../../globals';
import { on, LIVE } from '../../core/live';
import { addSpoilerBlurButton } from './detail-button';
import {
    loadState, resetState, whenLoaded, isLoadOk,
    isEnabledFor, isMovieEnabledFor, isCollectionEnabledFor,
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

const logPrefix = '🪼 Jellyfin Enhanced [SpoilerGuard]:';

let inited = false;

/**
 * Boot the client feature. Gated on the admin master switch. Idempotent: safe
 * to re-run on LIVE.CONFIG_CHANGED (re-fetches state; the cookie / CSS / live
 * subscription install once).
 */
function init(): void {
    if (JE.pluginConfig?.SpoilerBlurEnabled !== true) return;
    setIdentityCookie();
    if (!inited) {
        inited = true;
        injectSpoilerGuardCss();
        installWatchedRefresh();
    }
    void loadState();
}

JE.spoilerGuard = {
    init,
    addSpoilerBlurButton,
    isEnabledFor,
    isMovieEnabledFor,
    isCollectionEnabledFor,
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

// Boot now, and re-boot when an admin saves config (re-init instead of reload).
init();
on(LIVE.CONFIG_CHANGED, () => {
    try {
        if (JE.pluginConfig?.SpoilerBlurEnabled === true) {
            resetState();
            init();
        }
    } catch (e) {
        console.warn(`${logPrefix} re-init on config change failed:`, e);
    }
});
