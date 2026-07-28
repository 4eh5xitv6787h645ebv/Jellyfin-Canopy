// EP-01's exit gate: a client driven ONLY by the published contract artifacts
// negotiates with a live Jellyfin 12.
//
// The point is what this spec is NOT allowed to know. It imports no plugin
// constants, hard-codes no paths and no schema — every route, parameter and
// response shape is read out of contracts/platform/v1/openapi.json at runtime.
// If the spec and the server disagree, this fails. If a consumer could not build
// a working client from the published artifacts alone, this fails.
//
// PlatformContractTests already proves the spec matches the assembly by
// reflection. That is a static check and cannot see routing, authentication or
// serialization. This one runs against a real server, which is the only way to
// find out whether the contract survives the host.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, loginAs, assertNoRuntimeErrors } from './fixtures/auth';

/* eslint-disable @typescript-eslint/no-explicit-any */

const CONTRACT = JSON.parse(
    readFileSync(join(__dirname, '..', 'contracts', 'platform', 'v1', 'openapi.json'), 'utf8'),
);

/** Resolves a local `$ref` against the contract document. */
function resolveRef(ref: string): any {
    return ref
        .replace(/^#\//, '')
        .split('/')
        .reduce((node: any, segment: string) => node[segment], CONTRACT);
}

/** The JSON schema a given operation promises for a status code. */
function responseSchema(path: string, method: string, status: string): any {
    let response = CONTRACT.paths[path][method].responses[status];
    if (response.$ref) {
        response = resolveRef(response.$ref);
    }

    const schema = response.content['application/json'].schema;
    return schema.$ref ? resolveRef(schema.$ref) : schema;
}

/**
 * Checks a payload against a contract schema.
 *
 * Deliberately strict about BOTH directions. A missing required property means
 * the server under-delivers; an undeclared property means it leaks something the
 * contract never promised — and on the anonymous route that is a disclosure, not
 * a formatting nit.
 */
function assertMatchesSchema(payload: any, schema: any, where: string): void {
    for (const required of schema.required ?? []) {
        expect(payload, `${where}: missing required property "${required}"`).toHaveProperty(required);
    }

    if (schema.additionalProperties === false) {
        const declared = Object.keys(schema.properties ?? {});
        const undeclared = Object.keys(payload).filter((key) => !declared.includes(key));
        expect(undeclared, `${where}: returned properties the contract does not declare`).toEqual([]);
    }

    for (const [name, rawSpec] of Object.entries<any>(schema.properties ?? {})) {
        if (!(name in payload)) {
            continue;
        }

        const propertySpec = rawSpec.$ref ? resolveRef(rawSpec.$ref) : rawSpec;
        const allowed = Array.isArray(propertySpec.type) ? propertySpec.type : [propertySpec.type];
        const value = payload[name];

        const actual =
            value === null ? 'null'
                : Array.isArray(value) ? 'array'
                    : Number.isInteger(value) ? 'integer'
                        : typeof value;

        expect(allowed, `${where}: property "${name}" was ${actual}`).toContain(actual);

        if (propertySpec.enum) {
            expect(propertySpec.enum, `${where}: property "${name}" was outside the documented enum`).toContain(value);
        }

        if (propertySpec.pattern) {
            expect(String(value), `${where}: property "${name}" did not match its documented pattern`)
                .toMatch(new RegExp(propertySpec.pattern));
        }
    }
}

/** The one operation the contract marks anonymous. */
function anonymousPath(): string {
    const entries = Object.entries<any>(CONTRACT.paths).filter(
        ([, operations]) => Array.isArray(operations.get?.security) && operations.get.security.length === 0,
    );

    expect(entries, 'the contract must declare exactly one anonymous operation').toHaveLength(1);
    return entries[0][0];
}

async function getJson(page: any, path: string, authenticated: boolean): Promise<{ status: number; body: any }> {
    return page.evaluate(
        async ({ target, withAuth }: { target: string; withAuth: boolean }) => {
            const api = (window as any).ApiClient;
            const token = api.accessToken ? api.accessToken() : '';
            const headers: Record<string, string> = {};

            if (withAuth) {
                // JF12 authenticates from the Authorization header; it dropped the
                // legacy query-string api_key.
                headers.Authorization = `MediaBrowser Token="${token}"`;
            }

            const res = await fetch(new URL(target, window.location.origin).toString(), { headers });
            const text = await res.text();

            return { status: res.status, body: text ? JSON.parse(text) : null };
        },
        { target: path, withAuth: authenticated },
    );
}

test.describe('Platform v1 contract — live smoke client', () => {
    test('a client built only from the published contract discovers and negotiates', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);

        // 1. Discovery, anonymously. The contract says which path this is and that
        //    it needs no credentials; nothing here is hard-coded.
        const discoveryPath = anonymousPath();
        const discovery = await getJson(page, discoveryPath, false);

        expect(discovery.status, 'the anonymous route must be reachable without credentials').toBe(200);
        assertMatchesSchema(
            discovery.body,
            responseSchema(discoveryPath, 'get', '200'),
            `GET ${discoveryPath}`,
        );
        expect(discovery.body.Available).toBe(true);

        // 2. Negotiate, using the range discovery just advertised. This is the
        //    handshake a real consumer performs, and the reason the two routes
        //    exist as a pair.
        const negotiatePath = Object.keys(CONTRACT.paths).find((path) => path !== discoveryPath)!;
        const parameters = CONTRACT.paths[negotiatePath].get.parameters.map((p: any) => p.name);
        expect(parameters).toEqual(expect.arrayContaining(['protocolMinimum', 'protocolMaximum']));

        const query = `?protocolMinimum=${discovery.body.ProtocolMinimum}&protocolMaximum=${discovery.body.ProtocolMaximum}`;
        const negotiated = await getJson(page, negotiatePath + query, true);

        expect(negotiated.status).toBe(200);
        assertMatchesSchema(
            negotiated.body,
            responseSchema(negotiatePath, 'get', '200'),
            `GET ${negotiatePath}`,
        );

        // A client offering exactly what discovery advertised must be compatible.
        // If this ever fails, the two routes disagree about the same server.
        expect(negotiated.body.Compatible).toBe(true);
        expect(negotiated.body.Protocol).toBe(discovery.body.ProtocolMaximum);

        assertNoRuntimeErrors(consoleErrors);
    });

    test('an unauthenticated call to the authenticated route is refused with an unparseable body', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);

        // ADR-0002 and EP-00's S9 measurement: 401/403 carry ZERO body bytes, so
        // the contract documents them WITHOUT a schema. A client that tried to
        // parse an error envelope here would throw on empty input, which is why
        // the contract must not promise one.
        const discoveryPath = anonymousPath();
        const negotiatePath = Object.keys(CONTRACT.paths).find((path) => path !== discoveryPath)!;

        const refused = CONTRACT.paths[negotiatePath].get.responses['401'];
        const documented = refused.$ref ? resolveRef(refused.$ref) : refused;
        expect(documented.content, 'the contract must not promise a body for 401').toBeUndefined();

        const status = await page.evaluate(async (target: string) => {
            const res = await fetch(new URL(target, window.location.origin).toString());
            return { code: res.status, length: (await res.text()).length };
        }, negotiatePath);

        expect([401, 403]).toContain(status.code);
        expect(status.length, 'Jellyfin 12 returns 401/403 with no body at all').toBe(0);
    });
});
