// src/arr/search/actions.ts
//
// The server API layer (JE.core.api.plugin over /JellyfinElevate/arr/search/*), the
// user-facing toasts, and the deep-link to the existing Downloads page. No second
// downloads UI is built here — post-action progress reuses /arr/search/status (the same
// Sonarr/Radarr queue the Downloads page shows) and links the user to that page.

import { JE } from '../../globals';
import type { ArrPluginConfig } from '../arr-globals';
import type {
    ArrContext, ArrReleaseList, ArrDispatchResult, ArrAddOptions, ArrQueueRow, ArrService,
} from './types';

const logPrefix = '🪼 Jellyfin Elevate: arr Search:';

interface PluginApi {
    plugin(path: string, options?: { method?: string; body?: unknown; skipRetry?: boolean }): Promise<unknown>;
}

function api(): PluginApi | null {
    return (JE.core?.api as unknown as PluginApi) || null;
}

/** Extracts a human error message from an HttpError-shaped throw (v12 auth = bare 401/403). */
export function errorMessage(err: unknown): string {
    const e = err as { status?: number; responseJSON?: { message?: string; Message?: string }; message?: string };
    if (e?.status === 401 || e?.status === 403) return JE.t!('arr_search_error_forbidden');
    return e?.responseJSON?.message || e?.responseJSON?.Message || e?.message || JE.t!('unknown_error');
}

export async function fetchContext(itemId: string): Promise<ArrContext> {
    const result = await api()!.plugin(`/arr/search/context?itemId=${encodeURIComponent(itemId)}`);
    return result as ArrContext;
}

export async function autoSearch(itemId: string, instanceName?: string): Promise<ArrDispatchResult> {
    const result = await api()!.plugin('/arr/search/auto', {
        method: 'POST', skipRetry: true, body: { itemId, instanceName: instanceName ?? null },
    });
    return result as ArrDispatchResult;
}

export async function fetchReleases(itemId: string, instanceName: string): Promise<ArrReleaseList> {
    const q = new URLSearchParams({ itemId, instanceName });
    const result = await api()!.plugin(`/arr/search/releases?${q.toString()}`);
    return result as ArrReleaseList;
}

export async function grabRelease(service: ArrService, instanceName: string, guid: string, indexerId: number): Promise<void> {
    // skipRetry: grabbing is not idempotent — a silent retry could double-grab.
    await api()!.plugin('/arr/search/grab', {
        method: 'POST', skipRetry: true, body: { service, instanceName, guid, indexerId },
    });
}

export async function setMonitored(itemId: string, monitored: boolean, instanceName?: string): Promise<ArrDispatchResult> {
    const result = await api()!.plugin('/arr/search/monitor', {
        method: 'POST', skipRetry: true, body: { itemId, monitored, instanceName: instanceName ?? null },
    });
    return result as ArrDispatchResult;
}

export async function fetchAddOptions(service: ArrService, instanceName: string): Promise<ArrAddOptions> {
    const q = new URLSearchParams({ service, instanceName });
    const result = await api()!.plugin(`/arr/search/add-options?${q.toString()}`);
    return result as ArrAddOptions;
}

export interface AddBody {
    itemId: string;
    instanceName: string;
    qualityProfileId: number;
    rootFolderPath: string;
    monitored: boolean;
    searchOnAdd: boolean;
    minimumAvailability?: string | null;
}

export async function addItem(body: AddBody): Promise<{ ok: boolean; arrId?: number | null }> {
    const result = await api()!.plugin('/arr/search/add', { method: 'POST', skipRetry: true, body });
    return result as { ok: boolean; arrId?: number | null };
}

export async function fetchStatus(itemId: string): Promise<ArrQueueRow[]> {
    const result = await api()!.plugin(`/arr/search/status?itemId=${encodeURIComponent(itemId)}`) as { items?: ArrQueueRow[] };
    return result?.items ?? [];
}

// ── toasts (JE.toast renders innerHTML — every dynamic value is escaped) ─────

export function toast(iconKey: string, message: string, duration = 4000): void {
    try {
        JE.toast!(`{{icon:${iconKey}}} ${JE.escapeHtml(message)}`, duration);
    } catch (e) {
        console.log(`${logPrefix} ${message}`, e);
    }
}

export function toastInfo(message: string): void { toast('search', message); }
export function toastSuccess(message: string): void { toast('check_circle', message, 5000); }
export function toastError(message: string): void { toast('error', message, 6000); }

// ── Downloads-page deep-link (reuses the existing page; never a second one) ──

/** Whether the existing Downloads page exists to link to. */
export function downloadsPageAvailable(): boolean {
    const cfg = (JE.pluginConfig || {}) as ArrPluginConfig;
    return cfg.DownloadsPageEnabled === true;
}

/**
 * Navigates to the existing Downloads page by clicking its registered nav link (the same one the
 * Requests/Downloads tab uses). Best-effort: if the link isn't in the DOM (page disabled or not yet
 * rendered) it does nothing, and the caller keeps the plain toast.
 */
export function navigateToDownloads(): boolean {
    const link = document.querySelector<HTMLElement>(
        'a[is="emby-linkbutton"][data-itemid="Jellyfin.Plugin.JellyfinElevate.DownloadsPage"]');
    if (link) { link.click(); return true; }
    return false;
}
