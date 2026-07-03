// src/test/setup.ts
//
// Vitest setup: recreate the environment js/plugin.js guarantees before the
// bundle loads — the window.JellyfinEnhanced bootstrap namespace and the
// jellyfin-web globals the core modules touch at import time.

import type { JEGlobal } from '../types/je';

const bootstrapJE = {
    core: {},
    pluginConfig: {},
    translations: {},
    pluginVersion: 'test',
    escapeHtml: (value: unknown) => (typeof value === 'string' ? value : ''),
} as unknown as JEGlobal;

window.JellyfinEnhanced = bootstrapJE;

// Emby.Page must exist or navigation.ts's installEmbyHook keeps rescheduling
// itself forever (100ms retry loop) waiting for the host router.
window.Emby = { Page: {} };

// Minimal ApiClient: only what the core modules call at import/test time.
const apiClientStub = {
    getUrl: (path: string) => `http://jellyfin.test${path}`,
    getCurrentUserId: () => 'test-user-id',
    accessToken: () => 'test-token',
    getCurrentUser: () => Promise.resolve({}),
    getItem: () => Promise.resolve(null),
    ajax: () => Promise.resolve({}),
} as unknown as JellyfinApiClient;

window.ApiClient = apiClientStub;
// The modules reference the bare `ApiClient` global (not window.ApiClient).
(globalThis as Record<string, unknown>).ApiClient = apiClientStub;
