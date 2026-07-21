import type { Page } from 'playwright/test';
import {
    assertNoRuntimeErrors,
    expect,
    loginAs,
    showRoute,
    test,
    USERS,
    waitForHash,
} from './fixtures/auth';
import { api, authenticate, PLUGIN_ID } from './fixtures/api';
import { installThemeStudioVisualFont } from './helpers/theme-studio-visual';

const CONFIG_PATH = `/Plugins/${PLUGIN_ID}/Configuration`;

interface ItemList {
    Items?: Array<{ Id?: string; Name?: string }>;
}

interface LifecycleProbe {
    recording: boolean;
    observers: number;
    timers: number;
    listeners: number;
}

interface PlaybackEvidence {
    node: HTMLVideoElement;
    src: string;
    currentTime: number;
    paused: boolean;
}

async function seedModernLayout(page: Page): Promise<void> {
    await page.addInitScript(() => {
        window.localStorage.setItem('layout', 'experimental');
        const nativeMatchMedia = window.matchMedia.bind(window);
        window.matchMedia = ((query: string): MediaQueryList => {
            const list = nativeMatchMedia(query);
            if (query !== '(pointer: coarse)') return list;
            return new Proxy(list, {
                get(target, property, receiver) {
                    if (property === 'matches') return true;
                    const value = Reflect.get(target, property, receiver) as unknown;
                    return typeof value === 'function' ? value.bind(target) : value;
                },
            });
        }) as typeof window.matchMedia;
    });
}

async function installLifecycleProbe(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const probe: LifecycleProbe = { recording: false, observers: 0, timers: 0, listeners: 0 };
        Object.defineProperty(window, '__jcThemeMediaLifecycle', { configurable: true, value: probe });

        const NativeMutationObserver = window.MutationObserver;
        window.MutationObserver = class extends NativeMutationObserver {
            constructor(callback: MutationCallback) {
                if (probe.recording) probe.observers += 1;
                super(callback);
            }
        };

        const nativeSetTimeout = window.setTimeout.bind(window);
        window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
            if (probe.recording) probe.timers += 1;
            return nativeSetTimeout(handler, timeout, ...args);
        }) as typeof window.setTimeout;
        const nativeSetInterval = window.setInterval.bind(window);
        window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
            if (probe.recording) probe.timers += 1;
            return nativeSetInterval(handler, timeout, ...args);
        }) as typeof window.setInterval;

        const nativeAddEventListener = EventTarget.prototype.addEventListener;
        EventTarget.prototype.addEventListener = function addEventListener(
            type: string,
            callback: EventListenerOrEventListenerObject | null,
            options?: AddEventListenerOptions | boolean,
        ): void {
            if (probe.recording) probe.listeners += 1;
            nativeAddEventListener.call(this, type, callback, options);
        };
    });
}

async function waitForThemeRuntime(page: Page, breakpoint: string): Promise<void> {
    await page.waitForFunction((expected) => {
        const root = document.documentElement;
        return root.getAttribute('data-jc-theme-active') === 'true'
            && root.getAttribute('data-jc-theme-breakpoint') === expected
            && document.querySelectorAll('#jc-theme-studio-committed').length === 1;
    }, breakpoint);
}

async function previewMediaTheme(page: Page): Promise<boolean> {
    return page.evaluate(() => {
        const runtime = window.JellyfinCanopy.core.themeStudio;
        const draft = runtime?.getConfiguration();
        const active = draft?.Profiles.find((profile) => profile.Id === draft.ActiveProfileId)
            ?? draft?.Profiles[0];
        if (!runtime || !draft || !active) throw new Error('Theme Studio configuration is unavailable');
        active.BasePreset = 'canopy';
        active.PresetVersion = 1;
        active.FreezePresetVersion = true;
        active.Palette = 'canopy-night';
        active.Accent = 'palette';
        active.Mode = 'dark';
        active.Tokens = {};
        return runtime.preview(draft, { allowScheduling: false });
    });
}

