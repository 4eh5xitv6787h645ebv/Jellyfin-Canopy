#!/usr/bin/env node

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    AUTO_SKIP_FIXTURE,
    PLAYWRIGHT_DEVICE_PROFILE,
    TICKS_PER_SECOND,
    isAutoSkipZeroProgressResponse,
    minimumDurationSeconds,
    preservePrimaryError,
    resetAutoSkipPlaybackState,
    resolveAutoSkipFixture,
    selectFixtureItem,
    validatePlaybackInfo,
} = require('./auto-skip-fixture');

const ROOT = path.resolve(__dirname, '../..');

function item(overrides = {}) {
    return {
        Id: 'dynamic-id-a',
        Name: AUTO_SKIP_FIXTURE.name,
        RunTimeTicks: AUTO_SKIP_FIXTURE.durationSeconds * TICKS_PER_SECOND,
        ...overrides,
    };
}

function playbackInfo(overrides = {}) {
    return {
        MediaSources: [
            {
                Id: 'media-source-a',
                RunTimeTicks: AUTO_SKIP_FIXTURE.durationSeconds * TICKS_PER_SECOND,
                SupportsDirectPlay: true,
            },
        ],
        ...overrides,
    };
}

function fakeApi({ items = [item()], playback = playbackInfo(), overrideItem, failLookup } = {}) {
    const calls = [];
    return {
        calls,
        getCurrentUserId: () => 'admin-user-id',
        getItems: async (_userId, options) => {
            calls.push(['getItems', options]);
            if (failLookup) throw new Error(failLookup);
            return { Items: items };
        },
        getItem: async (_userId, id) => {
            calls.push(['getItem', id]);
            if (failLookup) throw new Error(failLookup);
            return overrideItem || item({ Id: id, Name: 'Manually selected item' });
        },
        getPlaybackInfo: async (id, options, profile) => {
            calls.push(['getPlaybackInfo', id, options, profile]);
            return playback;
        },
    };
}

function fakePlaybackStateApi(states) {
    const queue = [...states];
    const calls = [];
    return {
        calls,
        markUnplayed: async (itemId) => {
            calls.push(['markUnplayed', itemId]);
            return { PlaybackPositionTicks: 0, Played: false };
        },
        getUserData: async (itemId) => {
            calls.push(['getUserData', itemId]);
            return queue.length > 1 ? queue.shift() : queue[0];
        },
    };
}

test('the media contract leaves a ten-second margin after the segment end', () => {
    assert.equal(AUTO_SKIP_FIXTURE.segmentStartSeconds, 2);
    assert.equal(AUTO_SKIP_FIXTURE.segmentEndSeconds, 25);
    assert.equal(AUTO_SKIP_FIXTURE.minimumMarginSeconds, 10);
    assert.equal(AUTO_SKIP_FIXTURE.durationSeconds, 40);
    assert.ok(AUTO_SKIP_FIXTURE.segmentStartSeconds < AUTO_SKIP_FIXTURE.segmentEndSeconds);
    assert.ok(AUTO_SKIP_FIXTURE.durationSeconds >= minimumDurationSeconds);
});

test('exact-name discovery ignores fuzzy neighbors and returns the current seed ID', () => {
    const selected = selectFixtureItem([
        item({ Id: 'near-1', Name: `${AUTO_SKIP_FIXTURE.name} old` }),
        item({ Id: 'seed-run-20260713' }),
        item({ Id: 'near-2', Name: 'Auto-Skip Fixture' }),
    ]);
    assert.equal(selected.Id, 'seed-run-20260713');
});

test('missing, duplicate, and blank-ID fixtures fail with immediate diagnostics', () => {
    assert.throws(
        () => selectFixtureItem([]),
        /JC Auto-Skip E2E Fixture.*ID <missing>, duration <missing>.*not found/
    );
    assert.throws(
        () => selectFixtureItem([item({ Id: 'a' }), item({ Id: 'b' })]),
        /ambiguous \(2 exact matches\)/
    );
    assert.throws(
        () => selectFixtureItem([item({ Id: '' })]),
        /ID <missing>, duration 40\.0s.*without a Jellyfin item ID/
    );
});

