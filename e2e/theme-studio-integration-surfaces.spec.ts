import type { Page } from 'playwright/test';
import { assertNoRuntimeErrors, expect, loginAs, test, USERS } from './fixtures/auth';
import { api, authenticate, PLUGIN_ID, type Session } from './fixtures/api';

const CONFIG_PATH = `/Plugins/${PLUGIN_ID}/Configuration`;
const STYLE_IDS = [
    'jc-theme-studio-seerr-surfaces',
    'jc-theme-studio-arr-surfaces',
    'jc-theme-studio-external-surfaces',
] as const;

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

async function waitForIntegrationTheme(page: Page, breakpoint: 'phone' | 'desktop' | 'wide'): Promise<void> {
    await page.waitForFunction(({ expected, ids }) => {
        const root = document.documentElement;
        return root.getAttribute('data-jc-theme-active') === 'true'
            && root.getAttribute('data-jc-theme-breakpoint') === expected
            && ids.every((id) => {
                const link = document.getElementById(id);
                return link instanceof HTMLLinkElement && Boolean(link.sheet);
            });
    }, { expected: breakpoint, ids: STYLE_IDS });
}

async function previewIntegrationTheme(page: Page): Promise<void> {
    expect(await page.evaluate(() => {
        const runtime = window.JellyfinCanopy.core.themeStudio;
        const draft = runtime?.getConfiguration();
        const active = draft?.Profiles.find((profile) => profile.Id === draft.ActiveProfileId)
            ?? draft?.Profiles[0];
        if (!runtime || !draft || !active) throw new Error('Theme Studio configuration is unavailable');
        active.BasePreset = 'canopy';
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
        return runtime.preview(draft, { allowScheduling: false });
    })).toBe(true);
}

