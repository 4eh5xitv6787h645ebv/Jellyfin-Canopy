// src/core/live-update.ts
//
// Smart cross-device page refresh. Open Canopy browser/WebView sessions track
// three independent server identities:
//   - the content-addressed Canopy client build (same-version updates included),
//   - the Jellyfin server process generation, and
//   - the live admin-configuration revision.
//
// Hidden clients do no network polling. visibility/focus/pageshow/resume cause
// an immediate catch-up check, which is the path used by mobile app WebViews.
// A reload is committed only after a final playback/edit/dialog safety check.

import { JC } from '../globals';
import {
    clientRefreshSafetyBlockReason,
    isClientForeground,
    jellyfinTopLevelRoute,
    onClientForegroundSignal,
    onRefreshSafetyChange,
    register,
} from './lifecycle';
import { LIVE, on } from './live';
import { onNavigate } from './navigation';
import type { IdentityContext } from '../types/jc';

const logPrefix = '🪼 Jellyfin Canopy: Smart Refresh:';
const RELOAD_BUDGET_KEY = 'jc-smart-refresh-budget-v1';
const RELOAD_BUDGET_WINDOW_MS = 60_000;
const RELOAD_BUDGET_LIMIT = 3;
const RELOAD_SURVIVAL_WATCHDOG_MS = 3_000;
const MIN_INTERACTION_SETTLE_MS = 1_000;

export type ClientRefreshMode = 'Smart' | 'HomeOnly' | 'Notify' | 'Disabled';
export type RefreshSource = 'canopy' | 'jellyfin' | 'config' | 'force';

export interface ClientRefreshPolicy {
    Mode: ClientRefreshMode;
    OnCanopyUpdate: boolean;
    OnJellyfinUpdate: boolean;
    OnConfigChange: boolean;
    ShowNotices: boolean;
    PollSeconds: number;
    IdleSeconds: number;
}

export interface ClientRefreshState {
    SchemaVersion: 1;
    ServerId: string;
    CanopyBuildId: string;
    JellyfinGeneration: string;
    ConfigurationRevision: number;
    ForceRevision: number;
    Policy: ClientRefreshPolicy;
}

const FAIL_CLOSED_POLICY: ClientRefreshPolicy = Object.freeze({
    Mode: 'Disabled',
    OnCanopyUpdate: false,
    OnJellyfinUpdate: false,
    OnConfigChange: false,
    ShowNotices: true,
    PollSeconds: 30,
    IdleSeconds: 5,
});

const pendingSources = new Set<RefreshSource>();
const loadedCanopyBuildId = JC.clientBuildId || '';
const handle = register('live-update');

let activeContext: IdentityContext | null = null;
let baseline: ClientRefreshState | null = null;
let baselineServerId: string | null = null;
let policy: ClientRefreshPolicy = FAIL_CLOSED_POLICY;
let checkController: AbortController | null = null;
let checkDrain: Promise<void> | null = null;
let checkRequested = false;
let pollTimer: number | null = null;
let decisionTimer: number | null = null;
let retryTimer: number | null = null;
let lastInteractionAt = Date.now();
let reloadCommitted = false;
let notice: HTMLElement | null = null;
let dismissedNoticeStateKey: string | null = null;
let listenersInstalled = false;
let foregroundStateFresh = false;
let reloadRecoveryTimer: number | null = null;
let conservativeFirstStateServerId: string | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalServerId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().replaceAll('-', '').toLowerCase();
    return normalized.length > 0 && normalized.length <= 256
        ? normalized
        : null;
}

export function refreshStateBelongsToServer(
    state: ClientRefreshState,
    serverId: unknown,
): boolean {
    const stateServerId = canonicalServerId(state.ServerId);
    const contextServerId = canonicalServerId(serverId);
    return stateServerId !== null
        && contextServerId !== null
        && stateServerId === contextServerId;
}

/**
 * Validate the no-cache state endpoint at the client trust boundary. Invalid
 * responses are ignored rather than accidentally turning an error body into a
 * reload loop.
 */
