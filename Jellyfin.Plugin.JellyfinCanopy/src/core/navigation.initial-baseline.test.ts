import { expect, it, vi } from 'vitest';

it('seeds a direct-boot URL before the first same-URL pop but still dispatches a real change', async () => {
    const directBootUrl = '/direct-boot-baseline?owner=modal#/search';
    History.prototype.replaceState.call(history, { owner: 'host' }, '', directBootUrl);

    vi.resetModules();
    const { handleHistoryUpdate, onNavigate } = await import('./navigation');

    const callback = vi.fn();
    const unsubscribe = onNavigate(callback);

    // Closing a same-URL modal sentinel changes history state, not the route.
    window.dispatchEvent(new PopStateEvent('popstate', { state: { owner: 'host' } }));
    expect(callback).not.toHaveBeenCalled();

    // Bypass the instance patch to model a host-router change followed by its
    // native pop signal. The changed canonical URL must still dispatch once.
    History.prototype.pushState.call(history, { owner: 'host' }, '', `${directBootUrl}-next`);
    window.dispatchEvent(new PopStateEvent('popstate', { state: { owner: 'host' } }));
    expect(callback).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('hashchange'));
    handleHistoryUpdate();
    expect(callback).toHaveBeenCalledTimes(1);

    unsubscribe();
});
