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
import { open, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join, resolve } from 'node:path';
import { test, expect, loginAs, assertNoRuntimeErrors, USERS } from './fixtures/auth';
import { apiRaw, authenticate, authHeader } from './fixtures/api';

/* eslint-disable @typescript-eslint/no-explicit-any */

const CONTRACT = JSON.parse(
    readFileSync(join(__dirname, '..', 'contracts', 'platform', 'v1', 'openapi.json'), 'utf8'),
);
const FROZEN = JSON.parse(
    readFileSync(join(__dirname, '..', 'contracts', 'platform', 'v1', 'frozen.json'), 'utf8'),
);

type Authority = 'anonymous' | 'authenticated' | 'elevated';
type ActorKind = 'jellyfin-user-client' | 'installed-provider' | 'companion-service';

type FrozenOperation = {
    path: string;
    method: string;
    operation: any;
    authority: Authority;
    actorKinds: ActorKind[];
};

type JellyfinApiKey = {
    AccessToken: string;
    AppName: string;
};

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

/** A generated-client-shaped reader: consume known response fields, ignore future ones. */
function readKnownResponse(payload: any, schema: any): any {
    return Object.fromEntries(
        Object.keys(schema.properties ?? {})
            .filter((name) => name in payload)
            .map((name) => [name, payload[name]]),
    );
}

/** The one operation the contract marks anonymous. */
function anonymousPath(): string {
    const entries = Object.entries<any>(CONTRACT.paths).filter(
        ([, operations]) => Array.isArray(operations.get?.security) && operations.get.security.length === 0,
    );

    expect(entries, 'the contract must declare exactly one anonymous operation').toHaveLength(1);
    return entries[0][0];
}

