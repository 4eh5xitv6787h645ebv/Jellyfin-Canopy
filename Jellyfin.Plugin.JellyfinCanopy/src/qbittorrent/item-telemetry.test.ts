import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeatureScope } from '../core/feature-loader';
import type { DetailsIntegrationContext } from '../enhanced/features/details-page';
import type { ApiApi, IdentityContext } from '../types/jc';
import { JC } from '../globals';
import {
    createQbittorrentTelemetryIntegration,
    parseQbittorrentTelemetry,
} from './item-telemetry';
import { QBITTORRENT_TELEMETRY_CSS } from './item-telemetry-styles';

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

function target(itemId: string, current: () => boolean = () => true): DetailsIntegrationContext {
    const page = document.createElement('div');
    const metadataContainer = document.createElement('div');
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

const payload = {
    state: 'seeding',
    progressPercent: 100,
    ratio: 2.25,
    trackerIdentity: '…example.net',
    addedAt: '2026-08-15T00:00:00Z',
    completedAt: '2026-08-15T00:10:00Z',
    lastActivityAt: '2026-08-15T00:20:00Z',
};

describe('qBittorrent item telemetry', () => {
    beforeEach(() => {
        document.body.replaceChildren();
        JC.identity.transition('qbittorrent-server', `user-${Math.random()}`, 'qbittorrent-test');
        JC.currentUser = { Policy: { IsAdministrator: true } };
        JC.pluginConfig = {
            QbittorrentTelemetryEnabled: true,
            QbittorrentPollIntervalSeconds: 30,
        };
        JC.t = (key: string) => key;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('accepts only the exact closed redacted projection', () => {
        expect(parseQbittorrentTelemetry(payload)).toEqual(payload);
        expect(parseQbittorrentTelemetry({ ...payload, hash: 'secret' })).toBeUndefined();
        expect(parseQbittorrentTelemetry({ ...payload, trackerIdentity: 'https://tracker/a?passkey=x' }))
            .toBeUndefined();
        expect(parseQbittorrentTelemetry({ ...payload, state: 'deleting' })).toBeUndefined();
        expect(parseQbittorrentTelemetry({})).toBeNull();
    });

    it('reserves stable geometry and renders only redacted telemetry text', async () => {
        const plugin = vi.fn().mockResolvedValue(payload);
        JC.core.api = { plugin } as unknown as ApiApi;
        const integration = createQbittorrentTelemetryIntegration(scope());
        const context = target('item-a');

        integration.render(context);
        const slot = context.page.querySelector<HTMLElement>('.jc-qbittorrent-telemetry-slot');
        expect(slot?.getAttribute('aria-busy')).toBe('true');
        expect(slot?.getAttribute('role')).toBe('status');
        expect(slot?.getAttribute('aria-live')).toBe('polite');
        expect(slot?.textContent).toBe('');
        await vi.waitFor(() => expect(context.page.textContent).toContain('Seeding'));
        expect(context.page.textContent).toContain('100.0%');
        expect(context.page.textContent).toContain('2.25');
        expect(context.page.textContent).toContain('…example.net');
        expect(context.page.textContent).not.toContain('hash');
        expect(QBITTORRENT_TELEMETRY_CSS).toMatch(/block-size:\s*2\.25rem/);
        expect(QBITTORRENT_TELEMETRY_CSS).toMatch(/overflow:\s*auto hidden/);
        expect(plugin).toHaveBeenCalledWith(
            '/qbittorrent/telemetry/item-a',
            expect.objectContaining({ skipCache: true, skipRetry: true, timeoutMs: 10_000 }),
        );
        integration.reset();
    });

    it('aborts the old item and never publishes its stale result', async () => {
        let resolveA!: (value: unknown) => void;
        let resolveB!: (value: unknown) => void;
        const requestA = new Promise<unknown>((resolve) => { resolveA = resolve; });
        const requestB = new Promise<unknown>((resolve) => { resolveB = resolve; });
        const plugin = vi.fn((
            path: string,
            _options?: { signal?: AbortSignal },
        ) => path.endsWith('item-a') ? requestA : requestB);
        JC.core.api = { plugin } as unknown as ApiApi;
        const integration = createQbittorrentTelemetryIntegration(scope());
        let visible = 'item-a';
        const contextA = target('item-a', () => visible === 'item-a');
        const contextB = target('item-b', () => visible === 'item-b');

        integration.render(contextA);
        const signalA = plugin.mock.calls[0][1]?.signal as AbortSignal;
        visible = 'item-b';
        integration.render(contextB);
        expect(signalA.aborted).toBe(true);
        resolveA({ ...payload, state: 'error' });
        resolveB(payload);
        await vi.waitFor(() => expect(contextB.page.textContent).toContain('Seeding'));
        expect(contextA.page.querySelector('.jc-qbittorrent-telemetry')).toBeNull();
        integration.reset();
    });

    it('fences the same item across an account identity transition', async () => {
        let resolveOld!: (value: unknown) => void;
        const oldRequest = new Promise<unknown>((resolve) => { resolveOld = resolve; });
        let callCount = 0;
        const plugin = vi.fn((
            _path: string,
            _options?: { signal?: AbortSignal },
        ) => callCount++ === 0 ? oldRequest : Promise.resolve(payload));
        JC.core.api = { plugin } as unknown as ApiApi;
        const integration = createQbittorrentTelemetryIntegration(scope());
        const oldContext = target('shared-item');

        integration.render(oldContext);
        const oldSignal = plugin.mock.calls[0][1]?.signal as AbortSignal;
        JC.identity.transition('qbittorrent-server', 'replacement-user', 'account-change');
        const newContext = target('shared-item');
        integration.render(newContext);

        expect(oldSignal.aborted).toBe(true);
        resolveOld({ ...payload, state: 'error' });
        await vi.waitFor(() => expect(newContext.page.textContent).toContain('Seeding'));
        expect(oldContext.page.querySelector('.jc-qbittorrent-telemetry')).toBeNull();
        integration.reset();
    });

    it('backs failed polls off exponentially and caps the retry multiplier', async () => {
        vi.useFakeTimers();
        const plugin = vi.fn().mockRejectedValue(new Error('unavailable'));
        JC.core.api = { plugin } as unknown as ApiApi;
        const integration = createQbittorrentTelemetryIntegration(scope());
        const context = target('item-backoff');

        integration.render(context);
        await vi.advanceTimersByTimeAsync(0);
        expect(plugin).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(59_999);
        expect(plugin).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(plugin).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(plugin).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(240_000);
        expect(plugin).toHaveBeenCalledTimes(4);
        await vi.advanceTimersByTimeAsync(240_000);
        expect(plugin).toHaveBeenCalledTimes(5);
        integration.reset();
        await vi.advanceTimersByTimeAsync(480_000);
        expect(plugin).toHaveBeenCalledTimes(5);
    });

    it('removes telemetry and aborts work when configuration ownership drains', async () => {
        let resolve!: (value: unknown) => void;
        const pending = new Promise<unknown>((done) => { resolve = done; });
        const plugin = vi.fn((
            _path: string,
            _options?: { signal?: AbortSignal },
        ) => pending);
        JC.core.api = { plugin } as unknown as ApiApi;
        const activation = new AbortController();
        const integration = createQbittorrentTelemetryIntegration(scope(activation));
        const context = target('item-disable');

        integration.render(context);
        const signal = plugin.mock.calls[0][1]?.signal as AbortSignal;
        JC.pluginConfig = { QbittorrentTelemetryEnabled: false };
        activation.abort();
        integration.reset();

        expect(signal.aborted).toBe(true);
        resolve(payload);
        await pending;
        await Promise.resolve();
        expect(context.page.querySelector('.jc-qbittorrent-telemetry-slot')).toBeNull();
        expect(plugin).toHaveBeenCalledTimes(1);
    });

    it('does not expose upstream error text and removes an authoritative no-match', async () => {
        const plugin = vi.fn()
            .mockRejectedValueOnce(new Error('http://private-host/token=secret'))
            .mockResolvedValueOnce({});
        JC.core.api = { plugin } as unknown as ApiApi;
        const integration = createQbittorrentTelemetryIntegration(scope());
        const failed = target('item-error');
        integration.render(failed);
        await vi.waitFor(() => expect(failed.page.textContent).toContain('Torrent telemetry unavailable'));
        expect(failed.page.textContent).not.toContain('private-host');
        expect(failed.page.textContent).not.toContain('secret');

        const empty = target('item-empty');
        integration.render(empty);
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(2));
        await Promise.resolve();
        expect(empty.page.querySelector('.jc-qbittorrent-telemetry')).toBeNull();
        integration.reset();
    });
});
