// Real-browser acceptance for editing another user's Canopy files from the
// selected-user preferences route. Every touched settings/shortcuts file is
// restored from a fresh revision in finally so the shared E2E users remain
// reusable even when an assertion fails halfway through the workflow.
import type {
    Locator,
    Page,
    Request,
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

type UserFile = 'settings.json' | 'shortcuts.json';
type Layout = 'modern' | 'legacy';
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
}

interface UserFiles {
    settings: AdminFileEnvelope;
    shortcuts: AdminFileEnvelope;
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

const LAYOUTS: ReadonlyArray<{
    layout: Layout;
    seed: 'modern' | 'mobile-legacy';
    route(targetUserId: string): string;
}> = [
    {
        layout: 'modern',
        seed: 'modern',
        route: targetUserId => `/mypreferencesmenu?userId=${targetUserId}`,
    },
    {
        layout: 'legacy',
        seed: 'mobile-legacy',
        route: targetUserId => `/mypreferencesmenu.html?userId=${targetUserId}`,
    },
];

const LAYOUT_STAMP: Record<Layout, string> = {
    modern: 'jc-modern-layout',
    legacy: 'jc-legacy-layout',
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

function selfFilePath(userId: string, file: UserFile): string {
    return `/JellyfinCanopy/user-settings/${normalizeId(userId)}/${file}`;
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
    expectedTargetUserId: string
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

    expect(field(response, 'Success', 'success'), `${expectedFile} success`).toBe(true);
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

    return {
        file: expectedFile,
        revision,
        contentHash,
        data: clone(data),
        targetUserId,
        targetDisplayName,
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

async function readSelfFile(
    baseURL: string,
    session: Session,
    file: UserFile
): Promise<JsonRecord> {
    const response = await apiRaw(
        baseURL,
        selfFilePath(session.userId, file),
        session.token
    );
    expect(response.status, `fresh target GET ${file}`).toBe(200);
    return recordOf(await response.json(), `fresh target ${file}`);
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
    const [adminSettings, adminShortcuts, targetSettings, targetShortcuts] =
        await Promise.all([
            readAdminFile(baseURL, users.adminSession, users.admin.id, 'settings.json'),
            readAdminFile(baseURL, users.adminSession, users.admin.id, 'shortcuts.json'),
            readAdminFile(baseURL, users.adminSession, users.target.id, 'settings.json'),
            readAdminFile(baseURL, users.adminSession, users.target.id, 'shortcuts.json'),
        ]);
    expect(adminSettings.targetDisplayName).toBe(users.admin.displayName);
    expect(adminShortcuts.targetDisplayName).toBe(users.admin.displayName);
    expect(targetSettings.targetDisplayName).toBe(users.target.displayName);
    expect(targetShortcuts.targetDisplayName).toBe(users.target.displayName);
    return {
        admin: { settings: adminSettings, shortcuts: adminShortcuts },
        target: { settings: targetSettings, shortcuts: targetShortcuts },
    };
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
    const restorations = await Promise.allSettled([
        restoreFile(baseURL, users.adminSession, users.admin.id, originals.admin.settings),
        restoreFile(baseURL, users.adminSession, users.admin.id, originals.admin.shortcuts),
        restoreFile(baseURL, users.adminSession, users.target.id, originals.target.settings),
        restoreFile(baseURL, users.adminSession, users.target.id, originals.target.shortcuts),
    ]);
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
    expect(current.admin.settings.contentHash, 'admin settings remain exact').toBe(
        originals.admin.settings.contentHash
    );
    expect(current.admin.settings.revision, 'admin settings revision remains exact').toBe(
        originals.admin.settings.revision
    );
    expect(current.admin.shortcuts.contentHash, 'admin shortcuts remain exact').toBe(
        originals.admin.shortcuts.contentHash
    );
    expect(current.admin.shortcuts.revision, 'admin shortcuts revision remains exact').toBe(
        originals.admin.shortcuts.revision
    );
    expect(current.target.settings.contentHash, 'target settings remain exact').toBe(
        originals.target.settings.contentHash
    );
    expect(current.target.settings.revision, 'target settings revision remains exact').toBe(
        originals.target.settings.revision
    );
    expect(current.target.shortcuts.contentHash, 'target shortcuts remain exact').toBe(
        originals.target.shortcuts.contentHash
    );
    expect(current.target.shortcuts.revision, 'target shortcuts revision remains exact').toBe(
        originals.target.shortcuts.revision
    );
}

async function seedLayout(page: Page, seed: string): Promise<void> {
    await page.addInitScript((value) => localStorage.setItem('layout', value), seed);
}

async function expectExactLayout(page: Page, layout: Layout): Promise<void> {
    const wanted = LAYOUT_STAMP[layout];
    const other = LAYOUT_STAMP[layout === 'modern' ? 'legacy' : 'modern'];
    await page.waitForFunction(
        stamp => document.documentElement.classList.contains(stamp),
        wanted,
        { timeout: 20_000 }
    );
    expect(await page.locator('html').evaluate(
        (root, stamps) => ({
            wanted: root.classList.contains(stamps.wanted),
            other: root.classList.contains(stamps.other),
        }),
        { wanted, other }
    )).toEqual({ wanted: true, other: false });
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
            localStorageHashes,
            sessionStorageHashes,
        ] = await Promise.all([
            digest(stringify(JC.currentSettings)),
            digest(stringify(JC.userConfig?.settings)),
            digest(stringify(JC.userConfig?.shortcuts)),
            digest(stringify(JC.state?.activeShortcuts)),
            digest(stringify(JC.state?.activeShortcuts?.OpenSearch)),
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
    const traffic: UserFileTraffic[] = [];
    const responses: UserFileResponse[] = [];
    const onRequest = collectUserFileTraffic(traffic);
    const onResponse = collectUserFileResponses(responses);
    let listening = false;

    try {
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
        const [settingsGet, shortcutsGet] = await Promise.all([
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
        expect(settingsLoaded.targetDisplayName).toBe(users.target.displayName);
        expect(shortcutsLoaded.targetDisplayName).toBe(users.target.displayName);

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

        await page.keyboard.press('Escape');
        await expect(panel).toBeHidden({ timeout: 10_000 });
        expect(
            await captureActorIsolation(page),
            'closing target mode leaves actor globals, storage and live state unchanged'
        ).toEqual(actorBefore);

        // Authenticate the target again after the writes; do not reuse a
        // browser-cached actor object to prove the target's own endpoint sees it.
        const freshTarget = await authenticate(
            baseURL,
            USERS.user.username,
            USERS.user.password
        );
        expect(normalizeId(freshTarget.userId)).toBe(users.target.id);
        const [freshSettings, freshShortcuts] = await Promise.all([
            readSelfFile(baseURL, freshTarget, 'settings.json'),
            readSelfFile(baseURL, freshTarget, 'shortcuts.json'),
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

        const [adminSettingsNow, adminShortcutsNow] = await Promise.all([
            readAdminFile(baseURL, users.adminSession, users.admin.id, 'settings.json'),
            readAdminFile(baseURL, users.adminSession, users.admin.id, 'shortcuts.json'),
        ]);
        expect(
            adminSettingsNow.contentHash,
            'admin persisted settings content is unchanged'
        ).toBe(
            originals.admin.settings.contentHash
        );
        expect(
            adminSettingsNow.revision,
            'admin persisted settings revision is unchanged'
        ).toBe(originals.admin.settings.revision);
        expect(
            adminShortcutsNow.contentHash,
            'admin persisted shortcuts content is unchanged'
        ).toBe(
            originals.admin.shortcuts.contentHash
        );
        expect(
            adminShortcutsNow.revision,
            'admin persisted shortcuts revision is unchanged'
        ).toBe(originals.admin.shortcuts.revision);

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
        expect(
            responses.every(response =>
                response.status === 200
                && (response.method === 'GET' || response.method === 'POST')
                && allowedTargetPaths.has(response.path)
            ),
            'every positive-workflow user-file response is 200 from an exact target endpoint'
        ).toBe(true);
        const elevated = traffic.filter(request =>
            request.path.includes('/JellyfinCanopy/admin/user-settings/')
        );
        expect(
            elevated.every(request => request.path.startsWith(expectedPrefix)),
            'every elevated browser request uses the exact selected target id'
        ).toBe(true);
        expect(
            elevated.some(request =>
                request.method === 'GET'
                && request.path === adminFilePath(users.target.id, 'settings.json')
            )
        ).toBe(true);
        expect(
            elevated.some(request =>
                request.method === 'GET'
                && request.path === adminFilePath(users.target.id, 'shortcuts.json')
            )
        ).toBe(true);
        expect(
            elevated.some(request =>
                request.method === 'POST'
                && request.path === adminFilePath(users.target.id, 'settings.json')
            )
        ).toBe(true);
        const allowedMutationPaths = new Set([
            adminFilePath(users.target.id, 'settings.json'),
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
        expect(
            traffic.filter(request => request.method === 'POST').some(
                request => request.path.includes(`/user-settings/${users.admin.id}/`)
            ),
            'target controls never POST an actor-owned endpoint'
        ).toBe(false);

        assertNoRuntimeErrors(consoleErrors);
    } finally {
        if (listening) {
            page.off('request', onRequest);
            page.off('response', onResponse);
        }
        try {
            await closePanelIfPresent(page);
        } finally {
            await restoreAllFiles(baseURL, users, originals);
        }
    }
}

test.describe('admin target user settings', () => {
    for (const layout of LAYOUTS) {
        test(`${layout.layout}: admin edits the target without mutating actor state`, async ({
            page,
            baseURL,
            consoleErrors,
        }) => {
            await runAdminTargetWorkflow(page, baseURL!, layout, consoleErrors);
        });
    }

    test('non-admin foreign target route and elevated endpoints fail closed', async ({
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
                observer.observe(document.body, { childList: true });
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
            const deniedGet = await apiRaw(
                baseURL!,
                adminFilePath(users.admin.id, 'settings.json'),
                users.targetSession.token
            );
            expect(deniedGet.status, 'non-admin direct elevated GET').toBe(403);
            expect(await deniedGet.text(), '403 GET discloses no response body').toBe('');

            const currentAdminSettings = await readAdminFile(
                baseURL!,
                users.adminSession,
                users.admin.id,
                'settings.json'
            );
            const deniedCandidate = withRevision(
                currentAdminSettings.data,
                currentAdminSettings.revision
            );
            const currentAutoPause = Boolean(
                field(deniedCandidate, 'AutoPauseEnabled', 'autoPauseEnabled')
            );
            delete deniedCandidate.AutoPauseEnabled;
            delete deniedCandidate.autoPauseEnabled;
            deniedCandidate.AutoPauseEnabled = !currentAutoPause;
            const deniedPost = await apiRaw(
                baseURL!,
                adminFilePath(users.admin.id, 'settings.json'),
                users.targetSession.token,
                {
                    method: 'POST',
                    headers: { 'If-Match': `"${currentAdminSettings.revision}"` },
                    body: JSON.stringify(deniedCandidate),
                }
            );
            expect(deniedPost.status, 'non-admin direct elevated POST').toBe(403);
            expect(await deniedPost.text(), '403 POST discloses no response body').toBe('');

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
