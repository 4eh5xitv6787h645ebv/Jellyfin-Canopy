// EP-08's native-pilot exit gate: drive the current Platform v1 catalog and
// opaque-action protocol over a real Jellyfin 12 HTTP host. Routes come from
// the checked-in contract so this fixture cannot silently test a prototype or
// legacy feature endpoint.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, USERS } from './fixtures/auth';
import { api, apiRaw, authenticate, PLUGIN_ID, type Session } from './fixtures/api';

/* eslint-disable @typescript-eslint/no-explicit-any */

const CONTRACT = JSON.parse(
    readFileSync(join(__dirname, '..', 'contracts', 'platform', 'v1', 'openapi.json'), 'utf8'),
);

type Contribution = {
    Id: string;
    Kind: 'action' | 'status';
    Label: string;
    Enabled?: boolean;
    PrepareHandle?: string;
};

type ResolvedSurface = {
    CatalogRevision: string;
    Contributions: Contribution[];
};

type PreparedAction = {
    Capability: string;
    ExpiresAtUtc: string;
    Title: string;
    Fields: Array<{
        Id: string;
        Kind: string;
        Required: boolean;
        DefaultChecked?: boolean;
        DefaultOptionIds: string[];
    }>;
};

type ActionAnswer = {
    FieldId: string;
    BooleanValue?: boolean;
    OptionIds?: string[];
};

const CLIENT = {
    ContributionKinds: ['action', 'status'],
    FieldKinds: ['confirmation', 'boolean', 'single_select', 'multi_select'],
    InputModes: ['dpad'],
    Accessibility: ['screen_reader'],
    Locale: 'en-AU',
};

function operationPath(operationId: string): string {
    const matches = Object.entries<any>(CONTRACT.paths).filter(([, methods]) =>
        Object.values<any>(methods).some(operation => operation.operationId === operationId),
    );
    expect(matches, `contract operation ${operationId}`).toHaveLength(1);
    return matches[0][0];
}

const RESOLVE_PATH = operationPath('resolveNativeItemDetail');
const PREPARE_PATH = operationPath('prepareNativeAction');
const INVOKE_PATH = operationPath('invokeNativeAction');
const DISCOVERY_PATH = operationPath('getDiscovery');
const NEGOTIATE_PATH = operationPath('negotiate');
const CONFIG_PATH = `/Plugins/${PLUGIN_ID}/Configuration`;

