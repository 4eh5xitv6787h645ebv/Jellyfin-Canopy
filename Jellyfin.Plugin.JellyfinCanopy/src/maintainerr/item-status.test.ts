import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeatureScope } from '../core/feature-loader';
import type { DetailsIntegrationContext } from '../enhanced/features/details-page';
import type { ApiApi, IdentityContext } from '../types/jc';
import { JC } from '../globals';
import { registerDetailsIntegration } from '../enhanced/features/details-page';
import {
    createMaintainerrItemStatusIntegration,
    parseMaintainerrItemStatus,
} from './item-status';
import { MAINTAINERR_ITEM_STATUS_CSS } from './item-status-styles';

function scope(controller = new AbortController()): FeatureScope {
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

function target(
    itemId: string,
    current: () => boolean = () => true,
): DetailsIntegrationContext {
    const page = document.createElement('div');
    const metadataContainer = document.createElement('div');
    metadataContainer.className = 'itemMiscInfo-primary';
    page.appendChild(metadataContainer);
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

describe('Maintainerr item-status integration', () => {
    beforeEach(() => {
        document.body.replaceChildren();
        JC.identity.transition('maintainerr-item-server', `user-${Math.random()}`, 'maintainerr-item-test');
        JC.pluginConfig = {
            MaintainerrEnabled: true,
            MaintainerrItemStatusEnabled: true,
        };
        JC.t = (key: string) => key;
    });

    it('accepts the shared 256-character label ceiling and rejects max plus one', () => {
        const payload = {
            protectedFromCleanup: true,
            manuallyManaged: false,
            excludedFrom: [{ label: 'x'.repeat(256) }],
            manuallyAddedTo: [],
        };

        expect(parseMaintainerrItemStatus(payload, true)).not.toBeNull();
        expect(parseMaintainerrItemStatus({
            ...payload,
            excludedFrom: [{ label: 'x'.repeat(257) }],
        }, true)).toBeNull();
    });

    it('reserves stable loading geometry, then restores final DOM after a host wipe without refetching', async () => {
        JC.currentUser = { Policy: { IsAdministrator: true } };
        const plugin = vi.fn().mockResolvedValue({
            protectedFromCleanup: true,
            manuallyManaged: false,
            excludedFrom: [{ label: '<img onerror=alert(1)>', href: '/collections/1/exclusions' }],
            manuallyAddedTo: [],
        });
        JC.core.api = { plugin } as unknown as ApiApi;
        const integration = createMaintainerrItemStatusIntegration(scope());
        const context = target('item-a');

        integration.render(context);
        const reservation = context.page.querySelector<HTMLElement>(
            '.jc-maintainerr-item-status-slot',
        );
        expect(reservation).not.toBeNull();
        expect(reservation?.getAttribute('aria-busy')).toBe('true');
        expect(reservation?.textContent).toBe('');
        expect(context.page.querySelector('.jc-maintainerr-item-status')).toBeNull();
        await vi.waitFor(() => {
            expect(context.page.querySelector('.jc-maintainerr-item-status')?.textContent)
                .toContain('Protected from cleanup');
        });
        expect(context.page.querySelector('.jc-maintainerr-item-status-slot')).toBe(reservation);
        expect(reservation?.getAttribute('aria-busy')).toBe('false');
        expect(reservation?.querySelector('details:not([open])')).not.toBeNull();
        expect(MAINTAINERR_ITEM_STATUS_CSS).toMatch(
            /\.jc-maintainerr-item-status-slot\s*\{[\s\S]*?block-size:\s*2\.25rem;/,
        );
        expect(MAINTAINERR_ITEM_STATUS_CSS).toMatch(
            /\.jc-maintainerr-item-status-slot\s*\{[\s\S]*?flex:\s*1 1 100%;/,
        );
        expect(MAINTAINERR_ITEM_STATUS_CSS).toMatch(
            /\.jc-maintainerr-item-status-slot\s*\{[\s\S]*?min-inline-size:\s*0;/,
        );
        expect(MAINTAINERR_ITEM_STATUS_CSS).toMatch(
            /\.jc-maintainerr-item-status-slot\s*\{[\s\S]*?overflow:\s*auto hidden;/,
        );
        expect(context.page.querySelectorAll('img')).toHaveLength(0);
        expect(context.page.textContent).toContain('<img onerror=alert(1)>');
        expect(plugin).toHaveBeenCalledWith(
            '/maintainerr/item-status/item-a',
            expect.objectContaining({
                skipCache: true,
                skipRetry: true,
                timeoutMs: 10_000,
            }),
        );

        context.metadataContainer.replaceChildren();
        context.page.querySelector('.jc-maintainerr-item-status-details')?.remove();
        integration.render(context);
        expect(plugin).toHaveBeenCalledTimes(1);
        expect(context.page.querySelector('.jc-maintainerr-item-status')?.textContent)
            .toContain('Protected from cleanup');
    });

    it('aborts the outgoing item request and never publishes its stale response', async () => {
        JC.currentUser = { Policy: { IsAdministrator: false } };
        let resolveA!: (value: unknown) => void;
        let resolveB!: (value: unknown) => void;
        const promiseA = new Promise<unknown>((resolve) => { resolveA = resolve; });
        const promiseB = new Promise<unknown>((resolve) => { resolveB = resolve; });
        const plugin = vi.fn((
            path: string,
            _options?: { signal?: AbortSignal },
        ) => path.endsWith('item-a') ? promiseA : promiseB);
        JC.core.api = { plugin } as unknown as ApiApi;
        const integration = createMaintainerrItemStatusIntegration(scope());
        let visibleItem = 'item-a';
        const contextA = target('item-a', () => visibleItem === 'item-a');
        const contextB = target('item-b', () => visibleItem === 'item-b');

        integration.render(contextA);
        const signalA = plugin.mock.calls[0][1]?.signal as AbortSignal;
        visibleItem = 'item-b';
        integration.render(contextB);
        expect(signalA.aborted).toBe(true);

        resolveA({ protectedFromCleanup: true, manuallyManaged: false });
        resolveB({ protectedFromCleanup: false, manuallyManaged: true });
        await vi.waitFor(() => {
            expect(contextB.page.querySelector('.jc-maintainerr-item-status')?.textContent)
                .toContain('Manually managed');
        });
        expect(contextA.page.querySelector('.jc-maintainerr-item-status')).toBeNull();
    });

    it.each(['identity', 'configuration'] as const)(
        'activation-owned %s teardown aborts in-flight work and blocks late publication',
        async (reason) => {
            JC.currentUser = { Policy: { IsAdministrator: false } };
            const activation = new AbortController();
            let resolve!: (value: unknown) => void;
            const pending = new Promise<unknown>((done) => { resolve = done; });
            const plugin = vi.fn((
                _path: string,
                _options?: { signal?: AbortSignal },
            ) => pending);
            JC.core.api = { plugin } as unknown as ApiApi;
            const integration = createMaintainerrItemStatusIntegration(scope(activation));
            const unregister = registerDetailsIntegration(
                `maintainerr-item-status-${reason}-${Math.random()}`,
                integration,
            );
            const context = target(`item-${reason}`);

            integration.render(context);
            const signal = plugin.mock.calls[0][1]?.signal as AbortSignal;
            expect(signal.aborted).toBe(false);

            if (reason === 'identity') {
                JC.identity.transition(
                    'maintainerr-item-server',
                    `replacement-${Math.random()}`,
                    'identity-change',
                );
            } else {
                JC.pluginConfig = {
                    MaintainerrEnabled: false,
                    MaintainerrItemStatusEnabled: false,
                };
            }
            activation.abort();
            unregister();

            expect(signal.aborted).toBe(true);
            resolve({ protectedFromCleanup: true, manuallyManaged: false });
            await pending;
            await Promise.resolve();
            expect(context.page.querySelector('.jc-maintainerr-item-status')).toBeNull();
            expect(plugin).toHaveBeenCalledTimes(1);
        },
    );

    it('distinguishes genuine false/false from an unavailable regular-user response', async () => {
        JC.currentUser = { Policy: { IsAdministrator: false } };
        const plugin = vi.fn()
            .mockResolvedValueOnce({ protectedFromCleanup: false, manuallyManaged: false })
            .mockRejectedValueOnce(new Error('private upstream detail'));
        JC.core.api = { plugin } as unknown as ApiApi;
        const integration = createMaintainerrItemStatusIntegration(scope());
        const empty = target('item-empty');
        integration.render(empty);
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(1));
        await Promise.resolve();
        expect(empty.page.querySelector('.jc-maintainerr-item-status')).toBeNull();

        const unavailable = target('item-error');
        integration.render(unavailable);
        await vi.waitFor(() => {
            expect(unavailable.page.querySelector('.jc-maintainerr-item-status')?.textContent)
                .toContain('Maintainerr status unavailable');
        });
        expect(unavailable.page.textContent).not.toContain('private upstream detail');
    });

    it.each([
        ['identity_mismatch', 'identity does not match'],
        ['unknown_private_failure', 'Maintainerr status unavailable'],
    ])('renders a safe admin message for %s without exposing hostile details', async (code, expected) => {
        JC.currentUser = { Policy: { IsAdministrator: true } };
        const failure = Object.assign(new Error('raw exception from http://private-maintainerr.internal'), {
            responseJSON: {
                error: code,
                message: 'token=secret&target=http://private-maintainerr.internal/api',
            },
        });
        const plugin = vi.fn().mockRejectedValue(failure);
        JC.core.api = { plugin } as unknown as ApiApi;
        const integration = createMaintainerrItemStatusIntegration(scope());
        const context = target(`item-${code}`);

        integration.render(context);
        await vi.waitFor(() => {
            expect(context.page.querySelector('.jc-maintainerr-item-status')?.textContent)
                .toContain(expected);
        });
        expect(context.page.textContent).not.toContain(code);
        expect(context.page.textContent).not.toContain('raw exception');
        expect(context.page.textContent).not.toContain('private-maintainerr');
        expect(context.page.textContent).not.toContain('token=secret');
    });
});
