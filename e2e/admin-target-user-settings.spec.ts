// Real-browser acceptance for editing another user's Canopy files from the
// selected-user preferences route. Every touched preference resource is
// restored from a fresh revision in finally so the shared E2E users remain
// reusable even when an assertion fails halfway through the workflow.
import type {
    Locator,
    Page,
    Request,
    Route,
    Response as BrowserResponse,
} from 'playwright/test';
import {
    test,
    expect,
    loginAs,
    showRoute,
    waitForHash,
    assertNoRuntimeErrors,
    USERS,
} from './fixtures/auth';
import {
    apiRaw,
    authenticate,
    type Session,
} from './fixtures/api';

/* eslint-disable @typescript-eslint/no-explicit-any */

type UserFile =
    | 'settings.json'
    | 'shortcuts.json'
    | 'hidden-content-settings.json'
    | 'spoiler-guard-prefs.json'
    | 'spoiler-guard-overrides.json';
type RawUserFile =
    | 'settings.json'
    | 'shortcuts.json'
    | 'hidden-content.json'
    | 'spoilerblur.json';
type Layout = 'modern';
type JsonRecord = Record<string, any>;

interface ResolvedUser {
    id: string;
    displayName: string;
}

interface ResolvedUsers {
    admin: ResolvedUser;
    target: ResolvedUser;
    adminSession: Session;
    targetSession: Session;
}

interface AdminFileEnvelope {
    file: UserFile;
    revision: number;
    contentHash: string;
    data: JsonRecord;
    targetUserId: string;
    targetDisplayName: string;
    itemCount?: number;
}

interface UserFiles {
    settings: AdminFileEnvelope;
    shortcuts: AdminFileEnvelope;
    hiddenContent: AdminFileEnvelope;
    spoilerGuard: AdminFileEnvelope;
    spoilerOverrides: AdminFileEnvelope;
}

interface OriginalFiles {
    admin: UserFiles;
    target: UserFiles;
}

interface UserFileTraffic {
    method: string;
    path: string;
}

interface UserFileResponse extends UserFileTraffic {
    status: number;
}

interface ShortcutChoice {
    press: string;
    stored: string;
}

interface HiddenFixture {
    itemId: string;
    item: JsonRecord;
    itemsRevision: number;
}

type SpoilerOverrideSection =
    | 'Series'
    | 'Movies'
    | 'Collections'
    | 'PendingTmdb';

interface SpoilerOverrideFixture {
    kind: 'series' | 'movie' | 'collection' | 'pending-tv' | 'pending-movie';
    section: SpoilerOverrideSection;
    id: string;
    key: string;
    displayName: string;
    idField: string;
    nameField: string;
    mediaType?: 'tv' | 'movie';
}

interface PersistentStores {
    adminHiddenContent: JsonRecord;
    adminSpoilerGuard: JsonRecord;
    targetHiddenContent: JsonRecord;
    targetSpoilerGuard: JsonRecord;
}

const HIDDEN_CONTROLS: ReadonlyArray<{
    id: string;
    pascal: string;
    camel: string;
}> = [
    { id: 'hiddenContentEnabledToggle', pascal: 'Enabled', camel: 'enabled' },
    { id: 'hiddenShowHideButtons', pascal: 'ShowHideButtons', camel: 'showHideButtons' },
    { id: 'hiddenShowConfirmation', pascal: 'ShowHideConfirmation', camel: 'showHideConfirmation' },
    { id: 'hiddenShowButtonSeerr', pascal: 'ShowButtonSeerr', camel: 'showButtonSeerr' },
    { id: 'hiddenShowButtonLibrary', pascal: 'ShowButtonLibrary', camel: 'showButtonLibrary' },
    { id: 'hiddenShowButtonDetails', pascal: 'ShowButtonDetails', camel: 'showButtonDetails' },
    { id: 'hiddenShowButtonCast', pascal: 'ShowButtonCast', camel: 'showButtonCast' },
    { id: 'hiddenFilterLibrary', pascal: 'FilterLibrary', camel: 'filterLibrary' },
    { id: 'hiddenFilterDiscovery', pascal: 'FilterDiscovery', camel: 'filterDiscovery' },
    { id: 'hiddenFilterSearch', pascal: 'FilterSearch', camel: 'filterSearch' },
    { id: 'hiddenFilterCalendar', pascal: 'FilterCalendar', camel: 'filterCalendar' },
    { id: 'hiddenFilterUpcoming', pascal: 'FilterUpcoming', camel: 'filterUpcoming' },
    {
        id: 'hiddenFilterRecommendations',
        pascal: 'FilterRecommendations',
        camel: 'filterRecommendations',
    },
    { id: 'hiddenFilterRequests', pascal: 'FilterRequests', camel: 'filterRequests' },
    { id: 'hiddenFilterNextUp', pascal: 'FilterNextUp', camel: 'filterNextUp' },
    {
        id: 'hiddenFilterContinueWatching',
        pascal: 'FilterContinueWatching',
        camel: 'filterContinueWatching',
    },
    {
        id: 'hiddenExperimentalCollections',
        pascal: 'ExperimentalHideCollections',
        camel: 'experimentalHideCollections',
    },
];

const SPOILER_CONTROLS: ReadonlyArray<{
    id: string;
    field: string;
    directBoolean?: boolean;
}> = [
    { id: 'sbPrefHideOverview', field: 'HideEpisodeDescriptions' },
    { id: 'sbPrefReplaceTitle', field: 'ReplaceEpisodeTitles' },
    { id: 'sbPrefHideChapters', field: 'HideChapterNames' },
    { id: 'sbPrefHideCast', field: 'HideCast' },
    { id: 'sbPrefHideRatings', field: 'HideRatings' },
    { id: 'sbPrefHideAirDate', field: 'HideAirDate' },
    { id: 'sbPrefHideTaglines', field: 'HideTaglines' },
    { id: 'sbPrefHideTags', field: 'HideTags' },
    { id: 'sbPrefHideReviews', field: 'HideReviews' },
    { id: 'sbPrefSkipDisableConfirm', field: 'SkipDisableConfirm', directBoolean: true },
];

const LAYOUTS: ReadonlyArray<{
    layout: Layout;
    seed: 'modern';
    route(targetUserId: string): string;
}> = [
    {
        layout: 'modern',
        seed: 'modern',
        route: targetUserId => `/mypreferencesmenu?userId=${targetUserId}`,
    },
];

const LAYOUT_STAMP: Record<Layout, string> = {
    modern: 'jc-modern-layout',
};

const SHORTCUT_CHOICES: readonly ShortcutChoice[] = [
    { press: 'Control+Alt+9', stored: 'Ctrl+Alt+9' },
    { press: 'Control+Alt+8', stored: 'Ctrl+Alt+8' },
    { press: 'Control+Alt+7', stored: 'Ctrl+Alt+7' },
    { press: 'Control+Alt+6', stored: 'Ctrl+Alt+6' },
];

function normalizeId(value: unknown): string {
    return String(value || '').trim().replace(/-/g, '').toLowerCase();
}

