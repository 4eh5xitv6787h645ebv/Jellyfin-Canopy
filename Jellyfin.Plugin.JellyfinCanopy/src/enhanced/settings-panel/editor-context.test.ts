/* eslint-disable @typescript-eslint/require-await -- async API fakes mirror the production contract */
/* eslint-disable @typescript-eslint/unbound-method -- tests preserve host methods and assert Vitest mocks */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import {
    AdminTargetPersistenceError,
    createPanelEditorContext,
} from './editor-context';

const ACTOR = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TARGET = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

const originalApi = JC.core.api;
const originalGetCurrentUser = ApiClient.getCurrentUser;
const originalGetCurrentUserId = ApiClient.getCurrentUserId;
const originalServerId = ApiClient.serverId;
const originalTransform = JC.transformUserFileCase;

function convert(value: unknown, pascal: boolean): unknown {
    if (Array.isArray(value)) return value.map(item => convert(item, pascal));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => {
        const converted = pascal
            ? key.charAt(0).toUpperCase() + key.slice(1)
            : key.charAt(0).toLowerCase() + key.slice(1);
        return [converted, convert(child, pascal)];
    }));
}

function envelope(
    file: 'settings.json' | 'shortcuts.json',
    revision: number,
    data: Record<string, unknown>,
    hash = HASH_A,
): Record<string, unknown> {
    return {
        Success: true,
        File: file,
        Revision: revision,
        ContentHash: hash,
        Data: { ...data, Revision: revision },
        TargetUserId: TARGET,
        TargetDisplayName: 'Target <User>',
    };
}

function conflictEnvelope(
    file: 'settings.json' | 'shortcuts.json',
    revision: number,
    data: Record<string, unknown>,
    hash = HASH_B,
): Record<string, unknown> {
    return {
        Success: false,
        Conflict: true,
        File: file,
        Revision: revision,
        ContentHash: hash,
        Data: { ...data, Revision: revision },
        TargetUserId: TARGET,
        TargetDisplayName: 'Target <User>',
    };
}

function installApi(handler: (path: string, options?: Record<string, unknown>) => Promise<unknown>) {
    JC.core.api = {
        plugin: vi.fn(handler),
    } as unknown as NonNullable<typeof JC.core.api>;
    return JC.core.api.plugin as ReturnType<typeof vi.fn>;
}

async function openTarget(handler?: (path: string, options?: Record<string, unknown>) => Promise<unknown>) {
    const plugin = installApi(handler || (async (path) => path.includes('settings.json')
        ? envelope('settings.json', 1, {
            AutoPauseEnabled: true,
            PauseScreenDelaySeconds: 5,
            ExtensionValue: { Nested: 'preserved' },
            IsAdmin: false,
        })
        : envelope('shortcuts.json', 4, {
            Shortcuts: [{ Name: 'play', Key: 'P' }],
            ExtensionValue: 'preserved',
        }, HASH_B)));
    const actor = JC.identity.capture()!;
    const controller = new AbortController();
    const editor = await createPanelEditorContext({
        actor,
        requestedTargetUserId: TARGET,
        signal: controller.signal,
        isLaunchCurrent: () => true,
    });
    return { editor, plugin, controller };
}

