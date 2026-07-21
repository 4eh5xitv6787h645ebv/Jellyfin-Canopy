import * as ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { JC } from '../globals';
import {
    ARR_STYLESHEET_ID,
    EXTERNAL_STYLESHEET_ID,
    installIntegrationStylesheets,
    SEERR_STYLESHEET_ID,
} from './integration-stylesheets';

interface IntegrationSurfaceContract {
    readonly id: string;
    readonly asset: string;
    readonly outcome: string;
    readonly tokens: readonly string[];
    readonly modernRoles: readonly string[];
    readonly stateRoles: readonly string[];
    readonly policyHooks: readonly string[];
}

const TEST_FILE_PATH = decodeURIComponent(new URL(import.meta.url).pathname);
const REPO_ROOT = TEST_FILE_PATH.replace(/Jellyfin\.Plugin\.JellyfinCanopy\/src\/theme-studio\/[^/]+$/, '');
const CONTRACT_PATH = `${REPO_ROOT}Jellyfin.Plugin.JellyfinCanopy/src/theme-studio/integration-surfaces.contract.json`;
const CONTRACT = JSON.parse(ts.sys.readFile(CONTRACT_PATH) ?? '[]') as readonly IntegrationSurfaceContract[];
const ELSEWHERE_SOURCE = ts.sys.readFile(`${REPO_ROOT}Jellyfin.Plugin.JellyfinCanopy/src/elsewhere/elsewhere.ts`) ?? '';
const REVIEWS_SOURCE = ts.sys.readFile(`${REPO_ROOT}Jellyfin.Plugin.JellyfinCanopy/src/elsewhere/reviews.ts`) ?? '';
const SEERR_PRODUCER_SOURCE = [
    'src/discovery/customize.ts',
    'src/discovery/feed.ts',
    'src/seerr/discovery/filter-utils.ts',
    'src/seerr/modal.ts',
    'src/seerr/more-info-modal/actions.ts',
    'src/seerr/more-info-modal/render.ts',
    'src/seerr/seerr-status.ts',
    'src/seerr/ui/season-modal.ts',
].map((path) => ts.sys.readFile(`${REPO_ROOT}Jellyfin.Plugin.JellyfinCanopy/${path}`) ?? '').join('\n');
const cssFor = (name: 'seerr' | 'arr' | 'external'): string => ts.sys.readFile(
    `${REPO_ROOT}Jellyfin.Plugin.JellyfinCanopy/Assets/theme-studio-${name}-surfaces.css`,
) ?? '';

const IDS = [SEERR_STYLESHEET_ID, ARR_STYLESHEET_ID, EXTERNAL_STYLESHEET_ID] as const;

afterEach(() => {
    for (const id of IDS) document.getElementById(id)?.remove();
    JC.pluginConfig = {};
    JC.currentSettings = {};
    JC.currentUser = undefined;
});

