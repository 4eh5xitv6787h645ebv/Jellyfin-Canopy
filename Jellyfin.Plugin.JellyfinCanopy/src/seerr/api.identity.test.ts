import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';

describe('Seerr API identity-owned caches and issue writes', () => {
    let originalIdentity = JC.identity.capture()!;
    let fetchMock: ReturnType<typeof vi.fn>;
    let pluginMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        vi.resetModules();
        originalIdentity = JC.identity.capture()!;
        fetchMock = vi.fn();
        pluginMock = vi.fn();
        JC.core.api = {
            fetch: fetchMock,
            plugin: pluginMock,
        } as unknown as NonNullable<typeof JC.core.api>;
        JC.pluginConfig = { SeerrEnable4KRequests: true };
        JC.escapeHtml = (value: unknown) => String(value);
        JC.toast = vi.fn();
        const { installSeerrApi } = await import('./api');
        installSeerrApi();
    });

    afterEach(() => {
        JC.identity.transition(
            originalIdentity.serverId,
            originalIdentity.userId,
            'seerr-api-test-restore',
        );
    });

    it('rejects A status and override results while caching B only', async () => {
        let resolveStatusA!: (value: unknown) => void;
        let resolveRulesA!: (value: unknown) => void;
        fetchMock
            // eslint-disable-next-line @typescript-eslint/no-misused-promises -- deferred request fixture
            .mockImplementationOnce(() => new Promise((resolve) => { resolveStatusA = resolve; }))
            // eslint-disable-next-line @typescript-eslint/no-misused-promises -- deferred request fixture
            .mockImplementationOnce(() => new Promise((resolve) => { resolveRulesA = resolve; }))
            .mockResolvedValueOnce({ active: true, userFound: true, canRequest4kMovie: false })
            .mockResolvedValueOnce([{ id: 'rule-b' }]);

        const statusA = JC.seerrAPI!.checkUserStatus();
        const rulesA = JC.seerrAPI!.fetchOverrideRules();
        JC.identity.transition('server-b', 'user-b', 'seerr-api-race');

        const statusB = await JC.seerrAPI!.checkUserStatus();
        const rulesB = await JC.seerrAPI!.fetchOverrideRules();
        expect(statusB.canRequest4kMovie).toBe(false);
        expect(rulesB).toEqual([{ id: 'rule-b' }]);

        resolveStatusA({ active: true, userFound: true, canRequest4kMovie: true });
        resolveRulesA([{ id: 'rule-a' }]);
        await expect(statusA).rejects.toThrow(/stale identity/i);
        await expect(rulesA).rejects.toThrow(/stale identity/i);
        expect(JC.seerrAPI!.canRequest4k('movie')).toBe(false);
        expect(await JC.seerrAPI!.fetchOverrideRules()).toEqual([{ id: 'rule-b' }]);
    });

    it('does not issue an A report POST after its media lookup resolves under B', async () => {
        let resolveLookup!: (value: unknown) => void;
        // eslint-disable-next-line @typescript-eslint/no-misused-promises -- deferred request fixture
        fetchMock.mockImplementationOnce(() => new Promise((resolve) => { resolveLookup = resolve; }));

        const pending = JC.seerrAPI!.reportIssue('42', 'movie', '1', 'bad video');
        JC.identity.transition('server-b', 'user-b', 'seerr-issue-write-race');
        resolveLookup({ mediaInfo: { id: 99 } });

        await expect(pending).rejects.toThrow(/stale identity/i);
        expect(pluginMock).not.toHaveBeenCalled();
    });

    it('posts to the canonical issue route and retires stale issue reads after create', async () => {
        const clearCacheMatching = vi.fn();
        JC.requestManager = { clearCacheMatching } as unknown as NonNullable<typeof JC.requestManager>;
        fetchMock.mockResolvedValue({ mediaInfo: { id: 99 } });
        pluginMock.mockResolvedValue({ id: 71 });

        await expect(JC.seerrAPI!.reportIssue('42', 'movie', '1', 'bad video'))
            .resolves.toEqual({ id: 71 });

        expect(pluginMock).toHaveBeenCalledWith('/seerr/issue', expect.objectContaining({
            method: 'POST',
            skipRetry: true,
            body: expect.objectContaining({ mediaId: 99, issueType: 1, message: 'bad video' }),
        }));
        expect(clearCacheMatching).toHaveBeenCalledWith('seerr:/issue');
        expect(clearCacheMatching).toHaveBeenCalledWith('seerr:/movie/42');
    });

    it('rejects a malformed create response without publishing it as success', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        fetchMock.mockResolvedValue({ mediaInfo: { id: 99 } });
        pluginMock.mockResolvedValue({});

        await expect(JC.seerrAPI!.reportIssue('42', 'movie', '1', 'bad video'))
            .rejects.toThrow(/invalid issue create response/i);
    });
});
