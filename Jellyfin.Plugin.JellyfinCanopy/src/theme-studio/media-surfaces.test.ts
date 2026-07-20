import { describe, expect, it } from 'vitest';
import { serializeMediaSurfaceAdapters, THEME_MEDIA_SURFACE_MODULES } from './media-surfaces';

describe('Theme Studio modern media surface modules', () => {
    it('keeps the complete issue #390 media matrix machine-readable', () => {
        expect(THEME_MEDIA_SURFACE_MODULES.map((module) => module.id)).toEqual([
            'player-media-v12',
            'music-now-playing-v12',
            'live-guide-v12',
            'book-reader-v12',
        ]);
        expect(new Set(THEME_MEDIA_SURFACE_MODULES.map((module) => module.id)).size)
            .toBe(THEME_MEDIA_SURFACE_MODULES.length);
        for (const module of THEME_MEDIA_SURFACE_MODULES) {
            expect(module.outcome, module.id).toBeTruthy();
            expect(module.tokens.length, `${module.id}/tokens`).toBeGreaterThan(0);
            expect(module.modernRoles.length, `${module.id}/modern`).toBeGreaterThan(0);
        }
    });

    it('gates every adapter to the three supported modern browser breakpoints', () => {
        const css = serializeMediaSurfaceAdapters(':root.jc-modern-layout[data-jc-theme-active="true"]');
        expect(css).toContain('[data-jc-theme-breakpoint="phone"]');
        expect(css).toContain('[data-jc-theme-breakpoint="desktop"]');
        expect(css).toContain('[data-jc-theme-breakpoint="wide"]');
        expect(css).toContain(':not([data-jc-theme-route="dashboard"])');
        expect(css).not.toContain('[data-jc-theme-breakpoint="tablet"]');
        expect(css).not.toContain('.jc-legacy-layout');
        expect(css).not.toContain('.layout-tv');
        expect(css).not.toContain('.skinHeader');
    });

    it('binds all five player tokens to stable host and Canopy roles', () => {
        const css = serializeMediaSurfaceAdapters(':root[data-jc-theme-preview="true"]');
        for (const attribute of [
            'data-jc-theme-player-osd-density',
            'data-jc-theme-player-control-material',
            'data-jc-theme-player-pause-screen-material',
            'data-jc-theme-player-subtitle-backdrop',
            'data-jc-theme-player-trickplay-shape',
        ]) expect(css, attribute).toContain(attribute);
        for (const role of [
            '.videoOsdBottom',
            '.videoSubtitlesInner',
            '.sliderBubble',
            '.chapterThumbContainer',
            '#jc-osd-rating-container',
            '[data-jc-frame-overlay="true"]',
            '.jc-bookmark-marker[data-jc-identity-owned="true"]',
            '#pause-screen-content',
        ]) expect(css, role).toContain(role);
        const playerOptions = css.slice(0, css.indexOf('/* Adapter music-now-playing-v12'));
        expect(playerOptions).not.toMatch(/\.videoSubtitlesInner[^}]*!important/s);
        expect(playerOptions).toContain('background-color: var(--jc-color-scrim)');
        expect(playerOptions).toContain('color: var(--jc-color-on-scrim) !important');
        expect(playerOptions).toContain('.jc-chip.tmdb, .jc-chip.critic, .jc-star, .jc-text');
        expect(css).toContain('#jc-osd-rating-container :where(.jc-chip, .jc-star, .jc-text)');
        expect(css).toContain('color: var(--jc-color-text) !important');
        expect(css.match(/background-image: none/g)?.length).toBeGreaterThanOrEqual(2);
    });

    it('covers music, guide and reader states without changing host structure', () => {
        const css = serializeMediaSurfaceAdapters(':root[data-jc-theme-active="true"]');
        for (const role of [
            '.nowPlayingPage',
            '.nowPlayingPlaylist',
            '.nowPlayingPositionSlider',
            '.nowPlayingVolumeSlider',
            '.nowPlayingPage > .remoteControlContent',
            '[role="status"]',
            '.guide-channelHeaderCell',
            '.programCell-active',
            '.newTvProgram',
            '.liveTvProgram',
            '.premiereTvProgram',
            '.guideRequiresUnlock',
            '.noItemsMessage',
            '.booksPage .cardImageContainer',
            '#bookPlayerContainer',
            '#dialogToc',
            '.bookplayerButtonIcon',
            '.bookplayerErrorMsg',
            '[role="alert"]',
        ]) expect(css, role).toContain(role);
        expect(css).not.toMatch(/\.nowPlayingPage\s*\{[^}]*display:\s*grid/s);
        expect(css).toContain('min-block-size: max(2.75rem, 44px)');
        expect(css).toContain(':focus-visible');
        expect(css).toContain('@media (forced-colors: active)');
        expect(css).toContain('[data-jc-theme-transparency="reduced"]');
        expect(css).toContain('[data-jc-theme-effects-level="minimal"]');
        for (const solidRole of [
            '.videoOsdBottom', '#pause-screen-content', '.nowPlayingInfoContainer',
            '.nowPlayingPlaylist', '.bookOsdRow', '[data-jc-frame-overlay="true"]',
            '.videoSubtitlesInner', '#pause-screen-close-btn', '#jc-osd-rating-container .jc-chip',
            '.noItemsMessage', '.emptyMessage', '.errorMessage', '[role="alert"]',
        ]) expect(css, `minimal/${solidRole}`).toContain(solidRole);
        expect(css).not.toContain('url(');
        expect(css).not.toContain('@import');
        expect(css).not.toMatch(/(?:^|[;{\n])\s*order\s*:/m);
        expect(css).not.toMatch(/\.css-[a-z0-9]+/i);
    });
});
