import { expect, it, vi } from 'vitest';

it('upgrades a legacy history patch flag and hands mutation callbacks to a hot generation', async () => {
    history.__jePushed = true;
    Reflect.deleteProperty(history, '__jcNavigationPatchVersion');

    await import('./navigation');
    expect(history.__jcNavigationPatchVersion).toBe(2);

    vi.resetModules();
    const nextGeneration = await import('./navigation');
    const mutation = vi.fn();
    const release = nextGeneration.onHistoryMutation(mutation);
    const sameUrl = location.href;

    try {
        history.pushState({ proof: 'hot-generation-same-url' }, '', sameUrl);
        expect(mutation).toHaveBeenCalledTimes(1);
        expect(mutation).toHaveBeenCalledWith({
            source: 'pushState',
            state: { proof: 'hot-generation-same-url' },
            href: sameUrl,
            action: 'PUSH',
        });
    } finally {
        release();
    }
});