export function normalizeRefreshState(
    value: unknown,
    authenticatedSourceServerId?: unknown,
): ClientRefreshState | null {
    if (!isRecord(value) || value.SchemaVersion !== 1
        || typeof value.CanopyBuildId !== 'string'
        || !/^[a-f0-9]{64}$/.test(value.CanopyBuildId)
        || typeof value.JellyfinGeneration !== 'string'
        || !/^[a-f0-9]{64}$/.test(value.JellyfinGeneration)
        || !Number.isSafeInteger(value.ConfigurationRevision)
        || (value.ConfigurationRevision as number) < 0
        || !Number.isSafeInteger(value.ForceRevision)
        || (value.ForceRevision as number) < 0
        || !isRecord(value.Policy)) {
        return null;
    }

    // ServerId was added to the schema-1 contract after Smart Refresh shipped.
    // An authenticated poll may therefore receive an otherwise-valid legacy
    // response from a staggered-rollout server. Bind only a truly absent field
    // to the already-authenticated transport context; bootstrap remains strict,
    // and any present malformed/mismatched value is rejected.
    const responseServerId = canonicalServerId(value.ServerId);
    const sourceServerId = value.ServerId === undefined
        ? canonicalServerId(authenticatedSourceServerId)
        : null;
    const normalizedServerId = responseServerId ?? sourceServerId;
    if (normalizedServerId === null) return null;

    const policyValue = value.Policy;
    if (policyValue.Mode !== 'Smart'
        && policyValue.Mode !== 'HomeOnly'
        && policyValue.Mode !== 'Notify'
        && policyValue.Mode !== 'Disabled') {
        return null;
    }
    if (typeof policyValue.OnCanopyUpdate !== 'boolean'
        || typeof policyValue.OnJellyfinUpdate !== 'boolean'
        || typeof policyValue.OnConfigChange !== 'boolean'
        || (policyValue.ShowNotices !== undefined
            && typeof policyValue.ShowNotices !== 'boolean')
        || !Number.isSafeInteger(policyValue.PollSeconds)
        || (policyValue.PollSeconds as number) < 5
        || (policyValue.PollSeconds as number) > 3600
        || !Number.isSafeInteger(policyValue.IdleSeconds)
        || (policyValue.IdleSeconds as number) < 0
        || (policyValue.IdleSeconds as number) > 300) {
        return null;
    }

    return {
        SchemaVersion: 1,
        ServerId: responseServerId
            ? (value.ServerId as string).trim()
            : normalizedServerId,
        CanopyBuildId: value.CanopyBuildId,
        JellyfinGeneration: value.JellyfinGeneration,
        ConfigurationRevision: value.ConfigurationRevision as number,
        ForceRevision: value.ForceRevision as number,
        Policy: {
            Mode: policyValue.Mode,
            OnCanopyUpdate: policyValue.OnCanopyUpdate,
            OnJellyfinUpdate: policyValue.OnJellyfinUpdate,
            OnConfigChange: policyValue.OnConfigChange,
            // Additive schema-1 compatibility: pre-notice-control servers did
            // not send this field and retain the original visible behavior.
            ShowNotices: policyValue.ShowNotices === undefined
                ? true
                : policyValue.ShowNotices,
            PollSeconds: policyValue.PollSeconds as number,
            IdleSeconds: policyValue.IdleSeconds as number,
        },
    };
}

const bootstrapState = normalizeRefreshState(JC.clientRefreshBootstrap);
if (bootstrapState) {
    baseline = bootstrapState;
    baselineServerId = canonicalServerId(bootstrapState.ServerId);
    policy = bootstrapState.Policy;
}

function activeBootstrapForServer(serverId: unknown): ClientRefreshState | null {
    const candidate = normalizeRefreshState(JC.clientRefreshBootstrap);
    return candidate && refreshStateBelongsToServer(candidate, serverId)
        ? candidate
        : null;
}

/** Reject rollback within one process; a new generation is the reset boundary. */
export function isMonotonicRefreshTransition(
    previous: ClientRefreshState | null,
    next: ClientRefreshState,
): boolean {
    return !previous
        || next.JellyfinGeneration !== previous.JellyfinGeneration
        || (next.ConfigurationRevision >= previous.ConfigurationRevision
            && next.ForceRevision >= previous.ForceRevision);
}

