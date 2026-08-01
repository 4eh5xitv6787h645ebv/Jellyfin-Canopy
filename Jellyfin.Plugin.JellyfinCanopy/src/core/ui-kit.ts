// src/core/ui-kit.ts
//
// Small shared UI primitives: THE escapeHtml (previously defined 3+ times),
// the toast notification (moved from enhanced/ui.js), and dedupe-by-id CSS
// injection (previously helpers.addCSS).
//
// Public surface: JC.core.ui { escapeHtml, toast, injectCss, removeCss }.
// Aliases kept: JC.escapeHtml, JC.toast, JC.helpers.addCSS/removeCSS/escHtml.

import { JC } from '../globals';
import { assetUrl } from './asset-urls';
import { onNavigate } from './navigation';
import type {
    ActionableNotificationOptions,
    ExpandInOptions,
    MuiIconButtonOptions,
    MuiMenuItemOptions,
    NotificationDismissReason,
    NotificationHandle,
    NotificationOptions,
    NotificationSeverity,
    SectionContainerOptions,
    UiApi
} from '../types/jc';

JC.core = JC.core || {};

const NOTIFICATION_OWNER_ID = 'jc-notification-owner';
const NOTIFICATION_CSS_ID = 'jc-notification-css';
const NOTIFICATION_RUNTIME_OWNER = Symbol.for('JellyfinCanopy.notificationRuntime.v1');
const ANNOUNCEMENT_DWELL_MS = 500;
const ANNOUNCEMENT_GAP_MS = 50;
/** Completed actions remain readable for this full interval before dismissal. */
const ACTION_COMPLETION_DWELL_MS = 3000;
/** Visible cards are bounded independently from the assistive announcement queue. */
const MAX_ACTIVE_NOTIFICATIONS = 32;
/** Primary producers cannot consume the space reserved for action outcomes. */
const MAX_PRIMARY_ANNOUNCEMENTS = 32;
const MAX_PENDING_ANNOUNCEMENTS = 96;

interface Announcement {
    readonly message: string;
    readonly urgency: 'polite' | 'assertive';
    readonly dedupeKey: string | null;
    readonly admission: 'primary' | 'terminal';
    // Optional for compatibility with events retained by the v1 document owner
    // across a content-hashed module upgrade from the pre-callback shape.
    presentedCallbacks?: Array<() => void>;
}

interface AnnouncementTicket {
    readonly state: 'queued' | 'coalesced';
    /** Cancel only while the owned event is still pending. */
    cancel(): boolean;
}

interface NotificationRecord {
    readonly id: string;
    readonly element: HTMLElement;
    readonly identity: ReturnType<typeof JC.identity.capture>;
    readonly generation: number;
    readonly onDismiss?: (reason: NotificationDismissReason) => void;
    returnFocus: HTMLElement | null;
    remaining: number;
    startedAt: number;
    showTimer: number | null;
    expiryTimer: number | null;
    completionTimer: number | null;
    removalTimer: number | null;
    cancelPendingActionAnnouncement: (() => void) | null;
    pointerInside: boolean;
    focusInside: boolean;
    persistent: boolean;
    disposed: boolean;
    actionInvoked: boolean;
}

interface NotificationRuntime {
    readonly version: 1;
    readonly announcements: Announcement[];
    readonly notifications: Set<NotificationRecord>;
    sequence: number;
    generation: number;
    announcementTimer: number | null;
    announcementActive: boolean;
    announcementInGap: boolean;
    activeAnnouncementKey: string | null;
    activeAnnouncementAdmission: Announcement['admission'] | null;
    lifecycleInstalled: boolean;
    ownerInstallPending: boolean;
    drainDelegate: () => void;
    resetDelegate: (reason: 'navigation' | 'identity') => void;
}

function isNotificationRuntime(value: unknown): value is NotificationRuntime {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<NotificationRuntime>;
    return candidate.version === 1
        && Array.isArray(candidate.announcements)
        && candidate.notifications instanceof Set
        && typeof candidate.sequence === 'number'
        && typeof candidate.generation === 'number'
        && typeof candidate.resetDelegate === 'function';
}

const publishedNotificationRuntime = Reflect.get(window, NOTIFICATION_RUNTIME_OWNER) as unknown;
if (publishedNotificationRuntime !== undefined && !isNotificationRuntime(publishedNotificationRuntime)) {
    throw new TypeError('Jellyfin Canopy notification runtime has conflicting document ownership');
}

/**
 * One document-owned state machine survives content-hashed module retries.
 * Each evaluated graph delegates through this same state instead of retaining
 * duplicate queues, route callbacks, timers, or focus-owning cards.
 */
const notificationRuntime: NotificationRuntime = isNotificationRuntime(publishedNotificationRuntime)
    ? publishedNotificationRuntime
    : {
        version: 1,
        announcements: [],
        notifications: new Set<NotificationRecord>(),
        sequence: 0,
        generation: 0,
        announcementTimer: null,
        announcementActive: false,
        announcementInGap: false,
        activeAnnouncementKey: null,
        activeAnnouncementAdmission: null,
        lifecycleInstalled: false,
        ownerInstallPending: false,
        drainDelegate: () => undefined,
        resetDelegate: () => undefined,
    };

if (publishedNotificationRuntime === undefined
    && !Reflect.set(window, NOTIFICATION_RUNTIME_OWNER, notificationRuntime)) {
    throw new TypeError('Jellyfin Canopy could not publish the document notification runtime');
}

/** Explicit synchronous backpressure when either bounded notification resource is full. */
export class NotificationBackpressureError extends Error {
    constructor(resource: 'notifications' | 'announcements' = 'announcements') {
        const capacity = resource === 'notifications'
            ? String(MAX_ACTIVE_NOTIFICATIONS)
            : `${MAX_PRIMARY_ANNOUNCEMENTS} primary / ${MAX_PENDING_ANNOUNCEMENTS} total`;
        super(`Notification ${resource} backpressure: capacity ${capacity} is full`);
        this.name = 'NotificationBackpressureError';
    }
}

