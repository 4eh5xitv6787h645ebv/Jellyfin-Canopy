// src/enhanced/spoiler-guard/image-refresh.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import {
    bustUrl, rewriteSrcset, rewriteStyleUrls, refreshSpoilerableImages, IMG_PATH_RE,
} from './image-refresh';

const CB = '_sbcb=1699999999999';
const ITEM = '/Items/abcd1234/Images/Primary';
const NON = '/web/assets/logo.png';

afterEach(() => { document.body.innerHTML = ''; });

describe('spoiler-guard/image-refresh', () => {
    describe('bustUrl', () => {
        it('appends the cache-buster with ? when no query present', () => {
            expect(bustUrl(ITEM, CB)).toBe(`${ITEM}?${CB}`);
        });
        it('appends with & when a query already exists', () => {
            expect(bustUrl(`${ITEM}?tag=x`, CB)).toBe(`${ITEM}?tag=x&${CB}`);
        });
        it('replaces a prior _sbcb instead of stacking it', () => {
            const once = bustUrl(ITEM, '_sbcb=1');
            const twice = bustUrl(once, '_sbcb=2');
            expect(twice).toBe(`${ITEM}?_sbcb=2`);
            expect(twice.match(/_sbcb=/g)).toHaveLength(1);
        });
        it('leaves non-item URLs untouched', () => {
            expect(bustUrl(NON, CB)).toBe(NON);
            expect(bustUrl('', CB)).toBe('');
        });
    });

    describe('rewriteSrcset', () => {
        it('busts only item URLs and preserves descriptors + separators', () => {
            const ss = `${ITEM} 1x, ${ITEM}?tag=y 2x`;
            const out = rewriteSrcset(ss, CB);
            expect(out).toBe(`${ITEM}?${CB} 1x, ${ITEM}?tag=y&${CB} 2x`);
        });
        it('leaves a non-item srcset alone', () => {
            const ss = `${NON} 1x, ${NON} 2x`;
            expect(rewriteSrcset(ss, CB)).toBe(ss);
        });
    });

    describe('rewriteStyleUrls', () => {
        it('busts url(...) references to item images (quoted and bare)', () => {
            expect(rewriteStyleUrls(`background-image:url('${ITEM}')`, CB))
                .toBe(`background-image:url('${ITEM}?${CB}')`);
            expect(rewriteStyleUrls(`background:url(${ITEM})`, CB))
                .toBe(`background:url(${ITEM}?${CB})`);
        });
    });

    describe('refreshSpoilerableImages', () => {
        it('rewrites img[src], img[srcset], source[srcset] and inline backgrounds', () => {
            document.body.innerHTML = `
                <img id="a" src="${ITEM}">
                <img id="b" src="${NON}">
                <picture><source id="c" srcset="${ITEM} 2x"></picture>
                <div id="d" style="background-image:url('${ITEM}')"></div>`;
            refreshSpoilerableImages();
            expect(document.getElementById('a')!.getAttribute('src')).toMatch(/_sbcb=\d+/);
            expect(document.getElementById('b')!.getAttribute('src')).toBe(NON);
            expect(document.getElementById('c')!.getAttribute('srcset')).toMatch(/_sbcb=\d+/);
            expect(document.getElementById('d')!.getAttribute('style')).toMatch(/_sbcb=\d+/);
        });
    });

    it('IMG_PATH_RE matches the Jellyfin item-image shape only', () => {
        expect(IMG_PATH_RE.test(ITEM)).toBe(true);
        expect(IMG_PATH_RE.test(NON)).toBe(false);
    });
});