/** Pure source comparison used by both runtime behavior and unit tests. */
export function detectRefreshSources(
    previous: ClientRefreshState | null,
    current: ClientRefreshState,
    loadedBuildId: string,
): ReadonlySet<RefreshSource> {
    const sources = new Set<RefreshSource>();
    if (loadedBuildId && current.CanopyBuildId !== loadedBuildId) sources.add('canopy');
    if (!previous) return sources;
    if (current.JellyfinGeneration !== previous.JellyfinGeneration) {
        sources.add('jellyfin');
        // ConfigurationRevision and ForceRevision are intentionally scoped to
        // one server process. Comparing them across generations would treat
        // their restart reset as a new config signal. A positive force revision
        // is different: it proves an administrator requested a refresh after
        // the new process started, so it must survive the restart boundary.
        if (current.ForceRevision > 0) sources.add('force');
        return sources;
    }
    if (current.ConfigurationRevision > previous.ConfigurationRevision) sources.add('config');
    if (current.ForceRevision > previous.ForceRevision) sources.add('force');
    return sources;
}

/** First valid state after a failed pre-runtime capture must prefer one safe extra refresh. */
export function detectConservativeFirstStateSources(
    current: ClientRefreshState,
    loadedBuildId: string,
): ReadonlySet<RefreshSource> {
    const sources = new Set(detectRefreshSources(null, current, loadedBuildId));
    // Capture failure also means the current Jellyfin process generation is
    // unknowable. Prefer one policy-filtered refresh when the endpoint later
    // becomes valid instead of silently adopting that generation.
    sources.add('jellyfin');
    if (current.ConfigurationRevision > 0) sources.add('config');
    if (current.ForceRevision > 0) sources.add('force');
    return sources;
}

export function isHomeRoute(href: string): boolean {
    return jellyfinTopLevelRoute(href) === 'home';
}

/**
 * Return a stable reason when a page reload would be unsafe. Paused media is
 * deliberately protected: "not currently advancing" is still an active
 * playback session whose position/queue must survive.
 */
export function refreshSafetyBlockReason(
    documentValue: Document = document,
    href: string = window.location.href,
    nativePaused?: boolean,
): string | null {
    return clientRefreshSafetyBlockReason(
        documentValue,
        href,
        nativePaused,
    );
}

export function mayCommitRefresh(
    mode: ClientRefreshMode,
    force: boolean,
    safe: boolean,
    home: boolean,
    idle: boolean,
): boolean {
    if (!safe || !idle) return false;
    if (force) return true;
    if (mode === 'Disabled' || mode === 'Notify') return false;
    return mode === 'Smart' || home;
}

export function nextReloadBudget(
    history: readonly number[],
    now: number,
): Readonly<{ allowed: boolean; history: readonly number[] }> {
    const live = history
        .filter((stamp) => Number.isFinite(stamp) && stamp >= now - RELOAD_BUDGET_WINDOW_MS && stamp <= now)
        .slice(-RELOAD_BUDGET_LIMIT);
    if (live.length >= RELOAD_BUDGET_LIMIT) {
        return { allowed: false, history: live };
    }
    return { allowed: true, history: [...live, now] };
}

function readReloadBudget(
    storage: typeof JC.storage.session,
): number[] | null {
    const result = storage.readJson<number[]>(
        'live-update',
        RELOAD_BUDGET_KEY,
        (value): value is number[] => Array.isArray(value)
            && value.length <= RELOAD_BUDGET_LIMIT
            && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry)),
        'reload-budget',
    );
    if (result.state === 'Valid') return result.value;
    if (result.state === 'Missing') return [];
    return null;
}

export function reserveReload(): boolean {
    const readable = [JC.storage.session, JC.storage.local]
        .map((storage) => ({ storage, history: readReloadBudget(storage) }))
        .filter((entry): entry is {
            storage: typeof JC.storage.session;
            history: number[];
        } => entry.history !== null);
    if (readable.length === 0) return false;

    // Both adapters normally contain the same reservation. De-duplicate exact
    // stamps so mirroring cannot consume the budget twice.
    const combined = [...new Set(readable.flatMap((entry) => entry.history))];
    const budget = nextReloadBudget(combined, Date.now());
    if (!budget.allowed) return false;
    const serialized = JSON.stringify(budget.history);
    let persisted = false;
    for (const { storage } of readable) {
        if (storage.write(
            'live-update',
            RELOAD_BUDGET_KEY,
            serialized,
            'reload-budget',
        ).state === 'Valid') {
            // Some embedded WebViews accept setItem without throwing but drop
            // the value. Only a read-after-write match proves this reload was
            // durably counted.
            const verified = readReloadBudget(storage);
            if (verified
                && verified.length === budget.history.length
                && verified.every((stamp, index) => stamp === budget.history[index])) {
                persisted = true;
            }
        }
    }
    return persisted;
}

