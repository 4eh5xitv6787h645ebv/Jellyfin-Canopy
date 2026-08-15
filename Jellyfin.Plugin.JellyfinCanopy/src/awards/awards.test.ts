import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeatureScope } from '../core/feature-loader';
import type { DetailsIntegrationContext } from '../enhanced/features/details-page';
import type { ApiApi, IdentityContext } from '../types/jc';
import { JC } from '../globals';
import { createAwardsIntegration, parseAwardsResponse } from './awards';

function featureScope(controller = new AbortController()): FeatureScope {
    return {
        serverId: 'server',
        userId: 'user',
        identityEpoch: 1,
        configGeneration: 1,
        navigationGeneration: 1,
        routeKey: '/web/#/details?id=item',
        signal: controller.signal,
        isCurrent: () => !controller.signal.aborted,
        track: (resource) => resource,
    };
}

function context(itemId: string, current: () => boolean = () => true): DetailsIntegrationContext {
    const page = document.createElement('div');
    const secondary = document.createElement('div');
    secondary.className = 'detailPageSecondaryContainer';
    const metadataContainer = document.createElement('div');
    metadataContainer.className = 'itemMiscInfo-primary';
    page.append(metadataContainer, secondary);
    document.body.appendChild(page);
    return {
        identity: JC.identity.capture() as IdentityContext,
        itemId,
        itemType: 'Movie',
        page,
        metadataContainer,
        isCurrent: current,
    };
}

describe('awards details integration', () => {
    beforeEach(() => {
        vi.useRealTimers();
        document.body.replaceChildren();
        JC.identity.transition('awards-server', `user-${Math.random()}`, 'awards-test');
        JC.pluginConfig = { AwardsEnabled: true };
        JC.t = (key: string) => key;
    });

    it('strictly validates the minimal response envelope and bounds', () => {
        expect(parseAwardsResponse({
            wins: [{ name: 'Best Picture', year: 2024 }],
            nominations: [{ name: 'Audience Award', year: null }],
        })).not.toBeNull();
        expect(parseAwardsResponse({ wins: [], nominations: [], cachePath: '/secret' })).toBeNull();
        expect(parseAwardsResponse({ wins: [{ name: 'x', year: 1500 }], nominations: [] })).toBeNull();
        expect(parseAwardsResponse({ wins: Array.from({ length: 251 }, () => ({ name: 'x', year: null })), nominations: [] })).toBeNull();
    });

    it('renders safe accessible text and restores it after a host wipe without refetching', async () => {
        const plugin = vi.fn().mockResolvedValue({
            wins: [{ name: '<img onerror=alert(1)>', year: 2024 }],
            nominations: [{ name: 'Best Series', year: null }],
        });
        JC.core.api = { plugin } as unknown as ApiApi;
        const integration = createAwardsIntegration(featureScope());
        const target = context('item-a');

        integration.render(target);
        await vi.waitFor(() => expect(target.page.querySelector('.jc-awards-section')).not.toBeNull());
        const section = target.page.querySelector('.jc-awards-section');
        expect(section?.getAttribute('aria-labelledby')).toBe('jc-awards-heading-item-a');
        expect(section?.textContent).toContain('<img onerror=alert(1)>');
        expect(section?.querySelector('img')).toBeNull();
        expect(section?.querySelector('a')?.rel).toBe('noopener noreferrer');
        expect(plugin).toHaveBeenCalledWith('/awards/item-a', expect.objectContaining({
            skipCache: true,
            skipRetry: true,
            timeoutMs: 8_000,
        }));

        section?.remove();
        integration.render(target);
        expect(target.page.querySelector('.jc-awards-section')).not.toBeNull();
        expect(plugin).toHaveBeenCalledTimes(1);
    });

    it('renders no empty or unavailable surface', async () => {
        const plugin = vi.fn().mockResolvedValue({ wins: [], nominations: [] });
        JC.core.api = { plugin } as unknown as ApiApi;
        const integration = createAwardsIntegration(featureScope());
        const target = context('empty');

        integration.render(target);
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(1));
        await Promise.resolve();
        expect(target.page.querySelector('.jc-awards-section')).toBeNull();
    });

    it('does not retry a non-transient invalid response', async () => {
        vi.useFakeTimers();
        const plugin = vi.fn().mockResolvedValue({ wins: [], nominations: [], path: '/private' });
        JC.core.api = { plugin } as unknown as ApiApi;
        const integration = createAwardsIntegration(featureScope());
        integration.render(context('invalid'));
        await Promise.resolve();
        await vi.runAllTimersAsync();
        expect(plugin).toHaveBeenCalledTimes(1);
        expect(document.body.textContent).not.toContain('/private');
    });

    it('aborts outgoing navigation and fences a stale late response', async () => {
        let resolveA!: (value: unknown) => void;
        let resolveB!: (value: unknown) => void;
        const a = new Promise<unknown>((resolve) => { resolveA = resolve; });
        const b = new Promise<unknown>((resolve) => { resolveB = resolve; });
        const plugin = vi.fn((
            path: string,
            _options?: { signal?: AbortSignal },
        ) => path.endsWith('item-a') ? a : b);
        JC.core.api = { plugin } as unknown as ApiApi;
        const integration = createAwardsIntegration(featureScope());
        let visible = 'item-a';
        const targetA = context('item-a', () => visible === 'item-a');
        const targetB = context('item-b', () => visible === 'item-b');

        integration.render(targetA);
        const signalA = plugin.mock.calls[0][1]?.signal as AbortSignal;
        visible = 'item-b';
        integration.render(targetB);
        expect(signalA.aborted).toBe(true);
        resolveA({ wins: [{ name: 'Stale', year: 2020 }], nominations: [] });
        resolveB({ wins: [{ name: 'Current', year: 2024 }], nominations: [] });

        await vi.waitFor(() => expect(targetB.page.textContent).toContain('Current'));
        expect(targetA.page.querySelector('.jc-awards-section')).toBeNull();
    });

    it('retries transient failures only within the fixed budget and cancels retry on teardown', async () => {
        vi.useFakeTimers();
        const plugin = vi.fn().mockRejectedValue(Object.assign(new Error('busy'), { status: 503 }));
        JC.core.api = { plugin } as unknown as ApiApi;
        const integration = createAwardsIntegration(featureScope());
        const target = context('retry');
        integration.render(target);
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(750);
        await vi.advanceTimersByTimeAsync(1500);
        expect(plugin).toHaveBeenCalledTimes(3);
        expect(target.page.querySelector('.jc-awards-section')).toBeNull();

        const second = createAwardsIntegration(featureScope());
        second.render(context('cancel'));
        await Promise.resolve();
        second.reset();
        await vi.runAllTimersAsync();
        expect(plugin).toHaveBeenCalledTimes(4);
    });
});