function canonicalGuid(value: string): string {
    const compact = value.replaceAll('-', '').toLowerCase();
    expect(compact).toMatch(/^[0-9a-f]{32}$/);
    return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

async function postJson<T>(
    baseURL: string,
    path: string,
    session: Session,
    body: unknown,
    expectedStatus = 200,
): Promise<T> {
    const response = await apiRaw(baseURL, path, session.token, {
        method: 'POST',
        body: JSON.stringify(body),
    });
    expect(response.status, `POST ${path}`).toBe(expectedStatus);
    const text = await response.text();
    return (text ? JSON.parse(text) : null) as T;
}

async function resolve(
    baseURL: string,
    session: Session,
    itemId: string,
    client: Record<string, unknown> = CLIENT,
): Promise<ResolvedSurface> {
    const result = await postJson<ResolvedSurface>(baseURL, RESOLVE_PATH, session, {
        Protocol: 1,
        SurfaceSchema: 1,
        Item: { Id: canonicalGuid(itemId) },
        Client: client,
    });
    expect(result.CatalogRevision).toMatch(/^[A-Za-z0-9_.-]+$/);
    expect(result.Contributions.length).toBeLessThanOrEqual(7);
    expect(new Set(result.Contributions.map(row => row.Id)).size).toBe(result.Contributions.length);
    expect(JSON.stringify(result)).not.toContain('jc-e2e-seerr');
    expect(JSON.stringify(result)).not.toContain('http://integrations');
    return result;
}

function contribution(surface: ResolvedSurface, id: string): Contribution {
    const matches = surface.Contributions.filter(row => row.Id === id);
    expect(matches, `contribution ${id}`).toHaveLength(1);
    return matches[0];
}

function optionalContribution(surface: ResolvedSurface, id: string): Contribution | undefined {
    return surface.Contributions.find(row => row.Id === id);
}

async function prepare(
    baseURL: string,
    session: Session,
    action: Contribution,
): Promise<PreparedAction> {
    expect(action.Kind).toBe('action');
    expect(action.Enabled).toBe(true);
    expect(action.PrepareHandle).toBeTruthy();
    const prepared = await postJson<PreparedAction>(baseURL, PREPARE_PATH, session, {
        PrepareHandle: action.PrepareHandle,
    });
    expect(Date.parse(prepared.ExpiresAtUtc)).toBeGreaterThan(Date.now());
    expect(prepared.Fields.length).toBeLessThanOrEqual(8);
    return prepared;
}

async function invoke(
    baseURL: string,
    session: Session,
    prepared: PreparedAction,
    idempotencyKey: string,
    answers: ActionAnswer[],
): Promise<any> {
    return postJson<any>(baseURL, INVOKE_PATH, session, {
        Capability: prepared.Capability,
        IdempotencyKey: idempotencyKey,
        Answers: answers,
    });
}

async function configureBoolean(
    baseURL: string,
    session: Session,
    itemId: string,
    contributionId: string,
    answers: ActionAnswer[],
): Promise<any> {
    const surface = await resolve(baseURL, session, itemId);
    const prepared = await prepare(baseURL, session, contribution(surface, contributionId));
    return invoke(
        baseURL,
        session,
        prepared,
        `${contributionId}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        answers,
    );
}

async function jellyfinMovie(baseURL: string, session: Session): Promise<any> {
    const response = await apiRaw(
        baseURL,
        `/Items?IncludeItemTypes=Movie&Recursive=true&Limit=100&Fields=ProviderIds&userId=${session.userId}`,
        session.token,
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { Items: any[] };
    const movie = body.Items.find(item => item.ProviderIds?.Tmdb === '10334')
        ?? body.Items.find(item => Boolean(item.ProviderIds?.Tmdb));
    expect(movie, 'seeded server exposes a provider-backed movie').toBeTruthy();
    return movie;
}

test.describe.serial('Platform v1 native pilot — live Jellyfin 12', () => {
    test('admin disable is immediate, preserves bare auth, and reenable revokes old native authority', async ({ baseURL }) => {
        const admin = await authenticate(baseURL!, USERS.admin.username, USERS.admin.password);
        const original = await api<Record<string, unknown>>(baseURL!, CONFIG_PATH, admin.token);
        expect(original).toBeTruthy();

        const save = (enabled: boolean) => api(baseURL!, CONFIG_PATH, admin.token, {
            method: 'POST',
            body: JSON.stringify({ ...original, PlatformEnabled: enabled }),
        });

        try {
            await save(true);
            const available = await apiRaw(baseURL!, DISCOVERY_PATH);
            expect(available.status).toBe(200);
            const availableTag = available.headers.get('etag');
            expect(availableTag).toMatch(/^"sha256-[0-9a-f]{64}"$/);
            expect((await available.json() as any).Available).toBe(true);

            const movie = await jellyfinMovie(baseURL!, admin);
            const surface = await resolve(baseURL!, admin, movie.Id);
            const action = contribution(surface, 'hidden-content-configure');
            const prepared = await prepare(baseURL!, admin, action);

            await save(false);

            const disabled = await apiRaw(baseURL!, DISCOVERY_PATH, undefined, {
                headers: { 'If-None-Match': availableTag! },
            });
            expect(disabled.status).toBe(200);
            expect(disabled.headers.get('cache-control')).toContain('no-store');
            expect(disabled.headers.get('etag')).not.toBe(availableTag);
            const disabledTag = disabled.headers.get('etag');
            const disabledBody = await disabled.json() as any;
            expect(disabledBody).toEqual({
                Available: false,
                ProtocolMinimum: 1,
                ProtocolMaximum: 1,
            });

            const negotiate = await apiRaw(
                baseURL!,
                `${NEGOTIATE_PATH}?protocolMinimum=1&protocolMaximum=1`,
                admin.token,
            );
            expect(negotiate.status).toBe(503);
            expect(negotiate.headers.get('cache-control')).toContain('no-store');
            const unavailable = await negotiate.json() as any;
            expect(unavailable).toMatchObject({
                Error: true,
                Code: 'unavailable',
                Retryable: true,
            });
            expect(unavailable.CorrelationId).toBe(negotiate.headers.get('x-correlation-id'));

            const gatedResolve = await apiRaw(baseURL!, RESOLVE_PATH, admin.token, {
                method: 'POST',
                body: JSON.stringify({
                    Protocol: 1,
                    SurfaceSchema: 1,
                    Item: { Id: canonicalGuid(movie.Id) },
                    Client: CLIENT,
                }),
            });
            expect(gatedResolve.status).toBe(503);

            const anonymous = await apiRaw(baseURL!, NEGOTIATE_PATH);
            expect([401, 403]).toContain(anonymous.status);
            expect(await anonymous.text()).toBe('');

            await save(true);
            const reenabled = await apiRaw(baseURL!, DISCOVERY_PATH, undefined, {
                headers: { 'If-None-Match': disabledTag! },
            });
            expect(reenabled.status).toBe(200);
            expect((await reenabled.json() as any).Available).toBe(true);

            await postJson<null>(baseURL!, PREPARE_PATH, admin, {
                PrepareHandle: action.PrepareHandle,
            }, 404);
            await postJson<null>(baseURL!, INVOKE_PATH, admin, {
                Capability: prepared.Capability,
                IdempotencyKey: `platform-reenabled-${Date.now()}`,
                Answers: [],
            }, 404);
            await resolve(baseURL!, admin, movie.Id);
        } finally {
            await api(baseURL!, CONFIG_PATH, admin.token, {
                method: 'POST',
                body: JSON.stringify(original),
            });
        }
    });

    test('Spoiler Guard, Hidden Content, and Seerr complete through generic opaque actions', async ({ baseURL }) => {
        const admin = await authenticate(baseURL!, USERS.admin.username, USERS.admin.password);
        const user = await authenticate(baseURL!, USERS.user.username, USERS.user.password);
        const movie = await jellyfinMovie(baseURL!, admin);
        const itemId = movie.Id as string;

        const originalDtoResponse = await apiRaw(
            baseURL!,
            `/Users/${admin.userId}/Items/${itemId}?Fields=ProviderIds`,
            admin.token,
        );
        expect(originalDtoResponse.status).toBe(200);
        const originalDto = await originalDtoResponse.json() as any;
        const uniqueTmdb = String(1_500_000_000 + (Date.now() % 100_000_000));
        const patchedDto = structuredClone(originalDto);
        patchedDto.ProviderIds = { ...(patchedDto.ProviderIds ?? {}), Tmdb: uniqueTmdb };

        const patch = await apiRaw(baseURL!, `/Items/${itemId}`, admin.token, {
            method: 'POST',
            body: JSON.stringify(patchedDto),
        });
        expect(patch.status).toBe(204);

        let spoilerEnabled = false;
        let hidden = false;
        try {
            const initial = await resolve(baseURL!, admin, itemId);
            expect(initial.Contributions.map(row => row.Id)).toEqual(expect.arrayContaining([
                'spoiler-guard-status',
                'spoiler-guard-configure',
                'hidden-content-status',
                'hidden-content-configure',
                'seerr-request',
            ]));

            // Opaque prepare handles are actor-bound even when both users may
            // access the same Jellyfin item.
            const adminSpoiler = contribution(initial, 'spoiler-guard-configure');
            await postJson<null>(baseURL!, PREPARE_PATH, user, {
                PrepareHandle: adminSpoiler.PrepareHandle,
            }, 404);

            // Spoiler Guard: prepare the bounded boolean form, mutate, observe
            // normal-item refresh hints, resolve the new status, then restore.
            const spoilerPrepared = await prepare(baseURL!, admin, adminSpoiler);
            expect(spoilerPrepared.Fields.map(field => [field.Id, field.Kind]))
                .toEqual([['enabled', 'boolean']]);
            const spoilerResult = await invoke(
                baseURL!, admin, spoilerPrepared, `spoiler-on-${uniqueTmdb}`,
                [{ FieldId: 'enabled', BooleanValue: true }],
            );
            spoilerEnabled = true;
            expect(spoilerResult.Outcome).toBe('succeeded');
            expect(spoilerResult.Refresh.Targets).toEqual(expect.arrayContaining([
                'jellyfin_item',
                'item_detail_surface',
            ]));
            expect(contribution(await resolve(baseURL!, admin, itemId), 'spoiler-guard-status').Label)
                .toBe('Spoiler Guard: protected');

            await configureBoolean(
                baseURL!, admin, itemId, 'spoiler-guard-configure',
                [{ FieldId: 'enabled', BooleanValue: false }],
            );
            spoilerEnabled = false;
            expect(contribution(await resolve(baseURL!, admin, itemId), 'spoiler-guard-status').Label)
                .toBe('Spoiler Guard: unprotected');

            // Hidden Content: both fields are server supplied. Global hiding
            // changes the ordinary Jellyfin item response, while the platform
            // owner can still re-authorize the exact item to offer unhide.
            const hiddenPrepared = await prepare(
                baseURL!, admin, contribution(await resolve(baseURL!, admin, itemId), 'hidden-content-configure'),
            );
            expect(hiddenPrepared.Fields.map(field => [field.Id, field.Kind]))
                .toEqual([['hidden', 'boolean'], ['scope', 'single_select']]);
            const hiddenResult = await invoke(
                baseURL!, admin, hiddenPrepared, `hidden-on-${uniqueTmdb}`,
                [
                    { FieldId: 'hidden', BooleanValue: true },
                    { FieldId: 'scope', OptionIds: ['global'] },
                ],
            );
            hidden = true;
            expect(hiddenResult.Outcome).toBe('succeeded');
            const hiddenSurface = await resolve(baseURL!, admin, itemId);
            expect(contribution(hiddenSurface, 'hidden-content-status').Label)
                .toBe('Hidden Content: hidden (all surfaces)');

            const ordinaryHidden = await apiRaw(
                baseURL!,
                `/Items?IncludeItemTypes=Movie&Recursive=true&Limit=100&userId=${admin.userId}`,
                admin.token,
            );
            expect(ordinaryHidden.status).toBe(200);
            const ordinaryHiddenBody = await ordinaryHidden.json() as { Items: Array<{ Id: string }> };
            expect(ordinaryHiddenBody.Items.map(item => item.Id)).not.toContain(itemId);

            await configureBoolean(
                baseURL!, admin, itemId, 'hidden-content-configure',
                [
                    { FieldId: 'hidden', BooleanValue: false },
                    { FieldId: 'scope', OptionIds: ['global'] },
                ],
            );
            hidden = false;
            expect(contribution(await resolve(baseURL!, admin, itemId), 'hidden-content-status').Label)
                .toBe('Hidden Content: visible');

            // Seerr: Android sees only one server-approved confirmation. The
            // same exact body replays semantically; status refresh then removes
            // the no-longer-authorized Request action without leaking secrets.
            const seerrPrepared = await prepare(
                baseURL!, admin, contribution(await resolve(baseURL!, admin, itemId), 'seerr-request'),
            );
            expect(seerrPrepared.Fields.map(field => [field.Id, field.Kind, field.Required]))
                .toEqual([['confirm', 'confirmation', true]]);
            const seerrBody = {
                Capability: seerrPrepared.Capability,
                IdempotencyKey: `seerr-${uniqueTmdb}`,
                Answers: [{ FieldId: 'confirm', BooleanValue: true }],
            };
            const requested = await postJson<any>(baseURL!, INVOKE_PATH, admin, seerrBody);
            const replayed = await postJson<any>(baseURL!, INVOKE_PATH, admin, seerrBody);
            expect(replayed).toEqual(requested);
            expect(requested.Outcome).toBe('succeeded');

            const requestedSurface = await resolve(baseURL!, admin, itemId);
            expect(contribution(requestedSurface, 'seerr-status').Label).toContain('pending');
            expect(optionalContribution(requestedSurface, 'seerr-request')).toBeUndefined();

            // Provider request state is scoped to the mapped Jellyfin user.
            const otherUserSurface = await resolve(baseURL!, user, itemId);
            expect(optionalContribution(otherUserSurface, 'seerr-request')).toBeDefined();
        } finally {
            if (hidden) {
                await configureBoolean(
                    baseURL!, admin, itemId, 'hidden-content-configure',
                    [
                        { FieldId: 'hidden', BooleanValue: false },
                        { FieldId: 'scope', OptionIds: ['global'] },
                    ],
                );
            }
            if (spoilerEnabled) {
                await configureBoolean(
                    baseURL!, admin, itemId, 'spoiler-guard-configure',
                    [{ FieldId: 'enabled', BooleanValue: false }],
                );
            }
            const currentDtoResponse = await apiRaw(
                baseURL!,
                `/Users/${admin.userId}/Items/${itemId}?Fields=ProviderIds`,
                admin.token,
            );
            expect(currentDtoResponse.status).toBe(200);
            const restoredDto = await currentDtoResponse.json() as any;
            restoredDto.ProviderIds = originalDto.ProviderIds;
            const restore = await apiRaw(baseURL!, `/Items/${itemId}`, admin.token, {
                method: 'POST',
                body: JSON.stringify(restoredDto),
            });
            expect(restore.status).toBe(204);
        }
    });

    test('unsupported input mode and protocol fail closed without owner state', async ({ baseURL }) => {
        const admin = await authenticate(baseURL!, USERS.admin.username, USERS.admin.password);
        const movie = await jellyfinMovie(baseURL!, admin);
        const noDpad = await resolve(baseURL!, admin, movie.Id, {
            ...CLIENT,
            InputModes: [],
        });
        expect(noDpad.Contributions).toEqual([]);

        await postJson<null>(baseURL!, RESOLVE_PATH, admin, {
            Protocol: 2,
            SurfaceSchema: 1,
            Item: { Id: canonicalGuid(movie.Id) },
            Client: CLIENT,
        }, 400);
    });

    test('a live parental-policy revocation invalidates an already-prepared Seerr capability', async ({ baseURL }) => {
        const admin = await authenticate(baseURL!, USERS.admin.username, USERS.admin.password);
        const user = await authenticate(baseURL!, USERS.user.username, USERS.user.password);
        const movie = await jellyfinMovie(baseURL!, admin);
        const itemId = movie.Id as string;

        const dtoResponse = await apiRaw(
            baseURL!,
            `/Users/${admin.userId}/Items/${itemId}?Fields=ProviderIds`,
            admin.token,
        );
        expect(dtoResponse.status).toBe(200);
        const originalDto = await dtoResponse.json() as any;

        const userResponse = await apiRaw(baseURL!, `/Users/${user.userId}`, admin.token);
        expect(userResponse.status).toBe(200);
        const userRecord = await userResponse.json() as any;
        const originalPolicy = structuredClone(userRecord.Policy);

        const patchedDto = structuredClone(originalDto);
        patchedDto.ProviderIds = { ...(patchedDto.ProviderIds ?? {}), Tmdb: '293660' };
        const patchItem = await apiRaw(baseURL!, `/Items/${itemId}`, admin.token, {
            method: 'POST',
            body: JSON.stringify(patchedDto),
        });
        expect(patchItem.status).toBe(204);

        try {
            const prepared = await prepare(
                baseURL!, user, contribution(await resolve(baseURL!, user, itemId), 'seerr-request'),
            );

            const restrictedPolicy = structuredClone(originalPolicy);
            restrictedPolicy.MaxParentalRating = 13;
            const restrict = await apiRaw(baseURL!, `/Users/${user.userId}/Policy`, admin.token, {
                method: 'POST',
                body: JSON.stringify(restrictedPolicy),
            });
            expect(restrict.status).toBe(204);

            await postJson<null>(baseURL!, INVOKE_PATH, user, {
                Capability: prepared.Capability,
                IdempotencyKey: `revoked-parental-${Date.now()}`,
                Answers: [{ FieldId: 'confirm', BooleanValue: true }],
            }, 404);
        } finally {
            const restorePolicy = await apiRaw(baseURL!, `/Users/${user.userId}/Policy`, admin.token, {
                method: 'POST',
                body: JSON.stringify(originalPolicy),
            });
            expect(restorePolicy.status).toBe(204);

            const currentDtoResponse = await apiRaw(
                baseURL!,
                `/Users/${admin.userId}/Items/${itemId}?Fields=ProviderIds`,
                admin.token,
            );
            expect(currentDtoResponse.status).toBe(200);
            const restoredDto = await currentDtoResponse.json() as any;
            restoredDto.ProviderIds = originalDto.ProviderIds;
            const restoreItem = await apiRaw(baseURL!, `/Items/${itemId}`, admin.token, {
                method: 'POST',
                body: JSON.stringify(restoredDto),
            });
            expect(restoreItem.status).toBe(204);
        }
    });
});
