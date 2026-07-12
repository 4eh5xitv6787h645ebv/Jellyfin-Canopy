// Unit test for the OSD RT tomato icons (ENH-7 / R6).
//
// The critic chip used `url(assets/img/fresh.svg)` / `rotten.svg`, which
// resolve relative to /web/ and do not exist anywhere in the tree (404, no
// icon). They must now be inlined, plugin-owned, zero-network data-URI SVGs.
import { afterEach, describe, expect, it } from 'vitest';
import { ensureStyles } from './osd-rating';

describe('osd-rating tomato icons', () => {
    afterEach(() => { document.getElementById('jc-osd-rating-style')?.remove(); });

    it('injects data-URI tomato glyphs, never a relative assets/img url', () => {
        ensureStyles();
        const style = document.getElementById('jc-osd-rating-style');
        expect(style).not.toBeNull();
        const css = style!.textContent || '';

        expect(css).not.toContain('url(assets/img/');
        // Both fresh and rotten reference a data:image/svg URI.
        const dataUris = css.match(/url\(data:image\/svg\+xml[^)]*\)/g) || [];
        expect(dataUris.length).toBe(2);
        expect(css).toContain('.jc-tomato.fresh');
        expect(css).toContain('.jc-tomato.rotten');
    });
});
