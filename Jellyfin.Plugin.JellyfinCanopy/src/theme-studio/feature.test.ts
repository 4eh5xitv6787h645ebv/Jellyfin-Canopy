import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestFeatureScope } from '../test/feature-scope';
import { COMMITTED_STYLE_ID } from './styles';

afterEach(() => {
    document.getElementById(COMMITTED_STYLE_ID)?.remove();
    document.documentElement.removeAttribute('data-jc-theme-active');
    vi.unstubAllGlobals();
});

describe('Theme Studio feature activation boundary', () => {
    it('clears presentation and acquired resources when activation throws', async () => {
        const stale = document.createElement('style');
        stale.id = COMMITTED_STYLE_ID;
        document.head.append(stale);
        document.documentElement.setAttribute('data-jc-theme-active', 'true');
        vi.stubGlobal('matchMedia', undefined);
        vi.stubGlobal('MutationObserver', class {
            constructor() { throw new Error('observer unavailable'); }
        });
        const harness = createTestFeatureScope();
        const { themeStudioFeature } = await import('./feature');

        await expect(themeStudioFeature.activate(harness.scope)).rejects.toThrow('observer unavailable');
        expect(document.getElementById(COMMITTED_STYLE_ID)).toBeNull();
        expect(document.documentElement.hasAttribute('data-jc-theme-active')).toBe(false);
        await harness.dispose();
    });
});