describe('Theme Studio integration surface contract', () => {
    it('keeps the complete issue #395 matrix machine-readable and locally mapped', () => {
        expect(CONTRACT.map(({ id }) => id)).toEqual([
            'seerr-discovery-v1',
            'seerr-details-requests-v1',
            'arr-links-release-search-v1',
            'reviews-v1',
            'availability-external-links-v1',
        ]);
        for (const module of CONTRACT) {
            expect(module.outcome, module.id).toBeTruthy();
            expect(module.tokens.length, `${module.id}/tokens`).toBeGreaterThan(0);
            expect(module.modernRoles.length, `${module.id}/roles`).toBeGreaterThan(0);
            expect(module.stateRoles.length, `${module.id}/states`).toBeGreaterThan(0);
            expect(module.asset).toMatch(/^theme-studio\/(?:seerr|arr|external)-surfaces\.css$/);
        }
    });

    it('keeps every adapter scoped to modern phone, desktop and wide browser layouts', () => {
        for (const name of ['seerr', 'arr', 'external'] as const) {
            const css = cssFor(name);
            expect(css.length, name).toBeGreaterThan(5_000);
            expect(css, name).toContain(':root.jc-modern-layout');
            expect(css, name).toContain('[data-jc-theme-active="true"]');
            expect(css, name).toContain('[data-jc-theme-preview="true"]');
            expect(css, name).toContain('[data-jc-theme-breakpoint="phone"]');
            expect(css, name).toContain('[data-jc-theme-breakpoint="desktop"]');
            expect(css, name).toContain('[data-jc-theme-breakpoint="wide"]');
            expect(css, name).toContain(':not([data-jc-theme-route="dashboard"])');
            expect(css, name).not.toContain('[data-jc-theme-breakpoint="tablet"]');
            expect(css, name).not.toContain('.jc-legacy-layout');
            expect(css, name).not.toContain('.layout-tv');
        }
    });

    it('covers touch, focus, long text, RTL, low effects, contrast and phone landscape', () => {
        for (const name of ['seerr', 'arr', 'external'] as const) {
            const css = cssFor(name);
            expect(css, name).toContain('min-inline-size: max(2.75rem, 44px)');
            expect(css, name).toContain(':focus-visible');
            expect(css, name).toContain('overflow-wrap: anywhere');
            expect(css, name).toContain('overscroll-behavior');
            expect(css, name).toContain('[data-jc-theme-transparency="reduced"]');
            expect(css, name).toContain('[data-jc-theme-motion="reduced"]');
            expect(css, name).toContain('@media (orientation: landscape) and (max-height: 599px)');
            expect(css, name).toContain('@media (forced-colors: active)');
            expect(css, name).not.toContain('url(');
            expect(css, name).not.toContain('@import');
            expect(css, name).not.toMatch(/display:\s*none/);
            expect(css, name).not.toMatch(/visibility:\s*hidden/);
            expect(css, name).not.toMatch(/(?:^|[;{\n])\s*order\s*:/m);
            expect(css, name).not.toMatch(/(?:^|[;{\n])\s*content\s*:/m);
        }
        expect(cssFor('seerr')).toContain('border-style: dashed');
        expect(cssFor('arr')).toContain('border-inline-start-width:');
        expect(cssFor('external')).toContain('.jc-star-btn[aria-checked="true"]');
    });

    it('keeps credentials, URLs, permissions and provider policy out of presentation', () => {
        for (const module of CONTRACT) {
            const css = cssFor(module.asset.includes('/arr-') ? 'arr' : module.asset.includes('/seerr-') ? 'seerr' : 'external');
            for (const hook of module.policyHooks) expect(css, `${module.id}/${hook}`).not.toContain(hook);
        }
        for (const name of ['seerr', 'arr', 'external'] as const) {
            const css = cssFor(name);
            expect(css).not.toContain('http:');
            expect(css).not.toContain('https:');
            expect(css).not.toContain('ApiKey');
            expect(css).not.toContain('setInterval');
            expect(css).not.toContain('MutationObserver');
        }
    });

    it('binds external presentation to semantic hooks emitted by the production features', () => {
        for (const hook of [
            'streaming-result',
            'streaming-result-header',
            'streaming-provider-chip',
            'streaming-provider-logo',
            'streaming-provider-name',
            'streaming-search-button',
            'streaming-settings-dialog',
            'streaming-provider-select',
            'streaming-loading',
            'streaming-empty',
            'streaming-error',
            'streaming-result-close',
        ]) {
            expect(ELSEWHERE_SOURCE, hook).toContain(hook);
            expect(cssFor('external'), hook).toContain(`.${hook}`);
        }
        for (const hook of [
            'tmdb-review-card',
            'tmdb-review-toggle',
            'jc-review-form',
            'jc-review-star-picker',
            'jc-review-form-error',
        ]) {
            expect(REVIEWS_SOURCE, hook).toContain(hook);
            expect(cssFor('external'), hook).toContain(`.${hook}`);
        }
        expect(REVIEWS_SOURCE).toContain('role="radiogroup"');
        expect(REVIEWS_SOURCE).toContain('role="radio"');
        expect(REVIEWS_SOURCE).toContain('aria-checked');
        expect(REVIEWS_SOURCE).toContain("event.key === 'ArrowRight' || event.key === 'ArrowDown'");
        expect(REVIEWS_SOURCE).toContain("summary.className = 'sectionTitle'");
        expect(cssFor('external')).toContain('.tmdb-reviews-section > summary.sectionTitle');
        expect(cssFor('external')).not.toContain('.tmdb-reviews-title');
        expect(ELSEWHERE_SOURCE).toContain('installModalA11y(modal');
        expect(ELSEWHERE_SOURCE).toContain('dialogElement: dialog');
        expect(ELSEWHERE_SOURCE).toContain('onEscape: () => closeSettingsModal(modal)');
    });

    it('binds Seerr presentation to real discovery, dialog and request-state producers', () => {
        for (const hook of [
            'jc-discovery-feed',
            'jc-discovery-row',
            'seerr-discovery-header',
            'seerr-discovery-filter',
            'seerr-filter-btn',
            'seerr-discovery-sort',
            'seerr-sort-select',
            'jc-discovery-customize-dialog',
            'modal-container',
            'seerr-season-content',
            'seerr-request-state',
        ]) {
            expect(SEERR_PRODUCER_SOURCE, hook).toContain(hook);
            expect(cssFor('seerr'), hook).toContain(`.${hook}`);
        }
        for (const state of ['pending', 'approved', 'declined', 'failed']) {
            expect(SEERR_PRODUCER_SOURCE, state).toContain(`cssClass: '${state}'`);
            expect(cssFor('seerr'), state).toContain(`.seerr-request-state-${state}`);
        }
        expect(cssFor('seerr')).toContain('.jc-more-info-modal .modal-container');
        expect(cssFor('seerr')).toContain('.seerr-season-modal .seerr-season-content');
        expect(cssFor('seerr')).not.toMatch(/:where\([^)]*(?:\.jc-more-info-modal|\.seerr-season-modal)(?:,|\))/);
        expect(cssFor('seerr')).not.toContain('.seerr-discovery-filters');
        expect(cssFor('seerr')).not.toContain('.jc-discovery-row-title');
        expect(SEERR_PRODUCER_SOURCE).toContain("button.className = 'seerr-request-button seerr-button-request'");
        expect(cssFor('seerr')).toContain('.seerr-button-request');
        expect(cssFor('seerr')).toMatch(/\.seerr-more-info-link \{\s+display: inline-flex !important;/);
        expect(cssFor('seerr')).not.toContain('.jc-more-info-actions-primary');
    });

    it('uses the real Seerr modal factory to emit the themed overlay/content split', async () => {
        JC.identity.transition('', '', 'theme-integration-producer-reset');
        JC.identity.transition('theme-server', 'theme-user', 'theme-integration-producer');
        const { installSeerrModal } = await import('../seerr/modal');
        const originalTranslate = JC.t;
        JC.t = (key: string) => key;
        const dispose = installSeerrModal();
        try {
            const handle = JC.seerrModal!.create({
                title: 'Producer contract',
                subtitle: 'Theme integration',
                bodyHtml: '<div class="seerr-season-list"></div>',
                onSave: () => undefined,
            });
            handle.show();
            expect(handle.modalElement.classList).toContain('seerr-season-modal');
            expect(handle.modalElement.hasAttribute('role')).toBe(false);
            const content = handle.modalElement.querySelector<HTMLElement>('.seerr-season-content');
            expect(content).toBeInstanceOf(HTMLElement);
            expect(content?.getAttribute('role')).toBe('dialog');
            expect(content?.getAttribute('aria-modal')).toBe('true');
            expect(handle.modalElement.querySelector('.seerr-modal-body .seerr-season-list')).toBeInstanceOf(HTMLElement);
        } finally {
            JC.seerrModal?.closeAll();
            dispose();
            JC.t = originalTranslate;
            JC.identity.transition('', '', 'theme-integration-producer-cleanup');
        }
    });

    it('loads only configured closures and transfers exact ownership to a successor', () => {
        JC.pluginConfig = {
            SeerrEnabled: true,
            SeerrConfigured: false,
            ArrLinksEnabled: true,
            SonarrConfigured: false,
            ElsewhereEnabled: true,
            TmdbEnabled: true,
        };
        JC.currentUser = { Policy: { IsAdministrator: true } };
        const first = {};
        const disposeFirst = installIntegrationStylesheets(first);
        expect(document.getElementById(SEERR_STYLESHEET_ID)).toBeNull();
        expect(document.getElementById(ARR_STYLESHEET_ID)).toBeNull();
        expect(document.getElementById(EXTERNAL_STYLESHEET_ID)).toBeInstanceOf(HTMLLinkElement);

        JC.pluginConfig.SeerrConfigured = true;
        JC.pluginConfig.SonarrConfigured = true;
        const second = {};
        const existingExternal = document.getElementById(EXTERNAL_STYLESHEET_ID);
        const disposeSecond = installIntegrationStylesheets(second);
        expect(document.getElementById(SEERR_STYLESHEET_ID)).toBeInstanceOf(HTMLLinkElement);
        expect(document.getElementById(ARR_STYLESHEET_ID)).toBeInstanceOf(HTMLLinkElement);
        expect(document.getElementById(EXTERNAL_STYLESHEET_ID)).toBe(existingExternal);
        expect(document.querySelectorAll(IDS.map((id) => `#${id}`).join(','))).toHaveLength(3);

        disposeFirst();
        expect(document.querySelectorAll(IDS.map((id) => `#${id}`).join(','))).toHaveLength(3);
        disposeSecond();
        expect(document.querySelectorAll(IDS.map((id) => `#${id}`).join(','))).toHaveLength(0);
    });

    it('never grants ARR styling from configured services without admin identity', () => {
        JC.pluginConfig = { ArrSearchEnabled: true, SonarrConfigured: true };
        JC.currentSettings = { isAdmin: true };
        const dispose = installIntegrationStylesheets({});
        expect(document.getElementById(ARR_STYLESHEET_ID)).toBeNull();
        dispose();
    });

    it('keeps impossible ARR service and feature cross-products cold', () => {
        JC.currentUser = { Policy: { IsAdministrator: true } };
        JC.pluginConfig = {
            BazarrConfigured: true,
            ArrLinksEnabled: false,
            ArrTagsShowAsLinks: false,
            ArrSearchEnabled: true,
        };
        const disposeBazarrOnly = installIntegrationStylesheets({});
        expect(document.getElementById(ARR_STYLESHEET_ID)).toBeNull();
        disposeBazarrOnly();

        JC.pluginConfig = {
            BazarrConfigured: true,
            ArrLinksEnabled: true,
            ArrSearchEnabled: false,
        };
        const disposeBazarrLink = installIntegrationStylesheets({});
        expect(document.getElementById(ARR_STYLESHEET_ID)).toBeInstanceOf(HTMLLinkElement);
        disposeBazarrLink();

        JC.pluginConfig = {
            SonarrConfigured: true,
            ArrLinksEnabled: false,
            ArrTagsShowAsLinks: false,
            ArrSearchEnabled: true,
        };
        const disposeSonarrSearch = installIntegrationStylesheets({});
        expect(document.getElementById(ARR_STYLESHEET_ID)).toBeInstanceOf(HTMLLinkElement);
        disposeSonarrSearch();
    });
});
