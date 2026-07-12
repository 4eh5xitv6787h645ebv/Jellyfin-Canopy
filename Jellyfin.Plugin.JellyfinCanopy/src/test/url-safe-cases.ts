// src/test/url-safe-cases.ts
// (test-support module — lives under src/test/ so the bundle's reachability
//  guard excludes it from the production bundle.)
//
// The single shared "is this a safe browser LINK BASE?" case matrix — the one
// place that says, per input, whether the rule must ACCEPT or REJECT it. Three
// independent copies of that rule exist and MUST agree:
//   - src/core/url-safe.ts::isSafeLinkBase          (client link resolvers)
//   - Helpers/ServiceUrlResolver.cs::IsWellFormedHttpUrl (server projection)
//   - Configuration/config-page.js::jcIsHttpUrl      (config-page save gate)
//
// Every one of the three is exercised against THIS matrix from its own test
// suite (two vitest suites here + a mirrored xUnit Theory in
// ServiceUrlResolverTests.cs), so if any copy drifts from the rule, its suite
// goes red. When you change the rule, change it in all three AND here together.

/** One row of the shared matrix: an input and whether the rule must accept it. */
export interface LinkBaseCase {
    /** The raw value handed to the validator. */
    readonly input: string;
    /** True when the value is a safe http(s) link base; false when it must be rejected. */
    readonly accept: boolean;
    /** Human-readable reason this case exists (shown in test names). */
    readonly note: string;
}

/**
 * The shared accept/reject matrix. Keep in lockstep with the mirrored xUnit
 * `[Theory]` in ServiceUrlResolverTests.IsWellFormedHttpUrl_SharedDriftMatrix.
 */
export const LINK_BASE_CASES: readonly LinkBaseCase[] = [
    // ---- accepted: absolute http(s) bases with no credentials/query/fragment ----
    { input: 'http://sonarr:8989', accept: true, note: 'plain http host:port' },
    { input: 'https://sonarr.example.com', accept: true, note: 'plain https host' },
    { input: 'https://example.com/sonarr', accept: true, note: 'subpath base' },
    { input: 'http://[2001:db8::1]:5055', accept: true, note: 'IPv6 bracket literal' },
    { input: 'HTTP://example.com', accept: true, note: 'uppercase scheme (normalized)' },
    { input: 'https://example.com/', accept: true, note: 'trailing slash' },

    // ---- rejected ----
    { input: 'seerr.local:5055', accept: false, note: 'scheme-less host:port' },
    { input: '//example.com', accept: false, note: 'protocol-relative //host' },
    { input: 'javascript:alert(1)', accept: false, note: 'javascript: scheme' },
    { input: 'data:text/html,hi', accept: false, note: 'data: scheme' },
    { input: 'file:///etc/passwd', accept: false, note: 'file: scheme' },
    { input: 'ftp://example.com', accept: false, note: 'ftp: scheme' },
    { input: 'https://user:pass@example.com', accept: false, note: 'embedded credentials' },
    { input: 'https://example.com/x?y=1', accept: false, note: 'query string' },
    { input: 'https://example.com/x#frag', accept: false, note: 'fragment' },
    { input: '   ', accept: false, note: 'whitespace-only' },
];
