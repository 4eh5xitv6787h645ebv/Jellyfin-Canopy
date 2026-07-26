/* eslint-disable @typescript-eslint/require-await -- request fakes mirror the async transport */
/* eslint-disable @typescript-eslint/unbound-method -- host methods are restored after each test */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import {
    AdminTargetPersistenceError,
    createPanelEditorContext,
} from './editor-context';
import type { PanelEditorContext, PanelUserFile } from './editor-context';

const ACTOR = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TARGET = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const FILES: PanelUserFile[] = [
    'settings.json',
    'shortcuts.json',
    'hidden-content-settings.json',
    'spoiler-guard-prefs.json',
    'spoiler-guard-overrides.json',
];
const OPAQUE_EXTENSION_FILES = [
    'hidden-content-settings.json',
    'spoiler-guard-prefs.json',
    'spoiler-guard-overrides.json',
] as const;
type OpaqueExtensionFile = typeof OPAQUE_EXTENSION_FILES[number];

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

const originalApi = JC.core.api;
const originalGetCurrentUser = ApiClient.getCurrentUser;
const originalGetCurrentUserId = ApiClient.getCurrentUserId;
const originalServerId = ApiClient.serverId;
const originalTransform = JC.transformUserFileCase;
const originalPluginConfig = JC.pluginConfig;
const originalCurrentSettings = JC.currentSettings;
const originalUserConfig = JC.userConfig;
const originalState = JC.state;
const originalHiddenContent = JC.hiddenContent;
const originalSpoilerGuard = JC.spoilerGuard;

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

function fileFromPath(path: string): PanelUserFile {
    const file = FILES.find(candidate => path.includes(`/${candidate}`));
    if (!file) throw new Error(`Unexpected target resource path: ${path}`);
    return file;
}

function envelope(
    file: PanelUserFile,
    revision: number,
    data: Record<string, unknown>,
    options: {
        hash?: string;
        name?: string;
        target?: string;
        itemCount?: number;
    } = {},
): Record<string, unknown> {
    return {
        Success: true,
        File: file,
        Revision: revision,
        ContentHash: options.hash ?? HASH_A,
        Data: { ...data, Revision: revision },
        TargetUserId: options.target ?? TARGET,
        TargetDisplayName: options.name ?? 'Target User',
        ...(file === 'hidden-content-settings.json'
            ? { ItemCount: options.itemCount ?? 0 }
            : {}),
    };
}

function conflictEnvelope(
    file: PanelUserFile,
    revision: number,
    data: Record<string, unknown>,
): Record<string, unknown> {
    return {
        Success: false,
        Conflict: true,
        File: file,
        Revision: revision,
        ContentHash: HASH_B,
        Data: { ...data, Revision: revision },
        TargetUserId: TARGET,
        TargetDisplayName: 'Target User',
        ...(file === 'hidden-content-settings.json' ? { ItemCount: 0 } : {}),
    };
}

function initialEnvelope(
    file: PanelUserFile,
    options: { name?: string; target?: string; itemCount?: number } = {},
): Record<string, unknown> {
    switch (file) {
        case 'settings.json':
            return envelope(file, 1, { AutoPauseEnabled: true }, options);
        case 'shortcuts.json':
            return envelope(file, 2, { Shortcuts: [] }, { ...options, hash: HASH_B });
        case 'hidden-content-settings.json':
            return envelope(file, 3, {
                Enabled: true,
                ShowHideButtons: true,
                ShowHideConfirmation: true,
                ShowButtonSeerr: true,
                ShowButtonLibrary: false,
                ShowButtonDetails: true,
                ShowButtonCast: false,
                FilterLibrary: true,
                FilterDiscovery: true,
                FilterSearch: false,
                FilterCalendar: true,
                FilterUpcoming: true,
                FilterRecommendations: true,
                FilterRequests: true,
                FilterNextUp: true,
                FilterContinueWatching: true,
                ExperimentalHideCollections: false,
                Future_Field: { MiXeD: 'preserve' },
            }, { ...options, itemCount: options.itemCount ?? 0 });
        case 'spoiler-guard-prefs.json':
            return envelope(file, 5, {
                HideEpisodeDescriptions: null,
                ReplaceEpisodeTitles: null,
                HideChapterNames: null,
                HideCast: null,
                HideRatings: null,
                HideAirDate: null,
                HideTaglines: null,
                HideTags: null,
                HideReviews: null,
                SkipDisableConfirm: false,
                Future_Field: { MiXeD: 'preserve' },
            }, options);
        case 'spoiler-guard-overrides.json':
            return envelope(file, 7, {
                Series: {
                    aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: {
                        SeriesId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                        SeriesName: 'Existing series',
                        EnabledAt: '2026-01-01T00:00:00.000Z',
                    },
                },
                Movies: {
                    cccccccccccccccccccccccccccccccc: {
                        MovieId: 'cccccccccccccccccccccccccccccccc',
                        MovieName: 'Existing movie',
                        EnabledAt: '2026-01-02T00:00:00.000Z',
                    },
                },
                Collections: {},
                PendingTmdb: {
                    'tv:550': {
                        MediaType: 'tv',
                        TmdbId: '550',
                        DisplayName: 'Pending series',
                        RequestedAt: '2026-01-03T00:00:00.000Z',
                    },
                },
                Future_Field: { MiXeD: 'preserve' },
            }, options);
    }
}

