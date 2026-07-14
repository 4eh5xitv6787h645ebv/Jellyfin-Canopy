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
});
