import type { Page } from 'playwright/test';
import { assertNoRuntimeErrors, expect, loginAs, test, USERS } from './fixtures/auth';
import { api, authenticate, PLUGIN_ID, type Session } from './fixtures/api';

const CONFIG_PATH = `/Plugins/${PLUGIN_ID}/Configuration`;

async function seedModernCoarseLayout(page: Page): Promise<void> {
    await page.addInitScript(() => {
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
    });
}

async function waitForThemeRuntime(page: Page, breakpoint: 'phone' | 'desktop' | 'wide'): Promise<void> {
    await page.waitForFunction((expected) => {
        const root = document.documentElement;
        return root.getAttribute('data-jc-theme-active') === 'true'
            && root.getAttribute('data-jc-theme-breakpoint') === expected
            && document.querySelectorAll('#jc-theme-studio-committed').length === 1;
    }, breakpoint);
}

async function previewHighContrast(page: Page): Promise<void> {
    const accepted = await page.evaluate(() => {
        const runtime = window.JellyfinCanopy.core.themeStudio;
        const draft = runtime?.getConfiguration();
        const active = draft?.Profiles.find((profile) => profile.Id === draft.ActiveProfileId)
            ?? draft?.Profiles[0];
        if (!runtime || !draft || !active) throw new Error('Theme Studio configuration is unavailable');
        active.BasePreset = 'high-contrast';
        active.Palette = 'canopy-night';
        active.Accent = 'cyan';
        active.Accessibility = {
            ...active.Accessibility,
            Contrast: 'on',
            Motion: 'off',
            Transparency: 'off',
            FocusEmphasis: 'strong',
            UnderlineLinks: true,
        };
        active.Tokens = {
            ...active.Tokens,
            'layout.card-actions': 'always',
            'effects.level': 'minimal',
        };
        return runtime.preview(draft, { allowScheduling: false });
    });
    expect(accepted).toBe(true);
}