async function mountIntegrationFixture(page: Page): Promise<void> {
    await page.evaluate(() => {
        document.getElementById('jc-theme-integration-fixture')?.remove();
        document.getElementById('jc-theme-integration-fixture-style')?.remove();
        const style = document.createElement('style');
        style.id = 'jc-theme-integration-fixture-style';
        style.textContent = `
          body > :not(#jc-theme-integration-fixture){display:none!important}
          #jc-theme-integration-fixture{position:fixed;inset:0;z-index:1000002;box-sizing:border-box;overflow:auto;background:var(--jc-color-canvas,#101318);color:var(--jc-color-text,#fff);padding:clamp(.5rem,1.4vw,1rem);font-family:var(--jc-type-family-ui,system-ui)}
          #jc-theme-integration-fixture *{box-sizing:border-box}
          #jc-theme-integration-fixture>header{display:flex;align-items:center;gap:.65rem;max-inline-size:94rem;margin-inline:auto}
          #jc-theme-integration-fixture>header .mark{display:grid;place-items:center;inline-size:2.75rem;block-size:2.75rem;flex:none;border-radius:50%;background:var(--jc-color-primary,#00a4dc);color:var(--jc-color-on-primary,#000);font-weight:900}
          #jc-theme-integration-fixture h1{margin:0;font-size:clamp(1.05rem,2vw,1.55rem)}
          #jc-theme-integration-fixture header p{margin:.1rem 0 0;color:var(--jc-color-text-muted,#bbb)}
          #jc-theme-integration-fixture>main{display:grid;grid-template-columns:minmax(25rem,1fr) minmax(25rem,1fr);gap:.75rem;max-inline-size:94rem;margin:.75rem auto 0}
          #jc-theme-integration-fixture .fixture-column{display:grid;align-content:start;gap:.75rem;min-inline-size:0}
          #jc-theme-integration-fixture button,#jc-theme-integration-fixture input,#jc-theme-integration-fixture select,#jc-theme-integration-fixture textarea{font:inherit}
          #jc-theme-integration-fixture .seerr-section,#jc-theme-integration-fixture .jc-discovery-feed,#jc-theme-integration-fixture .tmdb-reviews-section,#jc-theme-integration-fixture .streaming-lookup-container{padding:0!important}
          #jc-theme-integration-fixture .jc-discovery-toolbar,#jc-theme-integration-fixture .seerr-button-group,#jc-theme-integration-fixture .jc-more-info-actions,#jc-theme-integration-fixture .seerr-discovery-header,#jc-theme-integration-fixture .seerr-discovery-filter,#jc-theme-integration-fixture .seerr-discovery-sort,#jc-theme-integration-fixture .tmdb-review-header,#jc-theme-integration-fixture .jc-review-form-btns,#jc-theme-integration-fixture .streaming-result-header,#jc-theme-integration-fixture .streaming-controls,#jc-theme-integration-fixture .streaming-providers,#jc-theme-integration-fixture .integration-link-row,#jc-theme-integration-fixture .integration-state-row{display:flex}
          #jc-theme-integration-fixture .jc-discovery-row-cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}
          #jc-theme-integration-fixture .seerr-card{position:relative}
          #jc-theme-integration-fixture .seerr-card .cardBox{display:grid;overflow:visible}
          #jc-theme-integration-fixture .seerr-card .cardScalable{position:relative;block-size:8rem;overflow:hidden}
          #jc-theme-integration-fixture .seerr-card .cardPadder{display:none}
          #jc-theme-integration-fixture .seerr-card .poster{position:absolute;inset:0;block-size:auto;background:linear-gradient(145deg,#245878,#492e68)}
          #jc-theme-integration-fixture .seerr-status-badge{position:absolute;inset-block-start:.4rem;inset-inline-end:.4rem;display:inline-flex;gap:.25rem;padding:.25rem .4rem}
          #jc-theme-integration-fixture .seerr-card .seerr-overview{font-size:.75rem}
          #jc-theme-integration-fixture .seerr-card .seerr-overview .content{-webkit-line-clamp:2}
          #jc-theme-integration-fixture .seerr-card .cardText{padding:.2rem .55rem;text-align:start}
          #jc-theme-integration-fixture .seerr-card .cardText-first{font-weight:800}
          #jc-theme-integration-fixture .fixture-more-info-stage .jc-more-info-modal{position:relative!important;inset:auto!important;z-index:auto!important;display:block!important;opacity:1!important;overflow:visible!important;background:transparent!important}
          #jc-theme-integration-fixture .fixture-more-info-stage .modal-overlay{inline-size:100%;block-size:auto;overflow:visible}
          #jc-theme-integration-fixture .fixture-more-info-stage .modal-container{position:relative;inline-size:100%!important;max-inline-size:100%!important;block-size:auto;max-block-size:none!important;padding:.6rem;overflow:visible}
          #jc-theme-integration-fixture .fixture-more-info-stage .modal-main{display:grid;grid-template-columns:minmax(0,1fr) minmax(12rem,.7fr);gap:.55rem}
          #jc-theme-integration-fixture .jc-download-progress .fill,#jc-theme-integration-fixture .jc-arr-progress-fill{block-size:100%}
          #jc-theme-integration-fixture .jc-download-meta,#jc-theme-integration-fixture .jc-arr-release-meta,#jc-theme-integration-fixture .jc-arr-progress-meta{display:flex;flex-wrap:wrap;gap:.35rem}
          #jc-theme-integration-fixture .arr-dropdown-menu{position:relative!important;display:grid!important;inline-size:100%!important;max-block-size:none!important}
          #jc-theme-integration-fixture .jc-arr-modal-overlay{position:relative!important;padding:0!important;background:transparent!important}
          #jc-theme-integration-fixture .jc-arr-modal{inline-size:100%!important;max-block-size:none!important}
          #jc-theme-integration-fixture .jc-arr-modal-header,#jc-theme-integration-fixture .jc-arr-modal-footer,#jc-theme-integration-fixture .jc-arr-release,#jc-theme-integration-fixture .jc-arr-manage-row{display:flex}
          #jc-theme-integration-fixture .jc-arr-modal-titles,#jc-theme-integration-fixture .jc-arr-release-main{flex:1;min-inline-size:0}
          #jc-theme-integration-fixture .jc-arr-modal-body{overflow:visible!important;padding:.55rem}
          #jc-theme-integration-fixture .jc-arr-release-list{display:grid;gap:.4rem}
          #jc-theme-integration-fixture .tmdb-reviews-section,#jc-theme-integration-fixture .streaming-lookup-container{display:grid;gap:.5rem}
          #jc-theme-integration-fixture .jc-review-star-picker{display:flex}
          #jc-theme-integration-fixture .streaming-result-header{justify-content:space-between}
          #jc-theme-integration-fixture .streaming-providers,#jc-theme-integration-fixture .integration-link-row,#jc-theme-integration-fixture .integration-state-row{flex-wrap:wrap;gap:.4rem}
          #jc-theme-integration-fixture .jc-arr-switch{display:flex;align-items:center;gap:.4rem}
          #jc-theme-integration-fixture .policy-private{display:none}
          #jc-theme-integration-fixture>.streaming-settings-modal{position:fixed;inset:0;z-index:1000003;align-items:center;justify-content:center}
          @media(max-width:899px){#jc-theme-integration-fixture>main{grid-template-columns:minmax(0,1fr)}#jc-theme-integration-fixture .fixture-more-info-stage .modal-main{grid-template-columns:minmax(0,1fr)}}
          @media(max-width:480px){#jc-theme-integration-fixture{padding:.4rem}#jc-theme-integration-fixture header p{font-size:.74rem}#jc-theme-integration-fixture>main{gap:.5rem;margin-block-start:.5rem}#jc-theme-integration-fixture .fixture-column{gap:.5rem}#jc-theme-integration-fixture .jc-discovery-row-cards{grid-template-columns:minmax(0,1fr)}#jc-theme-integration-fixture .seerr-card:nth-child(2),#jc-theme-integration-fixture .tmdb-review-card:nth-of-type(2){display:none}}
          @media(orientation:landscape) and (max-height:599px){#jc-theme-integration-fixture header p,#jc-theme-integration-fixture .seerr-card:nth-child(2),#jc-theme-integration-fixture .streaming-lookup-container{display:none}#jc-theme-integration-fixture>main{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}
        `;
        const fixture = document.createElement('div');
        fixture.id = 'jc-theme-integration-fixture';
        fixture.innerHTML = `
          <header><span class="mark" aria-hidden="true">JC</span><div><h1>Discovery and integrations</h1><p>Requests, releases, reviews and availability remain clear without sharing service policy.</p></div></header>
          <main>
            <div class="fixture-column">
              <section class="seerr-section"><div data-producer="seerr-discovery-header"></div><div class="jc-discovery-feed"><div class="jc-discovery-toolbar"><button class="jc-discovery-customize-btn" type="button">Customize rows</button></div><div class="jc-discovery-row"><h2 class="sectionTitle sectionTitle-cards focuscontainer-x padded-left padded-right">Discover next</h2><div class="jc-discovery-row-cards">
                <article class="card overflowPortraitCard seerr-card"><div class="cardBox cardBox-bottompadded"><div class="cardScalable"><div class="cardPadder cardPadder-overflowPortrait"></div><div class="cardImageContainer coveredImage cardContent seerr-poster-image poster"><span class="seerr-status-badge status-available" role="status" aria-label="Available"><span aria-hidden="true">✓</span> Available</span></div><div class="cardOverlayContainer"></div><div class="seerr-overview"><div class="content">A locally rendered discovery card with a long translated synopsis that can wrap safely.</div><button class="seerr-request-button seerr-button-available" disabled>✓ Available</button></div></div><div class="cardText cardTextCentered cardText-first"><a class="seerr-more-info-link" href="#">Available feature film</a></div><div class="cardText cardTextCentered cardText-secondary seerr-meta">2026 · Movie</div></div></article>
                <article class="card overflowPortraitCard seerr-card"><div class="cardBox cardBox-bottompadded"><div class="cardScalable"><div class="cardPadder cardPadder-overflowPortrait"></div><div class="cardImageContainer coveredImage cardContent seerr-poster-image poster"><span class="seerr-status-badge status-pending" role="status" aria-label="Pending approval"><span aria-hidden="true">◷</span> Pending</span></div><div class="cardOverlayContainer"></div><div class="seerr-overview"><div class="content">The request is visibly pending through text, icon, outline and shape.</div><button class="seerr-request-button seerr-button-pending permission-action" type="button" disabled aria-disabled="true">◷ Admin approval required</button></div></div><div class="cardText cardTextCentered cardText-first"><a class="seerr-more-info-link" href="#">Requested series</a></div><div class="cardText cardTextCentered cardText-secondary seerr-meta">TV · 4 seasons</div></div></article>
              </div></div></div></section>
              <div class="integration-state-row"><span class="seerr-request-state seerr-request-state-pending" role="status"><span aria-hidden="true">◷</span><span>Pending approval</span></span><span class="seerr-request-state seerr-request-state-approved" role="status"><span aria-hidden="true">✓</span><span>Request approved</span></span><span class="seerr-request-state seerr-request-state-declined" role="status"><span aria-hidden="true">✕</span><span>Declined</span></span><span class="seerr-request-state seerr-request-state-failed" role="status"><span aria-hidden="true">!</span><span>Failed</span></span></div>
              <div class="fixture-more-info-stage"><section class="jc-more-info-modal"><div class="modal-overlay"><div class="modal-container" role="dialog" aria-label="Request details"><div class="modal-content"><div class="modal-main"><div class="modal-left"><h2 class="title">Request details and seasons</h2><div class="overview-section"><p>Status, actions and download progress fit the same hero on desktop and mobile sheets.</p></div><div class="jc-more-info-actions"><button class="seerr-request-button seerr-button-request">Request in 4K</button><button>Open Seerr</button></div></div><div class="modal-right jc-more-info-right-panel"><span class="jc-status-chip chip-processing">↻ Processing</span><div class="jc-download-row"><div class="jc-download-title">Episode with an intentionally long localized release name</div><div class="jc-download-progress" role="progressbar" aria-label="Download" aria-valuemin="0" aria-valuemax="100" aria-valuenow="62"><div class="fill" style="width:62%"></div></div><div class="jc-download-meta"><span>62%</span><span>Downloading</span><span>ETA 12 min</span></div></div></div></div></div></div></div></section></div>
              <section class="streaming-lookup-container"><h2 class="streaming-title">Available elsewhere</h2><div class="streaming-result"><div class="streaming-result-header"><a class="streaming-title elsewhere-link-reset" href="#">Available in Australia</a><div class="streaming-controls"><button class="streaming-settings-button" aria-label="Availability settings">⚙</button><button class="streaming-result-close" aria-label="Close availability">×</button></div></div><div class="streaming-providers"><div class="streaming-provider-chip"><span class="streaming-provider-name">Local streaming provider with a very long name</span></div></div></div><div class="integration-state-row"><button class="streaming-search-button streaming-loading" type="button" aria-busy="true">↻ Refreshing</button><span class="streaming-empty" role="status">No configured providers match</span><span class="streaming-error" role="alert">Provider lookup failed safely</span></div><div class="integration-link-row"><a class="letterboxd-link" href="#">Letterboxd</a><span class="mediaInfoItem-releaseDate"><span class="jc-release-date-icon" aria-hidden="true">◷</span> Digital release · 28 July 2026</span></div></section>
            </div>
            <div class="fixture-column">
              <section class="arr-dropdown"><div class="integration-link-row"><a class="arr-link" role="button" aria-haspopup="menu" aria-expanded="true" href="#">Sonarr instances</a><a class="arr-link arr-link-bazarr" href="#">Bazarr subtitles</a></div><div class="arr-dropdown-menu" role="menu"><a class="arr-dropdown-item" role="menuitem" href="#"><span class="arr-dropdown-dot arr-dropdown-dot--complete">✓</span><span class="arr-dropdown-item-name">Main Sonarr</span><span class="arr-dropdown-status-text">✓ Complete</span><span class="arr-dropdown-item-stats">24 / 24</span></a><a class="arr-dropdown-item" role="menuitem" href="#"><span class="arr-dropdown-dot arr-dropdown-dot--partial">◐</span><span class="arr-dropdown-item-name">4K Sonarr</span><span class="arr-dropdown-status-text">◐ Partial</span><span class="arr-dropdown-item-stats">8 / 24</span></a></div></section>
              <section class="jc-arr-modal-overlay"><div class="jc-arr-modal" role="dialog" aria-label="Interactive release search"><div class="jc-arr-modal-header"><div class="jc-arr-modal-titles"><h2 class="jc-arr-modal-title">Interactive search</h2><div class="jc-arr-modal-subtitle">Main Radarr · high quality releases</div></div><button class="jc-arr-modal-close" aria-label="Close">×</button></div><div class="jc-arr-modal-body"><div class="jc-arr-toolbar"><select class="jc-arr-select" aria-label="Instance"><option>Main Radarr</option></select><input class="jc-arr-filter" aria-label="Filter" value=""><label class="jc-arr-switch"><input type="checkbox" checked><span class="jc-arr-switch-track"></span><span class="jc-arr-switch-label">Monitored only</span></label><button class="jc-arr-btn-base">Search</button></div><div class="jc-arr-release-list"><article class="jc-arr-release"><div class="jc-arr-release-main"><strong class="jc-arr-release-title">Accepted release</strong><div class="jc-arr-release-meta"><span class="jc-arr-badge jc-arr-badge-ok">✓ Accepted</span><span class="jc-arr-dim">12.4 GB</span></div></div><button class="jc-arr-grab" aria-label="Grab">↓</button></article><article class="jc-arr-release jc-arr-rejected" aria-label="Rejected release"><div class="jc-arr-release-main"><strong class="jc-arr-release-title">Rejected release with an extremely long localized title</strong><div class="jc-arr-release-rejections" role="note"><span aria-hidden="true">⚠</span>Rejected: quality profile mismatch · custom format score below the configured minimum threshold</div></div><button class="jc-arr-grab" aria-label="Grab">↓</button></article><div class="jc-arr-progress-row"><div class="jc-arr-progress-title">Downloading accepted release</div><div class="jc-arr-progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="41"><div class="jc-arr-progress-fill" style="width:41%"></div></div><div class="jc-arr-progress-meta"><span>41%</span><span>ETA 18 min</span></div></div></div></div><div class="jc-arr-modal-footer"><button class="jc-arr-btn-base">Cancel</button><button class="jc-arr-btn-base jc-arr-btn-primary">View downloads</button></div></div></section>
              <details class="detailSection tmdb-reviews-section" open><summary class="sectionTitle">Reviews <i class="material-icons expand-icon">expand_more</i></summary><article class="tmdb-review-card"><div class="tmdb-review-header"><div><strong class="tmdb-review-author">Community reviewer</strong><div class="tmdb-review-date">21 July 2026</div></div><span class="tmdb-review-rating">★ 8.5</span></div><p class="tmdb-review-text">A long review remains readable when localized text expands and the viewport becomes narrow. <button class="tmdb-review-toggle">Read more</button></p></article><form class="jc-review-form"><h3 class="jc-review-form-title">Write a review</h3><div class="jc-review-star-picker" role="radiogroup" aria-label="Rating"><button class="jc-star-btn jc-star-selected" role="radio" aria-checked="false" aria-label="1 of 5 stars">★</button><button class="jc-star-btn jc-star-selected" role="radio" aria-checked="false" aria-label="2 of 5 stars">★</button><button class="jc-star-btn jc-star-selected" role="radio" aria-checked="true" aria-label="3 of 5 stars">★</button><button class="jc-star-btn" role="radio" aria-checked="false" aria-label="4 of 5 stars">★</button><button class="jc-star-btn" role="radio" aria-checked="false" aria-label="5 of 5 stars">★</button><button class="jc-star-clear-btn" aria-label="Clear rating">×</button></div><textarea class="jc-review-textarea" aria-label="Review">Respectful spoiler-free thoughts.</textarea><div class="jc-review-form-btns"><button class="jc-review-btn jc-review-cancel-btn">Cancel</button><button class="jc-review-btn jc-review-submit-btn">Save review</button></div><div class="jc-review-form-error" role="alert">A localized validation error can wrap without clipping.</div></form></details>
              <span class="policy-private" data-source-token="private-provider-token">Private integration policy</span>
            </div>
          </main>
          <div class="streaming-settings-modal" aria-hidden="true" style="display:none"><div class="streaming-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="fixture-streaming-settings-title" tabindex="-1"><h2 id="fixture-streaming-settings-title">Availability settings</h2><label>Country <select class="streaming-provider-select"><option>Australia</option></select></label><div class="jc-review-form-btns"><button class="streaming-settings-cancel" type="button">Cancel</button><button class="streaming-settings-save" type="button">Save</button></div></div></div>`;
        const producerHeader = window.JellyfinCanopy.discoveryFilter?.createSectionHeader(
            'Seerr discovery filters',
            'theme-studio-e2e',
            true,
            () => undefined,
            () => undefined,
        );
        const producerMount = fixture.querySelector<HTMLElement>('[data-producer="seerr-discovery-header"]');
        if (!producerHeader || !producerMount) throw new Error('Seerr discovery header producer is unavailable');
        producerMount.replaceWith(producerHeader);
        const settingsButton = fixture.querySelector<HTMLButtonElement>('.streaming-settings-button')!;
        const settingsModal = fixture.querySelector<HTMLElement>('.streaming-settings-modal')!;
        const settingsDialog = fixture.querySelector<HTMLElement>('.streaming-settings-dialog')!;
        const closeSettings = (): void => {
            settingsModal.style.display = 'none';
            settingsModal.setAttribute('aria-hidden', 'true');
            settingsButton.focus();
        };
        settingsButton.addEventListener('click', () => {
            settingsModal.style.display = 'flex';
            settingsModal.removeAttribute('aria-hidden');
            settingsDialog.querySelector<HTMLElement>('.streaming-provider-select')?.focus();
        });
        settingsModal.querySelector('.streaming-settings-cancel')?.addEventListener('click', closeSettings);
        settingsModal.addEventListener('click', (event) => {
            if (event.target === settingsModal) closeSettings();
        });
        settingsModal.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                closeSettings();
                return;
            }
            if (event.key !== 'Tab') return;
            const focusable = [...settingsDialog.querySelectorAll<HTMLElement>('button,select')];
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
            }
        });
        document.head.appendChild(style);
        document.body.appendChild(fixture);
    });
}

