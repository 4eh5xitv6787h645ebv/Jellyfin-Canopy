import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import { resetFromUserConfig } from './data';
import {
    clearFilterIdentityState,
    filterAllNativeCards,
    filterNativeCards,
    invalidateParentSeriesAssociations,
    restoreNativeCardsForIds,
} from './filter';

function installHiddenSeries(seriesId = 'hidden-series'): void {
    const context = JC.identity.capture()!;
    const hiddenContent = JC.identity.own({
        items: { [seriesId]: { itemId: seriesId, type: 'Series', hideScope: 'global' } },
        settings: { enabled: true, filterLibrary: true },
    }, context);
    JC.userConfig = JC.identity.own({ hiddenContent }, context);
    resetFromUserConfig();
}

function episodeCard(itemId = 'episode-1'): HTMLElement {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.id = itemId;
    card.dataset.type = 'Episode';
    document.body.appendChild(card);
    return card;
}

describe('hidden-content parent-Series resolution', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        window.location.hash = '#/library';
        installHiddenSeries();
    });

    afterEach(() => {
        clearFilterIdentityState();
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    it('retries an omitted batch row and later restores parent hiding', async () => {
        const ajax = vi.spyOn(ApiClient, 'ajax')
            .mockResolvedValueOnce({ Items: [] })
            .mockResolvedValueOnce({ Items: [{ Id: 'episode-1', SeriesId: 'hidden-series' }] });
        const card = episodeCard();

        filterAllNativeCards();
        await vi.waitFor(() => expect(ajax).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(card.hasAttribute('data-jc-hidden-checked')).toBe(false));

        await vi.waitFor(() => {
            expect(ajax).toHaveBeenCalledTimes(2);
            expect(card.classList.contains('jc-hidden')).toBe(true);
            expect(card.getAttribute('data-jc-hidden-parent-series-id')).toBe('hidden-series');
        }, { timeout: 2_000 });
    });

    it('does not make a transient batch and individual failure sticky', async () => {
        const ajax = vi.spyOn(ApiClient, 'ajax')
            .mockRejectedValueOnce(new Error('temporary batch failure'))
            .mockRejectedValueOnce(new Error('temporary item failure'))
            .mockResolvedValueOnce({ Items: [{ Id: 'episode-1', SeriesId: 'hidden-series' }] });
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const card = episodeCard();

        filterAllNativeCards();

        await vi.waitFor(() => {
            expect(ajax).toHaveBeenCalledTimes(3);
            expect(card.classList.contains('jc-hidden')).toBe(true);
            expect(card.getAttribute('data-jc-hidden-parent-series-id')).toBe('hidden-series');
        }, { timeout: 2_000 });
    });

    it('keeps the old parent marker until a replacement result can unhide atomically', async () => {
        let resolveReplacement!: (value: unknown) => void;
        const replacement = new Promise((resolve) => { resolveReplacement = resolve; });
        const ajax = vi.spyOn(ApiClient, 'ajax')
            .mockResolvedValueOnce({ Items: [{ Id: 'episode-1', SeriesId: 'hidden-series' }] })
            .mockReturnValueOnce(replacement);
        const card = episodeCard();

        filterAllNativeCards();
        await vi.waitFor(() => expect(card.classList.contains('jc-hidden')).toBe(true));

        const afterPositiveTtl = Date.now() + 6 * 60 * 1_000;
        vi.spyOn(Date, 'now').mockReturnValue(afterPositiveTtl);
        restoreNativeCardsForIds(new Set(['unrelated-item']));
        filterNativeCards();
        await vi.waitFor(() => expect(ajax).toHaveBeenCalledTimes(2));
        expect(card.classList.contains('jc-hidden')).toBe(true);
        expect(card.getAttribute('data-jc-hidden-parent-series-id')).toBe('hidden-series');

        resolveReplacement({ Items: [{ Id: 'episode-1', SeriesId: 'visible-series' }] });
        await vi.waitFor(() => {
            expect(card.classList.contains('jc-hidden')).toBe(false);
            expect(card.hasAttribute('data-jc-hidden-parent-series-id')).toBe(false);
        });
    });

    it('deduplicates duplicate visible cards while applying the cached result to both', async () => {
        const ajax = vi.spyOn(ApiClient, 'ajax')
            .mockResolvedValue({ Items: [{ Id: 'episode-1', SeriesId: 'hidden-series' }] });
        const first = episodeCard();
        const second = episodeCard();

        filterAllNativeCards();
        await vi.waitFor(() => {
            expect(first.classList.contains('jc-hidden')).toBe(true);
            expect(second.classList.contains('jc-hidden')).toBe(true);
        }, { timeout: 2_000 });
        expect(ajax).toHaveBeenCalledTimes(1);
    });

    it('stops automatic retry work after the per-card attempt cap', async () => {
        vi.useFakeTimers();
        try {
            const ajax = vi.spyOn(ApiClient, 'ajax').mockRejectedValue(new Error('offline'));
            vi.spyOn(console, 'warn').mockImplementation(() => undefined);
            const card = episodeCard();

            filterAllNativeCards();
            await vi.advanceTimersByTimeAsync(2_500);
            expect(ajax).toHaveBeenCalledTimes(8);
            expect(card.hasAttribute('data-jc-hidden-checked')).toBe(true);

            filterNativeCards();
            await vi.advanceTimersByTimeAsync(1_000);
            expect(ajax).toHaveBeenCalledTimes(8);
        } finally {
            vi.useRealTimers();
        }
    });

    it('recovers overflow beyond both 1,000-entry backpressure tables', async () => {
        const responseItems = Array.from({ length: 1_001 }, (_value, index) => ({
            Id: `overflow-episode-${index}`,
            SeriesId: 'hidden-series',
        }));
        let calls = 0;
        const ajax = vi.spyOn(ApiClient, 'ajax').mockImplementation(() => {
            calls += 1;
            // The first 20 requests cover the first bounded 1,000 IDs in
            // 50-item chunks and omit every row. The bounded overflow pass
            // must later recover all 1,001 cards without retaining card 1,001.
            return Promise.resolve({ Items: calls <= 20 ? [] : responseItems });
        });
        for (let index = 0; index < 1_001; index += 1) {
            episodeCard(`overflow-episode-${index}`);
        }

        filterAllNativeCards();

        await vi.waitFor(() => {
            expect(document.querySelectorAll('.card.jc-hidden')).toHaveLength(1_001);
        }, { timeout: 4_000 });
        expect(ajax.mock.calls.length).toBeGreaterThan(20);
        // Initial wave plus at most three capped overflow waves, each no more
        // than 20 sequential 50-ID requests for the 1,000-ID pending bound.
        expect(ajax.mock.calls.length).toBeLessThanOrEqual(80);
    });

    it('invalidates an old parent association on a library change', async () => {
        const ajax = vi.spyOn(ApiClient, 'ajax')
            .mockResolvedValueOnce({ Items: [{ Id: 'episode-1', SeriesId: 'hidden-series' }] })
            .mockResolvedValueOnce({ Items: [{ Id: 'episode-1', SeriesId: 'visible-series' }] });
        const card = episodeCard();

        filterAllNativeCards();
        await vi.waitFor(() => expect(card.classList.contains('jc-hidden')).toBe(true));

        invalidateParentSeriesAssociations();
        await vi.waitFor(() => {
            expect(ajax).toHaveBeenCalledTimes(2);
            expect(card.classList.contains('jc-hidden')).toBe(false);
            expect(card.hasAttribute('data-jc-hidden-parent-series-id')).toBe(false);
        });
    });
});