async function mountMediaFixture(page: Page): Promise<void> {
    await page.evaluate(() => {
        document.getElementById('jc-theme-media-fixture')?.remove();
        document.getElementById('jc-theme-media-fixture-style')?.remove();
        const style = document.createElement('style');
        style.id = 'jc-theme-media-fixture-style';
        style.textContent = `
          #jc-theme-media-fixture {
            position: absolute; inset: 0 0 auto; z-index: 1000000; box-sizing: border-box;
            min-height: 100dvh;
            display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
            align-content: start; gap: var(--jc-card-gap); overflow: visible;
            padding: max(var(--jc-page-gutter), var(--jc-safe-area-top)) var(--jc-page-gutter)
              max(var(--jc-page-gutter), var(--jc-safe-area-bottom));
            background: var(--jc-color-canvas); color: var(--jc-color-text);
            font-family: var(--jc-type-family-ui);
          }
          #jc-theme-media-fixture [data-surface] {
            box-sizing: border-box; min-width: 0; padding: var(--jc-control-gap);
            border: var(--jc-shape-border-width) solid var(--jc-color-divider);
            border-radius: var(--jc-shape-card-radius); background: var(--jc-color-surface);
          }
          #jc-theme-media-fixture h2 { margin: 0 0 var(--jc-control-gap); font-size: 1rem; }
          #jc-theme-media-fixture button { border: 0; background: var(--jc-color-elevated); color: inherit; }
          #jc-theme-media-fixture .videoOsdBottom {
            position: relative !important; inset: auto !important; padding: 1rem !important;
            pointer-events: auto; display: flex; flex-direction: column; border-radius: var(--jc-shape-card-radius);
          }
          #jc-theme-media-fixture .videoOsdBottom .buttons { gap: .25rem; }
          #jc-theme-media-fixture .videoSubtitles { position: relative; margin: .75rem 0; text-align: center; }
          #jc-theme-media-fixture .sliderBubble { position: relative; transform: none; inline-size: fit-content; }
          #jc-theme-media-fixture [data-jc-frame-overlay] { position: relative !important; inset: auto !important; transform: none !important; }
          #jc-theme-media-fixture .jc-bookmark-marker {
            position: relative !important; inset: auto !important; transform: none !important;
            inline-size: max(2.75rem, 44px) !important; flex: 0 0 max(2.75rem, 44px) !important;
            align-self: center; justify-self: center; background: transparent !important;
          }
          #jc-theme-media-fixture #pause-screen-content { min-height: 4rem; padding: .75rem; border-radius: var(--jc-shape-card-radius); }
          #jc-theme-media-fixture .nowPlayingPage { padding: 0 !important; }
          #jc-theme-media-fixture .remoteControlContent { min-width: 0; padding: 0 !important; }
          #jc-theme-media-fixture .nowPlayingInfoContainer { padding: .75rem; flex-direction: row !important; height: auto; }
          #jc-theme-media-fixture .nowPlayingPageImage { inline-size: 5rem; block-size: 5rem; background: linear-gradient(135deg, var(--jc-color-primary), var(--jc-color-secondary)); }
          #jc-theme-media-fixture .nowPlayingInfoControls { margin-inline-start: .75rem; min-width: 0; }
          #jc-theme-media-fixture .playlistSection { min-width: 0; }
          #jc-theme-media-fixture .playlistSectionButton { display: flex; align-items: center; gap: .25rem; }
          #jc-theme-media-fixture .nowPlayingPlaylist { margin-top: .75rem; padding: .5rem; }
          #jc-theme-media-fixture :where([role="status"], [role="alert"]) { margin-top: .5rem; }
          #jc-theme-media-fixture .programGrid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
          #jc-theme-media-fixture .programCell { position: relative; inset: auto; gap: .25rem; min-height: 3.5rem; padding: .5rem !important; }
          #jc-theme-media-fixture .guide-channelHeaderCell { gap: .5rem; padding: .5rem !important; }
          #jc-theme-media-fixture .guideChannelName { margin-inline: 0 !important; }
          #jc-theme-media-fixture .guideProgramIndicator { margin-inline: .25rem !important; }
          #jc-theme-media-fixture #bookPlayerContainer { position: relative; inset: auto; width: auto; height: auto; }
          #jc-theme-media-fixture #bookPlayer { min-height: 4rem; padding: .5rem; }
          #jc-theme-media-fixture .bookOsd { position: relative; inset: auto; }
          #jc-theme-media-fixture #dialogToc { width: auto; margin-top: .5rem; padding: .5rem; }
          #jc-theme-media-fixture .toc { margin: 0; padding: 0 1.25rem !important; }
          @media (max-width: 899px) {
            #jc-theme-media-fixture { grid-template-columns: minmax(0, 1fr); }
            #jc-theme-media-fixture .programGrid { inline-size: calc(100% - 2px); }
          }
        `;
        document.head.append(style);

        const fixture = document.createElement('main');
        fixture.id = 'jc-theme-media-fixture';
        fixture.innerHTML = `
          <section data-surface="player">
            <h2>Player · captions · Canopy controls</h2>
            <div class="videoOsdBottom">
              <div class="buttons focuscontainer-x">
                <button type="button" aria-label="Previous">◀</button>
                <button type="button" aria-label="Play">▶</button>
                <button type="button" aria-label="Next">▶▶</button>
                <span id="jc-osd-rating-container"><span class="jc-chip"><span class="jc-text">94%</span></span></span>
              </div>
              <div class="videoSubtitles"><span class="videoSubtitlesInner">A long subtitle remains readable in every modern viewport.</span></div>
              <div class="sliderBubble"><span class="sliderBubbleText">00:42</span></div>
              <div class="chapterThumbContainer">Trickplay · Chapter 4</div>
              <button class="jc-bookmark-marker" data-jc-identity-owned="true" type="button" aria-label="Jump to bookmark">⌖</button>
              <div data-jc-frame-overlay="true">Frame step · 60 fps</div>
            </div>
            <div id="pause-screen-content"><strong>Paused</strong><div id="pause-screen-plot">Long metadata wraps without covering the player controls.</div></div>
          </section>
          <section data-surface="music">
            <h2>Music · now playing</h2>
            <div class="nowPlayingPage">
              <div class="remoteControlContent padded-left padded-right">
                <div class="nowPlayingInfoContainer">
                  <div class="nowPlayingPageImageContainer"><div class="nowPlayingPageImage"></div></div>
                  <div class="nowPlayingInfoControls">
                    <strong class="nowPlayingPageTitle">A Very Long Track Name for Layout Coverage</strong>
                    <span class="nowPlayingArtist">Canopy Ensemble</span>
                    <div class="nowPlayingPositionSliderContainer"><input class="nowPlayingPositionSlider" aria-label="Track position" type="range" value="42"></div>
                    <div class="nowPlayingInfoButtons"><button type="button">◀</button><button type="button">▶</button><button type="button">▶▶</button></div>
                    <div class="nowPlayingLoading" role="status" aria-live="polite">Loading now-playing metadata…</div>
                  </div>
                </div>
                <div class="remoteControlSection" hidden></div>
                <div class="playlistSection">
                  <div class="playlistSectionButton"><div class="nowPlayingVolumeSliderContainer"><input class="nowPlayingVolumeSlider" aria-label="Volume" type="range" value="70"></div></div>
                  <div class="nowPlayingPlaylist"><div class="listItem selected" aria-current="true">Current queue item · 04:12</div><div class="listItem">Next queue item · 03:55</div></div>
                </div>
              </div>
            </div>
          </section>
          <section data-surface="guide">
            <h2>Live TV · guide</h2>
            <div class="tvguide">
              <button class="guide-channelHeaderCell"><span class="guideChannelNumber">101</span><span class="guideChannelName">Canopy News</span></button>
              <div class="programGrid">
                <button class="programCell programCell-active" aria-current="true"><span class="guideProgramNameText">Now: Morning News</span></button>
                <button class="programCell"><span class="guideProgramNameText">Documentary</span><span class="guideProgramIndicator newTvProgram">New</span></button>
                <button class="programCell"><span class="guideProgramNameText">Live Event</span><span class="guideProgramIndicator liveTvProgram">Live</span></button>
              </div>
              <div class="guideRequiresUnlock">Unlock Live TV to load guide programs.</div>
              <div class="noItemsMessage" role="status">No guide programs match this filter.</div>
            </div>
          </section>
          <section class="booksPage" data-surface="reader">
            <h2>Books · reader</h2>
            <div class="cardImageContainer" aria-label="Book cover">Canopy Reader</div>
            <div id="bookPlayerContainer">
              <div id="bookPlayer">Reader canvas</div>
              <div class="bookOsd"><div class="bookOsdRow"><button class="bookplayerButton" type="button">☰</button><span class="bookOsdTitle">A Long Book Title That Must Truncate Safely</span></div></div>
              <div id="dialogToc"><button type="button" aria-label="Close table of contents"><span class="bookplayerButtonIcon">×</span></button><ol class="toc"><li><a href="#chapter-one">Chapter one</a></li><li><a href="#chapter-two">Chapter two</a></li></ol></div>
              <div class="bookplayerErrorMsg" role="alert">The reader could not load this chapter.</div>
            </div>
          </section>
        `;
        document.body.append(fixture);
    });
}

