import type { Page } from 'playwright/test';
import { assertNoRuntimeErrors, expect, loginAs, test, USERS } from './fixtures/auth';
import { api, authenticate, PLUGIN_ID, type Session } from './fixtures/api';

const CONFIG_PATH = `/Plugins/${PLUGIN_ID}/Configuration`;
const DYNAMIC_IMAGE_PATH = '/Items/jc-theme-effects-e2e/Images/Backdrop';

async function seedModernLayout(page: Page, lowEnd = false): Promise<void> {
    await page.addInitScript(({ emulateLowEnd }) => {
        localStorage.setItem('layout', 'experimental');
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
        if (emulateLowEnd) {
            Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: 1 });
            Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, value: 2 });
        }
    }, { emulateLowEnd: lowEnd });
}

async function waitForThemeRuntime(page: Page, breakpoint: 'phone' | 'desktop' | 'wide'): Promise<void> {
    await page.waitForFunction((expected) => {
        const root = document.documentElement;
        return root.getAttribute('data-jc-theme-active') === 'true'
            && root.getAttribute('data-jc-theme-breakpoint') === expected
            && document.querySelectorAll('#jc-theme-studio-committed').length === 1;
    }, breakpoint);
}

async function routeDynamicBackdrop(page: Page): Promise<void> {
    const image = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAEAAAABAEAIAAAB1mzrKAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRP///////wlY99wAAAAHdElNRQfqBxQNDC5u618MAAAAJXRFWHRkYXRlOmNyZWF0ZQAyMDI2LTA3LTIwVDEzOjEyOjQ2KzAwOjAw4kueewAAACV0RVh0ZGF0ZTptb2RpZnkAMjAyNi0wNy0yMFQxMzoxMjo0NiswMDowMJMWJscAAAAodEVYdGRhdGU6dGltZXN0YW1wADIwMjYtMDctMjBUMTM6MTI6NDYrMDA6MDDEAwcYAAAA90lEQVR42u3bwRECIRREQUCC0HgMyiQ1FyNADwbRB19HsFXU7PBhd77f9/vjMYLss8Z1vfRj/K991ri1AM4+a1xnC8CUAKwOwEoAts+lBEj7s+atEnbqAKwOwEoAVgKwJmGsBGB1APZLwFM/xv8qAdg+azQJQ/tcZgmA2gVhdQDWAmCVMFYCsEoYKwFYCcA6jsb2WbMEQHUAVgdgfZiFNQljdQBWB2AlACsBWJMwVgKwfVaX8lIJwNoFYZUw1isI6zAOKwFYJYz9jqP7P4ApAViX8lgJwNoFYU3CWAnA6gCsBGCdBWF9mIXVAViTMFYCsHZBWJMw9gUrmnxGl7pW5wAAAABJRU5ErkJggg==',
        'base64',
    );
    await page.route(`**${DYNAMIC_IMAGE_PATH}*`, async (route) => {
        await route.fulfill({ status: 200, contentType: 'image/png', body: image });
    });
}

