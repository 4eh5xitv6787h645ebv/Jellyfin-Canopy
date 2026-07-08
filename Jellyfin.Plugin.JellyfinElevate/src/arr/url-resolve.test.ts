import { describe, it, expect } from 'vitest';
import { parseUrlMappings, resolveMappedBase } from './url-resolve';

describe('parseUrlMappings', () => {
    it('parses newline-separated jellyfin|arr pairs', () => {
        expect(parseUrlMappings('https://jf.example.com|https://sonarr.example.com'))
            .toEqual([{ jellyfinUrl: 'https://jf.example.com', arrUrl: 'https://sonarr.example.com' }]);
    });

    it('ignores blank and malformed lines', () => {
        expect(parseUrlMappings('\n  \nonlyoneside\nhttps://a|https://b\n')).toEqual([
            { jellyfinUrl: 'https://a', arrUrl: 'https://b' }
        ]);
    });

    it('returns [] for empty/undefined input', () => {
        expect(parseUrlMappings(undefined)).toEqual([]);
        expect(parseUrlMappings('')).toEqual([]);
    });
});

describe('resolveMappedBase precedence', () => {
    const server = 'https://jf.example.com';

    it('falls back to the internal URL when no external/mapping (unchanged behaviour)', () => {
        expect(resolveMappedBase('http://sonarr:8989', '', [], server)).toBe('http://sonarr:8989');
    });

    it('prefers the external URL over the internal URL for links', () => {
        expect(resolveMappedBase('http://sonarr:8989', 'https://sonarr.example.com', [], server))
            .toBe('https://sonarr.example.com');
    });

    it('lets a matching URL mapping win over the external URL', () => {
        const mappings = parseUrlMappings('https://jf.example.com|https://mapped.example.com');
        expect(resolveMappedBase('http://sonarr:8989', 'https://external.example.com', mappings, server))
            .toBe('https://mapped.example.com');
    });

    it('uses the external URL when a mapping exists but does not match the current server', () => {
        const mappings = parseUrlMappings('https://other.example.com|https://mapped.example.com');
        expect(resolveMappedBase('http://sonarr:8989', 'https://external.example.com', mappings, server))
            .toBe('https://external.example.com');
    });

    it('trims trailing slashes but preserves a base-URL subpath', () => {
        expect(resolveMappedBase('http://host/sonarr/', '', [], server)).toBe('http://host/sonarr');
        expect(resolveMappedBase('http://sonarr:8989', 'https://host/sonarr/', [], server))
            .toBe('https://host/sonarr');
    });

    it('returns null when nothing is configured', () => {
        expect(resolveMappedBase('', '', [], server)).toBeNull();
        expect(resolveMappedBase(null, null, [], server)).toBeNull();
    });

    it('ignores a whitespace-only external URL and falls back to internal', () => {
        expect(resolveMappedBase('http://sonarr:8989', '   ', [], server)).toBe('http://sonarr:8989');
    });
});
