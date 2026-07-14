import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import { displayAudioLanguages, displayWatchProgress } from './details-media-info';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

async function flushPromises(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

function mountContainer(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'itemMiscInfo itemMiscInfo-primary';
    document.body.appendChild(container);
    return container;
}

describe('details media-info identity lifecycle', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = '';
        JC.identity.transition('details-server-a', 'details-user-a', 'details-media-test');
        JC.currentSettings = { watchProgressMode: 'percentage' };
        JC.t = (key: string) => key;
    });

    afterEach(() => {
        JC.identity.transition('', '', 'details-media-test-cleanup');
        JC.core.api = undefined;
        vi.restoreAllMocks();
        vi.clearAllTimers();
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    it('removes A chips and rejects a held A response before B DOM/cache publication', async () => {
        const container = mountContainer();
        const aResponse = deferred<unknown>();
        const aPlugin = vi.fn().mockReturnValue(aResponse.promise);
        JC.core.api = { plugin: aPlugin } as unknown as NonNullable<typeof JC.core.api>;

        displayWatchProgress('shared-item', container);
        expect(aPlugin).toHaveBeenCalledWith(
            '/watch-progress/detailsusera/shared-item',
            { skipCache: true },
        );

        JC.identity.transition('details-server-b', 'details-user-b', 'details-media-test');
        JC.currentSettings = { watchProgressMode: 'percentage' };
        expect(container.querySelector('.mediaInfoItem-watchProgress')).toBeNull();

        const bPlugin = vi.fn().mockResolvedValue({
            progress: 80,
            totalPlaybackTicks: 80,
            totalRuntimeTicks: 100,
        });
        JC.core.api = { plugin: bPlugin } as unknown as NonNullable<typeof JC.core.api>;
        displayWatchProgress('shared-item', container);
        await flushPromises();
        expect(container.textContent).toContain('80%');

        aResponse.resolve({ progress: 5, totalPlaybackTicks: 5, totalRuntimeTicks: 100 });
        await flushPromises();

        expect(container.textContent).toContain('80%');
        expect(container.textContent).not.toContain('5%');
    });

    it('cancels A retry timers synchronously on transition', async () => {
        const container = mountContainer();
        const plugin = vi.fn().mockRejectedValue(new Error('temporary'));
        JC.core.api = { plugin } as unknown as NonNullable<typeof JC.core.api>;
        vi.spyOn(console, 'error').mockImplementation(() => undefined);

        displayWatchProgress('retry-item', container);
        await flushPromises();
        expect(plugin).toHaveBeenCalledTimes(1);

        JC.identity.transition('details-server-b', 'details-user-b', 'details-media-test');
        vi.advanceTimersByTime(10_000);

        expect(plugin).toHaveBeenCalledTimes(1);
        expect(container.querySelector('.mediaInfoItem-watchProgress')).toBeNull();
    });

    it('uses the captured account for audio metadata and drops A language results', async () => {
        const container = mountContainer();
        const aResponse = deferred<unknown>();
        const getItem = vi.spyOn(ApiClient, 'getItem')
            .mockReturnValueOnce(aResponse.promise)
            .mockResolvedValueOnce({
                Type: 'Movie',
                MediaSources: [{ MediaStreams: [{ Type: 'Audio', Language: 'spa' }] }],
            });

        displayAudioLanguages('audio-item', container);
        expect(getItem).toHaveBeenNthCalledWith(1, 'detailsusera', 'audio-item');

        JC.identity.transition('details-server-b', 'details-user-b', 'details-media-test');
        JC.currentSettings = {};
        displayAudioLanguages('audio-item', container);
        await flushPromises();

        aResponse.resolve({
            Type: 'Movie',
            MediaSources: [{ MediaStreams: [{ Type: 'Audio', Language: 'eng' }] }],
        });
        await flushPromises();

        expect(getItem).toHaveBeenNthCalledWith(2, 'detailsuserb', 'audio-item');
        expect(container.querySelector('[data-lang="spa"]')).not.toBeNull();
        expect(container.querySelector('[data-lang="eng"]')).toBeNull();
    });
});
