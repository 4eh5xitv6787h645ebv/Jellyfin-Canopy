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

function context(
    itemId: string,
    current: () => boolean = () => true,
    identity: IdentityContext = JC.identity.capture() as IdentityContext,
): DetailsIntegrationContext {
    const page = document.createElement('div');
    const secondary = document.createElement('div');
    secondary.className = 'detailPageSecondaryContainer';
    const metadataContainer = document.createElement('div');
    metadataContainer.className = 'itemMiscInfo-primary';
    const actions = document.createElement('div');
    actions.className = 'detailButtons';
    page.append(metadataContainer, actions, secondary);
    document.body.appendChild(page);
    return {
        identity,
        itemId,
        itemType: 'Movie',
        page,
        metadataContainer,
        isCurrent: current,
    };
}

describe('awards details integration', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
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
        const expandIn = vi.spyOn(JC.core.ui!, 'expandIn');

        integration.render(target);
        await vi.waitFor(() => expect(target.page.querySelector('.jc-awards-trigger')).not.toBeNull());
        const trigger = target.page.querySelector<HTMLButtonElement>('.jc-awards-trigger');
        expect(trigger?.classList).toContain('MuiIconButton-root');
        expect(trigger?.parentElement?.classList).toContain('detailButtons');
        expect(expandIn).toHaveBeenCalledWith(trigger);
        expect(target.page.querySelector('.jc-awards-section')).toBeNull();
        trigger?.click();
        const section = document.querySelector('.jc-awards-section');
        expect(document.querySelector('.jc-awards-overlay')?.getAttribute('role')).toBe('dialog');
        expect(document.querySelector('.jc-awards-overlay')?.getAttribute('aria-modal')).toBe('true');
        expect(document.querySelector('.jc-awards-overlay')?.getAttribute('aria-labelledby')).toBe('jc-awards-heading-item-a');
        expect(section?.classList).toContain('verticalSection');
        expect(section?.textContent).toContain('<img onerror=alert(1)>');
        expect(section?.querySelector('img')).toBeNull();
        expect(section?.querySelector('a')?.rel).toBe('noopener noreferrer');
        expect(plugin).toHaveBeenCalledWith('/awards/item-a', expect.objectContaining({
            skipCache: true,
            skipRetry: true,
            timeoutMs: 8_000,
        }));

        trigger?.remove();
        integration.render(target);
        expect(target.page.querySelector('.jc-awards-trigger')).not.toBeNull();
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
        expect(target.page.querySelector('.jc-awards-trigger')).toBeNull();
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

        await vi.waitFor(() => expect(targetB.page.querySelector('.jc-awards-trigger')).not.toBeNull());
        targetB.page.querySelector<HTMLButtonElement>('.jc-awards-trigger')?.click();
        expect(document.querySelector('.jc-awards-dialog')?.textContent).toContain('Current');
        expect(targetA.page.querySelector('.jc-awards-trigger')).toBeNull();
    });

    it('isolates no-reload account transitions, stale results, and teardown', async () => {
        const deferred = new Map<string, {
            promise: Promise<unknown>;
            resolve: (value: unknown) => void;
        }>();
        const responseFor = (userId: string) => {
            let resolve!: (value: unknown) => void;
            const promise = new Promise<unknown>((accept) => { resolve = accept; });
            deferred.set(userId, { promise, resolve });
            return promise;
        };
        let activeUser = 'account-a';
        const identities = new Map<string, IdentityContext>();
        for (const userId of ['account-a', 'account-b', 'account-c', 'account-d']) {
            JC.identity.transition('awards-server', userId, 'awards-account-test');
            identities.set(userId, JC.identity.capture() as IdentityContext);
        }
        const identityFor = (userId: string): IdentityContext => {
            const identity = identities.get(userId);
            if (!identity) throw new Error(`Missing test identity ${userId}`);
            return identity;
        };
        const plugin = vi.fn((
            _path: string,
            _options?: { signal?: AbortSignal },
        ) => responseFor(activeUser));
        JC.core.api = { plugin } as unknown as ApiApi;
        const integration = createAwardsIntegration(featureScope());

        activeUser = 'account-a';
        const accountA = context(
            'shared-item',
            () => activeUser === 'account-a',
            identityFor('account-a'),
        );
        integration.render(accountA);
        deferred.get('account-a')?.resolve({
            wins: [{ name: 'Account A Award', year: 2021 }],
            nominations: [],
        });
        await vi.waitFor(() => expect(accountA.page.querySelector('.jc-awards-trigger')).not.toBeNull());
        accountA.page.querySelector<HTMLButtonElement>('.jc-awards-trigger')?.click();
        expect(document.body.textContent).toContain('Account A Award');

        activeUser = 'account-b';
        const accountB = context(
            'shared-item',
            () => activeUser === 'account-b',
            identityFor('account-b'),
        );
        integration.render(accountB);
        expect(document.body.textContent).not.toContain('Account A Award');
        const accountBSignal = plugin.mock.calls[1][1]?.signal as AbortSignal;

        activeUser = 'account-c';
        const accountC = context(
            'shared-item',
            () => activeUser === 'account-c',
            identityFor('account-c'),
        );
        integration.render(accountC);
        expect(accountBSignal.aborted).toBe(true);
        deferred.get('account-b')?.resolve({
            wins: [{ name: 'Stale Account B Award', year: 2022 }],
            nominations: [],
        });
        deferred.get('account-c')?.resolve({
            wins: [{ name: 'Account C Award', year: 2024 }],
            nominations: [],
        });
        await vi.waitFor(() => expect(accountC.page.querySelector('.jc-awards-trigger')).not.toBeNull());
        accountC.page.querySelector<HTMLButtonElement>('.jc-awards-trigger')?.click();
        expect(document.body.textContent).toContain('Account C Award');
        expect(document.body.textContent).not.toContain('Stale Account B Award');
        expect(plugin).toHaveBeenCalledTimes(3);

        activeUser = 'account-d';
        const accountD = context(
            'shared-item',
            () => activeUser === 'account-d',
            identityFor('account-d'),
        );
        integration.render(accountD);
        const accountDSignal = plugin.mock.calls[3][1]?.signal as AbortSignal;
        integration.reset();
        expect(accountDSignal.aborted).toBe(true);
        expect(document.querySelector('.jc-awards-trigger')).toBeNull();
        expect(document.querySelector('.jc-awards-overlay')).toBeNull();
        deferred.get('account-d')?.resolve({
            wins: [{ name: 'Post-teardown Award', year: 2025 }],
            nominations: [],
        });
        await Promise.resolve();
        expect(document.body.textContent).not.toContain('Post-teardown Award');
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
        expect(target.page.querySelector('.jc-awards-trigger')).toBeNull();

        const second = createAwardsIntegration(featureScope());
        second.render(context('cancel'));
        await Promise.resolve();
        second.reset();
        await vi.runAllTimersAsync();
        expect(plugin).toHaveBeenCalledTimes(4);
    });
});