function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function recordOf(value: unknown, label: string): JsonRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} was not a JSON object`);
    }
    return value as JsonRecord;
}

function field<T = unknown>(
    value: JsonRecord,
    pascalName: string,
    camelName: string
): T | undefined {
    return (value[pascalName] ?? value[camelName]) as T | undefined;
}

function ownField(
    value: JsonRecord,
    pascalName: string,
    camelName: string
): unknown {
    if (Object.prototype.hasOwnProperty.call(value, pascalName)) {
        return value[pascalName];
    }
    return value[camelName];
}

function withRevision(value: JsonRecord, revision: number): JsonRecord {
    const result = clone(value);
    delete result.Revision;
    delete result.revision;
    result.Revision = revision;
    return result;
}

function adminFilePath(targetUserId: string, file: UserFile): string {
    return `/JellyfinCanopy/admin/user-settings/${normalizeId(targetUserId)}/${file}`;
}

function pathOf(url: string): string {
    return new URL(url).pathname;
}

function requestBody(request: Request): JsonRecord | null {
    try {
        const value = request.postDataJSON();
        return value && typeof value === 'object' && !Array.isArray(value)
            ? value as JsonRecord
            : null;
    } catch {
        return null;
    }
}

function parseAdminEnvelope(
    raw: unknown,
    expectedFile: UserFile,
    expectedTargetUserId: string,
    expectedSuccess = true
): AdminFileEnvelope {
    const response = recordOf(raw, `${expectedFile} envelope`);
    const data = recordOf(
        field(response, 'Data', 'data'),
        `${expectedFile} envelope data`
    );
    const revision = Number(field(response, 'Revision', 'revision'));
    const contentHash = String(field(response, 'ContentHash', 'contentHash') || '').toLowerCase();
    const targetUserId = normalizeId(field(response, 'TargetUserId', 'targetUserId'));
    const targetDisplayName = String(
        field(response, 'TargetDisplayName', 'targetDisplayName') || ''
    ).trim();
    const itemCountValue = field(response, 'ItemCount', 'itemCount');
    const itemCount = itemCountValue === undefined
        ? undefined
        : Number(itemCountValue);

    expect(field(response, 'Success', 'success'), `${expectedFile} success`).toBe(
        expectedSuccess
    );
    expect(field(response, 'File', 'file'), `${expectedFile} file`).toBe(expectedFile);
    expect(Number.isSafeInteger(revision) && revision >= 0, `${expectedFile} revision`).toBe(true);
    expect(
        Number(field(data, 'Revision', 'revision')),
        `${expectedFile} data revision`
    ).toBe(revision);
    expect(contentHash, `${expectedFile} content hash`).toMatch(/^[0-9a-f]{64}$/);
    expect(targetUserId, `${expectedFile} canonical target id`).toBe(
        normalizeId(expectedTargetUserId)
    );
    expect(targetDisplayName, `${expectedFile} server-resolved target name`).not.toBe('');
    if (expectedFile === 'hidden-content-settings.json') {
        expect(
            Number.isSafeInteger(itemCount) && Number(itemCount) >= 0,
            `${expectedFile} bounded item count`
        ).toBe(true);
    }

    return {
        file: expectedFile,
        revision,
        contentHash,
        data: clone(data),
        targetUserId,
        targetDisplayName,
        ...(itemCount === undefined ? {} : { itemCount }),
    };
}

async function readAdminFile(
    baseURL: string,
    session: Session,
    targetUserId: string,
    file: UserFile
): Promise<AdminFileEnvelope> {
    const response = await apiRaw(
        baseURL,
        adminFilePath(targetUserId, file),
        session.token
    );
    expect(response.status, `admin GET ${file}`).toBe(200);
    const envelope = parseAdminEnvelope(
        await response.json(),
        file,
        targetUserId
    );
    expect(response.headers.get('etag'), `${file} strong ETag`).toBe(
        `"${envelope.revision}"`
    );
    expect(
        response.headers.get('x-jc-content-hash'),
        `${file} content-hash evidence`
    ).toBe(envelope.contentHash);
    return envelope;
}

async function writeAdminFile(
    baseURL: string,
    session: Session,
    targetUserId: string,
    current: AdminFileEnvelope,
    desiredData: JsonRecord
): Promise<AdminFileEnvelope> {
    const response = await apiRaw(
        baseURL,
        adminFilePath(targetUserId, current.file),
        session.token,
        {
            method: 'POST',
            headers: { 'If-Match': `"${current.revision}"` },
            body: JSON.stringify(withRevision(desiredData, current.revision)),
        }
    );
    expect(response.status, `admin POST ${current.file}`).toBe(200);
    const envelope = parseAdminEnvelope(
        await response.json(),
        current.file,
        targetUserId
    );
    expect(response.headers.get('etag'), `${current.file} POST ETag`).toBe(
        `"${envelope.revision}"`
    );
    expect(
        response.headers.get('x-jc-content-hash'),
        `${current.file} POST content-hash evidence`
    ).toBe(envelope.contentHash);
    return envelope;
}

async function readSelfFile(
    baseURL: string,
    session: Session,
    file: RawUserFile,
    userId: string = session.userId
): Promise<JsonRecord> {
    const response = await apiRaw(
        baseURL,
        `/JellyfinCanopy/user-settings/${normalizeId(userId)}/${file}`,
        session.token
    );
    expect(response.status, `fresh user GET ${file}`).toBe(200);
    return recordOf(await response.json(), `fresh user ${file}`);
}

async function resolveUsers(baseURL: string): Promise<ResolvedUsers> {
    const adminSession = await authenticate(
        baseURL,
        USERS.admin.username,
        USERS.admin.password
    );
    const targetSession = await authenticate(
        baseURL,
        USERS.user.username,
        USERS.user.password
    );
    const response = await apiRaw(baseURL, '/Users', adminSession.token);
    expect(response.status, 'admin can resolve real Jellyfin users').toBe(200);
    const raw = await response.json() as unknown;
    const candidates = Array.isArray(raw)
        ? raw
        : field<unknown[]>(recordOf(raw, 'Jellyfin users response'), 'Items', 'items');
    expect(Array.isArray(candidates), 'Jellyfin users response is a list').toBe(true);

    const users = (candidates || []).map((candidate) => {
        const user = recordOf(candidate, 'Jellyfin user');
        return {
            id: normalizeId(field(user, 'Id', 'id')),
            displayName: String(
                field(user, 'Name', 'name')
                ?? field(user, 'Username', 'username')
                ?? ''
            ).trim(),
        };
    });
    const adminId = normalizeId(adminSession.userId);
    const targetId = normalizeId(targetSession.userId);
    const admin = users.find(user => user.id === adminId);
    const target = users.find(user => user.id === targetId);

    expect(admin, `resolved ${USERS.admin.username} from /Users`).toBeTruthy();
    expect(target, `resolved ${USERS.user.username} from /Users`).toBeTruthy();
    expect(adminId, 'admin id is a canonical Jellyfin GUID').toMatch(/^[0-9a-f]{32}$/);
    expect(targetId, 'target id is a canonical Jellyfin GUID').toMatch(/^[0-9a-f]{32}$/);
    expect(targetId, 'actor and target are distinct real users').not.toBe(adminId);
    expect(admin!.displayName, 'admin display name is server-resolved').not.toBe('');
    expect(target!.displayName, 'target display name is server-resolved').not.toBe('');

    return {
        admin: admin!,
        target: target!,
        adminSession,
        targetSession,
    };
}

async function snapshotOriginalFiles(
    baseURL: string,
    users: ResolvedUsers
): Promise<OriginalFiles> {
    const [
        adminSettings,
        adminShortcuts,
        adminHiddenContent,
        adminSpoilerGuard,
        adminSpoilerOverrides,
        targetSettings,
        targetShortcuts,
        targetHiddenContent,
        targetSpoilerGuard,
        targetSpoilerOverrides,
    ] =
        await Promise.all([
            readAdminFile(baseURL, users.adminSession, users.admin.id, 'settings.json'),
            readAdminFile(baseURL, users.adminSession, users.admin.id, 'shortcuts.json'),
            readAdminFile(
                baseURL,
                users.adminSession,
                users.admin.id,
                'hidden-content-settings.json'
            ),
            readAdminFile(
                baseURL,
                users.adminSession,
                users.admin.id,
                'spoiler-guard-prefs.json'
            ),
            readAdminFile(
                baseURL,
                users.adminSession,
                users.admin.id,
                'spoiler-guard-overrides.json'
            ),
            readAdminFile(baseURL, users.adminSession, users.target.id, 'settings.json'),
            readAdminFile(baseURL, users.adminSession, users.target.id, 'shortcuts.json'),
            readAdminFile(
                baseURL,
                users.adminSession,
                users.target.id,
                'hidden-content-settings.json'
            ),
            readAdminFile(
                baseURL,
                users.adminSession,
                users.target.id,
                'spoiler-guard-prefs.json'
            ),
            readAdminFile(
                baseURL,
                users.adminSession,
                users.target.id,
                'spoiler-guard-overrides.json'
            ),
        ]);
    for (const file of [
        adminSettings,
        adminShortcuts,
        adminHiddenContent,
        adminSpoilerGuard,
        adminSpoilerOverrides,
    ]) {
        expect(file.targetDisplayName).toBe(users.admin.displayName);
    }
    for (const file of [
        targetSettings,
        targetShortcuts,
        targetHiddenContent,
        targetSpoilerGuard,
        targetSpoilerOverrides,
    ]) {
        expect(file.targetDisplayName).toBe(users.target.displayName);
    }
    return {
        admin: {
            settings: adminSettings,
            shortcuts: adminShortcuts,
            hiddenContent: adminHiddenContent,
            spoilerGuard: adminSpoilerGuard,
            spoilerOverrides: adminSpoilerOverrides,
        },
        target: {
            settings: targetSettings,
            shortcuts: targetShortcuts,
            hiddenContent: targetHiddenContent,
            spoilerGuard: targetSpoilerGuard,
            spoilerOverrides: targetSpoilerOverrides,
        },
    };
}

function userFiles(files: UserFiles): readonly AdminFileEnvelope[] {
    return [
        files.settings,
        files.shortcuts,
        files.hiddenContent,
        files.spoilerGuard,
        files.spoilerOverrides,
    ];
}

async function restoreFile(
    baseURL: string,
    adminSession: Session,
    targetUserId: string,
    original: AdminFileEnvelope
): Promise<void> {
    // Re-read immediately before every cleanup write. This deliberately does
    // not reuse the revision captured at test start.
    const current = await readAdminFile(
        baseURL,
        adminSession,
        targetUserId,
        original.file
    );
    const response = await apiRaw(
        baseURL,
        adminFilePath(targetUserId, original.file),
        adminSession.token,
        {
            method: 'POST',
            headers: { 'If-Match': `"${current.revision}"` },
            body: JSON.stringify(withRevision(original.data, current.revision)),
        }
    );
    expect(response.status, `restore ${original.file}`).toBe(200);
    const acknowledgement = parseAdminEnvelope(
        await response.json(),
        original.file,
        targetUserId
    );
    // The server acknowledges an already-restored payload as a no-op at the
    // current revision; a real restoration advances it exactly once.
    expect(
        [current.revision, current.revision + 1],
        `${original.file} cleanup acknowledgement revision`
    ).toContain(acknowledgement.revision);
    const restored = await readAdminFile(
        baseURL,
        adminSession,
        targetUserId,
        original.file
    );
    expect(
        restored.contentHash,
        `${original.file} original content restored`
    ).toBe(original.contentHash);
}

async function restoreAllFiles(
    baseURL: string,
    users: ResolvedUsers,
    originals: OriginalFiles
): Promise<void> {
    const restorations = await Promise.allSettled(
        [
            ...userFiles(originals.admin).map(file => ({
                targetUserId: users.admin.id,
                file,
            })),
            ...userFiles(originals.target).map(file => ({
                targetUserId: users.target.id,
                file,
            })),
        ].map(({ targetUserId, file }) =>
            restoreFile(
                baseURL,
                users.adminSession,
                targetUserId,
                file
            ))
    );
    const failures = restorations
        .map((result, index) => ({ result, index }))
        .filter(({ result }) => result.status === 'rejected')
        .map(({ result, index }) => {
            const reason = result.status === 'rejected' ? result.reason : null;
            return `restore[${index}]: ${reason instanceof Error ? reason.message : String(reason)}`;
        });
    if (failures.length > 0) {
        throw new Error(`One or more user files could not be restored: ${failures.join('; ')}`);
    }
}

async function expectFilesUnchanged(
    baseURL: string,
    users: ResolvedUsers,
    originals: OriginalFiles
): Promise<void> {
    const current = await snapshotOriginalFiles(baseURL, users);
    for (const owner of ['admin', 'target'] as const) {
        const currentFiles = userFiles(current[owner]);
        const originalFiles = userFiles(originals[owner]);
        for (let index = 0; index < originalFiles.length; index++) {
            const original = originalFiles[index];
            const now = currentFiles[index];
            expect(
                now.contentHash,
                `${owner} ${original.file} content remains exact`
            ).toBe(original.contentHash);
            expect(
                now.revision,
                `${owner} ${original.file} revision remains exact`
            ).toBe(original.revision);
        }
    }
}

async function snapshotPersistentStores(
    baseURL: string,
    users: ResolvedUsers
): Promise<PersistentStores> {
    const [
        adminHiddenContent,
        adminSpoilerGuard,
        targetHiddenContent,
        targetSpoilerGuard,
    ] = await Promise.all([
        readSelfFile(
            baseURL,
            users.adminSession,
            'hidden-content.json',
            users.admin.id
        ),
        readSelfFile(
            baseURL,
            users.adminSession,
            'spoilerblur.json',
            users.admin.id
        ),
        readSelfFile(
            baseURL,
            users.adminSession,
            'hidden-content.json',
            users.target.id
        ),
        readSelfFile(
            baseURL,
            users.adminSession,
            'spoilerblur.json',
            users.target.id
        ),
    ]);
    return {
        adminHiddenContent,
        adminSpoilerGuard,
        targetHiddenContent,
        targetSpoilerGuard,
    };
}

function nestedRecord(
    value: JsonRecord,
    pascalName: string,
    camelName: string
): JsonRecord {
    return recordOf(
        field(value, pascalName, camelName) ?? {},
        `${pascalName} store`
    );
}

function overrideSection(
    value: JsonRecord,
    section: SpoilerOverrideSection
): JsonRecord {
    const camel = section === 'PendingTmdb'
        ? 'pendingTmdb'
        : `${section[0].toLowerCase()}${section.slice(1)}`;
    return nestedRecord(value, section, camel);
}

function fixtureEntry(
    value: JsonRecord,
    fixture: SpoilerOverrideFixture
): JsonRecord | undefined {
    const raw = overrideSection(value, fixture.section)[fixture.key];
    return raw && typeof raw === 'object' && !Array.isArray(raw)
        ? raw as JsonRecord
        : undefined;
}

function expectFixture(
    value: JsonRecord,
    fixture: SpoilerOverrideFixture,
    present: boolean
): void {
    const entry = fixtureEntry(value, fixture);
    if (!present) {
        expect(
            entry,
            `${fixture.kind} override ${fixture.key} is absent`
        ).toBeUndefined();
        return;
    }
    expect(entry, `${fixture.kind} override ${fixture.key} is present`).toBeTruthy();
    expect(field(entry!, fixture.idField, `${fixture.idField[0].toLowerCase()}${fixture.idField.slice(1)}`))
        .toBe(fixture.id);
    expect(field(entry!, fixture.nameField, `${fixture.nameField[0].toLowerCase()}${fixture.nameField.slice(1)}`))
        .toBe(fixture.displayName);
    if (fixture.mediaType) {
        expect(field(entry!, 'MediaType', 'mediaType')).toBe(fixture.mediaType);
    }
}

async function chooseSpoilerOverrideFixtures(
    baseURL: string,
    users: ResolvedUsers,
    original: JsonRecord
): Promise<readonly SpoilerOverrideFixture[]> {
    const response = await apiRaw(
        baseURL,
        `/Items?Recursive=true&IncludeItemTypes=Series,Movie,BoxSet&Limit=100&userId=${users.target.id}&Fields=Name`,
        users.adminSession.token
    );
    expect(response.status, 'target-visible override fixture query').toBe(200);
    const payload = recordOf(
        await response.json(),
        'target-visible override fixture query'
    );
    const items = (field<unknown[]>(payload, 'Items', 'items') ?? [])
        .filter(value => !!value && typeof value === 'object' && !Array.isArray(value))
        .map(value => value as JsonRecord);
    const targetVisible = (
        itemType: 'Series' | 'Movie' | 'BoxSet',
        section: Exclude<SpoilerOverrideSection, 'PendingTmdb'>
    ): { id: string; name: string } => {
        const existing = new Set(
            Object.keys(overrideSection(original, section)).map(normalizeId)
        );
        const item = items.find(candidate => {
            const id = normalizeId(field(candidate, 'Id', 'id'));
            const name = String(field(candidate, 'Name', 'name') || '').trim();
            return field(candidate, 'Type', 'type') === itemType
                && /^[0-9a-f]{32}$/.test(id)
                && !existing.has(id)
                && name.length > 0
                && name.length <= 512;
        });
        expect(
            item,
            `an unconfigured target-visible ${itemType} is available`
        ).toBeTruthy();
        return {
            id: normalizeId(field(item!, 'Id', 'id')),
            name: String(field(item!, 'Name', 'name')).trim(),
        };
    };
    const uniqueTmdb = (mediaType: 'tv' | 'movie', first: number): string => {
        const existing = overrideSection(original, 'PendingTmdb');
        const existingKeys = new Set(Object.keys(existing).map(key => key.toLowerCase()));
        for (let value = first; value < first + 10_000; value++) {
            if (!existingKeys.has(`${mediaType}:${value}`)) {
                return String(value);
            }
        }
        throw new Error(`No collision-free pending ${mediaType} fixture ID was available`);
    };
    const series = targetVisible('Series', 'Series');
    const movie = targetVisible('Movie', 'Movies');
    const collection = targetVisible('BoxSet', 'Collections');
    const pendingTvId = uniqueTmdb('tv', 900_000_000);
    const pendingMovieId = uniqueTmdb('movie', 910_000_000);
    const label = 'Modern';
    return [
        {
            kind: 'series',
            section: 'Series',
            id: series.id,
            key: series.id,
            displayName: series.name,
            idField: 'SeriesId',
            nameField: 'SeriesName',
        },
        {
            kind: 'movie',
            section: 'Movies',
            id: movie.id,
            key: movie.id,
            displayName: movie.name,
            idField: 'MovieId',
            nameField: 'MovieName',
        },
        {
            kind: 'collection',
            section: 'Collections',
            id: collection.id,
            key: collection.id,
            displayName: collection.name,
            idField: 'CollectionId',
            nameField: 'CollectionName',
        },
        {
            kind: 'pending-tv',
            section: 'PendingTmdb',
            id: pendingTvId,
            key: `tv:${pendingTvId}`,
            displayName: `${label} E2E pending series`,
            idField: 'TmdbId',
            nameField: 'DisplayName',
            mediaType: 'tv',
        },
        {
            kind: 'pending-movie',
            section: 'PendingTmdb',
            id: pendingMovieId,
            key: `movie:${pendingMovieId}`,
            displayName: `${label} E2E pending movie`,
            idField: 'TmdbId',
            nameField: 'DisplayName',
            mediaType: 'movie',
        },
    ];
}

function expectOverrideDictionaryState(
    value: JsonRecord,
    original: JsonRecord,
    allFixtures: readonly SpoilerOverrideFixture[],
    presentFixtures: readonly SpoilerOverrideFixture[]
): void {
    for (const section of [
        'Series',
        'Movies',
        'Collections',
        'PendingTmdb',
    ] as const) {
        const before = overrideSection(original, section);
        const after = overrideSection(value, section);
        for (const [key, entry] of Object.entries(before)) {
            expect(
                after[key],
                `${section} preserves pre-existing override ${key}`
            ).toEqual(entry);
        }
        expect(
            Object.keys(after),
            `${section} contains only the original and expected E2E keys`
        ).toHaveLength(
            Object.keys(before).length
                + presentFixtures.filter(fixture => fixture.section === section).length
        );
    }
    const present = new Set(presentFixtures.map(fixture => fixture.key));
    for (const fixture of allFixtures) {
        expectFixture(value, fixture, present.has(fixture.key));
    }
}

function overrideRowCount(value: JsonRecord): number {
    return ([
        'Series',
        'Movies',
        'Collections',
        'PendingTmdb',
    ] as const).reduce(
        (total, section) => total + Object.keys(overrideSection(value, section)).length,
        0
    );
}

async function seedSpoilerOverridePagingFixture(
    baseURL: string,
    users: ResolvedUsers,
    current: AdminFileEnvelope
): Promise<AdminFileEnvelope> {
    const desired = clone(current.data);
    let total = overrideRowCount(desired);
    if (total >= 55) return current;
    const now = new Date().toISOString();
    const dictionary = overrideSection(desired, 'PendingTmdb');
    const existing = new Set(Object.keys(dictionary).map(key => key.toLowerCase()));
    for (
        let tmdbId = 920_000_000;
        tmdbId < 920_010_000
            && total < 55
            && Object.keys(dictionary).length < 1000;
        tmdbId++
    ) {
        const key = `tv:${tmdbId}`;
        if (existing.has(key)) continue;
        dictionary[key] = {
            MediaType: 'tv',
            TmdbId: String(tmdbId),
            DisplayName: `E2E paging fixture ${String(total + 1).padStart(3, '0')}`,
            RequestedAt: now,
        };
        existing.add(key);
        total++;
    }
    expect(total, 'the reversible override seed reaches a second 50-row page')
        .toBeGreaterThanOrEqual(55);
    const seeded = await writeAdminFile(
        baseURL,
        users.adminSession,
        users.target.id,
        current,
        desired
    );
    expect(overrideRowCount(seeded.data)).toBe(total);
    return seeded;
}

function hiddenItemsRevision(value: JsonRecord, label: string): number {
    const revision = Number(field(value, 'ItemsRevision', 'itemsRevision'));
    expect(
        Number.isSafeInteger(revision) && revision >= 0,
        `${label} item-set revision`
    ).toBe(true);
    return revision;
}

function hiddenStateContainsItem(value: JsonRecord, itemId: string): boolean {
    const wanted = normalizeId(itemId);
    return Object.entries(nestedRecord(value, 'Items', 'items')).some(([key, raw]) => {
        const item = raw && typeof raw === 'object' && !Array.isArray(raw)
            ? raw as JsonRecord
            : {};
        return normalizeId(key) === wanted
            || normalizeId(field(item, 'ItemId', 'itemId')) === wanted;
    });
}

async function seedHiddenFixture(
    baseURL: string,
    users: ResolvedUsers,
    originalHiddenState: JsonRecord
): Promise<HiddenFixture> {
    const originalItemsRevision = hiddenItemsRevision(
        originalHiddenState,
        'original target Hidden Content'
    );
    const existingItems = nestedRecord(originalHiddenState, 'Items', 'items');
    const existingIds = new Set<string>([
        ...Object.keys(existingItems).map(normalizeId),
        ...Object.values(existingItems).map(value => {
            const item = value && typeof value === 'object' && !Array.isArray(value)
                ? value as JsonRecord
                : {};
            return normalizeId(field(item, 'ItemId', 'itemId'));
        }),
    ]);
    const response = await apiRaw(
        baseURL,
        `/Items?Recursive=true&IncludeItemTypes=Movie&Limit=25&userId=${users.target.id}`,
        users.adminSession.token
    );
    expect(response.status, 'fixture movie query').toBe(200);
    const payload = recordOf(await response.json(), 'fixture movie query');
    const items = field<unknown[]>(payload, 'Items', 'items') ?? [];
    const movie = items
        .filter(value => !!value && typeof value === 'object' && !Array.isArray(value))
        .map(value => value as JsonRecord)
        .find(value => {
            const id = normalizeId(field(value, 'Id', 'id'));
            return /^[0-9a-f]{32}$/.test(id) && !existingIds.has(id);
        });
    expect(movie, 'an unhidden fixture movie is available').toBeTruthy();
    const itemId = String(field(movie!, 'Id', 'id'));
    const item = {
        ItemId: itemId,
        Name: String(field(movie!, 'Name', 'name') || ''),
        Type: 'Movie',
        HiddenAt: new Date().toISOString(),
        HideScope: 'global',
    };
    const hide = await apiRaw(
        baseURL,
        `/JellyfinCanopy/admin/hidden-content/${users.target.id}/hide`,
        users.adminSession.token,
        {
            method: 'POST',
            headers: { 'If-Match': `"${originalItemsRevision}"` },
            body: JSON.stringify([item]),
        }
    );
    expect(hide.status, 'seed target hidden item').toBe(200);
    const acknowledgement = recordOf(
        await hide.json(),
        'seed target hidden item acknowledgement'
    );
    expect(field(acknowledgement, 'Success', 'success')).toBe(true);
    expect(Number(field(acknowledgement, 'Added', 'added'))).toBe(1);
    const itemsRevision = hiddenItemsRevision(
        acknowledgement,
        'seed target hidden item acknowledgement'
    );
    expect(itemsRevision, 'seeding advances the target item set once').toBe(
        originalItemsRevision + 1
    );
    expect(hide.headers.get('etag'), 'seed target hidden item ETag').toBe(
        `"${itemsRevision}"`
    );
    return { itemId, item, itemsRevision };
}

async function removeHiddenFixture(
    baseURL: string,
    users: ResolvedUsers,
    fixture: HiddenFixture
): Promise<void> {
    // The workflow deliberately reauthenticates the target to prove a fresh
    // session observes every write. Jellyfin may retire an older token for the
    // same test device, so cleanup must use the still-authoritative admin
    // session instead of the target token captured before those reauths.
    const current = await readSelfFile(
        baseURL,
        users.adminSession,
        'hidden-content.json',
        users.target.id
    );
    if (!hiddenStateContainsItem(current, fixture.itemId)) return;

    const currentItemsRevision = hiddenItemsRevision(
        current,
        'target Hidden Content cleanup'
    );
    const response = await apiRaw(
        baseURL,
        `/JellyfinCanopy/admin/hidden-content/${users.target.id}/unhide`,
        users.adminSession.token,
        {
            method: 'POST',
            headers: { 'If-Match': `"${currentItemsRevision}"` },
            body: JSON.stringify([fixture.itemId]),
        }
    );
    expect(response.status, 'remove target hidden fixture').toBe(200);
    const acknowledgement = recordOf(
        await response.json(),
        'remove target hidden fixture acknowledgement'
    );
    expect(field(acknowledgement, 'Success', 'success')).toBe(true);
    expect(
        hiddenItemsRevision(
            acknowledgement,
            'remove target hidden fixture acknowledgement'
        )
    ).toBe(currentItemsRevision + 1);
    expect(response.headers.get('etag'), 'remove target hidden fixture ETag').toBe(
        `"${currentItemsRevision + 1}"`
    );
}

async function seedLayout(page: Page, seed: string): Promise<void> {
    await page.addInitScript((value) => localStorage.setItem('layout', value), seed);
}

async function expectExactLayout(page: Page, layout: Layout): Promise<void> {
    const wanted = LAYOUT_STAMP[layout];
    await page.waitForFunction(
        stamp => document.documentElement.classList.contains(stamp),
        wanted,
        { timeout: 20_000 }
    );
    expect(await page.locator('html').evaluate(
        (root, stamp) => root.classList.contains(stamp),
        wanted,
    )).toBe(true);
}

async function browserUserId(page: Page): Promise<string> {
    return normalizeId(await page.evaluate(
        () => (window as any).ApiClient.getCurrentUserId()
    ));
}

async function openTargetPreferencesRoute(
    page: Page,
    route: string,
    targetUserId: string
): Promise<Locator> {
    await showRoute(page, route);
    await waitForHash(page, '#/mypreferencesmenu');
    await page.waitForFunction((expectedTarget) => {
        const query = window.location.hash.split('?')[1] || '';
        const actual = new URLSearchParams(query).get('userId') || '';
        return actual.replace(/-/g, '').toLowerCase() === expectedTarget;
    }, normalizeId(targetUserId), { timeout: 30_000 });
    await page.waitForFunction(() => {
        const roots = Array.from(document.querySelectorAll<HTMLElement>('#myPreferencesMenuPage'))
            .filter(root => !root.closest('.hide') && root.getClientRects().length > 0);
        const links = Array.from(
            document.querySelectorAll<HTMLElement>('#jellyfinCanopyUserPrefsLink')
        );
        return roots.length === 1
            && links.length === 1
            && roots[0].contains(links[0])
            && links[0].getClientRects().length > 0;
    }, undefined, { timeout: 30_000 });

    const link = page.locator('#jellyfinCanopyUserPrefsLink');
    await expect(link).toHaveCount(1);
    await expect(link).toBeVisible();
    const expectedTitle = await page.evaluate(
        () => (window as any).JellyfinCanopy.t('panel_title')
    );
    expect(typeof expectedTitle, 'localized panel title type').toBe('string');
    expect(expectedTitle, 'localized panel title is non-empty').not.toBe('');
    expect(expectedTitle, 'the localized panel title is available').not.toBe('panel_title');
    await expect(link).toHaveText(expectedTitle);
    return link;
}

async function captureActorIsolation(page: Page): Promise<unknown> {
    return page.evaluate(async () => {
        const JC = (window as any).JellyfinCanopy;
        const identity = JC.identity.capture();
        const stringify = (value: unknown): string => {
            if (value === undefined) return '<undefined>';
            return JSON.stringify(value) ?? '<undefined>';
        };
        const digest = async (value: string): Promise<string> => {
            const bytes = new TextEncoder().encode(value);
            const hash = await crypto.subtle.digest('SHA-256', bytes);
            return Array.from(new Uint8Array(hash))
                .map(byte => byte.toString(16).padStart(2, '0'))
                .join('');
        };
        const storageEntries = async (
            storage: Storage
        ): Promise<Array<[string, string]>> => {
            const keys = Object.keys(storage)
                .filter((key) =>
                    key === 'layout'
                    || /^(?:jc(?:[-_:]|$)|je(?:[-_:]|$)|jellyfincanopy|jellyfinelevate)/i.test(key)
                    || key.toLowerCase() === `${identity.userId.toLowerCase()}-language`
                )
                .sort();
            return Promise.all(keys.map(async key => [
                key,
                await digest(storage.getItem(key) ?? '<null>'),
            ] as [string, string]));
        };
        const [
            currentSettingsHash,
            userConfigSettingsHash,
            userConfigShortcutsHash,
            activeShortcutsHash,
            openSearchShortcutHash,
            hiddenContentSettingsHash,
            spoilerGuardPrefsHash,
            localStorageHashes,
            sessionStorageHashes,
        ] = await Promise.all([
            digest(stringify(JC.currentSettings)),
            digest(stringify(JC.userConfig?.settings)),
            digest(stringify(JC.userConfig?.shortcuts)),
            digest(stringify(JC.state?.activeShortcuts)),
            digest(stringify(JC.state?.activeShortcuts?.OpenSearch)),
            digest(stringify(JC.hiddenContent?.getSettings?.())),
            digest(stringify(JC.spoilerGuard?.getUserPrefs?.())),
            storageEntries(window.localStorage),
            storageEntries(window.sessionStorage),
        ]);
        return {
            currentUserId: String((window as any).ApiClient.getCurrentUserId()).replace(/-/g, '').toLowerCase(),
            identity: {
                serverId: identity.serverId,
                userId: identity.userId,
                epoch: identity.epoch,
            },
            ownership: {
                currentSettings: JC.identity.isOwned(JC.currentSettings, identity),
                userConfigSettings: JC.identity.isOwned(JC.userConfig?.settings, identity),
                userConfigShortcuts: JC.identity.isOwned(JC.userConfig?.shortcuts, identity),
            },
            globals: {
                currentSettingsHash,
                userConfigSettingsHash,
                userConfigShortcutsHash,
                activeShortcutsHash,
                hiddenContentSettingsHash,
                spoilerGuardPrefsHash,
            },
            live: {
                openSearchShortcutHash,
                keyListenerType: typeof JC.keyListener,
                initialized: JC.initialized === true,
            },
            storage: {
                local: localStorageHashes,
                session: sessionStorageHashes,
            },
        };
    });
}

function collectUserFileTraffic(requests: UserFileTraffic[]): (request: Request) => void {
    return (request: Request) => {
        const path = pathOf(request.url());
        if (!/\/JellyfinCanopy\/(?:admin\/)?user-settings\//.test(path)) return;
        requests.push({
            method: request.method(),
            path,
        });
    };
}

function collectUserFileResponses(responses: UserFileResponse[]): (response: BrowserResponse) => void {
    return (response: BrowserResponse) => {
        const request = response.request();
        const path = pathOf(request.url());
        if (!/\/JellyfinCanopy\/(?:admin\/)?user-settings\//.test(path)) return;
        responses.push({
            method: request.method(),
            path,
            status: response.status(),
        });
    };
}

function exactAdminResponse(
    response: BrowserResponse,
    targetUserId: string,
    file: UserFile,
    method: 'GET' | 'POST'
): boolean {
    return response.request().method() === method
        && pathOf(response.url()) === adminFilePath(targetUserId, file);
}

async function assertBrowserEnvelope(
    response: BrowserResponse,
    targetUserId: string,
    file: UserFile
): Promise<AdminFileEnvelope> {
    expect(response.status(), `${response.request().method()} target ${file}`).toBe(200);
    const envelope = parseAdminEnvelope(await response.json(), file, targetUserId);
    expect(response.headers()['etag'], `${file} response ETag`).toBe(`"${envelope.revision}"`);
    expect(response.headers()['x-jc-content-hash'], `${file} response content hash`).toBe(
        envelope.contentHash
    );
    return envelope;
}

function shortcutEntries(value: JsonRecord): JsonRecord[] {
    const shortcuts = field<unknown[]>(value, 'Shortcuts', 'shortcuts');
    return Array.isArray(shortcuts)
        ? shortcuts.filter(
            candidate => !!candidate && typeof candidate === 'object' && !Array.isArray(candidate)
        ) as JsonRecord[]
        : [];
}

function findShortcut(value: JsonRecord, name: string): JsonRecord | undefined {
    return shortcutEntries(value).find(
        entry => field(entry, 'Name', 'name') === name
    );
}

function chooseShortcut(existing: readonly string[], original: string): ShortcutChoice {
    const choice = SHORTCUT_CHOICES.find(
        candidate => candidate.stored !== original && !existing.includes(candidate.stored)
    );
    if (!choice) throw new Error('No collision-free E2E shortcut candidate was available');
    return choice;
}

function assertStrongMutationRequest(
    request: Request,
    expectedFile: UserFile
): JsonRecord {
    const ifMatch = request.headers()['if-match'] || '';
    expect(ifMatch, `${expectedFile} uses a strong quoted If-Match`).toMatch(/^"\d+"$/);
    const body = requestBody(request);
    expect(body, `${expectedFile} request body`).not.toBeNull();
    expect(
        Number(field(body!, 'Revision', 'revision')),
        `${expectedFile} body revision matches If-Match`
    ).toBe(Number(ifMatch.slice(1, -1)));
    return body!;
}

async function translatedStatusText(
    page: Page,
    key: 'panel_admin_target_saving'
        | 'panel_admin_target_saved'
        | 'panel_admin_target_refresh_status'
): Promise<string> {
    const value = await page.evaluate(
        translationKey => (window as any).JellyfinCanopy.t(translationKey),
        key
    );
    expect(typeof value, `${key} translation type`).toBe('string');
    expect(value, `${key} translation is non-empty`).not.toBe('');
    expect(value, `${key} translation is available`).not.toBe(key);
    return value;
}

async function translatedText(page: Page, key: string): Promise<string> {
    const value = await page.evaluate(
        translationKey => (window as any).JellyfinCanopy.t(translationKey),
        key
    );
    expect(typeof value, `${key} translation type`).toBe('string');
    expect(value, `${key} translation is non-empty`).not.toBe('');
    expect(value, `${key} translation is available`).not.toBe(key);
    return value;
}

async function beginStatusRecording(
    page: Page,
    status: Locator,
    name: string
): Promise<void> {
    await status.evaluate((element, recorderName) => {
        const scope = window as any;
        scope.__jcAdminTargetStatusRecords ||= {};
        scope.__jcAdminTargetStatusObservers ||= {};
        scope.__jcAdminTargetStatusObservers[recorderName]?.disconnect?.();
        const records: string[] = [];
        scope.__jcAdminTargetStatusRecords[recorderName] = records;
        const capture = () => {
            const text = element.textContent?.trim() || '';
            if (text && records[records.length - 1] !== text) records.push(text);
        };
        const observer = new MutationObserver(capture);
        observer.observe(element, {
            characterData: true,
            childList: true,
            subtree: true,
        });
        scope.__jcAdminTargetStatusObservers[recorderName] = observer;
        capture();
    }, name);
}

async function statusRecords(page: Page, name: string): Promise<string[]> {
    return page.evaluate(
        recorderName => [
            ...((window as any).__jcAdminTargetStatusRecords?.[recorderName] || []),
        ],
        name
    );
}

async function exerciseHiddenPreferences(
    page: Page,
    panel: Locator,
    users: ResolvedUsers,
    loaded: AdminFileEnvelope,
    actorBefore: unknown
): Promise<AdminFileEnvelope> {
    await panel.locator('.tab-button[data-tab="hidden-content"]').click();
    const pane = panel.locator('.jc-pane[data-pane="hidden-content"]');
    await expect(pane).toBeVisible();
    const status = pane.locator('#hiddenContentSaveStatus');
    await expect(status).toHaveAttribute('role', 'status');
    await expect(status).toHaveAttribute('aria-live', 'polite');
    const savingText = await translatedStatusText(page, 'panel_admin_target_saving');
    const savedText = await translatedStatusText(page, 'panel_admin_target_saved');
    await translatedStatusText(page, 'panel_admin_target_refresh_status');
    await beginStatusRecording(page, status, 'hidden-content');

    let current = loaded;
    for (const control of HIDDEN_CONTROLS) {
        const input = pane.locator(`#${control.id}`);
        await expect(input, `${control.id} is rendered for the target`).toBeVisible();
        const expectedInitial = Boolean(
            ownField(current.data, control.pascal, control.camel)
        );
        expect(
            await input.isChecked(),
            `${control.id} reflects target state`
        ).toBe(expectedInitial);
        const next = !expectedInitial;
        const postPromise = page.waitForResponse((response) => {
            if (!exactAdminResponse(
                response,
                users.target.id,
                'hidden-content-settings.json',
                'POST'
            )) return false;
            const body = requestBody(response.request());
            return body !== null
                && ownField(body, control.pascal, control.camel) === next;
        }, { timeout: 30_000 });
        await input.setChecked(next);
        const post = await postPromise;
        const body = assertStrongMutationRequest(
            post.request(),
            'hidden-content-settings.json'
        );
        expect(ownField(body, control.pascal, control.camel)).toBe(next);
        const saved = await assertBrowserEnvelope(
            post,
            users.target.id,
            'hidden-content-settings.json'
        );
        expect(saved.revision, `${control.id} advances one revision`).toBe(
            current.revision + 1
        );
        expect(ownField(saved.data, control.pascal, control.camel)).toBe(next);
        await expect(status).toHaveText(savedText);
        await expect(status).toHaveAttribute('aria-busy', 'false');
        current = saved;
    }

    expect(await statusRecords(page, 'hidden-content')).toEqual(
        expect.arrayContaining([savingText, savedText])
    );
    expect(
        await captureActorIsolation(page),
        'target Hidden Content saves leave actor globals and browser storage unchanged'
    ).toEqual(actorBefore);
    return current;
}

