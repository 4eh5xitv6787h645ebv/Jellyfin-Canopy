#!/usr/bin/env node

'use strict';

const fixtureManifest = require('../../e2e/fixtures/media-fixtures.json');

const TICKS_PER_SECOND = 10_000_000;
const PLAYBACK_RESET_ATTEMPTS = 6;
const PLAYBACK_RESET_SETTLE_MS = 250;

function positiveNumber(value, label) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) {
        throw new Error(`Auto-Skip fixture contract has invalid ${label}: ${String(value)}`);
    }
    return number;
}

const manifest = fixtureManifest.autoSkip || {};
const AUTO_SKIP_FIXTURE = Object.freeze({
    name: String(manifest.name || '').trim(),
    filePrefix: String(manifest.filePrefix || '').trim(),
    durationSeconds: positiveNumber(manifest.durationSeconds, 'durationSeconds'),
    segmentStartSeconds: positiveNumber(manifest.segmentStartSeconds, 'segmentStartSeconds'),
    segmentEndSeconds: positiveNumber(manifest.segmentEndSeconds, 'segmentEndSeconds'),
    minimumMarginSeconds: positiveNumber(manifest.minimumMarginSeconds, 'minimumMarginSeconds'),
});

if (!AUTO_SKIP_FIXTURE.name || !AUTO_SKIP_FIXTURE.filePrefix) {
    throw new Error('Auto-Skip fixture contract requires a non-empty name and filePrefix');
}
if (AUTO_SKIP_FIXTURE.segmentStartSeconds >= AUTO_SKIP_FIXTURE.segmentEndSeconds) {
    throw new Error('Auto-Skip fixture contract requires segmentStartSeconds < segmentEndSeconds');
}

const minimumDurationSeconds =
    AUTO_SKIP_FIXTURE.segmentEndSeconds + AUTO_SKIP_FIXTURE.minimumMarginSeconds;
if (AUTO_SKIP_FIXTURE.durationSeconds < minimumDurationSeconds) {
    throw new Error(
        `Auto-Skip fixture duration ${AUTO_SKIP_FIXTURE.durationSeconds}s is below the `
        + `${minimumDurationSeconds}s segment-end-plus-margin requirement`
    );
}

const PLAYWRIGHT_DEVICE_PROFILE = Object.freeze({
    MaxStreamingBitrate: 140_000_000,
    MaxStaticBitrate: 140_000_000,
    MusicStreamingTranscodingBitrate: 384_000,
    DirectPlayProfiles: [
        {
            Container: 'mp4,m4v',
            AudioCodec: 'aac,mp3,opus,flac,vorbis',
            VideoCodec: 'h264',
            Type: 'Video',
        },
    ],
    TranscodingProfiles: [
        {
            Container: 'ts',
            Type: 'Video',
            VideoCodec: 'h264',
            AudioCodec: 'aac,mp3',
            Protocol: 'hls',
            Context: 'Streaming',
        },
    ],
    ContainerProfiles: [],
    CodecProfiles: [],
    SubtitleProfiles: [],
});

function fixtureLabel(overrideId) {
    return overrideId
        ? `Auto-Skip fixture override ${overrideId}`
        : `Auto-Skip fixture "${AUTO_SKIP_FIXTURE.name}"`;
}

function itemDurationLabel(item) {
    const ticks = Number(item?.RunTimeTicks);
    return Number.isFinite(ticks) && ticks > 0
        ? `${(ticks / TICKS_PER_SECOND).toFixed(1)}s`
        : '<missing>';
}

function itemDiagnostic(item, overrideId = '') {
    const id = String(item?.Id || overrideId || '').trim() || '<missing>';
    return `${fixtureLabel(overrideId)} (ID ${id}, duration ${itemDurationLabel(item)})`;
}

function selectFixtureItem(items, overrideId = '') {
    const rows = Array.isArray(items) ? items : [];
    const normalizedOverride = String(overrideId || '').trim();
    const matches = normalizedOverride
        ? rows.filter((item) => String(item?.Id || '') === normalizedOverride)
        : rows.filter((item) => String(item?.Name || '').trim() === AUTO_SKIP_FIXTURE.name);

    if (matches.length === 0) {
        throw new Error(
            `${itemDiagnostic(undefined, normalizedOverride)} was not found in the current server seed`
        );
    }
    if (matches.length > 1) {
        const details = matches.map((item) => itemDiagnostic(item, normalizedOverride)).join('; ');
        throw new Error(
            `${fixtureLabel(normalizedOverride)} is ambiguous (${matches.length} exact matches): ${details}`
        );
    }

    const item = matches[0];
    if (!String(item?.Id || '').trim()) {
        throw new Error(`${itemDiagnostic(item, normalizedOverride)} resolved without a Jellyfin item ID`);
    }
    return item;
}