describe('admin target settings editor isolation', () => {
    beforeEach(() => {
        JC.identity.transition('server-a', ACTOR, 'admin-target-editor-test');
        ApiClient.getCurrentUserId = () => ACTOR;
        ApiClient.serverId = () => 'server-a';
        ApiClient.getCurrentUser = () => Promise.resolve({
            Id: ACTOR,
            Policy: { IsAdministrator: true },
        });
        JC.transformUserFileCase = (_file, value, direction) =>
            convert(value, direction === 'save');
        JC.pluginConfig = {
            Shortcuts: [
                { Name: 'play', Key: 'Space' },
                { Name: 'search', Key: 'S' },
            ],
        };
        JC.currentSettings = { actorOnly: 'unchanged', autoPauseEnabled: false };
        JC.userConfig = {
            settings: { ActorOnly: 'unchanged', Revision: 8 },
            shortcuts: { Shortcuts: [{ Name: 'search', Key: 'A' }], Revision: 7 },
        };
        JC.state = {
            activeShortcuts: { play: 'Space', search: 'A' },
        } as unknown as NonNullable<typeof JC.state>;
    });

    afterEach(() => {
        JC.core.api = originalApi;
        ApiClient.getCurrentUser = originalGetCurrentUser;
        ApiClient.getCurrentUserId = originalGetCurrentUserId;
        ApiClient.serverId = originalServerId;
        JC.transformUserFileCase = originalTransform;
        vi.restoreAllMocks();
    });

    it('uses self mode without a target and does not call an admin endpoint', async () => {
        const plugin = installApi(async () => {
            throw new Error('must not fetch');
        });
        const actor = JC.identity.capture()!;
        const editor = await createPanelEditorContext({
            actor,
            signal: new AbortController().signal,
            isLaunchCurrent: () => true,
        });

        expect(editor.mode).toBe('self');
        expect(editor.settings).toBe(JC.currentSettings);
        expect(editor.shortcuts).toBe(JC.userConfig!.shortcuts);
        expect(plugin).not.toHaveBeenCalled();
    });

    it('treats an explicit dashed self target as self mode', async () => {
        const plugin = installApi(async () => {
            throw new Error('must not fetch');
        });
        const actor = JC.identity.capture()!;
        const dashed = `${ACTOR.slice(0, 8)}-${ACTOR.slice(8, 12)}-${ACTOR.slice(12, 16)}-${ACTOR.slice(16, 20)}-${ACTOR.slice(20)}`;
        const editor = await createPanelEditorContext({
            actor,
            requestedTargetUserId: dashed,
            signal: new AbortController().signal,
            isLaunchCurrent: () => true,
        });

        expect(editor.mode).toBe('self');
        expect(plugin).not.toHaveBeenCalled();
    });

    it('fails closed before a cross-user request for a non-admin actor', async () => {
        ApiClient.getCurrentUser = () => Promise.resolve({
            Id: ACTOR,
            Policy: { IsAdministrator: false },
        });
        const plugin = installApi(async () => {
            throw new Error('must not fetch');
        });
        const actor = JC.identity.capture()!;

        await expect(createPanelEditorContext({
            actor,
            requestedTargetUserId: TARGET,
            signal: new AbortController().signal,
            isLaunchCurrent: () => true,
        })).rejects.toMatchObject({ kind: 'authorization', status: 403 });
        expect(plugin).not.toHaveBeenCalled();
    });

    it('rejects a stale admin user object for a different actor before target reads', async () => {
        ApiClient.getCurrentUser = () => Promise.resolve({
            Id: TARGET,
            Policy: { IsAdministrator: true },
        });
        const plugin = installApi(async () => {
            throw new Error('must not fetch');
        });

        await expect(createPanelEditorContext({
            actor: JC.identity.capture()!,
            requestedTargetUserId: TARGET,
            signal: new AbortController().signal,
            isLaunchCurrent: () => true,
        })).rejects.toMatchObject({ kind: 'authorization', status: 403 });
        expect(plugin).not.toHaveBeenCalled();
    });

    it('rejects a stale live ApiClient actor before privilege or target reads', async () => {
        ApiClient.getCurrentUserId = () => 'cccccccccccccccccccccccccccccccc';
        const currentUser = vi.fn(ApiClient.getCurrentUser);
        ApiClient.getCurrentUser = currentUser;
        const plugin = installApi(async () => {
            throw new Error('must not fetch');
        });

        await expect(createPanelEditorContext({
            actor: JC.identity.capture()!,
            requestedTargetUserId: TARGET,
            signal: new AbortController().signal,
            isLaunchCurrent: () => true,
        })).rejects.toMatchObject({ kind: 'authorization' });
        expect(currentUser).not.toHaveBeenCalled();
        expect(plugin).not.toHaveBeenCalled();
    });

    it('rejects a same-user live server mismatch before privilege or target reads', async () => {
        ApiClient.serverId = () => 'server-b';
        const currentUser = vi.fn(ApiClient.getCurrentUser);
        ApiClient.getCurrentUser = currentUser;
        const plugin = installApi(async () => {
            throw new Error('must not fetch');
        });

        await expect(createPanelEditorContext({
            actor: JC.identity.capture()!,
            requestedTargetUserId: TARGET,
            signal: new AbortController().signal,
            isLaunchCurrent: () => true,
        })).rejects.toMatchObject({ kind: 'authorization', status: 403 });
        expect(currentUser).not.toHaveBeenCalled();
        expect(plugin).not.toHaveBeenCalled();
    });

    it('classifies an active elevated target read failure for localized panel handling', async () => {
        const plugin = installApi(async () => {
            throw Object.assign(new Error('forbidden'), { status: 403 });
        });

        await expect(createPanelEditorContext({
            actor: JC.identity.capture()!,
            requestedTargetUserId: TARGET,
            signal: new AbortController().signal,
            isLaunchCurrent: () => true,
        })).rejects.toMatchObject({ kind: 'authorization', status: 403 });
        expect(plugin).toHaveBeenCalledTimes(2);
    });

    it('classifies a stale privilege preflight as cancellation, not authorization', async () => {
        let resolveUser!: (value: unknown) => void;
        ApiClient.getCurrentUser = () => new Promise(resolve => { resolveUser = resolve; });
        let launchCurrent = true;
        const plugin = installApi(async () => {
            throw new Error('must not fetch');
        });
        const opening = createPanelEditorContext({
            actor: JC.identity.capture()!,
            requestedTargetUserId: TARGET,
            signal: new AbortController().signal,
            isLaunchCurrent: () => launchCurrent,
        });
        launchCurrent = false;
        resolveUser({ Policy: { IsAdministrator: true } });

        await expect(opening).rejects.toMatchObject({ kind: 'cancelled' });
        expect(plugin).not.toHaveBeenCalled();
    });

    it('classifies an active privilege lookup failure as unavailable without fetching a target', async () => {
        ApiClient.getCurrentUser = () => Promise.reject(
            Object.assign(new Error('user directory unavailable'), { status: 503 }),
        );
        const plugin = installApi(async () => {
            throw new Error('must not fetch');
        });

        await expect(createPanelEditorContext({
            actor: JC.identity.capture()!,
            requestedTargetUserId: TARGET,
            signal: new AbortController().signal,
            isLaunchCurrent: () => true,
        })).rejects.toMatchObject({ kind: 'unavailable', status: 503 });
        expect(plugin).not.toHaveBeenCalled();
    });

    it('loads both target files without changing any actor-owned global', async () => {
        const actorSnapshot = JSON.stringify({
            currentSettings: JC.currentSettings,
            userConfig: JC.userConfig,
            activeShortcuts: JC.state!.activeShortcuts,
        });
        const { editor, plugin } = await openTarget();

        expect(editor.mode).toBe('admin-target');
        expect(editor.targetDisplayName).toBe('Target <User>');
        expect(editor.settings).toMatchObject({
            autoPauseEnabled: true,
            pauseScreenDelaySeconds: 5,
            extensionValue: { nested: 'preserved' },
            isAdmin: false,
        });
        expect(editor.shortcuts.Shortcuts).toEqual([{ Name: 'play', Key: 'P' }]);
        expect(editor.activeShortcuts).toEqual({ play: 'P', search: 'S' });
        expect(plugin).toHaveBeenCalledTimes(2);
        expect(JSON.stringify({
            currentSettings: JC.currentSettings,
            userConfig: JC.userConfig,
            activeShortcuts: JC.state!.activeShortcuts,
        })).toBe(actorSnapshot);
    });

    it.each([
        ['empty-string', ''],
        ['boolean', false],
    ])('rejects a %s revision in an initial target envelope', async (
        _case,
        badRevision,
    ) => {
        await expect(openTarget(async path => {
            const response = path.includes('settings.json')
                ? envelope('settings.json', 1, { AutoPauseEnabled: true })
                : envelope('shortcuts.json', 1, { Shortcuts: [] }, HASH_B);
            if (path.includes('settings.json')) {
                response.Revision = badRevision;
                (response.Data as Record<string, unknown>).Revision = badRevision;
            }
            return response;
        })).rejects.toMatchObject({ kind: 'protocol' });
    });

    it.each([
        ['empty-string', ''],
        ['boolean', false],
    ])('evidence-checks rather than accepting a POST acknowledgement with a %s revision', async (
        _case,
        badRevision,
    ) => {
        let posts = 0;
        let evidenceReads = 0;
        const { editor } = await openTarget(async (path, options) => {
            if (!options?.method && path.includes('/evidence')) {
                evidenceReads++;
                throw Object.assign(new Error('evidence unavailable'), { status: 503 });
            }
            if (!options?.method) {
                return path.includes('settings.json')
                    ? envelope('settings.json', 1, { AutoPauseEnabled: true })
                    : envelope('shortcuts.json', 1, { Shortcuts: [] }, HASH_B);
            }
            posts++;
            const response = envelope(
                'settings.json',
                2,
                options.body as Record<string, unknown>,
                HASH_C,
            );
            response.Revision = badRevision;
            (response.Data as Record<string, unknown>).Revision = badRevision;
            return response;
        });
        (editor.settings as Record<string, unknown>).autoPauseEnabled = false;

        await expect(editor.saveSettings()).rejects.toMatchObject({
            kind: 'unavailable',
            ambiguous: true,
        });
        expect(posts).toBe(1);
        expect(evidenceReads).toBe(1);
        expect((editor.settings as Record<string, unknown>).autoPauseEnabled).toBe(true);
    });

    it.each([
        ['empty-string', ''],
        ['boolean', false],
    ])('rejects a 409 envelope with a %s revision before any safe rebase', async (
        _case,
        badRevision,
    ) => {
        let posts = 0;
        let evidenceReads = 0;
        const { editor } = await openTarget(async (path, options) => {
            if (!options?.method && path.includes('/evidence')) {
                evidenceReads++;
                throw Object.assign(new Error('evidence unavailable'), { status: 503 });
            }
            if (!options?.method) {
                return path.includes('settings.json')
                    ? envelope('settings.json', 1, { AutoPauseEnabled: true })
                    : envelope('shortcuts.json', 1, { Shortcuts: [] }, HASH_B);
            }
            posts++;
            const response = conflictEnvelope('settings.json', 2, {
                AutoPauseEnabled: true,
                RemoteField: 'must-not-rebase',
            });
            response.Revision = badRevision;
            (response.Data as Record<string, unknown>).Revision = badRevision;
            throw Object.assign(new Error('malformed conflict'), {
                status: 409,
                responseJSON: response,
            });
        });
        (editor.settings as Record<string, unknown>).autoPauseEnabled = false;

        await expect(editor.saveSettings()).rejects.toMatchObject({
            kind: 'unavailable',
            ambiguous: true,
        });
        expect(posts).toBe(1);
        expect(evidenceReads).toBe(1);
        expect(editor.settings).not.toHaveProperty('remoteField');
    });

    it('posts target settings with If-Match and leaves actor settings unchanged', async () => {
        const actorSnapshot = JSON.stringify(JC.currentSettings);
        const calls: Array<{ path: string; options?: Record<string, unknown> }> = [];
        const { editor } = await openTarget(async (path, options) => {
            calls.push({ path, options });
            if (!options?.method) {
                return path.includes('settings.json')
                    ? envelope('settings.json', 1, {
                        AutoPauseEnabled: true,
                        PauseScreenDelaySeconds: 5,
                        LastOpenedTab: '',
                        FutureSetting: {
                            nestedKey: [{ MiXeDKey: 'preserve-exactly' }],
                        },
                        vendorFlag: {
                            lower_child: true,
                        },
                    })
                    : envelope('shortcuts.json', 1, { Shortcuts: [] }, HASH_B);
            }
            const body = options.body as Record<string, unknown>;
            return envelope('settings.json', 2, body, HASH_C);
        });

        (editor.settings as Record<string, unknown>).autoPauseEnabled = false;
        await expect(editor.saveSettings()).resolves.toMatchObject({
            acknowledged: true,
            revision: 2,
        });

        const post = calls.find(call => call.options?.method === 'POST')!;
        expect(post.path).toBe(`/admin/user-settings/${TARGET}/settings.json`);
        expect(post.options?.headers).toEqual({ 'If-Match': '"1"' });
        expect(post.options?.body).toMatchObject({
            AutoPauseEnabled: false,
            LastOpenedTab: '',
            Revision: 1,
            FutureSetting: {
                nestedKey: [{ MiXeDKey: 'preserve-exactly' }],
            },
            vendorFlag: {
                lower_child: true,
            },
        });
        expect(post.options?.body).not.toHaveProperty('VendorFlag');
        expect(post.options?.body).not.toHaveProperty('FutureSetting.NestedKey');
        expect(JSON.stringify(JC.currentSettings)).toBe(actorSnapshot);
    });

    it('supersedes a pending B intent when deferred A becomes the latest A again', async () => {
        let resolveFirst!: () => void;
        const posts: Record<string, unknown>[] = [];
        const { editor } = await openTarget(async (path, options) => {
            if (!options?.method) {
                return path.includes('settings.json')
                    ? envelope('settings.json', 1, { AutoPauseEnabled: true })
                    : envelope('shortcuts.json', 1, { Shortcuts: [] }, HASH_B);
            }
            const body = { ...(options.body as Record<string, unknown>) };
            posts.push(body);
            if (posts.length === 1) {
                return new Promise(resolve => {
                    resolveFirst = () => resolve(envelope('settings.json', 2, body, HASH_C));
                });
            }
            return envelope('settings.json', 3, body, HASH_C);
        });

        (editor.settings as Record<string, unknown>).autoPauseEnabled = false;
        const firstA = editor.saveSettings();
        await vi.waitFor(() => expect(posts).toHaveLength(1));
        (editor.settings as Record<string, unknown>).autoPauseEnabled = true;
        const pendingB = editor.saveSettings();
        (editor.settings as Record<string, unknown>).autoPauseEnabled = false;
        const latestA = editor.saveSettings();

        resolveFirst();
        await expect(Promise.all([firstA, pendingB, latestA])).resolves.toEqual([
            expect.objectContaining({ revision: 2 }),
            expect.objectContaining({ revision: 2 }),
            expect.objectContaining({ revision: 2 }),
        ]);
        expect(posts).toHaveLength(1);
        expect(posts[0]).toMatchObject({ AutoPauseEnabled: false, Revision: 1 });
        expect(editor.settings.autoPauseEnabled).toBe(false);
    });

    it('fences target saves after a same-user live server switch', async () => {
        const { editor, plugin } = await openTarget();
        const callsBeforeSwitch = plugin.mock.calls.length;
        ApiClient.serverId = () => 'server-b';
        (editor.settings as Record<string, unknown>).autoPauseEnabled = false;

        await expect(editor.saveSettings()).rejects.toMatchObject({ kind: 'cancelled' });
        expect(plugin).toHaveBeenCalledTimes(callsBeforeSwitch);
    });

    it('saves target shortcuts without publishing them to the actor shortcut map', async () => {
        const actorMap = JC.state!.activeShortcuts;
        const actorSnapshot = JSON.stringify(actorMap);
        const { editor } = await openTarget(async (path, options) => {
            if (!options?.method) {
                return path.includes('settings.json')
                    ? envelope('settings.json', 1, { AutoPauseEnabled: true })
                    : envelope('shortcuts.json', 4, { Shortcuts: [{ Name: 'play', Key: 'P' }] }, HASH_B);
            }
            return envelope('shortcuts.json', 5, options.body as Record<string, unknown>, HASH_C);
        });
        (editor.shortcuts.Shortcuts as Array<Record<string, unknown>>)[0].Key = 'K';

        await editor.saveShortcuts();

        expect(editor.shortcuts.Shortcuts).toEqual([{ Name: 'play', Key: 'K' }]);
        expect(JC.state!.activeShortcuts).toBe(actorMap);
        expect(JSON.stringify(JC.state!.activeShortcuts)).toBe(actorSnapshot);
    });

    it('safely rebases a non-overlapping 409 and retries at the authoritative revision', async () => {
        let postCount = 0;
        const postHeaders: unknown[] = [];
        const { editor } = await openTarget(async (path, options) => {
            if (!options?.method) {
                return path.includes('settings.json')
                    ? envelope('settings.json', 1, { AutoPauseEnabled: true, PauseScreenDelaySeconds: 5 })
                    : envelope('shortcuts.json', 1, { Shortcuts: [] }, HASH_B);
            }
            postHeaders.push(options.headers);
            postCount++;
            if (postCount === 1) {
                throw Object.assign(new Error('conflict'), {
                    status: 409,
                    responseJSON: conflictEnvelope('settings.json', 2, {
                        AutoPauseEnabled: true,
                        PauseScreenDelaySeconds: 5,
                        ConcurrentExtension: 'remote',
                    }),
                });
            }
            return envelope('settings.json', 3, options.body as Record<string, unknown>, HASH_C);
        });
        (editor.settings as Record<string, unknown>).autoPauseEnabled = false;

        await expect(editor.saveSettings()).resolves.toMatchObject({ revision: 3 });
        expect(postHeaders).toEqual([
            { 'If-Match': '"1"' },
            { 'If-Match': '"2"' },
        ]);
        expect(editor.settings).toMatchObject({
            autoPauseEnabled: false,
            concurrentExtension: 'remote',
        });
    });

    it('adopts and preserves a hazardous extension key introduced by conflict evidence', async () => {
        let postCount = 0;
        const posts: Record<string, unknown>[] = [];
        const hazardous = JSON.parse(
            '{"__proto__":{"Nested":"remote-proto"},"constructor":{"Nested":"remote-constructor"}}',
        ) as Record<string, unknown>;
        const { editor } = await openTarget(async (path, options) => {
            if (!options?.method) {
                return path.includes('settings.json')
                    ? envelope('settings.json', 1, { AutoPauseEnabled: true })
                    : envelope('shortcuts.json', 1, { Shortcuts: [] }, HASH_B);
            }
            const body = options.body as Record<string, unknown>;
            posts.push(body);
            postCount++;
            if (postCount === 1) {
                throw Object.assign(new Error('conflict'), {
                    status: 409,
                    responseJSON: conflictEnvelope('settings.json', 2, {
                        AutoPauseEnabled: true,
                        ...hazardous,
                    }),
                });
            }
            return envelope('settings.json', postCount + 1, body, HASH_C);
        });
        (editor.settings as Record<string, unknown>).autoPauseEnabled = false;

        await editor.saveSettings();
        expect(Object.prototype.hasOwnProperty.call(editor.settings, '__proto__')).toBe(true);
        expect((editor.settings as Record<string, unknown>).__proto__)
            .toEqual({ nested: 'remote-proto' });
        expect(Object.prototype.hasOwnProperty.call(editor.settings, 'constructor')).toBe(true);

        (editor.settings as Record<string, unknown>).showFileSizes = true;
        await editor.saveSettings();

        expect(posts).toHaveLength(3);
        expect(Object.prototype.hasOwnProperty.call(posts[2], '__proto__')).toBe(true);
        expect(posts[2].__proto__).toEqual({ Nested: 'remote-proto' });
        expect(Object.prototype.hasOwnProperty.call(posts[2], 'constructor')).toBe(true);
        expect(posts[2].constructor).toEqual({ Nested: 'remote-constructor' });
    });

    it('rebases a queued intent onto authoritative mixed-case extension data', async () => {
        let rejectFirst!: (reason: unknown) => void;
        let resolvePending!: () => void;
        const posts: Array<{
            body: Record<string, unknown>;
            headers: unknown;
        }> = [];
        const authoritativeExtension = {
            nestedKey: [{ MiXeDKey: 'remote-value' }],
        };
        const { editor } = await openTarget(async (path, options) => {
            if (!options?.method) {
                return path.includes('settings.json')
                    ? envelope('settings.json', 1, {
                        AutoPauseEnabled: true,
                        PauseScreenDelaySeconds: 5,
                        FutureSetting: { nestedKey: [{ MiXeDKey: 'old-value' }] },
                        vendorFlag: { lower_child: 'old' },
                    })
                    : envelope('shortcuts.json', 1, { Shortcuts: [] }, HASH_B);
            }
            const body = JSON.parse(JSON.stringify(options.body)) as Record<string, unknown>;
            posts.push({ body, headers: options.headers });
            if (posts.length === 1) {
                return new Promise((_resolve, reject) => {
                    rejectFirst = reject;
                });
            }
            if (posts.length === 3) {
                return new Promise(resolve => {
                    resolvePending = () => resolve(envelope(
                        'settings.json',
                        4,
                        body,
                        HASH_C,
                    ));
                });
            }
            return envelope(
                'settings.json',
                posts.length === 2 ? 3 : 5,
                body,
                posts.length === 2 ? HASH_B : HASH_C,
            );
        });

        (editor.settings as Record<string, unknown>).autoPauseEnabled = false;
        const first = editor.saveSettings();
        await vi.waitFor(() => expect(posts).toHaveLength(1));
        (editor.settings as Record<string, unknown>).pauseScreenDelaySeconds = 9;
        const pending = editor.saveSettings();
        rejectFirst(Object.assign(new Error('conflict'), {
            status: 409,
            responseJSON: conflictEnvelope('settings.json', 2, {
                AutoPauseEnabled: true,
                PauseScreenDelaySeconds: 5,
                FutureSetting: authoritativeExtension,
                vendorFlag: { lower_child: 'remote' },
            }),
        }));

        await vi.waitFor(() => expect(posts).toHaveLength(3));
        expect(editor.settings).toMatchObject({
            futureSetting: {
                nestedKey: [{ miXeDKey: 'remote-value' }],
            },
            vendorFlag: { lower_child: 'remote' },
        });
        delete (editor.settings as Record<string, unknown>).futureSetting;
        delete (editor.settings as Record<string, unknown>).vendorFlag;
        (editor.settings as Record<string, unknown>).showFileSizes = true;
        const third = editor.saveSettings();
        resolvePending();

        await expect(Promise.all([first, pending, third])).resolves.toEqual([
            expect.objectContaining({ revision: 3 }),
            expect.objectContaining({ revision: 4 }),
            expect.objectContaining({ revision: 5 }),
        ]);
        expect(posts).toHaveLength(4);
        expect(posts[1]).toMatchObject({
            headers: { 'If-Match': '"2"' },
            body: {
                AutoPauseEnabled: false,
                PauseScreenDelaySeconds: 5,
                FutureSetting: authoritativeExtension,
                vendorFlag: { lower_child: 'remote' },
            },
        });
        expect(posts[2]).toMatchObject({
            headers: { 'If-Match': '"3"' },
            body: {
                AutoPauseEnabled: false,
                PauseScreenDelaySeconds: 9,
                FutureSetting: authoritativeExtension,
                vendorFlag: { lower_child: 'remote' },
            },
        });
        expect(posts[2].body).not.toHaveProperty('FutureSetting.NestedKey');
        expect(posts[2].body).not.toHaveProperty('VendorFlag');
        expect(posts[3]).toMatchObject({
            headers: { 'If-Match': '"4"' },
            body: {
                AutoPauseEnabled: false,
                PauseScreenDelaySeconds: 9,
                ShowFileSizes: true,
                FutureSetting: authoritativeExtension,
                vendorFlag: { lower_child: 'remote' },
            },
        });
        expect(posts[3].body).not.toHaveProperty('FutureSetting.NestedKey');
        expect(posts[3].body).not.toHaveProperty('VendorFlag');
    });

    it('rejects overlapping conflicts and restores the authoritative target state', async () => {
        const { editor } = await openTarget(async (path, options) => {
            if (!options?.method) {
                return path.includes('settings.json')
                    ? envelope('settings.json', 1, { PauseScreenDelaySeconds: 5 })
                    : envelope('shortcuts.json', 1, { Shortcuts: [] }, HASH_B);
            }
            throw Object.assign(new Error('conflict'), {
                status: 409,
                responseJSON: conflictEnvelope(
                    'settings.json',
                    2,
                    { PauseScreenDelaySeconds: 8 },
                ),
            });
        });
        (editor.settings as Record<string, unknown>).pauseScreenDelaySeconds = 12;

        await expect(editor.saveSettings()).rejects.toMatchObject({ kind: 'conflict' });
        expect((editor.settings as Record<string, unknown>).pauseScreenDelaySeconds).toBe(8);
        await expect(editor.saveSettings()).rejects.toMatchObject({ kind: 'conflict' });
    });

    it.each([
        ['target', { TargetUserId: 'cccccccccccccccccccccccccccccccc' }],
        ['file', { File: 'shortcuts.json' }],
        ['revision', { Data: { AutoPauseEnabled: false, Revision: 7 } }],
        ['hash', { ContentHash: 'not-a-content-hash' }],
    ])('rejects %s-mismatched 409 evidence and restores only exact-target evidence', async (_case, patch) => {
        let posts = 0;
        const { editor } = await openTarget(async (path, options) => {
            if (!options?.method && path.includes('/evidence')) {
                return envelope('settings.json', 2, {
                    AutoPauseEnabled: true,
                    ExactTargetEvidence: 'safe',
                }, HASH_C);
            }
            if (!options?.method) {
                return path.includes('settings.json')
                    ? envelope('settings.json', 1, { AutoPauseEnabled: true })
                    : envelope('shortcuts.json', 1, { Shortcuts: [] }, HASH_B);
            }
            posts++;
            throw Object.assign(new Error('misrouted conflict'), {
                status: 409,
                responseJSON: {
                    ...conflictEnvelope('settings.json', 2, {
                        AutoPauseEnabled: false,
                        UntrustedEvidence: 'must-not-publish',
                    }),
                    ...patch,
                },
            });
        });
        (editor.settings as Record<string, unknown>).autoPauseEnabled = false;

        await expect(editor.saveSettings()).rejects.toMatchObject({
            kind: 'conflict',
            ambiguous: true,
        });
        expect(posts).toBe(1);
        expect(editor.settings).toMatchObject({
            autoPauseEnabled: true,
            exactTargetEvidence: 'safe',
        });
        expect(editor.settings).not.toHaveProperty('untrustedEvidence');
    });

    it('restores the latest authoritative state after bounded safe-rebase exhaustion', async () => {
        let post = 0;
        const { editor } = await openTarget(async (path, options) => {
            if (!options?.method) {
                return path.includes('settings.json')
                    ? envelope('settings.json', 1, { AutoPauseEnabled: true })
                    : envelope('shortcuts.json', 1, { Shortcuts: [] }, HASH_B);
            }
            post++;
            throw Object.assign(new Error('moving conflict'), {
                status: 409,
                responseJSON: conflictEnvelope('settings.json', post + 1, {
                    AutoPauseEnabled: true,
                    LatestRemoteMarker: post,
                }),
            });
        });
        (editor.settings as Record<string, unknown>).autoPauseEnabled = false;

        await expect(editor.saveSettings()).rejects.toMatchObject({
            kind: 'conflict',
            authoritative: expect.objectContaining({
                LatestRemoteMarker: 5,
                Revision: 6,
            }),
        });
        expect(post).toBe(5);
        expect(editor.settings).toMatchObject({
            autoPauseEnabled: true,
            latestRemoteMarker: 5,
            revision: 6,
        });
    });

    it('evidence-checks an uncommitted 503, restores the target snapshot, and never mutates actor globals', async () => {
        const actorSnapshot = JSON.stringify(JC.currentSettings);
        let posts = 0;
        const { editor } = await openTarget(async (path, options) => {
            if (!options?.method && path.includes('/evidence')) {
                return envelope('settings.json', 1, { AutoPauseEnabled: true });
            }
            if (!options?.method) {
                return path.includes('settings.json')
                    ? envelope('settings.json', 1, { AutoPauseEnabled: true })
                    : envelope('shortcuts.json', 1, { Shortcuts: [] }, HASH_B);
            }
            posts++;
            throw Object.assign(new Error('unavailable'), { status: 503 });
        });
        (editor.settings as Record<string, unknown>).autoPauseEnabled = false;

        await expect(editor.saveSettings()).rejects.toMatchObject({
            kind: 'conflict',
            ambiguous: true,
        });
        expect(posts).toBe(2);
        expect((editor.settings as Record<string, unknown>).autoPauseEnabled).toBe(true);
        expect(JSON.stringify(JC.currentSettings)).toBe(actorSnapshot);
    });

    it('uses evidence to accept an exact committed write after a 503 response', async () => {
        let candidate: Record<string, unknown> | null = null;
        const { editor } = await openTarget(async (path, options) => {
            if (!options?.method && path.includes('/evidence')) {
                return envelope('settings.json', 2, candidate!, HASH_C);
            }
            if (!options?.method) {
                return path.includes('settings.json')
                    ? envelope('settings.json', 1, { AutoPauseEnabled: true })
                    : envelope('shortcuts.json', 1, { Shortcuts: [] }, HASH_B);
            }
            candidate = {
                ...(options.body as Record<string, unknown>),
                Revision: 2,
            };
            throw Object.assign(new Error('post-commit reconciliation failed'), { status: 503 });
        });
        (editor.settings as Record<string, unknown>).autoPauseEnabled = false;

        await expect(editor.saveSettings()).resolves.toMatchObject({ revision: 2 });
        expect((editor.settings as Record<string, unknown>).autoPauseEnabled).toBe(false);
    });

    it('uses evidence to accept a committed write after a malformed acknowledgement', async () => {
        let candidate: Record<string, unknown> | null = null;
        const { editor } = await openTarget(async (path, options) => {
            if (!options?.method && path.includes('/evidence')) {
                return envelope('settings.json', 2, candidate!, HASH_C);
            }
            if (!options?.method) {
                return path.includes('settings.json')
                    ? envelope('settings.json', 1, { AutoPauseEnabled: true })
                    : envelope('shortcuts.json', 1, { Shortcuts: [] }, HASH_B);
            }
            candidate = { ...(options.body as Record<string, unknown>), Revision: 2 };
            return { Success: true, File: 'settings.json' }; // committed, malformed response
        });
        (editor.settings as Record<string, unknown>).autoPauseEnabled = false;

        await expect(editor.saveSettings()).resolves.toMatchObject({ revision: 2 });
        expect((editor.settings as Record<string, unknown>).autoPauseEnabled).toBe(false);
    });

    it('keeps the conflict fence ahead of no-op dedup after an unverifiable acknowledgement', async () => {
        let posts = 0;
        const { editor } = await openTarget(async (path, options) => {
            if (!options?.method && path.includes('/evidence')) {
                throw Object.assign(new Error('evidence unavailable'), { status: 503 });
            }
            if (!options?.method) {
                return path.includes('settings.json')
                    ? envelope('settings.json', 1, { AutoPauseEnabled: true })
                    : envelope('shortcuts.json', 1, { Shortcuts: [] }, HASH_B);
            }
            posts++;
            return { Success: true, File: 'settings.json' };
        });
        (editor.settings as Record<string, unknown>).autoPauseEnabled = false;

        await expect(editor.saveSettings()).rejects.toMatchObject({
            kind: 'unavailable',
            ambiguous: true,
        });
        expect((editor.settings as Record<string, unknown>).autoPauseEnabled).toBe(true);
        await expect(editor.saveSettings()).rejects.toMatchObject({ kind: 'conflict' });
        expect(posts).toBe(1);
    });

    it('cancels stale panel work and restores the last acknowledged local state', async () => {
        let rejectPost: ((error: unknown) => void) | null = null;
        const { editor, controller } = await openTarget(async (path, options) => {
            if (!options?.method) {
                return path.includes('settings.json')
                    ? envelope('settings.json', 1, { AutoPauseEnabled: true })
                    : envelope('shortcuts.json', 1, { Shortcuts: [] }, HASH_B);
            }
            return new Promise((_resolve, reject) => {
                rejectPost = reject;
            });
        });
        const event = vi.fn();
        document.addEventListener('jc:admin-target-settings-save-error', event);
        (editor.settings as Record<string, unknown>).autoPauseEnabled = false;
        const saving = editor.saveSettings();
        controller.abort();
        const abort = new Error('aborted');
        abort.name = 'AbortError';
        rejectPost!(abort);

        await expect(saving).rejects.toBeInstanceOf(AdminTargetPersistenceError);
        expect((editor.settings as Record<string, unknown>).autoPauseEnabled).toBe(true);
        expect(event).not.toHaveBeenCalled();
        document.removeEventListener('jc:admin-target-settings-save-error', event);
    });
});