async function exerciseSpoilerPreferences(
    page: Page,
    panel: Locator,
    users: ResolvedUsers,
    loaded: AdminFileEnvelope,
    actorBefore: unknown
): Promise<AdminFileEnvelope> {
    await panel.locator('.tab-button[data-tab="spoiler-guard"]').click();
    const pane = panel.locator('.jc-pane[data-pane="spoiler-guard"]');
    await expect(pane).toBeVisible();
    const status = pane.locator('#spoilerGuardSaveStatus');
    await expect(status).toHaveAttribute('role', 'status');
    await expect(status).toHaveAttribute('aria-live', 'polite');
    const savingText = await translatedStatusText(page, 'panel_admin_target_saving');
    const savedText = await translatedStatusText(page, 'panel_admin_target_saved');
    await translatedStatusText(page, 'panel_admin_target_refresh_status');
    await beginStatusRecording(page, status, 'spoiler-guard');

    let current = loaded;
    let rendered = 0;
    for (const control of SPOILER_CONTROLS) {
        const input = pane.locator(`#${control.id}`);
        if (await input.count() === 0) continue;
        rendered++;
        await expect(input, `${control.id} is visible when its admin gate is enabled`).toBeVisible();
        const currentValue = ownField(current.data, control.field, `${control.field[0].toLowerCase()}${control.field.slice(1)}`);
        const expectedInitial = control.directBoolean
            ? currentValue === true
            : currentValue !== false;
        expect(
            await input.isChecked(),
            `${control.id} reflects target state`
        ).toBe(expectedInitial);
        const nextChecked = !expectedInitial;
        const expectedWire = control.directBoolean
            ? nextChecked
            : (nextChecked ? null : false);
        const camel = `${control.field[0].toLowerCase()}${control.field.slice(1)}`;
        const postPromise = page.waitForResponse((response) => {
            if (!exactAdminResponse(
                response,
                users.target.id,
                'spoiler-guard-prefs.json',
                'POST'
            )) return false;
            const body = requestBody(response.request());
            return body !== null
                && ownField(body, control.field, camel) === expectedWire;
        }, { timeout: 30_000 });
        await input.setChecked(nextChecked);
        const post = await postPromise;
        const body = assertStrongMutationRequest(
            post.request(),
            'spoiler-guard-prefs.json'
        );
        expect(ownField(body, control.field, camel)).toBe(expectedWire);
        const saved = await assertBrowserEnvelope(
            post,
            users.target.id,
            'spoiler-guard-prefs.json'
        );
        expect(saved.revision, `${control.id} advances one revision`).toBe(
            current.revision + 1
        );
        expect(ownField(saved.data, control.field, camel)).toBe(expectedWire);
        await expect(status).toHaveText(savedText);
        await expect(status).toHaveAttribute('aria-busy', 'false');
        current = saved;
    }
    expect(rendered, 'at least one server-backed Spoiler Guard control is exposed').toBeGreaterThan(0);
    expect(await statusRecords(page, 'spoiler-guard')).toEqual(
        expect.arrayContaining([savingText, savedText])
    );
    expect(
        await captureActorIsolation(page),
        'target Spoiler Guard saves leave actor globals and browser storage unchanged'
    ).toEqual(actorBefore);
    return current;
}

