// src/arr/search/actions.ts
//
// The server API layer (JC.core.api.plugin over /JellyfinCanopy/arr/search/*), the
// user-facing toasts, and the deep-link to the existing Downloads page. No second
// downloads UI is built here — post-action progress reuses /arr/search/status (the same
// Sonarr/Radarr queue the Downloads page shows) and links the user to that page.

import { JC } from '../../globals';
import type { ArrPluginConfig } from '../arr-globals';
import type {
    ArrContext, ArrReleaseList, ArrDispatchResult, ArrAddOptions, ArrQueueStatus, ArrService,
} from './types';

const logPrefix = '🪼 Jellyfin Canopy: arr Search:';

interface PluginApi {
    plugin(path: string, options?: {
        method?: string;
        body?: unknown;
        skipRetry?: boolean;
        signal?: AbortSignal;
        timeoutMs?: number;
    }): Promise<unknown>;
}

function api(): PluginApi | null {
    return (JC.core?.api as unknown as PluginApi) || null;
}

/** Extracts a human error message from an HttpError-shaped throw (v12 auth = bare 401/403). */
export function errorMessage(err: unknown): string {
    const e = err as { status?: number; responseJSON?: { message?: string; Message?: string }; message?: string };
    if (e?.status === 401 || e?.status === 403) return JC.t!('arr_search_error_forbidden');
    return e?.responseJSON?.message || e?.responseJSON?.Message || e?.message || JC.t!('unknown_error');
}

export async function fetchContext(itemId: string, signal?: AbortSignal): Promise<ArrContext> {
    const result = await api()!.plugin(
        `/arr/search/context?itemId=${encodeURIComponent(itemId)}`,
        { signal }
    );
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

export async function fetchAddOptions(
    service: ArrService,
    instanceName: string,
    signal?: AbortSignal
): Promise<ArrAddOptions> {
    const q = new URLSearchParams({ service, instanceName });
    const result = await api()!.plugin(`/arr/search/add-options?${q.toString()}`, { signal });
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

export async function fetchStatus(itemId: string, signal?: AbortSignal): Promise<ArrQueueStatus> {
    const result = await api()!.plugin(
        `/arr/search/status?itemId=${encodeURIComponent(itemId)}`,
        { signal, timeoutMs: 15_000 }
    ) as Partial<ArrQueueStatus> | null;
    return {
        items: Array.isArray(result?.items) ? result.items : [],
        errors: Array.isArray(result?.errors) ? result.errors : [],
        // Missing metadata is degraded/unknown, never convincing success.
        isComplete: result?.isComplete === true,
    };
}

// ── toasts (JC.toast renders innerHTML — every dynamic value is escaped) ─────

export function toast(iconKey: string, message: string, duration = 4000): void {
    try {
        // JC.t expands the {{icon:}} token to icon HTML (js/plugin.js) — JC.toast is a raw innerHTML
        // sink and does NOT expand it. iconKey is a constant; the message is escaped separately
        // (SEC(X1)) since JC.t does not escape and the message can carry item/error text.
        const iconHtml = JC.t ? JC.t(`{{icon:${iconKey}}}`) : '';
        JC.toast!(`${iconHtml} ${JC.escapeHtml(message)}`, duration);
    } catch (e) {
        console.log(`${logPrefix} ${message}`, e);
    }
}

// Icon keys must exist in the JC.t icon registry (js/locales use these): search, success, error.
export function toastInfo(message: string): void { toast('search', message); }
export function toastSuccess(message: string): void { toast('success', message, 5000); }
export function toastError(message: string): void { toast('error', message, 6000); }

// ── Downloads-page deep-link (reuses the existing page; never a second one) ──

/** Whether the existing Downloads page exists to link to. */
export function downloadsPageAvailable(): boolean {
    const cfg = (JC.pluginConfig || {}) as ArrPluginConfig;
    return cfg.DownloadsPageEnabled === true
        && cfg.ShowDownloadsInRequests !== false;
}

/** Navigates through the document-lifetime Downloads-page facade. */
export function navigateToDownloads(): boolean {
    const downloadsPage = (JC as typeof JC & {
        downloadsPage?: { showPage?: () => void };
    }).downloadsPage;
    if (typeof downloadsPage?.showPage !== 'function') return false;
    try {
        downloadsPage.showPage();
        return true;
    } catch {
        return false;
    }
}
