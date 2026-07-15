import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';

vi.mock('../helpers', () => ({
    getItemCached: vi.fn((itemId: string) => Promise.resolve({ Id: itemId, ImageTags: {} })),
}));
vi.mock('./library-render', () => ({
    formatTimestamp: (value: unknown) => String(value),
    parseTimestampInput: () => null,
    renderActiveBookmarks: vi.fn(),
}));
vi.mock('./library-replacements', () => ({ findAndOfferReplacement: vi.fn() }));
vi.mock('./library-modals', () => ({ showOffsetAdjustmentModal: vi.fn() }));

import { renderBookmarkItems } from './library-items';

describe('bookmark details navigation', () => {
    let show: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        history.replaceState({}, '', '/jellyfin/web/index.html#/bookmarks');
        JC.t = (key: string) => key === 'bookmark_count' ? '{count} bookmarks' : key;
        (window.ApiClient as unknown as { getImageUrl: (id: string) => string }).getImageUrl =
            (id: string) => `https://media.example/jellyfin/Items/${encodeURIComponent(id)}/Images/Primary`;
        show = vi.fn();
        window.Emby = { Page: { show } };
    });

    it('renders an encoded, document-relative link that retains the configured base URL', async () => {
        const container = document.createElement('div');
        const itemId = 'item/with ?#& delimiters';

        await renderBookmarkItems(container, {
            group: {
                type: 'movie',
                details: { itemId, name: 'Base URL fixture' },
                bookmarks: [],
            },
        }, 'movie');

        const title = container.querySelector<HTMLAnchorElement>('.jc-bookmark-item-title');
        expect(title?.getAttribute('href'))
            .toBe('#/details?id=item%2Fwith%20%3F%23%26%20delimiters');
        expect(title?.href).toBe(
            'http://localhost:3000/jellyfin/web/index.html#/details?id=item%2Fwith%20%3F%23%26%20delimiters'
        );

        container.querySelector<HTMLElement>('.jc-bookmark-item-poster')?.click();
        expect(show).toHaveBeenCalledWith(
            '/details?id=item%2Fwith%20%3F%23%26%20delimiters'
        );
    });
});