function clearTimer(name: 'poll' | 'decision' | 'retry'): void {
    const value = name === 'poll' ? pollTimer : name === 'decision' ? decisionTimer : retryTimer;
    if (value !== null) window.clearTimeout(value);
    if (name === 'poll') pollTimer = null;
    else if (name === 'decision') decisionTimer = null;
    else retryTimer = null;
}

function removeNotice(): void {
    notice?.remove();
    notice = null;
}

function noticeStateKey(): string {
    return baseline
        ? JSON.stringify([
            canonicalServerId(baseline.ServerId),
            baseline.CanopyBuildId,
            baseline.JellyfinGeneration,
            baseline.ConfigurationRevision,
            baseline.ForceRevision,
        ])
        : 'no-refresh-state';
}

function pendingLabel(): string {
    const labels: string[] = [];
    if (pendingSources.has('canopy')) labels.push('Canopy updated');
    if (pendingSources.has('jellyfin')) labels.push('Jellyfin restarted or updated');
    if (pendingSources.has('config')) labels.push('server settings changed');
    if (pendingSources.has('force')) labels.push('an administrator requested a refresh');
    return labels.join(', ') || 'an update is ready';
}

function showNotice(detail?: string): void {
    if (!policy.ShowNotices) {
        removeNotice();
        return;
    }
    const stateKey = noticeStateKey();
    if (dismissedNoticeStateKey === stateKey) {
        removeNotice();
        return;
    }
    // A genuinely newer build/generation/revision is a new notice event. The
    // same unchanged Canopy mismatch is detected on every poll, so the full
    // state watermark—not DOM existence—owns dismissal.
    dismissedNoticeStateKey = null;
    if (!document.body) return;
    if (!notice?.isConnected) {
        const root = document.createElement('div');
        root.id = 'jc-client-refresh-notice';
        root.style.cssText = [
            'position:fixed',
            'left:max(16px,env(safe-area-inset-left))',
            'right:max(16px,env(safe-area-inset-right))',
            'bottom:max(16px,env(safe-area-inset-bottom))',
            'z-index:100000',
            'display:flex',
            'flex-wrap:wrap',
            'align-items:center',
            'justify-content:space-between',
            'gap:12px',
            'max-width:760px',
            'margin:auto',
            'padding:12px 14px',
            'border-radius:10px',
            'background:#202124',
            'color:#fff',
            'box-shadow:0 8px 28px rgba(0,0,0,.4)',
            'font:14px/1.4 system-ui,sans-serif',
        ].join(';');

        const message = document.createElement('span');
        message.dataset.role = 'message';
        message.setAttribute('role', 'status');
        message.setAttribute('aria-live', 'polite');
        message.setAttribute('aria-atomic', 'true');
        message.style.cssText = 'flex:1 1 260px';

        const actions = document.createElement('span');
        actions.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:8px';

        const reloadButton = document.createElement('button');
        reloadButton.type = 'button';
        reloadButton.dataset.role = 'reload';
        reloadButton.textContent = 'Reload when safe';
        reloadButton.style.cssText = 'min-height:44px;border:0;border-radius:6px;padding:8px 12px;background:#007ea8;color:#fff;font:inherit;font-weight:600;cursor:pointer;white-space:nowrap';
        reloadButton.addEventListener('click', () => {
            pendingSources.add('force');
            evaluatePending();
        });

        const dismissButton = document.createElement('button');
        dismissButton.type = 'button';
        dismissButton.dataset.role = 'dismiss';
        dismissButton.textContent = 'Dismiss';
        dismissButton.setAttribute('aria-label', 'Dismiss Smart Refresh notice');
        dismissButton.style.cssText = 'min-height:44px;border:1px solid rgba(255,255,255,.72);border-radius:6px;padding:8px 12px;background:transparent;color:#fff;font:inherit;font-weight:600;cursor:pointer;white-space:nowrap';
        dismissButton.addEventListener('click', () => {
            dismissedNoticeStateKey = noticeStateKey();
            removeNotice();
        });

        actions.append(reloadButton, dismissButton);
        root.append(message, actions);
        document.body.appendChild(root);
        notice = root;
    }

    const message = notice.querySelector<HTMLElement>('[data-role="message"]');
    const nextMessage = detail || `A fresh page is ready: ${pendingLabel()}.`;
    if (message && message.textContent !== nextMessage) {
        message.textContent = nextMessage;
    }
}