/** Every frozen operation, with authorization taken from its published extension. */
function frozenOperations(): FrozenOperation[] {
    const operations: FrozenOperation[] = [];
    for (const [path, methods] of Object.entries<string[]>(FROZEN.paths)) {
        for (const method of methods) {
            const operation = CONTRACT.paths[path]?.[method];
            expect(operation, `frozen operation ${method.toUpperCase()} ${path} must remain in the spec`).toBeDefined();
            expect(['get', 'post'], `the live matrix supports ${method.toUpperCase()} ${path}`).toContain(method);
            expect(
                ['anonymous', 'authenticated', 'elevated'],
                `${method.toUpperCase()} ${path} must publish x-canopy-authority`,
            ).toContain(operation['x-canopy-authority']);
            const actorKinds = operation['x-canopy-actor-kinds'];
            expect(Array.isArray(actorKinds), `${method.toUpperCase()} ${path} must publish x-canopy-actor-kinds`)
                .toBe(true);
            for (const actorKind of actorKinds) {
                expect(CONTRACT['x-canopy-actor-kind-vocabulary'], `${method.toUpperCase()} ${path} actor kind`)
                    .toContain(actorKind);
            }
            const key = `${method} ${path}`;
            expect(FROZEN.operationMetadata[key], `${key} must freeze authority metadata`).toEqual({
                authority: operation['x-canopy-authority'],
                actorKinds,
            });
            operations.push({
                path,
                method,
                operation,
                authority: operation['x-canopy-authority'] as Authority,
                actorKinds: actorKinds as ActorKind[],
            });
        }
    }

    const frozenInventory = operations
        .map(({ path, method }) => `${method.toUpperCase()} ${path}`)
        .sort();
    const specInventory = Object.entries<any>(CONTRACT.paths)
        .flatMap(([path, pathItem]) => Object.keys(pathItem)
            .filter(method => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
            .map(method => `${method.toUpperCase()} ${path}`))
        .sort();
    expect(frozenInventory, 'frozen.json and openapi.json must expose the same operation inventory')
        .toEqual(specInventory);
    expect(Object.keys(FROZEN.operationMetadata).sort(), 'every frozen operation must have exact authority metadata')
        .toEqual(Object.keys(FROZEN.paths).flatMap(path =>
            FROZEN.paths[path].map((method: string) => `${method} ${path}`)).sort());
    return operations;
}

function operationById(operationId: string): FrozenOperation {
    const matches = frozenOperations().filter(({ operation }) => operation.operationId === operationId);
    expect(matches, `contract operation ${operationId}`).toHaveLength(1);
    return matches[0];
}

function assertPlatformError(body: any, response: Response, code?: string): void {
    assertMatchesSchema(body, CONTRACT.components.schemas.PlatformError, `HTTP ${response.status}`);
    expect(body.Error).toBe(true);
    if (code) {
        expect(body.Code).toBe(code);
    }
    expect(body.CorrelationId).toBe(response.headers.get('x-correlation-id'));
}

async function rawBodyLength(response: Response): Promise<number> {
    return (await response.arrayBuffer()).byteLength;
}

/** Mint a short-lived Jellyfin API-key actor so Platform's first-party boundary can prove bare 403. */
async function createTemporaryApiKey(
    baseURL: string,
    adminToken: string,
    appName: string,
): Promise<JellyfinApiKey> {
    const created = await apiRaw(baseURL, `/Auth/Keys?app=${encodeURIComponent(appName)}`, adminToken, {
        method: 'POST',
    });
    expect(created.status, 'the elevated fixture must mint its temporary API key').toBe(204);

    const listed = await apiRaw(baseURL, '/Auth/Keys', adminToken);
    expect(listed.status, 'the elevated fixture must read back its temporary API key').toBe(200);
    const payload = await listed.json() as { Items?: JellyfinApiKey[] };
    const matches = (payload.Items ?? []).filter(key => key.AppName === appName && key.AccessToken);
    expect(matches, 'the elevated fixture must identify exactly its own temporary API key').toHaveLength(1);
    return matches[0];
}

async function revokeTemporaryApiKeys(baseURL: string, adminToken: string, appName: string): Promise<void> {
    const listed = await apiRaw(baseURL, '/Auth/Keys', adminToken);
    expect(listed.status, 'the elevated fixture cleanup must list temporary API keys').toBe(200);
    const payload = await listed.json() as { Items?: JellyfinApiKey[] };
    const owned = (payload.Items ?? []).filter(key => key.AppName === appName && key.AccessToken);
    for (const apiKey of owned) {
        const revoked = await apiRaw(
            baseURL,
            `/Auth/Keys/${encodeURIComponent(apiKey.AccessToken)}`,
            adminToken,
            { method: 'DELETE' },
        );
        expect(revoked.status, 'the elevated fixture must revoke every owned temporary API key').toBe(204);
    }
}

/** Node fetch supplies a wildcard Accept automatically; use the native transport to prove true absence. */
async function requestWithoutAccept(
    baseURL: string,
    path: string,
    token: string,
    method: string,
    body?: string,
): Promise<{ status: number; headers: Headers; body: Buffer }> {
    const target = new URL(baseURL);
    const basePath = target.pathname.replace(/\/+$/, '');
    const operationPath = path.startsWith('/') ? path : `/${path}`;
    target.pathname = `${basePath}${operationPath}`;
    target.search = '';
    target.hash = '';
    const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise((resolveRequest, rejectRequest) => {
        const outgoing = request(target, {
            method,
            headers: {
                Authorization: authHeader(token),
                'Content-Type': 'application/json',
            },
        }, incoming => {
            const chunks: Buffer[] = [];
            incoming.on('data', chunk => chunks.push(Buffer.from(chunk)));
            incoming.on('end', () => {
                const headers = new Headers();
                for (const [name, value] of Object.entries(incoming.headers)) {
                    if (Array.isArray(value)) {
                        for (const item of value) headers.append(name, item);
                    } else if (value !== undefined) {
                        headers.set(name, value);
                    }
                }
                resolveRequest({
                    status: incoming.statusCode ?? 0,
                    headers,
                    body: Buffer.concat(chunks),
                });
            });
        });
        outgoing.on('error', rejectRequest);
        outgoing.setTimeout(10_000, () => outgoing.destroy(new Error('absent-Accept request timed out')));
        if (body !== undefined) {
            outgoing.write(body);
        }
        outgoing.end();
    });
}

function dedicatedLogDirectory(): string {
    const ownedState = process.env.JF_E2E_STATE_DIR?.trim();
    return ownedState
        ? resolve(ownedState, 'config', 'log')
        : join(__dirname, 'docker', 'config', 'log');
}

/** Polls bounded files, bytes and time; never returns or prints log contents. */
async function dedicatedLogContainsCorrelation(correlationId: string): Promise<boolean> {
    const deadline = Date.now() + 10_000;
    const maximumFiles = 8;
    const maximumBytesPerFile = 1024 * 1024;

    do {
        try {
            const names = (await readdir(dedicatedLogDirectory()))
                .filter(name => /^JellyfinCanopy_.*\.log$/.test(name))
                .sort()
                .slice(-maximumFiles);
            for (const name of names) {
                const handle = await open(join(dedicatedLogDirectory(), name), 'r');
                try {
                    const stat = await handle.stat();
                    const length = Math.min(stat.size, maximumBytesPerFile);
                    const buffer = Buffer.alloc(length);
                    await handle.read(buffer, 0, length, Math.max(0, stat.size - length));
                    if (buffer.includes(Buffer.from(`CorrelationId=${correlationId}`, 'utf8'))) {
                        return true;
                    }
                } finally {
                    await handle.close();
                }
            }
        } catch (error: any) {
            if (error?.code !== 'ENOENT') {
                throw error;
            }
        }
        await new Promise(resolvePoll => setTimeout(resolvePoll, 200));
    } while (Date.now() < deadline);

    return false;
}

async function getJson(
    page: any,
    path: string,
    authenticated: boolean,
    conditionalHeaders: Record<string, string> = {},
): Promise<{ status: number; body: any; etag: string | null; bodyLength: number }> {
    return page.evaluate(
        async ({ target, withAuth, conditions }: {
            target: string;
            withAuth: boolean;
            conditions: Record<string, string>;
        }) => {
            const api = (window as any).ApiClient;
            const token = api.accessToken ? api.accessToken() : '';
            const headers: Record<string, string> = { ...conditions };

            if (withAuth) {
                // JF12 authenticates from the Authorization header; it dropped the
                // legacy query-string api_key.
                headers.Authorization = `MediaBrowser Token="${token}"`;
            }

            const res = await fetch(api.getUrl(target), { headers });
            const text = await res.text();

            return {
                status: res.status,
                body: text ? JSON.parse(text) : null,
                etag: res.headers.get('etag'),
                bodyLength: new TextEncoder().encode(text).byteLength,
            };
        },
        { target: path, withAuth: authenticated, conditions: conditionalHeaders },
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
        expect(discovery.etag, 'discovery must return a strong content validator')
            .toMatch(/^"sha256-[0-9a-f]{64}"$/);
        assertMatchesSchema(
            discovery.body,
            responseSchema(discoveryPath, 'get', '200'),
            `GET ${discoveryPath}`,
        );
        expect(discovery.body.Available).toBe(true);

        const cachedDiscovery = await getJson(page, discoveryPath, false, {
            'If-None-Match': `W/${discovery.etag!}`,
        });
        expect(cachedDiscovery.status, 'weak GET revalidation must round-trip through Jellyfin').toBe(304);
        expect(cachedDiscovery.etag).toBe(discovery.etag);
        expect(cachedDiscovery.bodyLength, '304 must have zero body bytes').toBe(0);
        expect(cachedDiscovery.body).toBeNull();

        // 2. Negotiate, using the range discovery just advertised. This is the
        //    handshake a real consumer performs, and the reason the two routes
        //    exist as a pair.
        const negotiatePath = operationById('negotiate').path;
        const parameters = CONTRACT.paths[negotiatePath].get.parameters.map((p: any) => p.name);
        expect(parameters).toEqual(expect.arrayContaining(['protocolMinimum', 'protocolMaximum']));

        const query = `?protocolMinimum=${discovery.body.ProtocolMinimum}&protocolMaximum=${discovery.body.ProtocolMaximum}`;
        const negotiated = await getJson(page, negotiatePath + query, true);

        expect(negotiated.status).toBe(200);
        expect(negotiated.etag, 'negotiation must return a strong content validator')
            .toMatch(/^"sha256-[0-9a-f]{64}"$/);
        assertMatchesSchema(
            negotiated.body,
            responseSchema(negotiatePath, 'get', '200'),
            `GET ${negotiatePath}`,
        );

        // A client offering exactly what discovery advertised must be compatible.
        // If this ever fails, the two routes disagree about the same server.
        expect(negotiated.body.Compatible).toBe(true);
        expect(negotiated.body.Protocol).toBe(discovery.body.ProtocolMaximum);

        const matchedNegotiation = await getJson(page, negotiatePath + query, true, {
            'If-Match': negotiated.etag!,
        });
        expect(matchedNegotiation.status, 'a matching strong validator must preserve the 200 response').toBe(200);
        expect(matchedNegotiation.etag).toBe(negotiated.etag);

        const staleValidator = '"sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"';
        const staleNegotiation = await getJson(page, negotiatePath + query, true, {
            'If-Match': staleValidator,
        });
        expect(staleNegotiation.status, 'a stale strong validator must fail closed').toBe(412);
        expect(staleNegotiation.etag).toBe(negotiated.etag);
        assertMatchesSchema(
            staleNegotiation.body,
            responseSchema(negotiatePath, 'get', '412'),
            `GET ${negotiatePath} stale If-Match`,
        );
        expect(staleNegotiation.body.Code).toBe('precondition_failed');

        // A real browser reports the deliberate 412 through both the URL-aware
        // response sink and a URL-less Chromium console line. Prove the exact
        // request provenance before acknowledging only that collected response,
        // then narrow only its matching console diagnostic at the final gate.
        const deliberatePreconditionFailures = consoleErrors.unexpected4xx().filter((failure) => {
            const url = new URL(failure.url);
            return failure.status === 412
                && failure.method === 'GET'
                && url.pathname.endsWith(negotiatePath)
                && url.search === query;
        });
        expect(deliberatePreconditionFailures, 'only the proved stale validator returns 412')
            .toHaveLength(1);
        const staleRequest = consoleErrors.requestFor(deliberatePreconditionFailures[0]);
        expect(staleRequest, 'the deliberate 412 retains its initiating browser request').toBeDefined();
        expect(staleRequest!.headers()['if-match']).toBe(staleValidator);
        consoleErrors.acknowledgeExpected4xx(deliberatePreconditionFailures);

        const expectedPreconditionConsole =
            /^Failed to load resource: the server responded with a status of 412 \(Precondition Failed\)$/i;
        expect(
            consoleErrors.realDetails().filter(
                detail => detail.source === 'console' && expectedPreconditionConsole.test(detail.text)
            ),
            'Chromium reports exactly the proved stale-validator response'
        ).toHaveLength(1);

        // Additive v1 evolution may put a property on a future host that this
        // contract-driven client does not know yet. Prove the reader preserves
        // every known field and ignores that injected future field.
        const negotiationSchema = responseSchema(negotiatePath, 'get', '200');
        const forwardPayload = { ...negotiated.body, FutureCapability: { version: 2 } };
        const forwardCompatible = readKnownResponse(forwardPayload, negotiationSchema);
        expect(forwardCompatible).toEqual(negotiated.body);
        expect(forwardCompatible.FutureCapability).toBeUndefined();

        // Enum sets also grow additively. A client must preserve an unfamiliar
        // response value so its default branch can treat the HTTP status class
        // as a generic failure; schema validation belongs on the server, not in
        // a forward-compatible response reader.
        const errorSchema = CONTRACT.components.schemas.PlatformError;
        const futureError = readKnownResponse({
            Error: true,
            Code: 'future_platform_code',
            Message: 'A newer host returned a code this client does not know.',
            Retryable: false,
            CorrelationId: '0123456789abcdef0123456789abcdef',
            FutureDetail: { revision: 2 },
        }, errorSchema);
        expect(futureError.Code).toBe('future_platform_code');
        expect(futureError.FutureDetail).toBeUndefined();

        assertNoRuntimeErrors({
            ...consoleErrors,
            real: () => consoleErrors.real().filter(
                text => !expectedPreconditionConsole.test(text)
            ),
            realDetails: () => consoleErrors.realDetails().filter(
                detail => !(detail.source === 'console'
                    && expectedPreconditionConsole.test(detail.text))
            ),
        });
    });

    test('every frozen operation enforces its published anonymous, authenticated, and elevated authority', async ({ baseURL }) => {
        const sessions = {
            anonymous: undefined,
            user: await authenticate(baseURL!, USERS.user.username, USERS.user.password),
            admin: await authenticate(baseURL!, USERS.admin.username, USERS.admin.password),
        };

        for (const frozen of frozenOperations()) {
            expect(frozen.actorKinds, `${frozen.method.toUpperCase()} ${frozen.path} actor policy`).toEqual(
                frozen.authority === 'anonymous' ? [] : ['jellyfin-user-client'],
            );
            expect(frozen.actorKinds).not.toContain('installed-provider');
            expect(frozen.actorKinds).not.toContain('companion-service');
            for (const [actor, session] of Object.entries(sessions)) {
                const allowed = frozen.authority === 'anonymous'
                    || (frozen.authority === 'authenticated' && actor !== 'anonymous')
                    || (frozen.authority === 'elevated' && actor === 'admin');
                const hasBody = Boolean(frozen.operation.requestBody);
                const response = await apiRaw(baseURL!, frozen.path, session?.token, {
                    method: frozen.method.toUpperCase(),
                    body: hasBody ? '{}' : undefined,
                });
                const where = `${actor} ${frozen.method.toUpperCase()} ${frozen.path}`;

                if (!allowed) {
                    const expectedStatus = actor === 'anonymous' ? 401 : 403;
                    expect(response.status, `${where} must fail at the exact host authorization boundary`)
                        .toBe(expectedStatus);
                    const documented = frozen.operation.responses[String(response.status)];
                    expect(documented, `${where} status must be documented`).toBeDefined();
                    const resolved = documented.$ref ? resolveRef(documented.$ref) : documented;
                    expect(resolved.content, `${where} must not promise a parseable auth body`).toBeUndefined();
                    expect(await rawBodyLength(response), `${where} must return exactly zero body bytes`).toBe(0);
                    expect(response.headers.get('content-type'), `${where} must not imply a body type`).toBeNull();
                    continue;
                }

                const expectedStatus = hasBody ? 400 : 200;
                expect(response.status, `${where} must pass authorization`).toBe(expectedStatus);
                const body = await response.json();
                if (expectedStatus === 400) {
                    assertPlatformError(body, response, 'invalid_request');
                }
            }
        }

        const authenticatedOperation = frozenOperations().find(frozen => frozen.authority === 'authenticated');
        expect(authenticatedOperation, 'the frozen matrix must contain an authenticated Platform operation').toBeDefined();
        const apiKeyAppName = `JC-EP01-${Date.now()}-${crypto.randomUUID()}`;
        try {
            const apiKey = await createTemporaryApiKey(baseURL!, sessions.admin!.token, apiKeyAppName);
            const forbidden = await apiRaw(baseURL!, authenticatedOperation!.path, apiKey.AccessToken, {
                method: authenticatedOperation!.method.toUpperCase(),
                body: authenticatedOperation!.operation.requestBody ? '{}' : undefined,
            });
            expect(forbidden.status, 'an API-key actor must fail at the Platform first-party boundary').toBe(403);
            expect(await rawBodyLength(forbidden), 'Platform 403 must return exactly zero body bytes').toBe(0);
            expect(forbidden.headers.get('content-type'), 'Platform 403 must not imply a body type').toBeNull();
        } finally {
            await revokeTemporaryApiKeys(baseURL!, sessions.admin!.token, apiKeyAppName);
        }
    });

    test('response content negotiation accepts JSON, wildcard, and absent Accept but rejects unsupported media', async ({ baseURL }) => {
        const admin = await authenticate(baseURL!, USERS.admin.username, USERS.admin.password);
        for (const frozen of frozenOperations()) {
            const hasBody = Boolean(frozen.operation.requestBody);
            for (const accept of ['application/json', '*/*']) {
                const response = await apiRaw(baseURL!, frozen.path, admin.token, {
                    method: frozen.method.toUpperCase(),
                    body: hasBody ? '{}' : undefined,
                    headers: { Accept: accept },
                });
                const where = `${frozen.method.toUpperCase()} ${frozen.path} Accept ${accept}`;
                expect(response.status, `${where} must not be rejected by negotiation`).toBe(hasBody ? 400 : 200);
                expect(response.headers.get('content-type')).toMatch(/^application\/json(?:;|$)/i);
                await response.json();
            }

            const absent = await requestWithoutAccept(
                baseURL!, frozen.path, admin.token, frozen.method.toUpperCase(), hasBody ? '{}' : undefined,
            );
            expect(absent.status, `${frozen.method.toUpperCase()} ${frozen.path} absent Accept`)
                .toBe(hasBody ? 400 : 200);
            expect(absent.headers.get('content-type')).toMatch(/^application\/json(?:;|$)/i);
            expect(() => JSON.parse(absent.body.toString('utf8'))).not.toThrow();

            expect(
                frozen.operation.responses['406'],
                `${frozen.method.toUpperCase()} ${frozen.path} must publish unsupported Accept`,
            ).toBeDefined();
            const unsupported = await apiRaw(baseURL!, frozen.path, admin.token, {
                method: frozen.method.toUpperCase(),
                body: hasBody ? '{}' : undefined,
                headers: { Accept: 'application/xml' },
            });
            expect(unsupported.status, `${frozen.method.toUpperCase()} ${frozen.path}`).toBe(406);
            assertPlatformError(await unsupported.json(), unsupported, 'not_acceptable');
        }
    });

    test('correlation id agrees across the live response body, header, and dedicated log', async ({ baseURL }) => {
        const invoke = operationById('invokeNativeAction');
        const admin = await authenticate(baseURL!, USERS.admin.username, USERS.admin.password);
        const response = await apiRaw(baseURL!, invoke.path, admin.token, {
            method: invoke.method.toUpperCase(),
            body: JSON.stringify({
                Capability: 'invalid-capability',
                IdempotencyKey: `correlation-${Date.now()}`,
                Answers: [],
            }),
        });

        expect(response.status).toBe(404);
        const body = await response.json();
        assertPlatformError(body, response, 'not_found');
        expect(body.CorrelationId).toMatch(/^[0-9a-f]{32}$/);
        expect(
            await dedicatedLogContainsCorrelation(body.CorrelationId),
            'the bounded dedicated-log poll must observe the response correlation id',
        ).toBe(true);
    });
});