async function findSpoilerOverrideRow(
    host: Locator,
    key: string
): Promise<Locator> {
    const list = host.locator('#spoilerGuardOverrideList');
    const pagerButtons = host.locator('#spoilerGuardOverridePager button');
    const previous = pagerButtons.nth(0);
    const next = pagerButtons.nth(1);

    for (let pageIndex = 0; pageIndex < 100 && !await previous.isDisabled(); pageIndex++) {
        await previous.click();
    }
    for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
        const rows = list.locator('.jc-spoiler-override-row');
        expect(
            await rows.count(),
            `persistent override page ${pageIndex + 1} stays bounded`
        ).toBeLessThanOrEqual(50);
        const match = rows.filter({ hasText: key });
        if (await match.count() === 1) return match;
        if (await next.isDisabled()) break;
        await next.click();
    }
    throw new Error(`Persistent Spoiler Guard row ${key} was not reachable`);
}

async function exerciseSpoilerPersistentOverrides(
    page: Page,
    panel: Locator,
    baseURL: string,
    users: ResolvedUsers,
    layout: Layout,
    loaded: AdminFileEnvelope,
    actorBefore: unknown,
    prefsBefore: JsonRecord,
    traffic: UserFileTraffic[]
): Promise<void> {
    await panel.locator('.tab-button[data-tab="spoiler-guard"]').click();
    const pane = panel.locator('.jc-pane[data-pane="spoiler-guard"]');
    const host = pane.locator('#spoilerGuardTargetOverrides');
    await expect(host).toBeVisible();
    await expect(host).toHaveAttribute('aria-busy', 'false');
    const list = host.locator('#spoilerGuardOverrideList');
    expect(
        await list.locator('.jc-spoiler-override-row').count(),
        'the first persistent-override page is bounded'
    ).toBe(50);
    expect(
        overrideRowCount(loaded.data),
        'the loaded target resource contains more than one override page'
    ).toBeGreaterThanOrEqual(55);
    const initialPager = host.locator('#spoilerGuardOverridePager button');
    await expect(initialPager.nth(0)).toBeDisabled();
    await expect(initialPager.nth(1)).toBeEnabled();
    await initialPager.nth(1).click();
    expect(
        await list.locator('.jc-spoiler-override-row').count(),
        'the second persistent-override page replaces rather than accumulates rows'
    ).toBeGreaterThan(0);
    expect(
        await list.locator('.jc-spoiler-override-row').count(),
        'the second persistent-override page remains bounded'
    ).toBeLessThanOrEqual(50);
    await expect(initialPager.nth(0)).toBeEnabled();
    await initialPager.nth(0).click();
    await expect(list.locator('.jc-spoiler-override-row')).toHaveCount(50);

    const form = host.locator('#spoilerGuardOverrideAddForm');
    const type = host.locator('#spoilerGuardOverrideType');
    const id = host.locator('#spoilerGuardOverrideId');
    const name = host.locator('#spoilerGuardOverrideName');
    const add = host.locator('#spoilerGuardOverrideAdd');
    const status = host.locator('#spoilerGuardOverrideStatus');
    await expect(status).toHaveAttribute('role', 'status');
    await expect(status).toHaveAttribute('aria-live', 'polite');
    await expect(status).toHaveAttribute('aria-atomic', 'true');

    const invalidText = await translatedText(
        page,
        'panel_settings_spoiler_guard_persistent_invalid'
    );
    const overridePostsBeforeInvalid = traffic.filter(request =>
        request.method === 'POST'
        && request.path === adminFilePath(
            users.target.id,
            'spoiler-guard-overrides.json'
        )
    ).length;
    await type.selectOption('series');
    await id.fill('not-a-jellyfin-id');
    await name.fill('Invalid E2E override');
    await add.click();
    await expect(status).toHaveText(invalidText);
    await expect(status).toHaveAttribute('role', 'alert');
    await expect(status).toHaveAttribute('aria-live', 'assertive');
    await expect(id).toBeFocused();
    await expect(host).toHaveAttribute('aria-busy', 'false');
    await page.evaluate(() => Promise.resolve());
    expect(
        traffic.filter(request =>
            request.method === 'POST'
            && request.path === adminFilePath(
                users.target.id,
                'spoiler-guard-overrides.json'
            )
        ),
        'invalid persistent-override input performs no override mutation'
    ).toHaveLength(overridePostsBeforeInvalid);

    const savingText = await translatedStatusText(page, 'panel_admin_target_saving');
    const savedText = await translatedStatusText(page, 'panel_admin_target_saved');
    await beginStatusRecording(page, status, `spoiler-overrides-${layout}`);
    const fixtures = await chooseSpoilerOverrideFixtures(
        baseURL,
        users,
        loaded.data
    );
    const conflictKey = Object.keys(
        overrideSection(loaded.data, 'PendingTmdb')
    ).sort()[0];
    expect(
        conflictKey,
        'the paging fixture supplies a known pending override for the conflict writer'
    ).toBeTruthy();
    const conflictData = clone(loaded.data);
    const conflictEntry = recordOf(
        overrideSection(conflictData, 'PendingTmdb')[conflictKey],
        'conflict writer pending override'
    );
    const originalConflictName = String(
        field(conflictEntry, 'DisplayName', 'displayName') || ''
    );
    const conflictDisplayNameBase =
        `Jellyfin Canopy E2E ${layout} conflict ${loaded.revision}`;
    const conflictDisplayName = conflictDisplayNameBase === originalConflictName
        ? `${conflictDisplayNameBase} updated`
        : conflictDisplayNameBase;
    const conflictNameField = Object.prototype.hasOwnProperty.call(
        conflictEntry,
        'DisplayName'
    )
        ? 'DisplayName'
        : 'displayName';
    conflictEntry[conflictNameField] = conflictDisplayName;
    const conflictSaved = await writeAdminFile(
        baseURL,
        users.adminSession,
        users.target.id,
        loaded,
        conflictData
    );
    expect(
        conflictSaved.revision,
        'the external writer advances the combined override CAS token once'
    ).toBe(loaded.revision + 1);
    const expectConflictWriterState = (
        value: JsonRecord,
        label: string
    ): void => {
        const entry = recordOf(
            overrideSection(value, 'PendingTmdb')[conflictKey],
            `${label} conflict writer pending override`
        );
        expect(
            field(entry, 'DisplayName', 'displayName'),
            `${label} preserves the external writer's known-field change`
        ).toBe(conflictDisplayName);
    };
    expectConflictWriterState(conflictSaved.data, 'external write');
    expect(
        await captureActorIsolation(page),
        'the external target write does not publish target state into actor globals'
    ).toEqual(actorBefore);

    let current = conflictSaved;
    const present: SpoilerOverrideFixture[] = [];
    for (const [index, fixture] of fixtures.entries()) {
        await type.selectOption(fixture.kind);
        await id.fill(fixture.id);
        await name.fill(fixture.displayName);
        const successPromise = page.waitForResponse((response) => {
            if (
                response.status() !== 200
                || !exactAdminResponse(
                    response,
                    users.target.id,
                    'spoiler-guard-overrides.json',
                    'POST'
                )
            ) return false;
            const body = requestBody(response.request());
            return body !== null && fixtureEntry(body, fixture) !== undefined;
        }, { timeout: 45_000 });
        const conflictPromise = index === 0
            ? page.waitForResponse((response) =>
                response.status() === 409
                && exactAdminResponse(
                    response,
                    users.target.id,
                    'spoiler-guard-overrides.json',
                    'POST'
                ),
            { timeout: 45_000 })
            : null;
        await add.click();

        if (conflictPromise) {
            const conflict = await conflictPromise;
            const staleBody = assertStrongMutationRequest(
                conflict.request(),
                'spoiler-guard-overrides.json'
            );
            expect(Number(field(staleBody, 'Revision', 'revision'))).toBe(
                loaded.revision
            );
            const conflictRaw = await conflict.json();
            expect(
                field(recordOf(conflictRaw, 'override conflict'), 'Conflict', 'conflict')
            ).toBe(true);
            const authoritative = parseAdminEnvelope(
                conflictRaw,
                'spoiler-guard-overrides.json',
                users.target.id,
                false
            );
            expectConflictWriterState(
                authoritative.data,
                'authoritative conflict response'
            );
        }

        const success = await successPromise;
        const requestData = assertStrongMutationRequest(
            success.request(),
            'spoiler-guard-overrides.json'
        );
        expect(Number(field(requestData, 'Revision', 'revision'))).toBe(
            current.revision
        );
        const saved = await assertBrowserEnvelope(
            success,
            users.target.id,
            'spoiler-guard-overrides.json'
        );
        expect(saved.revision, `${fixture.kind} add advances one revision`).toBe(
            current.revision + 1
        );
        present.push(fixture);
        expectOverrideDictionaryState(
            saved.data,
            conflictSaved.data,
            fixtures,
            present
        );
        expectConflictWriterState(saved.data, 'safe rebase');
        await expect(status).toHaveText(savedText);
        await expect(status).toHaveAttribute('role', 'status');
        await expect(status).toHaveAttribute('aria-live', 'polite');
        await expect(host).toHaveAttribute('aria-busy', 'false');
        expect(
            await list.locator('.jc-spoiler-override-row').count(),
            'persistent override rendering remains bounded after an add'
        ).toBeLessThanOrEqual(50);
        expect(
            await captureActorIsolation(page),
            `${fixture.kind} target add leaves actor state unchanged`
        ).toEqual(actorBefore);
        current = saved;
    }
    expect(await statusRecords(page, `spoiler-overrides-${layout}`)).toEqual(
        expect.arrayContaining([savingText, savedText])
    );

    const freshTargetAfterAdds = await authenticate(
        baseURL,
        USERS.user.username,
        USERS.user.password
    );
    const persistedAdds = await readSelfFile(
        baseURL,
        freshTargetAfterAdds,
        'spoilerblur.json'
    );
    expectOverrideDictionaryState(
        persistedAdds,
        conflictSaved.data,
        fixtures,
        fixtures
    );
    expectConflictWriterState(persistedAdds, 'fresh target read after adds');
    expect(
        nestedRecord(persistedAdds, 'Prefs', 'prefs'),
        'combined override writes preserve the target preference subsection'
    ).toEqual(prefsBefore);

    for (const fixture of fixtures) {
        const row = await findSpoilerOverrideRow(host, fixture.key);
        const remove = row.locator('button');
        const expectedRemoveLabel = await page.evaluate(
            ({ displayName }) => (window as any).JellyfinCanopy.t(
                'panel_settings_spoiler_guard_persistent_remove_named',
                { name: displayName }
            ),
            { displayName: fixture.displayName }
        );
        expect(expectedRemoveLabel).not.toBe(
            'panel_settings_spoiler_guard_persistent_remove_named'
        );
        await expect(remove).toHaveAttribute('aria-label', expectedRemoveLabel);
        const removePromise = page.waitForResponse((response) => {
            if (
                response.status() !== 200
                || !exactAdminResponse(
                    response,
                    users.target.id,
                    'spoiler-guard-overrides.json',
                    'POST'
                )
            ) return false;
            const body = requestBody(response.request());
            return body !== null && fixtureEntry(body, fixture) === undefined;
        }, { timeout: 45_000 });
        await remove.click();
        const response = await removePromise;
        const body = assertStrongMutationRequest(
            response.request(),
            'spoiler-guard-overrides.json'
        );
        expect(Number(field(body, 'Revision', 'revision'))).toBe(current.revision);
        const saved = await assertBrowserEnvelope(
            response,
            users.target.id,
            'spoiler-guard-overrides.json'
        );
        expect(saved.revision, `${fixture.kind} removal advances one revision`).toBe(
            current.revision + 1
        );
        const fixtureIndex = present.findIndex(candidate => candidate.key === fixture.key);
        expect(fixtureIndex).toBeGreaterThanOrEqual(0);
        present.splice(fixtureIndex, 1);
        expectOverrideDictionaryState(
            saved.data,
            conflictSaved.data,
            fixtures,
            present
        );
        expectConflictWriterState(saved.data, 'removal');
        await expect(status).toHaveText(savedText);
        await expect(host).toHaveAttribute('aria-busy', 'false');
        expect(
            await captureActorIsolation(page),
            `${fixture.kind} target removal leaves actor state unchanged`
        ).toEqual(actorBefore);
        current = saved;
    }

    const persistedRemovals = await readSelfFile(
        baseURL,
        freshTargetAfterAdds,
        'spoilerblur.json'
    );
    expectOverrideDictionaryState(
        persistedRemovals,
        conflictSaved.data,
        fixtures,
        []
    );
    expectConflictWriterState(
        persistedRemovals,
        'fresh target read after removals'
    );
    expect(
        nestedRecord(persistedRemovals, 'Prefs', 'prefs'),
        'removing persistent overrides still preserves target preferences'
    ).toEqual(prefsBefore);
}