async function mountEffectsFixture(page: Page): Promise<void> {
    await page.evaluate((backdropPath) => {
        document.getElementById('jc-theme-effects-fixture')?.remove();
        document.getElementById('jc-theme-effects-fixture-style')?.remove();
        const style = document.createElement('style');
        style.id = 'jc-theme-effects-fixture-style';
        style.textContent = `
          #jc-theme-effects-fixture {
            position: fixed; inset: 0; z-index: 1000000; box-sizing: border-box;
            min-width: 0; min-height: 100dvh; overflow: auto; isolation: isolate;
            background: var(--jc-color-canvas); color: var(--jc-color-text);
            font-family: var(--jc-type-family-ui); padding: clamp(.75rem, 2vw, 2rem);
          }
          #jc-theme-effects-fixture * { box-sizing: border-box; }
          #jc-theme-effects-fixture > .backdropImage {
            position: fixed; inset: -4%; z-index: -2; width: 108%; height: 108%;
            object-fit: cover; opacity: .42; pointer-events: none;
          }
          #jc-theme-effects-fixture::after {
            content: ''; position: fixed; inset: 0; z-index: -1; pointer-events: none;
            background: linear-gradient(115deg, color-mix(in srgb, var(--jc-color-canvas) 90%, transparent),
              color-mix(in srgb, var(--jc-color-canvas) 55%, transparent));
          }
          #jc-theme-effects-fixture .MuiAppBar-root {
            min-height: 4rem; display: flex; align-items: center; gap: .8rem;
            padding: .55rem .85rem; border: 1px solid var(--jc-color-divider);
            border-radius: var(--jc-shape-dialog-radius); color: var(--jc-color-text);
          }
          #jc-theme-effects-fixture .brand {
            display: flex; align-items: center; gap: .7rem; min-width: 0; font-weight: 750;
          }
          #jc-theme-effects-fixture .brand-mark {
            display: grid; place-items: center; inline-size: 2.75rem; block-size: 2.75rem;
            flex: 0 0 auto; border-radius: 50%; color: var(--jc-color-on-primary);
            background: var(--jc-color-primary); font-size: 1.15rem;
          }
          #jc-theme-effects-fixture .brand-copy { min-width: 0; }
          #jc-theme-effects-fixture .brand-copy small { display: block; color: var(--jc-color-text-muted); }
          #jc-theme-effects-fixture .header-actions { margin-inline-start: auto; display: flex; gap: .45rem; }
          #jc-theme-effects-fixture button {
            min-width: 44px; min-height: 44px; border: 1px solid var(--jc-color-divider);
            border-radius: var(--jc-shape-control-radius); padding: .55rem .85rem;
            background: var(--jc-color-elevated); color: inherit; font: inherit; cursor: pointer;
          }
          #jc-theme-effects-fixture button.primary {
            background: var(--jc-color-primary); color: var(--jc-color-on-primary); border-color: transparent;
          }
          #jc-theme-effects-fixture button:focus-visible {
            outline: 3px solid var(--jc-color-focus, var(--jc-color-primary));
            outline-offset: 3px;
          }
          #jc-theme-effects-fixture main {
            width: min(100%, 92rem); margin: clamp(.8rem, 2vw, 1.5rem) auto 0;
            display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(17rem, .7fr); gap: 1rem;
          }
          #jc-theme-effects-fixture .hero,
          #jc-theme-effects-fixture .MuiDialog-paper {
            min-width: 0; padding: clamp(1rem, 3vw, 2rem); border: 1px solid var(--jc-color-divider);
            border-radius: var(--jc-shape-dialog-radius); color: var(--jc-color-text);
          }
          #jc-theme-effects-fixture .MuiDialog-paper {
            width: auto !important; min-inline-size: 0 !important; max-inline-size: none !important; margin: 0 !important;
          }
          #jc-theme-effects-fixture .eyebrow {
            margin: 0 0 .4rem; color: var(--jc-color-primary); font-size: .78rem;
            font-weight: 800; letter-spacing: .13em; text-transform: uppercase;
          }
          #jc-theme-effects-fixture h1 {
            max-width: 15ch; margin: 0; font-family: var(--jc-type-family-display);
            font-size: clamp(2rem, 5vw, 4.8rem); line-height: 1.02;
          }
          #jc-theme-effects-fixture .lead {
            max-width: 60ch; margin: .8rem 0 1.1rem; color: var(--jc-color-text-muted); line-height: 1.55;
          }
          #jc-theme-effects-fixture .hero-actions { display: flex; flex-wrap: wrap; gap: .55rem; }
          #jc-theme-effects-fixture .chips { display: flex; flex-wrap: wrap; gap: .45rem; margin-top: 1.2rem; }
          #jc-theme-effects-fixture .chip {
            padding: .38rem .62rem; border: 1px solid var(--jc-color-divider); border-radius: 999px;
            background: var(--jc-effects-surface-background); color: var(--jc-color-text-muted);
          }
          #jc-theme-effects-fixture .MuiDialog-paper h2 { margin: 0 0 .35rem; font-size: 1.15rem; }
          #jc-theme-effects-fixture .MuiDialog-paper p { margin: 0; color: var(--jc-color-text-muted); }
          #jc-theme-effects-fixture .effect-list {
            display: grid; gap: .65rem; margin: 1rem 0; padding: 0; list-style: none;
          }
          #jc-theme-effects-fixture .effect-list li {
            display: grid; grid-template-columns: 2rem minmax(0, 1fr); align-items: center; gap: .65rem;
          }
          #jc-theme-effects-fixture .effect-icon {
            display: grid; place-items: center; inline-size: 2rem; block-size: 2rem;
            border-radius: 50%; background: color-mix(in srgb, var(--jc-color-primary) 22%, transparent);
            color: var(--jc-color-primary); font-weight: 800;
          }
          #jc-theme-effects-fixture .schedule {
            padding-top: .8rem; border-top: 1px solid var(--jc-color-divider);
            color: var(--jc-color-text-muted); font-size: .88rem;
          }
          #jc-theme-effects-fixture .itemsContainer {
            grid-column: 1 / -1; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: .8rem;
          }
          #jc-theme-effects-fixture .visualCardBox {
            min-width: 0; min-height: 8.5rem; padding: 1rem; display: flex; flex-direction: column;
            justify-content: flex-end; border: 1px solid var(--jc-color-divider);
            border-radius: var(--jc-shape-card-radius); background: var(--jc-color-surface);
          }
          #jc-theme-effects-fixture .visualCardBox:nth-child(1) {
            background: linear-gradient(145deg, color-mix(in srgb, var(--jc-color-primary) 62%, #18152B), #18152B);
          }
          #jc-theme-effects-fixture .visualCardBox:nth-child(2) {
            background: linear-gradient(145deg, color-mix(in srgb, var(--jc-color-secondary) 58%, #151A2E), #151A2E);
          }
          #jc-theme-effects-fixture .visualCardBox:nth-child(3) {
            background: linear-gradient(145deg, #4C223E, #151522);
          }
          #jc-theme-effects-fixture .visualCardBox:nth-child(4) {
            background: linear-gradient(145deg, #163C46, #141722);
          }
          #jc-theme-effects-fixture .visualCardBox strong,
          #jc-theme-effects-fixture .visualCardBox span { overflow-wrap: anywhere; }
          #jc-theme-effects-fixture .visualCardBox span { margin-top: .25rem; color: var(--jc-color-text-muted); }
          @media (max-width: 899px) {
            #jc-theme-effects-fixture { padding: max(.65rem, env(safe-area-inset-top)) .65rem max(.65rem, env(safe-area-inset-bottom)); }
            #jc-theme-effects-fixture main { grid-template-columns: minmax(0, 1fr); }
            #jc-theme-effects-fixture .itemsContainer { grid-column: auto; grid-template-columns: repeat(2, minmax(0, 1fr)); }
            #jc-theme-effects-fixture .header-actions button:not(.primary) { display: none; }
          }
          @media (orientation: landscape) and (max-height: 599px) {
            #jc-theme-effects-fixture main { grid-template-columns: minmax(0, 1.25fr) minmax(0, .75fr); }
            #jc-theme-effects-fixture .itemsContainer { display: none; }
            #jc-theme-effects-fixture h1 { font-size: clamp(1.8rem, 5vw, 3rem); }
          }
        `;
        const fixture = document.createElement('div');
        fixture.id = 'jc-theme-effects-fixture';
        fixture.innerHTML = `
          <img class="backdropImage" src="${backdropPath}" alt="">
          <header class="MuiAppBar-root">
            <div class="brand"><span class="brand-mark" aria-hidden="true">JC</span>
              <span class="brand-copy">Jellyfin Canopy<small>Theme Studio · Modern layout</small></span></div>
            <div class="header-actions"><button type="button" aria-label="Search library">⌕</button>
              <button type="button" class="primary">My Jellyfin</button></div>
          </header>
          <main>
            <section class="hero MuiPaper-elevation3">
              <p class="eyebrow">Holiday profile · local dynamic colour</p>
              <h1>Your library, unmistakably yours.</h1>
              <p class="lead">Glass materials, expressive motion, local artwork accents, and accessible fallbacks compose without changing Jellyfin's content order.</p>
              <div class="hero-actions"><button id="jc-effects-play" type="button" class="primary" aria-label="Play featured title">▶ Play</button>
                <button type="button">More information</button></div>
              <div class="chips"><span class="chip">Glass</span><span class="chip">Expressive</span>
                <span class="chip">Dynamic accent</span><span class="chip">UTC holiday schedule</span></div>
            </section>
            <aside class="MuiDialog-paper">
              <p class="eyebrow">Effects profile</p><h2>Full · capability aware</h2>
              <p>Administrator and accessibility policy can only reduce visual cost.</p>
              <ul class="effect-list"><li><span class="effect-icon">G</span><span>Bounded glass surfaces</span></li>
                <li><span class="effect-icon">M</span><span>Layout-stable motion</span></li>
                <li><span class="effect-icon">A</span><span>Same-origin artwork analysis</span></li></ul>
              <div class="schedule">Holiday overrides season · deterministic local or UTC dates</div>
            </aside>
            <section class="itemsContainer" aria-label="Recently added">
              <article class="visualCardBox"><strong>Continue watching</strong><span>Season 2 · Episode 4</span></article>
              <article class="visualCardBox"><strong>Recently added</strong><span>Eight new films</span></article>
              <article class="visualCardBox"><strong>Because you watched</strong><span>A long localized recommendation label wraps safely</span></article>
              <article class="visualCardBox"><strong>Live tonight</strong><span>Starts at 20:30</span></article>
            </section>
          </main>`;
        document.head.append(style);
        document.body.append(fixture);
    }, DYNAMIC_IMAGE_PATH);
}