function scheduleRetry(delayMs: number): void {
    clearTimer('retry');
    retryTimer = window.setTimeout(() => {
        retryTimer = null;
        evaluatePending();
    }, Math.max(250, delayMs));
}

export function beginReloadAttempt(
    reload: () => void,
    onDocumentSurvived: () => void,
    watchdogMs = RELOAD_SURVIVAL_WATCHDOG_MS,
): number | null {
    try {
        reload();
    } catch {
        onDocumentSurvived();
        return null;
    }
    return window.setTimeout(onDocumentSurvived, watchdogMs);
}

function recoverFailedReload(): void {
    reloadRecoveryTimer = null;
    if (!reloadCommitted) return;
    reloadCommitted = false;
    if (activeContext
        && JC.identity.isCurrent(activeContext)
        && pendingSources.size > 0) {
        showNotice('Canopy could not complete the automatic reload. Reload this page manually when ready.');
    }
}

function commitReload(): void {
    if (reloadCommitted) return;
    // The final guard is intentionally repeated here, immediately before the
    // irreversible action. A play event can land while an idle timer is queued.
    const block = refreshSafetyBlockReason();
    if (block !== null) {
        if (block !== 'background') scheduleRetry(1000);
        return;
    }
    if (!reserveReload()) {
        showNotice('Canopy stopped an automatic reload loop. You can reload this page manually when ready.');
        scheduleRetry(RELOAD_BUDGET_WINDOW_MS);
        return;
    }

    reloadCommitted = true;
    if (reloadRecoveryTimer !== null) window.clearTimeout(reloadRecoveryTimer);
    reloadRecoveryTimer = beginReloadAttempt(
        () => window.location.reload(),
        recoverFailedReload,
    );
}

function evaluatePending(): void {
    if (typeof window === 'undefined') return;
    clearTimer('decision');
    if (!activeContext || !JC.identity.isCurrent(activeContext)) {
        removeNotice();
        return;
    }
    if (pendingSources.size === 0 || reloadCommitted) {
        if (pendingSources.size === 0) dismissedNoticeStateKey = null;
        removeNotice();
        return;
    }
    if (!foregroundStateFresh) {
        showNotice('A fresh page is ready. Canopy is checking the latest server refresh policy first.');
        return;
    }

    const force = pendingSources.has('force');
    if (!force && policy.Mode === 'Disabled') {
        pendingSources.clear();
        dismissedNoticeStateKey = null;
        removeNotice();
        return;
    }
    if (!force && policy.Mode === 'Notify') {
        showNotice();
        return;
    }

    const block = refreshSafetyBlockReason();
    if (block !== null) {
        if (block !== 'background') {
            showNotice(`A fresh page is ready and will wait until ${block.replaceAll('-', ' ')} is clear.`);
            scheduleRetry(1000);
        }
        return;
    }

    const home = isHomeRoute(window.location.href);
    if (!force && policy.Mode === 'HomeOnly' && !home) {
        showNotice('A fresh page is ready and will load when you return Home.');
        return;
    }

    // Even a legacy/admin policy of zero needs one task for the host's click
    // handler and a short dispatch window for Jellyfin-owned fire-and-forget
    // Favorite/Played mutations, which cannot acquire a Canopy transport hold.
    const idleMs = Math.max(
        policy.IdleSeconds * 1000,
        MIN_INTERACTION_SETTLE_MS,
    );
    const remaining = Math.max(0, lastInteractionAt + idleMs - Date.now());
    const allowed = mayCommitRefresh(policy.Mode, force, true, home, remaining === 0);
    if (!allowed) {
        decisionTimer = window.setTimeout(() => {
            decisionTimer = null;
            evaluatePending();
        }, Math.max(50, remaining));
        return;
    }

    commitReload();
}