function sourceSupportsPlayback(source) {
    return source?.SupportsDirectPlay === true
        || source?.SupportsDirectStream === true
        || source?.SupportsTranscoding === true;
}

function runtimeSeconds(item, playableSource) {
    const sourceTicks = Number(playableSource?.RunTimeTicks);
    const itemTicks = Number(item?.RunTimeTicks);
    if (Number.isFinite(sourceTicks) && sourceTicks > 0) {
        return sourceTicks / TICKS_PER_SECOND;
    }
    if (Number.isFinite(itemTicks) && itemTicks > 0) {
        return itemTicks / TICKS_PER_SECOND;
    }
    return 0;
}

function validatePlaybackInfo(item, playbackInfo, overrideId = '') {
    const label = fixtureLabel(String(overrideId || '').trim());
    const mediaSources = Array.isArray(playbackInfo?.MediaSources)
        ? playbackInfo.MediaSources
        : [];
    const playableSource = mediaSources.find(sourceSupportsPlayback);
    if (!playableSource) {
        throw new Error(
            `${itemDiagnostic(item, String(overrideId || '').trim())} is not playable: `
            + 'PlaybackInfo exposed no direct-play, '
            + 'direct-stream, or transcode source'
        );
    }

    const actualDurationSeconds = runtimeSeconds(item, playableSource);
    if (actualDurationSeconds < minimumDurationSeconds) {
        throw new Error(
            `${label} (ID ${item.Id}, duration ${actualDurationSeconds.toFixed(1)}s) is too short: `
            + `${actualDurationSeconds.toFixed(1)}s actual; `
            + `${minimumDurationSeconds.toFixed(1)}s required `
            + `(segment end ${AUTO_SKIP_FIXTURE.segmentEndSeconds}s + `
            + `${AUTO_SKIP_FIXTURE.minimumMarginSeconds}s margin)`
        );
    }

    return Object.freeze({
        id: String(item.Id),
        name: String(item.Name || AUTO_SKIP_FIXTURE.name),
        durationSeconds: actualDurationSeconds,
        mediaSourceId: String(playableSource.Id || ''),
        playbackMode: playableSource.SupportsDirectPlay === true
            ? 'direct-play'
            : playableSource.SupportsDirectStream === true
                ? 'direct-stream'
                : 'transcode',
    });
}

async function resolveAutoSkipFixture(apiClient, overrideId = '') {
    if (!apiClient || typeof apiClient.getCurrentUserId !== 'function') {
        throw new Error('Auto-Skip fixture resolution requires an authenticated Jellyfin ApiClient');
    }
    const userId = String(apiClient.getCurrentUserId() || '').trim();
    if (!userId) {
        throw new Error('Auto-Skip fixture resolution requires a signed-in Jellyfin user');
    }

    const normalizedOverride = String(overrideId || '').trim();
    let candidates;
    try {
        if (normalizedOverride) {
            candidates = [await apiClient.getItem(userId, normalizedOverride)];
        } else {
            const result = await apiClient.getItems(userId, {
                IncludeItemTypes: 'Movie',
                Recursive: true,
                SearchTerm: AUTO_SKIP_FIXTURE.name,
                Fields: 'MediaSources,Path',
            });
            candidates = result?.Items || [];
        }
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
            `${itemDiagnostic(undefined, normalizedOverride)} lookup failed before navigation: ${detail}`
        );
    }

    const item = selectFixtureItem(candidates, normalizedOverride);
    let playbackInfo;
    try {
        playbackInfo = await apiClient.getPlaybackInfo(
            item.Id,
            {
                UserId: userId,
                AutoOpenLiveStream: false,
                MaxStreamingBitrate: PLAYWRIGHT_DEVICE_PROFILE.MaxStreamingBitrate,
            },
            PLAYWRIGHT_DEVICE_PROFILE
        );
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
            `${itemDiagnostic(item, normalizedOverride)} PlaybackInfo preflight failed `
            + `before navigation: ${detail}`
        );
    }
    return validatePlaybackInfo(item, playbackInfo, normalizedOverride);
}

