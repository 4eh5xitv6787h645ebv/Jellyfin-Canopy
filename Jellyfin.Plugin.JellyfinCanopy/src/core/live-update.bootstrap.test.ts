import { describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import type { ClientRefreshState } from './live-update';

const hash = (character: string): string => character.repeat(64);

function refreshState(
    overrides: Partial<ClientRefreshState> = {},
): ClientRefreshState {
    return {
        SchemaVersion: 1,
        ServerId: 'test-server-id',
        CanopyBuildId: hash('a'),
        JellyfinGeneration: hash('b'),
        ConfigurationRevision: 1,
        ForceRevision: 0,
        Policy: {
            Mode: 'Notify',
            OnCanopyUpdate: true,
            OnJellyfinUpdate: true,
            OnConfigChange: true,
            PollSeconds: 30,
            IdleSeconds: 5,
        },
        ...overrides,
    };
}

describe('pre-runtime refresh bootstrap adoption', () => {
    it('detects config and force changes that happen before the first authenticated poll', async () => {
        JC.clientRefreshBootstrap = refreshState();
        const plugin = vi.fn().mockResolvedValue(refreshState({
            ConfigurationRevision: 2,
            ForceRevision: 1,
        }));
        const originalApi = JC.core.api;
        JC.core.api = { plugin } as unknown as NonNullable<typeof JC.core.api>;

        const { acquireRefreshSafetyHold } = await import('./lifecycle');
        const releaseModal = acquireRefreshSafetyHold('modal');
        try {
            await import('./live-update');

            await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(1));
            await vi.waitFor(() => {
                expect(document.getElementById('jc-client-refresh-notice')?.textContent)
                    .toMatch(/wait until dialog is clear/i);
            });
        } finally {
            JC.identity.transition('', '', 'bootstrap-test-cleanup');
            releaseModal();
            JC.core.api = originalApi;
            JC.clientRefreshBootstrap = undefined;
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    });
});
