import type { Page } from 'playwright/test';
import { assertNoRuntimeErrors, expect, loginAs, test, USERS } from './fixtures/auth';
import { api, authenticate, PLUGIN_ID, type Session } from './fixtures/api';

const CONFIG_PATH = `/Plugins/${PLUGIN_ID}/Configuration`;

async function seedModernLayout(page: Page): Promise<void> {
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
            && document.querySelectorAll('#jc-theme-studio-committed').length === 1
            && document.getElementById('jc-theme-studio-operational-surfaces') instanceof HTMLLinkElement
            && Boolean((document.getElementById('jc-theme-studio-operational-surfaces') as HTMLLinkElement).sheet);
    }, breakpoint);
}

async function previewOperationalTheme(page: Page): Promise<void> {
    const accepted = await page.evaluate(() => {
        const runtime = window.JellyfinCanopy.core.themeStudio;
        const draft = runtime?.getConfiguration();
        const active = draft?.Profiles.find((profile) => profile.Id === draft.ActiveProfileId)
            ?? draft?.Profiles[0];
        if (!runtime || !draft || !active) throw new Error('Theme Studio configuration is unavailable');
        active.BasePreset = 'studio';
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
            'effects.level': 'minimal',
            'layout.density': 'cozy',
        };
        return runtime.preview(draft, { allowScheduling: false });
    });
    expect(accepted).toBe(true);
}

