'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    HOME_TAB_PREFIX,
    SCROLL_HANDLER_ERROR,
    isKnownHiddenContentHostNoise,
} = require('./jellyfin-host-noise');

const OBSERVED_HOME_RACE = `${HOME_TAB_PREFIX}\n`
    + '    at new e (http://localhost:8100/web/hometab.2be9340f81cc7f0987ef.chunk.js:1:1173)\n'
    + '    at http://localhost:8100/web/home.ea733a1f3e4e4f7bee3b.chunk.js:1:2950';

test('accepts only the exact observed scroll-handler host message', () => {
    assert.equal(isKnownHiddenContentHostNoise(SCROLL_HANDLER_ERROR), true);
    assert.equal(isKnownHiddenContentHostNoise(`${SCROLL_HANDLER_ERROR} extra`), false);
    assert.equal(isKnownHiddenContentHostNoise('t.scrollHandler is not a function'), false);
});

test('accepts the observed Home race only with both Jellyfin host chunks', () => {
    assert.equal(isKnownHiddenContentHostNoise(OBSERVED_HOME_RACE), true);
    assert.equal(
        isKnownHiddenContentHostNoise(OBSERVED_HOME_RACE.replace('/web/hometab.', '/JellyfinCanopy/hometab.')),
        false
    );
    assert.equal(
        isKnownHiddenContentHostNoise(OBSERVED_HOME_RACE.replace('/web/home.', '/JellyfinCanopy/home.')),
        false
    );
});

test('rejects a mixed Home race stack containing a Canopy plugin frame', () => {
    assert.equal(
        isKnownHiddenContentHostNoise(
            `${OBSERVED_HOME_RACE}\n    at renderHiddenContent (http://localhost:8100/JellyfinCanopy/dist/jc.bundle.js?v=1:4:20)`
        ),
        false
    );
    assert.equal(
        isKnownHiddenContentHostNoise(
            `${OBSERVED_HOME_RACE}\n    at JellyfinCanopy.show (http://localhost:8100/JellyfinCanopy/script?v=1:8:15)`
        ),
        false
    );
    assert.equal(
        isKnownHiddenContentHostNoise(
            `${OBSERVED_HOME_RACE}\nrenderHiddenContent@http://localhost:8100/JellyfinCanopy/dist/jc.bundle.js:4:20`
        ),
        false
    );
});

test('a different Home, querySelector, or Canopy error remains fatal', () => {
    assert.equal(
        isKnownHiddenContentHostNoise(OBSERVED_HOME_RACE.replace("reading 'querySelector'", "reading 'remove'")),
        false
    );
    assert.equal(
        isKnownHiddenContentHostNoise('[Home] failed to get tab controller Error: Canopy failed'),
        false
    );
    assert.equal(
        isKnownHiddenContentHostNoise("TypeError: Cannot read properties of undefined (reading 'querySelector')"),
        false
    );
});