async function mountCanopyFixture(page: Page): Promise<void> {
    await page.evaluate(() => {
        document.getElementById('jc-theme-canopy-fixture')?.remove();
        document.getElementById('jc-theme-canopy-fixture-style')?.remove();
        const style = document.createElement('style');
        style.id = 'jc-theme-canopy-fixture-style';
        style.textContent = `
          #jc-theme-canopy-fixture {
            position:fixed; inset:0; z-index:1000000; box-sizing:border-box; overflow:auto;
            min-inline-size:0; background:var(--jc-color-canvas); color:var(--jc-color-text);
            font-family:var(--jc-type-family-ui); padding:clamp(.65rem,2vw,1.4rem);
          }
          #jc-theme-canopy-fixture * { box-sizing:border-box; }
          #jc-theme-canopy-fixture > header { display:flex; align-items:center; gap:.7rem; max-inline-size:86rem; margin-inline:auto; }
          #jc-theme-canopy-fixture > header .mark { display:grid; place-items:center; inline-size:2.75rem; block-size:2.75rem; flex:none; border-radius:50%; background:var(--jc-color-primary); color:var(--jc-color-on-primary); font-weight:900; }
          #jc-theme-canopy-fixture > header .heading { min-inline-size:0; }
          #jc-theme-canopy-fixture > header h1 { margin:0; font-size:clamp(1.15rem,3vw,1.8rem); overflow-wrap:anywhere; }
          #jc-theme-canopy-fixture > header p { margin:.1rem 0 0; color:var(--jc-color-text-muted); overflow-wrap:anywhere; }
          #jc-theme-canopy-fixture #jc-native-tabs-group { margin-inline-start:auto; }
          #jc-theme-canopy-fixture button,
          #jc-theme-canopy-fixture input { font:inherit; }
          #jc-theme-canopy-fixture > main { display:grid; grid-template-columns:minmax(22rem,1.15fr) minmax(18rem,.85fr); gap:1rem; max-inline-size:86rem; margin:1rem auto 0; }
          #jc-theme-canopy-fixture .fixture-column { display:grid; align-content:start; gap:1rem; min-inline-size:0; }
          #jc-theme-canopy-fixture #jellyfin-canopy-panel {
            position:relative !important; inset:auto !important; transform:none !important;
            inline-size:100% !important; block-size:auto !important; min-inline-size:0 !important;
            max-inline-size:none !important; max-block-size:none !important; overflow:hidden;
          }
          #jc-theme-canopy-fixture #jellyfin-canopy-panel .jc-panel-header,
          #jc-theme-canopy-fixture #jellyfin-canopy-panel .panel-footer { display:flex; align-items:center; gap:.6rem; padding:.75rem 1rem !important; }
          #jc-theme-canopy-fixture #jellyfin-canopy-panel .jc-panel-header strong { overflow-wrap:anywhere; }
          #jc-theme-canopy-fixture #jellyfin-canopy-panel .jc-panel-body { display:grid; grid-template-columns:11rem minmax(0,1fr); min-block-size:17rem; }
          #jc-theme-canopy-fixture #jellyfin-canopy-panel .jc-panel-nav { position:relative; inset:auto; padding:.65rem; }
          #jc-theme-canopy-fixture #jellyfin-canopy-panel .jc-panel-nav-items { display:grid; gap:.25rem; }
          #jc-theme-canopy-fixture #jellyfin-canopy-panel .jc-panel-main { position:relative !important; inset:auto !important; transform:none !important; padding:1rem !important; }
          #jc-theme-canopy-fixture #jellyfin-canopy-panel .jc-pane { display:block; }
          #jc-theme-canopy-fixture #jellyfin-canopy-panel .setting-card { padding:.7rem; border:1px solid var(--jc-color-divider); border-radius:var(--jc-shape-card-radius); background:var(--jc-color-elevated); }
          #jc-theme-canopy-fixture #jellyfin-canopy-panel .setting-card + .setting-card { margin-block-start:.55rem; }
          #jc-theme-canopy-fixture #jellyfin-canopy-panel .panel-footer { justify-content:flex-end; }
          #jc-theme-canopy-fixture .card-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:.7rem; }
          #jc-theme-canopy-fixture .card { min-inline-size:0; }
          #jc-theme-canopy-fixture .cardBox { position:relative; margin:0 !important; }
          #jc-theme-canopy-fixture .cardScalable { position:relative; min-block-size:15rem; overflow:hidden; border:1px solid var(--jc-color-divider); border-radius:var(--jc-shape-card-radius); background:linear-gradient(145deg,#24385e,#121826 58%,#47233c); }
          #jc-theme-canopy-fixture .card:nth-child(2) .cardScalable { background:linear-gradient(145deg,#174842,#17211f 62%,#5f4519); }
          #jc-theme-canopy-fixture .card:nth-child(3) .cardScalable { background:linear-gradient(145deg,#563157,#181521 62%,#174552); }
          #jc-theme-canopy-fixture .jc-tag-host { position:absolute !important; inset:0; z-index:2; pointer-events:none; }
          #jc-theme-canopy-fixture .genre-overlay-container,
          #jc-theme-canopy-fixture .quality-overlay-container,
          #jc-theme-canopy-fixture .rating-overlay-container,
          #jc-theme-canopy-fixture .language-overlay-container { display:flex; flex-direction:column; gap:2px; }
          #jc-theme-canopy-fixture .genre-tag,
          #jc-theme-canopy-fixture .quality-overlay-label,
          #jc-theme-canopy-fixture .rating-tag { display:inline-flex; align-items:center; gap:.25rem; inline-size:fit-content; padding:.22rem .45rem; font-size:.72rem; font-weight:800; }
          #jc-theme-canopy-fixture .genre-tag { inline-size:1.8rem; block-size:1.8rem; justify-content:center; border-radius:50% !important; }
          #jc-theme-canopy-fixture .language-flag { inline-size:1.8rem; block-size:1.15rem; background:linear-gradient(#1769aa 0 33%,#fff 33% 66%,#d32f2f 66%); }
          #jc-theme-canopy-fixture .jc-anime-filler-marker { position:absolute; z-index:3; padding:.2rem .45rem; }
          #jc-theme-canopy-fixture .jc-hide-btn { opacity:1; }
          #jc-theme-canopy-fixture .cardFooter { min-block-size:4rem; }
          #jc-theme-canopy-fixture .cardFooter strong,
          #jc-theme-canopy-fixture .cardFooter span { display:block; overflow-wrap:anywhere; }
          #jc-theme-canopy-fixture .cardFooter span { color:var(--jc-color-text-muted); font-size:.8rem; }
          #jc-theme-canopy-fixture .fixture-dialogs { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:.7rem; }
          #jc-theme-canopy-fixture :where(.jc-spoiler-confirm-dialog,.jc-hide-confirm-dialog) { inline-size:auto !important; max-inline-size:none !important; padding:1rem; }
          #jc-theme-canopy-fixture :where(.jc-spoiler-confirm-dialog,.jc-hide-confirm-dialog) h3 { margin:0 0 .35rem; }
          #jc-theme-canopy-fixture :where(.jc-spoiler-confirm-dialog,.jc-hide-confirm-dialog) p { margin:.2rem 0 .65rem; }
          #jc-theme-canopy-fixture .jc-spoiler-confirm-buttons,
          #jc-theme-canopy-fixture .jc-hide-confirm-buttons { display:flex; justify-content:flex-end; }
          #jc-theme-canopy-fixture .jc-hidden-management-panel { inline-size:100%; max-inline-size:none !important; max-block-size:none; overflow:hidden; }
          #jc-theme-canopy-fixture .jc-hidden-management-header,
          #jc-theme-canopy-fixture .jc-hidden-management-toolbar { display:flex; align-items:center; padding:.65rem .8rem; }
          #jc-theme-canopy-fixture .jc-hidden-management-header { justify-content:space-between; }
          #jc-theme-canopy-fixture .jc-hidden-management-header h2 { margin:0; font-size:1rem; }
          #jc-theme-canopy-fixture .jc-hidden-management-search { flex:1; }
          #jc-theme-canopy-fixture .jc-hidden-management-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:.6rem; padding:.8rem; }
          #jc-theme-canopy-fixture .jc-hidden-item-card { overflow:hidden; }
          #jc-theme-canopy-fixture .jc-hidden-item-poster { min-block-size:4.5rem; background:linear-gradient(135deg,var(--jc-color-primary),var(--jc-color-secondary)); }
          #jc-theme-canopy-fixture .jc-hidden-item-info { padding:.55rem; }
          #jc-theme-canopy-fixture .jc-hidden-item-name { display:block; }
          #jc-theme-canopy-fixture .jc-undo-toast { position:relative !important; inset:auto !important; transform:none !important; display:flex; align-items:center; gap:.6rem; max-inline-size:none !important; margin-block-start:.7rem; }
          @media (max-width:899px) {
            #jc-theme-canopy-fixture > main { grid-template-columns:minmax(0,1fr); }
            #jc-theme-canopy-fixture #jellyfin-canopy-panel .jc-panel-body { grid-template-columns:8.5rem minmax(0,1fr); }
            #jc-theme-canopy-fixture .card-grid { grid-template-columns:repeat(3,minmax(8.5rem,1fr)); overflow-x:auto; }
          }
          @media (max-width:480px) {
            #jc-theme-canopy-fixture #jc-native-tabs-group { flex:0 0 7.5rem; display:grid !important; grid-template-columns:minmax(0,1fr) 1px 44px; gap:2px !important; overflow:visible !important; }
            #jc-theme-canopy-fixture #jc-native-tab-btn-requests { padding-inline:.3rem; font-size:.75rem; }
            #jc-theme-canopy-fixture #jellyfin-canopy-panel .jc-panel-body { grid-template-columns:7.75rem minmax(0,1fr); }
            #jc-theme-canopy-fixture #jellyfin-canopy-panel .tab-button { padding-inline:.4rem; font-size:.875rem; }
            #jc-theme-canopy-fixture .fixture-dialogs { grid-template-columns:minmax(0,1fr); }
            #jc-theme-canopy-fixture .card-grid { grid-template-columns:repeat(3,8.6rem); }
          }
          @media (orientation:landscape) and (max-height:599px) {
            #jc-theme-canopy-fixture { padding:.45rem; }
            #jc-theme-canopy-fixture > main { grid-template-columns:minmax(0,1.15fr) minmax(0,.85fr); margin-block-start:.45rem; }
            #jc-theme-canopy-fixture .card-grid { grid-template-columns:repeat(3,minmax(7.5rem,1fr)); overflow:visible; }
            #jc-theme-canopy-fixture .cardScalable { min-block-size:8rem; }
            #jc-theme-canopy-fixture .fixture-dialogs { display:none; }
            #jc-theme-canopy-fixture .jc-hidden-management-panel { display:none; }
          }
        `;
        const fixture = document.createElement('div');
        fixture.id = 'jc-theme-canopy-fixture';
        fixture.innerHTML = `
          <header><span class="mark" aria-hidden="true">JC</span><div class="heading"><h1>Canopy surfaces · one visual language</h1><p>Protection, settings, tags and notifications stay policy-owned.</p></div>
            <div id="jc-native-tabs-group" data-jc-theme-surface="home" data-jc-theme-component="native-tab-actions"><button id="jc-native-tab-btn-requests" type="button" aria-current="page">Requests</button><span id="jc-native-tabs-separator"></span><button id="randomItemButton" type="button" aria-label="Random item">◆</button></div></header>
          <main>
            <div class="fixture-column">
              <section id="jellyfin-canopy-panel" data-jc-theme-surface="settings" data-jc-theme-component="enhanced-panel">
                <div class="jc-panel-header"><strong>Enhanced settings</strong><span>Modern desktop + phone</span></div>
                <div class="jc-panel-body"><nav class="jc-panel-nav"><input class="jc-panel-search" aria-label="Search settings" placeholder="Search"><div class="jc-panel-nav-items"><button class="tab-button active" type="button">Appearance</button><button class="tab-button" type="button">Protection</button><button class="tab-button" type="button">Tags</button></div></nav>
                  <div class="jc-panel-main"><section class="jc-pane active"><h2 class="jc-pane-title">Theme-aware controls</h2><div class="setting-card"><label><input type="checkbox" checked> Collision-safe card overlays</label></div><div class="setting-card"><label><input type="checkbox" checked> Fail-closed spoiler protection</label></div></section></div></div>
                <div class="panel-footer"><button type="button">Cancel</button><button class="jc-theme-button" type="button">Apply</button></div>
              </section>
              <section class="card-grid" aria-label="Canopy card overlay combinations">
                <article class="card"><div class="cardBox"><div class="cardScalable jc-anime-filler-anchor"><span class="jc-anime-filler-marker" data-jc-theme-component="warning-badge">Filler episode</span><div class="jc-tag-host"><div class="jc-tag-lane" data-jc-tag-position="top-left" data-jc-theme-component="card-tag-lane"><div class="genre-overlay-container"><span class="genre-tag">✦</span></div></div><div class="jc-tag-lane" data-jc-tag-position="top-right" data-jc-theme-component="card-tag-lane"><div class="quality-overlay-container"><span class="quality-overlay-label">4K HDR10+</span></div><div class="rating-overlay-container"><span class="rating-tag"><span class="rating-star-icon">★</span><span class="rating-text">9.1</span></span><span class="rating-tag jc-userreview-tag">♥ 10</span></div></div><div class="jc-tag-lane" data-jc-tag-position="bottom-left"><div class="language-overlay-container"><span class="language-flag" role="img" aria-label="French audio"></span></div></div></div></div><button class="jc-hide-btn" type="button" aria-label="Hide item">×</button><div class="cardFooter"><strong>Combined overlays</strong><span>Hide, filler and tag lanes occupy separate collision-safe positions.</span></div></div></article>
                <article class="card"><div class="cardBox"><div class="cardScalable jc-anime-filler-anchor"><span class="jc-anime-filler-marker" data-jc-theme-component="warning-badge">Filler episode</span><div class="jc-tag-host"><div class="jc-tag-lane" data-jc-tag-position="top-right"><div class="quality-overlay-container"><span class="quality-overlay-label">1080p</span></div><div class="rating-overlay-container"><span class="rating-tag">87%</span></div></div></div></div><div class="cardFooter"><strong>Warning coexistence</strong><span>Filler and rating remain independently visible.</span></div></div></article>
                <article class="card"><div class="cardBox"><div class="cardScalable" data-jc-spoiler-state="on" style="filter:blur(8px)"></div><div class="cardFooter"><strong>Protected artwork</strong><span>The theme cannot remove this feature-owned blur.</span></div></div><div class="jc-hidden" style="display:none">Protected overview must stay hidden</div><div data-jc-home-removed="1" style="display:none">Removed home item</div></article>
              </section>
            </div>
            <div class="fixture-column">
              <section class="fixture-dialogs"><div class="jc-spoiler-confirm-dialog" data-jc-theme-surface="protection" data-jc-theme-component="confirmation-dialog"><h3>Disable Spoiler Guard?</h3><p>Protected ratings remain concealed until you confirm.</p><label class="jc-spoiler-confirm-snooze"><input type="checkbox"> Don’t ask again briefly</label><div class="jc-spoiler-confirm-buttons"><button class="jc-spoiler-confirm-cancel" type="button">Cancel</button><button class="jc-spoiler-confirm-ok" type="button">Disable</button></div></div>
                <div class="jc-hide-confirm-dialog" data-jc-theme-surface="hidden-content" data-jc-theme-component="confirmation-dialog"><h3>Hide this item?</h3><p>Choose a scope without changing playback history.</p><div class="jc-hide-confirm-buttons"><button class="jc-hide-confirm-cancel" type="button">Cancel</button><button class="jc-hide-confirm-hide" type="button">Hide everywhere</button></div></div></section>
              <section class="jc-hidden-management-panel" data-jc-theme-component="management-panel"><div class="jc-hidden-management-header"><h2>Hidden content</h2><button class="jc-hidden-management-close" type="button" aria-label="Close">×</button></div><div class="jc-hidden-management-toolbar"><input class="jc-hidden-management-search" aria-label="Search hidden content" placeholder="Search a very long localized title"></div><div class="jc-hidden-management-grid"><article class="jc-hidden-item-card"><div class="jc-hidden-item-poster"></div><div class="jc-hidden-item-info"><strong class="jc-hidden-item-name">A Hidden Film with a Long Name</strong><div class="jc-hidden-item-meta">Movie · hidden everywhere</div><button class="jc-hidden-item-unhide" type="button">Unhide</button></div></article><article class="jc-hidden-item-card"><div class="jc-hidden-item-poster"></div><div class="jc-hidden-item-info"><strong class="jc-hidden-item-name">Episode 12</strong><div class="jc-hidden-item-meta">Next Up only</div><button class="jc-hidden-item-unhide" type="button">Unhide</button></div></article></div></section>
              <aside class="jc-undo-toast jc-visible" data-jc-theme-surface="hidden-content" data-jc-theme-component="undo-notification"><span class="jc-undo-toast-text">Item hidden from Continue Watching.</span><button class="jc-undo-btn" type="button">Undo</button></aside>
            </div>
          </main>`;
        const semanticFixtures = [
            ['.jc-panel-header', 'panel-header'],
            ['.jc-panel-nav', 'panel-navigation'],
            ['.jc-panel-main', 'panel-content'],
            ['.jc-tag-lane', 'card-tag-lane'],
            ['.quality-overlay-container', 'card-tag-stack'],
            ['.rating-overlay-container', 'card-tag-stack'],
            ['.jc-hidden-management-panel', 'management-panel'],
        ] as const;
        for (const [selector, component] of semanticFixtures) {
            for (const element of fixture.querySelectorAll(selector)) {
                if (!element.hasAttribute('data-jc-theme-component')) {
                    element.setAttribute('data-jc-theme-component', component);
                }
            }
        }
        document.head.append(style);
        document.body.append(fixture);
    });
}

