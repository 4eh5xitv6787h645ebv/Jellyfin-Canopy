import { afterEach, describe, expect, it, vi } from 'vitest';
import { themeConfiguration } from '../test/theme-studio-fixture';
import { resolveTheme, type ThemeMediaState } from './resolver';
import {
    analyzeLocalMediaImage,
    blendDynamicAccent,
    deriveDominantAccent,
    DynamicAccentCache,
    findLocalMediaImage,
    localMediaImage,
    MAXIMUM_DYNAMIC_ACCENT_CACHE_ENTRIES,
    MAXIMUM_DYNAMIC_IMAGE_BYTES,
    serializeDynamicAccentStyle,
} from './dynamic-color';

const media: ThemeMediaState = {
    viewportWidth: 1366, viewportHeight: 768, tv: false, darkScheme: true,
    reducedMotion: false, moreContrast: false, reducedTransparency: false,
    forcedColors: false, hover: true, coarsePointer: false, jellyfinTheme: 'dark',
    backdropFilterSupported: true,
};

afterEach(() => vi.unstubAllGlobals());

describe('Theme Studio local dynamic color', () => {
    it('accepts only exact same-origin Jellyfin primary/backdrop images and strips the cache key query', () => {
        const valid = localMediaImage(
            'https://media.example/Items/abc/Images/Primary?tag=private-revision',
            'https://media.example',
        );
        expect(valid).toEqual({
            url: 'https://media.example/Items/abc/Images/Primary?tag=private-revision',
            key: 'https://media.example/Items/abc/Images/Primary',
        });
        expect(valid?.key).not.toContain('private-revision');
        for (const value of [
            'https://cdn.example/Items/abc/Images/Primary',
            'https://media.example/Users/abc/Images/Primary',
            'https://media.example/Items/abc/Images/Logo',
            'javascript:alert(1)',
        ]) expect(localMediaImage(value, 'https://media.example'), value).toBeNull();
    });

    it('finds one direct poster or inline backdrop without computed-style or layout reads', () => {
        document.body.innerHTML = '<div class="page">'
            + '<img src="/Items/poster/Images/Primary?tag=1">'
            + '<div style="background-image:url(\'/Items/backdrop/Images/Backdrop?tag=2\')"></div></div>';
        expect(findLocalMediaImage(document, 'poster', window.location.origin)?.key)
            .toBe(`${window.location.origin}/Items/poster/Images/Primary`);
        expect(findLocalMediaImage(document, 'backdrop', window.location.origin)?.key)
            .toBe(`${window.location.origin}/Items/backdrop/Images/Backdrop`);
    });

    it('ignores a hidden cached page and uses the active page before a bounded global backdrop', () => {
        document.body.innerHTML = '<div class="page hide"><div class="backdropImage">'
            + '<img src="/Items/stale/Images/Backdrop"></div>'
            + '</div>'
            + '<div class="page"><img src="/Items/active/Images/Backdrop"></div>'
            + '<img class="backdropImage" src="/Items/global/Images/Backdrop">';
        expect(findLocalMediaImage(document, 'backdrop', window.location.origin)?.key)
            .toBe(`${window.location.origin}/Items/active/Images/Backdrop`);

        document.querySelector('.page:not(.hide)')?.remove();
        document.querySelector<HTMLImageElement>('body > .backdropImage')!.src = '/Items/global/Images/Primary';
        expect(findLocalMediaImage(document, 'backdrop', window.location.origin)).toBeNull();
        document.querySelector<HTMLImageElement>('body > .backdropImage')!.src = '/Items/global/Images/Backdrop';
        expect(findLocalMediaImage(document, 'backdrop', window.location.origin)?.key)
            .toBe(`${window.location.origin}/Items/global/Images/Backdrop`);
        expect(findLocalMediaImage(document, 'poster', window.location.origin)).toBeNull();
    });

    it('derives a deterministic bounded dominant accent and ignores transparent or grey pixels', () => {
        const pixels = new Uint8ClampedArray(4 * 10);
        for (let index = 0; index < 8; index += 1) pixels.set([240, 40, 60, 255], index * 4);
        for (let index = 8; index < 10; index += 1) pixels.set([30, 80, 240, 255], index * 4);
        expect(deriveDominantAccent(pixels)).toBe('#F0283C');
        expect(deriveDominantAccent(pixels)).toBe(deriveDominantAccent(pixels));
        expect(deriveDominantAccent(new Uint8ClampedArray([80, 80, 80, 255, 240, 20, 20, 100])))
            .toBeNull();
    });

    it('bounds blending and its LRU cache without persisting a media identity', () => {
        expect(blendDynamicAccent('#000000', '#FFFFFF', -1)).toBe('#000000');
        expect(blendDynamicAccent('#000000', '#FFFFFF', 0.5)).toBe('#808080');
        expect(blendDynamicAccent('#000000', '#FFFFFF', 2)).toBe('#FFFFFF');
        expect(blendDynamicAccent('red', '#FFFFFF', 1)).toBe('red');

        const cache = new DynamicAccentCache();
        for (let index = 0; index <= MAXIMUM_DYNAMIC_ACCENT_CACHE_ENTRIES; index += 1) {
            cache.set(`item-${index}`, '#AABBCC');
        }
        expect(cache.size).toBe(MAXIMUM_DYNAMIC_ACCENT_CACHE_ENTRIES);
        expect(cache.get('item-0')).toBeUndefined();
        expect(cache.get(`item-${MAXIMUM_DYNAMIC_ACCENT_CACHE_ENTRIES}`)).toBe('#AABBCC');
        cache.clear();
        expect(cache.size).toBe(0);
    });

    it('emits only typed primary variables and no media URL or identifier', () => {
        const configuration = themeConfiguration();
        configuration.Profiles[0].Tokens = {
            'color.dynamic-source': 'poster', 'color.dynamic-strength': 0.5,
        };
        const css = serializeDynamicAccentStyle(resolveTheme(configuration, media), '#FF0000');
        expect(css).toContain('data-jc-theme-dynamic-accent="active"');
        expect(css).toContain('--jf-palette-primary-main:');
        expect(css).not.toContain('url(');
        expect(css).not.toContain('/Items/');
    });

    it('stops an oversized stream before decode and never fetches after cancellation', async () => {
        const createBitmap = vi.fn();
        const fetchMock = vi.fn(() => Promise.resolve(new Response(
            new Uint8Array(MAXIMUM_DYNAMIC_IMAGE_BYTES + 1),
            { status: 200, headers: { 'content-type': 'image/png' } },
        )));
        vi.stubGlobal('createImageBitmap', createBitmap);
        vi.stubGlobal('fetch', fetchMock);
        const image = localMediaImage('/Items/abc/Images/Primary', window.location.origin)!;
        expect(await analyzeLocalMediaImage(image, new AbortController().signal)).toBeNull();
        expect(createBitmap).not.toHaveBeenCalled();

        const cancelled = new AbortController();
        cancelled.abort();
        expect(await analyzeLocalMediaImage(image, cancelled.signal)).toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
