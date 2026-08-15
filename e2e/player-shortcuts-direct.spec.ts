// Direct player-shortcut browser proof against a real Jellyfin 12 playback
// surface. Server session/command responses are intercepted only at the exact
// remote-control contract so the shipped Canopy client, lifecycle, media
// element, and host-dialog boundaries execute in the browser.
import { expect, loginAs, showRoute, test } from './fixtures/auth';
import { api, authenticate, type Session } from './fixtures/api';
import {
    preservePrimaryError,
    resetAutoSkipPlaybackState,
    resolveAutoSkipFixture,
    type FixtureApiClient,
    type JellyfinItem,
    type PlaybackInfo,
    type PlaybackStateApiClient,
} from '../scripts/e2e/auto-skip-fixture';

interface ItemList {
    Items?: JellyfinItem[];
}

interface UserData {
    PlaybackPositionTicks?: number;
    PlayedPercentage?: number;
    Played?: boolean;
}

interface ShortcutCommand {
    Name?: string;
    Arguments?: { Index?: string };
}

function queryString(options: Record<string, unknown>): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) {
        if (value !== undefined && value !== null) params.set(key, String(value));
    }
    return params.toString();
}

function fixtureApi(baseURL: string, session: Session): FixtureApiClient {
    return {
        getCurrentUserId: () => session.userId,
        getItems: async (userId, options) =>
            (await api<ItemList>(
                baseURL,
                `/Items?${queryString({ ...options, UserId: userId })}`,
                session.token
            )) ?? { Items: [] },
        getItem: async (userId, itemId) => {
            const item = await api<JellyfinItem>(
                baseURL,
                `/Users/${encodeURIComponent(userId)}/Items/${encodeURIComponent(itemId)}?Fields=MediaSources,Path`,
                session.token
            );
            if (!item) throw new Error(`item ${itemId} returned an empty response`);
            return item;
        },
        getPlaybackInfo: async (itemId, options, deviceProfile) => {
            const info = await api<PlaybackInfo>(
                baseURL,
                `/Items/${encodeURIComponent(itemId)}/PlaybackInfo`,
                session.token,
                {
                    method: 'POST',
                    body: JSON.stringify({ ...options, DeviceProfile: deviceProfile }),
                }
            );
            if (!info) throw new Error(`PlaybackInfo for ${itemId} returned an empty response`);
            return info;
        },
    };
}

function playbackStateApi(baseURL: string, session: Session): PlaybackStateApiClient {
    return {
        markUnplayed: (itemId) => api<UserData>(
            baseURL,
            `/UserPlayedItems/${encodeURIComponent(itemId)}?userId=${encodeURIComponent(session.userId)}`,
            session.token,
            { method: 'DELETE' }
        ),
        getUserData: (itemId) => api<UserData>(
            baseURL,
            `/UserItems/${encodeURIComponent(itemId)}/UserData?userId=${encodeURIComponent(session.userId)}`,
            session.token
        ),
    };
}

