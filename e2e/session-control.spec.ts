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

// A DISTINCT device for the streamed session — critical, because a Jellyfin
// device holds one session per client; if the arruser and the admin both
// authenticated on the fixture's shared device id, the admin's login would
// supersede (close) the arruser's playing session before we could observe it.
const STREAM_CLIENT = 'MediaBrowser Client="JE-E2E", Device="je-e2e-sc", DeviceId="je-e2e-sc-stream", Version="1.0.0"';

/** Report a movie as playing for je_arruser on its own device; return its name. */
async function startUserPlayback(baseURL: string): Promise<string> {
    const authRes = await fetch(`${baseURL}/Users/AuthenticateByName`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: STREAM_CLIENT },
        body: JSON.stringify({ Username: USERS.user.username, Pw: USERS.user.password }),
    });
    if (!authRes.ok) throw new Error(`stream auth -> ${authRes.status}`);
    const auth = (await authRes.json()) as { AccessToken: string; User: { Id: string } };
    const streamAuth = `${STREAM_CLIENT}, Token="${auth.AccessToken}"`;
    const call = (path: string, init: RequestInit = {}): Promise<Response> =>
        fetch(`${baseURL}${path}`, { ...init, headers: { Authorization: streamAuth, 'Content-Type': 'application/json', ...(init.headers || {}) } });

    const items = (await (await call(`/Users/${auth.User.Id}/Items?IncludeItemTypes=Movie&Recursive=true&Limit=1`)).json()) as { Items?: Array<{ Id: string; Name: string }> };
    const item = items?.Items?.[0];
    if (!item) throw new Error('no movie available to play');
    await call('/Sessions/Capabilities/Full', {
        method: 'POST',
        body: JSON.stringify({ PlayableMediaTypes: ['Video'], SupportedCommands: ['DisplayMessage', 'PlayState'], SupportsMediaControl: true }),
    });
    await call('/Sessions/Playing', {
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
        //
        // NOTE: this asserts ENDPOINT-LEVEL success only. The streamed session is
        // a REST-reported fixture with no live client attached (it reports
        // SupportsRemoteControl=false), so the message is accepted and dispatched
        // by the core but has no client to render it — we deliberately do NOT
        // claim on-screen delivery here. Real client rendering of the core
        // message dialog is out of scope for this fixture; the per-card compose /
        // send UI is covered by the unit tests.
        const msg = await apiRaw(baseURL!, `/JellyfinElevate/active-streams/sessions/${target.Id}/message`, admin.token, {
            method: 'POST',
            body: JSON.stringify({ text: 'Please pause your stream', timeoutMs: 5000 }),
        });
        expect(msg.status, 'admin message endpoint accepts the request → 200').toBe(200);

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
