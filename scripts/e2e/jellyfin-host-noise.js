// @ts-check
'use strict';

const SCROLL_HANDLER_ERROR = 'pageerror: t.scrollHandler is not a function';
const HOME_TAB_PREFIX = "[Home] failed to get tab controller TypeError: Cannot read properties of undefined (reading 'querySelector')";
const HOME_TAB_CHUNK = /\/web\/hometab\.[A-Za-z0-9]+\.chunk\.js:\d+:\d+/;
const HOME_CHUNK = /\/web\/home\.[A-Za-z0-9]+\.chunk\.js:\d+:\d+/;

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
        && HOME_CHUNK.test(text);
}

module.exports = {
    HOME_TAB_PREFIX,
    SCROLL_HANDLER_ERROR,
    isKnownHiddenContentHostNoise,
};