async function exerciseHiddenManagement(
    page: Page,
    panel: Locator,
    baseURL: string,
    users: ResolvedUsers,
    fixture: HiddenFixture
): Promise<void> {
    await panel.locator('.tab-button[data-tab="hidden-content"]').click();
    const pane = panel.locator('.jc-pane[data-pane="hidden-content"]');
    const targetRead = page.waitForResponse(response =>
        response.request().method() === 'GET'
        && pathOf(response.url())
            === `/JellyfinCanopy/admin/hidden-content/${users.target.id}`,
    { timeout: 30_000 });
    await pane.locator('#manageHiddenContentBtn').click();
    const targetResponse = await targetRead;
    expect(targetResponse.status(), 'target hidden-item management load').toBe(200);
    const targetPayload = recordOf(
        await targetResponse.json(),
        'target hidden-item management load'
    );
    const loadedTargetState = recordOf(
        field(targetPayload, 'HiddenContent', 'hiddenContent'),
        'target hidden-item management state'
    );
    expect(
        hiddenItemsRevision(
            loadedTargetState,
            'target hidden-item management state'
        )
    ).toBe(fixture.itemsRevision);
    expect(
        targetResponse.headers()['etag'],
        'target hidden-item management load ETag'
    ).toBe(`"${fixture.itemsRevision}"`);
    await closePanelIfPresent(page);

    const container = page.locator('#jc-hidden-content-container');
    await expect(container).toBeVisible({ timeout: 30_000 });
    await expect(container.locator('.jc-hidden-admin-viewing-user')).toContainText(
        users.target.displayName
    );
    await expect(
        container.locator('.jc-hidden-item-unhide'),
        'target management opens read-only'
    ).toHaveCount(0);
    const edit = container.locator('.jc-hidden-admin-edit-toggle');
    await expect(edit).toBeVisible();
    await edit.click();

    const exactCard = container.locator(
        `.jc-hidden-item-card[data-item-id="${fixture.itemId}" i]`
    );
    await expect(exactCard, 'the seeded target item is rendered').toHaveCount(1);
    const unhide = exactCard.locator('.jc-hidden-item-unhide');
    await expect(unhide).toBeVisible();

    // Prove same-key ABA protection, not merely a different-row race. The
    // browser still owns revision R while another admin removes this exact key
    // at R+1 and re-adds it at R+2.
    const externalUnhide = await apiRaw(
        baseURL,
        `/JellyfinCanopy/admin/hidden-content/${users.target.id}/unhide`,
        users.adminSession.token,
        {
            method: 'POST',
            headers: { 'If-Match': `"${fixture.itemsRevision}"` },
            body: JSON.stringify([fixture.itemId]),
        }
    );
    expect(externalUnhide.status, 'concurrent exact-key unhide').toBe(200);
    const externalUnhideAck = recordOf(
        await externalUnhide.json(),
        'concurrent exact-key unhide acknowledgement'
    );
    expect(Number(field(externalUnhideAck, 'Removed', 'removed'))).toBe(1);
    const externallyRemovedRevision = hiddenItemsRevision(
        externalUnhideAck,
        'concurrent exact-key unhide acknowledgement'
    );
    expect(externallyRemovedRevision).toBe(fixture.itemsRevision + 1);
    expect(externalUnhide.headers.get('etag')).toBe(
        `"${externallyRemovedRevision}"`
    );

    const externalHide = await apiRaw(
        baseURL,
        `/JellyfinCanopy/admin/hidden-content/${users.target.id}/hide`,
        users.adminSession.token,
        {
            method: 'POST',
            headers: { 'If-Match': `"${externallyRemovedRevision}"` },
            body: JSON.stringify([fixture.item]),
        }
    );
    expect(externalHide.status, 'concurrent exact-key re-hide').toBe(200);
    const externalHideAck = recordOf(
        await externalHide.json(),
        'concurrent exact-key re-hide acknowledgement'
    );
    expect(Number(field(externalHideAck, 'Added', 'added'))).toBe(1);
    const externallyReaddedRevision = hiddenItemsRevision(
        externalHideAck,
        'concurrent exact-key re-hide acknowledgement'
    );
    expect(externallyReaddedRevision).toBe(fixture.itemsRevision + 2);
    expect(externalHide.headers.get('etag')).toBe(
        `"${externallyReaddedRevision}"`
    );
    // A fresh target authentication earlier in this workflow may retire the
    // token captured by resolveUsers for the same test device. These are
    // administrator-side state proofs, so use the stable elevated session and
    // an explicit target id; the final target-observation block separately
    // authenticates the target again.
    const beforeConflictState = await readSelfFile(
        baseURL,
        users.adminSession,
        'hidden-content.json',
        users.target.id
    );
    expect(
        hiddenItemsRevision(beforeConflictState, 'target before stale unhide')
    ).toBe(externallyReaddedRevision);
    expect(
        hiddenStateContainsItem(beforeConflictState, fixture.itemId),
        'the same key is present again before the stale browser mutation'
    ).toBe(true);

    await unhide.click();
    const confirmation = page.locator('.jc-hide-confirm-overlay');
    await expect(confirmation).toBeVisible();
    const staleUnhideResponse = page.waitForResponse(response =>
        response.request().method() === 'POST'
        && pathOf(response.url())
            === `/JellyfinCanopy/admin/hidden-content/${users.target.id}/unhide`,
    { timeout: 30_000 });
    const conflictRecoveryRead = page.waitForResponse(response =>
        response.request().method() === 'GET'
        && pathOf(response.url())
            === `/JellyfinCanopy/admin/hidden-content/${users.target.id}`,
    { timeout: 30_000 });
    await confirmation.locator('.jc-hide-confirm-hide').click();
    const conflictResponse = await staleUnhideResponse;
    expect(conflictResponse.status(), 'stale exact-key unhide conflicts').toBe(409);
    expect(
        conflictResponse.request().headers()['if-match'],
        'stale exact-key unhide uses the revision loaded by the page'
    ).toBe(`"${fixture.itemsRevision}"`);
    expect(
        conflictResponse.request().postDataJSON(),
        'stale target mutation contains only the selected key'
    ).toEqual([fixture.itemId]);
    expect(conflictResponse.headers()['etag']).toBe(
        `"${externallyReaddedRevision}"`
    );
    const conflict = recordOf(
        await conflictResponse.json(),
        'stale target item conflict'
    );
    expect(field(conflict, 'Success', 'success')).toBe(false);
    expect(field(conflict, 'Conflict', 'conflict')).toBe(true);
    expect(field(conflict, 'Code', 'code')).toBe('hidden_content_items_conflict');
    expect(
        normalizeId(field(conflict, 'TargetUserId', 'targetUserId'))
    ).toBe(users.target.id);
    expect(
        hiddenItemsRevision(conflict, 'stale target item conflict')
    ).toBe(externallyReaddedRevision);
    expect(
        Object.keys(conflict)
            .map(key => key.toLowerCase())
            .filter(key => ['hiddencontent', 'items', 'data'].includes(key)),
        'privacy-minimal conflict omits the target item dictionary'
    ).toEqual([]);

    const recoveryResponse = await conflictRecoveryRead;
    expect(recoveryResponse.status(), 'conflict recovery target GET').toBe(200);
    expect(recoveryResponse.headers()['etag']).toBe(
        `"${externallyReaddedRevision}"`
    );
    const recoveryPayload = recordOf(
        await recoveryResponse.json(),
        'conflict recovery target GET'
    );
    const recoveredState = recordOf(
        field(recoveryPayload, 'HiddenContent', 'hiddenContent'),
        'conflict recovery target state'
    );
    expect(
        hiddenItemsRevision(recoveredState, 'conflict recovery target state')
    ).toBe(externallyReaddedRevision);
    const conflictText = await translatedText(
        page,
        'panel_admin_target_conflict_error'
    );
    const mutationStatus = container.locator('.jc-hidden-admin-mutation-status');
    await expect(mutationStatus, 'stale edit reports localized conflict guidance')
        .toHaveText(conflictText);
    await expect(exactCard, 'stale edit never falsely removes the re-added row')
        .toHaveCount(1);

    const afterConflictState = await readSelfFile(
        baseURL,
        users.adminSession,
        'hidden-content.json',
        users.target.id
    );
    expect(
        hiddenItemsRevision(afterConflictState, 'target after stale unhide'),
        'the rejected stale edit does not advance target state'
    ).toBe(externallyReaddedRevision);
    expect(
        nestedRecord(afterConflictState, 'Items', 'items'),
        'the rejected stale edit leaves the exact target dictionary unchanged'
    ).toEqual(nestedRecord(beforeConflictState, 'Items', 'items'));

    // An explicit user retry now uses the authoritative R+2 snapshot adopted
    // by recovery and is the only mutation allowed to remove the row.
    await unhide.click();
    await expect(confirmation).toBeVisible();
    const retryUnhideResponse = page.waitForResponse(response =>
        response.request().method() === 'POST'
        && pathOf(response.url())
            === `/JellyfinCanopy/admin/hidden-content/${users.target.id}/unhide`,
    { timeout: 30_000 });
    await confirmation.locator('.jc-hide-confirm-hide').click();
    const retryResponse = await retryUnhideResponse;
    expect(retryResponse.status(), 'explicit target item retry succeeds').toBe(200);
    expect(
        retryResponse.request().headers()['if-match'],
        'retry uses the authoritative recovered item-set revision'
    ).toBe(`"${externallyReaddedRevision}"`);
    expect(retryResponse.request().postDataJSON()).toEqual([fixture.itemId]);
    const acknowledgement = recordOf(
        await retryResponse.json(),
        'target item retry acknowledgement'
    );
    expect(field(acknowledgement, 'Success', 'success')).toBe(true);
    expect(Number(field(acknowledgement, 'Removed', 'removed'))).toBe(1);
    const finalRevision = hiddenItemsRevision(
        acknowledgement,
        'target item retry acknowledgement'
    );
    expect(finalRevision).toBe(externallyReaddedRevision + 1);
    expect(retryResponse.headers()['etag']).toBe(`"${finalRevision}"`);
    await expect(exactCard, 'only the explicit retry removes the target row')
        .toHaveCount(0);

    const targetState = await readSelfFile(
        baseURL,
        users.adminSession,
        'hidden-content.json',
        users.target.id
    );
    expect(hiddenItemsRevision(targetState, 'target state after retry'))
        .toBe(finalRevision);
    expect(
        hiddenStateContainsItem(targetState, fixture.itemId),
        'the target no longer sees the item after the explicit retry'
    ).toBe(false);
}

