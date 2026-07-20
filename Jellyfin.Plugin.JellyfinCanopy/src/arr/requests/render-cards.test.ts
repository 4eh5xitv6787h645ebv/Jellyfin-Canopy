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
import { renderDownloadCard, renderIssueCard, renderRequestCard, renderSeasonPackCard } from './render-cards';
import { state } from './data';
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
        const progress = host.querySelector('.jc-download-progress')!;
        expect(progress.getAttribute('role')).toBe('progressbar');
        expect(progress.getAttribute('aria-valuemin')).toBe('0');
        expect(progress.getAttribute('aria-valuemax')).toBe('100');
        expect(progress.getAttribute('aria-valuenow')).toBe('42');
    });

    it('coerces a non-numeric progress instead of interpolating it into the style attribute', () => {
        const host = renderToDom(renderDownloadCard(hostileItem({
            progress: '"; background:url(javascript:alert(1))' as unknown as number,
        })));
        const bar = host.querySelector<HTMLElement>('.jc-download-progress-bar')!;
        expect(bar.getAttribute('style')).toContain('width: 0%');
        expect(bar.getAttribute('style')).not.toContain('javascript:');
    });

    it.each([
        { value: -5, expected: '0' },
        { value: 150, expected: '100' },
    ])('bounds progress $value to the ARIA range', ({ value, expected }) => {
        const host = renderToDom(renderDownloadCard(hostileItem({ progress: value })));
        const progress = host.querySelector<HTMLElement>('.jc-download-progress')!;
        const bar = host.querySelector<HTMLElement>('.jc-download-progress-bar')!;
        expect(progress.getAttribute('aria-valuenow')).toBe(expected);
        expect(bar.getAttribute('style')).toContain(`width: ${expected}%`);
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
        expect(host.querySelector('.jc-download-progress')?.getAttribute('aria-valuenow')).toBe('42');
    });
});

describe('renderRequestCard source binding', () => {
    it('only renders approval controls when a source token is present', () => {
        state.canApproveRequests = true;
        const pluginConfig = window.JellyfinCanopy.pluginConfig as Record<string, unknown>;
        pluginConfig.RequestApprovalsEnabled = true;

        const withoutToken = renderToDom(renderRequestCard({
            id: 9,
            requestStatus: 1,
            title: 'Pending movie',
        }));
        expect(withoutToken.querySelector('.jc-request-approve-btn')).toBeNull();

        const token = 'signed.payload"><img src=x onerror=alert(1)>';
        const withToken = renderToDom(renderRequestCard({
            id: 9,
            sourceToken: token,
            requestStatus: 1,
            title: 'Pending movie',
        }));
        const approve = withToken.querySelector<HTMLButtonElement>('.jc-request-approve-btn');
        const decline = withToken.querySelector<HTMLButtonElement>('.jc-request-decline-btn');
        expect(approve?.getAttribute('data-source-token')).toBe(token);
        expect(decline?.getAttribute('data-source-token')).toBe(token);
        expect(withToken.querySelector('img[src="x"]')).toBeNull();
    });
});

describe('renderIssueCard avatar source binding', () => {
    it('refuses a relative issue avatar unless the server decorated it with a source token', () => {
        const withoutToken = renderToDom(renderIssueCard({
            createdBy: { username: 'reporter', avatar: '/avatar/reporter.png' },
        }));
        expect(withoutToken.querySelector('.jc-request-avatar')).toBeNull();

        const withToken = renderToDom(renderIssueCard({
            createdBy: {
                username: 'reporter',
                avatar: '/avatar/reporter.png',
                avatarSourceToken: 'payload.signature',
            },
        }));
        const avatar = withToken.querySelector<HTMLImageElement>('.jc-request-avatar');
        expect(avatar?.getAttribute('data-avatar-src')).toBe(
            '/JellyfinCanopy/proxy/avatar?path=%2Favatar%2Freporter.png&sourceToken=payload.signature',
        );
    });
});
