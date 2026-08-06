import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import type { TagPipelineLike } from '../types/jc';
import { disposeAllTagRenderers } from '../core/tag-renderer-base';
import { getEnhancedQuality, installQualityTagsFacade } from './qualitytags';

type RegisteredRenderer = {
    render(el: HTMLElement, item: unknown, extras?: unknown): void;
    renderFromCache?(el: HTMLElement, itemId: string): boolean;
    renderFromServerCache(el: HTMLElement, entry: unknown, itemId: string): void;
};

function host(): HTMLElement {
    const card = document.createElement('div');
    card.className = 'card';
    const target = document.createElement('div');
    card.appendChild(target);
    document.body.appendChild(card);
    return target;
}

function labels(target: HTMLElement): string[] {
    return Array.from(target.querySelectorAll<HTMLElement>('.quality-overlay-label'))
        .map((label) => label.textContent || '');
}

describe('quality tag file-source integration', () => {
    let renderer: RegisteredRenderer;
    let uninstall: () => void;

    beforeEach(() => {
        document.body.innerHTML = '';
        localStorage.clear();
        JC.identity.transition('server-a', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'quality-source-test');
        JC.currentSettings = {
            qualityTagsEnabled: true,
            showResolutionTag: false,
            showSourceTag: true,
            showDynamicRangeTag: false,
            showSpecialFormatTag: false,
            showVideoCodecTag: false,
            showAudioInfoTag: false,
            showFileSource: false,
        };
        JC.pluginConfig = { TagCacheServerMode: true };
        JC.tagPipeline = {
            registerRenderer: (_name, candidate) => {
                renderer = candidate as unknown as RegisteredRenderer;
            },
            unregisterRenderer: vi.fn(),
        } as TagPipelineLike;
        uninstall = installQualityTagsFacade();
        (JC as typeof JC & { initializeQualityTags?: () => void }).initializeQualityTags?.();
    });

    afterEach(() => {
        uninstall();
        disposeAllTagRenderers();
        document.body.innerHTML = '';
        localStorage.clear();
        JC.currentSettings = {};
        JC.pluginConfig = {};
        JC.tagPipeline = undefined;
        JC._hotCache = undefined;
    });

    it('keeps item-only, live, and projected server source values aligned', () => {
        expect(getEnhancedQuality(null, null, { Path: '/media/Item.BluRay.disc' })).toEqual(['BluRay']);

        const live = host();
        renderer.render(live, {
            Id: 'live-source',
            Type: 'Movie',
            MediaSources: [{ Path: '/media/Item.BluRay.disc' }],
        });
        const projected = host();
        renderer.renderFromServerCache(projected, {
            StreamData: {
                ItemName: 'Item',
                ItemPath: '/media/Item.disc',
                Streams: [],
                Sources: [{ Path: '/media/Item.BluRay.disc' }],
            },
        }, 'server-source');

        expect(labels(live)).toEqual(['BluRay']);
        expect(labels(projected)).toEqual(labels(live));
        expect(live.querySelector('.other-quality')?.getAttribute('data-quality')).toBe('BluRay');
    });

    it('keeps ambiguous multi-version source data silent on both poster paths', () => {
        const sources = [
            { Path: '/media/A.BluRay.disc' },
            { Path: '/media/B.DVD.disc' },
        ];
        const live = host();
        renderer.render(live, { Id: 'live-ambiguous', Type: 'Movie', MediaSources: sources });
        const projected = host();
        renderer.renderFromServerCache(projected, {
            StreamData: { ItemName: 'Item', ItemPath: '', Streams: [], Sources: sources },
        }, 'server-ambiguous');

        expect(labels(live)).toEqual([]);
        expect(labels(projected)).toEqual([]);
    });

    it('keeps the poster category independent from the details toggle', () => {
        JC.currentSettings = { ...JC.currentSettings, showSourceTag: false, showFileSource: true };
        const posterOff = host();
        renderer.render(posterOff, {
            Id: 'poster-off', Type: 'Movie', MediaSources: [{ Path: '/media/Item.DVD.disc' }],
        });
        expect(labels(posterOff)).toEqual([]);

        JC.currentSettings = { ...JC.currentSettings, showSourceTag: true, showFileSource: false };
        const posterOn = host();
        renderer.render(posterOn, {
            Id: 'poster-on', Type: 'Movie', MediaSources: [{ Path: '/media/Item.DVD.disc' }],
        });
        expect(labels(posterOn)).toEqual(['DVD']);
    });

    it('rejects a hot entry created before the shared detector version', () => {
        const initial = host();
        renderer.render(initial, {
            Id: 'legacy-cache', Type: 'Movie', MediaSources: [{ Path: '/media/Item.DVD.disc' }],
        });
        const hot = JC._hotCache?.quality as { get(key: string): Record<string, unknown> | undefined };
        const entry = hot.get('legacy-cache')!;
        delete entry.fileSourceDetectionVersion;

        const replay = host();
        expect(renderer.renderFromCache?.(replay, 'legacy-cache')).toBe(false);
        expect(labels(replay)).toEqual([]);
    });
});