async function viewportEvidence(page: Page): Promise<{
    readonly documentOverflow: number;
    readonly fixtureOverflow: number;
    readonly minimumTarget: number;
    readonly minimumTargetDescriptor: string;
    readonly laneOverlap: number;
    readonly laneOverflow: number;
    readonly competingOverlayOverlap: number;
    readonly hiddenDisplay: string;
    readonly removedDisplay: string;
    readonly protectedFilter: string;
    readonly semanticHooks: number;
}> {
    return page.evaluate(() => {
        const fixture = document.getElementById('jc-theme-canopy-fixture')!;
        const targets = [...fixture.querySelectorAll<HTMLElement>(
            'button, input:not([type="checkbox"]), label:has(input[type="checkbox"])',
        )].filter((element) => {
            const box = element.getBoundingClientRect();
            return box.width > 0 && box.height > 0;
        });
        const lane = fixture.querySelector<HTMLElement>('.jc-tag-lane[data-jc-tag-position="top-right"]')!;
        const laneBox = lane.getBoundingClientRect();
        const cardBox = lane.closest('.cardScalable')!.getBoundingClientRect();
        const children = [...lane.children].map((child) => child.getBoundingClientRect());
        let overlap = 0;
        for (let index = 1; index < children.length; index += 1) {
            overlap = Math.max(overlap, children[index - 1].bottom - children[index].top);
        }
        const intersectionArea = (left: DOMRect, right: DOMRect): number => Math.max(
            0,
            Math.min(left.right, right.right) - Math.max(left.left, right.left),
        ) * Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
        let competingOverlayOverlap = 0;
        for (const card of fixture.querySelectorAll<HTMLElement>('.card')) {
            const overlays = [...card.querySelectorAll<HTMLElement>(
                '.jc-tag-lane[data-jc-tag-position], .jc-hide-btn, .jc-anime-filler-marker',
            )].map((element) => element.getBoundingClientRect())
                .filter((bounds) => bounds.width > 0 && bounds.height > 0);
            for (let leftIndex = 0; leftIndex < overlays.length; leftIndex += 1) {
                for (let rightIndex = leftIndex + 1; rightIndex < overlays.length; rightIndex += 1) {
                    competingOverlayOverlap = Math.max(
                        competingOverlayOverlap,
                        intersectionArea(overlays[leftIndex], overlays[rightIndex]),
                    );
                }
            }
        }
        const targetSizes = targets.map((target) => ({
            descriptor: `${target.tagName.toLowerCase()}#${target.id}.${target.className}`,
            height: target.getBoundingClientRect().height,
        })).sort((left, right) => left.height - right.height);
        return {
            documentOverflow: document.scrollingElement!.scrollWidth - innerWidth,
            fixtureOverflow: fixture.scrollWidth - fixture.clientWidth,
            minimumTarget: targetSizes[0].height,
            minimumTargetDescriptor: targetSizes[0].descriptor,
            laneOverlap: overlap,
            laneOverflow: Math.max(0, laneBox.right - cardBox.right, cardBox.left - laneBox.left),
            competingOverlayOverlap,
            hiddenDisplay: getComputedStyle(fixture.querySelector('.jc-hidden')!).display,
            removedDisplay: getComputedStyle(fixture.querySelector('[data-jc-home-removed]')!).display,
            protectedFilter: getComputedStyle(fixture.querySelector('[data-jc-spoiler-state="on"]')!).filter,
            semanticHooks: fixture.querySelectorAll('[data-jc-theme-surface], [data-jc-theme-component]').length,
        };
    });
}

