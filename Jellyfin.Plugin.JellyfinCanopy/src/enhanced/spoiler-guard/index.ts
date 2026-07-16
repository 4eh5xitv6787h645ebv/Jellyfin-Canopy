// src/enhanced/spoiler-guard/index.ts
//
// Activation-owned Spoiler Guard implementation and stable public facade.
// Importing this module is inert: the feature entry owns facade publication,
// config/live subscriptions, identity fencing, CSS, timers and requests.

import { JC } from '../../globals';
import { createStableMethodFacade } from '../../core/feature-loader';
import { addSpoilerBlurButton, resetSpoilerDetailControls } from './detail-button';
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
import { confirmDisableSpoiler, resetSpoilerDisableConfirms } from './dialog';
import { injectSpoilerGuardCss, removeSpoilerGuardCss } from './styles';
import { primeIdentityCookieEarly, resetIdentityCookie, setIdentityCookie } from './identity';
import { installWatchedRefresh, resetWatchedRefresh } from './watched-refresh';
import { resetSpoilerSettingsControls } from './settings-tab';
import { resetSpoilerSeerrControls } from './seerr-toggle';
import type { IdentityContext, SpoilerGuardApi } from '../../types/jc';

let activeEpoch: number | null = null;
let watchedCleanup: (() => void) | null = null;

async function initializeRuntime(
    context: IdentityContext | null = JC.identity.capture(),
): Promise<void> {
    if (JC.pluginConfig?.SpoilerBlurEnabled !== true) return;
    if (!context || !JC.identity.isCurrent(context)) return;
    setIdentityCookie(context);
    primeIdentityCookieEarly(context);
    injectSpoilerGuardCss();
    watchedCleanup ??= installWatchedRefresh();
    if (activeEpoch === context.epoch) return whenLoaded();
    activeEpoch = context.epoch;
    await loadState();
}

/** Tear down every resource or UI surface owned by one activation. */
export function resetSpoilerGuardRuntime(): void {
    activeEpoch = null;
    watchedCleanup?.();
    watchedCleanup = null;
    resetWatchedRefresh();
    resetSpoilerSettingsControls();
    resetSpoilerSeerrControls();
    resetSpoilerDetailControls();
    resetSpoilerDisableConfirms();
    resetIdentityCookie();
    resetState();
    removeSpoilerGuardCss();
}

const spoilerGuardApi: SpoilerGuardApi = {
    init(): void { void initializeRuntime(); },
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

const inactiveError = (): Promise<never> => Promise.reject(
    new Error('Spoiler Guard is not active for the current identity'),
);

const stableSpoilerGuard = createStableMethodFacade<SpoilerGuardApi>({
    init() {},
    addSpoilerBlurButton() {},
    isEnabledFor: () => false,
    isMovieEnabledFor: () => false,
    isCollectionEnabledFor: () => false,
    hasEnabledCollections: () => false,
    fetchMovieScope: () => Promise.resolve(null),
    enableForSeries: inactiveError,
    disableForSeries: inactiveError,
    enableForMovie: inactiveError,
    disableForMovie: inactiveError,
    enableForCollection: inactiveError,
    disableForCollection: inactiveError,
    isTmdbEnabled: () => false,
    enableForTmdb: inactiveError,
    disableForTmdb: inactiveError,
    whenLoaded: () => Promise.resolve(),
    isLoadOk: () => false,
    confirmDisableSpoiler: () => Promise.resolve(false),
    getUserPrefs: () => ({}),
    setUserPrefs: inactiveError,
});

/** Publish the stable facade for one loader-owned activation. */
export function installSpoilerGuard(): () => void {
    const uninstall = stableSpoilerGuard.install(spoilerGuardApi);
    JC.spoilerGuard = stableSpoilerGuard.facade;
    let disposed = false;
    return () => {
        if (disposed) return;
        disposed = true;
        resetSpoilerGuardRuntime();
        uninstall();
    };
}

/** Initialize one current feature-loader generation. */
export function initializeSpoilerGuard(
    context: IdentityContext | null = JC.identity.capture(),
): Promise<void> {
    return initializeRuntime(context);
}
