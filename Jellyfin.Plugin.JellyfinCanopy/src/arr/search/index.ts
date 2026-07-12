// src/arr/search/index.ts
//
// Wires the admin-only arr Search feature: resolve admin once, inject CSS, install the
// trigger-time capture, drive the action-sheet injector off the shared body-mutation
// multiplexer (never a new body observer — R3), and prefetch the details item type on
// navigation so the details "…" menu can gate synchronously. Idempotent + hot-reloadable.

import { JC } from '../../globals';
import { getItemIdFromUrl } from '../../core/details-view';
import { LIVE, on } from '../../core/live';
import { setAdmin, searchEnabled, cacheDetailsType, getDetailsType } from './state';
import { injectArrSearchStyles } from './styles';
import { installCapture } from './capture';
import { requestInject, injectSearchItems } from './menu';

/** Public surface exposed as window.JellyfinCanopy.arrSearch. */
export interface ArrSearchApi {
    /** Wire the feature up (idempotent — also runs on config hot-reload). */
    initialize(): void;
    /** Remove injected listeners/observers and release tracked resources. */
    teardown(): void;
}

declare module '../../types/jc' {
    interface JEGlobal {
        /** arr Search: admin-only action-sheet Search / Interactive Search / Manage. */
        arrSearch?: ArrSearchApi;
    }
}

const lifecycle = JC.core.lifecycle!.register('arr-search');
let installed = false;

interface UserWithPolicy { Policy?: { IsAdministrator?: boolean }; }

/** Resolves the caller's admin flag once (cached in currentSettings, like arr-links). */
async function resolveAdmin(): Promise<boolean> {
    if (JC.currentSettings?.isAdmin === true) { setAdmin(true); return true; }
    try {
        const user = await ApiClient.getCurrentUser() as UserWithPolicy;
        const admin = user?.Policy?.IsAdministrator === true;
        setAdmin(admin);
        return admin;
    } catch {
        return false;
    }
}

interface ItemHelpers { getItemCached?(itemId: string, options?: { userId?: string }): Promise<unknown>; }

/** Caches the current details item's type so the details "…" menu can gate without a round-trip. */
function prefetchDetailsType(): void {
    const itemId = getItemIdFromUrl();
    if (!itemId || getDetailsType(itemId)) return;
    const helpers = JC.helpers as ItemHelpers | undefined;
    helpers?.getItemCached?.(itemId, { userId: ApiClient.getCurrentUserId() })
        .then((item) => cacheDetailsType(itemId, (item as { Type?: string } | null)?.Type || null))
        .catch(() => { /* details more menu simply resolves the type on demand */ });
}

async function install(): Promise<void> {
    if (installed || !searchEnabled()) return;
    if (!await resolveAdmin()) return; // non-admins never see the items; skip the listeners entirely
    if (installed) return; // re-entrancy guard across the await

    installed = true;
    injectArrSearchStyles();
    installCapture((unregister) => lifecycle.track(unregister));

    // Reuse the shared body-observer multiplexer; a sheet opening triggers a re-inject.
    lifecycle.track(JC.core.dom!.onBodyMutation('jc-arr-search-actionsheet', () => requestInject()));

    // Prefetch details type on every navigation (cheap, cached).
    lifecycle.track(JC.core.navigation!.onNavigate(() => prefetchDetailsType()));
    prefetchDetailsType();
}

function initialize(): void {
    void install();
}

function teardown(): void {
    lifecycle.teardown();
    installed = false;
}

// Always listen for config hot-reload so enabling the feature mid-session installs it, and a
// disable is reflected immediately (the injector also reads the live flag each pass).
lifecycle.track(on(LIVE.CONFIG_CHANGED, () => {
    if (searchEnabled()) initialize(); else injectSearchItems();
}));

JC.arrSearch = { initialize, teardown };
initialize();

console.log('🪼 Jellyfin Canopy: arr Search: module loaded');