test('an override is selected only by its exact current ID', () => {
    const selected = selectFixtureItem([
        item({ Id: 'other', Name: AUTO_SKIP_FIXTURE.name }),
        item({ Id: 'override-now', Name: 'Different title' }),
    ], 'override-now');
    assert.equal(selected.Id, 'override-now');
    assert.throws(
        () => selectFixtureItem([item({ Id: 'other' })], 'stale-id'),
        /fixture override stale-id.*ID stale-id, duration <missing>.*not found/
    );
});

test('too-short media fails with actual and required durations before playback', () => {
    const short = item({ RunTimeTicks: 5 * TICKS_PER_SECOND });
    assert.throws(
        () => validatePlaybackInfo(short, playbackInfo({
            MediaSources: [{
                Id: 'short-source',
                RunTimeTicks: 5 * TICKS_PER_SECOND,
                SupportsDirectPlay: true,
            }],
        })),
        /5\.0s actual; 35\.0s required \(segment end 25s \+ 10s margin\)/
    );
});

test('a media item with no advertised playback path fails before navigation', () => {
    assert.throws(
        () => validatePlaybackInfo(item(), {
            MediaSources: [{ Id: 'blocked', SupportsDirectPlay: false }],
        }),
        /ID dynamic-id-a, duration 40\.0s.*exposed no direct-play, direct-stream, or transcode source/
    );
});

test('the selected playable source cannot borrow a longer item or alternate-source duration', () => {
    assert.throws(
        () => validatePlaybackInfo(item({ RunTimeTicks: 90 * TICKS_PER_SECOND }), {
            MediaSources: [
                {
                    Id: 'selected-short-source',
                    RunTimeTicks: 5 * TICKS_PER_SECOND,
                    SupportsDirectPlay: true,
                },
                {
                    Id: 'unplayable-long-source',
                    RunTimeTicks: 90 * TICKS_PER_SECOND,
                    SupportsDirectPlay: false,
                    SupportsDirectStream: false,
                    SupportsTranscoding: false,
                },
            ],
        }),
        /ID dynamic-id-a, duration 5\.0s.*5\.0s actual; 35\.0s required/
    );
});

test('valid playback info records the dynamic ID, duration, and chosen path', () => {
    const resolved = validatePlaybackInfo(item({ Id: 'new-seed-id' }), playbackInfo());
    assert.deepEqual(resolved, {
        id: 'new-seed-id',
        name: AUTO_SKIP_FIXTURE.name,
        durationSeconds: 40,
        mediaSourceId: 'media-source-a',
        playbackMode: 'direct-play',
    });
});

test('resolver discovers by stable name and preflights PlaybackInfo before returning', async () => {
    const api = fakeApi({
        items: [
            item({ Id: 'near', Name: `${AUTO_SKIP_FIXTURE.name} stale` }),
            item({ Id: 'fresh-seed-id' }),
        ],
    });
    const resolved = await resolveAutoSkipFixture(api);
    assert.equal(resolved.id, 'fresh-seed-id');
    assert.deepEqual(api.calls.map((call) => call[0]), ['getItems', 'getPlaybackInfo']);
    assert.equal(api.calls[0][1].SearchTerm, AUTO_SKIP_FIXTURE.name);
    assert.equal(api.calls[1][1], 'fresh-seed-id');
    assert.equal(api.calls[1][2].UserId, 'admin-user-id');
    assert.deepEqual(api.calls[1][3], PLAYWRIGHT_DEVICE_PROFILE);
});