async function closePanelIfPresent(page: Page): Promise<void> {
    const panel = page.locator('#jellyfin-canopy-panel');
    if (await panel.count() > 0 && await panel.isVisible()) {
        await page.keyboard.press('Escape');
        await expect(panel).toBeHidden({ timeout: 10_000 });
    }
}

async function runAdminTargetWorkflow(
    page: Page,
    baseURL: string,
    layout: typeof LAYOUTS[number],
    consoleErrors: Parameters<typeof assertNoRuntimeErrors>[0]
): Promise<void> {
    const users = await resolveUsers(baseURL);
    const originals = await snapshotOriginalFiles(baseURL, users);
    const persistentBefore = await snapshotPersistentStores(baseURL, users);
    const traffic: UserFileTraffic[] = [];
    const responses: UserFileResponse[] = [];
    const onRequest = collectUserFileTraffic(traffic);
    const onResponse = collectUserFileResponses(responses);
    let listening = false;
    let hiddenFixture: HiddenFixture | null = null;
    let seededStores: PersistentStores | null = null;

    try {
        const pagingOverrides = await seedSpoilerOverridePagingFixture(
            baseURL,
            users,
            originals.target.spoilerOverrides
        );
        hiddenFixture = await seedHiddenFixture(
            baseURL,
            users,
            persistentBefore.targetHiddenContent
        );
        seededStores = await snapshotPersistentStores(baseURL, users);
        expect(
            hiddenItemsRevision(
                seededStores.targetHiddenContent,
                'seeded target Hidden Content'
            )
        ).toBe(hiddenFixture.itemsRevision);
        expect(
            Number(field(
                seededStores.targetSpoilerGuard,
                'OverridesRevision',
                'overridesRevision'
            )),
            'the raw target store exposes the seeded combined override revision'
        ).toBe(pagingOverrides.revision);
        expect(
            overrideRowCount(seededStores.targetSpoilerGuard),
            'the raw target store contains a second override page'
        ).toBeGreaterThanOrEqual(55);
        await seedLayout(page, layout.seed);
        await loginAs(page, 'admin', consoleErrors);
        await expectExactLayout(page, layout.layout);
        expect(await browserUserId(page), 'the browser actor is the resolved admin').toBe(
            users.admin.id
        );
        await page.waitForLoadState('networkidle');
        const actorBefore = await captureActorIsolation(page);
        page.on('request', onRequest);
        page.on('response', onResponse);
        listening = true;
        const link = await openTargetPreferencesRoute(
            page,
            layout.route(users.target.id),
            users.target.id
        );
        await page.waitForLoadState('networkidle');
        expect(
            await captureActorIsolation(page),
            'selecting the target route and injecting its link leaves actor state unchanged'
        ).toEqual(actorBefore);
        expect(
            traffic.filter(request =>
                request.path.includes('/JellyfinCanopy/admin/user-settings/')
            ),
            'target files are fetched only after the injected link is clicked'
        ).toEqual([]);
        const [
            settingsGet,
            shortcutsGet,
            hiddenContentGet,
            spoilerGuardGet,
            spoilerOverridesGet,
        ] = await Promise.all([
            page.waitForResponse(
                response => exactAdminResponse(
                    response,
                    users.target.id,
                    'settings.json',
                    'GET'
                ),
                { timeout: 45_000 }
            ),
            page.waitForResponse(
                response => exactAdminResponse(
                    response,
                    users.target.id,
                    'shortcuts.json',
                    'GET'
                ),
                { timeout: 45_000 }
            ),
            page.waitForResponse(
                response => exactAdminResponse(
                    response,
                    users.target.id,
                    'hidden-content-settings.json',
                    'GET'
                ),
                { timeout: 45_000 }
            ),
            page.waitForResponse(
                response => exactAdminResponse(
                    response,
                    users.target.id,
                    'spoiler-guard-prefs.json',
                    'GET'
                ),
                { timeout: 45_000 }
            ),
            page.waitForResponse(
                response => exactAdminResponse(
                    response,
                    users.target.id,
                    'spoiler-guard-overrides.json',
                    'GET'
                ),
                { timeout: 45_000 }
            ),
            link.click(),
        ]);
        const settingsLoaded = await assertBrowserEnvelope(
            settingsGet,
            users.target.id,
            'settings.json'
        );
        const shortcutsLoaded = await assertBrowserEnvelope(
            shortcutsGet,
            users.target.id,
            'shortcuts.json'
        );
        const hiddenContentLoaded = await assertBrowserEnvelope(
            hiddenContentGet,
            users.target.id,
            'hidden-content-settings.json'
        );
        const spoilerGuardLoaded = await assertBrowserEnvelope(
            spoilerGuardGet,
            users.target.id,
            'spoiler-guard-prefs.json'
        );
        const spoilerOverridesLoaded = await assertBrowserEnvelope(
            spoilerOverridesGet,
            users.target.id,
            'spoiler-guard-overrides.json'
        );
        expect(settingsLoaded.targetDisplayName).toBe(users.target.displayName);
        expect(shortcutsLoaded.targetDisplayName).toBe(users.target.displayName);
        expect(hiddenContentLoaded.targetDisplayName).toBe(users.target.displayName);
        expect(spoilerGuardLoaded.targetDisplayName).toBe(users.target.displayName);
        expect(spoilerOverridesLoaded.targetDisplayName).toBe(users.target.displayName);
        for (const section of [
            'Series',
            'Movies',
            'Collections',
            'PendingTmdb',
        ] as const) {
            expect(
                overrideSection(spoilerOverridesLoaded.data, section),
                `the target override read contains its bounded ${section} dictionary`
            ).toEqual(expect.any(Object));
            expect(
                Object.keys(overrideSection(spoilerOverridesLoaded.data, section))
            ).toHaveLength(
                Object.keys(overrideSection(
                    seededStores.targetSpoilerGuard,
                    section
                )).length
            );
        }
        expect(
            spoilerOverridesLoaded.revision,
            'the combined resource exposes the target OverridesRevision'
        ).toBe(Number(field(
            seededStores.targetSpoilerGuard,
            'OverridesRevision',
            'overridesRevision'
        )));
        expect(hiddenContentLoaded.itemCount).toBe(
            Object.keys(nestedRecord(
                seededStores.targetHiddenContent,
                'Items',
                'items'
            )).length
        );

        const panel = page.locator('#jellyfin-canopy-panel');
        await expect(panel).toBeVisible({ timeout: 15_000 });
        const expectedBanner = await page.evaluate(
            name => (window as any).JellyfinCanopy.t(
                'panel_admin_target_banner',
                { name }
            ),
            users.target.displayName
        );
        await expect(panel.locator('.jc-admin-target-banner')).toHaveText(expectedBanner);
        expect(expectedBanner).toContain(users.target.displayName);

        const originalAutoPause = Boolean(
            field(originals.target.settings.data, 'AutoPauseEnabled', 'autoPauseEnabled')
        );
        const originalLastOpenedTab = field(
            originals.target.settings.data,
            'LastOpenedTab',
            'lastOpenedTab'
        );
        const targetAutoPause = !originalAutoPause;
        await panel.locator('.tab-button[data-tab="playback"]').click();
        const playbackPane = panel.locator('.jc-pane[data-pane="playback"]');
        await expect(playbackPane).toBeVisible();
        const autoPause = playbackPane.locator('#autoPauseToggle');
        await expect(autoPause).toBeVisible();
        expect(await autoPause.isChecked()).toBe(originalAutoPause);

        const settingsPostPromise = page.waitForResponse((response) => {
            if (!exactAdminResponse(
                response,
                users.target.id,
                'settings.json',
                'POST'
            )) return false;
            const body = requestBody(response.request());
            return body !== null
                && field(body, 'AutoPauseEnabled', 'autoPauseEnabled') === targetAutoPause;
        }, { timeout: 30_000 });
        await autoPause.setChecked(targetAutoPause);
        const settingsPost = await settingsPostPromise;
        const settingsRequestBody = assertStrongMutationRequest(
            settingsPost.request(),
            'settings.json'
        );
        expect(
            field(settingsRequestBody, 'AutoPauseEnabled', 'autoPauseEnabled')
        ).toBe(targetAutoPause);
        expect(
            field(settingsRequestBody, 'LastOpenedTab', 'lastOpenedTab')
                === originalLastOpenedTab,
            'the real target settings POST does not persist admin pane navigation'
        ).toBe(true);
        const settingsSaved = await assertBrowserEnvelope(
            settingsPost,
            users.target.id,
            'settings.json'
        );
        expect(field(settingsSaved.data, 'AutoPauseEnabled', 'autoPauseEnabled')).toBe(
            targetAutoPause
        );
        expect(
            await captureActorIsolation(page),
            'target setting save leaves actor globals, storage and live shortcut state unchanged'
        ).toEqual(actorBefore);

        let editedShortcut: ShortcutChoice | null = null;
        const shortcutTab = panel.locator('.tab-button[data-tab="shortcuts"]');
        if (await shortcutTab.count() > 0 && await shortcutTab.isVisible()) {
            await shortcutTab.click();
            const shortcutsPane = panel.locator('.jc-pane[data-pane="shortcuts"]');
            await expect(shortcutsPane).toBeVisible();
            const openSearch = shortcutsPane.locator(
                '.shortcut-key[data-action="OpenSearch"]'
            );
            await expect(openSearch).toBeVisible();
            const displayed = await shortcutsPane.locator('.shortcut-key').allTextContents();
            const originalOpenSearch = (await openSearch.textContent() || '').trim();
            editedShortcut = chooseShortcut(displayed.map(value => value.trim()), originalOpenSearch);

            const shortcutPostPromise = page.waitForResponse((response) => {
                if (!exactAdminResponse(
                    response,
                    users.target.id,
                    'shortcuts.json',
                    'POST'
                )) return false;
                const body = requestBody(response.request());
                const entry = body ? findShortcut(body, 'OpenSearch') : undefined;
                return field(entry || {}, 'Key', 'key') === editedShortcut!.stored;
            }, { timeout: 30_000 });
            await openSearch.click();
            await page.keyboard.press(editedShortcut.press);
            const shortcutPost = await shortcutPostPromise;
            const shortcutRequestBody = assertStrongMutationRequest(
                shortcutPost.request(),
                'shortcuts.json'
            );
            expect(
                field(findShortcut(shortcutRequestBody, 'OpenSearch') || {}, 'Key', 'key')
            ).toBe(editedShortcut.stored);
            const shortcutsSaved = await assertBrowserEnvelope(
                shortcutPost,
                users.target.id,
                'shortcuts.json'
            );
            expect(
                field(findShortcut(shortcutsSaved.data, 'OpenSearch') || {}, 'Key', 'key')
            ).toBe(editedShortcut.stored);
            await expect(openSearch).toHaveText(editedShortcut.stored);
            expect(
                await captureActorIsolation(page),
                'target shortcut save leaves the actor active shortcut map unchanged'
            ).toEqual(actorBefore);
        } else {
            expect(
                await page.evaluate(
                    () => (window as any).JellyfinCanopy.pluginConfig.DisableAllShortcuts === true
                ),
                'the shortcut editor is absent only when shortcuts are administratively disabled'
            ).toBe(true);
        }

        const hiddenSaved = await exerciseHiddenPreferences(
            page,
            panel,
            users,
            hiddenContentLoaded,
            actorBefore
        );
        const spoilerSaved = await exerciseSpoilerPreferences(
            page,
            panel,
            users,
            spoilerGuardLoaded,
            actorBefore
        );

        const afterPreferenceStores = await snapshotPersistentStores(baseURL, users);
        expect(
            nestedRecord(afterPreferenceStores.targetHiddenContent, 'Items', 'items'),
            'Hidden Content preference writes preserve every target hidden item'
        ).toEqual(
            nestedRecord(seededStores.targetHiddenContent, 'Items', 'items')
        );
        expect(
            hiddenItemsRevision(
                afterPreferenceStores.targetHiddenContent,
                'target Hidden Content after preference writes'
            ),
            'Hidden Content preference writes preserve the item-set revision'
        ).toBe(hiddenFixture.itemsRevision);
        for (const [pascal, camel] of [
            ['Series', 'series'],
            ['Movies', 'movies'],
            ['Collections', 'collections'],
            ['PendingTmdb', 'pendingTmdb'],
        ] as const) {
            expect(
                nestedRecord(afterPreferenceStores.targetSpoilerGuard, pascal, camel),
                `Spoiler Guard preference writes preserve target ${pascal}`
            ).toEqual(
                nestedRecord(seededStores.targetSpoilerGuard, pascal, camel)
            );
        }
        expect(
            afterPreferenceStores.adminHiddenContent,
            'target Hidden Content changes do not mutate the administrator store'
        ).toEqual(persistentBefore.adminHiddenContent);
        expect(
            afterPreferenceStores.adminSpoilerGuard,
            'target Spoiler Guard changes do not mutate the administrator store'
        ).toEqual(persistentBefore.adminSpoilerGuard);

        await exerciseSpoilerPersistentOverrides(
            page,
            panel,
            baseURL,
            users,
            layout.layout,
            spoilerOverridesLoaded,
            actorBefore,
            nestedRecord(
                afterPreferenceStores.targetSpoilerGuard,
                'Prefs',
                'prefs'
            ),
            traffic
        );

        await exerciseHiddenManagement(
            page,
            panel,
            baseURL,
            users,
            hiddenFixture
        );
        await expect(panel).toBeHidden({ timeout: 10_000 });
        const afterManagementStores = await snapshotPersistentStores(baseURL, users);
        expect(
            nestedRecord(afterManagementStores.targetHiddenContent, 'Items', 'items'),
            'target hide/unhide management restores the exact pre-test item dictionary'
        ).toEqual(
            nestedRecord(persistentBefore.targetHiddenContent, 'Items', 'items')
        );
        expect(
            hiddenItemsRevision(
                afterManagementStores.targetHiddenContent,
                'target Hidden Content after item management'
            ),
            'same-key ABA and the explicit retry advance the item-set revision three times'
        ).toBe(hiddenFixture.itemsRevision + 3);
        expect(
            await browserUserId(page),
            'target management keeps the authenticated administrator as actor'
        ).toBe(users.admin.id);
        expect(
            await captureActorIsolation(page),
            'target item management leaves administrator globals and browser storage unchanged'
        ).toEqual(actorBefore);

        // Authenticate the target again after the writes; do not reuse a
        // browser-cached actor object to prove the target's own endpoint sees it.
        const freshTarget = await authenticate(
            baseURL,
            USERS.user.username,
            USERS.user.password
        );
        expect(normalizeId(freshTarget.userId)).toBe(users.target.id);
        const [
            freshSettings,
            freshShortcuts,
            freshHiddenContent,
            freshSpoilerGuard,
        ] = await Promise.all([
            readSelfFile(baseURL, freshTarget, 'settings.json'),
            readSelfFile(baseURL, freshTarget, 'shortcuts.json'),
            readSelfFile(baseURL, freshTarget, 'hidden-content.json'),
            readSelfFile(baseURL, freshTarget, 'spoilerblur.json'),
        ]);
        expect(field(freshSettings, 'AutoPauseEnabled', 'autoPauseEnabled')).toBe(
            targetAutoPause
        );
        expect(
            field(freshSettings, 'LastOpenedTab', 'lastOpenedTab')
                === field(originals.target.settings.data, 'LastOpenedTab', 'lastOpenedTab'),
            'target section navigation never persists LastOpenedTab'
        ).toBe(true);
        if (editedShortcut) {
            expect(
                field(findShortcut(freshShortcuts, 'OpenSearch') || {}, 'Key', 'key')
            ).toBe(editedShortcut.stored);
        }
        const freshHiddenSettings = nestedRecord(
            freshHiddenContent,
            'Settings',
            'settings'
        );
        for (const control of HIDDEN_CONTROLS) {
            expect(
                ownField(freshHiddenSettings, control.pascal, control.camel),
                `target observes the admin's ${control.pascal} change`
            ).toBe(ownField(hiddenSaved.data, control.pascal, control.camel));
        }
        const freshSpoilerPrefs = nestedRecord(
            freshSpoilerGuard,
            'Prefs',
            'prefs'
        );
        for (const control of SPOILER_CONTROLS) {
            const camel = `${control.field[0].toLowerCase()}${control.field.slice(1)}`;
            expect(
                ownField(freshSpoilerPrefs, control.field, camel),
                `target observes the admin's ${control.field} change`
            ).toBe(ownField(spoilerSaved.data, control.field, camel));
        }

        const currentFiles = await snapshotOriginalFiles(baseURL, users);
        const originalAdminFiles = userFiles(originals.admin);
        const currentAdminFiles = userFiles(currentFiles.admin);
        for (let index = 0; index < originalAdminFiles.length; index++) {
            expect(
                currentAdminFiles[index].contentHash,
                `administrator ${originalAdminFiles[index].file} remains unchanged`
            ).toBe(originalAdminFiles[index].contentHash);
            expect(
                currentAdminFiles[index].revision,
                `administrator ${originalAdminFiles[index].file} revision remains unchanged`
            ).toBe(originalAdminFiles[index].revision);
        }

        const targetSettingsNow = await readAdminFile(
            baseURL,
            users.adminSession,
            users.target.id,
            'settings.json'
        );
        expect(
            field(targetSettingsNow.data, 'LastOpenedTab', 'lastOpenedTab')
                === field(originals.target.settings.data, 'LastOpenedTab', 'lastOpenedTab'),
            'server evidence retains the target LastOpenedTab value'
        ).toBe(true);

        const expectedPrefix =
            `/JellyfinCanopy/admin/user-settings/${users.target.id}/`;
        const allowedTargetPaths = new Set([
            adminFilePath(users.target.id, 'settings.json'),
            adminFilePath(users.target.id, 'shortcuts.json'),
            adminFilePath(users.target.id, 'hidden-content-settings.json'),
            adminFilePath(users.target.id, 'spoiler-guard-prefs.json'),
            adminFilePath(users.target.id, 'spoiler-guard-overrides.json'),
        ]);
        expect(
            traffic.every(request =>
                (request.method === 'GET' || request.method === 'POST')
                && allowedTargetPaths.has(request.path)
            ),
            'every browser user-file request is an exact selected-target admin endpoint'
        ).toBe(true);
        expect(
            responses,
            'every positive-workflow user-file request receives a browser response'
        ).toHaveLength(traffic.length);
        const expectedOverrideConflicts = responses.filter(response =>
            response.status === 409
            && response.method === 'POST'
            && response.path === adminFilePath(
                users.target.id,
                'spoiler-guard-overrides.json'
            )
        );
        expect(
            expectedOverrideConflicts,
            'the induced combined-resource conflict is observed exactly once'
        ).toHaveLength(1);
        expect(
            responses.every(response =>
                (
                    response.status === 200
                    || expectedOverrideConflicts.includes(response)
                )
                && (response.method === 'GET' || response.method === 'POST')
                && allowedTargetPaths.has(response.path)
            ),
            'every workflow response is successful except the one proved CAS conflict'
        ).toBe(true);
        const elevated = traffic.filter(request =>
            request.path.includes('/JellyfinCanopy/admin/user-settings/')
        );
        expect(
            elevated.every(request => request.path.startsWith(expectedPrefix)),
            'every elevated browser request uses the exact selected target id'
        ).toBe(true);
        for (const file of [
            'settings.json',
            'shortcuts.json',
            'hidden-content-settings.json',
            'spoiler-guard-prefs.json',
            'spoiler-guard-overrides.json',
        ] as const) {
            expect(
                elevated.some(request =>
                    request.method === 'GET'
                    && request.path === adminFilePath(users.target.id, file)
                ),
                `browser reads target ${file}`
            ).toBe(true);
        }
        expect(
            elevated.some(request =>
                request.method === 'POST'
                && request.path === adminFilePath(users.target.id, 'settings.json')
            )
        ).toBe(true);
        const allowedMutationPaths = new Set([
            adminFilePath(users.target.id, 'settings.json'),
            adminFilePath(users.target.id, 'hidden-content-settings.json'),
            adminFilePath(users.target.id, 'spoiler-guard-prefs.json'),
            adminFilePath(users.target.id, 'spoiler-guard-overrides.json'),
            ...(editedShortcut
                ? [adminFilePath(users.target.id, 'shortcuts.json')]
                : []),
        ]);
        expect(
            traffic
                .filter(request => request.method === 'POST')
                .every(request => allowedMutationPaths.has(request.path)),
            'every browser mutation uses only an exact elevated selected-target endpoint'
        ).toBe(true);
        if (editedShortcut) {
            expect(
                elevated.some(request =>
                    request.method === 'POST'
                    && request.path === adminFilePath(users.target.id, 'shortcuts.json')
                )
            ).toBe(true);
        }
        for (const file of [
            'hidden-content-settings.json',
            'spoiler-guard-prefs.json',
            'spoiler-guard-overrides.json',
        ] as const) {
            expect(
                elevated.some(request =>
                    request.method === 'POST'
                    && request.path === adminFilePath(users.target.id, file)
                ),
                `browser mutates target ${file}`
            ).toBe(true);
        }
        expect(
            traffic.filter(request => request.method === 'POST').some(
                request => request.path.includes(`/user-settings/${users.admin.id}/`)
            ),
            'target controls never POST an actor-owned endpoint'
        ).toBe(false);

        // The shared runtime sink intentionally allowlists /JellyfinCanopy/admin/
        // 4xx responses so non-admin degradation tests can probe elevated
        // routes. The two expected 409s above are therefore proved from their
        // exact response objects at the call sites, not from unexpected4xx().
        // Chromium also emits one URL-less console line for each 409. Prove the
        // count before locally filtering only that exact generic text; every
        // structured response and every unrelated console/network error still
        // reaches the shared gate.
        const expectedConflictConsole =
            /^Failed to load resource: the server responded with a status of 409 \(Conflict\)$/i;
        expect(
            consoleErrors.realDetails().filter(
                detail => detail.source === 'console'
                    && expectedConflictConsole.test(detail.text)
            ),
            'Chromium reports exactly the two proved admin conflicts'
        ).toHaveLength(2);
        assertNoRuntimeErrors({
            ...consoleErrors,
            real: () => consoleErrors.real().filter(
                text => !expectedConflictConsole.test(text)
            ),
            realDetails: () => consoleErrors.realDetails().filter(
                detail => !(
                    detail.source === 'console'
                    && expectedConflictConsole.test(detail.text)
                )
            ),
        });
    } finally {
        if (listening) {
            page.off('request', onRequest);
            page.off('response', onResponse);
        }
        try {
            await closePanelIfPresent(page);
        } finally {
            try {
                if (hiddenFixture) {
                    await removeHiddenFixture(baseURL, users, hiddenFixture);
                }
            } finally {
                await restoreAllFiles(baseURL, users, originals);
            }
        }
    }
}

