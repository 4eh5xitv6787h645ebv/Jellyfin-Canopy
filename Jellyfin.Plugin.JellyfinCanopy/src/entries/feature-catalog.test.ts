import { beforeEach, describe, expect, it } from 'vitest';
import type { FeatureLoaderState } from '../core/feature-loader';
import { JC } from '../globals';
import { builtInFeatureDescriptors } from './feature-catalog';

const state: FeatureLoaderState = {
    identity: { serverId: 'server', userId: 'user', epoch: 1 },
    configGeneration: 1,
    navigationGeneration: 1,
    routeKey: '/web/#/details?id=item',
};

function descriptor(id: string) {
    const value = builtInFeatureDescriptors.find((item) => item.id === id);
    if (!value) throw new Error(`missing descriptor ${id}`);
    return value;
}

beforeEach(() => {
    JC.pluginConfig = {};
    JC.currentSettings = {};
    JC.currentUser = undefined;
});

describe('built-in detail integration catalog', () => {
    it('gates the administrator Maintainerr page by both switches and exact route', () => {
        const item = descriptor('maintainerr-page');
        JC.currentUser = { Policy: { IsAdministrator: true } };
        JC.pluginConfig = { MaintainerrEnabled: true, MaintainerrPageEnabled: true };

        expect(item.scope).toBe('navigation');
        expect(item.restartOnConfigChange).toBe(true);
        expect(item.isEnabled(state)).toBe(true);
        expect(item.isApplicable({ ...state, routeKey: '/web/#/maintainerr' })).toBe(true);
        expect(item.isApplicable({ ...state, routeKey: '/web/#/maintainerr?tab=rules' })).toBe(true);
        expect(item.isApplicable({ ...state, routeKey: '/web/#/maintainerr-extra' })).toBe(false);
        JC.currentUser = { Policy: { IsAdministrator: false } };
        expect(item.isEnabled(state)).toBe(false);
        JC.currentUser = { Policy: { IsAdministrator: true } };
        JC.pluginConfig.MaintainerrPageEnabled = false;
        expect(item.isEnabled(state)).toBe(false);
        JC.pluginConfig.MaintainerrPageEnabled = true;
        JC.pluginConfig.MaintainerrEnabled = false;
        expect(item.isEnabled(state)).toBe(false);
    });

    it('gates Maintainerr item status by role and shares the details owner', () => {
        const item = descriptor('maintainerr-item-status');
        JC.pluginConfig = {
            MaintainerrEnabled: true,
            MaintainerrItemStatusEnabled: true,
            MaintainerrItemStatusForUsers: false,
        };
        JC.currentUser = { Policy: { IsAdministrator: true } };
        expect(item.dependsOn).toEqual(['details-enhancements']);
        expect(item.restartOnConfigChange).toBe(true);
        expect(item.isEnabled(state)).toBe(true);
        expect(item.isApplicable(state)).toBe(true);
        expect(item.isApplicable({ ...state, routeKey: '/web/#/home' })).toBe(false);

        JC.currentUser = { Policy: { IsAdministrator: false } };
        expect(item.isEnabled(state)).toBe(false);
        JC.pluginConfig.MaintainerrItemStatusForUsers = true;
        expect(item.isEnabled(state)).toBe(true);
        expect(descriptor('details-enhancements').isEnabled(state)).toBe(true);
        JC.pluginConfig.MaintainerrItemStatusEnabled = false;
        expect(item.isEnabled(state)).toBe(false);
    });

    it('activates the event shell after its settings-launcher dependency', () => {
        const settingsIndex = builtInFeatureDescriptors.findIndex((item) => item.id === 'settings-launcher');
        const eventsIndex = builtInFeatureDescriptors.findIndex((item) => item.id === 'enhanced-events');
        expect(settingsIndex).toBeGreaterThanOrEqual(0);
        expect(eventsIndex).toBeGreaterThan(settingsIndex);
        expect(descriptor('enhanced-events').dependsOn).toEqual(['settings-launcher']);
        expect(descriptor('enhanced-events').isEnabled(state)).toBe(true);
        expect(descriptor('enhanced-events').isEnabled({ ...state, identity: null })).toBe(false);
    });

    it('orders bookmark runtime before its dependent management page', () => {
        const runtimeIndex = builtInFeatureDescriptors.findIndex((item) => item.id === 'bookmarks-runtime');
        const pageIndex = builtInFeatureDescriptors.findIndex((item) => item.id === 'bookmarks-page');
        expect(runtimeIndex).toBeGreaterThanOrEqual(0);
        expect(runtimeIndex).toBeLessThan(pageIndex);
        expect(descriptor('bookmarks-page').dependsOn).toEqual(['bookmarks-runtime']);
    });

    it('restarts the requests page when its server-projected policy changes', () => {
        expect(descriptor('requests-page').restartOnConfigChange).toBe(true);
    });

    it('restarts the calendar when requester attribution configuration changes', () => {
        expect(descriptor('calendar-page').restartOnConfigChange).toBe(true);
    });

    it('keeps enabled remove actions identity-global for event-shell menus on any route', () => {
        const removeActions = descriptor('remove-home-actions');
        JC.currentSettings = { removeContinueWatchingEnabled: true };

        expect(removeActions.scope).toBe('identity');
        expect(removeActions.restartOnConfigChange).toBe(true);
        expect(removeActions.isEnabled(state)).toBe(true);
        for (const routeKey of ['/web/#/home', '/web/#/details?id=item', '/web/#/nextup']) {
            expect(removeActions.isApplicable({ ...state, routeKey })).toBe(true);
        }

        JC.currentSettings.removeContinueWatchingEnabled = false;
        expect(removeActions.isEnabled(state)).toBe(false);
        expect(removeActions.isEnabled({ ...state, identity: null })).toBe(false);
    });

    it('loads activity icons for the dashboard widget without widening to unrelated routes', () => {
        const activityIcons = descriptor('activity-icons');
        JC.pluginConfig = { ColoredActivityIconsEnabled: true };

        for (const routeKey of [
            '/web/#/dashboard',
            '/web/#/dashboard?tab=home',
            '/web/#/dashboard/activity',
            '/web/#/configurationpage?name=plugin',
        ]) expect(activityIcons.isApplicable({ ...state, routeKey })).toBe(true);
        for (const routeKey of [
            '/web/#/home',
            '/web/#/details?id=item',
            '/web/#/dashboard/plugins',
        ]) expect(activityIcons.isApplicable({ ...state, routeKey })).toBe(false);

        expect(activityIcons.isEnabled(state)).toBe(true);
        JC.pluginConfig.ColoredActivityIconsEnabled = false;
        expect(activityIcons.isEnabled(state)).toBe(false);
        expect(activityIcons.isEnabled({ ...state, identity: null })).toBe(false);
    });

    it('keeps every detail integration off non-detail routes and before identity', () => {
        for (const id of ['details-enhancements', 'elsewhere', 'reviews', 'arr-detail-links', 'letterboxd-links']) {
            const item = descriptor(id);
            expect(item.isApplicable({ ...state, routeKey: '/web/#/home' })).toBe(false);
            expect(item.isEnabled({ ...state, identity: null })).toBe(false);
        }
    });

    it('loads details for the file-source setting without coupling it to poster source tags', () => {
        const details = descriptor('details-enhancements');
        JC.pluginConfig = {};
        JC.currentSettings = {
            showFileSource: true,
            qualityTagsEnabled: false,
            showSourceTag: false,
        };
        expect(details.isEnabled(state)).toBe(true);

        JC.currentSettings = {
            showFileSource: false,
            qualityTagsEnabled: true,
            showSourceTag: true,
        };
        expect(details.isEnabled(state)).toBe(false);
    });

    it('enforces TMDB prerequisites independently for release dates, Elsewhere, and TMDB reviews', () => {
        JC.currentSettings = { showWatchProgress: false };
        JC.pluginConfig = {
            ElsewhereEnabled: true,
            ShowReleaseDates: true,
            ShowReviews: true,
            TmdbEnabled: false,
        };
        expect(descriptor('details-enhancements').isEnabled(state)).toBe(false);
        expect(descriptor('elsewhere').isEnabled(state)).toBe(false);
        expect(descriptor('reviews').isEnabled(state)).toBe(false);
        JC.pluginConfig.TmdbEnabled = true;
        expect(descriptor('details-enhancements').isEnabled(state)).toBe(true);
        expect(descriptor('elsewhere').isEnabled(state)).toBe(true);
        expect(descriptor('reviews').isEnabled(state)).toBe(true);
        JC.pluginConfig.TmdbEnabled = false;
        JC.pluginConfig.ShowUserReviews = true;
        expect(descriptor('reviews').isEnabled(state)).toBe(true);
    });

    it('loads Arr search only for an administrator with a configured enabled instance', () => {
        const item = descriptor('arr-search');
        JC.pluginConfig = {
            ArrSearchEnabled: true,
            RadarrInstances: [{ Enabled: true, Url: 'https://radarr.example' }],
        };
        expect(item.isEnabled(state)).toBe(false);
        JC.currentUser = { Policy: { IsAdministrator: true } };
        expect(item.isEnabled(state)).toBe(true);
        JC.pluginConfig.RadarrInstances = [{ Enabled: false, Url: 'https://radarr.example' }];
        expect(item.isEnabled(state)).toBe(false);
        JC.pluginConfig.RadarrUrl = 'https://legacy-radarr.example';
        expect(item.isEnabled(state)).toBe(true);
        JC.pluginConfig.ArrSearchEnabled = false;
        expect(item.isEnabled(state)).toBe(false);
    });

    it('gates the remaining integrations from their exact live switches', () => {
        JC.pluginConfig = {
            ArrTagsShowAsLinks: true,
            LetterboxdEnabled: true,
        };
        expect(descriptor('arr-detail-links').isEnabled(state)).toBe(true);
        expect(descriptor('letterboxd-links').isEnabled(state)).toBe(true);
        expect(descriptor('details-enhancements').isEnabled(state)).toBe(false);
        JC.pluginConfig.HiddenContentEnabled = true;
        expect(descriptor('details-enhancements').isEnabled(state)).toBe(true);
        JC.pluginConfig.HiddenContentEnabled = false;
        JC.pluginConfig.SpoilerBlurEnabled = true;
        expect(descriptor('details-enhancements').isEnabled(state)).toBe(true);
    });
});
