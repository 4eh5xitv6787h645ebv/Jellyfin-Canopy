import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JC } from '../globals';
import { createTestFeatureScope, type TestFeatureScope } from '../test/feature-scope';
import { activate as activateBookmarks } from './bookmarks-runtime';
import { activate as activateOsdRating } from './osd-rating';
import { activate as activatePauseScreen } from './pause-screen';
import { activate as activatePlayback } from './playback-controls';
import { activate as activateSubtitles } from './subtitle-styles';

describe('playback feature activation ownership', () => {
    const active: TestFeatureScope[] = [];

    beforeEach(() => {
        document.body.innerHTML = '';
        document.head.querySelectorAll('[data-jc-identity-owned="true"]').forEach((node) => node.remove());
        window.history.replaceState(null, '', '/web/index.html#/video');
        JC.identity.transition('playback-server', 'playback-user', 'playback-entry-test');
        JC.currentSettings = { pauseScreenEnabled: false, disableCustomSubtitleStyles: false };
        JC.pluginConfig = { ShowRatingInPlayer: true, BookmarksEnabled: true };
        JC.isVideoPage = () => false;
    });

    afterEach(async () => {
        for (const feature of active.splice(0).reverse()) await feature.dispose();
        JC.identity.transition('', '', 'playback-entry-cleanup');
        document.body.innerHTML = '';
        window.history.replaceState(null, '', '/web/index.html#/home');
    });

    it('rejects stale scopes before publishing or tracking anything', () => {
        const activators = [activatePlayback, activateSubtitles, activateOsdRating, activatePauseScreen, activateBookmarks];
        for (const activate of activators) {
            const feature = createTestFeatureScope();
            feature.setCurrent(false);
            activate(feature.scope);
            expect(feature.cleanups).toHaveLength(0);
        }
    });

    it('rolls back a scope that becomes stale during installation', async () => {
        const video = document.createElement('video');
        video.playbackRate = 1;
        document.body.appendChild(video);
        const feature = createTestFeatureScope();
        let checks = 0;
        feature.scope.isCurrent = () => ++checks === 1;

        activatePlayback(feature.scope);
        expect(feature.cleanups).toHaveLength(0);
        JC.adjustPlaybackSpeed?.('increase');
        expect(video.playbackRate).toBe(1);
    });

    it('retains frozen facade identity while delegates activate, dispose twice, and reactivate', async () => {
        const firstPlayback = createTestFeatureScope();
        active.push(firstPlayback);
        activatePlayback(firstPlayback.scope);
        const adjust = JC.adjustPlaybackSpeed;
        expect(typeof adjust).toBe('function');

        const firstBookmarks = createTestFeatureScope();
        active.push(firstBookmarks);
        activateBookmarks(firstBookmarks.scope);
        const bookmarks = JC.bookmarks;
        expect(Object.isFrozen(bookmarks)).toBe(true);

        await firstPlayback.dispose();
        await firstPlayback.dispose();
        await firstBookmarks.dispose();
        await firstBookmarks.dispose();

        const secondPlayback = createTestFeatureScope();
        active.push(secondPlayback);
        activatePlayback(secondPlayback.scope);
        const secondBookmarks = createTestFeatureScope();
        active.push(secondBookmarks);
        activateBookmarks(secondBookmarks.scope);

        expect(JC.adjustPlaybackSpeed).toBe(adjust);
        expect(JC.bookmarks).toBe(bookmarks);
    });
});