/**
 * Escapes HTML special characters to prevent XSS when interpolating into
 * HTML strings (innerHTML sinks, template literals, JC.toast, ...).
 * Non-string values are stringified first (null/undefined become '').
 * @param str - The value to escape.
 * @returns The escaped string safe for HTML interpolation.
 */
export function escapeHtml(str: unknown): string {
    // Frozen behavior: non-strings coerce via String() — objects intentionally
    // become '[object Object]' rather than throwing, exactly as pre-TS.
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    const s = typeof str === 'string' ? str : String(str ?? '');
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Add custom CSS to the page, deduped by id. Injecting the same id again
 * replaces the previous style element.
 * @param id - Unique ID for the style element
 * @param css - The CSS content
 */
export function injectCss(id: string, css: string): void {
    // Remove existing style with same ID
    const existing = document.getElementById(id);
    if (existing) {
        existing.remove();
    }

    const style = document.createElement('style');
    style.id = id;
    style.textContent = css;
    document.head.appendChild(style);

    console.log(`🪼 Jellyfin Canopy: Added CSS: ${id}`);
}

/**
 * Injects the ONE shared 'Material Symbols Rounded' @font-face for every
 * feature that renders those icons (media-info chips, release dates, people
 * tags, user-review tags, reviews, calendar). Replaces the six per-feature
 * duplicates of the same @font-face — call this next to each feature's own
 * style injection instead of re-declaring it.
 *
 * PERF(R6): no remote assets — the woff2 is served from the local asset cache
 * (same font-display: block as before, but same-origin = fast + private).
 */
export function ensureMaterialSymbolsFont(): void {
    const id = 'jc-material-symbols-rounded';
    if (document.getElementById(id)) return;
    injectCss(id, `
        @font-face {
            font-family: 'Material Symbols Rounded';
            font-style: normal;
            font-weight: 100 700;
            font-display: block;
            src: url(${assetUrl('fonts/material-symbols-rounded.woff2')}) format('woff2');
        }
    `);
}

/**
 * Remove injected CSS by ID.
 * @param id - The style element ID
 * @returns True if removed
 */
export function removeCss(id: string): boolean {
    const existing = document.getElementById(id);
    if (existing) {
        existing.remove();
        console.log(`🪼 Jellyfin Canopy: Removed CSS: ${id}`);
        return true;
    }
    return false;
}

function prefersReducedMotion(): boolean {
    return typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function ensureNotificationCss(): void {
    if (document.getElementById(NOTIFICATION_CSS_ID)) return;
    injectCss(NOTIFICATION_CSS_ID, `
        #${NOTIFICATION_OWNER_ID} .jc-notification-stack {
            position: fixed;
            right: 20px;
            bottom: 20px;
            z-index: 99999;
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            gap: 10px;
            max-height: calc(100vh - 40px);
            overflow-y: auto;
            pointer-events: none;
        }
        #${NOTIFICATION_OWNER_ID} .jc-notification {
            overflow-wrap: anywhere;
            pointer-events: auto;
        }
        #${NOTIFICATION_OWNER_ID} .jc-notification-action-status[hidden] { display: none !important; }
        #${NOTIFICATION_OWNER_ID} .jc-notification-action:hover { filter: brightness(1.3); }
        #${NOTIFICATION_OWNER_ID} .jc-notification-live {
            position: absolute !important;
            width: 1px !important;
            height: 1px !important;
            padding: 0 !important;
            margin: -1px !important;
            overflow: hidden !important;
            clip: rect(0, 0, 0, 0) !important;
            white-space: nowrap !important;
            border: 0 !important;
        }
        @media (prefers-reduced-motion: reduce) {
            #${NOTIFICATION_OWNER_ID} .jc-notification,
            #${NOTIFICATION_OWNER_ID} .jc-notification * {
                transition: none !important;
                animation: none !important;
            }
        }
    `);
}

function ensureNotificationOwner(): HTMLElement {
    ensureNotificationCss();
    const duplicates = Array.from(document.querySelectorAll<HTMLElement>(`#${NOTIFICATION_OWNER_ID}`));
    let owner = duplicates.find((candidate) => Array.from(notificationRuntime.notifications)
        .some((record) => candidate.contains(record.element)))
        || duplicates.shift()
        || null;
    if (!owner) {
        owner = document.createElement('div');
        owner.id = NOTIFICATION_OWNER_ID;
    }
    owner.dataset.jcNotificationOwner = 'v1';
    if (!owner.isConnected) {
        const parent = document.body || document.documentElement;
        parent.appendChild(owner);
    }

    const politeDuplicates = Array.from(owner.querySelectorAll<HTMLElement>('[data-jc-announcer="polite"]'));
    const polite = politeDuplicates.shift() || null;
    politeDuplicates.forEach((node) => node.remove());
    if (!polite) {
        const polite = document.createElement('div');
        polite.className = 'jc-notification-live';
        polite.dataset.jcAnnouncer = 'polite';
        polite.setAttribute('aria-live', 'polite');
        polite.setAttribute('aria-atomic', 'true');
        polite.setAttribute('aria-relevant', 'additions text');
        owner.appendChild(polite);
    }

    const assertiveDuplicates = Array.from(owner.querySelectorAll<HTMLElement>('[data-jc-announcer="assertive"]'));
    const assertive = assertiveDuplicates.shift() || null;
    assertiveDuplicates.forEach((node) => node.remove());
    if (!assertive) {
        const assertive = document.createElement('div');
        assertive.className = 'jc-notification-live';
        assertive.dataset.jcAnnouncer = 'assertive';
        assertive.setAttribute('aria-live', 'assertive');
        assertive.setAttribute('aria-atomic', 'true');
        assertive.setAttribute('aria-relevant', 'additions text');
        owner.appendChild(assertive);
    }

    const stackDuplicates = Array.from(owner.querySelectorAll<HTMLElement>(':scope > .jc-notification-stack'));
    let stack = stackDuplicates.shift() || null;
    if (!stack) {
        const stack = document.createElement('div');
        stack.className = 'jc-notification-stack';
        stack.setAttribute('aria-live', 'off');
        owner.appendChild(stack);
    }
    stack = owner.querySelector<HTMLElement>(':scope > .jc-notification-stack')!;
    for (const duplicateStack of stackDuplicates) {
        duplicateStack.querySelectorAll<HTMLElement>(':scope > .jc-notification')
            .forEach((card) => stack.appendChild(card));
        duplicateStack.remove();
    }

    for (const duplicateOwner of duplicates) {
        if (duplicateOwner === owner) continue;
        duplicateOwner.querySelectorAll<HTMLElement>('.jc-notification')
            .forEach((card) => stack.appendChild(card));
        duplicateOwner.remove();
    }
    return owner;
}

function presentationCallbacksFor(announcement: Announcement): Array<() => void> {
    if (!Array.isArray(announcement.presentedCallbacks)) {
        announcement.presentedCallbacks = [];
    }
    return announcement.presentedCallbacks;
}

function clearCentralAnnouncementLanes(): void {
    if (typeof document === 'undefined') return;
    document.getElementById(NOTIFICATION_OWNER_ID)
        ?.querySelectorAll<HTMLElement>('[data-jc-announcer]')
        .forEach((lane) => { lane.textContent = ''; });
}

function scheduleAnnouncementGap(): void {
    notificationRuntime.announcementTimer = window.setTimeout(() => {
        notificationRuntime.announcementTimer = null;
        notificationRuntime.announcementInGap = false;
        notificationRuntime.drainDelegate();
    }, ANNOUNCEMENT_GAP_MS);
}

function scheduleActiveAnnouncementRetirement(): void {
    notificationRuntime.announcementTimer = window.setTimeout(() => {
        clearCentralAnnouncementLanes();
        notificationRuntime.announcementActive = false;
        notificationRuntime.announcementInGap = true;
        notificationRuntime.activeAnnouncementKey = null;
        notificationRuntime.activeAnnouncementAdmission = null;
        // Give assistive technology an observable empty state before the same
        // live lane receives another message. Replacing text in one task can
        // otherwise collapse two rapid events into one spoken update.
        scheduleAnnouncementGap();
    }, ANNOUNCEMENT_DWELL_MS);
}

function drainAnnouncements(): void {
    // A real timer may outlive a jsdom document or a host WebView teardown.
    // Retire the detached queue without touching missing globals.
    if (typeof document === 'undefined' || typeof window === 'undefined') {
        notificationRuntime.announcements.length = 0;
        notificationRuntime.announcementTimer = null;
        notificationRuntime.announcementActive = false;
        notificationRuntime.announcementInGap = false;
        notificationRuntime.activeAnnouncementKey = null;
        notificationRuntime.activeAnnouncementAdmission = null;
        return;
    }
    // Queue admission enforces this invariant. Keep the bounded compare here
    // too so the self-rescheduling drain fails closed if internal code drifts.
    if (notificationRuntime.announcements.length > MAX_PENDING_ANNOUNCEMENTS) {
        throw new NotificationBackpressureError('announcements');
    }
    if (notificationRuntime.announcementActive || notificationRuntime.announcementInGap) return;
    const next = notificationRuntime.announcements.shift();
    if (!next) return;
    const owner = ensureNotificationOwner();
    const lane = owner.querySelector<HTMLElement>(`[data-jc-announcer="${next.urgency}"]`);
    if (!lane) return;
    notificationRuntime.announcementActive = true;
    notificationRuntime.activeAnnouncementKey = next.dedupeKey;
    notificationRuntime.activeAnnouncementAdmission = next.admission;
    lane.textContent = next.message;
    const callbacks = presentationCallbacksFor(next).splice(0);
    for (const callback of callbacks) {
        try {
            callback();
        } catch (error) {
            console.warn('🪼 Jellyfin Canopy: Notification presentation callback failed', error);
        }
    }
    scheduleActiveAnnouncementRetirement();
}

function adoptAnnouncementTimerOwnership(): void {
    // A content-hashed predecessor may still own a v1 timer whose closure calls
    // its old drain implementation. Cancel and re-arm that phase so every later
    // event is drained by this graph and presentation callbacks cannot be lost.
    if (notificationRuntime.announcementTimer != null) {
        clearTimeout(notificationRuntime.announcementTimer);
        notificationRuntime.announcementTimer = null;
    }
    notificationRuntime.drainDelegate = drainAnnouncements;
    if (notificationRuntime.announcementActive) {
        scheduleActiveAnnouncementRetirement();
    } else if (notificationRuntime.announcementInGap) {
        scheduleAnnouncementGap();
    } else {
        drainAnnouncements();
    }
}

function queueAnnouncement(
    message: string,
    severity: NotificationSeverity = 'info',
    dedupeKey?: string,
    admission: Announcement['admission'] = 'primary',
    onPresented?: () => void
): AnnouncementTicket {
    const normalized = message.replace(/\s+/g, ' ').trim();
    if (!normalized) {
        onPresented?.();
        return { state: 'coalesced', cancel: () => false };
    }
    const normalizedKey = dedupeKey?.trim() || null;
    if (normalizedKey && notificationRuntime.activeAnnouncementKey === normalizedKey) {
        onPresented?.();
        return { state: 'coalesced', cancel: () => false };
    }
    const pendingDuplicate = normalizedKey
        ? notificationRuntime.announcements.find((item) => item.dedupeKey === normalizedKey)
        : null;
    if (pendingDuplicate) {
        if (!onPresented) return { state: 'coalesced', cancel: () => false };
        const presentedCallbacks = presentationCallbacksFor(pendingDuplicate);
        presentedCallbacks.push(onPresented);
        let callbackPending = true;
        return {
            state: 'coalesced',
            cancel: () => {
                if (!callbackPending) return false;
                const index = presentedCallbacks.indexOf(onPresented);
                if (index < 0) {
                    callbackPending = false;
                    return false;
                }
                presentedCallbacks.splice(index, 1);
                callbackPending = false;
                return true;
            }
        };
    }
    const activeCount = notificationRuntime.announcementActive ? 1 : 0;
    const pendingCount = notificationRuntime.announcements.length + activeCount;
    const primaryCount = notificationRuntime.announcements
        .filter((item) => item.admission === 'primary').length
        + (notificationRuntime.activeAnnouncementAdmission === 'primary' ? 1 : 0);
    if (pendingCount >= MAX_PENDING_ANNOUNCEMENTS
        || (admission === 'primary' && primaryCount >= MAX_PRIMARY_ANNOUNCEMENTS)) {
        throw new NotificationBackpressureError('announcements');
    }
    const announcement: Announcement = {
        message: normalized,
        urgency: severity === 'warning' || severity === 'error' ? 'assertive' : 'polite',
        dedupeKey: normalizedKey,
        admission,
        presentedCallbacks: onPresented ? [onPresented] : [],
    };
    if (announcement.urgency === 'assertive') {
        // Preserve the currently spoken message, then put urgent work ahead of
        // queued polite work without reordering other urgent announcements.
        const firstPolite = notificationRuntime.announcements
            .findIndex((item) => item.urgency === 'polite');
        if (firstPolite < 0) notificationRuntime.announcements.push(announcement);
        else notificationRuntime.announcements.splice(firstPolite, 0, announcement);
    } else {
        notificationRuntime.announcements.push(announcement);
    }
    let pending = true;
    const ticket: AnnouncementTicket = {
        state: 'queued',
        cancel: () => {
            if (!pending) return false;
            const index = notificationRuntime.announcements.indexOf(announcement);
            if (index < 0) {
                pending = false;
                return false;
            }
            notificationRuntime.announcements.splice(index, 1);
            presentationCallbacksFor(announcement).length = 0;
            pending = false;
            return true;
        }
    };
    drainAnnouncements();
    if (!notificationRuntime.announcements.includes(announcement)) pending = false;
    return ticket;
}

/** @internal Narrow production-queue seam for bounded admission tests. */
export function queueNotificationAnnouncementForTesting(
    message: string,
    severity: NotificationSeverity = 'info',
    dedupeKey?: string
): 'queued' | 'coalesced' {
    return queueAnnouncement(message, severity, dedupeKey).state;
}

/** @internal Terminal-capacity seam for deterministic completion fallback tests. */
export function queueTerminalNotificationAnnouncementForTesting(
    message: string,
    severity: NotificationSeverity = 'success',
    dedupeKey?: string
): 'queued' | 'coalesced' {
    return queueAnnouncement(message, severity, dedupeKey, 'terminal').state;
}

function clearAnnouncements(): void {
    notificationRuntime.announcements.length = 0;
    if (notificationRuntime.announcementTimer != null) {
        clearTimeout(notificationRuntime.announcementTimer);
    }
    notificationRuntime.announcementTimer = null;
    notificationRuntime.announcementActive = false;
    notificationRuntime.announcementInGap = false;
    notificationRuntime.activeAnnouncementKey = null;
    notificationRuntime.activeAnnouncementAdmission = null;
    if (typeof document !== 'undefined') {
        const owner = document.getElementById(NOTIFICATION_OWNER_ID);
        owner?.querySelectorAll<HTMLElement>('[data-jc-announcer]')
            .forEach((lane) => { lane.textContent = ''; });
    }
}

function deriveAnnouncement(html: string): string {
    const template = document.createElement('template');
    template.innerHTML = html;
    template.content.querySelectorAll('svg, .material-icons, [aria-hidden="true"]').forEach((node) => node.remove());
    return (template.content.textContent || '').replace(/\s+/g, ' ').trim();
}

function clearRecordTimer(
    record: NotificationRecord,
    key: 'showTimer' | 'expiryTimer' | 'completionTimer' | 'removalTimer'
): void {
    const timer = record[key];
    if (timer != null) clearTimeout(timer);
    record[key] = null;
}

function shouldRestoreNotificationFocus(reason: NotificationDismissReason): boolean {
    return reason !== 'navigation' && reason !== 'identity';
}

function removeRecord(record: NotificationRecord, restoreFocus: boolean): void {
    clearRecordTimer(record, 'removalTimer');
    clearRecordTimer(record, 'completionTimer');
    const active = typeof document === 'undefined' ? null : document.activeElement;
    if (typeof HTMLElement !== 'undefined'
        && active instanceof HTMLElement
        && record.element.contains(active)) {
        const returnTarget = record.returnFocus;
        if (restoreFocus && returnTarget?.isConnected && !record.element.contains(returnTarget)) {
            returnTarget.focus({ preventScroll: true });
        } else {
            active.blur();
        }
    }
    record.element.remove();
    notificationRuntime.notifications.delete(record);
}

function dismissRecord(
    record: NotificationRecord,
    reason: NotificationDismissReason,
    immediate = false
): void {
    if (record.disposed) {
        if (immediate) removeRecord(record, shouldRestoreNotificationFocus(reason));
        return;
    }
    record.disposed = true;
    record.cancelPendingActionAnnouncement?.();
    record.cancelPendingActionAnnouncement = null;
    clearRecordTimer(record, 'showTimer');
    clearRecordTimer(record, 'expiryTimer');
    clearRecordTimer(record, 'completionTimer');
    const action = record.element.querySelector<HTMLButtonElement>('.jc-notification-action');
    if (action) {
        action.removeAttribute('aria-busy');
    }
    record.element.classList.remove('jc-visible');
    record.element.style.transform = 'translateX(100%)';
    try {
        record.onDismiss?.(reason);
    } catch (error) {
        console.warn('🪼 Jellyfin Canopy: Notification dismiss callback failed', error);
    }
    const restoreFocus = shouldRestoreNotificationFocus(reason);
    if (immediate || prefersReducedMotion() || typeof window === 'undefined') {
        removeRecord(record, restoreFocus);
    } else {
        record.removalTimer = window.setTimeout(() => removeRecord(record, restoreFocus), 300);
    }
}

function scheduleActionCompletionDismiss(record: NotificationRecord): void {
    if (record.disposed || record.completionTimer != null) return;
    if (typeof window === 'undefined') {
        dismissRecord(record, 'action', true);
        return;
    }
    record.completionTimer = window.setTimeout(() => {
        record.completionTimer = null;
        dismissRecord(record, 'action');
    }, ACTION_COMPLETION_DWELL_MS);
}

function startExpiry(record: NotificationRecord): void {
    if (record.disposed || record.persistent || record.pointerInside
        || record.focusInside || record.actionInvoked) return;
    if (typeof window === 'undefined') {
        dismissRecord(record, 'programmatic', true);
        return;
    }
    record.startedAt = Date.now();
    record.expiryTimer = window.setTimeout(() => {
        record.expiryTimer = null;
        dismissRecord(record, 'timeout');
    }, record.remaining);
}

function pauseExpiry(record: NotificationRecord): void {
    if (record.disposed || record.expiryTimer == null) return;
    record.remaining = Math.max(0, record.remaining - (Date.now() - record.startedAt));
    clearRecordTimer(record, 'expiryTimer');
}

function resumeExpiry(record: NotificationRecord): void {
    if (record.disposed || record.pointerInside || record.focusInside
        || record.actionInvoked || record.expiryTimer != null) return;
    startExpiry(record);
}

interface InternalNotificationOptions extends NotificationOptions {
    readonly legacyClass?: string;
    readonly action?: {
        readonly label: string;
        readonly invoke: () => void | Promise<void>;
        readonly availableAnnouncement?: string;
        readonly announcement?: string;
        readonly errorAnnouncement?: string;
    };
}

function createNotification(options: InternalNotificationOptions): NotificationHandle {
    if (typeof options.message !== 'string' || options.message.trim() === '') {
        throw new TypeError('Notification message must contain accessible text');
    }
    if (options.action
        && (typeof options.action.label !== 'string' || options.action.label.trim() === '')) {
        throw new TypeError('Notification action must have an accessible label');
    }
    if (options.action && typeof options.action.invoke !== 'function') {
        throw new TypeError('Notification action callback must be callable');
    }
    if (options.action?.availableAnnouncement !== undefined
        && (typeof options.action.availableAnnouncement !== 'string'
            || options.action.availableAnnouncement.trim() === '')) {
        throw new TypeError('Notification action availability must contain accessible text');
    }
    if (notificationRuntime.notifications.size >= MAX_ACTIVE_NOTIFICATIONS) {
        throw new NotificationBackpressureError('notifications');
    }
    // Admission happens before the owner, card, or timers become observable.
    // A rejected producer therefore cannot leave an inaccessible visual orphan.
    let initialAnnouncementPresented = false;
    let notificationRecord: NotificationRecord | null = null;
    const initialAnnouncement = options.action
        ? (options.action.availableAnnouncement || `${options.message} — ${options.action.label}`)
        : options.message;
    const initialAnnouncementTicket = queueAnnouncement(
        initialAnnouncement,
        options.severity || 'info',
        // Every actionable card represents a distinct reachable control, so its
        // availability event must never be coalesced with another action.
        options.action ? undefined : options.dedupeKey,
        'primary',
        options.action
            ? () => {
                initialAnnouncementPresented = true;
                if (notificationRecord) {
                    notificationRecord.cancelPendingActionAnnouncement = null;
                    startExpiry(notificationRecord);
                }
            }
            : undefined
    );

    const owner = ensureNotificationOwner();
    const stack = owner.querySelector<HTMLElement>('.jc-notification-stack')!;
    const identity = JC.identity.capture();
    const severity = options.severity || 'info';
    const configuredDuration = options.duration
        ?? (options.action ? 8000 : (JC.CONFIG?.TOAST_DURATION || 1500));
    const duration = Number.isFinite(configuredDuration) ? Math.max(0, configuredDuration) : 1500;
    const themeVars = JC.themer?.getThemeVariables?.() || {};
    const reducedMotion = prefersReducedMotion();
    const element = document.createElement('div');
    const id = `jc-notification-${++notificationRuntime.sequence}`;
    element.id = id;
    element.className = `jc-notification${options.legacyClass ? ` ${options.legacyClass}` : ''}`;
    element.dataset.jcNotificationSeverity = severity;
    element.setAttribute('aria-live', 'off');
    if (identity) element.dataset.jcIdentityOwned = 'true';
    Object.assign(element.style, {
        position: 'relative',
        transform: reducedMotion ? 'translateX(0)' : 'translateX(100%)',
        background: themeVars.secondaryBg || 'linear-gradient(135deg, rgba(0,0,0,0.9), rgba(40,40,40,0.9))',
        color: '#fff',
        padding: options.action ? '12px 16px' : '10px 14px',
        borderRadius: '8px',
        fontSize: 'clamp(13px, 2vw, 16px)',
        textShadow: '-1px -1px 10px black',
        fontWeight: '500',
        boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
        backdropFilter: `blur(${themeVars.blur || '30px'})`,
        border: `1px solid ${themeVars.primaryAccent || 'rgba(255,255,255,0.1)'}`,
        transition: reducedMotion ? 'none' : 'transform 0.3s ease-out',
        maxWidth: options.action ? '380px' : 'clamp(280px, 80vw, 350px)'
    });
    const message = document.createElement('span');
    message.className = 'jc-notification-message';
    message.textContent = options.message;
    element.appendChild(message);

    const record: NotificationRecord = {
        id,
        element,
        identity,
        generation: notificationRuntime.generation,
        onDismiss: options.onDismiss,
        returnFocus: null,
        remaining: duration,
        startedAt: Date.now(),
        showTimer: null,
        expiryTimer: null,
        completionTimer: null,
        removalTimer: null,
        cancelPendingActionAnnouncement: options.action && !initialAnnouncementPresented
            ? () => { initialAnnouncementTicket.cancel(); }
            : null,
        pointerInside: false,
        focusInside: false,
        persistent: options.persistent === true,
        disposed: false,
        actionInvoked: false
    };
    notificationRecord = record;
    notificationRuntime.notifications.add(record);

    if (options.action) {
        Object.assign(element.style, { display: 'flex', alignItems: 'center', gap: '12px' });
        const content = document.createElement('span');
        content.className = 'jc-notification-content';
        content.style.flex = '1';
        element.replaceChildren(content);
        content.appendChild(message);
        const actionStatus = document.createElement('span');
        actionStatus.id = `${id}-action-status`;
        actionStatus.className = 'jc-notification-action-status';
        actionStatus.hidden = true;
        Object.assign(actionStatus.style, {
            display: 'block',
            marginTop: '4px',
            fontSize: '12px',
            fontWeight: '400',
        });
        content.appendChild(actionStatus);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'jc-notification-action';
        button.textContent = options.action.label;
        button.setAttribute('aria-describedby', `${id}-message ${id}-action-status`);
        message.id = `${id}-message`;
        Object.assign(button.style, {
            background: 'rgba(255,255,255,0.15)',
            border: '1px solid rgba(255,255,255,0.25)',
            color: '#fff',
            padding: '4px 12px',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '13px',
            fontWeight: '600',
            whiteSpace: 'nowrap'
        });
        const clearActionStatus = (): void => {
            actionStatus.hidden = true;
            actionStatus.textContent = '';
            actionStatus.removeAttribute('aria-live');
            actionStatus.removeAttribute('aria-atomic');
        };
        const showActionStatus = (statusMessage: string): void => {
            actionStatus.removeAttribute('aria-live');
            actionStatus.removeAttribute('aria-atomic');
            actionStatus.textContent = statusMessage;
            actionStatus.hidden = false;
        };
        const showFallbackLiveStatus = (
            statusMessage: string,
            urgency: 'polite' | 'assertive'
        ): void => {
            actionStatus.hidden = true;
            actionStatus.textContent = '';
            actionStatus.setAttribute('aria-live', urgency);
            actionStatus.setAttribute('aria-atomic', 'true');
            actionStatus.hidden = false;
            actionStatus.textContent = statusMessage;
        };
        const restoreFailedAction = (error: unknown): void => {
            console.warn('🪼 Jellyfin Canopy: Notification action failed', error);
            if (record.disposed || record.generation !== notificationRuntime.generation
                || (record.identity && !JC.identity.isCurrent(record.identity))) return;
            record.actionInvoked = false;
            button.disabled = false;
            button.removeAttribute('aria-busy');
            // A failed action is a new actionable state. Do not consume its
            // retry window with time that elapsed before or during the failed
            // attempt; the full configured duration starts after restoration.
            record.remaining = duration;
            const failureMessage = options.action?.errorAnnouncement
                || `${options.action?.label || 'Action'} failed. Try again.`;
            showActionStatus(failureMessage);
            let failurePresented = false;
            try {
                const failureTicket = queueAnnouncement(
                    failureMessage,
                    'error',
                    `${record.id}:action-error`,
                    'terminal',
                    () => {
                        failurePresented = true;
                        record.cancelPendingActionAnnouncement = null;
                        resumeExpiry(record);
                    }
                );
                if (!failurePresented) {
                    record.cancelPendingActionAnnouncement = () => { failureTicket.cancel(); };
                }
            } catch (backpressureError) {
                // Keep the retry contract visible even in pathological queue
                // saturation. This bounded per-card live fallback is used only
                // when the central terminal queue explicitly rejects admission.
                console.error('🪼 Jellyfin Canopy: Could not queue action failure announcement', backpressureError);
                showFallbackLiveStatus(failureMessage, 'assertive');
                resumeExpiry(record);
            }
        };
        button.addEventListener('click', () => {
            if (record.disposed || record.actionInvoked) return;
            if (record.identity && !JC.identity.isCurrent(record.identity)) {
                dismissRecord(record, 'identity', true);
                return;
            }
            record.cancelPendingActionAnnouncement?.();
            record.cancelPendingActionAnnouncement = null;
            record.actionInvoked = true;
            button.disabled = true;
            button.setAttribute('aria-busy', 'true');
            clearActionStatus();
            pauseExpiry(record);
            try {
                const result = options.action!.invoke();
                void Promise.resolve(result).then(() => {
                    if (record.disposed || record.generation !== notificationRuntime.generation
                        || (record.identity && !JC.identity.isCurrent(record.identity))) return;
                    button.removeAttribute('aria-busy');
                    if (options.action?.announcement) {
                        let completionPresented = false;
                        try {
                            const completionTicket = queueAnnouncement(
                                options.action.announcement,
                                'success',
                                `${record.id}:action-success`,
                                'terminal',
                                () => {
                                    completionPresented = true;
                                    record.cancelPendingActionAnnouncement = null;
                                    scheduleActionCompletionDismiss(record);
                                }
                            );
                            if (!completionPresented) {
                                record.cancelPendingActionAnnouncement = () => { completionTicket.cancel(); };
                            }
                        } catch (backpressureError) {
                            console.error('🪼 Jellyfin Canopy: Could not queue action completion announcement', backpressureError);
                            // The operation did complete. Keep a bounded, polite,
                            // per-card live fallback visible for the full dwell;
                            // reduced motion changes animation, never readability.
                            showFallbackLiveStatus(options.action.announcement, 'polite');
                            scheduleActionCompletionDismiss(record);
                        }
                    } else {
                        dismissRecord(record, 'action');
                    }
                }).catch(restoreFailedAction);
            } catch (error) {
                restoreFailedAction(error);
            }
        });
        element.appendChild(button);
    }

    element.addEventListener('pointerenter', () => {
        record.pointerInside = true;
        pauseExpiry(record);
    });
    element.addEventListener('pointerleave', () => {
        record.pointerInside = false;
        resumeExpiry(record);
    });
    element.addEventListener('focusin', (event) => {
        const previous = event.relatedTarget;
        if (previous instanceof HTMLElement
            && previous.isConnected && !element.contains(previous)) {
            record.returnFocus = previous;
        }
        record.focusInside = true;
        pauseExpiry(record);
    });
    element.addEventListener('focusout', (event) => {
        const next = event.relatedTarget;
        record.focusInside = next instanceof Node && element.contains(next);
        resumeExpiry(record);
    });

    stack.appendChild(element);
    if (!reducedMotion) {
        record.showTimer = window.setTimeout(() => {
            record.showTimer = null;
            if (!record.disposed && element.isConnected) {
                element.classList.add('jc-visible');
                element.style.transform = 'translateX(0)';
            }
        }, 10);
    } else {
        element.classList.add('jc-visible');
    }
    if (!options.action || initialAnnouncementPresented) startExpiry(record);

    return {
        id,
        element,
        dismiss: () => dismissRecord(record, 'programmatic')
    };
}

/** Show a safe text notification through the shared document-life owner. */
export function notify(options: NotificationOptions): NotificationHandle {
    return createNotification(options);
}

/** Show a safe text notification with one keyboard-reachable action. */
export function notifyAction(options: ActionableNotificationOptions): NotificationHandle {
    return createNotification({
        ...options,
        action: {
            label: options.actionLabel,
            invoke: options.onAction,
            availableAnnouncement: options.actionAvailableAnnouncement,
            announcement: options.actionAnnouncement,
            errorAnnouncement: options.actionErrorAnnouncement
        }
    });
}

/**
 * Displays a short-lived toast notification (moved from enhanced/ui.js).
 * NOTE: preserves the frozen innerHTML contract — escape user-controlled
 * content with JC.core.ui.escapeHtml before passing it in.
 * @param html The (already localized/escaped) content to display.
 * @param duration How long to show the toast, in ms.
 * @param severity Optional explicit urgency for migrated legacy producers.
 */
export function toast(
    html: string,
    duration?: number,
    severity: NotificationSeverity = 'info'
): void {
    let handle: NotificationHandle;
    const announcement = deriveAnnouncement(html);
    try {
        handle = createNotification({
            message: announcement,
            duration,
            severity,
            // The compatibility API cannot accept an event identity. Coalesce
            // only equivalent normalized pending spoken copy; each visual card and
            // every later occurrence after the queue drains remain intact.
            dedupeKey: `legacy:${severity}:${announcement}`,
            legacyClass: 'jellyfin-canopy-toast'
        });
    } catch (error) {
        if (!(error instanceof NotificationBackpressureError)) throw error;
        // The frozen legacy adapter has historically been fire-and-forget.
        // Typed notify/notifyAction remain the producer-visible backpressure API.
        console.error('🪼 Jellyfin Canopy: Legacy toast rejected by notification backpressure', error);
        return;
    }
    // Frozen compatibility/XSS contract: callers still own escaping and the
    // supplied markup remains the card's exact innerHTML.
    handle.element.innerHTML = html;
}

function resetNotifications(reason: 'navigation' | 'identity'): void {
    notificationRuntime.generation += 1;
    for (const record of Array.from(notificationRuntime.notifications)) {
        dismissRecord(record, reason, true);
    }
    clearAnnouncements();
}

// An older content-hashed graph may own the one lifecycle callback. Always
// replace its delegate so teardown executes the newest compatible code while
// retaining exactly one navigation and identity registration per document.
notificationRuntime.resetDelegate = resetNotifications;

function installNotificationRuntime(): void {
    if (document.body) {
        ensureNotificationOwner();
    } else if (!notificationRuntime.ownerInstallPending) {
        notificationRuntime.ownerInstallPending = true;
        document.addEventListener('DOMContentLoaded', () => {
            notificationRuntime.ownerInstallPending = false;
            ensureNotificationOwner();
        }, { once: true });
    }

    if (notificationRuntime.lifecycleInstalled) return;
    const offNavigate = onNavigate(() => notificationRuntime.resetDelegate('navigation'));
    try {
        JC.identity.registerReset(
            'ui-toasts',
            () => notificationRuntime.resetDelegate('identity')
        );
        notificationRuntime.lifecycleInstalled = true;
    } catch (error) {
        offNavigate();
        throw error;
    }
}

adoptAnnouncementTimerOwnership();
installNotificationRuntime();

// ── MUI component kit (v12 React/MUI markup match) ──────────────────────────
//
// Builders that produce plain DOM carrying the SAME class names the v12
// React/MUI client emits (verified against the jellyfin-web source, e.g.
// components/toolbar/UserMenuButton.tsx → MUI <IconButton size="large">).
// Because jellyfin-web's MUI stylesheet is global and its theme is emitted as
// CSS custom properties (createTheme({ cssVariables: { cssVarPrefix: 'jf' } }),
// selector [data-theme="%s"]), a hand-built element wearing those classes is
// styled natively by the running theme — so light/dark/custom themes all work
// with ZERO hardcoded colors. Where we add our own chrome we reference the same
// `--jf-palette-*` tokens (with non-color fallbacks) rather than literal colors.
//
// On the LEGACY layout the MUI stylesheet is present too; pass legacy classes
// via `className` when a button must live in both headers (dual-layout support).
//
// Usage:
//   const btn = JC.core.ui.muiIconButton({ icon: 'casino', title: 'Random',
//                                           onClick: () => run() });
//   trayContainer.prepend(btn);                       // native AppBar look
//   const item = JC.core.ui.muiMenuItem({ label: 'Settings', icon: 'tune',
//                                          onClick: open });
//   const section = JC.core.ui.sectionContainer({ title: 'Enhanced' });
//   section.appendChild(myCards);                     // matches home sections

const KIT_CSS_ID = 'jc-ui-kit-css';
let kitCssInjected = false;

/** Inject the kit's small supplemental stylesheet once (theme-token driven). */
function ensureKitCss(): void {
    if (kitCssInjected) return;
    kitCssInjected = true;
    injectCss(KIT_CSS_ID, `
        /* IconButton glyph: MUI IconButton sizes its child SvgIcon; our glyph is
           a material-icons font span, so pin it to MUI's own icon sizes. Colour
           is inherited (colorInherit) — no hardcoded value. */
        .jc-mui-icon-button .material-icons { font-size: 1.5rem; line-height: 1; }
        .jc-mui-icon-button.MuiIconButton-sizeSmall .material-icons { font-size: 1.25rem; }
        /* MenuItem leading icon uses the secondary text token. */
        .jc-mui-menu-item { display: flex; align-items: center; gap: 0.75rem; }
        .jc-mui-menu-item .jc-mui-menu-item-icon .material-icons {
            font-size: 1.5rem;
            color: var(--jf-palette-text-secondary, currentColor);
        }
    `);
}

/**
 * Build an MUI IconButton clone (the AppBar action-button markup). Styled
 * natively by the running theme via the MUI classes; the glyph is a
 * material-icons font ligature.
 * @param options - See {@link MuiIconButtonOptions}.
 * @returns The `<button>` (not yet attached — caller places it).
 */
export function muiIconButton(options: MuiIconButtonOptions): HTMLButtonElement {
    ensureKitCss();
    const size = options.size || 'large';
    const sizeClass = size === 'large'
        ? 'MuiIconButton-sizeLarge'
        : size === 'small' ? 'MuiIconButton-sizeSmall' : 'MuiIconButton-sizeMedium';

    const btn = document.createElement('button');
    btn.type = 'button';
    // MuiButtonBase-root + MuiIconButton-root + size + colorInherit are exactly
    // what MUI renders for <IconButton size=… color='inherit'>.
    btn.className = `MuiButtonBase-root MuiIconButton-root ${sizeClass} MuiIconButton-colorInherit jc-mui-icon-button`;
    if (options.className) btn.className += ` ${options.className}`;
    if (options.id) btn.id = options.id;
    if (options.title) btn.title = options.title;
    const label = options.ariaLabel ?? options.title;
    if (label) btn.setAttribute('aria-label', label);

    const glyph = document.createElement('span');
    glyph.className = 'material-icons';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = options.icon;
    btn.appendChild(glyph);

    if (options.onClick) btn.addEventListener('click', options.onClick);
    return btn;
}

/**
 * Build an MUI MenuItem clone (`<li class="MuiMenuItem-root">`) with an optional
 * leading icon and a typography label. Styled natively by the MUI stylesheet.
 * @param options - See {@link MuiMenuItemOptions}.
 * @returns The `<li>` (not yet attached).
 */
export function muiMenuItem(options: MuiMenuItemOptions): HTMLLIElement {
    ensureKitCss();
    const li = document.createElement('li');
    li.className = 'MuiButtonBase-root MuiMenuItem-root MuiMenuItem-gutters jc-mui-menu-item';
    if (options.className) li.className += ` ${options.className}`;
    if (options.id) li.id = options.id;
    li.setAttribute('role', 'menuitem');
    li.tabIndex = -1;

    if (options.icon) {
        const iconWrap = document.createElement('div');
        iconWrap.className = 'MuiListItemIcon-root jc-mui-menu-item-icon';
        const glyph = document.createElement('span');
        glyph.className = 'material-icons';
        glyph.setAttribute('aria-hidden', 'true');
        glyph.textContent = options.icon;
        iconWrap.appendChild(glyph);
        li.appendChild(iconWrap);
    }

    const text = document.createElement('span');
    text.className = 'MuiTypography-root MuiTypography-body1';
    text.textContent = options.label;
    li.appendChild(text);

    if (options.onClick) li.addEventListener('click', options.onClick);
    return li;
}

/**
 * Build a `.verticalSection` matching the home-sections markup (the React home
 * wrapper hosts the legacy hometab controller inside `.homeSectionsContainer`;
 * each block is a `.verticalSection` with a `.sectionTitle`). Append content
 * directly into the returned element.
 * @param options - See {@link SectionContainerOptions}.
 * @returns The section `<div>` (title prepended when provided).
 */
export function sectionContainer(options: SectionContainerOptions = {}): HTMLDivElement {
    ensureKitCss();
    const section = document.createElement('div');
    section.className = 'verticalSection';
    if (options.className) section.className += ` ${options.className}`;
    if (options.id) section.id = options.id;

    if (options.title) {
        const heading = document.createElement('h2');
        heading.className = 'sectionTitle sectionTitle-cards';
        heading.textContent = options.title;
        section.appendChild(heading);
    }
    return section;
}

/**
 * PERF(R1): shift-free entrance for a node just inserted in-flow into an
 * ALREADY-PAINTED container (e.g. a header tray at plugin boot, which by
 * architecture paints seconds before JC loads). Instead of snap-shifting its
 * siblings, the node expands from width 0 to its natural width over a short
 * eased transition, then every inline style is removed so the final layout is
 * exactly what a plain insert would have produced.
 *
 * Call synchronously right after attaching the node (same task, before the
 * next paint — the natural width is measured before collapsing, so the node
 * never paints full-size first). Pass `instant: true` when the injection is
 * known to run in the same mutation batch that mounted the container
 * (pre-paint re-mounts): the node is then part of the container's first
 * painted frame and animating would only draw attention to it.
 * @param el - The just-attached element.
 * @param options - See {@link ExpandInOptions}.
 */
export function expandIn(el: HTMLElement, options: ExpandInOptions = {}): void {
    if (options.instant) return;
    if (!el.isConnected) return;
    const targetWidth = el.getBoundingClientRect().width;
    if (targetWidth <= 0) return; // hidden / not laid out — nothing to animate
    const duration = options.durationMs ?? 150;
    const prevOverflow = el.style.overflow;
    el.style.overflow = 'hidden';
    el.style.width = '0px';
    void el.offsetWidth; // flush so the transition starts from the collapsed width
    el.style.transition = `width ${duration}ms ease`;
    el.style.width = `${targetWidth}px`;
    let cleaned = false;
    const cleanup = (): void => {
        if (cleaned) return;
        cleaned = true;
        el.style.transition = '';
        el.style.width = '';
        el.style.overflow = prevOverflow;
    };
    el.addEventListener('transitionend', cleanup, { once: true });
    setTimeout(cleanup, duration + 100); // safety net if transitionend never fires
}

const ui: UiApi = {
    escapeHtml,
    toast,
    notify,
    notifyAction,
    injectCss,
    removeCss,
    muiIconButton,
    muiMenuItem,
    sectionContainer,
    expandIn
};

JC.core.ui = ui;

// Frozen-contract aliases: these are the canonical implementations now.
JC.escapeHtml = escapeHtml;
JC.toast = toast;

console.log('🪼 Jellyfin Canopy: UI kit core initialized');
