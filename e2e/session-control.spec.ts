// Session Control (Active Streams) end-to-end.
//
// Admin perspective: the header widget is present, its panel shows the live
// session an ordinary user is playing, and the admin-only session-control
// endpoints (stop / targeted message) act on it. Non-admin perspective: no
// widget is injected and every session-control endpoint is forbidden.
//
// The played "session" is created over REST (authenticate → declare
// capabilities → report Playing) so the test needs no real video decode. Such
// a session reports SupportsRemoteControl=false (no live controller), so the
// per-card Stop/Message BUTTONS — gated on that flag — are covered by the
// unit tests; here we drive the endpoints directly to assert their effect and
// the admin/non-admin gate.
import { test, expect, loginAs, assertNoRuntimeErrors, USERS } from './fixtures/auth';
import { api, apiRaw, authenticate, PLUGIN_ID } from './fixtures/api';

/* eslint-disable @typescript-eslint/no-explicit-any */

const CONFIG_PATH = `/Plugins/${PLUGIN_ID}/Configuration`;

async function enableActiveStreams(baseURL: string): Promise<void> {
    const admin = await authenticate(baseURL, USERS.admin.username, USERS.admin.password);
    const config = await api<Record<string, unknown>>(baseURL, CONFIG_PATH, admin.token);
    await api(baseURL, CONFIG_PATH, admin.token, {
        method: 'POST',
        body: JSON.stringify({ ...config, ActiveStreamsEnabled: true, ActiveStreamsAllUsers: false }),
    });
}

/** Report a movie as playing for je_arruser, returning the item name. */
async function startUserPlayback(baseURL: string): Promise<string> {
    const user = await authenticate(baseURL, USERS.user.username, USERS.user.password);
    const items = await api<{ Items?: Array<{ Id: string; Name: string }> }>(
        baseURL,
        `/Users/${user.userId}/Items?IncludeItemTypes=Movie&Recursive=true&Limit=1`,
        user.token,
    );
    const item = items?.Items?.[0];
    if (!item) throw new Error('no movie available to play');
    await api(baseURL, '/Sessions/Capabilities/Full', user.token, {
        method: 'POST',
        body: JSON.stringify({ PlayableMediaTypes: ['Video'], SupportedCommands: ['DisplayMessage', 'PlayState'], SupportsMediaControl: true }),
    });
    await api(baseURL, '/Sessions/Playing', user.token, {
        method: 'POST',
        body: JSON.stringify({ ItemId: item.Id, PlayMethod: 'DirectPlay', CanSeek: true, PositionTicks: 0 }),
    });
    return item.Name;
}

test.describe('session control', () => {
    test('admin sees the live session and can stop / message it', async ({ page, consoleErrors, baseURL }) => {
        await enableActiveStreams(baseURL!);
        const itemName = await startUserPlayback(baseURL!);

        const admin = await authenticate(baseURL!, USERS.admin.username, USERS.admin.password);

        // The plugin surface reports the session with the fields the client needs.
        const sessions = await api<Array<any>>(baseURL!, '/JellyfinElevate/active-streams/sessions', admin.token);
        const target = (sessions || []).find((s) => s?.NowPlayingItem?.Name === itemName);
        expect(target, 'admin session list includes the played item').toBeTruthy();
        expect(typeof target.Id).toBe('string');
        expect('SupportsRemoteControl' in target).toBe(true);

        // The admin UI renders the session panel with a card for that stream.
        await loginAs(page, 'admin', consoleErrors);
        await page.waitForFunction(
            () => (window as any).JellyfinElevate?.initialized === true
                && (window as any).JellyfinElevate?.pluginConfig?.ActiveStreamsEnabled === true,
            undefined,
            { timeout: 60_000 },
        );
        const widget = page.locator('#je-active-streams');
        await expect(widget).toBeVisible({ timeout: 30_000 });
        await widget.click();
        const card = page.locator('#je-active-streams-panel .je-as-card').first();
        await expect(card).toBeVisible({ timeout: 15_000 });
        await expect(card).toContainText(itemName);

        // Session-control endpoints act on that session (admin-gated).
        const msg = await apiRaw(baseURL!, `/JellyfinElevate/active-streams/sessions/${target.Id}/message`, admin.token, {
            method: 'POST',
            body: JSON.stringify({ text: 'Please pause your stream', timeoutMs: 5000 }),
        });
        expect(msg.status, 'admin message → 200').toBe(200);

        const stop = await apiRaw(baseURL!, `/JellyfinElevate/active-streams/sessions/${target.Id}/stop`, admin.token, {
            method: 'POST',
        });
        expect(stop.status, 'admin stop → 200').toBe(200);
        expect((await stop.json()).stopped).toBe(true);

        // The played user has no profile image, so the session card's avatar
        // <img> 404s and falls back to the person icon (handled by its onerror).
        // Scope that benign 404 locally — mirrors settings-persist.spec.ts.
        const AVATAR_404 = /\/Users\/[^/]+\/Images\/Primary/i;
        expect(consoleErrors.real().filter((t) => !AVATAR_404.test(t)), 'unexpected console errors').toEqual([]);
        expect(consoleErrors.unexpected4xx().filter((r) => !AVATAR_404.test(r.url)), 'unexpected 4xx').toEqual([]);
    });

    test('non-admin gets no session surface and is forbidden from controls', async ({ page, consoleErrors, baseURL }) => {
        await enableActiveStreams(baseURL!); // enabled, but AllUsers off

        // No widget for a non-admin when "show to non-admins" is off.
        await loginAs(page, 'user', consoleErrors);
        await page.waitForFunction(
            () => (window as any).JellyfinElevate?.initialized === true,
            undefined,
            { timeout: 60_000 },
        );
        await expect(page.locator('#je-active-streams')).toHaveCount(0);

        // Every session-control endpoint is forbidden for a non-admin token.
        const user = await authenticate(baseURL!, USERS.user.username, USERS.user.password);
        const list = await apiRaw(baseURL!, '/JellyfinElevate/active-streams/sessions', user.token);
        expect(list.status, 'non-admin sessions list → 403').toBe(403);
        const stop = await apiRaw(baseURL!, '/JellyfinElevate/active-streams/sessions/anything/stop', user.token, { method: 'POST' });
        expect(stop.status, 'non-admin stop → 403').toBe(403);
        const msg = await apiRaw(baseURL!, '/JellyfinElevate/active-streams/sessions/anything/message', user.token, {
            method: 'POST',
            body: JSON.stringify({ text: 'x' }),
        });
        expect(msg.status, 'non-admin message → 403').toBe(403);

        assertNoRuntimeErrors(consoleErrors);
    });
});