function playbackStateIsReset(userData) {
    const position = Number(userData?.PlaybackPositionTicks);
    const percentage = userData?.PlayedPercentage;
    return Boolean(userData)
        && Number.isFinite(position)
        && position === 0
        && (percentage === null || percentage === undefined || Number(percentage) === 0)
        && userData.Played === false;
}

function playbackStateDiagnostic(userData) {
    return `PlaybackPositionTicks=${String(userData?.PlaybackPositionTicks)}, `
        + `PlayedPercentage=${String(userData?.PlayedPercentage)}, `
        + `Played=${String(userData?.Played)}`;
}

function errorDetail(error, index) {
    if (error instanceof Error) {
        return `[cleanup ${index}] ${error.name}: ${error.message}\n${error.stack || '<no stack>'}`;
    }
    return `[cleanup ${index}] ${String(error)}`;
}

function preservePrimaryError(primary, cleanupErrors = []) {
    const primaryError = primary instanceof Error
        ? primary
        : new Error(`Auto-Skip test failed with a non-Error value: ${String(primary)}`);
    if (!Array.isArray(cleanupErrors) || cleanupErrors.length === 0) return primaryError;

    const existingCause = primaryError.cause;
    const cleanupCause = new Error(
        `Auto-Skip cleanup failures:\n${cleanupErrors
            .map((error, index) => errorDetail(error, index + 1))
            .join('\n\n')}`,
        existingCause === undefined ? undefined : { cause: existingCause }
    );
    Object.defineProperty(primaryError, 'cause', {
        configurable: true,
        value: cleanupCause,
    });
    return primaryError;
}

function isAutoSkipZeroProgressResponse(candidate, itemId) {
    const normalizedItemId = String(itemId || '').replaceAll('-', '').toLowerCase();
    const bodyItemId = String(candidate?.body?.ItemId || '').replaceAll('-', '').toLowerCase();
    return Boolean(normalizedItemId)
        && candidate?.method === 'POST'
        && candidate?.pathname === '/Sessions/Playing/Progress'
        && Number.isInteger(candidate?.status)
        && candidate.status >= 200
        && candidate.status < 300
        && bodyItemId === normalizedItemId
        && typeof candidate?.body?.PositionTicks === 'number'
        && candidate.body.PositionTicks === 0;
}

async function resetAutoSkipPlaybackState(apiClient, itemId, options = {}) {
    if (!apiClient
        || typeof apiClient.markUnplayed !== 'function'
        || typeof apiClient.getUserData !== 'function') {
        throw new Error('Auto-Skip playback reset requires an authenticated playback-state ApiClient');
    }

    const normalizedItemId = String(itemId || '').trim();
    if (!normalizedItemId) {
        throw new Error('Auto-Skip playback reset requires a Jellyfin item ID');
    }

    const attempts = Number.isInteger(options.attempts) && options.attempts > 0
        ? options.attempts
        : PLAYBACK_RESET_ATTEMPTS;
    const settleMs = Number.isFinite(options.settleMs) && options.settleMs >= 0
        ? options.settleMs
        : PLAYBACK_RESET_SETTLE_MS;
    const wait = typeof options.wait === 'function'
        ? options.wait
        : (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    let verified;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        // Jellyfin's canonical unplayed route clears Played, play count,
        // position, and last-played state together. The generic UserData route
        // leaves some of those fields behind and can lose a race to a late
        // playback-session update during Playwright cleanup.
        await apiClient.markUnplayed(normalizedItemId);
        verified = await apiClient.getUserData(normalizedItemId);
        if (!playbackStateIsReset(verified)) continue;

        // Require a second clean read after a short quiet window. A page-unload
        // beacon can otherwise overwrite the first reset immediately after it
        // is observed, contaminating the next retry or local run.
        await wait(settleMs);
        verified = await apiClient.getUserData(normalizedItemId);
        if (playbackStateIsReset(verified)) return;
    }

    throw new Error(
        `Auto-Skip fixture ${normalizedItemId} playback reset did not converge `
        + `after ${attempts} attempts: ${playbackStateDiagnostic(verified)}`
    );
}

module.exports = {
    AUTO_SKIP_FIXTURE,
    PLAYWRIGHT_DEVICE_PROFILE,
    TICKS_PER_SECOND,
    minimumDurationSeconds,
    isAutoSkipZeroProgressResponse,
    preservePrimaryError,
    resetAutoSkipPlaybackState,
    resolveAutoSkipFixture,
    selectFixtureItem,
    validatePlaybackInfo,
};
