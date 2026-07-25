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
import { renderDownloadCard, renderIssueCard, renderRequestCard } from './render-cards';
import { state } from './data';
import type { DownloadItem } from './data';

const HOSTILE = '"><img src=x onerror=alert(1)>';

function renderToDom(html: string): HTMLElement {
    const host = document.createElement('div');
    host.innerHTML = html;
    return host;
}

function hostileItem(overrides: Partial<DownloadItem> = {}): DownloadItem {
    return {
        id: 'activity-1',
        source: 'Sonarr',
        instanceId: 'sonarr-main',
        instanceName: HOSTILE,
        title: HOSTILE,
        subtitle: HOSTILE,
        mediaType: 'episode',
        seasonNumber: 1,
        episodeNumber: 2,
        section: 'downloading',
        lifecycle: 'downloading',
        progress: 42,
        timeRemaining: HOSTILE,
        occurredAt: null,
        stale: false,
        reasonCode: null,
        terminal: false,
        groupCount: 1,
        importedCount: null,
        expectedCount: null,
        partial: false,
        provenance: null,
        jellyfinItemId: HOSTILE,
        availability: 'available',
        ...overrides,
    };
}

describe('renderDownloadCard escaping', () => {
    it('renders allowlisted hostile text and Jellyfin id inert', () => {
        const host = renderToDom(renderDownloadCard(hostileItem()));

        expect(host.querySelector('img[src="x"]')).toBeNull();
        expect(host.querySelectorAll('[onerror]')).toHaveLength(0);
        expect(host.querySelectorAll('img')).toHaveLength(1);
        expect(host.querySelector('.jc-download-source')?.textContent).toContain(HOSTILE);
        expect(host.querySelector('.jc-download-open-btn')?.getAttribute('data-media-id')).toBe(HOSTILE);

        const title = host.querySelector('.jc-download-title')!;
        expect(title.textContent).toBe(HOSTILE);
        expect(title.children.length).toBe(0);
        const subtitle = host.querySelector('.jc-download-subtitle')!;
        expect(subtitle.textContent).toBe(HOSTILE);
        expect(subtitle.children.length).toBe(0);
        expect(host.textContent).toContain(HOSTILE);
    });

    it('omits a non-numeric progress instead of interpolating it into markup', () => {
        const host = renderToDom(renderDownloadCard(hostileItem({
            progress: '"; background:url(javascript:alert(1))' as unknown as number,
        })));
        expect(host.querySelector('.jc-download-progress-bar')).toBeNull();
        expect(host.innerHTML).not.toContain('javascript:');
    });

    it('keeps transfer completion distinct from importing and availability', () => {
        const host = renderToDom(renderDownloadCard(hostileItem({
            lifecycle: 'importing',
            progress: 100,
            availability: 'unknown',
            jellyfinItemId: null,
        })));
        expect(host.querySelector('.jc-download-lifecycle')?.textContent).toBe('Importing');
        expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('100');
        expect(host.textContent).not.toContain('Available');
        expect(host.querySelector('.jc-download-open-btn')).toBeNull();
    });

    it('labels import and library availability independently', () => {
        const imported = renderToDom(renderDownloadCard(hostileItem({
            lifecycle: 'imported',
            section: 'history',
            progress: null,
            availability: 'unavailable',
            jellyfinItemId: null,
        })));
        expect(imported.querySelector('.jc-download-lifecycle')?.textContent).toBe('Imported');
        expect(imported.textContent).toContain('Availability not confirmed');
        expect(imported.querySelector('.jc-download-open-btn')).toBeNull();

        const available = renderToDom(renderDownloadCard(hostileItem({
            lifecycle: 'imported',
            section: 'history',
        })));
        expect(available.textContent).toContain('Available');
        expect(available.querySelector('.jc-download-open-btn')).not.toBeNull();
    });

    it('shows only explicit provenance and never exposes an unknown reason code', () => {
        const absent = renderToDom(renderDownloadCard(hostileItem({
            lifecycle: 'downloading',
            reasonCode: 'future-secret-upstream-detail',
            provenance: null,
        })));
        expect(absent.querySelector('.jc-download-provenance')).toBeNull();
        expect(absent.textContent).toContain('Additional lifecycle details are unavailable.');
        expect(absent.textContent).not.toContain('future-secret-upstream-detail');

        const explicit = renderToDom(renderDownloadCard(hostileItem({
            provenance: 'unknown',
        })));
        expect(explicit.querySelector('.jc-download-provenance')?.textContent).toBe('Origin unknown');
    });

    it('renders server-provided group and partial-import metadata', () => {
        const host = renderToDom(renderDownloadCard(hostileItem({
            lifecycle: 'attention',
            section: 'processing',
            groupCount: 8,
            partial: true,
            importedCount: 3,
            expectedCount: 8,
        })));
        expect(host.textContent).toContain('8 items');
        expect(host.textContent).toContain('3 of 8 imported');
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
