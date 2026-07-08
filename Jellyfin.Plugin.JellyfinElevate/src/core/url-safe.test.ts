import { describe, it, expect } from 'vitest';
import { isSafeLinkBase } from './url-safe';

describe('isSafeLinkBase', () => {
    it.each([
        ['http://sonarr:8989', true],
        ['https://sonarr.example.com', true],
        ['https://example.com/sonarr', true],            // base-url/subpath
        ['  https://example.com/seerr  ', true],         // trimmed
        ['http://[2001:db8::1]:5055', true],             // IPv6 literal
        ['', false],
        ['   ', false],
        [null, false],
        [undefined, false],
        ['sonarr.example.com', false],                   // no scheme
        ['ftp://example.com', false],
        ['javascript:alert(1)', false],
        ['file:///etc/passwd', false],
        ['https://user:pass@example.com', false],        // credentials leak
        ['https://user@example.com', false],             // bare username too
        ['https://example.com/x?y=1', false],            // query breaks concatenation
        ['https://example.com/x#frag', false],           // fragment breaks concatenation
    ] as [string | null | undefined, boolean][])('%s -> %s', (input, expected) => {
        expect(isSafeLinkBase(input)).toBe(expected);
    });
});