function queueSources(sources: ReadonlySet<RefreshSource>): void {
    for (const source of sources) {
        if (source === 'force') {
            pendingSources.add(source);
        } else if (isSourceEnabled(source)) {
            pendingSources.add(source);
        }
    }
}

function isSourceEnabled(source: RefreshSource): boolean {
    return source === 'force'
        || (policy.Mode !== 'Disabled'
            && (source !== 'canopy' || policy.OnCanopyUpdate)
            && (source !== 'jellyfin' || policy.OnJellyfinUpdate)
            && (source !== 'config' || policy.OnConfigChange));
}

function reconcilePendingSources(): void {
    for (const source of pendingSources) {
        if (!isSourceEnabled(source)) pendingSources.delete(source);
    }
}

function schedulePoll(context: IdentityContext): void {
    if (typeof window === 'undefined') return;
    clearTimer('poll');
    if (!JC.identity.isCurrent(context) || !isClientForeground()) return;
    pollTimer = window.setTimeout(() => {
        pollTimer = null;
        if (isClientForeground()) void requestStateCheck(context);
    }, policy.PollSeconds * 1000);
}

async function performStateCheck(context: IdentityContext): Promise<boolean> {
    const api = JC.core.api;
    if (!JC.identity.isCurrent(context) || !api || !isClientForeground()) return false;

    const controller = new AbortController();
    checkController = controller;
    try {
        const raw = await api.plugin(
            `/client-refresh-state?_jc=${Date.now()}`,
            {
                signal: controller.signal,
                skipCache: true,
                skipRetry: true,
                timeoutMs: 10_000,
            },
        );
        if (!JC.identity.isCurrent(context) || !isClientForeground()) return false;
        const next = normalizeRefreshState(raw, context.serverId);
        if (!next
            || !JC.identity.isCurrent(context)
            || !refreshStateBelongsToServer(next, context.serverId)) {
            return false;
        }

        const previous = baseline;
        const contextServerId = canonicalServerId(context.serverId);
        const conservativeFirstState = previous === null
            && contextServerId !== null
            && conservativeFirstStateServerId === contextServerId;
        if (!isMonotonicRefreshTransition(previous, next)) {
            console.debug(`${logPrefix} ignored a non-monotonic same-generation state response`);
            return false;
        }

        // Apply state and policy atomically before reconciling old intent or
        // admitting newly-detected sources.
        baseline = next;
        policy = next.Policy;
        reconcilePendingSources();
        if (next.CanopyBuildId === loadedCanopyBuildId) {
            pendingSources.delete('canopy');
        }
        queueSources(conservativeFirstState
            ? detectConservativeFirstStateSources(next, loadedCanopyBuildId)
            : detectRefreshSources(previous, next, loadedCanopyBuildId));
        if (conservativeFirstState) {
            conservativeFirstStateServerId = null;
            JC.clientRefreshBootstrapUnavailableServerId = '';
        }
        return true;
    } catch (error) {
        if (!controller.signal.aborted && JC.identity.isCurrent(context)) {
            console.debug(`${logPrefix} state check failed:`, error);
        }
        return false;
    } finally {
        if (checkController === controller) checkController = null;
    }
}

/**
 * Coalesce state requests into one active fetch plus one requested rerun. The
 * resulting policy barrier covers the complete drain, so no foreground event
 * can evaluate pending intent between an old and a newly-requested response.
 */
function requestStateCheck(context: IdentityContext): Promise<void> {
    if (!JC.identity.isCurrent(context) || !isClientForeground()) {
        return Promise.resolve();
    }
    checkRequested = true;
    foregroundStateFresh = false;
    if (checkDrain) return checkDrain;

    const drain = (async () => {
        let finalResponseApplied = false;
        while (checkRequested
            && JC.identity.isCurrent(context)
            && isClientForeground()) {
            checkRequested = false;
            finalResponseApplied = await performStateCheck(context);
        }
        if (JC.identity.isCurrent(context) && isClientForeground()) {
            foregroundStateFresh = finalResponseApplied;
            if (finalResponseApplied) evaluatePending();
        }
    })().finally(() => {
        if (checkDrain !== drain) return;
        checkDrain = null;
        schedulePoll(context);
    });
    checkDrain = drain;
    return drain;
}