test.describe('direct player shortcuts', () => {
    test('track, aspect, and playback-info actions stay on direct browser surfaces', async ({
        page,
        consoleErrors,
        baseURL,
    }) => {
        if (!baseURL) throw new Error('Direct player-shortcut E2E requires a configured baseURL');
        const session = await authenticate(
            baseURL,
            process.env.JF_ADMIN_USER || 'jc_arradmin',
            process.env.JF_ADMIN_PASS || 'Test669Pw!x'
        );
        const resolved = await resolveAutoSkipFixture(fixtureApi(baseURL, session), process.env.JF_AUTOSKIP_ITEM || '');
        const resetApi = playbackStateApi(baseURL, session);
        await resetAutoSkipPlaybackState(resetApi, resolved.id);

        await page.addInitScript(() => window.localStorage.setItem('layout', 'experimental'));
        let bodyError: unknown;
        const cleanupErrors: unknown[] = [];
        try {
            await loginAs(page, 'admin', consoleErrors);
            await showRoute(page, `/details?id=${resolved.id}`);
            const playButton = page.locator('.btnPlay:visible').first();
            await expect(playButton).toBeVisible();
            await playButton.click();
            await page.waitForFunction(
                () => {
                    const video = document.querySelector('video');
                    return !!video?.currentSrc && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
                },
                undefined,
                { timeout: 30_000 }
            );
            const surface = await page.evaluate(() => {
                const video = document.querySelector('video')!;
                const src = video.currentSrc || video.src;
                let mediaSourceId: string | null = null;
                try {
                    mediaSourceId = new URL(src).searchParams.get('MediaSourceId');
                } catch { /* blob sources intentionally have no query identity */ }
                return {
                    deviceId: (window as unknown as { ApiClient: { deviceId(): string } }).ApiClient.deviceId(),
                    mediaSourceId,
                };
            });
            expect(surface.deviceId, 'the browser exposes its caller-owned device id').not.toBe('');

            const commandBodies: ShortcutCommand[] = [];
            await page.route('**/Sessions?ControllableByUserId=*', async (route) => {
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify([{
                        Id: 'jc-e2e-direct-session',
                        DeviceId: surface.deviceId,
                        PlayState: {
                            AudioStreamIndex: 1,
                            SubtitleStreamIndex: 2,
                            PlayMethod: 'DirectPlay',
                            MediaSourceId: surface.mediaSourceId ?? undefined,
                        },
                        NowPlayingItem: {
                            Id: resolved.id,
                            Container: 'mp4',
                            MediaStreams: [
                                { Index: 1, Type: 'Audio', DisplayTitle: 'English AAC' },
                                { Index: 4, Type: 'Audio', DisplayTitle: 'German AC3' },
                                { Index: 2, Type: 'Subtitle', DisplayTitle: 'English SRT' },
                                { Index: 3, Type: 'Subtitle', DisplayTitle: 'German SRT' },
                            ],
                        },
                    }]),
                });
            });
            await page.route('**/Sessions/jc-e2e-direct-session/Command', async (route) => {
                commandBodies.push(route.request().postDataJSON() as ShortcutCommand);
                await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
            });

            await page.evaluate(() => {
                (window as unknown as { JellyfinCanopy: { cycleSubtitleTrack(): void } })
                    .JellyfinCanopy.cycleSubtitleTrack();
            });
            await expect.poll(() => commandBodies.length).toBe(1);
            expect(commandBodies[0]).toEqual({
                Name: 'SetSubtitleStreamIndex',
                Arguments: { Index: '3' },
            });
            await expect(page.locator('.actionSheetContent:visible')).toHaveCount(0);

            const aspect = await page.evaluate(() => {
                window.localStorage.setItem('aspectRatio', 'auto');
                const JC = (window as unknown as {
                    JellyfinCanopy: { cycleAspect(): void };
                }).JellyfinCanopy;
                JC.cycleAspect();
                const video = document.querySelector('video')!;
                return {
                    stored: window.localStorage.getItem('aspectRatio'),
                    objectFit: video.style.objectFit,
                };
            });
            expect(aspect).toEqual({ stored: 'cover', objectFit: 'cover' });
            await expect(page.locator('.actionSheetContent:visible')).toHaveCount(0);

            await page.evaluate(() => {
                (window as unknown as { JellyfinCanopy: { togglePlaybackInfo(): void } })
                    .JellyfinCanopy.togglePlaybackInfo();
            });
            const overlay = page.locator('[data-jc-playback-info="true"]');
            await expect(overlay).toBeVisible();
            await expect(overlay).toHaveAttribute('role', 'region');
            await expect(overlay).toContainText('DirectPlay');
            await expect(page.locator('.actionSheetContent:visible')).toHaveCount(0);

            expect(consoleErrors.unexpected5xx(), 'unexpected 5xx responses').toEqual([]);
            expect(consoleErrors.real(), 'unexpected console errors').toEqual([]);
            const pluginFourxx = consoleErrors
                .unexpected4xx()
                .filter((response) => /\/JellyfinCanopy\//i.test(response.url));
            expect(pluginFourxx, 'no 4xx from plugin endpoints').toEqual([]);
        } catch (error) {
            bodyError = error;
        }

        try {
            await page.goto('about:blank', { waitUntil: 'load' });
        } catch (error) {
            cleanupErrors.push(error);
        }
        try {
            await resetAutoSkipPlaybackState(resetApi, resolved.id);
        } catch (error) {
            cleanupErrors.push(error);
        }
        if (bodyError) throw preservePrimaryError(bodyError, cleanupErrors);
        if (cleanupErrors.length > 0) {
            throw preservePrimaryError(cleanupErrors[0], cleanupErrors.slice(1));
        }
    });
});