async function themePresentationCount(page: Page): Promise<number> {
    return page.evaluate(() => document.querySelectorAll(
        '#jc-theme-studio-committed, #jc-theme-studio-preview',
    ).length);
}

test.describe.serial('Theme Studio core Canopy surfaces', () => {
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
                ThemeStudioMaximumEffectsLevel: 'full',
                ThemeStudioAllowDynamicColor: false,
                ThemeSelectorEnabled: false,
                LayoutEnforcement: 'None',
            }),
        });
    });

    test.afterEach(async ({ baseURL }) => {
        if (!admin || !original) return;
        await api(baseURL!, CONFIG_PATH, admin.token, {
            method: 'POST', body: JSON.stringify(original),
        });
    });

    test.afterAll(async ({ baseURL }) => {
        if (!admin || !original) return;
        await api(baseURL!, CONFIG_PATH, admin.token, {
            method: 'POST', body: JSON.stringify(original),
        });
    });

    test('desktop, wide and phone surfaces keep policy, focus and overlay lanes intact', async ({
        page,
        consoleErrors,
    }) => {
        await page.setViewportSize({ width: 1366, height: 768 });
        await seedModernCoarseLayout(page);
        await loginAs(page, 'admin', consoleErrors);
        await waitForThemeRuntime(page, 'desktop');
        await previewHighContrast(page);
        await mountCanopyFixture(page);

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
            expect(evidence.minimumTarget, `${viewport.name}: ${JSON.stringify(evidence)}`)
                .toBeGreaterThanOrEqual(44);
            expect(evidence.laneOverlap, viewport.name).toBeLessThanOrEqual(0.5);
            expect(evidence.laneOverflow, viewport.name).toBeLessThanOrEqual(1);
            expect(evidence.competingOverlayOverlap, `${viewport.name}: ${JSON.stringify(evidence)}`)
                .toBeLessThanOrEqual(1);
            expect(evidence.hiddenDisplay).toBe('none');
            expect(evidence.removedDisplay).toBe('none');
            expect(evidence.protectedFilter).toContain('blur');
            expect(evidence.semanticHooks).toBeGreaterThanOrEqual(12);
            await expect(page).toHaveScreenshot(`theme-studio-canopy-surfaces-${viewport.name}.png`, {
                animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02,
            });
            if (process.env.JC_CAPTURE_THEME_DOCS === '1' && viewport.name === 'desktop') {
                await page.screenshot({
                    path: 'docs/images/theme-studio-canopy-surfaces-desktop.png',
                    animations: 'disabled', caret: 'hide',
                });
            }
            if (process.env.JC_CAPTURE_THEME_DOCS === '1' && viewport.name === 'phone-portrait') {
                await page.screenshot({
                    path: 'docs/images/theme-studio-canopy-surfaces-phone.png',
                    animations: 'disabled', caret: 'hide',
                });
            }
        }

        await page.setViewportSize({ width: 1366, height: 768 });
        await waitForThemeRuntime(page, 'desktop');
        await page.evaluate(() => {
            document.documentElement.dir = 'rtl';
            document.getElementById('jc-theme-canopy-fixture')!.dir = 'rtl';
            window.JellyfinCanopy.core.themeStudio?.refresh();
        });
        const rtlEvidence = await viewportEvidence(page);
        expect(rtlEvidence.documentOverflow).toBeLessThanOrEqual(1);
        expect(rtlEvidence.fixtureOverflow).toBeLessThanOrEqual(1);
        expect(rtlEvidence.hiddenDisplay).toBe('none');
        expect(rtlEvidence.protectedFilter).toContain('blur');
        await page.locator('.jc-hidden-item-unhide').first().focus();
        expect(await page.locator('.jc-hidden-item-unhide').first().evaluate((element) =>
            getComputedStyle(element).outlineStyle)).toBe('solid');
        assertNoRuntimeErrors(consoleErrors);
    });

    test('tablet-only, legacy and TV markers retain stock presentation', async ({ page, consoleErrors }) => {
        await page.setViewportSize({ width: 1366, height: 768 });
        await seedModernCoarseLayout(page);
        await loginAs(page, 'admin', consoleErrors);
        await waitForThemeRuntime(page, 'desktop');
        await expect(page.locator('#jc-tag-pipeline-perf')).toHaveCount(1);

        const mountIndicatorFixture = async (): Promise<number> => page.evaluate(() => {
            document.getElementById('jc-unsupported-indicator-fixture')?.remove();
            const css = document.getElementById('jc-tag-pipeline-perf')?.textContent ?? '';
            const match = css.match(
                /\.jc-tag-lane\[data-jc-tag-position="top-right"\] > \.([a-z-]+-overlay-container)/,
            );
            if (!match) throw new Error('Nested native-indicator compatibility selector is missing');
            const card = document.createElement('div');
            card.id = 'jc-unsupported-indicator-fixture';
            card.innerHTML = '<div class="cardScalable"><span class="countIndicator">2</span>'
                + '<div class="jc-tag-host"><div class="jc-tag-lane" data-jc-tag-position="top-right">'
                + `<div class="${match[1]}">Tag</div></div></div></div>`;
            document.body.append(card);
            return Number.parseFloat(getComputedStyle(card.querySelector<HTMLElement>(`.${match[1]}`)!).marginTop);
        });

        await page.setViewportSize({ width: 820, height: 1180 });
        await expect.poll(() => themePresentationCount(page)).toBe(0);
        expect(await mountIndicatorFixture()).toBeGreaterThanOrEqual(20);
        await page.evaluate(() => {
            document.documentElement.classList.remove('jc-modern-layout');
            document.documentElement.classList.add('jc-legacy-layout');
            window.dispatchEvent(new Event('resize'));
        });
        await expect.poll(() => themePresentationCount(page)).toBe(0);
        expect(await mountIndicatorFixture()).toBeGreaterThanOrEqual(20);
        await page.evaluate(() => {
            document.documentElement.classList.remove('jc-legacy-layout');
            document.documentElement.classList.add('jc-modern-layout', 'layout-tv');
            document.documentElement.setAttribute('data-layout', 'tv');
            window.dispatchEvent(new Event('resize'));
        });
        await expect.poll(() => themePresentationCount(page)).toBe(0);
        expect(await mountIndicatorFixture()).toBeGreaterThanOrEqual(20);
        assertNoRuntimeErrors(consoleErrors);
    });
});