async function previewEffects(page: Page): Promise<{ accepted: boolean; serialized: string }> {
    return page.evaluate(() => {
        const runtime = window.JellyfinCanopy.core.themeStudio;
        const current = runtime?.getConfiguration();
        if (!runtime || !current) throw new Error('Theme Studio configuration is unavailable');
        const draft = structuredClone(current);
        const active = draft.Profiles.find((profile) => profile.Id === draft.ActiveProfileId)
            ?? draft.Profiles[0];
        if (!active) throw new Error('Theme Studio active profile is unavailable');
        const effects = {
            ...active.Tokens,
            'effects.level': 'full',
            'effects.material': 'glass',
            'effects.blur': 16,
            'effects.saturation': 1.25,
            'effects.glow': 0.35,
            'effects.image-treatment': 'blur',
            'motion.profile': 'expressive',
            'motion.duration-scale': 1,
            'motion.page-transition': true,
            'motion.stagger': true,
            'color.dynamic-source': 'backdrop',
            'color.dynamic-strength': 1,
        };
        active.Tokens = effects;
        const holiday = structuredClone(active);
        holiday.Id = 'jc-e2e-holiday-profile';
        holiday.Name = 'Holiday aurora';
        holiday.Palette = 'vivid';
        holiday.Tokens = { ...effects };
        draft.Profiles = [active, holiday];
        draft.ScheduleTimeZone = 'utc';
        draft.Schedule = [
            {
                Id: 'jc-e2e-season', ProfileId: active.Id, Kind: 'season', StartMonthDay: '01-01',
                EndMonthDay: '12-31', Priority: 99, Enabled: true,
            },
            {
                Id: 'jc-e2e-holiday', ProfileId: holiday.Id, Kind: 'holiday', StartMonthDay: '01-01',
                EndMonthDay: '12-31', Priority: 1, Enabled: true,
            },
        ];
        return { accepted: runtime.preview(draft), serialized: JSON.stringify(draft) };
    });
}