test('resolver fetches and validates an optional override instead of trusting it', async () => {
    const api = fakeApi();
    const resolved = await resolveAutoSkipFixture(api, 'operator-item-id');
    assert.equal(resolved.id, 'operator-item-id');
    assert.deepEqual(api.calls.map((call) => call[0]), ['getItem', 'getPlaybackInfo']);
    assert.equal(api.calls[0][1], 'operator-item-id');
});

test('lookup and PlaybackInfo errors name the phase and happen before navigation', async () => {
    await assert.rejects(
        resolveAutoSkipFixture(fakeApi({ failLookup: '404 missing' }), 'stale-id'),
        /fixture override stale-id.*ID stale-id, duration <missing>.*lookup failed before navigation: 404 missing/
    );

    const api = fakeApi();
    api.getPlaybackInfo = async () => { throw new Error('server rejected media'); };
    await assert.rejects(
        resolveAutoSkipFixture(api),
        /ID dynamic-id-a, duration 40\.0s.*PlaybackInfo preflight failed before navigation: server rejected media/
    );
});

test('playback reset requires two stable reads after the canonical unplayed write', async () => {
    const clean = { PlaybackPositionTicks: 0, PlayedPercentage: undefined, Played: false };
    const api = fakePlaybackStateApi([clean, clean]);
    const waits = [];

    await resetAutoSkipPlaybackState(api, 'fixture-id', {
        settleMs: 17,
        wait: async (milliseconds) => waits.push(milliseconds),
    });

    assert.deepEqual(api.calls, [
        ['markUnplayed', 'fixture-id'],
        ['getUserData', 'fixture-id'],
        ['getUserData', 'fixture-id'],
    ]);
    assert.deepEqual(waits, [17]);
});

test('zero-progress response matcher owns only the exact successful Jellyfin write', () => {
    const exact = {
        method: 'POST',
        pathname: '/Sessions/Playing/Progress',
        status: 204,
        body: { ItemId: 'fixture-id', PositionTicks: 0 },
    };
    assert.equal(isAutoSkipZeroProgressResponse(exact, 'fixture-id'), true);
    assert.equal(isAutoSkipZeroProgressResponse(exact, 'other-id'), false);
    assert.equal(isAutoSkipZeroProgressResponse({ ...exact, method: 'GET' }, 'fixture-id'), false);
    assert.equal(isAutoSkipZeroProgressResponse({ ...exact, status: 500 }, 'fixture-id'), false);
    assert.equal(isAutoSkipZeroProgressResponse({
        ...exact,
        body: { ...exact.body, PositionTicks: 1 },
    }, 'fixture-id'), false);
    assert.equal(isAutoSkipZeroProgressResponse({
        ...exact,
        pathname: '/Sessions/Playing/Stopped',
    }, 'fixture-id'), false);
});

test('cleanup diagnostics preserve the primary Error for Playwright cause serialization', () => {
    const originalCause = new Error('original cause');
    const primary = new Error('PRIMARY ASSERTION', { cause: originalCause });
    primary.stack = 'PRIMARY STACK';
    const firstCleanup = new Error('progress handshake failed');
    firstCleanup.stack = 'PROGRESS STACK';
    const secondCleanup = new Error('native reset failed');
    secondCleanup.stack = 'RESET STACK';

    const preserved = preservePrimaryError(primary, [firstCleanup, secondCleanup]);

    assert.equal(preserved, primary);
    assert.equal(preserved.message, 'PRIMARY ASSERTION');
    assert.equal(preserved.stack, 'PRIMARY STACK');
    assert.ok(preserved.cause instanceof Error);
    assert.match(preserved.cause.message, /progress handshake failed[\s\S]*native reset failed/);
    assert.match(preserved.cause.message, /PROGRESS STACK[\s\S]*RESET STACK/);
    assert.equal(preserved.cause.cause, originalCause);
});

test('non-Error primary values remain visible while cleanup is attached as cause', () => {
    const preserved = preservePrimaryError('plain failure', ['plain cleanup']);
    assert.match(preserved.message, /plain failure/);
    assert.ok(preserved.cause instanceof Error);
    assert.match(preserved.cause.message, /plain cleanup/);
});