interface ProducerDialogEvidence {
    rootPosition: string;
    rootWidth: number;
    rootHeight: number;
    contentWidth: number;
    contentHeight: number;
    rootBorderRadius: string;
    contentBorderRadius: string;
}

/** Exercise the exact producer-owned overlay/content hooks without staging overrides. */
async function seerrDialogGeometryEvidence(page: Page): Promise<ProducerDialogEvidence> {
    return page.evaluate(async () => {
        const root = document.createElement('div');
        root.className = 'seerr-season-modal show';
        root.innerHTML = '<div class="seerr-season-content" role="dialog" aria-modal="true"><div class="seerr-season-header"><div class="seerr-season-title">Request state evidence</div></div><div class="seerr-modal-body"><div class="seerr-season-list"><div class="seerr-season-item">Season 1</div></div></div></div>';
        document.body.appendChild(root);
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        const content = root.querySelector<HTMLElement>('.seerr-season-content');
        if (!content) throw new Error('Seerr dialog content surface is unavailable');
        const rootBox = root.getBoundingClientRect();
        const contentBox = content.getBoundingClientRect();
        const evidence = {
            rootPosition: getComputedStyle(root).position,
            rootWidth: rootBox.width,
            rootHeight: rootBox.height,
            contentWidth: contentBox.width,
            contentHeight: contentBox.height,
            rootBorderRadius: getComputedStyle(root).borderRadius,
            contentBorderRadius: getComputedStyle(content).borderRadius,
        };
        root.remove();
        return evidence;
    });
}

