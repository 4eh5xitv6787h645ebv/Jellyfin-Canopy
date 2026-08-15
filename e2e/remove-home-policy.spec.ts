import type { Page } from 'playwright/test';
import {
    test,
    expect,
    loginAs,
    showRoute,
    waitForHash,
    assertNoRuntimeErrors,
} from './fixtures/auth';
import { api, apiRaw, authenticate, PLUGIN_ID } from './fixtures/api';
import {
    completeAcknowledgedMutation,
    runIndependentRestorations,
    throwAfterRestoration,
} from '../scripts/e2e/remove-home-policy-cleanup';

/* eslint-disable @typescript-eslint/no-explicit-any */

const CONFIG_PATH = `/Plugins/${PLUGIN_ID}/Configuration`;

function field<T>(value: Record<string, any>, pascal: string, camel: string): T {
    return (value[pascal] ?? value[camel]) as T;
}

function canonical(value: unknown): string {
    return String(value || '').replaceAll('-', '').toLowerCase();
}

async function setPluginPolicy(
    baseURL: string,
    token: string,
    original: Record<string, unknown>,
    hiddenContentEnabled: boolean,
    administratorRemoveDefault: boolean,
): Promise<void> {
    const response = await apiRaw(baseURL, CONFIG_PATH, token, {
        method: 'POST',
        body: JSON.stringify({
            ...original,
            HiddenContentEnabled: hiddenContentEnabled,
            RemoveContinueWatchingEnabled: administratorRemoveDefault,
        }),
    });
    expect(response.status, 'plugin policy update').toBe(204);
}

async function waitForPluginPolicy(
    page: Page,
    hiddenContentEnabled: boolean,
    administratorRemoveDefault: boolean,
): Promise<void> {
    await page.waitForFunction(({ hidden, remove }) => {
        const config = (window as any).JellyfinCanopy?.pluginConfig;
        return config?.HiddenContentEnabled === hidden
            && config?.RemoveContinueWatchingEnabled === remove;
    }, { hidden: hiddenContentEnabled, remove: administratorRemoveDefault });
}

async function setUserRemovePolicy(page: Page, enabled: boolean): Promise<void> {
    const acknowledgement = await page.evaluate(async (next) => {
        const canopy = (window as any).JellyfinCanopy;
        const settings = canopy.currentSettings;
        if (!settings || !canopy.identity?.isOwned?.(settings)) {
            throw new Error('active settings are not identity-owned');
        }
        settings.removeContinueWatchingEnabled = next;
        return canopy.saveUserSettings('settings.json', settings);
    }, enabled) as { acknowledged?: unknown };
    expect(acknowledgement.acknowledged, 'client persistence acknowledgement').toBe(true);
    await page.waitForFunction((next) =>
        (window as any).JellyfinCanopy.currentSettings
            ?.removeContinueWatchingEnabled === next,
    enabled);
}

async function resumeIds(page: Page, mediaType: 'Audio' | 'Book'): Promise<string[]> {
    return page.evaluate(async (type) => {
        const apiClient = (window as any).ApiClient;
        const userId = apiClient.getCurrentUserId();
        const result = await apiClient.ajax({
            type: 'GET',
            url: apiClient.getUrl(
                `/UserItems/Resume?userId=${encodeURIComponent(userId)}`
                + `&limit=100&mediaTypes=${encodeURIComponent(type)}`
            ),
            dataType: 'json',
        });
        return (result?.Items || []).map((item: any) => String(item?.Id || ''));
    }, mediaType);
}

async function actionFor(
    page: Page,
    cardSelector: string,
    itemId: string,
    expectedSurface: 'continuewatching' | null,
    journalMutation: () => void = () => {},
): Promise<void> {
    await page.evaluate(({ selector }) => {
        document.querySelector('#jc-remove-policy-sheet')?.remove();
        const card = document.querySelector<HTMLElement>(selector);
        const menu = card?.querySelector<HTMLButtonElement>('button[data-action="menu"]');
        if (!card || !menu) throw new Error(`missing action source ${selector}`);
        menu.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

        const container = document.createElement('div');
        container.id = 'jc-remove-policy-sheet';
        container.className = 'dialogContainer';
        container.innerHTML = `
            <div class="dialog actionSheet opened" style="display:block">
                <div class="actionSheetScroller">
                    <button class="listItem actionSheetMenuItem" data-id="play">
                        <span class="actionSheetItemText">Play</span>
                    </button>
                </div>
            </div>`;
        document.body.appendChild(container);
        (window as any).JellyfinCanopy.addRemoveButton();
    }, { selector: cardSelector });

    const button = page.locator(
        '#jc-remove-policy-sheet [data-id="remove-continue-watching"]'
    );
    if (expectedSurface === null) {
        await expect(button, 'ordinary row gets no scoped action').toHaveCount(0);
        return;
    }

    await expect(button, 'real feature injected the scoped native action').toHaveCount(1);
    await expect(button).toHaveAttribute('data-jc-item-id', itemId);
    await expect(button).toHaveAttribute('data-jc-surface', expectedSurface);
    const responsePromise = page.waitForResponse((response) =>
        response.request().method() === 'POST'
        && response.url().includes(
            `/JellyfinCanopy/continue-watching/hide/${encodeURIComponent(itemId)}`
        ));
    await button.click();
    const response = await responsePromise;
    await completeAcknowledgedMutation({
        verifyAcknowledgement: () => {
            expect(response.status(), 'caller-authorized scoped POST').toBe(200);
        },
        journalMutation,
        verifyProductState: () => expect(page.locator(cardSelector)).toHaveCSS('display', 'none'),
    });
}