async function viewportEvidence(page: Page): Promise<{
    documentOverflow: number;
    fixtureOverflow: number;
    minimumTarget: number;
    direction: string;
}> {
    return page.evaluate(() => {
        const fixture = document.getElementById('jc-theme-effects-fixture')!;
        const targets = [...fixture.querySelectorAll<HTMLElement>('button')].filter((element) => {
            const box = element.getBoundingClientRect();
            return box.width > 0 && box.height > 0 && getComputedStyle(element).display !== 'none';
        });
        return {
            documentOverflow: document.scrollingElement!.scrollWidth - innerWidth,
            fixtureOverflow: fixture.scrollWidth - fixture.clientWidth,
            minimumTarget: Math.min(...targets.map((element) => element.getBoundingClientRect().height)),
            direction: getComputedStyle(fixture).direction,
        };
    });
}

test.describe.serial('Theme Studio bounded effects', () => {
    let admin: Session;
    let original: Record<string, unknown>;

    test.beforeAll(async ({ baseURL }) => {
        admin = await authenticate(baseURL!, USERS.admin.username, USERS.admin.password);
        const configuration = await api<Record<string, unknown>>(baseURL!, CONFIG_PATH, admin.token);
        expect(configuration, 'plugin configuration must be readable').toBeTruthy();
        original = configuration!;
    });

    test.beforeEach(async ({ baseURL }) => {
        await api(baseURL!, CONFIG_PATH, admin.token, {
            method: 'POST',
            body: JSON.stringify({
                ...original,
                ThemeStudioEnabled: true,
                ThemeStudioDashboardEnabled: false,
                ThemeStudioAllowSeasonalScheduling: true,
                ThemeStudioAllowDynamicColor: true,
                ThemeStudioMaximumEffectsLevel: 'full',
                ThemeStudioAllowProfileImport: true,
                ThemeSelectorEnabled: false,
                LayoutEnforcement: 'None',
            }),
        });
    });

    test.afterEach(async ({ baseURL }) => {
        await api(baseURL!, CONFIG_PATH, admin.token, {
            method: 'POST', body: JSON.stringify(original),
        });
    });

    test.afterAll(async ({ baseURL }) => {
        await api(baseURL!, CONFIG_PATH, admin.token, {
            method: 'POST', body: JSON.stringify(original),
        });
    });

    test('full effects, dynamic holiday accents, and keyboard/touch surfaces work across modern desktop, wide, and phone views', async ({
        page,
        consoleErrors,
    }) => {
        await page.setViewportSize({ width: 1366, height: 768 });
        await seedModernLayout(page);
        await routeDynamicBackdrop(page);
        await loginAs(page, 'admin', consoleErrors);
        await waitForThemeRuntime(page, 'desktop');
        await mountEffectsFixture(page);
        const preview = await previewEffects(page);
        expect(preview.accepted).toBe(true);
        expect(preview.serialized).not.toContain('/Items/');
        await expect.poll(() => page.evaluate(() =>
            document.documentElement.getAttribute('data-jc-theme-dynamic-accent'))).toBe('active');
        await expect.poll(() => page.evaluate(() => ({
            breakpoint: document.documentElement.getAttribute('data-jc-theme-breakpoint'),
            level: document.documentElement.getAttribute('data-jc-theme-effects-level'),
            material: document.documentElement.getAttribute('data-jc-theme-effects-material'),
            treatment: document.documentElement.getAttribute('data-jc-theme-image-treatment'),
            motion: document.documentElement.getAttribute('data-jc-theme-motion-profile'),
            schedule: document.documentElement.getAttribute('data-jc-theme-schedule'),
            scheduleKind: document.documentElement.getAttribute('data-jc-theme-schedule-kind'),
            scheduleZone: document.documentElement.getAttribute('data-jc-theme-schedule-time-zone'),
        }))).toEqual({
            breakpoint: 'desktop', level: 'full', material: 'glass', treatment: 'blur',
            motion: 'expressive', schedule: 'jc-e2e-holiday', scheduleKind: 'holiday', scheduleZone: 'utc',
        });
        const dynamicCss = await page.locator('#jc-theme-studio-dynamic-accent').textContent();
        expect(dynamicCss).toContain('--jf-palette-primary-main:');
        expect(dynamicCss).not.toContain('/Items/');

        const play = page.getByRole('button', { name: 'Play featured title' });
        await play.focus();
        await page.keyboard.press('Tab');
        await page.keyboard.press('Shift+Tab');
        await expect(play).toBeFocused();
        const focus = await play.evaluate((element) => {
            const styles = getComputedStyle(element);
            return { style: styles.outlineStyle, width: Number.parseFloat(styles.outlineWidth) };
        });
        expect(focus.style).not.toBe('none');
        expect(focus.width).toBeGreaterThanOrEqual(2);

        const viewports = [
            { name: 'desktop', width: 1366, height: 768, breakpoint: 'desktop' as const },
            { name: 'wide', width: 1920, height: 1080, breakpoint: 'wide' as const },
            { name: 'phone-portrait', width: 390, height: 844, breakpoint: 'phone' as const },
            { name: 'phone-landscape', width: 844, height: 390, breakpoint: 'phone' as const },
        ];
        for (const viewport of viewports) {
            await page.setViewportSize({ width: viewport.width, height: viewport.height });
            await waitForThemeRuntime(page, viewport.breakpoint);
            const evidence = await viewportEvidence(page);
            expect(evidence.documentOverflow, `${viewport.name}: ${JSON.stringify(evidence)}`).toBeLessThanOrEqual(1);
            expect(evidence.fixtureOverflow, `${viewport.name}: ${JSON.stringify(evidence)}`).toBeLessThanOrEqual(1);
            expect(evidence.minimumTarget, viewport.name).toBeGreaterThanOrEqual(44);
            expect(await page.locator('#jc-theme-studio-committed')).toHaveCount(1);
            expect(await page.locator('#jc-theme-studio-preview')).toHaveCount(1);
            expect(await page.locator('#jc-theme-studio-dynamic-accent')).toHaveCount(1);
            await expect(page).toHaveScreenshot(`theme-studio-effects-${viewport.name}.png`, {
                animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02,
            });
            if (process.env.JC_CAPTURE_THEME_DOCS === '1' && viewport.name === 'desktop') {
                await page.screenshot({
                    path: 'docs/images/theme-studio-effects-desktop.png', animations: 'disabled', caret: 'hide',
                });
            }
            if (process.env.JC_CAPTURE_THEME_DOCS === '1' && viewport.name === 'phone-portrait') {
                await page.screenshot({
                    path: 'docs/images/theme-studio-effects-phone.png', animations: 'disabled', caret: 'hide',
                });
            }
        }

        await page.setViewportSize({ width: 1366, height: 768 });
        await waitForThemeRuntime(page, 'desktop');
        await page.evaluate(() => {
            document.documentElement.dir = 'rtl';
            document.getElementById('jc-theme-effects-fixture')!.dir = 'rtl';
            window.JellyfinCanopy.core.themeStudio?.refresh();
        });
        expect(await viewportEvidence(page)).toMatchObject({
            documentOverflow: 0, fixtureOverflow: 0, direction: 'rtl',
        });
        await page.evaluate(() => {
            document.documentElement.dir = 'ltr';
            document.getElementById('jc-theme-effects-fixture')!.dir = 'ltr';
        });

        await page.evaluate(() => {
            window.JellyfinCanopy.pluginConfig!.ThemeStudioMaximumEffectsLevel = 'balanced';
            window.JellyfinCanopy.core.themeStudio?.refresh();
        });
        await expect.poll(() => page.evaluate(() => ({
            level: document.documentElement.getAttribute('data-jc-theme-effects-level'),
            treatment: document.documentElement.getAttribute('data-jc-theme-image-treatment'),
            motion: document.documentElement.getAttribute('data-jc-theme-motion-profile'),
        }))).toEqual({ level: 'balanced', treatment: 'gradient', motion: 'calm' });
        await page.evaluate(() => {
            window.JellyfinCanopy.pluginConfig!.ThemeStudioAllowDynamicColor = false;
            window.JellyfinCanopy.core.themeStudio?.refresh();
        });
        await expect.poll(() => page.evaluate(() => ({
            source: document.documentElement.getAttribute('data-jc-theme-dynamic-source'),
            accent: document.documentElement.getAttribute('data-jc-theme-dynamic-accent'),
        }))).toEqual({ source: 'off', accent: 'off' });
        assertNoRuntimeErrors(consoleErrors);
    });

    test('low-end modern phone portrait and landscape reduce costly effects without overflow', async ({
        page,
        consoleErrors,
    }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await seedModernLayout(page, true);
        await routeDynamicBackdrop(page);
        await loginAs(page, 'admin', consoleErrors);
        await waitForThemeRuntime(page, 'phone');
        await mountEffectsFixture(page);
        await page.evaluate(() => {
            const probe = document.createElement('div');
            probe.id = 'jc-minimal-material-probe';
            probe.style.cssText = 'position:fixed;inset-inline-start:-10000px;inline-size:10px;block-size:10px;overflow:hidden';
            probe.innerHTML = '<div class="videoOsdBottom"></div>'
                + '<div id="pause-screen-content"></div>'
                + '<div class="nowPlayingInfoContainer"></div>'
                + '<div class="bookOsdRow"></div>';
            document.body.append(probe);
        });
        expect((await previewEffects(page)).accepted).toBe(true);
        await expect.poll(() => page.evaluate(() => ({
            breakpoint: document.documentElement.getAttribute('data-jc-theme-breakpoint'),
            performance: document.documentElement.getAttribute('data-jc-theme-performance'),
            level: document.documentElement.getAttribute('data-jc-theme-effects-level'),
            material: document.documentElement.getAttribute('data-jc-theme-effects-material'),
            treatment: document.documentElement.getAttribute('data-jc-theme-image-treatment'),
            motion: document.documentElement.getAttribute('data-jc-theme-motion-profile'),
            source: document.documentElement.getAttribute('data-jc-theme-dynamic-source'),
            accent: document.documentElement.getAttribute('data-jc-theme-dynamic-accent'),
            playerControl: document.documentElement.getAttribute('data-jc-theme-player-control-material'),
            playerPause: document.documentElement.getAttribute('data-jc-theme-player-pause-screen-material'),
        }))).toEqual({
            breakpoint: 'phone', performance: 'reduced', level: 'minimal', material: 'solid',
            treatment: 'none', motion: 'off', source: 'off', accent: 'off',
            playerControl: 'solid', playerPause: 'solid',
        });
        for (const viewport of [
            { name: 'portrait', width: 390, height: 844 },
            { name: 'landscape', width: 844, height: 390 },
        ]) {
            await page.setViewportSize({ width: viewport.width, height: viewport.height });
            await waitForThemeRuntime(page, 'phone');
            const evidence = await viewportEvidence(page);
            expect(evidence.documentOverflow, `${viewport.name}: ${JSON.stringify(evidence)}`).toBeLessThanOrEqual(1);
            expect(evidence.fixtureOverflow, `${viewport.name}: ${JSON.stringify(evidence)}`).toBeLessThanOrEqual(1);
            expect(evidence.minimumTarget, viewport.name).toBeGreaterThanOrEqual(44);
        }
        const dialogEffects = await page.locator('#jc-theme-effects-fixture .MuiDialog-paper')
            .evaluate((element) => {
                const styles = getComputedStyle(element);
                return { backdrop: styles.backdropFilter, shadow: styles.boxShadow };
            });
        expect(dialogEffects.backdrop).toBe('none');
        expect(dialogEffects.shadow).toBe('none');
        const materialEffects = await page.locator('#jc-minimal-material-probe > *').evaluateAll((elements) => {
            const reference = document.createElement('div');
            reference.style.backgroundColor = 'var(--jc-color-surface)';
            document.body.append(reference);
            const solid = getComputedStyle(reference).backgroundColor;
            reference.remove();
            return elements.map((element) => {
                const styles = getComputedStyle(element);
                return {
                    role: element.id || element.className,
                    background: styles.backgroundColor,
                    image: styles.backgroundImage,
                    backdrop: styles.backdropFilter,
                    shadow: styles.boxShadow,
                    solid,
                };
            });
        });
        for (const effects of materialEffects) {
            expect(effects.background, effects.role).toBe(effects.solid);
            expect(effects.image, effects.role).toBe('none');
            expect(effects.backdrop, effects.role).toBe('none');
            expect(effects.shadow, effects.role).toBe('none');
        }
        assertNoRuntimeErrors(consoleErrors);
    });
});