test.describe('Theme Studio modern media surfaces', () => {
    let original: Record<string, unknown>;

    test.beforeAll(async ({ baseURL }) => {
        const session = await authenticate(baseURL!, USERS.admin.username, USERS.admin.password);
        const configuration = await api<Record<string, unknown>>(baseURL!, CONFIG_PATH, session.token);
        expect(configuration, 'plugin configuration must be readable').toBeTruthy();
        original = configuration!;
    });

    test.beforeEach(async ({ baseURL, page }) => {
        await installThemeStudioVisualFont(page);
        const session = await authenticate(baseURL!, USERS.admin.username, USERS.admin.password);
        await api(baseURL!, CONFIG_PATH, session.token, {
            method: 'POST',
            body: JSON.stringify({
                ...original,
                ThemeStudioEnabled: true,
                ThemeStudioDashboardEnabled: false,
                ThemeStudioAllowDynamicColor: false,
                ThemeSelectorEnabled: false,
                LayoutEnforcement: 'None',
            }),
        });
    });

    test.afterEach(async ({ baseURL }) => {
        const session = await authenticate(baseURL!, USERS.admin.username, USERS.admin.password);
        await api(baseURL!, CONFIG_PATH, session.token, {
            method: 'POST', body: JSON.stringify(original),
        });
    });

    test.afterAll(async ({ baseURL }) => {
        const session = await authenticate(baseURL!, USERS.admin.username, USERS.admin.password);
        await api(baseURL!, CONFIG_PATH, session.token, {
            method: 'POST', body: JSON.stringify(original),
        });
    });

    test('theme previews preserve the active media element, playback position, focus and lifecycle', async ({
        baseURL,
        page,
        consoleErrors,
    }) => {
        if (!baseURL) throw new Error('Theme Studio media E2E requires a configured baseURL');
        const session = await authenticate(baseURL, USERS.admin.username, USERS.admin.password);
        const items = await api<ItemList>(
            baseURL,
            `/Items?IncludeItemTypes=Movie&Recursive=true&Limit=1&UserId=${encodeURIComponent(session.userId)}`,
            session.token,
        );
        const item = items?.Items?.find((candidate) => candidate.Id);
        expect(item?.Id, 'the seeded server must expose a movie').toBeTruthy();
        const itemId = item!.Id!;

        await page.setViewportSize({ width: 844, height: 390 });
        await seedModernLayout(page);
        await installLifecycleProbe(page);
        try {
            await loginAs(page, 'admin', consoleErrors);
            await waitForThemeRuntime(page, 'phone');
            await showRoute(page, `/details?id=${itemId}`);
            const playButton = page.locator('.page:not(.hide) .mainDetailButtons .btnPlay').first();
            await expect(playButton).toBeVisible({ timeout: 30_000 });
            await playButton.click();
            await waitForHash(page, '/video');
            await page.waitForFunction(
                () => {
                    const video = document.querySelector('video');
                    return !!video?.currentSrc && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
                },
                undefined,
                { timeout: 30_000 },
            );
            await page.evaluate(async () => {
                const video = document.querySelector('video');
                if (!video) throw new Error('active video element is missing');
                // This assertion exercises Theme Studio itself. The separate
                // synthetic surface fixture covers pause-screen paint, while
                // disabling the optional pause-screen fetcher here prevents a
                // seed with deliberately absent artwork from adding unrelated
                // Logo/Disc/Backdrop HEAD misses after the evidence starts.
                if (window.JellyfinCanopy.currentSettings) {
                    window.JellyfinCanopy.currentSettings.pauseScreenEnabled = false;
                }
                window.JellyfinCanopy._pauseScreenInstance?.destroy();
                window.JellyfinCanopy._pauseScreenInstance = undefined;
                video.muted = true;
                video.pause();
                video.currentTime = Math.min(4, Math.max(0, (video.duration || 20) / 4));
                if (video.seeking) {
                    await new Promise<void>((resolve) => video.addEventListener('seeked', () => resolve(), { once: true }));
                }
                video.tabIndex = 0;
                video.dataset.jcThemeMediaFocus = 'true';
                video.focus();
                (window as unknown as { __jcThemeMediaPlayback?: PlaybackEvidence }).__jcThemeMediaPlayback = {
                    node: video,
                    src: video.currentSrc,
                    currentTime: video.currentTime,
                    paused: video.paused,
                };
            });
            // The seeded movie intentionally has no Logo/Disc/Backdrop art, so
            // the stock pause screen's optional HEAD probes return 404 during
            // player setup. Start the Theme Studio continuity evidence after
            // those known fixture misses; reset retains every 5xx as sticky.
            consoleErrors.reset();

            await expect(page.locator('.volumeOsd')).toBeHidden({ timeout: 10_000 });
            await page.mouse.move(1, 1);
            await page.mouse.move(422, 195);
            const actualOsd = page.locator('.videoOsdBottom').first();
            await expect(actualOsd).toBeVisible({ timeout: 10_000 });
            const actualPlayer = await page.evaluate(() => {
                const osd = document.querySelector<HTMLElement>('.videoOsdBottom');
                if (!osd) throw new Error('real Jellyfin OSD is missing');
                const osdRect = osd.getBoundingClientRect();
                const visibleControls = [...osd.querySelectorAll<HTMLElement>(
                    'button, .emby-button, .paper-icon-button-light, input[type="range"]',
                )].filter((control) => {
                    const rect = control.getBoundingClientRect();
                    const style = getComputedStyle(control);
                    return rect.width > 0 && rect.height > 0
                        && style.display !== 'none' && style.visibility !== 'hidden';
                });
                return {
                    viewport: { width: innerWidth, height: innerHeight },
                    breakpoint: document.documentElement.getAttribute('data-jc-theme-breakpoint'),
                    route: document.documentElement.getAttribute('data-jc-theme-route'),
                    osd: {
                        left: osdRect.left,
                        right: osdRect.right,
                        top: osdRect.top,
                        bottom: osdRect.bottom,
                    },
                    visibleControls: visibleControls.length,
                    undersizedControls: visibleControls.filter((control) => {
                        const rect = control.getBoundingClientRect();
                        return rect.width < 44 || rect.height < 44;
                    }).map((control) => control.getAttribute('aria-label') || control.title || control.className),
                    clippedControls: visibleControls.filter((control) => {
                        const rect = control.getBoundingClientRect();
                        return rect.left < -0.5 || rect.right > innerWidth + 0.5
                            || rect.top < -0.5 || rect.bottom > innerHeight + 0.5;
                    }).map((control) => control.getAttribute('aria-label') || control.title || control.className),
                    horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
                };
            });
            expect(actualPlayer.viewport).toEqual({ width: 844, height: 390 });
            expect(actualPlayer.breakpoint).toBe('phone');
            expect(actualPlayer.route).toBe('player');
            expect(actualPlayer.osd.left).toBeGreaterThanOrEqual(-0.5);
            expect(actualPlayer.osd.right).toBeLessThanOrEqual(844.5);
            expect(actualPlayer.osd.top).toBeGreaterThanOrEqual(-0.5);
            expect(actualPlayer.osd.bottom).toBeLessThanOrEqual(390.5);
            expect(actualPlayer.visibleControls).toBeGreaterThan(0);
            expect(actualPlayer.undersizedControls).toEqual([]);
            expect(actualPlayer.clippedControls).toEqual([]);
            expect(actualPlayer.horizontalOverflow).toBeLessThanOrEqual(1);
            await expect(page).toHaveScreenshot('theme-studio-media-real-player-phone-landscape.png', {
                animations: 'disabled',
                caret: 'hide',
                // Chromium's decoded H.264 test frame can vary at a small
                // number of edge pixels while the paused timestamp and OSD
                // geometry remain exact. Keep the tolerance below 0.8%.
                maxDiffPixels: 2_500,
            });

            const evidence = await page.evaluate(() => {
                const runtime = window.JellyfinCanopy.core.themeStudio;
                const configuration = runtime?.getConfiguration();
                const before = (window as unknown as { __jcThemeMediaPlayback?: PlaybackEvidence })
                    .__jcThemeMediaPlayback;
                const lifecycle = (window as unknown as { __jcThemeMediaLifecycle?: LifecycleProbe })
                    .__jcThemeMediaLifecycle;
                if (!runtime || !configuration || !before || !lifecycle) {
                    throw new Error('Theme Studio playback evidence prerequisites are missing');
                }
                lifecycle.observers = 0;
                lifecycle.timers = 0;
                lifecycle.listeners = 0;
                lifecycle.recording = true;
                try {
                    for (let index = 0; index < 12; index += 1) {
                        const preview = structuredClone(configuration);
                        const profile = preview.Profiles.find((candidate) => candidate.Id === preview.ActiveProfileId)
                            ?? preview.Profiles[0];
                        profile.Tokens = {
                            ...profile.Tokens,
                            'player.osd-density': index % 2 === 0 ? 'compact' : 'cinematic',
                            'player.control-material': index % 2 === 0 ? 'solid' : 'glass',
                            'player.pause-screen-material': index % 2 === 0 ? 'translucent' : 'glass',
                            'player.subtitle-backdrop': index % 2 === 0 ? 'shadow' : 'box',
                            'player.trickplay-shape': index % 2 === 0 ? 'rounded' : 'pill',
                        };
                        if (!runtime.preview(preview)) throw new Error(`preview ${index} was rejected`);
                    }
                    runtime.cancelPreview();
                } finally {
                    lifecycle.recording = false;
                }
                const video = document.querySelector('video');
                return {
                    sameNode: video === before.node,
                    sameSource: video?.currentSrc === before.src,
                    timeDelta: Math.abs((video?.currentTime ?? -100) - before.currentTime),
                    stayedPaused: video?.paused === before.paused && video?.paused === true,
                    focusPreserved: document.activeElement === before.node,
                    lifecycle: {
                        observers: lifecycle.observers,
                        timers: lifecycle.timers,
                        listeners: lifecycle.listeners,
                    },
                    route: document.documentElement.getAttribute('data-jc-theme-route'),
                    previews: document.querySelectorAll('#jc-theme-studio-preview').length,
                };
            });
            expect(evidence).toMatchObject({
                sameNode: true,
                sameSource: true,
                stayedPaused: true,
                focusPreserved: true,
                lifecycle: { observers: 0, timers: 0, listeners: 0 },
                route: 'player',
                previews: 0,
            });
            expect(evidence.timeDelta).toBeLessThan(0.1);
            assertNoRuntimeErrors(consoleErrors);
        } finally {
            await page.evaluate(() => document.querySelector('video')?.pause()).catch(() => undefined);
            await showRoute(page, '/home').catch(() => undefined);
            await api(
                baseURL,
                `/UserPlayedItems/${encodeURIComponent(itemId)}?userId=${encodeURIComponent(session.userId)}`,
                session.token,
                { method: 'DELETE' },
            ).catch(() => undefined);
        }
    });

    test('phone portrait/landscape, desktop and wide media fixtures fit and remain touch/keyboard reachable', async ({
        page,
        consoleErrors,
    }) => {
        await seedModernLayout(page);
        await page.setViewportSize({ width: 844, height: 390 });
        await loginAs(page, 'admin', consoleErrors);
        await waitForThemeRuntime(page, 'phone');
        expect(await previewMediaTheme(page)).toBe(true);
        await mountMediaFixture(page);

        const viewports = [
            { name: 'phone-portrait', width: 390, height: 844, breakpoint: 'phone' },
            { name: 'phone-landscape', width: 844, height: 390, breakpoint: 'phone' },
            { name: 'desktop', width: 1366, height: 768, breakpoint: 'desktop' },
            { name: 'wide', width: 1920, height: 1080, breakpoint: 'wide' },
        ] as const;
        for (const viewport of viewports) {
            await page.setViewportSize({ width: viewport.width, height: viewport.height });
            await waitForThemeRuntime(page, viewport.breakpoint);
            await page.evaluate(() => {
                document.documentElement.dir = 'ltr';
                document.body.dir = 'ltr';
                window.scrollTo(0, 0);
            });
            const layout = await page.evaluate(() => {
                const fixture = document.getElementById('jc-theme-media-fixture');
                if (!fixture) throw new Error('media fixture is missing');
                const interactive = [...fixture.querySelectorAll<HTMLElement>(
                    'button, a[href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])',
                )];
                const surfaces = [...fixture.querySelectorAll<HTMLElement>('[data-surface]')];
                const fixtureRect = fixture.getBoundingClientRect();
                const root = document.documentElement;
                const osd = fixture.querySelector<HTMLElement>('.videoOsdBottom');
                if (!osd) throw new Error('player OSD fixture is missing');
                const priorMaterial = root.getAttribute('data-jc-theme-player-control-material');
                const priorTransparency = root.getAttribute('data-jc-theme-transparency');
                root.setAttribute('data-jc-theme-transparency', 'full');
                root.setAttribute('data-jc-theme-player-control-material', 'solid');
                const solidOsdBackground = getComputedStyle(osd).backgroundImage;
                root.setAttribute('data-jc-theme-transparency', 'reduced');
                root.setAttribute('data-jc-theme-player-control-material', 'glass');
                const reducedOsdBackground = getComputedStyle(osd).backgroundImage;
                if (priorMaterial === null) root.removeAttribute('data-jc-theme-player-control-material');
                else root.setAttribute('data-jc-theme-player-control-material', priorMaterial);
                if (priorTransparency === null) root.removeAttribute('data-jc-theme-transparency');
                else root.setAttribute('data-jc-theme-transparency', priorTransparency);

                const nowPlayingPage = fixture.querySelector<HTMLElement>('.nowPlayingPage')!;
                const remoteControlContent = nowPlayingPage.querySelector<HTMLElement>(':scope > .remoteControlContent');
                const info = remoteControlContent?.querySelector<HTMLElement>(':scope > .nowPlayingInfoContainer');
                const playlistSection = remoteControlContent?.querySelector<HTMLElement>(':scope > .playlistSection');
                const playlist = playlistSection?.querySelector<HTMLElement>(':scope > .nowPlayingPlaylist');
                const infoRect = info?.getBoundingClientRect();
                const playlistRect = playlistSection?.getBoundingClientRect();
                return {
                    horizontalOverflow: fixture.scrollWidth - fixture.clientWidth,
                    fixtureLeft: fixtureRect.left,
                    fixtureRight: fixtureRect.right,
                    surfaceBounds: surfaces.map((surface) => {
                        const rect = surface.getBoundingClientRect();
                        return { left: rect.left, right: rect.right, width: rect.width };
                    }),
                    undersizedTargets: interactive.filter((target) => {
                        const rect = target.getBoundingClientRect();
                        return rect.width < 44 || rect.height < 44;
                    }).map((target) => target.getAttribute('aria-label') || target.textContent || target.className),
                    playerBackground: getComputedStyle(fixture.querySelector('.videoOsdBottom')!).backgroundImage,
                    solidOsdBackground,
                    reducedOsdBackground,
                    guideBackground: getComputedStyle(fixture.querySelector('.programCell-active')!).backgroundColor,
                    readerBackground: getComputedStyle(fixture.querySelector('#dialogToc')!).backgroundColor,
                    stateRoles: {
                        loading: fixture.querySelector('.nowPlayingLoading')?.getAttribute('role'),
                        empty: fixture.querySelector('.noItemsMessage')?.getAttribute('role'),
                        error: fixture.querySelector('.bookplayerErrorMsg')?.getAttribute('role'),
                    },
                    bookmarkWidth: fixture.querySelector<HTMLElement>('.jc-bookmark-marker')!
                        .getBoundingClientRect().width,
                    musicHierarchy: {
                        remoteIsDirectChild: remoteControlContent?.parentElement === nowPlayingPage,
                        infoIsDirectChild: info?.parentElement === remoteControlContent,
                        playlistSectionIsDirectChild: playlistSection?.parentElement === remoteControlContent,
                        playlistIsNested: playlist?.parentElement === playlistSection,
                    },
                    musicColumns: infoRect && playlistRect ? {
                        infoLeft: infoRect.left,
                        infoRight: infoRect.right,
                        playlistLeft: playlistRect.left,
                        playlistRight: playlistRect.right,
                    } : null,
                };
            });
            expect(layout.horizontalOverflow, `${viewport.name} fixture overflow`).toBeLessThanOrEqual(1);
            expect(layout.fixtureLeft).toBeGreaterThanOrEqual(0);
            expect(layout.fixtureRight).toBeLessThanOrEqual(viewport.width);
            for (const bounds of layout.surfaceBounds) {
                expect(bounds.left, `${viewport.name} surface left`).toBeGreaterThanOrEqual(-0.5);
                expect(bounds.right, `${viewport.name} surface right`).toBeLessThanOrEqual(viewport.width + 0.5);
                expect(bounds.width, `${viewport.name} surface width`).toBeGreaterThan(0);
            }
            expect(layout.undersizedTargets, `${viewport.name} target sizes`).toEqual([]);
            expect(layout.bookmarkWidth, `${viewport.name} bookmark marker width`).toBeLessThanOrEqual(45);
            expect(layout.stateRoles).toEqual({ loading: 'status', empty: 'status', error: 'alert' });
            expect(layout.musicHierarchy).toEqual({
                remoteIsDirectChild: true,
                infoIsDirectChild: true,
                playlistSectionIsDirectChild: true,
                playlistIsNested: true,
            });
            expect(layout.playerBackground).not.toBe('none');
            expect(layout.solidOsdBackground).toBe('none');
            expect(layout.reducedOsdBackground).toBe('none');
            expect(layout.guideBackground).not.toBe('rgba(0, 0, 0, 0)');
            expect(layout.readerBackground).not.toBe('rgba(0, 0, 0, 0)');
            if (viewport.name === 'wide') {
                expect(layout.musicColumns).not.toBeNull();
                expect(layout.musicColumns!.infoRight).toBeLessThan(layout.musicColumns!.playlistLeft);
                await page.evaluate(async () => {
                    document.documentElement.dir = 'rtl';
                    document.body.dir = 'rtl';
                    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
                });
                const rtlColumns = await page.evaluate(() => {
                    const fixture = document.getElementById('jc-theme-media-fixture')!;
                    const info = fixture.querySelector<HTMLElement>('.nowPlayingInfoContainer')!.getBoundingClientRect();
                    const playlist = fixture.querySelector<HTMLElement>('.playlistSection')!.getBoundingClientRect();
                    return {
                        infoLeft: info.left,
                        infoRight: info.right,
                        playlistLeft: playlist.left,
                        playlistRight: playlist.right,
                        direction: getComputedStyle(fixture.querySelector('.remoteControlContent')!).direction,
                        overflow: fixture.scrollWidth - fixture.clientWidth,
                    };
                });
                expect(rtlColumns.direction).toBe('rtl');
                expect(rtlColumns.infoLeft).toBeGreaterThan(rtlColumns.playlistRight);
                expect(rtlColumns.overflow).toBeLessThanOrEqual(1);
                await page.evaluate(() => {
                    document.documentElement.dir = 'ltr';
                    document.body.dir = 'ltr';
                });
            }

            const surfaceCount = await page.locator('#jc-theme-media-fixture [data-surface]').count();
            for (let index = 0; index < surfaceCount; index += 1) {
                const surface = page.locator('#jc-theme-media-fixture [data-surface]').nth(index);
                await surface.scrollIntoViewIfNeeded();
                await expect(surface).toBeVisible();
            }
            await page.evaluate(() => window.scrollTo(0, 0));
            await expect(page).toHaveScreenshot(`theme-studio-media-${viewport.name}.png`, {
                animations: 'disabled',
                caret: 'hide',
            });
        }
        await page.evaluate(() => window.JellyfinCanopy.core.themeStudio?.cancelPreview());
        assertNoRuntimeErrors(consoleErrors);
    });
});
