import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { recordDetailsViewShown, resetDetailsViewTrackingForTests } from '../core/details-view';
import { installAnimeFillerWarnings } from './anime-filler-warnings';

type AjaxResult = { items: Array<{ itemId: string; classification: 'Filler' | 'Canon' | 'Unknown'; reason?: string }> };
type AjaxOptions = { data: string; signal?: AbortSignal };

let ajax: Mock<(options: AjaxOptions) => Promise<AjaxResult>>;
let dispose: (() => void) | null;

function markerRules(): CSSStyleRule[] {
    const style = document.getElementById('jc-anime-filler-warning-styles') as HTMLStyleElement | null;
    if (!style?.sheet) return [];
    return [...style.sheet.cssRules].filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule);
}

beforeEach(() => {
    vi.useFakeTimers();
    resetDetailsViewTrackingForTests();
    window.history.replaceState({}, '', '/web/index.html#/details?id=episode-1');
    document.head.querySelector('#jc-anime-filler-warning-styles')?.remove();
    document.body.innerHTML = `
        <div id="itemDetailPage">
            <h1 class="itemName">Episode</h1>
            <div class="card" data-id="episode-2"><div class="cardScalable"></div></div>
        </div>`;
    recordDetailsViewShown(document.querySelector('#itemDetailPage'));
    ajax = vi.fn((_options: AjaxOptions): Promise<AjaxResult> => Promise.resolve({
        items: [
            { itemId: 'episode-1', classification: 'Filler' },
            { itemId: 'episode-2', classification: 'Canon' },
        ],
    }));
    const client = { ajax, getUrl: (path: string) => path };
    window.ApiClient = client as unknown as typeof window.ApiClient;
    (globalThis as unknown as { ApiClient: typeof client }).ApiClient = client;
    dispose = null;
});