interface Evidence {
    documentOverflow: number;
    fixtureOverflow: number;
    undersized: string[];
    clipped: string[];
    progress: string[];
    statuses: string[];
    semanticStates: { busy: number; empty: number; alerts: number };
    bazarrLinks: number;
    checkedSwitches: number;
    disabledPermissionActions: number;
    privateDisplay: string;
    stylesheets: number;
}

async function integrationEvidence(page: Page): Promise<Evidence> {
    return page.evaluate((ids) => {
        const fixture = document.getElementById('jc-theme-integration-fixture')!;
        const visible = (element: Element): element is HTMLElement => {
            const node = element as HTMLElement;
            const style = getComputedStyle(node);
            const box = node.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
        };
        const controls = [...fixture.querySelectorAll('button, input, select, textarea, a')].filter(visible);
        const enforceTouchTargets = document.documentElement.getAttribute('data-jc-theme-breakpoint') === 'phone';
        return {
            documentOverflow: document.scrollingElement!.scrollWidth - innerWidth,
            fixtureOverflow: fixture.scrollWidth - fixture.clientWidth,
            undersized: controls.filter((control) => enforceTouchTargets && (() => {
                const touchTarget = control.closest('.jc-arr-switch') ?? control;
                const box = touchTarget.getBoundingClientRect();
                return box.width < 43.5 || box.height < 43.5;
            })()).map((control) => `${control.tagName}.${control.className}`),
            clipped: controls.filter((control) => {
                const box = control.getBoundingClientRect();
                if (box.bottom < 0 || box.top > innerHeight) return false;
                return box.left < -.5 || box.right > innerWidth + .5;
            }).map((control) => `${control.tagName}.${control.className}`),
            progress: [...fixture.querySelectorAll('[role="progressbar"]')]
                .map((element) => element.getAttribute('aria-valuenow') ?? ''),
            statuses: [...fixture.querySelectorAll('.seerr-status-badge,.seerr-request-state,.jc-status-chip,.arr-dropdown-status-text,.jc-arr-badge,.jc-arr-release-rejections')]
                .map((element) => element.textContent?.trim() ?? ''),
            semanticStates: {
                busy: fixture.querySelectorAll('.streaming-loading[aria-busy="true"]').length,
                empty: fixture.querySelectorAll('.streaming-empty[role="status"]').length,
                alerts: fixture.querySelectorAll('[role="alert"]').length,
            },
            bazarrLinks: fixture.querySelectorAll('.arr-link-bazarr').length,
            checkedSwitches: fixture.querySelectorAll('.jc-arr-switch input:checked').length,
            disabledPermissionActions: fixture.querySelectorAll('.permission-action:disabled[aria-disabled="true"]').length,
            privateDisplay: getComputedStyle(fixture.querySelector('.policy-private')!).display,
            stylesheets: ids.filter((id) => document.getElementById(id) instanceof HTMLLinkElement).length,
        };
    }, STYLE_IDS);
}

