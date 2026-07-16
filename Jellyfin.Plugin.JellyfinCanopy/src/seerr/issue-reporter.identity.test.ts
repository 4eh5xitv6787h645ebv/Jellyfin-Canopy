import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';

describe('Seerr issue reporter identity fencing', () => {
    let originalIdentity = JC.identity.capture()!;

    beforeEach(async () => {
        vi.resetModules();
        originalIdentity = JC.identity.capture()!;
        JC.pluginConfig = { SeerrShowIssueIndicator: true };
        JC.t = (key: string) => key;
        JC.escapeHtml = (value: unknown) => String(value);
        JC.toast = vi.fn();
        await import('./issue-reporter');
    });

    afterEach(() => {
        JC.identity.transition(
            originalIdentity.serverId,
            originalIdentity.userId,
            'issue-reporter-test-restore',
        );
        document.body.innerHTML = '';
    });

    it('removes A button synchronously and ignores its late issue indicator', async () => {
        let resolveIssues!: (value: unknown) => void;
        JC.seerrAPI = {
            fetchIssuesForMedia: vi.fn(() => new Promise((resolve) => { resolveIssues = resolve; })),
        } as unknown as NonNullable<typeof JC.seerrAPI>;
        const button = document.createElement('button');
        document.body.appendChild(button);

        const pending = JC.seerrIssueReporter!.applyIssueIndicator(button, '42', 'movie');
        JC.identity.transition('server-b', 'user-b', 'issue-indicator-race');
        expect(button.isConnected).toBe(false);

        resolveIssues({ results: [{ id: 1 }] });
        await pending;
        expect(button.querySelector('.seerr-issue-count-badge')).toBeNull();
        expect(button.classList.contains('has-open-issues')).toBe(false);
    });

    it('routes a handled prefetch failure through the indicator error path, never as zero issues', async () => {
        const button = document.createElement('button');
        document.body.appendChild(button);
        const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
        const failure = new Error('title issue projection unavailable');

        await expect(JC.seerrIssueReporter!.applyIssueIndicator(
            button,
            '42',
            'movie',
            Promise.resolve({ state: 'failed', error: failure }),
        )).resolves.toBeUndefined();

        expect(debug).toHaveBeenCalledWith(
            expect.stringContaining('applyIssueIndicator failed'),
            failure,
        );
        expect(button.querySelector('.seerr-issue-count-badge')).toBeNull();
        expect(button.classList.contains('has-open-issues')).toBe(false);
    });

    it('uses the exact title total for the badge even when only one row is fetched', async () => {
        JC.seerrAPI = {
            fetchIssuesForMedia: vi.fn().mockResolvedValue({
                pageInfo: { pages: 51, pageSize: 1, results: 51, page: 1 },
                results: [{ id: 51 }],
            }),
        } as unknown as NonNullable<typeof JC.seerrAPI>;
        const button = document.createElement('button');
        document.body.appendChild(button);

        await JC.seerrIssueReporter!.applyIssueIndicator(button, '42', 'movie');

        expect(button.querySelector('.seerr-issue-count-badge')?.textContent).toBe('9+');
        expect(button.title).toContain('51 ');
        expect(button.getAttribute('aria-label')).toContain('51 ');
    });

    it('bounds detail enrichment concurrency while preserving more than fifty title issues', async () => {
        const { enrichIssuesForDisplay } = await import('./issue-reporter');
        const issues = Array.from({ length: 75 }, (_, index) => ({ id: index + 1 }));
        let active = 0;
        let peak = 0;
        let calls = 0;

        const enriched = await enrichIssuesForDisplay(issues, issueId => {
            calls++;
            active++;
            peak = Math.max(peak, active);
            return new Promise(resolve => queueMicrotask(() => {
                active--;
                resolve({ id: issueId, comments: [`comment-${issueId}`] });
            }));
        });

        expect(calls).toBe(75);
        expect(peak).toBe(6);
        expect(enriched).toHaveLength(75);
        expect(enriched.map(issue => issue.id)).toEqual(issues.map(issue => issue.id));
        expect(enriched[74].comments).toEqual(['comment-75']);
    });

    it('retires queued issue enrichment when the captured identity changes', async () => {
        const { enrichIssuesForDisplay } = await import('./issue-reporter');
        const context = JC.identity.capture()!;
        const issues = Array.from({ length: 75 }, (_, index) => ({ id: index + 1 }));
        const pendingResolvers: Array<() => void> = [];
        const fetchedIds: number[] = [];

        const pending = enrichIssuesForDisplay(
            issues,
            issueId => {
                fetchedIds.push(issueId);
                return new Promise(resolve => pendingResolvers.push(() => resolve({ id: issueId })));
            },
            () => JC.identity.isCurrent(context),
        );

        expect(fetchedIds).toEqual([1, 2, 3, 4, 5, 6]);
        JC.identity.transition('server-b', 'user-b', 'issue-enrichment-retired');
        pendingResolvers.forEach(resolve => resolve());
        await pending;

        expect(fetchedIds).toEqual([1, 2, 3, 4, 5, 6]);
    });
});
