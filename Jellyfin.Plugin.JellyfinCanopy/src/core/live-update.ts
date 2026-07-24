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
import { register } from './lifecycle';
import { LIVE, on } from './live';
import { onNavigate } from './navigation';
import type { IdentityContext } from '../types/jc';

const logPrefix = '🪼 Jellyfin Canopy: Smart Refresh:';
const RELOAD_BUDGET_KEY = 'jc-smart-refresh-budget-v1';
const RELOAD_BUDGET_WINDOW_MS = 60_000;
const RELOAD_BUDGET_LIMIT = 3;

export type ClientRefreshMode = 'Smart' | 'HomeOnly' | 'Notify' | 'Disabled';
export type RefreshSource = 'canopy' | 'jellyfin' | 'config' | 'force';

export interface ClientRefreshPolicy {
    Mode: ClientRefreshMode;
    OnCanopyUpdate: boolean;
    OnJellyfinUpdate: boolean;
    OnConfigChange: boolean;
    PollSeconds: number;
    IdleSeconds: number;
}

export interface ClientRefreshState {
    SchemaVersion: 1;
    CanopyBuildId: string;
    JellyfinGeneration: string;
    ConfigurationRevision: number;
    ForceRevision: number;
    Policy: ClientRefreshPolicy;
}

const DEFAULT_POLICY: ClientRefreshPolicy = Object.freeze({
    Mode: 'Smart',
    OnCanopyUpdate: true,
    OnJellyfinUpdate: true,
    OnConfigChange: true,
    PollSeconds: 30,
    IdleSeconds: 5,
});

const pendingSources = new Set<RefreshSource>();
const loadedCanopyBuildId = JC.clientBuildId || '';
const handle = register('live-update');

let activeContext: IdentityContext | null = null;
let baseline: ClientRefreshState | null = null;
let policy: ClientRefreshPolicy = DEFAULT_POLICY;
let checkController: AbortController | null = null;
let checkFlight: Promise<void> | null = null;
let checkAgain = false;
let pollTimer: number | null = null;
let decisionTimer: number | null = null;
let retryTimer: number | null = null;
let lastInteractionAt = Date.now();
let reloadCommitted = false;
let notice: HTMLElement | null = null;
let listenersInstalled = false;
// Android's Jellyfin WebView keeps document.visibilityState="visible" after
// the Activity is backgrounded. Cordova's pause/resume events are the
// authoritative lifecycle signal there.
let nativeAppPaused = false;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clampInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
    const parsed = typeof value === 'number' && Number.isFinite(value)
        ? Math.trunc(value)
        : fallback;
    return Math.min(maximum, Math.max(minimum, parsed));
}

function normalizeMode(value: unknown): ClientRefreshMode {
    return value === 'Smart' || value === 'HomeOnly'
        || value === 'Notify' || value === 'Disabled'
        ? value
        : 'Smart';
}

/**
 * Validate the no-cache state endpoint at the client trust boundary. Invalid
 * responses are ignored rather than accidentally turning an error body into a
 * reload loop.
 */
export function normalizeRefreshState(value: unknown): ClientRefreshState | null {
    if (!isRecord(value) || value.SchemaVersion !== 1
        || typeof value.CanopyBuildId !== 'string'
        || !/^[a-f0-9]{64}$/.test(value.CanopyBuildId)
        || typeof value.JellyfinGeneration !== 'string'
        || !/^[a-f0-9]{64}$/.test(value.JellyfinGeneration)
        || !Number.isSafeInteger(value.ConfigurationRevision)
        || !Number.isSafeInteger(value.ForceRevision)
        || !isRecord(value.Policy)) {
        return null;
    }

    return {
        SchemaVersion: 1,
        CanopyBuildId: value.CanopyBuildId,
        JellyfinGeneration: value.JellyfinGeneration,
        ConfigurationRevision: value.ConfigurationRevision as number,
        ForceRevision: value.ForceRevision as number,
        Policy: {
            Mode: normalizeMode(value.Policy.Mode),
            OnCanopyUpdate: value.Policy.OnCanopyUpdate !== false,
            OnJellyfinUpdate: value.Policy.OnJellyfinUpdate !== false,
            OnConfigChange: value.Policy.OnConfigChange !== false,
            PollSeconds: clampInteger(value.Policy.PollSeconds, 30, 5, 3600),
            IdleSeconds: clampInteger(value.Policy.IdleSeconds, 5, 0, 300),
        },
    };
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
        // their restart reset as a new config/force signal.
        return sources;
    }
    if (current.ConfigurationRevision !== previous.ConfigurationRevision) sources.add('config');
    if (current.ForceRevision !== previous.ForceRevision) sources.add('force');
    return sources;
}

