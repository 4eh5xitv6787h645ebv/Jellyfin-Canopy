import { afterEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';

const unregister: Array<() => void> = [];

afterEach(() => {
    for (const dispose of unregister.splice(0)) dispose();
});

describe('shared test identity activation contract', () => {
    it('retries a failed handler and memoizes only its successful attempt', async () => {
        const context = JC.identity.transition('setup-server', 'setup-retry-user', 'setup-retry')!;
        const flaky = vi.fn()
            .mockRejectedValueOnce(new Error('first activation failed'))
            .mockResolvedValue(undefined);
        unregister.push(JC.identity.registerActivate('setup-retry-probe', flaky));

        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        await expect(JC.identity.activate(context)).resolves.toBeUndefined();
        await expect(JC.identity.activate(context)).resolves.toBeUndefined();
        await expect(JC.identity.activate(context)).resolves.toBeUndefined();

        expect(flaky).toHaveBeenCalledTimes(2);
        expect(error).toHaveBeenCalledTimes(1);
    });

    it('deduplicates concurrent activation for the same handler and epoch', async () => {
        const context = JC.identity.transition('setup-server', 'setup-pending-user', 'setup-pending')!;
        let release: (() => void) | undefined;
        const held = new Promise<void>((resolve) => { release = resolve; });
        const handler = vi.fn(() => held);
        unregister.push(JC.identity.registerActivate('setup-pending-probe', handler));

        const first = JC.identity.activate(context);
        const second = JC.identity.activate(context);
        await Promise.resolve();
        expect(handler).toHaveBeenCalledTimes(1);

        release?.();
        await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
        expect(handler).toHaveBeenCalledTimes(1);
    });
});
