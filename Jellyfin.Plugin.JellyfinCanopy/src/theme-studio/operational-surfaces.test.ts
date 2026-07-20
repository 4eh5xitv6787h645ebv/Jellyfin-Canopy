import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

interface OperationalSurfaceContract {
    readonly id: string;
    readonly outcome: string;
    readonly tokens: readonly string[];
    readonly modernRoles: readonly string[];
    readonly stateRoles: readonly string[];
    readonly policyHooks: readonly string[];
}

const TEST_FILE_PATH = decodeURIComponent(new URL(import.meta.url).pathname);
const REPO_ROOT = TEST_FILE_PATH.replace(
    /Jellyfin\.Plugin\.JellyfinCanopy\/src\/theme-studio\/[^/]+$/,
    '',
);
const CSS_PATH = `${REPO_ROOT}Jellyfin.Plugin.JellyfinCanopy/Assets/theme-studio-operational-surfaces.css`;
const CSS = ts.sys.readFile(CSS_PATH) ?? '';
const CONTRACT_PATH = `${REPO_ROOT}Jellyfin.Plugin.JellyfinCanopy/src/theme-studio/operational-surfaces.contract.json`;
const CONTRACT_TEXT = ts.sys.readFile(CONTRACT_PATH) ?? '[]';
const THEME_OPERATIONAL_SURFACE_MODULES = JSON.parse(CONTRACT_TEXT) as readonly OperationalSurfaceContract[];

describe('Theme Studio operational surface contract', () => {
    it('keeps the complete issue #394 component matrix machine-readable', () => {
        expect(THEME_OPERATIONAL_SURFACE_MODULES.map((module) => module.id)).toEqual([
            'active-streams-operations-v1',
            'calendar-operations-v1',
            'request-download-operations-v1',
            'bookmark-operations-v1',
        ]);
        expect(new Set(THEME_OPERATIONAL_SURFACE_MODULES.map((module) => module.id)).size)
            .toBe(THEME_OPERATIONAL_SURFACE_MODULES.length);

        for (const module of THEME_OPERATIONAL_SURFACE_MODULES) {
            expect(module.outcome, module.id).toBeTruthy();
            expect(module.tokens.length, `${module.id}/tokens`).toBeGreaterThan(0);
            expect(module.modernRoles.length, `${module.id}/roles`).toBeGreaterThan(0);
            expect(module.stateRoles.length, `${module.id}/states`).toBeGreaterThan(0);
            const hooks = [...module.modernRoles, ...module.stateRoles, ...module.policyHooks];
            expect(new Set(hooks).size, `${module.id}/duplicate hook`).toBe(hooks.length);
        }
    });

    it('gates every adapter to modern phone, desktop and wide browser layouts', () => {
        expect(CSS.length, CSS_PATH).toBeGreaterThan(1_000);
        expect(CSS.trimStart()).toMatch(/^\/\* Adapter active-streams-operations-v1:/);
        expect(CSS).toContain(':root.jc-modern-layout');
        expect(CSS).toContain('[data-jc-theme-active="true"]');
        expect(CSS).toContain('[data-jc-theme-preview="true"]');
        expect(CSS).toContain('[data-jc-theme-breakpoint="phone"]');
        expect(CSS).toContain('[data-jc-theme-breakpoint="desktop"]');
        expect(CSS).toContain('[data-jc-theme-breakpoint="wide"]');
        expect(CSS).toContain(':not([data-jc-theme-route="dashboard"])');
        expect(CSS).not.toContain('[data-jc-theme-breakpoint="tablet"]');
        expect(CSS).not.toContain('.jc-legacy-layout');
        expect(CSS).not.toContain('.layout-tv');
        expect(CSS).not.toContain('.skinHeader');
    });

    it('covers all operational components and semantic states', () => {
        for (const marker of [
            'Adapter active-streams-operations-v1',
            '#jc-active-streams-panel',
            '.jc-as-state-playing',
            '.jc-as-badge-transcode',
            '.jc-as-broadcast-form',
            '.jc-as-action-btn-stop.jc-as-confirming',
            'Adapter calendar-operations-v1',
            '.jc-calendar-layout',
            '.jc-calendar-month-grid',
            '.jc-calendar-agenda-event',
            '.jc-calendar-card-time.is-late',
            '.jc-calendar-page .jc-error-state',
            'Adapter request-download-operations-v1',
            '.jc-downloads-search-input',
            '.jc-download-progress-bar',
            '.jc-request-card',
            '.jc-request-approve-btn',
            '.jc-issue-card',
            'Adapter bookmark-operations-v1',
            '.jc-bookmark-row',
            '.jc-btn-edit-row',
            '.jc-bookmark-item-orphaned',
            '.jc-bm-player-modal-container',
            '.jc-bm-library-modal-container',
            '.replacement-option.selected',
        ]) expect(CSS, marker).toContain(marker);
    });

    it('keeps authorization, identity and live-update policy hooks presentation-free', () => {
        for (const module of THEME_OPERATIONAL_SURFACE_MODULES) {
            for (const hook of module.policyHooks) expect(CSS, `${module.id}/${hook}`).not.toContain(hook);
        }
        expect(CSS).not.toContain('data-live-sig');
        expect(CSS).not.toContain('setInterval');
        expect(CSS).not.toContain('setTimeout');
        expect(CSS).not.toContain('MutationObserver');
        expect(CSS).not.toMatch(/display:\s*none/);
        expect(CSS).not.toMatch(/visibility:\s*hidden/);
        expect(CSS).not.toMatch(/(?:^|[;{\n])\s*order\s*:/m);
    });

    it('covers touch, focus, low-effects, contrast, RTL-safe geometry and phone reflow', () => {
        expect(CSS).toContain('min-inline-size: max(2.75rem, 44px)');
        expect(CSS).toContain(':focus-visible');
        expect(CSS).toContain('overflow-wrap: anywhere');
        expect(CSS).toContain('inset-inline-end:');
        expect(CSS).toContain('border-inline-start-width:');
        expect(CSS).toContain('overscroll-behavior-inline: contain');
        expect(CSS).toContain('[data-jc-theme-transparency="reduced"]');
        expect(CSS).toContain('[data-jc-theme-effects-level="minimal"]');
        expect(CSS).toContain('[data-jc-theme-motion="reduced"]');
        expect(CSS).toContain('@media (orientation: landscape) and (max-height: 599px)');
        expect(CSS).toContain('@media (forced-colors: active)');
        expect(CSS).not.toContain('url(');
        expect(CSS).not.toContain('@import');
        expect(CSS).not.toMatch(/(?:^|[;{\n])\s*content\s*:/m);
    });
});
