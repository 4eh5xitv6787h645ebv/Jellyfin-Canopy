import { beforeEach, describe, expect, it } from 'vitest';
import type { FeatureLoaderState } from '../core/feature-loader';
import { JC } from '../globals';
import {
    isBookmarksRuntimeApplicable,
    isBookmarksRuntimeEnabled,
    isOsdRatingEnabled,
    isPauseScreenEnabled,
    isPlaybackControlsEnabled,
    isSubtitleStylesEnabled,
    isVideoPlaybackRoute,
} from './playback-policy';

const identity = Object.freeze({ serverId: 'server', userId: 'user', epoch: 1 });
function state(routeKey = '/web/index.html#/home', authenticated = true): FeatureLoaderState {
    return {
        identity: authenticated ? identity : null,
        configGeneration: 1,
        navigationGeneration: 1,
        routeKey,
    };
}

describe('playback lazy-feature policy', () => {
    beforeEach(() => {
        JC.pluginConfig = {};
        JC.currentSettings = {};
    });

    it('matches only video routes across modern and hash dialects', () => {
        expect(isVideoPlaybackRoute(state('/web/index.html#/video'))).toBe(true);
        expect(isVideoPlaybackRoute(state('/web/video?item=1'))).toBe(true);
        expect(isVideoPlaybackRoute(state('/web/index.html#/home'))).toBe(false);
        expect(isVideoPlaybackRoute(state('/web/index.html#/videography'))).toBe(false);
    });

    it('keeps disabled and anonymous features off the cold home path', () => {
        JC.currentSettings = { disableCustomSubtitleStyles: true, pauseScreenEnabled: false };
        JC.pluginConfig = { ShowRatingInPlayer: false, BookmarksEnabled: false };
        const anonymous = state('/web/index.html#/video', false);
        expect(isPlaybackControlsEnabled(anonymous)).toBe(false);
        expect(isSubtitleStylesEnabled(state())).toBe(false);
        expect(isOsdRatingEnabled(state())).toBe(false);
        expect(isPauseScreenEnabled(state())).toBe(false);
        expect(isBookmarksRuntimeEnabled(state())).toBe(false);
    });

    it('reads live settings/config on every decision without cached gates', () => {
        const current = state('/web/index.html#/video');
        JC.currentSettings = { disableCustomSubtitleStyles: true, pauseScreenEnabled: false };
        JC.pluginConfig = { ShowRatingInPlayer: false, BookmarksEnabled: false };
        expect(isSubtitleStylesEnabled(current)).toBe(false);
        expect(isOsdRatingEnabled(current)).toBe(false);
        expect(isPauseScreenEnabled(current)).toBe(false);
        expect(isBookmarksRuntimeEnabled(current)).toBe(false);

        JC.currentSettings = { disableCustomSubtitleStyles: false, pauseScreenEnabled: true };
        JC.pluginConfig = { ShowRatingInPlayer: true, BookmarksEnabled: true };
        expect(isSubtitleStylesEnabled(current)).toBe(true);
        expect(isOsdRatingEnabled(current)).toBe(true);
        expect(isPauseScreenEnabled(current)).toBe(true);
        expect(isBookmarksRuntimeEnabled(current)).toBe(true);
    });

    it('loads bookmark CRUD on video and management routes only', () => {
        expect(isBookmarksRuntimeApplicable(state('/web/index.html#/video'))).toBe(true);
        expect(isBookmarksRuntimeApplicable(state('/web/index.html#/bookmarks'))).toBe(true);
        expect(isBookmarksRuntimeApplicable(state('/web/index.html#/bookmarks-extra'))).toBe(false);
        expect(isBookmarksRuntimeApplicable(state('/web/index.html#/home'))).toBe(false);
    });
});
