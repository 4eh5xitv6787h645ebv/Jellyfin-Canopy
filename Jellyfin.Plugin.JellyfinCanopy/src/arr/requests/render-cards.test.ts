// Unit tests for src/arr/requests/render-cards.ts — XSS escaping of
// item/API-derived fields in the download-card renderers (the request/issue
// card renderers already escaped; these guard the download-card sweep).
//
// A hostile field like '"><img src=x onerror=alert(1)>' must render inert:
// escaped into attribute/text positions without injecting any element.
import { describe, expect, it } from 'vitest';
// ui-kit must load before render-cards: it installs the real JC.escapeHtml
// (the test setup stub is a no-op) which render-cards captures at import.
import '../../core/ui-kit';
import { renderDownloadCard, renderSeasonPackCard } from './render-cards';
import type { DownloadItem } from './data';
import type { DownloadGroup } from './render-helpers';

const HOSTILE = '"><img src=x onerror=alert(1)>';

function renderToDom(html: string): HTMLElement {
    const host = document.createElement('div');
    host.innerHTML = html;
    return host;
}

function hostileItem(overrides: Partial<DownloadItem> = {}): DownloadItem {
    return {
        source: 'Sonarr',
        status: HOSTILE,
        title: HOSTILE,
        subtitle: HOSTILE,
        posterUrl: HOSTILE,
        jellyfinMediaId: HOSTILE,
        timeRemaining: HOSTILE,
        progress: 42,
        ...overrides,
    };
}

describe('renderDownloadCard escaping', () => {
    it('renders hostile poster/title/subtitle/id/status inert (no element injection)', () => {
        const host = renderToDom(renderDownloadCard(hostileItem()));

        // No injected <img src="x"> anywhere — the payload must stay a string.
        expect(host.querySelector('img[src="x"]')).toBeNull();
        // The only onerror is the static display-toggle on the poster img.
        for (const el of host.querySelectorAll('[onerror]')) {
            expect(el.getAttribute('onerror')).toBe("this.style.display='none'");
        }
        // Poster + arr source icon only — nothing extra parsed into existence.
        expect(host.querySelectorAll('img').length).toBe(2);

        // Attribute positions hold the payload as a value, not as markup.
        const card = host.querySelector('.jc-download-card')!;
        expect(card.getAttribute('data-media-id')).toBe(HOSTILE);
        const poster = host.querySelector<HTMLImageElement>('.jc-download-poster')!;
        expect(poster.getAttribute('src')).toBe(HOSTILE);

        // Text positions render the payload as text with no child elements.
        const title = host.querySelector('.jc-download-title')!;
        expect(title.textContent).toBe(HOSTILE);
        expect(title.children.length).toBe(0);
        expect(title.getAttribute('title')).toBe(HOSTILE);
        const subtitle = host.querySelector('.jc-download-subtitle')!;
        expect(subtitle.textContent).toBe(HOSTILE);
        expect(subtitle.children.length).toBe(0);
    });

    it('coerces a non-numeric progress instead of interpolating it into the style attribute', () => {
        const host = renderToDom(renderDownloadCard(hostileItem({
            progress: '"; background:url(javascript:alert(1))' as unknown as number,
        })));
        const bar = host.querySelector<HTMLElement>('.jc-download-progress-bar')!;
        expect(bar.getAttribute('style')).toContain('width: 0%');
        expect(bar.getAttribute('style')).not.toContain('javascript:');
    });
});

describe('renderSeasonPackCard escaping', () => {
    it('renders hostile fields inert in the season-pack variant', () => {
        const group = {
            type: 'seasonPack',
            item: hostileItem({ seasonNumber: 1 }),
            episodes: [hostileItem({ episodeNumber: 1 }), hostileItem({ episodeNumber: 2 }), hostileItem({ episodeNumber: 3 })],
            episodeRange: HOSTILE,
            episodeCount: 3,
        } as Extract<DownloadGroup, { type: 'seasonPack' }>;

        const host = renderToDom(renderSeasonPackCard(group));

        expect(host.querySelector('img[src="x"]')).toBeNull();
        for (const el of host.querySelectorAll('[onerror]')) {
            expect(el.getAttribute('onerror')).toBe("this.style.display='none'");
        }
        const title = host.querySelector('.jc-download-title')!;
        expect(title.textContent).toBe(HOSTILE);
        expect(title.children.length).toBe(0);
        // episodeRange badge stays a text node.
        const badges = host.querySelectorAll('.jc-download-badge');
        const rangeBadge = badges[badges.length - 1];
        expect(rangeBadge.textContent).toBe(HOSTILE);
        expect(rangeBadge.children.length).toBe(0);
    });
});
