import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';

function deferred(): { promise: Promise<void>; resolve(): void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

describe('Seerr discovery render generation ownership', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        JC.identity.transition('server-a', 'user-a', 'discovery-generation-test-start');
        JC.pluginConfig = {};
        JC.core.navigation = {
            onNavigate: () => () => undefined,
            onViewPage: () => () => undefined,
        } as unknown as NonNullable<typeof JC.core.navigation>;
    });

    it.each(['A settles first', 'B settles first'])(
        'keeps B ownership through triple same-key re-entry when %s',
        async (completionOrder) => {
            const gates = [deferred(), deferred(), deferred()];
            const calls: AbortSignal[] = [];
            const { installDiscoveryBase } = await import('./base');
            installDiscoveryBase();
            const controller = JC.discoveryBase!.createDiscovery({
                key: 'generation-test',
                mode: 'one-shot',
                logLabel: 'Generation Test',
                configKey: 'GenerationTestEnabled',
                getIdFromUrl: () => 'same-item',
                renderOneShot: vi.fn(async ({ signal }: { signal: AbortSignal }) => {
                    const call = calls.push(signal) - 1;
                    await gates[call].promise;
                    if (signal.aborted) return false;

                    const section = document.createElement('div');
                    section.className = 'seerr-generation-test-discovery-section';
                    section.textContent = `generation-${call + 1}`;
                    document.body.appendChild(section);
                    return true;
                }),
            });

            const renderA = controller.render();
            await vi.waitFor(() => expect(calls).toHaveLength(1));

            // Navigation/re-entry aborts A, releases the page key, and installs B
            // as the new owner for that exact same key.
            controller.cleanup();
            const renderB = controller.render();
            await vi.waitFor(() => expect(calls).toHaveLength(2));
            expect(calls[0].aborted).toBe(true);
            expect(calls[1].aborted).toBe(false);

            if (completionOrder === 'A settles first') {
                gates[0].resolve();
                await renderA;

                // A's late finally must compare-and-clear. If it releases B's
                // ownership, this third call starts and aborts B.
                const renderC = controller.render();
                await Promise.resolve();
                const thirdStarted = calls.length === 3;
                if (thirdStarted) gates[2].resolve();
                gates[1].resolve();
                await Promise.all([renderB, renderC]);

                expect(thirdStarted).toBe(false);
                expect(calls).toHaveLength(2);
                expect(calls[1].aborted).toBe(false);
            } else {
                gates[1].resolve();
                await renderB;

                // A remains held while a completed B owns the processed key.
                await controller.render();
                expect(calls).toHaveLength(2);

                gates[0].resolve();
                await renderA;
            }

            expect(document.querySelectorAll('.seerr-generation-test-discovery-section'))
                .toHaveLength(1);
            expect(document.body.textContent).toContain('generation-2');
            expect(document.body.textContent).not.toContain('generation-1');
            controller.dispose();
        },
    );
});
