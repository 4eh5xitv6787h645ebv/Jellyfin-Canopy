import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import { internal } from './internal';

describe('More Info TV actions for Specials-only follow-up requests', () => {
    let actionMount: HTMLElement;
    let resolveUnrequestedSeasons: ReturnType<typeof vi.fn>;
    let buildTvRequestMoreButton: ReturnType<typeof vi.fn>;
    let buildTvActions: ReturnType<typeof vi.fn>;

    beforeAll(async () => {
        JC.t = (key: string) => key;
        JC.escapeHtml = (value: unknown) => String(value);
        JC.pluginConfig = {};
        const { installSeerrStatus } = await import('../seerr-status');
        installSeerrStatus();
        await import('./actions');
    });

    beforeEach(() => {
        vi.useFakeTimers();
        document.body.replaceChildren();
        const identity = JC.identity.transition(
            'specials-actions-server',
            `specials-actions-user-${Math.random()}`,
            'test setup',
        );
        const modal = Object.assign(document.createElement('div'), {
            _actionCleanups: new Set<() => void>(),
        });
        modal.innerHTML = `
            <div data-mount="jc-actions"></div>
            <div data-mount="jc-status-chip"></div>
            <div data-mount="jc-downloads"></div>`;
        JC.identity.own(modal, identity);
        document.body.appendChild(modal);
        internal.state.identity = identity;
        internal.state.currentModal = modal;
        actionMount = modal.querySelector('[data-mount="jc-actions"]')!;

        resolveUnrequestedSeasons = vi.fn();
        buildTvRequestMoreButton = vi.fn(() => {
            const button = document.createElement('button');
            button.className = 'request-more-fixture';
            return button;
        });
        buildTvActions = vi.fn(() => {
            const button = document.createElement('button');
            button.className = 'whole-show-fixture';
            return button;
        });
        internal.resolveUnrequestedSeasons = resolveUnrequestedSeasons;
        internal.buildTvRequestMoreButton = buildTvRequestMoreButton;
        internal.buildTvActions = buildTvActions;
        internal.buildSingleTv4kButton = vi.fn(() => null);
        internal.buildStatusChip = vi.fn(() => null);
        internal.buildDownloadBars = vi.fn(() => null);
        JC.seerrAPI = {
            canRequest4k: () => false,
        } as unknown as NonNullable<typeof JC.seerrAPI>;
        JC.seerrUI = {};
    });

    afterEach(() => {
        const modal = internal.state.currentModal as (HTMLElement & {
            _actionCleanups?: Set<() => void>;
        }) | null;
        for (const cleanup of modal?._actionCleanups || []) cleanup();
        internal.state.currentModal = null;
        internal.state.identity = null;
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    const specialsOnlyData = {
        id: 674,
        name: 'Specials fixture',
        seasons: [{ seasonNumber: 0, episodeCount: 3 }],
        mediaInfo: { status: 5, status4k: 1 },
    };

    async function renderAndSettle(data: unknown = specialsOnlyData): Promise<void> {
        internal.renderActions(data, 'tv');
        await Promise.resolve();
        await Promise.resolve();
    }

    it('renders Request More when enabled Specials are the only unrequested season', async () => {
        resolveUnrequestedSeasons.mockResolvedValue({
            hasUnrequestedSeasons: true,
            definitive: true,
        });

        await renderAndSettle();

        expect(resolveUnrequestedSeasons).toHaveBeenCalledWith(specialsOnlyData);
        expect(buildTvRequestMoreButton).toHaveBeenCalledOnce();
        expect(actionMount.querySelector('.request-more-fixture')).not.toBeNull();
        expect(buildTvActions).not.toHaveBeenCalled();
    });

    it('does not publish a normal request when Specials are disabled', async () => {
        resolveUnrequestedSeasons.mockResolvedValue({
            hasUnrequestedSeasons: false,
            definitive: true,
        });

        await renderAndSettle();

        expect(resolveUnrequestedSeasons).toHaveBeenCalledOnce();
        expect(actionMount.children).toHaveLength(0);
        expect(buildTvRequestMoreButton).not.toHaveBeenCalled();
        expect(buildTvActions).not.toHaveBeenCalled();
    });

    it('routes deleted parent status through the capability resolver', async () => {
        resolveUnrequestedSeasons.mockResolvedValue({
            hasUnrequestedSeasons: false,
            definitive: true,
        });

        await renderAndSettle({
            ...specialsOnlyData,
            mediaInfo: { status: 7, status4k: 1 },
        });

        expect(resolveUnrequestedSeasons).toHaveBeenCalledOnce();
        expect(buildTvRequestMoreButton).not.toHaveBeenCalled();
        expect(actionMount.children).toHaveLength(0);
    });

    it('retries an indeterminate capability and renders only after it becomes definitive', async () => {
        resolveUnrequestedSeasons
            .mockResolvedValueOnce({ hasUnrequestedSeasons: false, definitive: false })
            .mockResolvedValueOnce({ hasUnrequestedSeasons: true, definitive: true });

        await renderAndSettle();
        expect(actionMount.children).toHaveLength(0);
        expect(resolveUnrequestedSeasons).toHaveBeenCalledOnce();

        await vi.advanceTimersByTimeAsync(1_999);
        expect(resolveUnrequestedSeasons).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(1);

        expect(resolveUnrequestedSeasons).toHaveBeenCalledTimes(2);
        expect(actionMount.querySelector('.request-more-fixture')).not.toBeNull();
        expect(internal.state.currentModal?._actionCleanups?.size).toBe(0);
    });

    it('cancels a pending retry when the modal action lifecycle is cleaned up', async () => {
        resolveUnrequestedSeasons.mockResolvedValue({
            hasUnrequestedSeasons: false,
            definitive: false,
        });

        await renderAndSettle();
        const cleanups = internal.state.currentModal?._actionCleanups;
        expect(cleanups?.size).toBe(1);
        for (const cleanup of cleanups || []) cleanup();
        cleanups?.clear();

        await vi.advanceTimersByTimeAsync(20_000);
        expect(resolveUnrequestedSeasons).toHaveBeenCalledOnce();
        expect(actionMount.children).toHaveLength(0);
    });

    it('discards an older resolver result after the same modal mount is refreshed', async () => {
        let resolveOlder!: (value: unknown) => void;
        let resolveNewer!: (value: unknown) => void;
        const older = new Promise((resolve) => { resolveOlder = resolve; });
        const newer = new Promise((resolve) => { resolveNewer = resolve; });
        resolveUnrequestedSeasons
            .mockReturnValueOnce(older)
            .mockReturnValueOnce(newer);

        internal.renderActions(specialsOnlyData, 'tv');
        internal.renderActions({ ...specialsOnlyData, name: 'Refreshed fixture' }, 'tv');
        expect(resolveUnrequestedSeasons).toHaveBeenCalledTimes(2);

        resolveNewer({ hasUnrequestedSeasons: false, definitive: true });
        await Promise.resolve();
        await Promise.resolve();
        expect(actionMount.children).toHaveLength(0);

        resolveOlder({ hasUnrequestedSeasons: true, definitive: true });
        await Promise.resolve();
        await Promise.resolve();

        expect(buildTvRequestMoreButton).not.toHaveBeenCalled();
        expect(actionMount.children).toHaveLength(0);
    });
});
