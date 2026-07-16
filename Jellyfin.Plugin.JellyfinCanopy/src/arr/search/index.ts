// src/arr/search/index.ts
//
// Wires the admin-only arr Search feature: resolve admin once, inject CSS, install the
// trigger-time capture, drive the action-sheet injector off the shared body-mutation
// multiplexer (never a new body observer — R3), and prefetch the details item type on
// navigation so the details "…" menu can gate synchronously. Idempotent + hot-reloadable.

import { JC } from '../../globals';
import { getItemIdFromUrl } from '../../core/details-view';
import { LIVE, on } from '../../core/live';
import { createStableMethodFacade } from '../../core/feature-loader';
import { setAdmin, searchEnabled, cacheDetailsType, getDetailsType, resetArrSearchState } from './state';
import { injectArrSearchStyles, removeArrSearchStyles } from './styles';
import { installCapture } from './capture';
import { requestInject, resetSearchItems } from './menu';
import { closeArrSearchModals } from './modal';
import type { IdentityContext, LifecycleHandle } from '../../types/jc';

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

let lifecycle: LifecycleHandle | null = null;
let installed = false;

interface UserWithPolicy { Policy?: { IsAdministrator?: boolean }; }

/** Resolves the caller's admin flag once (cached in currentSettings, like arr-links). */
async function resolveAdmin(context: IdentityContext): Promise<boolean> {
    if (JC.currentSettings?.isAdmin === true) { setAdmin(true); return true; }
    try {
        const user = await ApiClient.getCurrentUser() as UserWithPolicy;
        if (!JC.identity.isCurrent(context)) return false;
        const admin = user?.Policy?.IsAdministrator === true;
        setAdmin(admin);
        return admin;
    } catch {
        return false;
    }
}

interface ItemHelpers { getItemCached?(itemId: string, options?: { userId?: string }): Promise<unknown>; }

/** Caches the current details item's type so the details "…" menu can gate without a round-trip. */
function prefetchDetailsType(context: IdentityContext): void {
    if (!JC.identity.isCurrent(context)) return;
    const itemId = getItemIdFromUrl();
    if (!itemId || getDetailsType(itemId)) return;
    const helpers = JC.helpers as ItemHelpers | undefined;
    helpers?.getItemCached?.(itemId, { userId: ApiClient.getCurrentUserId() })
        .then((item) => {
            if (JC.identity.isCurrent(context)) {
                cacheDetailsType(itemId, (item as { Type?: string } | null)?.Type || null);
            }
        })
        .catch(() => { /* details more menu simply resolves the type on demand */ });
}

async function install(): Promise<void> {
    if (installed || !searchEnabled()) return;
    const context = JC.identity.capture();
    if (!context) return;
    if (!await resolveAdmin(context) || !JC.identity.isCurrent(context)) return; // non-admins never see the items; skip the listeners entirely
    if (installed) return; // re-entrancy guard across the await

    installed = true;
    lifecycle = JC.core.lifecycle!.register('arr-search');
    injectArrSearchStyles();
    installCapture((unregister) => lifecycle?.track(unregister));

    // Reuse the shared body-observer multiplexer; a sheet opening triggers a re-inject.
    lifecycle.track(JC.core.dom!.onBodyMutation('jc-arr-search-actionsheet', () => requestInject()));

    // Prefetch details type on every navigation (cheap, cached).
    lifecycle.track(JC.core.navigation!.onNavigate(() => prefetchDetailsType(context)));
    prefetchDetailsType(context);
}

function initialize(): void {
    void install();
}

export function teardown(): void {
    lifecycle?.teardown();
    lifecycle = null;
    installed = false;
    resetArrSearchState();
    resetSearchItems();
    closeArrSearchModals();
    removeArrSearchStyles();
}

const arrSearchApi: ArrSearchApi = { initialize, teardown };
const stableArrSearch = createStableMethodFacade<ArrSearchApi>({
    initialize() {},
    teardown() {},
});
const arrSearchFacade = Object.freeze({
    initialize: (): void => stableArrSearch.facade.initialize(),
    teardown: (): void => stableArrSearch.facade.teardown(),
});

export function installArrSearch(): () => void {
    const uninstall = stableArrSearch.install(arrSearchApi);
    JC.arrSearch = arrSearchFacade;
    const offConfig = on(LIVE.CONFIG_CHANGED, () => {
        if (searchEnabled()) initialize(); else teardown();
    });
    let disposed = false;
    return () => {
        if (disposed) return;
        disposed = true;
        offConfig();
        teardown();
        uninstall();
    };
}

export function initializeArrSearch(): void {
    arrSearchApi.initialize();
}