export function isHomeRoute(href: string): boolean {
    const route = href.toLowerCase();
    return /#\/home(?:\.html)?(?:[/?#]|$)/.test(route)
        || /(?:^|\/)home(?:[?#]|$)/.test(route);
}

function isEditingRoute(href: string): boolean {
    const route = href.toLowerCase();
    return /(?:#\/|\/)(?:dashboard|configurationpage|metadata|edititemmetadata|mypreferences(?:menu|home)?|settings|profile)(?:\.html)?(?:[/?#]|$)/
        .test(route);
}

function hasLoadedMedia(element: HTMLMediaElement): boolean {
    const source = element.currentSrc
        || element.getAttribute('src')
        || element.querySelector('source[src]')?.getAttribute('src')
        || '';
    return Boolean(source) && !element.ended
        && (!element.paused || element.currentTime > 0)
        && (element.readyState > HTMLMediaElement.HAVE_NOTHING || element.currentTime > 0);
}

/**
 * Return a stable reason when a page reload would be unsafe. Paused media is
 * deliberately protected: "not currently advancing" is still an active
 * playback session whose position/queue must survive.
 */
export function refreshSafetyBlockReason(
    documentValue: Document = document,
    href: string = window.location.href,
    nativePaused: boolean = nativeAppPaused,
): string | null {
    if (nativePaused || documentValue.visibilityState === 'hidden') return 'background';
    if (isEditingRoute(href)) return 'editing-route';
    if (/(?:#\/|\/)video(?:[/?#]|$)/i.test(href)) return 'playback-route';
    if (documentValue.fullscreenElement || documentValue.pictureInPictureElement) return 'fullscreen-media';
    const dialogs = documentValue.querySelectorAll<HTMLElement>(
        '.dialog.opened, .actionSheet.opened, [role="dialog"], [aria-modal="true"]',
    );
    if ([...dialogs].some((element) =>
        !element.closest('[aria-hidden="true"], [hidden]'))) {
        return 'dialog';
    }

    const mediaSessionState = navigator.mediaSession?.playbackState;
    if (mediaSessionState === 'playing' || mediaSessionState === 'paused') return 'media-session';
    if ([...documentValue.querySelectorAll<HTMLMediaElement>('video, audio')].some(hasLoadedMedia)) {
        return 'media-element';
    }

    const active = documentValue.activeElement;
    if (active instanceof HTMLElement
        && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))) {
        return 'active-editor';
    }
    return null;
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

function readReloadBudget(): number[] {
    const result = JC.storage.session.readJson<number[]>(
        'live-update',
        RELOAD_BUDGET_KEY,
        (value): value is number[] => Array.isArray(value)
            && value.length <= RELOAD_BUDGET_LIMIT
            && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry)),
        'reload-budget',
    );
    return result.state === 'Valid' ? result.value : [];
}

function reserveReload(): boolean {
    const budget = nextReloadBudget(readReloadBudget(), Date.now());
    if (!budget.allowed) return false;
    return JC.storage.session.write(
        'live-update',
        RELOAD_BUDGET_KEY,
        JSON.stringify(budget.history),
        'reload-budget',
    ).state === 'Valid';
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

function pendingLabel(): string {
    const labels: string[] = [];
    if (pendingSources.has('canopy')) labels.push('Canopy updated');
    if (pendingSources.has('jellyfin')) labels.push('Jellyfin restarted or updated');
    if (pendingSources.has('config')) labels.push('server settings changed');
    if (pendingSources.has('force')) labels.push('an administrator requested a refresh');
    return labels.join(', ') || 'an update is ready';
}

function showNotice(detail?: string): void {
    if (!document.body) return;
    if (!notice?.isConnected) {
        const root = document.createElement('div');
        root.id = 'jc-client-refresh-notice';
        root.setAttribute('role', 'status');
        root.setAttribute('aria-live', 'polite');
        root.style.cssText = [
            'position:fixed',
            'left:max(16px,env(safe-area-inset-left))',
            'right:max(16px,env(safe-area-inset-right))',
            'bottom:max(16px,env(safe-area-inset-bottom))',
            'z-index:100000',
            'display:flex',
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
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Reload when safe';
        button.style.cssText = 'border:0;border-radius:6px;padding:8px 12px;background:#00a4dc;color:#fff;font:inherit;font-weight:600;cursor:pointer;white-space:nowrap';
        button.addEventListener('click', () => {
            pendingSources.add('force');
            evaluatePending();
        });
        root.append(message, button);
        document.body.appendChild(root);
        notice = root;
    }

    const message = notice.querySelector<HTMLElement>('[data-role="message"]');
    if (message) {
        message.textContent = detail || `A fresh page is ready: ${pendingLabel()}.`;
    }
}

function scheduleRetry(delayMs: number): void {
    clearTimer('retry');
    retryTimer = window.setTimeout(() => {
        retryTimer = null;
        evaluatePending();
    }, Math.max(250, delayMs));
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
    window.location.reload();
}

function evaluatePending(): void {
    if (typeof window === 'undefined') return;
    clearTimer('decision');
    if (pendingSources.size === 0 || reloadCommitted) {
        removeNotice();
        return;
    }

    const force = pendingSources.has('force');
    if (!force && policy.Mode === 'Disabled') {
        pendingSources.clear();
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

    const idleMs = policy.IdleSeconds * 1000;
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
    evaluatePending();
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
        if (isClientForeground()) void checkNow(context);
    }, policy.PollSeconds * 1000);
}

async function checkNow(context: IdentityContext): Promise<void> {
    const api = JC.core.api;
    if (!JC.identity.isCurrent(context) || !api || !isClientForeground()) return;
    if (checkFlight) {
        checkAgain = true;
        return checkFlight;
    }

    const controller = new AbortController();
    checkController = controller;
    const flight = (async () => {
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
            if (!JC.identity.isCurrent(context)) return;
            const next = normalizeRefreshState(raw);
            if (!next || !JC.identity.isCurrent(context)) return;

            const previous = baseline;
            baseline = next;
            policy = next.Policy;
            reconcilePendingSources();
            queueSources(detectRefreshSources(previous, next, loadedCanopyBuildId));
        } catch (error) {
            if (!controller.signal.aborted && JC.identity.isCurrent(context)) {
                console.debug(`${logPrefix} state check failed:`, error);
            }
        } finally {
            if (checkController === controller) {
                checkController = null;
                checkFlight = null;
            }
            if (checkAgain && JC.identity.isCurrent(context)) {
                checkAgain = false;
                void checkNow(context);
            } else {
                schedulePoll(context);
            }
        }
    })();
    checkFlight = flight;
    return flight;
}

function markInteraction(): void {
    lastInteractionAt = Date.now();
    if (pendingSources.size > 0) evaluatePending();
}

function isClientForeground(): boolean {
    return !nativeAppPaused && document.visibilityState !== 'hidden';
}

function checkOnForeground(): void {
    const context = activeContext;
    if (!context || !isClientForeground()) return;
    void checkNow(context);
    if (pendingSources.size > 0) evaluatePending();
}

function suspendBackgroundWork(): void {
    checkController?.abort();
    clearTimer('poll');
    clearTimer('decision');
    clearTimer('retry');
}

function onVisibilityChange(): void {
    if (document.visibilityState === 'hidden') {
        suspendBackgroundWork();
        return;
    }
    checkOnForeground();
}

function onNativePause(): void {
    nativeAppPaused = true;
    suspendBackgroundWork();
    if (pendingSources.size > 0) evaluatePending();
}

function onNativeResume(): void {
    nativeAppPaused = false;
    checkOnForeground();
}

function installListeners(): void {
    if (listenersInstalled) return;
    listenersInstalled = true;
    for (const type of ['pointerdown', 'keydown', 'input', 'change'] as const) {
        handle.addListener(document, type, markInteraction, { capture: true, passive: type === 'pointerdown' });
    }
    for (const type of ['play', 'pause', 'ended', 'emptied'] as const) {
        handle.addListener(document, type, evaluatePending, true);
    }
    handle.addListener(document, 'visibilitychange', onVisibilityChange);
    handle.addListener(document, 'pause', onNativePause);
    handle.addListener(document, 'resume', onNativeResume);
    handle.addListener(window, 'focus', checkOnForeground);
    handle.addListener(window, 'online', checkOnForeground);
    handle.addListener(window, 'pageshow', checkOnForeground);
}

function stop(): void {
    activeContext = null;
    baseline = null;
    pendingSources.clear();
    policy = DEFAULT_POLICY;
    reloadCommitted = false;
    nativeAppPaused = false;
    checkController?.abort();
    checkController = null;
    checkFlight = null;
    checkAgain = false;
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
    activeContext = context;
    lastInteractionAt = Date.now();
    installListeners();
    if (isClientForeground()) void checkNow(context);
}

onNavigate(() => {
    if (pendingSources.size > 0) evaluatePending();
});
on(LIVE.CONFIG_CHANGED, () => {
    const context = activeContext;
    if (context && isClientForeground()) void checkNow(context);
});

handle.onTeardown(() => {
    listenersInstalled = false;
});
JC.identity.registerReset('core-live-update', stop);
JC.identity.registerActivate('core-live-update', start);

const initialIdentity = JC.identity.capture();
if (initialIdentity) start(initialIdentity);

console.log(`${logPrefix} initialized`);