async function mountOperationalFixture(page: Page): Promise<void> {
    await page.evaluate(() => {
        document.getElementById('jc-theme-operational-fixture')?.remove();
        document.getElementById('jc-theme-operational-fixture-style')?.remove();
        const style = document.createElement('style');
        style.id = 'jc-theme-operational-fixture-style';
        style.textContent = `
          #jc-theme-operational-fixture {
            position:fixed; inset:0; z-index:1000000; box-sizing:border-box; overflow:auto;
            background:var(--jc-color-canvas,#101318); color:var(--jc-color-text,#fff);
            font-family:var(--jc-type-family-ui,system-ui); padding:clamp(.55rem,1.5vw,1.15rem);
          }
          #jc-theme-operational-fixture * { box-sizing:border-box; }
          #jc-theme-operational-fixture > header { display:flex; align-items:center; gap:.65rem; max-inline-size:92rem; margin-inline:auto; }
          #jc-theme-operational-fixture > header .mark { display:grid; place-items:center; inline-size:2.75rem; block-size:2.75rem; flex:none; border-radius:50%; background:var(--jc-color-primary,#00a4dc); color:var(--jc-color-on-primary,#000); font-weight:900; }
          #jc-theme-operational-fixture > header h1 { margin:0; font-size:clamp(1.1rem,2.3vw,1.65rem); overflow-wrap:anywhere; }
          #jc-theme-operational-fixture > header p { margin:.05rem 0 0; color:var(--jc-color-text-muted,#bbb); overflow-wrap:anywhere; }
          #jc-theme-operational-fixture > main { display:grid; grid-template-columns:minmax(25rem,1.1fr) minmax(23rem,.9fr); gap:.8rem; max-inline-size:92rem; margin:.8rem auto 0; }
          #jc-theme-operational-fixture .fixture-column { display:grid; align-content:start; gap:.8rem; min-inline-size:0; }
          #jc-theme-operational-fixture button,
          #jc-theme-operational-fixture input,
          #jc-theme-operational-fixture textarea { font:inherit; }
          #jc-theme-operational-fixture #jc-active-streams-panel { position:relative !important; inset:auto !important; inline-size:100% !important; max-inline-size:none !important; max-block-size:none !important; overflow:visible !important; }
          #jc-theme-operational-fixture .jc-as-panel-header { display:flex; align-items:center; }
          #jc-theme-operational-fixture .jc-as-panel-title { margin-inline-end:auto; }
          #jc-theme-operational-fixture .jc-as-card-with-poster { display:flex; }
          #jc-theme-operational-fixture .jc-as-card-main { flex:1; }
          #jc-theme-operational-fixture .jc-as-card-top,
          #jc-theme-operational-fixture .jc-as-progress-row,
          #jc-theme-operational-fixture .jc-as-user,
          #jc-theme-operational-fixture .jc-as-badges,
          #jc-theme-operational-fixture .jc-as-actions { display:flex; align-items:center; gap:.4rem; }
          #jc-theme-operational-fixture .jc-as-card-info { flex:1; min-inline-size:0; }
          #jc-theme-operational-fixture .jc-as-progress-bar { flex:1; }
          #jc-theme-operational-fixture .jc-as-progress-fill { block-size:100%; }
          #jc-theme-operational-fixture .jc-as-broadcast-form { display:grid; grid-template-columns:minmax(0,1fr) 7rem; gap:.4rem; }
          #jc-theme-operational-fixture .jc-as-broadcast-form textarea { grid-column:1/-1; min-block-size:3.5rem; }
          #jc-theme-operational-fixture .jc-as-broadcast-actions { grid-column:1/-1; display:flex; justify-content:flex-end; }
          #jc-theme-operational-fixture .jc-calendar-page,
          #jc-theme-operational-fixture .jc-downloads-page,
          #jc-theme-operational-fixture .jc-bookmarks-page { padding:0 !important; }
          #jc-theme-operational-fixture .jc-calendar-header { display:flex; align-items:center; }
          #jc-theme-operational-fixture .jc-calendar-title { margin:0 auto 0 0; font-size:1.05rem; }
          #jc-theme-operational-fixture .jc-calendar-actions,
          #jc-theme-operational-fixture .jc-calendar-nav,
          #jc-theme-operational-fixture .jc-calendar-mode-toggle { display:flex; }
          #jc-theme-operational-fixture .jc-calendar-layout { grid-template-columns:minmax(0,1fr) 9.5rem !important; }
          #jc-theme-operational-fixture .jc-calendar-agenda { display:grid; gap:.35rem; }
          #jc-theme-operational-fixture .jc-calendar-agenda-row { display:grid; grid-template-columns:5.25rem minmax(0,1fr); gap:.35rem; }
          #jc-theme-operational-fixture .jc-calendar-agenda-event { display:flex; align-items:center; gap:.45rem; padding:.45rem; }
          #jc-theme-operational-fixture .jc-calendar-agenda-event-content { min-inline-size:0; }
          #jc-theme-operational-fixture .jc-calendar-agenda-event-title,
          #jc-theme-operational-fixture .jc-calendar-agenda-event-meta { display:flex; flex-wrap:wrap; gap:.25rem; }
          #jc-theme-operational-fixture .jc-calendar-sidebar { padding:.4rem; }
          #jc-theme-operational-fixture .jc-calendar-legend { display:grid; gap:.25rem; }
          #jc-theme-operational-fixture .jc-calendar-legend-item { display:flex; align-items:center; gap:.35rem; padding:.2rem .35rem; }
          #jc-theme-operational-fixture .jc-downloads-section { margin:0 !important; padding:.65rem !important; }
          #jc-theme-operational-fixture .jc-downloads-section > h2 { margin:0 0 .45rem; font-size:1rem; }
          #jc-theme-operational-fixture .jc-downloads-controls { display:flex; gap:.4rem; margin-block-end:.45rem; }
          #jc-theme-operational-fixture .jc-downloads-tabs,
          #jc-theme-operational-fixture .jc-requests-tabs { display:flex; gap:.3rem; min-inline-size:0; }
          #jc-theme-operational-fixture .jc-downloads-search-container { display:flex; align-items:center; padding-inline:.4rem; }
          #jc-theme-operational-fixture .jc-downloads-search-input { inline-size:100%; border:0 !important; }
          #jc-theme-operational-fixture .jc-downloads-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
          #jc-theme-operational-fixture .jc-download-card,
          #jc-theme-operational-fixture .jc-request-card { padding:.55rem; }
          #jc-theme-operational-fixture .jc-download-card-content,
          #jc-theme-operational-fixture .jc-request-card { display:flex; gap:.55rem; }
          #jc-theme-operational-fixture .jc-download-poster,
          #jc-theme-operational-fixture .jc-request-poster { inline-size:3.2rem; block-size:4.8rem; flex:none; background:linear-gradient(145deg,#245878,#492e68); }
          #jc-theme-operational-fixture .jc-download-info,
          #jc-theme-operational-fixture .jc-request-info { min-inline-size:0; flex:1; }
          #jc-theme-operational-fixture .jc-download-title,
          #jc-theme-operational-fixture .jc-request-title { font-weight:800; }
          #jc-theme-operational-fixture .jc-download-meta,
          #jc-theme-operational-fixture .jc-download-stats,
          #jc-theme-operational-fixture .jc-request-title-row,
          #jc-theme-operational-fixture .jc-request-meta { display:flex; flex-wrap:wrap; gap:.3rem; align-items:center; }
          #jc-theme-operational-fixture .jc-download-progress-container { margin-block-start:.45rem; }
          #jc-theme-operational-fixture .jc-bookmarks-grid { grid-template-columns:minmax(0,1fr); }
          #jc-theme-operational-fixture .jc-bookmark-item-header,
          #jc-theme-operational-fixture .jc-bookmark-main { display:flex; align-items:center; padding:.5rem; }
          #jc-theme-operational-fixture .jc-bookmark-item-poster { inline-size:3rem; block-size:4.5rem; flex:none; background:linear-gradient(145deg,#614031,#294e62); }
          #jc-theme-operational-fixture .jc-bookmark-item-info,
          #jc-theme-operational-fixture .jc-bookmark-info { flex:1; min-inline-size:0; }
          #jc-theme-operational-fixture .jc-bookmarks-list { padding:.35rem; }
          #jc-theme-operational-fixture .jc-bookmark-row { padding:.35rem; }
          #jc-theme-operational-fixture .jc-bm-library-modal-overlay { position:relative !important; inset:auto !important; padding:.4rem !important; margin-block-start:.55rem; }
          #jc-theme-operational-fixture .jc-bm-library-modal-container { inline-size:100% !important; max-block-size:none !important; overflow:visible !important; padding:.55rem; }
          #jc-theme-operational-fixture .jc-bookmark-modal-actions { display:flex; justify-content:flex-end; gap:.4rem; }
          #jc-theme-operational-fixture .policy-private { display:none; }
          @media (max-width:899px) {
            #jc-theme-operational-fixture > main { grid-template-columns:minmax(0,1fr); }
            #jc-theme-operational-fixture .jc-calendar-layout { display:grid !important; grid-template-columns:minmax(0,1fr) !important; }
            #jc-theme-operational-fixture .jc-calendar-sidebar { display:none; }
            #jc-theme-operational-fixture .jc-downloads-grid { grid-template-columns:minmax(0,1fr); }
            #jc-theme-operational-fixture .jc-bookmarks-grid { grid-template-columns:minmax(0,1fr); }
          }
          @media (max-width:480px) {
            #jc-theme-operational-fixture { padding:.45rem; }
            #jc-theme-operational-fixture > header p { font-size:.75rem; }
            #jc-theme-operational-fixture > main { margin-block-start:.45rem; gap:.55rem; }
            #jc-theme-operational-fixture .fixture-column { gap:.55rem; }
            #jc-theme-operational-fixture .jc-as-card:nth-of-type(2),
            #jc-theme-operational-fixture .jc-bm-library-modal-overlay { display:none; }
            #jc-theme-operational-fixture .jc-calendar-header { display:grid !important; }
            #jc-theme-operational-fixture .jc-calendar-actions-right { overflow-x:auto; }
          }
          @media (orientation:landscape) and (max-height:599px) {
            #jc-theme-operational-fixture > header p,
            #jc-theme-operational-fixture .jc-as-broadcast-form,
            #jc-theme-operational-fixture .jc-calendar-sidebar,
            #jc-theme-operational-fixture .jc-bookmark-item-header { display:none; }
            #jc-theme-operational-fixture > main { grid-template-columns:minmax(0,1fr) minmax(0,1fr); }
          }
        `;
        const fixture = document.createElement('div');
        fixture.id = 'jc-theme-operational-fixture';
        fixture.innerHTML = `
          <header><span class="mark" aria-hidden="true">JC</span><div><h1>Operational surfaces · live and readable</h1><p>Streams, calendar, downloads and bookmarks share the active theme without sharing policy.</p></div><button id="jc-active-streams" type="button" aria-label="Active streams"><span class="jc-as-icon">cast</span><span class="jc-as-sup">2</span></button></header>
          <main>
            <div class="fixture-column">
              <section id="jc-active-streams-panel" class="jc-as-panel-open" aria-label="Active streams panel"><div class="jc-as-panel-header"><strong class="jc-as-panel-title">2 active streams</strong><button class="jc-as-refresh-btn" aria-label="Refresh">↻</button><button class="jc-as-panel-close" aria-label="Close">×</button></div><div class="jc-as-panel-body">
                <article class="jc-as-card jc-as-card-with-poster" data-session-id="private-session-token"><div class="jc-as-poster" aria-hidden="true"></div><div class="jc-as-card-main"><div class="jc-as-card-top"><div class="jc-as-card-info"><a class="jc-as-card-title-link" href="#">A Film with a Deliberately Long Localized Title</a><div class="jc-as-card-subtitle">2026 · Web browser</div></div><span class="jc-as-state jc-as-state-playing">Playing</span></div><div class="jc-as-progress-row"><div class="jc-as-progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="38" aria-valuetext="38 percent"><div class="jc-as-transcode-fill" style="width:62%"></div><div class="jc-as-progress-fill" style="width:38%"></div></div><span class="jc-as-progress-time">19:04 / 49:59</span></div><div class="jc-as-badges"><span class="jc-as-badge jc-as-badge-transcode">Transcoding</span><span class="jc-as-badge">H.265 → H.264</span></div><div class="jc-as-user"><span aria-hidden="true">●</span><span>Administrator · Chrome</span></div><div class="jc-as-actions"><button class="jc-as-action-btn" type="button">Message</button><button class="jc-as-action-btn jc-as-action-btn-stop" type="button">Stop</button></div></div></article>
                <form class="jc-as-broadcast-form jc-as-broadcast-form-open"><input class="jc-as-broadcast-input" aria-label="Header" value="Server notice"><textarea class="jc-as-broadcast-textarea" aria-label="Message">Maintenance starts in ten minutes.</textarea><div class="jc-as-broadcast-actions"><button class="jc-as-broadcast-cancel" type="button">Cancel</button><button class="jc-as-broadcast-send" type="button">Broadcast</button></div></form>
                <span class="policy-private" data-jc-identity-user="private-user">Private endpoint must stay hidden</span>
              </div></section>
              <section class="jc-calendar-page"><div class="jc-calendar-header"><h2 class="jc-calendar-title">July 2026</h2><div class="jc-calendar-actions jc-calendar-actions-right"><div class="jc-calendar-nav"><button class="jc-calendar-view-btn active" aria-pressed="true">Agenda</button><button class="jc-calendar-view-btn" aria-pressed="false">Month</button><div class="jc-calendar-mode-toggle"><button class="jc-calendar-mode-btn active" aria-pressed="true" aria-label="List">☷</button></div></div></div></div><div class="jc-calendar-layout"><div class="jc-calendar-main"><div class="jc-calendar-agenda"><div class="jc-calendar-agenda-row"><div class="jc-calendar-agenda-date">Tue, Jul 21</div><div class="jc-calendar-agenda-events"><article class="jc-calendar-agenda-event jc-has-file" data-event-id="event-private"><span aria-hidden="true">▣</span><div class="jc-calendar-agenda-event-content"><div class="jc-calendar-agenda-event-title"><strong>New Episode</strong><span>Available</span></div><div class="jc-calendar-agenda-event-meta"><span>Episode</span><span class="jc-arr-badge">Sonarr</span><span>8:00 pm</span></div></div><button class="jc-calendar-play-btn" type="button" aria-label="Play">▶</button></article><article class="jc-calendar-agenda-event"><span aria-hidden="true">◆</span><div class="jc-calendar-agenda-event-content"><div class="jc-calendar-agenda-event-title"><strong>Digital Premiere</strong></div><div class="jc-calendar-agenda-event-meta"><span>Digital release</span><span class="jc-arr-badge">Radarr</span></div></div></article></div></div></div></div><aside class="jc-calendar-sidebar"><button class="jc-calendar-sidebar-toggle" aria-expanded="true">Filters</button><div class="jc-calendar-legend"><button type="button" class="jc-calendar-legend-item active" aria-pressed="true"><span>◆</span><span>Digital</span></button><button type="button" class="jc-calendar-legend-item" aria-pressed="false"><span>✓</span><span>Available</span></button></div></aside></div></section>
            </div>
            <div class="fixture-column">
              <section class="jc-downloads-page"><div class="jc-downloads-section"><h2>Downloads and requests</h2><div class="jc-downloads-controls"><div class="jc-downloads-tabs"><button class="jc-downloads-tab active" aria-pressed="true">All <span class="jc-downloads-tab-count">2</span></button><button class="jc-downloads-tab" aria-pressed="false">Downloading</button></div><div class="jc-downloads-search-container"><span>⌕</span><input class="jc-downloads-search-input" aria-label="Search downloads" value=""></div></div><div class="jc-downloads-grid"><article class="jc-download-card"><div class="jc-download-card-content"><div class="jc-download-poster"></div><div class="jc-download-info"><div class="jc-download-title">Feature Film</div><div class="jc-download-subtitle">1080p · Episode 4</div><div class="jc-download-meta"><span class="jc-download-badge">Downloading</span></div></div></div><div class="jc-download-progress-container"><div class="jc-download-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="64"><div class="jc-download-progress-bar" style="width:64%"></div></div><div class="jc-download-stats"><span>64%</span><span>ETA 8 min</span></div></div></article><article class="jc-request-card"><div class="jc-request-poster"></div><div class="jc-request-info"><div class="jc-request-title-row"><strong class="jc-request-title">Requested Series</strong><span class="jc-requests-status-chip jc-chip-pending">Pending approval</span></div><div class="jc-request-meta">Requested by member · 2 hours ago</div><div class="jc-request-actions"><button class="jc-request-approve-btn" data-source-token="signed-private-token" type="button" aria-label="Approve">✓</button><button class="jc-request-decline-btn" data-source-token="signed-private-token" type="button" aria-label="Decline">×</button></div></div></article></div></div></section>
              <section class="jc-bookmarks-page"><div class="jc-bookmarks-wrapper"><div class="jc-bookmark-tabs" role="group" aria-label="Bookmarks"><button type="button" class="jc-tab active" aria-pressed="true">Movies <span class="jc-tab-count">2</span></button><button type="button" class="jc-tab" aria-pressed="false">TV</button></div><div class="jc-bookmarks-grid"><article class="jc-bookmark-item jc-bookmark-item-orphaned"><div class="jc-bookmark-item-header"><div class="jc-bookmark-item-poster"></div><div class="jc-bookmark-item-info"><a class="jc-bookmark-item-title" href="#">Director's Cut</a><div class="jc-bookmark-item-meta">2 bookmarks · Orphaned media</div></div><button class="jc-btn-find-replacement" type="button" aria-label="Find replacement">⌕</button></div><div class="jc-bookmarks-list"><div class="jc-bookmark-row"><div class="jc-bookmark-main"><div class="jc-bookmark-bar"></div><div class="jc-bookmark-info"><div class="jc-bookmark-label">Resume after opening credits</div><div class="jc-bm-time">12:48 · 18%</div></div><div class="jc-bookmark-actions"><button class="jc-btn" type="button" aria-label="Play">▶</button><button class="jc-btn jc-btn-delete" type="button" aria-label="Delete">×</button></div></div></div></div></article></div><div class="jc-bm-library-modal-overlay"><div class="jc-bm-library-modal-container"><strong class="jc-modal-title">Resolve bookmark conflict</strong><p class="jc-modal-help-text">Choose the primary version; timestamps stay attached to the signed-in user.</p><div class="jc-merge-version is-target">Primary · 4K edition</div><div class="jc-bookmark-modal-actions"><button type="button">Cancel</button><button class="jc-modal-btn-primary" type="button">Merge</button></div></div></div></div></section>
            </div>
          </main>`;
        document.head.appendChild(style);
        document.body.appendChild(fixture);
    });
}