test('playback reset repairs a late player-session overwrite before returning', async () => {
    const clean = { PlaybackPositionTicks: 0, PlayedPercentage: 0, Played: false };
    const lateStop = { PlaybackPositionTicks: 0, PlayedPercentage: undefined, Played: true };
    const api = fakePlaybackStateApi([clean, lateStop, clean, clean]);

    await resetAutoSkipPlaybackState(api, 'fixture-id', {
        settleMs: 0,
        wait: async () => undefined,
    });

    assert.equal(api.calls.filter(([name]) => name === 'markUnplayed').length, 2);
    assert.equal(api.calls.filter(([name]) => name === 'getUserData').length, 4);
});

test('playback reset is bounded and reports the last server state', async () => {
    const stale = { PlaybackPositionTicks: 0, PlayedPercentage: undefined, Played: true };
    const api = fakePlaybackStateApi([stale]);

    await assert.rejects(
        resetAutoSkipPlaybackState(api, 'fixture-id', {
            attempts: 3,
            settleMs: 0,
            wait: async () => undefined,
        }),
        /fixture fixture-id.*did not converge after 3 attempts:.*Played=true/
    );
    assert.equal(api.calls.filter(([name]) => name === 'markUnplayed').length, 3);
});

test('seed, spec, compose, and CI consume the dynamic fixture contract', () => {
    const seed = fs.readFileSync(path.join(ROOT, 'e2e/docker/seed.sh'), 'utf8');
    const spec = fs.readFileSync(path.join(ROOT, 'e2e/auto-skip.spec.ts'), 'utf8');
    const compose = fs.readFileSync(path.join(ROOT, 'e2e/docker/compose.yml'), 'utf8');
    const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/build.yml'), 'utf8');

    assert.match(seed, /media-fixtures\.json/);
    assert.match(seed, /make_clip "\$\{AUTOSKIP_RELATIVE_PATH\}" \d+ "\$\{AUTOSKIP_DURATION\}"/);
    assert.match(seed, /testsrc2=duration=\$\{duration\}/);
    assert.match(seed, /sine=frequency=\$2:duration=\$\{duration\}/);
    assert.match(seed, /seed-result\.json/);
    assert.match(spec, /resolveAutoSkipFixture/);
    assert.match(spec, /UserPlayedItems\/\$\{encodeURIComponent\(itemId\)\}/);
    assert.doesNotMatch(spec, /method: 'POST',[\s\S]{0,200}PlaybackPositionTicks: 0/);
    assert.match(spec, /page\.waitForResponse/);
    assert.match(spec, /isZeroProgressResponse\(response, resolved\.id\)/);
    assert.match(spec, /video\.dispatchEvent\(new Event\('timeupdate'\)\)/);
    assert.match(spec, /let testBodyFailed = false/);
    assert.match(spec, /preservePrimaryError\(testBodyError, cleanupErrors\)/);
    assert.ok(
        spec.indexOf('testBodyError = error') < spec.lastIndexOf('resetAutoSkipPlaybackState(resetApi'),
        'the primary test error must be captured before cleanup can fail'
    );
    assert.match(spec, /page\.goto\('about:blank'/);
    assert.ok(
        spec.indexOf("page.goto('about:blank'") < spec.lastIndexOf('resetAutoSkipPlaybackState('),
        'the player must unload before the final server-state reset'
    );
    assert.doesNotMatch(spec, /14ba72cbe419e23f29d748060beef153/);
    assert.ok(
        spec.indexOf('await resolveAutoSkipFixture(') < spec.indexOf('showRoute(page'),
        'fixture preflight must appear before details navigation'
    );
    assert.match(
        compose,
        /image: "\$\{JF_IMAGE:-jellyfin\/jellyfin:unstable@sha256:[0-9a-f]{64}\}"/
    );
    assert.match(workflow, /npm run test:scripts/);
});