function envelopeWithOpaqueExtensions(
    file: OpaqueExtensionFile,
    extensions: Record<string, unknown>,
): Record<string, unknown> {
    const initial = initialEnvelope(file);
    return envelope(
        file,
        Number(initial.Revision),
        {
            ...(initial.Data as Record<string, unknown>),
            ...extensions,
        },
        { itemCount: 0 },
    );
}

function opaqueTarget(
    editor: PanelEditorContext,
    file: OpaqueExtensionFile,
): Record<string, unknown> {
    if (file === 'hidden-content-settings.json') return editor.hiddenContentSettings!;
    if (file === 'spoiler-guard-prefs.json') return editor.spoilerGuardPrefs!;
    return editor.spoilerGuardOverrides!;
}

function saveOpaqueTarget(
    editor: PanelEditorContext,
    file: OpaqueExtensionFile,
): Promise<unknown> {
    if (file === 'hidden-content-settings.json') {
        return editor.saveHiddenContentSettings!();
    }
    if (file === 'spoiler-guard-prefs.json') return editor.saveSpoilerGuardPrefs!();
    return editor.saveSpoilerGuardOverrides!();
}

function installApi(
    handler: (path: string, options?: Record<string, unknown>) => Promise<unknown>,
) {
    JC.core.api = { plugin: vi.fn(handler) } as unknown as NonNullable<typeof JC.core.api>;
    return JC.core.api.plugin as ReturnType<typeof vi.fn>;
}

async function openTarget(options: {
    handler?: (path: string, request?: Record<string, unknown>) => Promise<unknown>;
    controller?: AbortController;
    isLaunchCurrent?: () => boolean;
} = {}): Promise<{
    controller: AbortController;
    editor: PanelEditorContext;
    plugin: ReturnType<typeof vi.fn>;
}> {
    const plugin = installApi(options.handler ?? (async path => initialEnvelope(fileFromPath(path))));
    const controller = options.controller ?? new AbortController();
    const editor = await createPanelEditorContext({
        actor: JC.identity.capture()!,
        requestedTargetUserId: TARGET,
        signal: controller.signal,
        isLaunchCurrent: options.isLaunchCurrent ?? (() => true),
    });
    return { controller, editor, plugin };
}

