/**
 * Whether the current route is the Home page that owns the native
 * Home/Favorites tab strip. This module is intentionally import-pure so lazy
 * feature entries can use it without pulling the enhanced helper lifecycle.
 */
export function isOnHomePage(): boolean {
    const hash = window.location.hash;
    if (hash) {
        const legacyRoute = hash.split('?')[0];
        return legacyRoute === '#/home' || legacyRoute === '#/home.html';
    }

    const modernRoute = `${window.location.pathname}${window.location.search}`;
    return modernRoute === '/home' || modernRoute.startsWith('/home?');
}