interface OperationalEvidence {
    documentOverflow: number;
    fixtureOverflow: number;
    undersized: string[];
    clipped: string[];
    nestedVerticalScrollers: string[];
    privateDisplay: string;
    progressValues: string[];
    stateText: string[];
    themeLayers: number;
}

async function operationalEvidence(page: Page): Promise<OperationalEvidence> {
    return page.evaluate(() => {
        const fixture = document.getElementById('jc-theme-operational-fixture')!;
        const visible = (element: Element): element is HTMLElement => {
            const node = element as HTMLElement;
            const style = getComputedStyle(node);
            const box = node.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
        };
        const controls = [...fixture.querySelectorAll('button, input, textarea')].filter(visible);
        const undersized = controls.filter((control) => {
            const box = control.getBoundingClientRect();
            return box.width < 43.5 || box.height < 43.5;
        }).map((control) => {
            const box = control.getBoundingClientRect();
            const label = control.getAttribute('aria-label') ?? control.textContent?.trim() ?? '';
            return `${control.tagName}.${control.className}[${label}]:${box.width.toFixed(1)}x${box.height.toFixed(1)}`;
        });
        const clipped = controls.filter((control) => {
            const box = control.getBoundingClientRect();
            if (box.bottom < 0 || box.top > innerHeight) return false;
            return box.left < -0.5 || box.right > innerWidth + 0.5;
        }).map((control) => `${control.tagName}.${control.className}`);
        const nestedVerticalScrollers = [...fixture.querySelectorAll<HTMLElement>('*')].filter((element) => {
            const style = getComputedStyle(element);
            return element !== fixture
                && /auto|scroll/.test(style.overflowY)
                && element.scrollHeight - element.clientHeight > 1;
        }).map((element) => `${element.tagName}.${element.className}`);
        return {
            documentOverflow: document.scrollingElement!.scrollWidth - innerWidth,
            fixtureOverflow: fixture.scrollWidth - fixture.clientWidth,
            undersized,
            clipped,
            nestedVerticalScrollers,
            privateDisplay: getComputedStyle(fixture.querySelector('.policy-private')!).display,
            progressValues: [...fixture.querySelectorAll('[role="progressbar"]')]
                .map((element) => element.getAttribute('aria-valuenow') ?? ''),
            stateText: [...fixture.querySelectorAll('.jc-as-state, .jc-as-badge-transcode, .jc-download-badge, .jc-requests-status-chip, .jc-bookmark-item-meta')]
                .map((element) => element.textContent?.trim() ?? ''),
            themeLayers: document.querySelectorAll('#jc-theme-studio-committed, #jc-theme-studio-preview').length,
        };
    });
}

