// @ts-check
'use strict';

const SCROLL_HANDLER_ERROR = 'pageerror: t.scrollHandler is not a function';
const HOME_TAB_PREFIX = "[Home] failed to get tab controller TypeError: Cannot read properties of undefined (reading 'querySelector')";
const HOME_SELECTED_INDEX_ERROR = "pageerror: Cannot read properties of undefined (reading 'selectedIndex')";
const HOME_TAB_CHUNK = /\/web\/hometab\.[A-Za-z0-9]+\.chunk\.js:\d+:\d+/;
const HOME_CHUNK = /\/web\/home\.[A-Za-z0-9]+\.chunk\.js:\d+:\d+/;
const JELLYFIN_WEB_BUNDLE_FRAME = /\/web\/[A-Za-z0-9_.%-]+\.[A-Fa-f0-9]{12,}\.chunk\.js:\d+:\d+/;
const CANOPY_STACK_FRAME = /(?:^|\n)[^\n]*(?:\bJellyfinCanopy\b|\/JellyfinCanopy(?:\/|[?#]))/i;

/**
 * Exact Jellyfin-web host errors observed while the standalone Hidden Content
 * page replaces the home view. This deliberately does not accept a generic
 * querySelector error or a Canopy stack: every other runtime error stays fatal.
 *
 * @param {string} text
 */
function isKnownHiddenContentHostNoise(text) {
    if (text === SCROLL_HANDLER_ERROR) return true;
    return text.startsWith(HOME_TAB_PREFIX)
        && HOME_TAB_CHUNK.test(text)
        && HOME_CHUNK.test(text)
        && !CANOPY_STACK_FRAME.test(text);
}

/**
 * Exact Jellyfin-web races that can surface when the host is CPU-starved while
 * replacing or rebuilding its home view. The selectedIndex message alone is
 * not sufficient: it is accepted only with a browser stack pointing at the
 * immutable hashed Jellyfin-web chunk and with no Canopy frame.
 *
 * @param {{text: string, stack?: string}} detail
 */
function isKnownJellyfinWebHostNoise(detail) {
    const text = String(detail?.text || '');
    const stack = String(detail?.stack || '');
    if (isKnownHiddenContentHostNoise(text)) return true;
    return text === HOME_SELECTED_INDEX_ERROR
        && JELLYFIN_WEB_BUNDLE_FRAME.test(stack)
        && !CANOPY_STACK_FRAME.test(stack);
}

module.exports = {
    HOME_SELECTED_INDEX_ERROR,
    HOME_TAB_PREFIX,
    SCROLL_HANDLER_ERROR,
    isKnownHiddenContentHostNoise,
    isKnownJellyfinWebHostNoise,
};
