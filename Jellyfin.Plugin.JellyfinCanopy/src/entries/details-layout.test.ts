import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestFeatureScope } from '../test/feature-scope';

afterEach(() => {
    document.getElementById('jc-details-layout-styles')?.remove();
    vi.restoreAllMocks();
});

describe('details layout feature', () => {
    it('evaluates without DOM side effects', async () => {
        document.getElementById('jc-details-layout-styles')?.remove();
        vi.resetModules();
        const createElement = vi.spyOn(document, 'createElement');

        const loaded: unknown = await import('./details-layout');

        expect(typeof (loaded as { activate?: unknown }).activate).toBe('function');
        expect(createElement).not.toHaveBeenCalled();
        expect(document.getElementById('jc-details-layout-styles')).toBeNull();
    });

    it('owns the mobile action-row adapter for every details route activation', async () => {
        const { detailsLayoutFeature } = await import('./details-layout');
        const harness = createTestFeatureScope();

        await detailsLayoutFeature.activate(harness.scope);

        const style = document.getElementById('jc-details-layout-styles');
        expect(style?.textContent).toContain('@media (max-width: 600px)');
        expect(style?.textContent).toContain('#itemDetailPage .detailRibbon > .mainDetailButtons');
        expect(style?.textContent).toContain('flex-wrap: wrap');
        await harness.dispose();
        expect(document.getElementById('jc-details-layout-styles')).toBeNull();
    });

    it('does no work for a stale scope and protects a newer owner from stale cleanup', async () => {
        const { detailsLayoutFeature } = await import('./details-layout');
        const stale = createTestFeatureScope();
        stale.setCurrent(false);
        await detailsLayoutFeature.activate(stale.scope);
        expect(document.getElementById('jc-details-layout-styles')).toBeNull();

        const first = createTestFeatureScope();
        const second = createTestFeatureScope();
        await detailsLayoutFeature.activate(first.scope);
        const oldStyle = document.getElementById('jc-details-layout-styles');
        await detailsLayoutFeature.activate(second.scope);
        const currentStyle = document.getElementById('jc-details-layout-styles');
        expect(currentStyle).not.toBe(oldStyle);
        await first.dispose();
        expect(document.getElementById('jc-details-layout-styles')).toBe(currentStyle);
        await second.dispose();
        expect(document.getElementById('jc-details-layout-styles')).toBeNull();
    });
});
