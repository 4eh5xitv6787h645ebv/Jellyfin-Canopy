import { afterEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import {
    primeIdentityCookieEarly,
    resetIdentityCookie,
} from './identity';

describe('spoiler identity cookie ownership', () => {
    afterEach(() => {
        resetIdentityCookie();
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('expires A synchronously and primes B once on activation', async () => {
        vi.useFakeTimers();
        const interval = vi.spyOn(window, 'setInterval');
        const original = JC.identity.capture()!;

        resetIdentityCookie();
        primeIdentityCookieEarly(original);
        expect(document.cookie).toContain(`jc-spoiler-uid=${original.userId}`);

        const next = JC.identity.transition('server-b', 'user-b', 'spoiler-cookie-test')!;
        expect(document.cookie).not.toContain('jc-spoiler-uid=');

        await JC.identity.activate(next);
        await JC.identity.activate(next);
        expect(document.cookie).toContain(`jc-spoiler-uid=${next.userId}`);
        expect(interval).toHaveBeenCalledTimes(2);

        JC.identity.transition(original.serverId, original.userId, 'spoiler-cookie-test-restore');
    });
});
