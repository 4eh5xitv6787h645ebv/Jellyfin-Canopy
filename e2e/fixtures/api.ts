// Server-side REST helpers for the E2E suite.
//
// Tokens are obtained by authenticating the test users through the public
// /Users/AuthenticateByName endpoint — no pre-provisioned API key is needed,
// so the same specs run against any seeded server (local dev or CI compose).
//
// Jellyfin 12 gotcha (docs/v12-platform.md §6.9): legacy auth carriers
// (?api_key=, X-Emby-Token) are ignored — only the full
// `Authorization: MediaBrowser Token="..."` header works.

const CLIENT_AUTH = 'MediaBrowser Client="JC-E2E", Device="jc-e2e", DeviceId="jc-e2e", Version="1.0.0"';

export const PLUGIN_ID = '9ffa12bc-f4b5-406c-ab1d-d575acbeea7b';

export interface Session {
    token: string;
    userId: string;
}

/** Build the MediaBrowser Authorization header (optionally token-less). */
export function authHeader(token?: string): string {
    return token ? `${CLIENT_AUTH}, Token="${token}"` : CLIENT_AUTH;
}

/** Authenticate a user by name and return an access token + user id. */
export async function authenticate(baseURL: string, username: string, password: string): Promise<Session> {
    const response = await fetch(`${baseURL}/Users/AuthenticateByName`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: authHeader(),
        },
        body: JSON.stringify({ Username: username, Pw: password }),
    });
    if (!response.ok) {
        throw new Error(`AuthenticateByName(${username}) -> ${response.status}`);
    }
    const body = (await response.json()) as { AccessToken: string; User: { Id: string } };
    return { token: body.AccessToken, userId: body.User.Id };
}

/** Raw request — returns the Response so specs can assert status codes. */
export async function apiRaw(
    baseURL: string,
    path: string,
    token?: string,
    init: RequestInit = {}
): Promise<Response> {
    return fetch(`${baseURL}${path}`, {
        ...init,
        headers: {
            Authorization: authHeader(token),
            'Content-Type': 'application/json',
            ...(init.headers || {}),
        },
    });
}

/** JSON request that throws on non-2xx (204/empty bodies return null). */
export async function api<T = unknown>(
    baseURL: string,
    path: string,
    token: string,
    init: RequestInit = {}
): Promise<T | null> {
    const response = await apiRaw(baseURL, path, token, init);
    if (!response.ok && response.status !== 204) {
        throw new Error(`${init.method || 'GET'} ${path} -> ${response.status}`);
    }
    const text = await response.text();
    return text ? (JSON.parse(text) as T) : null;
}