test.describe('admin target user settings', () => {
    for (const layout of LAYOUTS) {
        test(`${layout.layout}: admin edits target settings, Hidden Content, Spoiler Guard preferences, and persistent overrides without mutating actor state`, async ({
            page,
            baseURL,
            consoleErrors,
        }) => {
            await runAdminTargetWorkflow(page, baseURL!, layout, consoleErrors);
        });
    }

    test('rapid target switch discards a held persistent-override response without publishing target state', async ({
        page,
        baseURL,
        consoleErrors,
    }) => {
        const users = await resolveUsers(baseURL!);
        await seedLayout(page, 'modern');
        await loginAs(page, 'admin', consoleErrors);
        await expectExactLayout(page, 'modern');
        await page.waitForLoadState('networkidle');
        const actorBefore = await captureActorIsolation(page);
        const traffic: UserFileTraffic[] = [];
        const onRequest = collectUserFileTraffic(traffic);
        page.on('request', onRequest);

        const overrideRoute = /\/JellyfinCanopy\/admin\/user-settings\/[0-9a-f]{32}\/spoiler-guard-overrides\.json(?:\?|$)/;
        let heldRoute: Route | null = null;
        let signalHeld!: () => void;
        const held = new Promise<void>(resolve => {
            signalHeld = resolve;
        });
        const holdOverride = async (route: Route): Promise<void> => {
            if (
                route.request().method() === 'GET'
                && pathOf(route.request().url()) === adminFilePath(
                    users.target.id,
                    'spoiler-guard-overrides.json'
                )
                && !heldRoute
            ) {
                heldRoute = route;
                signalHeld();
                return;
            }
            await route.continue();
        };
        await page.route(overrideRoute, holdOverride);

        try {
            const targetLink = await openTargetPreferencesRoute(
                page,
                LAYOUTS[0].route(users.target.id),
                users.target.id
            );
            await targetLink.click();
            await held;
            await openTargetPreferencesRoute(
                page,
                LAYOUTS[0].route(users.admin.id),
                users.admin.id
            );
            const delayed = heldRoute;
            expect(delayed, 'the exact target override GET was held').toBeTruthy();
            if (delayed) {
                await delayed.continue().catch(() => {
                    // Navigating away is allowed to abort the obsolete fetch.
                });
            }
            await page.waitForLoadState('networkidle');
            await expect(page.locator('#jellyfin-canopy-panel')).toHaveCount(0);
            await expect(page.locator('.jc-admin-target-banner')).toHaveCount(0);
            expect(
                traffic.some(request =>
                    request.method === 'GET'
                    && request.path === adminFilePath(
                        users.target.id,
                        'spoiler-guard-overrides.json'
                    )
                ),
                'the delayed request belongs to the first selected target'
            ).toBe(true);
            expect(
                traffic.some(request => request.method === 'POST'),
                'rapid navigation performs no target mutation'
            ).toBe(false);
            expect(
                await captureActorIsolation(page),
                'a late or aborted target response cannot publish into actor state'
            ).toEqual(actorBefore);
            assertNoRuntimeErrors(consoleErrors);
        } finally {
            page.off('request', onRequest);
            if (heldRoute) {
                await heldRoute.continue().catch(() => {});
            }
            await page.unroute(overrideRoute, holdOverride);
        }
    });

    test('mismatched target identity metadata fails closed before the target editor is exposed', async ({
        page,
        baseURL,
        consoleErrors,
    }) => {
        const users = await resolveUsers(baseURL!);
        await seedLayout(page, 'modern');
        await loginAs(page, 'admin', consoleErrors);
        await expectExactLayout(page, 'modern');
        await page.waitForLoadState('networkidle');
        const actorBefore = await captureActorIsolation(page);
        const traffic: UserFileTraffic[] = [];
        const onRequest = collectUserFileTraffic(traffic);
        page.on('request', onRequest);
        const overrideRoute = /\/JellyfinCanopy\/admin\/user-settings\/[0-9a-f]{32}\/spoiler-guard-overrides\.json(?:\?|$)/;
        const mismatchIdentity = async (route: Route): Promise<void> => {
            expect(route.request().method()).toBe('GET');
            expect(pathOf(route.request().url())).toBe(adminFilePath(
                users.target.id,
                'spoiler-guard-overrides.json'
            ));
            const upstream = await route.fetch();
            const raw = recordOf(
                await upstream.json(),
                'real target override response'
            );
            raw.TargetUserId = users.admin.id;
            raw.targetUserId = users.admin.id;
            const headers = {
                ...upstream.headers(),
                'content-type': 'application/json',
            };
            delete headers['content-length'];
            await route.fulfill({
                response: upstream,
                body: JSON.stringify(raw),
                headers,
            });
        };
        await page.route(overrideRoute, mismatchIdentity);

        try {
            const loadError = await translatedText(
                page,
                'panel_admin_target_load_error'
            );
            await page.evaluate((expectedText) => {
                const scope = window as any;
                scope.__jcAdminTargetIdentityFailureSeen = false;
                scope.__jcAdminTargetIdentityFailureObserver?.disconnect?.();
                const observer = new MutationObserver(mutations => {
                    for (const mutation of mutations) {
                        for (const node of Array.from(mutation.addedNodes)) {
                            if (
                                node instanceof HTMLElement
                                && node.classList.contains('jellyfin-canopy-toast')
                                && node.textContent?.trim() === expectedText
                            ) {
                                scope.__jcAdminTargetIdentityFailureSeen = true;
                            }
                        }
                    }
                });
                observer.observe(document.body, { childList: true, subtree: true });
                scope.__jcAdminTargetIdentityFailureObserver = observer;
            }, loadError);

            const link = await openTargetPreferencesRoute(
                page,
                LAYOUTS[0].route(users.target.id),
                users.target.id
            );
            await link.click();
            await page.waitForFunction(
                () => (window as any).__jcAdminTargetIdentityFailureSeen === true,
                undefined,
                { timeout: 45_000 }
            );
            await expect(page.locator('#jellyfin-canopy-panel')).toHaveCount(0);
            await expect(page.locator('.jc-admin-target-banner')).toHaveCount(0);
            expect(
                traffic.some(request => request.method === 'POST'),
                'mismatched identity metadata cannot reach a mutation'
            ).toBe(false);
            expect(
                await captureActorIsolation(page),
                'mismatched target identity cannot publish target state'
            ).toEqual(actorBefore);
            assertNoRuntimeErrors(consoleErrors);
        } finally {
            page.off('request', onRequest);
            await page.unroute(overrideRoute, mismatchIdentity);
        }
    });

    test('Hidden Content admin inventory reaches page-two users and replaces the bounded page', async ({
        page,
        baseURL,
        consoleErrors,
    }) => {
        const admin = await authenticate(
            baseURL!,
            USERS.admin.username,
            USERS.admin.password
        );
        const serverResponse = await apiRaw(
            baseURL!,
            '/JellyfinCanopy/admin/hidden-content-users?limit=100',
            admin.token
        );
        expect(serverResponse.status, 'real bounded user-inventory endpoint').toBe(200);
        const serverPage = recordOf(
            await serverResponse.json(),
            'real bounded user-inventory page'
        );
        const serverUsers = field<unknown[]>(serverPage, 'Users', 'users');
        const serverLimit = Number(field(serverPage, 'Limit', 'limit'));
        const serverScanned = Number(field(serverPage, 'Scanned', 'scanned'));
        const serverTruncated = field(serverPage, 'Truncated', 'truncated');
        const serverNext = field(serverPage, 'NextCursor', 'nextCursor');
        expect(Array.isArray(serverUsers)).toBe(true);
        expect(Number.isSafeInteger(serverLimit) && serverLimit === 100).toBe(true);
        expect(
            Number.isSafeInteger(serverScanned)
            && serverScanned >= 0
            && serverScanned <= serverLimit
        ).toBe(true);
        expect(serverUsers!.length).toBeLessThanOrEqual(serverScanned);
        for (const rawUser of serverUsers!) {
            const user = recordOf(rawUser, 'real bounded user-inventory entry');
            expect(normalizeId(field(user, 'UserId', 'userId')))
                .toMatch(/^[0-9a-f]{32}$/);
            expect(String(field(user, 'UserName', 'userName') || '').trim())
                .not.toBe('');
            const count = Number(field(user, 'Count', 'count'));
            expect(Number.isSafeInteger(count) && count > 0).toBe(true);
        }
        expect(typeof serverTruncated).toBe('boolean');
        if (serverTruncated) {
            expect(normalizeId(serverNext)).toMatch(/^[0-9a-f]{32}$/);
        } else {
            expect(serverNext ?? null).toBeNull();
        }

        await seedLayout(page, 'modern');
        await loginAs(page, 'admin', consoleErrors);
        await expectExactLayout(page, 'modern');
        const firstPageUsers = Array.from({ length: 100 }, (_, index) => {
            const userId = (index + 1).toString(16).padStart(32, '0');
            return {
                userId,
                userName: `First-page user ${String(index + 1).padStart(3, '0')}`,
                count: 1,
            };
        });
        const cursor = firstPageUsers[firstPageUsers.length - 1].userId;
        const pageTwoUser = {
            userId: 'b'.repeat(32),
            userName: 'Page-two hidden-content user',
            count: 7,
        };
        const inventoryRequests: Array<string | null> = [];
        const usersRoute = /\/JellyfinCanopy\/admin\/hidden-content-users(?:\?|$)/;
        const targetRoute = new RegExp(
            `/JellyfinCanopy/admin/hidden-content/${pageTwoUser.userId}(?:\\?|$)`
        );
        const serveUsers = async (route: Route): Promise<void> => {
            expect(route.request().method()).toBe('GET');
            const requestUrl = new URL(route.request().url());
            expect(requestUrl.searchParams.get('limit')).toBe('100');
            expect(
                [...requestUrl.searchParams.keys()].every(
                    key => key === 'limit' || key === 'cursor'
                ),
                'the inventory request uses only the bounded paging contract'
            ).toBe(true);
            const requestedCursor = requestUrl.searchParams.get('cursor');
            inventoryRequests.push(requestedCursor);
            if (requestedCursor === null) {
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({
                        users: firstPageUsers,
                        limit: 100,
                        scanned: 100,
                        truncated: true,
                        nextCursor: cursor,
                    }),
                });
                return;
            }
            expect(requestedCursor).toBe(cursor);
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    users: [pageTwoUser],
                    limit: 100,
                    scanned: 1,
                    truncated: false,
                    nextCursor: null,
                }),
            });
        };
        const serveTarget = async (route: Route): Promise<void> => {
            expect(route.request().method()).toBe('GET');
            expect(pathOf(route.request().url())).toBe(
                `/JellyfinCanopy/admin/hidden-content/${pageTwoUser.userId}`
            );
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    userId: pageTwoUser.userId,
                    userName: pageTwoUser.userName,
                    hiddenContent: {
                        ItemsRevision: 0,
                        Items: {},
                        Settings: {},
                    },
                }),
            });
        };
        await page.route(usersRoute, serveUsers);
        await page.route(targetRoute, serveTarget);

        try {
            await page.evaluate(() => {
                const canopy = (window as any).JellyfinCanopy;
                canopy.pluginConfig.HiddenContentEnabled = true;
                canopy.pluginConfig.HiddenContentAdmin = true;
                void canopy.hiddenContentPage.showPage();
            });
            const container = page.locator('#jc-hidden-content-container');
            await expect(container).toBeVisible({ timeout: 30_000 });
            const filter = container.locator('.jc-hidden-admin-user-filter');
            await expect(filter).toBeVisible({ timeout: 30_000 });
            await expect(filter.locator('option')).toHaveCount(101);
            await expect(
                filter.locator('option[value^="__jc_hidden_users_"]')
            ).toHaveCount(0);
            await expect(
                filter.locator(`option[value="${firstPageUsers[0].userId}"]`)
            ).toHaveCount(1);
            await expect(
                filter.locator(`option[value="${pageTwoUser.userId}"]`)
            ).toHaveCount(0);

            await container.getByRole('button', {
                name: 'Next page',
                exact: true,
            }).click();
            await expect(filter.locator('option')).toHaveCount(2);
            await expect(filter).toBeFocused();
            await expect(
                filter.locator(`option[value="${firstPageUsers[0].userId}"]`)
            ).toHaveCount(0);
            await expect(
                filter.locator(`option[value="${pageTwoUser.userId}"]`)
            ).toHaveText(`${pageTwoUser.userName} (${pageTwoUser.count})`);
            await expect(
                filter.locator('option[value^="__jc_hidden_users_"]')
            ).toHaveCount(0);
            await container.getByRole('button', {
                name: 'First page',
                exact: true,
            }).click();
            await expect(filter.locator('option')).toHaveCount(101);
            await expect(filter).toBeFocused();
            await expect(
                filter.locator(`option[value="${firstPageUsers[0].userId}"]`)
            ).toHaveCount(1);
            await container.getByRole('button', {
                name: 'Next page',
                exact: true,
            }).click();
            await expect(filter.locator('option')).toHaveCount(2);
            await expect(filter).toBeFocused();
            expect(
                inventoryRequests,
                'the browser requests one strict page at a time'
            ).toEqual([null, cursor, null, cursor]);

            await filter.selectOption(pageTwoUser.userId);
            await expect(
                container.locator('.jc-hidden-admin-viewing-user')
            ).toContainText(pageTwoUser.userName);
            assertNoRuntimeErrors(consoleErrors);
        } finally {
            await page.unroute(usersRoute, serveUsers);
            await page.unroute(targetRoute, serveTarget);
        }
    });

    test('non-admin foreign target route and all elevated resources fail closed', async ({
        page,
        baseURL,
        consoleErrors,
    }) => {
        const users = await resolveUsers(baseURL!);
        const originals = await snapshotOriginalFiles(baseURL!, users);
        const traffic: UserFileTraffic[] = [];
        const onRequest = collectUserFileTraffic(traffic);
        let listening = false;

        try {
            await seedLayout(page, 'modern');
            await loginAs(page, 'user', consoleErrors);
            await expectExactLayout(page, 'modern');
            expect(await browserUserId(page), 'the browser actor is the resolved non-admin').toBe(
                users.target.id
            );
            await page.waitForLoadState('networkidle');
            const actorBefore = await captureActorIsolation(page);
            page.on('request', onRequest);
            listening = true;
            const link = await openTargetPreferencesRoute(
                page,
                `/mypreferencesmenu?userId=${users.admin.id}`,
                users.admin.id
            );
            await page.waitForLoadState('networkidle');
            const unauthorizedText = await page.evaluate(
                () => (window as any).JellyfinCanopy.t('panel_admin_target_unauthorized')
            );
            expect(
                unauthorizedText,
                'the localized authorization denial is available'
            ).not.toBe('panel_admin_target_unauthorized');
            expect(typeof unauthorizedText, 'localized authorization denial type').toBe('string');
            expect(unauthorizedText, 'localized authorization denial is non-empty').not.toBe('');
            await page.evaluate((expectedText) => {
                const scope = window as any;
                scope.__jcAdminTargetUnauthorizedSeen = false;
                scope.__jcAdminTargetUnauthorizedObserver?.disconnect?.();
                const observe = (node: Node) => {
                    if (
                        node instanceof HTMLElement
                        && node.classList.contains('jellyfin-canopy-toast')
                        && node.textContent?.trim() === expectedText
                    ) {
                        scope.__jcAdminTargetUnauthorizedSeen = true;
                    }
                };
                const observer = new MutationObserver(mutations => {
                    for (const mutation of mutations) {
                        for (const node of Array.from(mutation.addedNodes)) observe(node);
                    }
                });
                observer.observe(document.body, { childList: true, subtree: true });
                scope.__jcAdminTargetUnauthorizedObserver = observer;
            }, unauthorizedText);

            await link.click();
            await page.waitForFunction(
                () => (window as any).__jcAdminTargetUnauthorizedSeen === true,
                undefined,
                { timeout: 30_000 }
            );
            await expect(page.locator('#jellyfin-canopy-panel')).toHaveCount(0);
            await expect(page.locator('.jc-admin-target-banner')).toHaveCount(0);
            expect(
                traffic.filter(request =>
                    request.path.includes('/JellyfinCanopy/admin/user-settings/')
                ),
                'non-admin client authorization fails before any cross-user fetch'
            ).toEqual([]);
            expect(
                await captureActorIsolation(page),
                'the handcrafted foreign route cannot alter non-admin actor state'
            ).toEqual(actorBefore);

            // These are Node-side calls, outside the browser response collector,
            // so the exact expected 403 and empty body are evidenced here.
            for (const original of userFiles(originals.admin)) {
                const deniedGet = await apiRaw(
                    baseURL!,
                    adminFilePath(users.admin.id, original.file),
                    users.targetSession.token
                );
                expect(
                    deniedGet.status,
                    `non-admin direct elevated GET ${original.file}`
                ).toBe(403);
                expect(
                    await deniedGet.text(),
                    `403 GET ${original.file} discloses no response body`
                ).toBe('');

                const current = await readAdminFile(
                    baseURL!,
                    users.adminSession,
                    users.admin.id,
                    original.file
                );
                const deniedPost = await apiRaw(
                    baseURL!,
                    adminFilePath(users.admin.id, original.file),
                    users.targetSession.token,
                    {
                        method: 'POST',
                        headers: { 'If-Match': `"${current.revision}"` },
                        body: JSON.stringify(
                            withRevision(current.data, current.revision)
                        ),
                    }
                );
                expect(
                    deniedPost.status,
                    `non-admin direct elevated POST ${original.file}`
                ).toBe(403);
                expect(
                    await deniedPost.text(),
                    `403 POST ${original.file} discloses no response body`
                ).toBe('');
            }

            const deniedItems = await apiRaw(
                baseURL!,
                `/JellyfinCanopy/admin/hidden-content/${users.admin.id}`,
                users.targetSession.token
            );
            expect(deniedItems.status, 'non-admin target hidden-item GET').toBe(403);
            expect(await deniedItems.text(), 'hidden-item 403 body is empty').toBe('');
            const deniedUnhide = await apiRaw(
                baseURL!,
                `/JellyfinCanopy/admin/hidden-content/${users.admin.id}/unhide`,
                users.targetSession.token,
                {
                    method: 'POST',
                    body: JSON.stringify([]),
                }
            );
            expect(deniedUnhide.status, 'non-admin target hidden-item mutation').toBe(403);
            expect(await deniedUnhide.text(), 'hidden-item mutation 403 body is empty').toBe('');

            await expectFilesUnchanged(baseURL!, users, originals);
            expect(
                await captureActorIsolation(page),
                'denied direct requests cannot alter browser actor state'
            ).toEqual(actorBefore);
            assertNoRuntimeErrors(consoleErrors);
        } finally {
            if (listening) page.off('request', onRequest);
            await page.evaluate(() => {
                (window as any).__jcAdminTargetUnauthorizedObserver?.disconnect?.();
                delete (window as any).__jcAdminTargetUnauthorizedObserver;
                delete (window as any).__jcAdminTargetUnauthorizedSeen;
            }).catch(() => undefined);
            try {
                await closePanelIfPresent(page);
            } finally {
                await restoreAllFiles(baseURL!, users, originals);
            }
        }
    });
});
