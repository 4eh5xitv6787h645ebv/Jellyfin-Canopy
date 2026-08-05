import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import type { TagPipelineLike } from '../types/jc';
import { disposeAllTagRenderers } from '../core/tag-renderer-base';
import { installQualityTagsFacade } from './qualitytags';

type RegisteredRenderer = {
    render(el: HTMLElement, item: unknown, extras?: unknown): void;
    renderFromServerCache(el: HTMLElement, entry: unknown, itemId: string): void;
};

const ENGLISH = {
    Type: 'Audio', Language: 'en-US', Codec: 'aac', Channels: 6,
    ChannelLayout: '5.1', IsDefault: true, Index: 1, SourceIndex: 0,
};
const PORTUGUESE = {
    Type: 'Audio', Language: 'pt-BR', Codec: 'eac3', Channels: 2,
    ChannelLayout: 'stereo', IsDefault: false, Index: 2, SourceIndex: 0,
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

function liveItem(id: string): Record<string, unknown> {
    const video = { Type: 'Video', Codec: 'h264', Width: 1920, Height: 1080 };
    return {
        Id: id,
        Type: 'Movie',
        MediaStreams: [video, ENGLISH, PORTUGUESE],
        MediaSources: [{ MediaStreams: [video, ENGLISH, PORTUGUESE] }],
    };
}

function serverEntry(streams: unknown[] = [ENGLISH, PORTUGUESE]): Record<string, unknown> {
    return {
        StreamData: {
            ItemName: 'Multilingual fixture',
            Streams: streams,
            Sources: [{ Path: '/media/primary.mkv' }],
        },
    };
}

describe('quality tag preferred-audio integration', () => {
    let renderer: RegisteredRenderer;
    let uninstall: () => void;

    beforeEach(() => {
        document.body.innerHTML = '';
        localStorage.clear();
        JC.identity.transition('server-a', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'quality-audio-test');
        JC.currentSettings = {
            qualityTagsEnabled: true,
            preferredAudioLanguage: 'pt-BR',
            showResolutionTag: false,
            showSourceTag: false,
            showDynamicRangeTag: false,
            showSpecialFormatTag: false,
            showVideoCodecTag: false,
            showAudioInfoTag: true,
        };
        JC.pluginConfig = { PreferredAudioLanguage: '' };
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
    });

    it('renders the same selected-track badge from live and projected server data', () => {
        const live = host();
        renderer.render(live, liveItem('live-item'));
        const projected = host();
        renderer.renderFromServerCache(projected, serverEntry(), 'server-item');

        expect(labels(live)).toEqual(['Dolby Digital+ 2.0']);
        expect(labels(projected)).toEqual(labels(live));
        expect(labels(live)).not.toContain('5.1');
    });

    it('does not reuse an item-only server result after the preference changes', () => {
        const portuguese = host();
        renderer.renderFromServerCache(portuguese, serverEntry(), 'shared-item');
        expect(labels(portuguese)).toEqual(['Dolby Digital+ 2.0']);

        JC.currentSettings = { ...JC.currentSettings, preferredAudioLanguage: 'en-US' };
        const english = host();
        renderer.renderFromServerCache(english, serverEntry(), 'shared-item');
        expect(labels(english)).toEqual(['5.1']);
    });

    it('does not carry a server result across user identities', () => {
        const first = host();
        renderer.renderFromServerCache(first, serverEntry(), 'same-item');
        expect(labels(first)).toEqual(['Dolby Digital+ 2.0']);

        JC.identity.transition('server-a', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'quality-audio-next-user');
        (JC as typeof JC & { initializeQualityTags?: () => void }).initializeQualityTags?.();
        const second = host();
        renderer.renderFromServerCache(second, serverEntry([
            { ...PORTUGUESE, Codec: 'aac', Channels: 6, ChannelLayout: '5.1' },
        ]), 'same-item');
        expect(labels(second)).toEqual(['5.1']);
    });
});