function markInteraction(): void {
    lastInteractionAt = Date.now();
    if (pendingSources.size > 0) {
        // Capture-phase interaction runs before the target handler can begin a
        // write, open a modal, or start playback. Let that handler establish its
        // safety owner before reconsidering a zero-idle refresh.
        clearTimer('decision');
        decisionTimer = window.setTimeout(() => {
            decisionTimer = null;
            evaluatePending();
        }, 0);
    }
}

function checkOnForeground(): void {
    const context = activeContext;
    if (!context || !isClientForeground()) return;
    void requestStateCheck(context);
}

function suspendBackgroundWork(): void {
    foregroundStateFresh = false;
    checkRequested = false;
    checkController?.abort();
    clearTimer('poll');
    clearTimer('decision');
    clearTimer('retry');
}

function handleSafetyChange(): void {
    if (!isClientForeground()) {
        suspendBackgroundWork();
    }
    if (pendingSources.size > 0) evaluatePending();
}

function installListeners(): void {
    if (listenersInstalled) return;
    listenersInstalled = true;
    for (const type of ['pointerdown', 'keydown', 'input', 'change', 'click'] as const) {
        handle.addListener(document, type, markInteraction, {
            capture: true,
            passive: type === 'pointerdown' || type === 'click',
        });
    }
    for (const type of ['pointermove', 'wheel', 'touchstart', 'touchmove'] as const) {
        handle.addListener(document, type, markInteraction, { capture: true, passive: true });
    }
    // scroll does not bubble, so capture it from nested Jellyfin scrollers.
    handle.addListener(document, 'scroll', markInteraction, { capture: true, passive: true });
    for (const type of ['play', 'pause', 'ended', 'emptied'] as const) {
        handle.addListener(document, type, markInteraction, { capture: true, passive: true });
    }
}

function stop(): void {
    activeContext = null;
    foregroundStateFresh = false;
    reloadCommitted = false;
    dismissedNoticeStateKey = null;
    if (reloadRecoveryTimer !== null) window.clearTimeout(reloadRecoveryTimer);
    reloadRecoveryTimer = null;
    checkController?.abort();
    checkController = null;
    checkDrain = null;
    checkRequested = false;
    clearTimer('poll');
    clearTimer('decision');
    clearTimer('retry');
    removeNotice();
    handle.teardown();
    listenersInstalled = false;
}

function start(context: IdentityContext): void {
    if (!JC.identity.isCurrent(context)) return;
    stop();
    const nextServerId = canonicalServerId(context.serverId);
    const activeBootstrap = activeBootstrapForServer(context.serverId);
    const captureUnavailable = nextServerId !== null
        && canonicalServerId(JC.clientRefreshBootstrapUnavailableServerId) === nextServerId;
    if (baselineServerId && baselineServerId !== nextServerId) {
        pendingSources.clear();
        // The classic loader captures this active server's authenticated state
        // before it reads owner configuration. Adopt that load-coupled watermark
        // on a remote switch so the first runtime poll can detect every edge
        // that occurred while the new epoch initialized.
        baseline = activeBootstrap;
        policy = activeBootstrap?.Policy ?? FAIL_CLOSED_POLICY;
    } else if (!baseline && activeBootstrap) {
        baseline = activeBootstrap;
        policy = activeBootstrap.Policy;
    }
    conservativeFirstStateServerId = !baseline && captureUnavailable
        ? nextServerId
        : null;
    baselineServerId = nextServerId;
    activeContext = context;
    lastInteractionAt = Date.now();
    installListeners();
    if (isClientForeground()) void requestStateCheck(context);
}

onNavigate(() => {
    if (pendingSources.size > 0) evaluatePending();
});
on(LIVE.CONFIG_CHANGED, () => {
    const context = activeContext;
    if (context && isClientForeground()) void requestStateCheck(context);
});
onClientForegroundSignal(checkOnForeground);
onRefreshSafetyChange(handleSafetyChange);

handle.onTeardown(() => {
    listenersInstalled = false;
});
JC.identity.registerReset('core-live-update', stop);
JC.identity.registerActivate('core-live-update', start);

const initialIdentity = JC.identity.capture();
if (initialIdentity) start(initialIdentity);

console.log(`${logPrefix} initialized`);
