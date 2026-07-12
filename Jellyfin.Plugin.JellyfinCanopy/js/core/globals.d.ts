/**
 * Ambient declarations for globals provided by jellyfin-web at runtime.
 *
 * These exist so `// @ts-check`-ed modules can reference the host globals
 * without tripping "cannot find name" errors. Everything is `any` on
 * purpose: the host client is untyped from our perspective, and the goal
 * of checkJs here is catching our own defects, not modelling Jellyfin.
 */

declare var ApiClient: any;
declare var Emby: any;
declare var Dashboard: any;

interface Window {
    JellyfinCanopy: any;
    JC: any;
    ApiClient: any;
    Emby: any;
    __JE_userStatusBannerShown?: any;
}

interface History {
    /** Set once js/core/navigation.js has patched pushState/replaceState. */
    __jePushed?: boolean;
}