test.describe.serial('Theme Studio discovery and integration surfaces', () => {
    let admin: Session;
    let original: Record<string, unknown>;

    test.beforeAll(async ({ baseURL }) => {
        admin = await authenticate(baseURL!, USERS.admin.username, USERS.admin.password);
        original = (await api<Record<string, unknown>>(baseURL!, CONFIG_PATH, admin.token))!;
    });

    test.beforeEach(async ({ baseURL }) => {
        await api(baseURL!, CONFIG_PATH, admin.token, {
            method: 'POST',
            body: JSON.stringify({
                ...original,
                ThemeStudioEnabled: true,
                ThemeStudioDashboardEnabled: false,
                ThemeStudioAllowDynamicColor: false,
                ThemeSelectorEnabled: false,
                LayoutEnforcement: 'None',
                SeerrEnabled: true,
                SeerrUrls: 'http://127.0.0.1:9',
                SeerrApiKey: 'theme-studio-e2e',
                DiscoveryEnabled: true,
                DiscoveryLibraryTab: true,
                ArrLinksEnabled: true,
                ArrSearchEnabled: true,
                SonarrInstances: JSON.stringify([{ Name: 'Theme test', Url: 'http://127.0.0.1:9', ApiKey: 'theme-studio-e2e', Enabled: true }]),
                RadarrInstances: '[]',
                BazarrUrl: 'http://127.0.0.1:9',
                ElsewhereEnabled: true,
                ShowReviews: true,
                ShowUserReviews: true,
                LetterboxdEnabled: true,
                ShowReleaseDates: true,
                TMDB_API_KEY: 'theme-studio-e2e',
            }),
        });
    });

    test.afterEach(async ({ baseURL }) => {
        if (!admin || !original) return;
        await api(baseURL!, CONFIG_PATH, admin.token, { method: 'POST', body: JSON.stringify(original) });
    });

    test.afterAll(async ({ baseURL }) => {
        if (!admin || !original) return;
        await api(baseURL!, CONFIG_PATH, admin.token, { method: 'POST', body: JSON.stringify(original) });
    });

    test('desktop, wide and phone integrations fit, stay semantic, and preserve policy', async ({ page, consoleErrors }) => {
        await page.setViewportSize({ width: 1366, height: 768 });
        await seedModernLayout(page);
        await loginAs(page, 'admin', consoleErrors);
        await page.goto('/web/#/movies');
        await page.waitForFunction(() => window.JellyfinCanopy?.initialized === true);
        await waitForIntegrationTheme(page, 'desktop');
        await previewIntegrationTheme(page);

        for (const dialogViewport of [
            { width: 1366, height: 768, breakpoint: 'desktop' as const },
            { width: 390, height: 844, breakpoint: 'phone' as const },
        ]) {
            await page.setViewportSize(dialogViewport);
            await waitForIntegrationTheme(page, dialogViewport.breakpoint);
            const dialog = await seerrDialogGeometryEvidence(page);
            expect(dialog.rootPosition).toBe('fixed');
            expect(dialog.rootWidth).toBeGreaterThanOrEqual(dialogViewport.width - 1);
            expect(dialog.rootHeight).toBeGreaterThanOrEqual(dialogViewport.height - 1);
            expect(dialog.contentWidth).toBeLessThanOrEqual(dialog.rootWidth);
            expect(dialog.contentHeight).toBeLessThanOrEqual(dialog.rootHeight);
            expect(dialog.rootBorderRadius).toBe('0px');
            expect(dialog.contentBorderRadius).not.toBe('0px');
        }
        await page.setViewportSize({ width: 1366, height: 768 });
        await waitForIntegrationTheme(page, 'desktop');
        await mountIntegrationFixture(page);

        const settingsButton = page.locator('#jc-theme-integration-fixture .streaming-settings-button');
        const settingsModal = page.locator('#jc-theme-integration-fixture > .streaming-settings-modal');
        const settingsDialog = settingsModal.locator('.streaming-settings-dialog');
        await settingsButton.focus();
        await settingsButton.click();
        await expect(settingsModal).toBeVisible();
        await expect(settingsDialog).toHaveAttribute('role', 'dialog');
        await expect(settingsDialog).toHaveAttribute('aria-modal', 'true');
        await expect(settingsDialog.locator('.streaming-provider-select')).toBeFocused();
        await settingsDialog.locator('.streaming-settings-save').focus();
        await page.keyboard.press('Tab');
        await expect(settingsDialog.locator('.streaming-provider-select')).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(settingsModal).toBeHidden();
        await expect(settingsModal).toHaveAttribute('aria-hidden', 'true');
        await expect(settingsButton).toBeFocused();
        await page.evaluate(() => {
            (document.activeElement as HTMLElement | null)?.blur();
            document.getElementById('jc-theme-integration-fixture')?.scrollTo({ top: 0, left: 0 });
        });

        const viewports = [
            { name: 'desktop', width: 1366, height: 768, breakpoint: 'desktop' as const },
            { name: 'wide', width: 1920, height: 1080, breakpoint: 'wide' as const },
            { name: 'phone-portrait', width: 390, height: 844, breakpoint: 'phone' as const },
            { name: 'phone-landscape', width: 844, height: 390, breakpoint: 'phone' as const },
        ];
        for (const viewport of viewports) {
            await page.setViewportSize({ width: viewport.width, height: viewport.height });
            await waitForIntegrationTheme(page, viewport.breakpoint);
            const evidence = await integrationEvidence(page);
            expect(evidence.documentOverflow, `${viewport.name}: ${JSON.stringify(evidence)}`).toBeLessThanOrEqual(1);
            expect(evidence.fixtureOverflow, `${viewport.name}: ${JSON.stringify(evidence)}`).toBeLessThanOrEqual(1);
            expect(evidence.undersized, `${viewport.name}: ${JSON.stringify(evidence)}`).toEqual([]);
            expect(evidence.clipped, `${viewport.name}: ${JSON.stringify(evidence)}`).toEqual([]);
            expect(evidence.progress).toEqual(['62', '41']);
            expect(evidence.statuses).toEqual(expect.arrayContaining([
                '✓ Available', '◷ Pending', '◷Pending approval', '✓Request approved', '✕Declined', '!Failed',
                '↻ Processing', '✓ Complete', '◐ Partial', '✓ Accepted',
            ]));
            expect(evidence.semanticStates).toEqual({ busy: 1, empty: 1, alerts: 2 });
            expect(evidence.bazarrLinks).toBe(1);
            expect(evidence.checkedSwitches).toBe(1);
            expect(evidence.disabledPermissionActions).toBe(1);
            expect(evidence.privateDisplay).toBe('none');
            expect(evidence.stylesheets).toBe(3);
            await expect(page).toHaveScreenshot(`theme-studio-integration-surfaces-${viewport.name}.png`, {
                animations: 'disabled', caret: 'hide', maxDiffPixelRatio: .02,
            });
            if (process.env.JC_CAPTURE_THEME_DOCS === '1' && viewport.name === 'desktop') {
                await page.setViewportSize({ width: viewport.width, height: 1200 });
                await waitForIntegrationTheme(page, viewport.breakpoint);
                await page.screenshot({ path: 'docs/images/theme-studio-integration-surfaces-desktop.png', animations: 'disabled', caret: 'hide' });
                await page.setViewportSize({ width: viewport.width, height: viewport.height });
                await waitForIntegrationTheme(page, viewport.breakpoint);
            }
            if (process.env.JC_CAPTURE_THEME_DOCS === '1' && viewport.name === 'phone-portrait') {
                await page.screenshot({ path: 'docs/images/theme-studio-integration-surfaces-phone.png', animations: 'disabled', caret: 'hide' });
            }
        }

        await page.evaluate(() => {
            document.documentElement.dir = 'rtl';
            document.getElementById('jc-theme-integration-fixture')!.dir = 'rtl';
            window.JellyfinCanopy.core.themeStudio?.refresh();
        });
        const rtl = await integrationEvidence(page);
        expect(rtl.documentOverflow).toBeLessThanOrEqual(1);
        expect(rtl.fixtureOverflow).toBeLessThanOrEqual(1);
        await page.locator('.jc-review-submit-btn').focus();
        expect(await page.locator('.jc-review-submit-btn').evaluate((element) => getComputedStyle(element).outlineStyle)).toBe('solid');
        expect(await page.locator('.jc-star-btn[aria-checked="true"]').count()).toBe(1);
        assertNoRuntimeErrors(consoleErrors);
    });

    test('disabled and unconfigured Seerr and ARR closures remain absent', async ({ page, baseURL, consoleErrors }) => {
        await api(baseURL!, CONFIG_PATH, admin.token, {
            method: 'POST',
            body: JSON.stringify({
                ...original,
                ThemeStudioEnabled: true,
                ThemeStudioDashboardEnabled: false,
                ThemeStudioAllowDynamicColor: false,
                SeerrEnabled: true,
                SeerrUrls: '',
                SeerrApiKey: '',
                ArrLinksEnabled: true,
                ArrSearchEnabled: true,
                SonarrInstances: '[]',
                RadarrInstances: '[]',
                SonarrUrl: '',
                SonarrApiKey: '',
                RadarrUrl: '',
                RadarrApiKey: '',
                BazarrUrl: '',
                ShowUserReviews: true,
            }),
        });
        await seedModernLayout(page);
        await loginAs(page, 'admin', consoleErrors);
        await page.waitForFunction(() => document.documentElement.getAttribute('data-jc-theme-active') === 'true');
        expect(await page.evaluate(() => ({
            seerr: document.getElementById('jc-theme-studio-seerr-surfaces') !== null,
            arr: document.getElementById('jc-theme-studio-arr-surfaces') !== null,
            external: document.getElementById('jc-theme-studio-external-surfaces') instanceof HTMLLinkElement,
            seerrConfigured: window.JellyfinCanopy.pluginConfig?.SeerrConfigured,
            sonarrConfigured: window.JellyfinCanopy.pluginConfig?.SonarrConfigured,
        }))).toEqual({ seerr: false, arr: false, external: true, seerrConfigured: false, sonarrConfigured: false });
        assertNoRuntimeErrors(consoleErrors);
    });

    test('tablet-only, legacy and TV markers retain stock integration presentation', async ({ page, consoleErrors }) => {
        await page.setViewportSize({ width: 1366, height: 768 });
        await seedModernLayout(page);
        await loginAs(page, 'admin', consoleErrors);
        await page.goto('/web/#/movies');
        await page.waitForFunction(() => window.JellyfinCanopy?.initialized === true);
        await waitForIntegrationTheme(page, 'desktop');
        await page.setViewportSize({ width: 820, height: 1180 });
        await expect.poll(() => page.evaluate(() => document.querySelectorAll('#jc-theme-studio-committed,#jc-theme-studio-preview').length)).toBe(0);
        await mountIntegrationFixture(page);

        const stockEvidence = async () => page.evaluate(() => {
            const fixture = document.getElementById('jc-theme-integration-fixture')!;
            const card = fixture.querySelector<HTMLElement>('.seerr-card')!;
            const privateNode = fixture.querySelector<HTMLElement>('.policy-private')!;
            const fixtureBox = fixture.getBoundingClientRect();
            return {
                cardBackground: getComputedStyle(card).backgroundColor,
                privateDisplay: getComputedStyle(privateNode).display,
                overflow: fixture.scrollWidth - fixture.clientWidth,
                overflowing: [...fixture.querySelectorAll<HTMLElement>('*')]
                    .filter((element) => {
                        const box = element.getBoundingClientRect();
                        return box.left < fixtureBox.left - .5 || box.right > fixtureBox.right + .5;
                    })
                    .map((element) => `${element.tagName}.${element.className}`)
                    .slice(0, 12),
            };
        });
        const tablet = await stockEvidence();
        expect(tablet.cardBackground).toBe('rgba(0, 0, 0, 0)');
        expect(tablet.privateDisplay).toBe('none');
        expect(tablet.overflowing, JSON.stringify(tablet)).toEqual([]);

        for (const mode of ['legacy', 'tv'] as const) {
            await page.evaluate((next) => {
                const root = document.documentElement;
                root.classList.remove('jc-modern-layout', 'jc-legacy-layout', 'layout-tv');
                root.removeAttribute('data-layout');
                if (next === 'legacy') root.classList.add('jc-legacy-layout');
                else {
                    root.classList.add('jc-modern-layout', 'layout-tv');
                    root.setAttribute('data-layout', 'tv');
                }
                window.dispatchEvent(new Event('resize'));
            }, mode);
            await expect.poll(() => page.evaluate(() => document.querySelectorAll('#jc-theme-studio-committed,#jc-theme-studio-preview').length)).toBe(0);
            const stock = await stockEvidence();
            expect(stock.cardBackground).toBe('rgba(0, 0, 0, 0)');
            expect(stock.privateDisplay).toBe('none');
            expect(stock.overflowing, JSON.stringify(stock)).toEqual([]);
        }
        assertNoRuntimeErrors(consoleErrors);
    });
});