test.describe('Remove-from-home policy and resume row ownership', () => {
    test.use({ serviceWorkers: 'block' });

    test('real audio/book actions obey the effective user policy and stay scoped to resume rows', async ({
        page,
        baseURL,
        consoleErrors,
    }) => {
        const admin = await authenticate(baseURL!, 'jc_arradmin', 'Test669Pw!x');
        const user = await authenticate(baseURL!, 'jc_arruser', 'Test669Pw!x');
        const originalConfig = await api<Record<string, unknown>>(
            baseURL!, CONFIG_PATH, admin.token
        );
        expect(originalConfig).toBeTruthy();

        await loginAs(page, 'user', consoleErrors);
        consoleErrors.reset();
        const fixture = await page.evaluate(async () => {
            const apiClient = (window as any).ApiClient;
            const userId = apiClient.getCurrentUserId();
            const result = await apiClient.getItems(userId, {
                Recursive: true,
                IncludeItemTypes: 'Audio,Book',
                Limit: 100,
            });
            const audio = (result?.Items || []).find(
                (item: any) => item.Type === 'Audio' && item.Name === 'Canopy Resume Audio'
            );
            const book = (result?.Items || []).find(
                (item: any) => item.Type === 'Book' && item.Name === 'Canopy Resume Book'
            );
            return {
                userId,
                audio: audio && { id: audio.Id, type: audio.Type },
                book: book && { id: book.Id, type: book.Type },
                originalRemovePolicy:
                    (window as any).JellyfinCanopy.currentSettings
                        ?.removeContinueWatchingEnabled === true,
            };
        });
        expect(fixture.audio, 'real audio fixture is caller-visible').toBeTruthy();
        expect(fixture.book, 'real book fixture is caller-visible').toBeTruthy();
        expect(canonical(user.userId), 'cleanup session owns the browser user').toBe(
            canonical(fixture.userId)
        );

        const hiddenResponse = await apiRaw(
            baseURL!,
            `/JellyfinCanopy/admin/hidden-content/${fixture.userId}`,
            admin.token,
        );
        expect(hiddenResponse.status).toBe(200);
        const hiddenEnvelope = await hiddenResponse.json() as Record<string, any>;
        const originalHidden = field<Record<string, any>>(
            hiddenEnvelope,
            'HiddenContent',
            'hiddenContent',
        );
        const originalEntries = field<Record<string, any>>(
            originalHidden,
            'Items',
            'items',
        ) || {};
        const originalIds = new Set([
            ...Object.keys(originalEntries),
            ...Object.values(originalEntries).map(
                (item: any) => item?.ItemId ?? item?.itemId
            ),
        ].map(canonical));
        expect(originalIds.has(canonical(fixture.audio!.id))).toBe(false);
        expect(originalIds.has(canonical(fixture.book!.id))).toBe(false);

        const originalUserData = await page.evaluate(async (ids) => {
            const apiClient = (window as any).ApiClient;
            const userId = apiClient.getCurrentUserId();
            return Promise.all(ids.map((id) => apiClient.ajax({
                type: 'GET',
                url: apiClient.getUrl(
                    `/UserItems/${encodeURIComponent(id)}/UserData?userId=${encodeURIComponent(userId)}`
                ),
                dataType: 'json',
            })));
        }, [fixture.audio!.id, fixture.book!.id]);

        let audioHidden = false;
        let bookHidden = false;
        let primaryError: unknown = null;
        try {
            await page.evaluate(async (ids) => {
                const apiClient = (window as any).ApiClient;
                const userId = apiClient.getCurrentUserId();
                for (const id of ids) {
                    const current = await apiClient.ajax({
                        type: 'GET',
                        url: apiClient.getUrl(
                            `/UserItems/${encodeURIComponent(id)}/UserData?userId=${encodeURIComponent(userId)}`
                        ),
                        dataType: 'json',
                    });
                    await apiClient.ajax({
                        type: 'POST',
                        url: apiClient.getUrl(
                            `/UserItems/${encodeURIComponent(id)}/UserData?userId=${encodeURIComponent(userId)}`
                        ),
                        data: JSON.stringify({
                            ...current,
                            PlaybackPositionTicks: 10_000_000,
                            Played: false,
                        }),
                        contentType: 'application/json',
                    });
                }
            }, [fixture.audio!.id, fixture.book!.id]);

            // User false overrides administrator true on both native media families.
            await setPluginPolicy(baseURL!, admin.token, originalConfig!, false, true);
            await waitForPluginPolicy(page, false, true);
            await setUserRemovePolicy(page, false);
            await expect.poll(async () => ({
                audio: (await resumeIds(page, 'Audio')).map(canonical),
                book: (await resumeIds(page, 'Book')).map(canonical),
            }), { message: 'disabled user override preserves real audio/book Resume rows' })
                .toMatchObject({
                    audio: expect.arrayContaining([canonical(fixture.audio!.id)]),
                    book: expect.arrayContaining([canonical(fixture.book!.id)]),
                });

            // User true overrides administrator false, then the real loader owns
            // section2/section3 action injection from DisplayPreferences.
            await setPluginPolicy(baseURL!, admin.token, originalConfig!, false, false);
            await waitForPluginPolicy(page, false, false);
            await setUserRemovePolicy(page, true);
            await showRoute(page, '/mypreferencesmenu.html');
            await waitForHash(page, '#/mypreferencesmenu');
            await showRoute(page, '/home');
            await waitForHash(page, '#/home');
            await page.waitForFunction(() =>
                typeof (window as any).JellyfinCanopy?.addRemoveButton === 'function'
                && typeof (window as any).JellyfinCanopy?.detectCardSurface === 'function'
            );

            const rowProof = await page.evaluate(async ({ audioId, bookId }) => {
                const apiClient = (window as any).ApiClient;
                const userId = apiClient.getCurrentUserId();
                const prefs = await apiClient.getDisplayPreferences('usersettings', userId, 'emby');
                const custom = prefs?.CustomPrefs || {};
                const expected = {
                    section2: String(custom.homesection2 || 'resumeaudio').toLowerCase(),
                    section3: String(custom.homesection3 || 'resumebook').toLowerCase(),
                    section4: String(custom.homesection4 || 'livetv').toLowerCase(),
                };
                const owner = document.createElement('div');
                owner.id = 'jc-remove-policy-proof';
                owner.className = 'homeSectionsContainer';
                owner.innerHTML = `
                    <div class="verticalSection section2">
                        <div class="card" data-id="${audioId}" data-type="Audio">
                            <button data-action="menu">Audio menu</button>
                        </div>
                    </div>
                    <div class="verticalSection section3">
                        <div class="card" data-id="${bookId}" data-type="Book">
                            <button data-action="menu">Book menu</button>
                        </div>
                    </div>
                    <div class="verticalSection section4">
                        <div class="card" data-id="${audioId}" data-type="Audio">
                            <button data-action="menu">Ordinary menu</button>
                        </div>
                    </div>`;
                document.body.appendChild(owner);
                const canopy = (window as any).JellyfinCanopy;
                const surfaces = () => [2, 3, 4].map((index) => canopy.detectCardSurface(
                    owner.querySelector(`.section${index} .card`)
                ));
                const deadline = Date.now() + 10_000;
                let values = surfaces();
                while ((values[0] === null || values[1] === null) && Date.now() < deadline) {
                    await new Promise((resolve) => setTimeout(resolve, 50));
                    values = surfaces();
                }
                return { expected, values };
            }, { audioId: fixture.audio!.id, bookId: fixture.book!.id });
            expect(rowProof.expected).toEqual({
                section2: 'resumeaudio',
                section3: 'resumebook',
                section4: 'livetv',
            });
            expect(rowProof.values).toEqual(['continuewatching', 'continuewatching', null]);

            await actionFor(
                page,
                '#jc-remove-policy-proof .section4 .card',
                fixture.audio!.id,
                null,
            );
            await actionFor(
                page,
                '#jc-remove-policy-proof .section2 .card',
                fixture.audio!.id,
                'continuewatching',
                () => { audioHidden = true; },
            );
            await actionFor(
                page,
                '#jc-remove-policy-proof .section3 .card',
                fixture.book!.id,
                'continuewatching',
                () => { bookHidden = true; },
            );
            await expect(
                page.locator('#jc-remove-policy-proof .section4 .card'),
                'same item stays visible on an unrelated authoritative row',
            ).not.toHaveCSS('display', 'none');

            await expect.poll(async () => ({
                audio: (await resumeIds(page, 'Audio')).map(canonical),
                book: (await resumeIds(page, 'Book')).map(canonical),
            }), { message: 'fresh native Resume responses apply both scoped actions' })
                .toEqual({ audio: [], book: [] });

            const playbackTicks = await page.evaluate(async (ids) => {
                const apiClient = (window as any).ApiClient;
                const userId = apiClient.getCurrentUserId();
                return Promise.all(ids.map(async (id) => {
                    const data = await apiClient.ajax({
                        type: 'GET',
                        url: apiClient.getUrl(
                            `/UserItems/${encodeURIComponent(id)}/UserData?userId=${encodeURIComponent(userId)}`
                        ),
                        dataType: 'json',
                    });
                    return Number(data?.PlaybackPositionTicks || 0);
                }));
            }, [fixture.audio!.id, fixture.book!.id]);
            expect(playbackTicks).toEqual([10_000_000, 10_000_000]);
            assertNoRuntimeErrors(consoleErrors);
        } catch (error) {
            primaryError = error;
        }

        const cleanupFailures = await runIndependentRestorations({
            pageCleanup: async () => {
                await page.evaluate(() => {
                    document.querySelector('#jc-remove-policy-proof')?.remove();
                    document.querySelector('#jc-remove-policy-sheet')?.remove();
                });
            },
            restoreDurableUserState: async () => {
                const userStateFailures: string[] = [];
                const attempt = async (label: string, operation: () => Promise<Response>) => {
                    try {
                        const response = await operation();
                        if (!response.ok) {
                            throw new Error(`HTTP ${response.status}`);
                        }
                    } catch (error) {
                        userStateFailures.push(
                            `${label}: ${error instanceof Error ? error.message : String(error)}`
                        );
                    }
                };
                const ids = [fixture.audio!.id, fixture.book!.id];
                const hidden = [audioHidden, bookHidden];
                for (let index = 0; index < ids.length; index++) {
                    if (hidden[index]) {
                        await attempt(`unhide item ${index}`, () => apiRaw(
                            baseURL!,
                            `/JellyfinCanopy/continue-watching/hide/${encodeURIComponent(ids[index])}`,
                            user.token,
                            { method: 'DELETE' },
                        ));
                    }
                    await attempt(`restore user data ${index}`, () => apiRaw(
                        baseURL!,
                        `/UserItems/${encodeURIComponent(ids[index])}/UserData?userId=${encodeURIComponent(user.userId)}`,
                        user.token,
                        { method: 'POST', body: JSON.stringify(originalUserData[index]) },
                    ));
                }

                try {
                    const settingsPath = `/JellyfinCanopy/user-settings/${encodeURIComponent(user.userId)}/settings.json`;
                    const current = await api<Record<string, any>>(
                        baseURL!, settingsPath, user.token
                    );
                    if (!current) throw new Error('current settings response is empty');
                    const revision = field<number>(current, 'Revision', 'revision');
                    const revisionKey = Object.hasOwn(current, 'Revision') ? 'Revision' : 'revision';
                    const removeKey = Object.hasOwn(current, 'RemoveContinueWatchingEnabled')
                        ? 'RemoveContinueWatchingEnabled'
                        : 'removeContinueWatchingEnabled';
                    const restored = {
                        ...current,
                        [revisionKey]: revision,
                        [removeKey]: fixture.originalRemovePolicy,
                    };
                    await attempt('restore user Remove policy', () => apiRaw(
                        baseURL!,
                        settingsPath,
                        user.token,
                        {
                            method: 'POST',
                            headers: { 'If-Match': `"${revision}"` },
                            body: JSON.stringify(restored),
                        },
                    ));
                } catch (error) {
                    userStateFailures.push(
                        `restore user Remove policy: ${error instanceof Error ? error.message : String(error)}`
                    );
                }

                if (userStateFailures.length > 0) {
                    throw new Error(userStateFailures.join('; '));
                }
            },
            restoreAdministratorConfig: async () => {
                const restore = await apiRaw(baseURL!, CONFIG_PATH, admin.token, {
                    method: 'POST',
                    body: JSON.stringify(originalConfig),
                });
                expect(restore.status).toBe(204);
            },
        });

        throwAfterRestoration(primaryError, cleanupFailures);

        assertNoRuntimeErrors(consoleErrors);
    });
});