describe('admin-target Hidden Content and Spoiler Guard resources', () => {
    let actorHiddenContent: {
        getHiddenCount: ReturnType<typeof vi.fn>;
        getSettings: ReturnType<typeof vi.fn>;
        updateSettings: ReturnType<typeof vi.fn>;
    };
    let actorSpoilerGuard: {
        getUserPrefs: ReturnType<typeof vi.fn>;
        setUserPrefs: ReturnType<typeof vi.fn>;
        whenLoaded: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
        JC.identity.transition('server-a', ACTOR, 'target-resource-test');
        ApiClient.getCurrentUserId = () => ACTOR;
        ApiClient.serverId = () => 'server-a';
        ApiClient.getCurrentUser = () => Promise.resolve({
            Id: ACTOR,
            Policy: { IsAdministrator: true },
        });
        JC.transformUserFileCase = (_file, value, direction) =>
            convert(value, direction === 'save');
        JC.pluginConfig = {
            HiddenContentEnabled: true,
            SpoilerBlurEnabled: true,
            Shortcuts: [],
        };
        JC.currentSettings = { actorOnly: 'unchanged' };
        JC.userConfig = {
            settings: { ActorOnly: 'unchanged', Revision: 8 },
            shortcuts: { Shortcuts: [], Revision: 7 },
        };
        JC.state = {
            activeShortcuts: { actorOnly: 'A' },
        } as unknown as NonNullable<typeof JC.state>;
        actorHiddenContent = {
            getHiddenCount: vi.fn(() => 99),
            getSettings: vi.fn(() => ({ enabled: false, actorOnly: true })),
            updateSettings: vi.fn(),
        };
        JC.hiddenContent =
            actorHiddenContent as unknown as NonNullable<typeof JC.hiddenContent>;
        actorSpoilerGuard = {
            getUserPrefs: vi.fn(() => ({ HideRatings: false, ActorOnly: true })),
            setUserPrefs: vi.fn(),
            whenLoaded: vi.fn(() => Promise.resolve()),
        };
        JC.spoilerGuard =
            actorSpoilerGuard as unknown as NonNullable<typeof JC.spoilerGuard>;
    });

    afterEach(() => {
        JC.core.api = originalApi;
        ApiClient.getCurrentUser = originalGetCurrentUser;
        ApiClient.getCurrentUserId = originalGetCurrentUserId;
        ApiClient.serverId = originalServerId;
        JC.transformUserFileCase = originalTransform;
        JC.pluginConfig = originalPluginConfig;
        JC.currentSettings = originalCurrentSettings;
        JC.userConfig = originalUserConfig;
        JC.state = originalState;
        JC.hiddenContent = originalHiddenContent;
        JC.spoilerGuard = originalSpoilerGuard;
        JC.identity.transition('', '', 'target-resource-test-cleanup');
        vi.restoreAllMocks();
    });

    it('loads all five exact-target resources, including a zero-item Hidden target, without actor publication', async () => {
        const actorSnapshot = JSON.stringify({
            currentSettings: JC.currentSettings,
            state: JC.state,
            userConfig: JC.userConfig,
        });
        const { editor, plugin } = await openTarget();

        expect(plugin).toHaveBeenCalledTimes(5);
        expect(plugin.mock.calls.map(([path]) => fileFromPath(String(path))).sort())
            .toEqual([...FILES].sort());
        expect(editor.hiddenContentCount).toBe(0);
        expect(editor.hiddenContentSettings).toMatchObject({
            revision: 3,
            enabled: true,
            showButtonCast: false,
            filterSearch: false,
            Future_Field: { MiXeD: 'preserve' },
        });
        expect(editor.spoilerGuardPrefs).toMatchObject({
            Revision: 5,
            HideEpisodeDescriptions: null,
            HideRatings: null,
            SkipDisableConfirm: false,
            Future_Field: { MiXeD: 'preserve' },
        });
        expect(editor.spoilerGuardOverrides).toMatchObject({
            Revision: 7,
            Series: {
                aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: {
                    SeriesName: 'Existing series',
                },
            },
            Movies: {
                cccccccccccccccccccccccccccccccc: {
                    MovieName: 'Existing movie',
                },
            },
            PendingTmdb: {
                'tv:550': {
                    DisplayName: 'Pending series',
                },
            },
            Future_Field: { MiXeD: 'preserve' },
        });
        expect(actorHiddenContent.getSettings).not.toHaveBeenCalled();
        expect(actorHiddenContent.getHiddenCount).not.toHaveBeenCalled();
        expect(actorHiddenContent.updateSettings).not.toHaveBeenCalled();
        expect(actorSpoilerGuard.getUserPrefs).not.toHaveBeenCalled();
        expect(actorSpoilerGuard.setUserPrefs).not.toHaveBeenCalled();
        expect(actorSpoilerGuard.whenLoaded).not.toHaveBeenCalled();
        expect(JSON.stringify({
            currentSettings: JC.currentSettings,
            state: JC.state,
            userConfig: JC.userConfig,
        })).toBe(actorSnapshot);
    });

    it.each([
        ['empty-string', ''],
        ['boolean', false],
    ])('rejects a %s Hidden ItemCount in an initial target envelope', async (
        _case,
        badItemCount,
    ) => {
        await expect(openTarget({
            handler: async path => {
                const file = fileFromPath(path);
                const response = initialEnvelope(file);
                if (file === 'hidden-content-settings.json') {
                    response.ItemCount = badItemCount;
                }
                return response;
            },
        })).rejects.toMatchObject({ kind: 'protocol' });
    });

    it.each([
        ['empty-string', ''],
        ['boolean', false],
    ])('evidence-checks a Hidden POST acknowledgement with a %s ItemCount', async (
        _case,
        badItemCount,
    ) => {
        let posts = 0;
        let evidenceReads = 0;
        const { editor } = await openTarget({
            handler: async (path, request) => {
                const file = fileFromPath(path);
                if (path.includes('/evidence')) {
                    evidenceReads++;
                    throw Object.assign(
                        new Error('evidence unavailable'),
                        { status: 503 },
                    );
                }
                if (!request?.method) return initialEnvelope(file);
                posts++;
                const body = request.body as Record<string, unknown>;
                const response = envelope(
                    file,
                    Number(body.Revision) + 1,
                    body,
                    { hash: HASH_B, itemCount: 0 },
                );
                response.ItemCount = badItemCount;
                return response;
            },
        });
        editor.hiddenContentSettings!.enabled = false;

        await expect(editor.saveHiddenContentSettings!()).rejects.toMatchObject({
            kind: 'unavailable',
            ambiguous: true,
        });
        expect(posts).toBe(1);
        expect(evidenceReads).toBe(1);
        expect(editor.hiddenContentSettings!.enabled).toBe(true);
    });

    it.each([
        ['empty-string', ''],
        ['boolean', false],
    ])('rejects a Hidden 409 envelope with a %s ItemCount before rebase', async (
        _case,
        badItemCount,
    ) => {
        let posts = 0;
        let evidenceReads = 0;
        const { editor } = await openTarget({
            handler: async (path, request) => {
                const file = fileFromPath(path);
                if (path.includes('/evidence')) {
                    evidenceReads++;
                    throw Object.assign(
                        new Error('evidence unavailable'),
                        { status: 503 },
                    );
                }
                if (!request?.method) return initialEnvelope(file);
                posts++;
                const response = conflictEnvelope(file, 4, {
                    ...(initialEnvelope(file).Data as Record<string, unknown>),
                    RemoteField: 'must-not-rebase',
                });
                response.ItemCount = badItemCount;
                throw Object.assign(new Error('malformed conflict'), {
                    status: 409,
                    responseJSON: response,
                });
            },
        });
        editor.hiddenContentSettings!.enabled = false;

        await expect(editor.saveHiddenContentSettings!()).rejects.toMatchObject({
            kind: 'unavailable',
            ambiguous: true,
        });
        expect(posts).toBe(1);
        expect(evidenceReads).toBe(1);
        expect(editor.hiddenContentSettings).not.toHaveProperty('RemoteField');
    });

    it('preserves hazardous opaque Hidden extension keys and shortcut names', async () => {
        const hazardous = JSON.parse(
            '{"__proto__":{"Nested":"keep-proto"},"constructor":{"Nested":"keep-constructor"}}',
        ) as Record<string, unknown>;
        let hiddenPost: Record<string, unknown> | null = null;
        const { editor } = await openTarget({
            handler: async (path, request) => {
                const file = fileFromPath(path);
                if (!request?.method) {
                    if (file === 'hidden-content-settings.json') {
                        return envelope(file, 3, {
                            Enabled: true,
                            ShowButtonCast: false,
                            ...hazardous,
                        }, { itemCount: 0 });
                    }
                    if (file === 'shortcuts.json') {
                        return envelope(file, 2, {
                            Shortcuts: [{
                                Name: '__proto__',
                                Key: 'Ctrl+P',
                            }, {
                                Name: 'constructor',
                                Key: 'Ctrl+C',
                            }],
                        });
                    }
                    return initialEnvelope(file);
                }
                const body = request.body as Record<string, unknown>;
                if (file === 'hidden-content-settings.json') hiddenPost = body;
                return envelope(file, Number(body.Revision) + 1, body, {
                    hash: HASH_B,
                    itemCount: 0,
                });
            },
        });

        expect(Object.prototype.hasOwnProperty.call(editor.activeShortcuts, '__proto__')).toBe(true);
        expect(editor.activeShortcuts.__proto__).toBe('Ctrl+P');
        expect(Object.prototype.hasOwnProperty.call(editor.activeShortcuts, 'constructor')).toBe(true);
        expect(editor.activeShortcuts.constructor).toBe('Ctrl+C');
        expect(Object.prototype.hasOwnProperty.call(editor.hiddenContentSettings, '__proto__')).toBe(true);
        expect(editor.hiddenContentSettings?.__proto__).toEqual({ Nested: 'keep-proto' });

        editor.hiddenContentSettings!.showButtonCast = true;
        await editor.saveHiddenContentSettings!();

        expect(hiddenPost).not.toBeNull();
        const posted = hiddenPost as unknown as Record<string, unknown>;
        expect(Object.prototype.hasOwnProperty.call(posted, '__proto__')).toBe(true);
        expect(posted.__proto__).toEqual({ Nested: 'keep-proto' });
        expect(Object.prototype.hasOwnProperty.call(posted, 'constructor')).toBe(true);
        expect(posted.constructor).toEqual({ Nested: 'keep-constructor' });
    });

    it.each([
        ['display name', { name: 'Other User' }],
        ['target ID', { target: 'cccccccccccccccccccccccccccccccc' }],
    ])('rejects mismatched resource %s metadata before exposing a target editor', async (
        _case,
        mismatch,
    ) => {
        const actorSnapshot = JSON.stringify(JC.currentSettings);
        installApi(async path => {
            const file = fileFromPath(path);
            return initialEnvelope(
                file,
                file === 'spoiler-guard-prefs.json' ? mismatch : {},
            );
        });

        await expect(createPanelEditorContext({
            actor: JC.identity.capture()!,
            requestedTargetUserId: TARGET,
            signal: new AbortController().signal,
            isLaunchCurrent: () => true,
        })).rejects.toMatchObject({ kind: 'protocol' });
        expect(JSON.stringify(JC.currentSettings)).toBe(actorSnapshot);
        expect(actorHiddenContent.getSettings).not.toHaveBeenCalled();
        expect(actorSpoilerGuard.getUserPrefs).not.toHaveBeenCalled();
    });

    it('rejects a partial target override resource before it can materialize missing dictionaries', async () => {
        installApi(async path => {
            const file = fileFromPath(path);
            if (file !== 'spoiler-guard-overrides.json') return initialEnvelope(file);
            return envelope(file, 7, {
                Series: {},
                Movies: {},
                // Collections is deliberately absent.
                PendingTmdb: {},
            });
        });

        await expect(createPanelEditorContext({
            actor: JC.identity.capture()!,
            requestedTargetUserId: TARGET,
            signal: new AbortController().signal,
            isLaunchCurrent: () => true,
        })).rejects.toMatchObject({ kind: 'protocol' });
        expect(actorSpoilerGuard.getUserPrefs).not.toHaveBeenCalled();
        expect(actorSpoilerGuard.setUserPrefs).not.toHaveBeenCalled();
    });

    it('saves each bounded target preference resource with its own revision and preserves extensions', async () => {
        const requests: Array<{ path: string; request?: Record<string, unknown> }> = [];
        const { editor } = await openTarget({
            handler: async (path, request) => {
                requests.push({ path, request });
                const file = fileFromPath(path);
                if (!request?.method) return initialEnvelope(file);
                const body = request.body as Record<string, unknown>;
                return envelope(file, Number(body.Revision) + 1, body, {
                    hash: HASH_B,
                    itemCount: 0,
                });
            },
        });

        editor.hiddenContentSettings!.showButtonCast = true;
        editor.spoilerGuardPrefs!.HideRatings = false;
        delete (
            editor.spoilerGuardOverrides!.Series as Record<string, unknown>
        ).aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;
        await expect(editor.saveHiddenContentSettings!()).resolves.toMatchObject({
            file: 'hidden-content-settings.json',
            revision: 4,
        });
        await expect(editor.saveSpoilerGuardPrefs!()).resolves.toMatchObject({
            file: 'spoiler-guard-prefs.json',
            revision: 6,
        });
        await expect(editor.saveSpoilerGuardOverrides!()).resolves.toMatchObject({
            file: 'spoiler-guard-overrides.json',
            revision: 8,
        });

        const posts = requests.filter(({ request }) => request?.method === 'POST');
        expect(posts).toHaveLength(3);
        expect(posts[0]).toMatchObject({
            path: `/admin/user-settings/${TARGET}/hidden-content-settings.json`,
            request: {
                headers: { 'If-Match': '"3"' },
                body: {
                    Revision: 3,
                    ShowButtonCast: true,
                    Future_Field: { MiXeD: 'preserve' },
                },
            },
        });
        expect(posts[0].request?.body).not.toHaveProperty('showButtonCast');
        expect(posts[1]).toMatchObject({
            path: `/admin/user-settings/${TARGET}/spoiler-guard-prefs.json`,
            request: {
                headers: { 'If-Match': '"5"' },
                body: {
                    Revision: 5,
                    HideRatings: false,
                    Future_Field: { MiXeD: 'preserve' },
                },
            },
        });
        expect(posts[2]).toMatchObject({
            path: `/admin/user-settings/${TARGET}/spoiler-guard-overrides.json`,
            request: {
                headers: { 'If-Match': '"7"' },
                body: {
                    Revision: 7,
                    Series: {},
                    Movies: {
                        cccccccccccccccccccccccccccccccc: {
                            MovieName: 'Existing movie',
                        },
                    },
                    PendingTmdb: {
                        'tv:550': {
                            DisplayName: 'Pending series',
                        },
                    },
                    Future_Field: { MiXeD: 'preserve' },
                },
            },
        });
        expect(actorHiddenContent.updateSettings).not.toHaveBeenCalled();
        expect(actorSpoilerGuard.setUserPrefs).not.toHaveBeenCalled();
    });

    it.each(OPAQUE_EXTENSION_FILES)(
        'requires exact evidence when a %s acknowledgement changes IsAdmin extension fields',
        async (testedFile) => {
            let evidenceReads = 0;
            let posted: Record<string, unknown> | null = null;
            const baseExtensions = {
                IsAdmin: { Marker: 'base-pascal' },
                isAdmin: { Marker: 'base-camel' },
            };
            const { editor } = await openTarget({
                handler: async (path, request) => {
                    const file = fileFromPath(path);
                    if (path.includes('/evidence')) {
                        evidenceReads++;
                        if (file !== testedFile || !posted) {
                            throw new Error('Unexpected evidence read');
                        }
                        return envelope(
                            file,
                            Number(posted.Revision) + 1,
                            posted,
                            { hash: HASH_B, itemCount: 0 },
                        );
                    }
                    if (!request?.method) {
                        return file === testedFile
                            ? envelopeWithOpaqueExtensions(file, baseExtensions)
                            : initialEnvelope(file);
                    }
                    if (file !== testedFile) throw new Error('Unexpected target POST');
                    posted = request.body as Record<string, unknown>;
                    return envelope(
                        file,
                        Number(posted.Revision) + 1,
                        {
                            ...posted,
                            IsAdmin: { Marker: 'different-pascal' },
                            isAdmin: { Marker: 'different-camel' },
                        },
                        { hash: HASH_B, itemCount: 0 },
                    );
                },
            });
            const target = opaqueTarget(editor, testedFile);
            target.IsAdmin = { Marker: 'desired-pascal' };
            target.isAdmin = { Marker: 'desired-camel' };

            await expect(saveOpaqueTarget(editor, testedFile)).resolves.toMatchObject({
                file: testedFile,
            });

            expect(posted).toMatchObject({
                IsAdmin: { Marker: 'desired-pascal' },
                isAdmin: { Marker: 'desired-camel' },
            });
            expect(evidenceReads).toBe(1);
            expect(target).toMatchObject({
                IsAdmin: { Marker: 'desired-pascal' },
                isAdmin: { Marker: 'desired-camel' },
            });
        },
    );

    it.each(OPAQUE_EXTENSION_FILES)(
        'preserves %s IsAdmin extension edits through a non-overlapping CAS rebase',
        async (testedFile) => {
            const posts: Record<string, unknown>[] = [];
            const baseExtensions = {
                IsAdmin: { Marker: 'base-pascal' },
                isAdmin: { Marker: 'base-camel' },
            };
            const initial = envelopeWithOpaqueExtensions(testedFile, baseExtensions);
            const initialData = initial.Data as Record<string, unknown>;
            const initialRevision = Number(initial.Revision);
            const { editor } = await openTarget({
                handler: async (path, request) => {
                    const file = fileFromPath(path);
                    if (!request?.method) {
                        return file === testedFile ? initial : initialEnvelope(file);
                    }
                    if (file !== testedFile) throw new Error('Unexpected target POST');
                    const body = request.body as Record<string, unknown>;
                    posts.push(body);
                    if (posts.length === 1) {
                        throw Object.assign(new Error('conflict'), {
                            status: 409,
                            responseJSON: conflictEnvelope(
                                file,
                                initialRevision + 1,
                                {
                                    ...initialData,
                                    ...baseExtensions,
                                    RemoteEdit: 'preserve-remote',
                                },
                            ),
                        });
                    }
                    return envelope(
                        file,
                        Number(body.Revision) + 1,
                        body,
                        { hash: HASH_B, itemCount: 0 },
                    );
                },
            });
            const target = opaqueTarget(editor, testedFile);
            target.IsAdmin = { Marker: 'desired-pascal' };
            target.isAdmin = { Marker: 'desired-camel' };
            target.UserEdit = 'preserve-local';

            await expect(saveOpaqueTarget(editor, testedFile)).resolves.toMatchObject({
                file: testedFile,
            });

            expect(posts).toHaveLength(2);
            expect(posts[1]).toMatchObject({
                Revision: initialRevision + 1,
                IsAdmin: { Marker: 'desired-pascal' },
                isAdmin: { Marker: 'desired-camel' },
                RemoteEdit: 'preserve-remote',
                UserEdit: 'preserve-local',
            });
            expect(target).toMatchObject({
                IsAdmin: { Marker: 'desired-pascal' },
                isAdmin: { Marker: 'desired-camel' },
                RemoteEdit: 'preserve-remote',
                UserEdit: 'preserve-local',
            });
        },
    );

    it('preserves a later field revert while an earlier target save is held', async () => {
        const heldFirstPost = deferred<unknown>();
        const posts: Record<string, unknown>[] = [];
        const { editor } = await openTarget({
            handler: async (path, request) => {
                const file = fileFromPath(path);
                if (!request?.method) return initialEnvelope(file);
                const body = request.body as Record<string, unknown>;
                posts.push(body);
                if (posts.length === 1) return heldFirstPost.promise;
                return envelope(file, Number(body.Revision) + 1, body, {
                    hash: HASH_B,
                    itemCount: 0,
                });
            },
        });

        editor.hiddenContentSettings!.enabled = false;
        const firstSave = editor.saveHiddenContentSettings!();
        await vi.waitFor(() => expect(posts).toHaveLength(1));

        // Revert the first field to its original value while also making a
        // second change. The queued intent must be relative to the in-flight
        // desired state, so the explicit revert survives A's acknowledgement.
        editor.hiddenContentSettings!.enabled = true;
        editor.hiddenContentSettings!.filterSearch = true;
        const secondSave = editor.saveHiddenContentSettings!();

        heldFirstPost.resolve(envelope(
            'hidden-content-settings.json',
            4,
            posts[0],
            { hash: HASH_B, itemCount: 0 },
        ));
        await expect(firstSave).resolves.toMatchObject({ revision: 4 });
        await expect(secondSave).resolves.toMatchObject({ revision: 5 });

        expect(posts).toHaveLength(2);
        expect(posts[1]).toMatchObject({
            Revision: 4,
            Enabled: true,
            FilterSearch: true,
        });
        expect(editor.hiddenContentSettings).toMatchObject({
            revision: 5,
            enabled: true,
            filterSearch: true,
        });
        expect(actorHiddenContent.updateSettings).not.toHaveBeenCalled();
    });

    it('preserves a later resolved-settings revert while its earlier save is held', async () => {
        const heldFirstPost = deferred<unknown>();
        const posts: Record<string, unknown>[] = [];
        const { editor } = await openTarget({
            handler: async (path, request) => {
                const file = fileFromPath(path);
                if (!request?.method) return initialEnvelope(file);
                const body = request.body as Record<string, unknown>;
                posts.push(body);
                if (posts.length === 1) return heldFirstPost.promise;
                return envelope(file, Number(body.Revision) + 1, body, {
                    hash: HASH_B,
                });
            },
        });

        editor.settings.autoPauseEnabled = false;
        const firstSave = editor.saveSettings();
        await vi.waitFor(() => expect(posts).toHaveLength(1));

        editor.settings.autoPauseEnabled = true;
        editor.settings.autoResumeEnabled = true;
        const secondSave = editor.saveSettings();

        heldFirstPost.resolve(envelope('settings.json', 2, posts[0], {
            hash: HASH_B,
        }));
        await expect(firstSave).resolves.toMatchObject({ revision: 2 });
        await expect(secondSave).resolves.toMatchObject({ revision: 3 });

        expect(posts).toHaveLength(2);
        expect(posts[1]).toMatchObject({
            Revision: 2,
            AutoPauseEnabled: true,
            AutoResumeEnabled: true,
        });
        expect(editor.settings).toMatchObject({
            revision: 3,
            autoPauseEnabled: true,
            autoResumeEnabled: true,
        });
    });

    it('rejects and rolls back an unverifiable target acknowledgement, then fences retry', async () => {
        let posts = 0;
        let evidenceReads = 0;
        const { editor } = await openTarget({
            handler: async (path, request) => {
                const file = fileFromPath(path);
                if (path.includes('/evidence')) {
                    evidenceReads++;
                    throw Object.assign(new Error('evidence unavailable'), { status: 503 });
                }
                if (!request?.method) return initialEnvelope(file);
                posts++;
                return { Success: true, File: file };
            },
        });
        editor.hiddenContentSettings!.enabled = false;

        await expect(editor.saveHiddenContentSettings!()).rejects.toMatchObject({
            kind: 'unavailable',
            ambiguous: true,
        });
        expect(posts).toBe(1);
        expect(evidenceReads).toBe(1);
        expect(editor.hiddenContentSettings!.enabled).toBe(true);
        await expect(editor.saveHiddenContentSettings!()).rejects.toMatchObject({
            kind: 'conflict',
        });
        expect(posts).toBe(1);
        expect(actorHiddenContent.updateSettings).not.toHaveBeenCalled();
    });

    it('rolls back an acknowledged response that arrives after a target switch fence', async () => {
        let launchCurrent = true;
        let resolvePost!: (value: unknown) => void;
        let postedBody: Record<string, unknown> | null = null;
        const saveError = vi.fn();
        document.addEventListener('jc:admin-target-settings-save-error', saveError);
        const { editor } = await openTarget({
            isLaunchCurrent: () => launchCurrent,
            handler: async (path, request) => {
                const file = fileFromPath(path);
                if (!request?.method) return initialEnvelope(file);
                postedBody = request.body as Record<string, unknown>;
                return new Promise(resolve => { resolvePost = resolve; });
            },
        });
        editor.hiddenContentSettings!.filterSearch = true;
        const saving = editor.saveHiddenContentSettings!();
        await vi.waitFor(() => expect(postedBody).not.toBeNull());

        launchCurrent = false;
        resolvePost(envelope(
            'hidden-content-settings.json',
            4,
            postedBody!,
            { hash: HASH_B, itemCount: 0 },
        ));

        await expect(saving).rejects.toMatchObject({ kind: 'cancelled' });
        expect(editor.hiddenContentSettings!.filterSearch).toBe(false);
        expect(saveError).not.toHaveBeenCalled();
        await expect(editor.saveHiddenContentSettings!()).rejects.toMatchObject({
            kind: 'cancelled',
        });
        document.removeEventListener('jc:admin-target-settings-save-error', saveError);
    });

    it('aborts an in-flight target resource save and restores its acknowledged snapshot', async () => {
        let postStarted = false;
        const controller = new AbortController();
        const { editor } = await openTarget({
            controller,
            handler: async (path, request) => {
                const file = fileFromPath(path);
                if (!request?.method) return initialEnvelope(file);
                postStarted = true;
                return new Promise((_resolve, reject) => {
                    const signal = request.signal as AbortSignal;
                    signal.addEventListener('abort', () => {
                        const error = new Error('aborted');
                        error.name = 'AbortError';
                        reject(error);
                    }, { once: true });
                });
            },
        });
        editor.spoilerGuardPrefs!.SkipDisableConfirm = true;
        const saving = editor.saveSpoilerGuardPrefs!();
        await vi.waitFor(() => expect(postStarted).toBe(true));

        controller.abort();

        await expect(saving).rejects.toBeInstanceOf(AdminTargetPersistenceError);
        await expect(saving).rejects.toMatchObject({ kind: 'cancelled' });
        expect(editor.spoilerGuardPrefs!.SkipDisableConfirm).toBe(false);
        expect(actorSpoilerGuard.setUserPrefs).not.toHaveBeenCalled();
    });
});
