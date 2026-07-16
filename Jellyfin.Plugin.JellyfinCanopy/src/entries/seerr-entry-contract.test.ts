import { afterEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';

afterEach(() => vi.restoreAllMocks());

describe('Seerr lazy entry evaluation', () => {
    for (const entry of ['./seerr-core', './seerr-search', './seerr-discovery'] as const) {
        it(`${entry} performs no DOM, listener, request, or identity registration`, async () => {
            const createElement = vi.spyOn(document, 'createElement');
            const documentListener = vi.spyOn(document, 'addEventListener');
            const windowListener = vi.spyOn(window, 'addEventListener');
            const registerReset = vi.spyOn(JC.identity, 'registerReset');
            const fetchRequest = vi.spyOn(globalThis, 'fetch');
            const loaded: unknown = await import(entry);

            expect(typeof (loaded as { activate?: unknown }).activate).toBe('function');
            expect(createElement).not.toHaveBeenCalled();
            expect(documentListener).not.toHaveBeenCalled();
            expect(windowListener).not.toHaveBeenCalled();
            expect(registerReset).not.toHaveBeenCalled();
            expect(fetchRequest).not.toHaveBeenCalled();
        });
    }
});
