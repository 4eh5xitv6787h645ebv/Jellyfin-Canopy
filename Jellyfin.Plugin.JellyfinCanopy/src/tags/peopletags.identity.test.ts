import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import './peopletags';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

function mountPersonCard(personId: string): HTMLElement {
    document.body.innerHTML = `
        <div id="itemDetailPage">
            <div id="castCollapsible">
                <div class="personCard" data-id="${personId}">
                    <div class="cardScalable"></div>
                </div>
            </div>
        </div>`;
    return document.querySelector<HTMLElement>('.personCard')!;
}

const surface = JC as typeof JC & { initializePeopleTags?: () => void };

describe('people tags identity lifecycle', () => {
    const originalApi = JC.core.api;
    const originalHelpers = JC.helpers;

    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = '';
        localStorage.clear();
        JC.identity.transition('people-server-a', `people-user-a-${Date.now()}`, 'people-test-a');
        JC.currentSettings = { peopleTagsEnabled: true };
        JC.pluginConfig = { TagsCacheTtlDays: 7 };
    });

    afterEach(() => {
        JC.identity.transition('test-server-id', 'test-user-id', 'people-test-cleanup');
        JC.core.api = originalApi;
        JC.helpers = originalHelpers;
        JC.currentSettings = {};
        JC.pluginConfig = {};
        document.body.innerHTML = '';
        localStorage.clear();
        vi.useRealTimers();
    });

    it('disconnects A, rejects its late response, and starts one clean B observer', async () => {
        const callbacks: MutationCallback[] = [];
        const disconnects: ReturnType<typeof vi.fn>[] = [];
        JC.helpers = {
            ...originalHelpers,
            createObserver: vi.fn((_id, callback) => {
                callbacks.push(callback);
                const disconnect = vi.fn();
                disconnects.push(disconnect);
                return { disconnect };
            }),
        };

        const responseA = deferred<any>();
        const plugin = vi.fn()
            .mockReturnValueOnce(responseA.promise)
            .mockResolvedValueOnce({ currentAge: 44, birthPlace: 'Perth, Australia' });
        JC.core.api = { plugin } as unknown as typeof JC.core.api;

        window.location.hash = '#/details?id=item-a';
        const cardA = mountPersonCard('person-a');
        localStorage.setItem('JellyfinCanopy-peopleTagsCache', JSON.stringify({ secret: 'A' }));
        surface.initializePeopleTags!();
        expect(callbacks).toHaveLength(1);

        callbacks[0]([{ addedNodes: [document.createElement('div')] }] as unknown as MutationRecord[], {} as MutationObserver);
        await vi.advanceTimersByTimeAsync(100);
        expect(plugin).toHaveBeenCalledTimes(1);

        JC.identity.transition('people-server-b', 'people-user-b', 'people-test-b');
        expect(disconnects[0]).toHaveBeenCalledTimes(1);
        expect(localStorage.getItem('JellyfinCanopy-peopleTagsCache')).toBeNull();

        responseA.resolve({ currentAge: 99, birthPlace: 'A-only place' });
        await Promise.resolve();
        await Promise.resolve();
        expect(cardA.querySelector('.jc-people-age-container')).toBeNull();
        expect(cardA.querySelector('.jc-people-place-banner')).toBeNull();

        // Even if a queued copy of A's observer callback is delivered, its
        // captured epoch keeps it dormant.
        callbacks[0]([{ addedNodes: [document.createElement('div')] }] as unknown as MutationRecord[], {} as MutationObserver);
        await vi.advanceTimersByTimeAsync(100);
        expect(plugin).toHaveBeenCalledTimes(1);

        window.location.hash = '#/details?id=item-b';
        const cardB = mountPersonCard('person-b');
        surface.initializePeopleTags!();
        expect(callbacks).toHaveLength(2);
        callbacks[1]([{ addedNodes: [document.createElement('div')] }] as unknown as MutationRecord[], {} as MutationObserver);
        await vi.advanceTimersByTimeAsync(100);
        await Promise.resolve();
        await Promise.resolve();

        expect(plugin).toHaveBeenCalledTimes(2);
        expect(cardB.querySelector('.jc-people-age-text')?.textContent).toBe('44y');
        expect(cardB.querySelector('.jc-people-place-text')?.textContent).toBe('Perth, Australia');
        expect(cardB.querySelector('.jc-people-age-container')?.getAttribute('data-jc-identity-owned')).toBe('true');
    });

    it('retains the current owner cache across a same-identity reinitialization', () => {
        const disconnect = vi.fn();
        JC.helpers = {
            ...originalHelpers,
            createObserver: vi.fn(() => ({ disconnect })),
        };
        const context = JC.identity.capture()!;
        const cache = JSON.stringify({ 'person-a-item-a': { currentAge: 40 } });
        localStorage.setItem('JellyfinCanopy-peopleTagsCacheIdentityOwner', `${context.serverId}:${context.userId}`);
        localStorage.setItem('JellyfinCanopy-peopleTagsCache', cache);
        localStorage.setItem('JellyfinCanopy-peopleTagsCacheTimestamp', JSON.stringify({ 'person-a-item-a': Date.now() }));

        surface.initializePeopleTags!();
        surface.initializePeopleTags!();

        expect(disconnect).toHaveBeenCalledTimes(1);
        expect(localStorage.getItem('JellyfinCanopy-peopleTagsCache')).toBe(cache);
        expect(localStorage.getItem('JellyfinCanopy-peopleTagsCacheIdentityOwner')).toBe(
            `${context.serverId}:${context.userId}`,
        );
    });
});
