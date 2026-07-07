// Unit tests for the arr-search gating + capture store (the synchronous decisions the menu
// injector relies on to avoid a network round-trip on menu open).
import { beforeEach, describe, expect, it } from 'vitest';
import { JE } from '../../globals';
import {
    serviceForType, supportsInteractive, serviceConfigured, searchEnabled, manageEnabled,
    setCaptured, getCaptured, refineCapturedType, cacheDetailsType, getDetailsType, CAPTURE_TTL_MS,
} from './state';

function setConfig(cfg: Record<string, unknown>): void {
    (JE as unknown as { pluginConfig: Record<string, unknown> }).pluginConfig = cfg;
}

beforeEach(() => { setConfig({}); setCaptured(null); });

describe('serviceForType', () => {
    it('maps item types to their arr service', () => {
        expect(serviceForType('Movie')).toBe('radarr');
        expect(serviceForType('Series')).toBe('sonarr');
        expect(serviceForType('Season')).toBe('sonarr');
        expect(serviceForType('Episode')).toBe('sonarr');
        expect(serviceForType('BoxSet')).toBeNull();
        expect(serviceForType(null)).toBeNull();
        expect(serviceForType(undefined)).toBeNull();
    });
});

describe('supportsInteractive', () => {
    it('is true for movie/season/episode, false for a whole series', () => {
        expect(supportsInteractive('Movie')).toBe(true);
        expect(supportsInteractive('Season')).toBe(true);
        expect(supportsInteractive('Episode')).toBe(true);
        expect(supportsInteractive('Series')).toBe(false);
        expect(supportsInteractive(null)).toBe(false);
    });
});

describe('serviceConfigured', () => {
    it('is true only when an enabled instance with a URL exists', () => {
        setConfig({ RadarrInstances: [{ Name: 'r', Url: 'http://x', Enabled: true }] });
        expect(serviceConfigured('radarr')).toBe(true);
        expect(serviceConfigured('sonarr')).toBe(false);
    });

    it('ignores disabled or URL-less instances', () => {
        setConfig({ SonarrInstances: [{ Name: 's', Url: 'http://x', Enabled: false }, { Name: 's2', Url: '', Enabled: true }] });
        expect(serviceConfigured('sonarr')).toBe(false);
    });
});

describe('enable flags', () => {
    it('searchEnabled defaults on, off only when explicitly false', () => {
        expect(searchEnabled()).toBe(true);           // absent → default true
        setConfig({ ArrSearchEnabled: false });
        expect(searchEnabled()).toBe(false);
    });

    it('manageEnabled requires both search and manage on', () => {
        setConfig({ ArrSearchEnabled: true, ArrSearchManageEnabled: false });
        expect(manageEnabled()).toBe(false);
        setConfig({ ArrSearchEnabled: false, ArrSearchManageEnabled: true });
        expect(manageEnabled()).toBe(false);
        setConfig({});
        expect(manageEnabled()).toBe(true);           // both default true
    });
});

describe('capture store', () => {
    it('returns a fresh context and null once past the TTL', () => {
        setCaptured({ itemId: 'abc', type: 'Movie', ts: Date.now() });
        expect(getCaptured()?.itemId).toBe('abc');

        setCaptured({ itemId: 'abc', type: 'Movie', ts: Date.now() - CAPTURE_TTL_MS - 1 });
        expect(getCaptured()).toBeNull();
    });

    it('refines an unknown type for the same item only', () => {
        setCaptured({ itemId: 'abc', type: null, ts: Date.now() });
        refineCapturedType('other', 'Series');
        expect(getCaptured()?.type).toBeNull();
        refineCapturedType('abc', 'Series');
        expect(getCaptured()?.type).toBe('Series');
    });
});

describe('details type cache', () => {
    it('caches non-null types and reads them back', () => {
        cacheDetailsType('id1', 'Episode');
        cacheDetailsType('id2', null);
        expect(getDetailsType('id1')).toBe('Episode');
        expect(getDetailsType('id2')).toBeNull();
    });
});