afterEach(() => {
    dispose?.();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('anime filler warnings', () => {
    it('scopes identity attribute observation to the active page instead of document.body', async () => {
        const observe = vi.spyOn(MutationObserver.prototype, 'observe');
        dispose = installAnimeFillerWarnings(new AbortController().signal, () => true);

        await vi.advanceTimersByTimeAsync(80);

        const attributeCalls = observe.mock.calls.filter(([, options]) => options?.attributes);
        expect(attributeCalls).toHaveLength(1);
        expect(attributeCalls[0][0]).toBe(document.querySelector('#itemDetailPage'));
        expect(attributeCalls[0][1]).toMatchObject({
            attributes: true,
            attributeFilter: ['data-id', 'data-itemid'],
            subtree: true,
        });
        expect(attributeCalls.some(([target]) => target === document.body)).toBe(false);
    });

    it('batches visible IDs and renders only accessible Filler results', async () => {
        dispose = installAnimeFillerWarnings(new AbortController().signal, () => true);

        await vi.advanceTimersByTimeAsync(80);

        expect(ajax).toHaveBeenCalledTimes(1);
        const request = ajax.mock.calls[0][0];
        const body = JSON.parse(request.data) as { itemIds: string[] };
        expect(body.itemIds).toEqual(['episode-1', 'episode-2']);
        expect(request.signal).toBeInstanceOf(AbortSignal);
        expect(document.querySelector('#itemDetailPage > .itemName > .jc-anime-filler-marker')?.textContent).toBe('Filler');
        expect(document.querySelector('.card .jc-anime-filler-marker')).toBeNull();
    });

    it('moves an early detail badge beside a title that renders later', async () => {
        document.body.innerHTML = '<div id="itemDetailPage"><div class="detailPagePrimaryContainer"></div></div>';
        recordDetailsViewShown(document.querySelector('#itemDetailPage'));
        dispose = installAnimeFillerWarnings(new AbortController().signal, () => true);

        await vi.advanceTimersByTimeAsync(80);
        expect(document.querySelector('.detailPagePrimaryContainer > .jc-anime-filler-marker')).not.toBeNull();

        document.querySelector('.detailPagePrimaryContainer')!
            .insertAdjacentHTML('afterbegin', '<h1 class="itemName">Episode</h1>');
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(80);

        expect(document.querySelectorAll('.jc-anime-filler-marker')).toHaveLength(1);
        expect(document.querySelector('.itemName > .jc-anime-filler-marker')?.textContent).toBe('Filler');
        expect(document.querySelector('.detailPagePrimaryContainer')?.classList.contains('jc-anime-filler-anchor')).toBe(false);
    });

    it('overlays fallback badges on image-less cards so they add no in-flow width (issue #454)', async () => {
        // Partial-library season page whose episode rows have no
        // .cardScalable/.cardImageContainer/.listItemImage anchor: applyMarker
        // falls back to the card/list item itself. The badge must be an
        // absolute overlay there too, or it widens the 390px mobile page
        // (the e2e mobile no-jank contract).
        window.history.replaceState({}, '', '/web/index.html#/details?id=season-1');
        document.body.innerHTML = `
            <div id="itemDetailPage">
                <h1 class="itemName">Season</h1>
                <div class="card" data-id="episode-2"></div>
                <div class="listItem" data-id="episode-3"></div>
            </div>`;
        recordDetailsViewShown(document.querySelector('#itemDetailPage'));
        ajax.mockResolvedValue({
            items: [
                { itemId: 'season-1', classification: 'Unknown' },
                { itemId: 'episode-2', classification: 'Filler' },
                { itemId: 'episode-3', classification: 'Filler' },
            ],
        });
        dispose = installAnimeFillerWarnings(new AbortController().signal, () => true);

        await vi.advanceTimersByTimeAsync(80);

        const cardBadge = document.querySelector<HTMLElement>('.card > .jc-anime-filler-marker');
        const listBadge = document.querySelector<HTMLElement>('.listItem > .jc-anime-filler-marker');
        expect(cardBadge).not.toBeNull();
        expect(listBadge).not.toBeNull();
        const rules = markerRules();
        expect(rules.length).toBeGreaterThan(0);
        for (const badge of [cardBadge!, listBadge!]) {
            // Out of flow: contributes no width to the card or the page.
            expect(rules.some(rule => badge.matches(rule.selectorText)
                && rule.style.position === 'absolute'
                && rule.style.pointerEvents === 'none')).toBe(true);
            // ...and positioned against its own anchor, not an ancestor.
            expect(badge.parentElement!.classList.contains('jc-anime-filler-anchor')).toBe(true);
            expect(rules.some(rule => badge.parentElement!.matches(rule.selectorText)
                && rule.style.position === 'relative')).toBe(true);
        }
    });

    it('hard-caps in-flow badge width so no anchor can overflow the viewport (issue #454)', async () => {
        dispose = installAnimeFillerWarnings(new AbortController().signal, () => true);

        await vi.advanceTimersByTimeAsync(80);

        const badge = document.querySelector<HTMLElement>('.itemName > .jc-anime-filler-marker');
        expect(badge).not.toBeNull();
        const base = markerRules().filter(rule => badge!.matches(rule.selectorText));
        expect(base.length).toBeGreaterThan(0);
        // Width constraint: never wider than the anchor's content box.
        expect(base.some(rule => rule.style.maxWidth === '100%'
            && rule.style.boxSizing === 'border-box')).toBe(true);
        // Flex-item min-content floor lifted so a tight row can compress the
        // pill instead of overflowing the page.
        expect(base.some(rule => rule.style.minWidth === '0px')).toBe(true);
        // Long localized badge text folds instead of forcing intrinsic width.
        expect(base.some(rule => rule.style.overflowWrap === 'anywhere')).toBe(true);
    });

    it('does not let an Unknown season target churn a descendant filler-card badge', async () => {
        window.history.replaceState({}, '', '/web/index.html#/details?id=season-1');
        document.body.innerHTML = `
            <div id="itemDetailPage">
                <h1 class="itemName">Season</h1>
                <div class="card" data-id="episode-2"><div class="cardScalable"></div></div>
            </div>`;
        recordDetailsViewShown(document.querySelector('#itemDetailPage'));
        ajax.mockResolvedValue({
            items: [
                { itemId: 'season-1', classification: 'Unknown' },
                { itemId: 'episode-2', classification: 'Filler' },
            ],
        });
        dispose = installAnimeFillerWarnings(new AbortController().signal, () => true);

        await vi.advanceTimersByTimeAsync(80);
        const settled = document.querySelector('.card .jc-anime-filler-marker');
        expect(settled).not.toBeNull();
        await Promise.resolve();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(800);

        expect(ajax).toHaveBeenCalledTimes(1);
        expect(document.querySelectorAll('.card .jc-anime-filler-marker')).toHaveLength(1);
        expect(document.querySelector('.card .jc-anime-filler-marker')).toBe(settled);
    });

    it('fences a recycled card before an async response lands', async () => {
        let resolve!: (value: AjaxResult) => void;
        const pending = new Promise<AjaxResult>((done) => { resolve = done; });
        ajax.mockReturnValue(pending);
        dispose = installAnimeFillerWarnings(new AbortController().signal, () => true);
        await vi.advanceTimersByTimeAsync(80);

        document.querySelector<HTMLElement>('.card')!.dataset.id = 'episode-3';
        resolve({ items: [{ itemId: 'episode-2', classification: 'Filler' }] });
        await Promise.resolve();

        expect(document.querySelector('.card .jc-anime-filler-marker')).toBeNull();
    });

    it('drops late results and owned DOM after disposal', async () => {
        let resolve!: (value: AjaxResult) => void;
        const pending = new Promise<AjaxResult>((done) => { resolve = done; });
        ajax.mockReturnValue(pending);
        dispose = installAnimeFillerWarnings(new AbortController().signal, () => true);
        await vi.advanceTimersByTimeAsync(80);
        dispose();
        dispose = null;

        resolve({ items: [{ itemId: 'episode-1', classification: 'Filler' }] });
        await Promise.resolve();

        expect(document.querySelector('.jc-anime-filler-marker')).toBeNull();
        expect(document.querySelector('#jc-anime-filler-warning-styles')).toBeNull();
    });

    it('partitions more than 100 visible episodes without starving later cards', async () => {
        document.body.innerHTML = `<div id="itemDetailPage"><h1 class="itemName">Episode</h1>${Array.from(
            { length: 204 },
            (_, index) => `<div class="card" data-id="episode-${index + 2}"><div class="cardScalable"></div></div>`
        ).join('')}</div>`;
        recordDetailsViewShown(document.querySelector('#itemDetailPage'));
        ajax.mockImplementation((options: AjaxOptions): Promise<AjaxResult> => {
            const body = JSON.parse(options.data) as { itemIds: string[] };
            return Promise.resolve({
                items: body.itemIds.map(itemId => ({
                    itemId,
                    classification: itemId === 'episode-205' ? 'Filler' as const : 'Unknown' as const,
                })),
            });
        });
        dispose = installAnimeFillerWarnings(new AbortController().signal, () => true);

        for (let batch = 0; batch < 4; batch++) await vi.advanceTimersByTimeAsync(80);

        expect(ajax).toHaveBeenCalledTimes(3);
        expect(ajax.mock.calls.map(call => {
            const body = JSON.parse(call[0].data) as { itemIds: string[] };
            return body.itemIds.length;
        })).toEqual([100, 100, 5]);
        expect(document.querySelector('[data-id="episode-205"] .jc-anime-filler-marker')).not.toBeNull();
    });

    it('keeps one request in flight during repeated DOM churn and then requests the recycled ID', async () => {
        let resolveFirst!: (value: AjaxResult) => void;
        const first = new Promise<AjaxResult>((done) => { resolveFirst = done; });
        ajax.mockReturnValueOnce(first).mockResolvedValue({
            items: [{ itemId: 'episode-3', classification: 'Canon' }],
        });
        dispose = installAnimeFillerWarnings(new AbortController().signal, () => true);
        await vi.advanceTimersByTimeAsync(80);

        const card = document.querySelector<HTMLElement>('.card')!;
        for (let index = 0; index < 20; index++) card.dataset.churn = String(index);
        card.dataset.id = 'episode-3';
        await vi.advanceTimersByTimeAsync(400);
        expect(ajax).toHaveBeenCalledTimes(1);

        resolveFirst({ items: [{ itemId: 'episode-1', classification: 'Canon' }] });
        await Promise.resolve();
        await vi.runAllTimersAsync();

        expect(ajax).toHaveBeenCalledTimes(2);
        const secondBody = JSON.parse(ajax.mock.calls[1][0].data) as { itemIds: string[] };
        expect(secondBody.itemIds).toEqual(['episode-3']);
    });

    it('removes a settled Filler badge when an identity attribute recycles the card', async () => {
        ajax.mockImplementation((options: AjaxOptions): Promise<AjaxResult> => {
            const body = JSON.parse(options.data) as { itemIds: string[] };
            return Promise.resolve({
                items: body.itemIds.map(itemId => ({
                    itemId,
                    classification: itemId === 'episode-2' ? 'Filler' as const : 'Canon' as const,
                })),
            });
        });
        dispose = installAnimeFillerWarnings(new AbortController().signal, () => true);
        await vi.advanceTimersByTimeAsync(160);
        expect(document.querySelector('.card .jc-anime-filler-marker')).not.toBeNull();

        document.querySelector<HTMLElement>('.card')!.dataset.id = 'episode-3';
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(80);

        expect(ajax).toHaveBeenCalledTimes(2);
        expect(document.querySelector('.card .jc-anime-filler-marker')).toBeNull();
    });

    it('retries transient Unknown responses after the stable-page backoff expires', async () => {
        ajax.mockResolvedValueOnce({
            items: [
                { itemId: 'episode-1', classification: 'Unknown', reason: 'provider-unavailable' },
                { itemId: 'episode-2', classification: 'Unknown', reason: 'provider-unavailable' },
            ],
        }).mockResolvedValue({
            items: [
                { itemId: 'episode-1', classification: 'Filler' },
                { itemId: 'episode-2', classification: 'Canon' },
            ],
        });
        dispose = installAnimeFillerWarnings(new AbortController().signal, () => true);
        await vi.advanceTimersByTimeAsync(80);
        expect(ajax).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(30_080);

        expect(ajax).toHaveBeenCalledTimes(2);
        expect(document.querySelector('#itemDetailPage .jc-anime-filler-marker')).not.toBeNull();
    });

    it('retries a rejected request after the stable-page backoff expires', async () => {
        ajax.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({
            items: [
                { itemId: 'episode-1', classification: 'Filler' },
                { itemId: 'episode-2', classification: 'Canon' },
            ],
        });
        dispose = installAnimeFillerWarnings(new AbortController().signal, () => true);
        await vi.advanceTimersByTimeAsync(80);
        expect(ajax).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(30_080);

        expect(ajax).toHaveBeenCalledTimes(2);
        expect(document.querySelector('#itemDetailPage .jc-anime-filler-marker')).not.toBeNull();
    });

    it('retains a later rejection deadline after an earlier transient batch deadline', async () => {
        document.body.innerHTML = `<div id="itemDetailPage"><h1 class="itemName">Episode</h1>${Array.from(
            { length: 204 },
            (_, index) => `<div class="card" data-id="episode-${index + 2}"><div class="cardScalable"></div></div>`
        ).join('')}</div>`;
        recordDetailsViewShown(document.querySelector('#itemDetailPage'));
        let requestNumber = 0;
        let rejectSecond!: (reason: Error) => void;
        ajax.mockImplementation((options: AjaxOptions): Promise<AjaxResult> => {
            requestNumber++;
            const body = JSON.parse(options.data) as { itemIds: string[] };
            if (requestNumber === 1) {
                return Promise.resolve({
                    items: body.itemIds.map(itemId => ({
                        itemId,
                        classification: 'Unknown' as const,
                        reason: 'provider-unavailable',
                    })),
                });
            }
            if (requestNumber === 2) {
                return new Promise((_resolve, reject) => { rejectSecond = reject; });
            }
            return Promise.resolve({
                items: body.itemIds.map(itemId => ({ itemId, classification: 'Canon' as const })),
            });
        });
        dispose = installAnimeFillerWarnings(new AbortController().signal, () => true);
        await vi.advanceTimersByTimeAsync(160);
        expect(ajax).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(5_000);
        rejectSecond(new Error('later offline failure'));
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(30_090);

        expect(ajax).toHaveBeenCalledTimes(3);
    });
});
