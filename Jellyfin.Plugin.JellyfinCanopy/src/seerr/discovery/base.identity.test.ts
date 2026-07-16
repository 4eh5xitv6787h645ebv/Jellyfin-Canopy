import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';

function deferred(): { promise: Promise<void>; resolve(): void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

describe('Seerr discovery controller identity lifecycle', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        JC.identity.transition('server-a', 'user-a', 'discovery-base-test-start');
        JC.pluginConfig = {};
        JC.core.navigation = {
            onNavigate: () => () => undefined,
            onViewPage: () => () => undefined,
        } as unknown as NonNullable<typeof JC.core.navigation>;
    });

    it('removes A synchronously, drops held A, and renders B on activation', async () => {
        const heldA = deferred();
        let call = 0;
        await import('./base');
        const controller = JC.discoveryBase!.createDiscovery({
            key: 'identity-test',
            mode: 'one-shot',
            logLabel: 'Identity Test',
            configKey: 'IdentityTestEnabled',
            getIdFromUrl: () => 'same-item',
            renderOneShot: vi.fn(async ({ signal }: { signal: AbortSignal }) => {
                call++;
                if (call === 1) await heldA.promise;
                if (signal.aborted) return false;
                const section = document.createElement('div');
                section.className = 'seerr-identity-test-discovery-section';
                section.textContent = call === 1 ? 'account-a' : 'account-b';
                document.body.appendChild(section);
                return true;
            }),
        });
        controller.start();

        const staleSection = document.createElement('div');
        staleSection.className = 'seerr-identity-test-discovery-section';
        staleSection.textContent = 'visible-a';
        document.body.appendChild(staleSection);
        const first = controller.render();
        await vi.waitFor(() => expect(call).toBe(1));

        const contextB = JC.identity.transition('server-a', 'user-b', 'account-switch');
        expect(document.querySelector('.seerr-identity-test-discovery-section')).toBeNull();
        heldA.resolve();
        await first;
        expect(document.body.textContent).not.toContain('account-a');

        await JC.identity.activate(contextB);
        await vi.waitFor(() => expect(call).toBe(2));
        await vi.waitFor(() => expect(document.body.textContent).toContain('account-b'));
        controller.dispose();
    });
});