test.describe.serial('Theme Studio operational surfaces', () => {
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

    test('desktop, wide and phone operational surfaces fit, remain semantic, and patch live in place', async ({
        page,
        consoleErrors,
    }) => {
        await page.setViewportSize({ width: 1366, height: 768 });
        await seedModernLayout(page);
        await loginAs(page, 'admin', consoleErrors);
        await waitForThemeRuntime(page, 'desktop');
        await previewOperationalTheme(page);
        await mountOperationalFixture(page);

        const viewports = [
            { name: 'desktop', width: 1366, height: 768, breakpoint: 'desktop' as const },
            { name: 'wide', width: 1920, height: 1080, breakpoint: 'wide' as const },
            { name: 'phone-portrait', width: 390, height: 844, breakpoint: 'phone' as const },
            { name: 'phone-landscape', width: 844, height: 390, breakpoint: 'phone' as const },
        ];

        for (const viewport of viewports) {
            await page.setViewportSize({ width: viewport.width, height: viewport.height });
            await waitForThemeRuntime(page, viewport.breakpoint);
            const evidence = await operationalEvidence(page);
            expect(evidence.documentOverflow, `${viewport.name}: ${JSON.stringify(evidence)}`).toBeLessThanOrEqual(1);
            expect(evidence.fixtureOverflow, `${viewport.name}: ${JSON.stringify(evidence)}`).toBeLessThanOrEqual(1);
            expect(evidence.undersized, `${viewport.name}: ${JSON.stringify(evidence)}`).toEqual([]);
            expect(evidence.clipped, `${viewport.name}: ${JSON.stringify(evidence)}`).toEqual([]);
            expect(evidence.nestedVerticalScrollers, `${viewport.name}: ${JSON.stringify(evidence)}`).toEqual([]);
            expect(evidence.privateDisplay).toBe('none');
            expect(evidence.progressValues).toEqual(['38', '64']);
            expect(evidence.stateText).toEqual(expect.arrayContaining([
                'Playing', 'Transcoding', 'Pending approval', '2 bookmarks · Orphaned media',
            ]));
            expect(evidence.themeLayers).toBe(2);
            await expect(page).toHaveScreenshot(`theme-studio-operational-surfaces-${viewport.name}.png`, {
                animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02,
            });
            if (process.env.JC_CAPTURE_THEME_DOCS === '1' && viewport.name === 'desktop') {
                await page.screenshot({
                    path: 'docs/images/theme-studio-operational-surfaces-desktop.png',
                    animations: 'disabled', caret: 'hide',
                });
            }
            if (process.env.JC_CAPTURE_THEME_DOCS === '1' && viewport.name === 'phone-portrait') {
                await page.screenshot({
                    path: 'docs/images/theme-studio-operational-surfaces-phone.png',
                    animations: 'disabled', caret: 'hide',
                });
            }
        }

        await page.setViewportSize({ width: 1366, height: 768 });
        await waitForThemeRuntime(page, 'desktop');
        const live = await page.evaluate(() => {
            const fixture = document.getElementById('jc-theme-operational-fixture')!;
            const card = fixture.querySelector('.jc-as-card')!;
            const streamProgress = fixture.querySelector<HTMLElement>('.jc-as-progress-fill')!;
            const downloadProgress = fixture.querySelector<HTMLElement>('.jc-download-progress-bar')!;
            const committed = document.getElementById('jc-theme-studio-committed');
            const preview = document.getElementById('jc-theme-studio-preview');
            const nativeInterval = window.setInterval;
            const NativeObserver = window.MutationObserver;
            let intervals = 0;
            let observers = 0;
            window.setInterval = ((...args: Parameters<typeof setInterval>) => {
                intervals += 1;
                return nativeInterval(...args);
            }) as typeof window.setInterval;
            window.MutationObserver = class extends NativeObserver {
                constructor(callback: MutationCallback) {
                    observers += 1;
                    super(callback);
                }
            };
            try {
                for (let index = 0; index < 12; index += 1) {
                    const value = 38 + index;
                    streamProgress.style.width = `${value}%`;
                    downloadProgress.style.width = `${64 + (index % 5)}%`;
                    downloadProgress.parentElement!.setAttribute('aria-valuenow', String(64 + (index % 5)));
                    const state = fixture.querySelector('.jc-as-state')!;
                    state.classList.toggle('jc-as-state-playing', index % 2 === 0);
                    state.classList.toggle('jc-as-state-paused', index % 2 !== 0);
                    state.textContent = index % 2 === 0 ? 'Playing' : 'Paused';
                }
            } finally {
                window.setInterval = nativeInterval;
                window.MutationObserver = NativeObserver;
            }
            return {
                sameCard: fixture.querySelector('.jc-as-card') === card,
                sameStreamProgress: fixture.querySelector('.jc-as-progress-fill') === streamProgress,
                sameDownloadProgress: fixture.querySelector('.jc-download-progress-bar') === downloadProgress,
                sameCommittedStyle: document.getElementById('jc-theme-studio-committed') === committed,
                samePreviewStyle: document.getElementById('jc-theme-studio-preview') === preview,
                intervals,
                observers,
                sourceToken: fixture.querySelector('.jc-request-approve-btn')?.getAttribute('data-source-token'),
                privateDisplay: getComputedStyle(fixture.querySelector('.policy-private')!).display,
            };
        });
        expect(live).toEqual({
            sameCard: true,
            sameStreamProgress: true,
            sameDownloadProgress: true,
            sameCommittedStyle: true,
            samePreviewStyle: true,
            intervals: 0,
            observers: 0,
            sourceToken: 'signed-private-token',
            privateDisplay: 'none',
        });

        await page.evaluate(() => {
            document.documentElement.dir = 'rtl';
            document.getElementById('jc-theme-operational-fixture')!.dir = 'rtl';
            window.JellyfinCanopy.core.themeStudio?.refresh();
        });
        const rtl = await operationalEvidence(page);
        expect(rtl.documentOverflow).toBeLessThanOrEqual(1);
        expect(rtl.fixtureOverflow).toBeLessThanOrEqual(1);
        expect(rtl.privateDisplay).toBe('none');
        await page.locator('.jc-request-approve-btn').focus();
        expect(await page.locator('.jc-request-approve-btn').evaluate((element) =>
            getComputedStyle(element).outlineStyle)).toBe('solid');
        assertNoRuntimeErrors(consoleErrors);
    });

    test('tablet-only, legacy and TV markers retain stock operational geometry and privacy', async ({
        page,
        consoleErrors,
    }) => {
        await page.setViewportSize({ width: 1366, height: 768 });
        await seedModernLayout(page);
        await loginAs(page, 'admin', consoleErrors);
        await waitForThemeRuntime(page, 'desktop');

        await page.setViewportSize({ width: 820, height: 1180 });
        await expect.poll(() => page.evaluate(() => document.querySelectorAll(
            '#jc-theme-studio-committed, #jc-theme-studio-preview',
        ).length)).toBe(0);
        await mountOperationalFixture(page);
        const stock = await page.evaluate(() => {
            const fixture = document.getElementById('jc-theme-operational-fixture')!;
            const button = fixture.querySelector<HTMLElement>('.jc-as-refresh-btn')!;
            const card = fixture.querySelector<HTMLElement>('.jc-download-card')!;
            const privateNode = fixture.querySelector<HTMLElement>('.policy-private')!;
            return {
                button: [button.getBoundingClientRect().width, button.getBoundingClientRect().height],
                cardBackground: getComputedStyle(card).backgroundColor,
                privateDisplay: getComputedStyle(privateNode).display,
                overflow: fixture.scrollWidth - fixture.clientWidth,
            };
        });

        const evidenceForCurrentMode = async (): Promise<typeof stock> => page.evaluate(() => {
            const fixture = document.getElementById('jc-theme-operational-fixture')!;
            const button = fixture.querySelector<HTMLElement>('.jc-as-refresh-btn')!;
            const card = fixture.querySelector<HTMLElement>('.jc-download-card')!;
            const privateNode = fixture.querySelector<HTMLElement>('.policy-private')!;
            return {
                button: [button.getBoundingClientRect().width, button.getBoundingClientRect().height],
                cardBackground: getComputedStyle(card).backgroundColor,
                privateDisplay: getComputedStyle(privateNode).display,
                overflow: fixture.scrollWidth - fixture.clientWidth,
            };
        });
        const expectStockGeometry = (evidence: typeof stock): void => {
            expect(evidence.button[0]).toBeLessThan(44);
            expect(evidence.button[1]).toBeLessThan(44);
            expect(evidence.cardBackground).toBe('rgba(0, 0, 0, 0)');
            expect(evidence.privateDisplay).toBe('none');
            expect(evidence.overflow).toBeLessThanOrEqual(1);
        };
        expectStockGeometry(stock);

        await page.evaluate(() => {
            document.documentElement.classList.remove('jc-modern-layout');
            document.documentElement.classList.add('jc-legacy-layout');
            window.dispatchEvent(new Event('resize'));
        });
        await expect.poll(() => page.evaluate(() => document.querySelectorAll(
            '#jc-theme-studio-committed, #jc-theme-studio-preview',
        ).length)).toBe(0);
        expectStockGeometry(await evidenceForCurrentMode());

        await page.evaluate(() => {
            document.documentElement.classList.remove('jc-legacy-layout');
            document.documentElement.classList.add('jc-modern-layout', 'layout-tv');
            document.documentElement.setAttribute('data-layout', 'tv');
            window.dispatchEvent(new Event('resize'));
        });
        await expect.poll(() => page.evaluate(() => document.querySelectorAll(
            '#jc-theme-studio-committed, #jc-theme-studio-preview',
        ).length)).toBe(0);
        expectStockGeometry(await evidenceForCurrentMode());
        assertNoRuntimeErrors(consoleErrors);
    });
});
