// src/extras/active-streams.ts
// Shows a live Active Streams counter in the Jellyfin header.

import { JC as JEBase } from '../globals';
import { describeFetchError } from '../core/fetch-error';
import { insertHeaderTrayButton, HeaderTrayOrder } from '../enhanced/header-tray';
import { createStableMethodFacade } from '../core/feature-loader';
import type { ApiApi, IdentityContext, LifecycleApi, LifecycleHandle, NavigationApi, PluginConfig, UiApi } from '../types/jc';

/**
 * Local view of the shared namespace adding the public member this module
 * OWNS plus the core/legacy surfaces it uses.
 */
const JC = JEBase as typeof JEBase & {
    activeStreams?: { initialize(): void; destroy(): void };
    t?: (key: string, params?: Record<string, unknown>) => string;
    toast?: (html: string, duration?: number) => void;
    currentUser?: { Policy?: { IsAdministrator?: boolean } };
    pluginConfig: PluginConfig & { ActiveStreamsEnabled?: boolean; ActiveStreamsAllUsers?: boolean };
    core: { api: ApiApi; navigation: NavigationApi; lifecycle: LifecycleApi; ui?: UiApi };
    themer?: { getThemeVariables?: () => { primaryAccent?: string } };
    helpers: {
        getHeaderRightContainer: () => HTMLElement | null;
        onBodyMutation?: (id: string, cb: () => void) => { unsubscribe(): void };
    };
};

// ── Session shape (the /active-streams/sessions projection) ────────────────
interface SessionMediaStream { Type?: string; Codec?: string; BitRate?: number }
interface SessionNowPlaying {
    Id?: string;
    Type?: string;
    Name?: string;
    SeriesName?: string;
    RunTimeTicks?: number;
    ProductionYear?: number;
    ParentIndexNumber?: number;
    IndexNumber?: number;
    ImageTags?: Record<string, string> | null;
    SeriesId?: string;
    SeriesPrimaryImageTag?: string;
    MediaStreams?: SessionMediaStream[] | null;
}
interface SessionPlayState { IsPaused?: boolean; PositionTicks?: number; PlayMethod?: string }
interface SessionTranscoding {
    IsVideoDirect?: boolean;
    VideoCodec?: string;
    AudioCodec?: string;
    Bitrate?: number;
    TranscodeReasons?: string[];
    CompletionPercentage?: number;
    Width?: number;
    Height?: number;
    Framerate?: number;
}
interface SessionView {
    // Null (not just absent) for non-admin viewers: the server redacts the
    // session id server-side, mirroring the RemoteEndPoint redaction below.
    Id?: string | null;
    UserId?: string;
    UserName?: string;
    Client?: string;
    DeviceName?: string;
    SupportsRemoteControl?: boolean;
    RemoteEndPoint?: string | null;
    NowPlayingItem?: SessionNowPlaying | null;
    PlayState?: SessionPlayState | null;
    TranscodingInfo?: SessionTranscoding | null;
}

const isAdmin = (): boolean => JC?.currentUser?.Policy?.IsAdministrator === true;

// Fire a transient toast if the host exposes one (no-op under jsdom tests).
// Callers only ever pass trusted localized strings (no session-derived data),
// so no escaping is needed at these sites (X1).
const notify = (message: string): void => {
    try { (JC.toast || JC.core?.ui?.toast)?.(message); } catch (_) { /* non-fatal */ }
};

// ── Live-update cadence ────────────────────────────────────────────────────
// The panel is a live surface. While it is OPEN we drive updates from the core
// `Sessions` websocket message (the same push the native dashboard uses) and
// fall back to a page-scoped, visibility-gated interval when the socket bridge
// is unavailable (PERF R5: page-scoped + visibility-gated + push-nudged — never
// a standing DOM poll). Everything is torn down when the panel closes.
const LIVE_FALLBACK_MS = 5000;   // fallback cadence when no websocket push
const LIVE_NUDGE_DEBOUNCE_MS = 800; // coalesce websocket bursts (~1.5s cadence)

const LOG = '🪼 Jellyfin Canopy:';

// ── State ────────────────────────────────────────────────────────────────
let _pollTimer: ReturnType<typeof setInterval> | null = null;
let _panelOpen = false;
let _observer: { unsubscribe(): void } | null = null;
let _lifecycle: LifecycleHandle | null = null;
let _outsideClickListener: ((e: MouseEvent) => void) | null = null;
let _lastUpdated: Date | null = null;
// PERF(R1): true once the header button has been injected in this enable cycle —
// the first injection (boot / toggle-on, post-paint by architecture) gets the
// one-time width-expand entrance; re-mount re-injections attach instantly.
let _headerInjectedOnce = false;
// The 500ms header-injection retry (fired when the header tray isn't mounted
// yet). Stored so both teardown paths (stopObserver + destroy) can cancel a
// pending retry — otherwise a disable racing the retry window re-injects the
// full button + panel + poll after teardown (zombie UI).
let _headerRetryTimer: ReturnType<typeof setTimeout> | null = null;
// ── Live-update resources (only alive while the panel is open) ──────────────
let _liveTimer: ReturnType<typeof setInterval> | null = null;
let _liveUnsub: (() => void) | null = null;
let _visListener: (() => void) | null = null;
let _nudgeTimer: ReturnType<typeof setTimeout> | null = null;
// Monotonic refresh counter — see updateCounter's request-ordering guard.
let _refreshSeq = 0;
let _identityContext: IdentityContext | null = null;

const isCurrentContext = (context: IdentityContext | null): context is IdentityContext =>
    !!context
    && _identityContext?.epoch === context.epoch
    && _identityContext.serverId === context.serverId
    && _identityContext.userId === context.userId
    && JC.identity.isCurrent(context);

/** Freeze a value snapshot even when a host/test identity implementation does not. */
const immutableOwner = (context: IdentityContext | null): IdentityContext | null => context
    ? Object.freeze({ serverId: context.serverId, userId: context.userId, epoch: context.epoch })
    : null;

const stampOwner = <T extends HTMLElement>(element: T, context: IdentityContext): T => {
    element.dataset.jcIdentityEpoch = String(context.epoch);
    element.dataset.jcIdentityServer = context.serverId;
    element.dataset.jcIdentityUser = context.userId;
    return element;
};

// ── Helpers ──────────────────────────────────────────────────────────────
const ticksToTime = (ticks: number): string => {
    if (!ticks) return '0:00';
    const totalSec = Math.floor(ticks / 10000000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
};

// ── Theme-aware colours ──────────────────────────────────────────────────
const getAccentColor = (): string => {
    try {
        return JC?.themer?.getThemeVariables?.()?.primaryAccent || '#00a4dc';
    } catch (_) {
        return '#00a4dc';
    }
};

const applyThemeVars = (context?: IdentityContext): void => {
    if (context && !isCurrentContext(context)) return;
    document.documentElement.style.setProperty('--jc-as-accent', getAccentColor());
};

// ── CSS injection ────────────────────────────────────────────────────────
const injectStyles = (): void => {
    if (document.getElementById('jc-active-streams-styles')) return;
    const style = document.createElement('style');
    style.id = 'jc-active-streams-styles';
    style.textContent = `
#jc-active-streams {
  position: relative;
  overflow: visible;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  flex-shrink: 0;
}
#jc-active-streams .jc-as-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
  transition: color 0.3s;
}
#jc-active-streams .jc-as-sup {
  position: absolute;
  top: 2px;
  right: 2px;
  min-width: 12px;
  padding: 0;
  font-size: 11px;
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: -0.15px;
  pointer-events: none;
  text-align: center;
  white-space: nowrap;
  transition: color 0.3s;
}
#jc-active-streams .jc-as-sup:empty { display: none; }
#jc-active-streams.jc-as-active .jc-as-icon,
#jc-active-streams.jc-as-active .jc-as-sup { color: var(--jc-as-accent, #00a4dc); }
#jc-active-streams.jc-as-err .jc-as-icon   { color: #b91c1c; }
#jc-active-streams.jc-as-err .jc-as-sup    { color: #991b1b; }

/* Panel */
#jc-active-streams-panel {
  position: fixed;
  right: 12px;
  width: 360px;
  max-width: calc(100vw - 16px);
  max-height: calc(100vh - 72px);
  overflow-y: auto;
  background: rgba(18,18,18,0.97);
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 10px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.7);
  z-index: 9999;
  padding: 12px;
  display: none;
  flex-direction: column;
  gap: 10px;
  box-sizing: border-box;
}
#jc-active-streams-panel.jc-as-panel-open { display: flex; }

.jc-as-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(255,255,255,0.08);
}
.jc-as-panel-title {
  font-size: 13px;
  font-weight: 600;
  color: rgba(255,255,255,0.85);
  letter-spacing: 0.3px;
}
.jc-as-panel-close {
  background: none;
  border: none;
  color: rgba(255,255,255,0.4);
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  padding: 0;
  display: flex;
  align-items: center;
}
.jc-as-panel-close:hover { color: rgba(255,255,255,0.8); }
.jc-as-panel-empty {
  font-size: 13px;
  color: rgba(255,255,255,0.35);
  text-align: center;
  padding: 20px 0;
}

/* Session card */
.jc-as-card {
  background: rgba(255,255,255,0.07);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.jc-as-card-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}
.jc-as-card-info { flex: 1; min-width: 0; }
.jc-as-card-title {
  font-size: 13px;
  font-weight: 600;
  color: rgba(255,255,255,0.9);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.jc-as-card-subtitle {
  font-size: 11px;
  color: rgba(255,255,255,0.45);
  margin-top: 1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.jc-as-state {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 4px;
  flex-shrink: 0;
  letter-spacing: 0.4px;
  text-transform: uppercase;
}
.jc-as-state-playing { background: rgba(29,78,216,0.25); color: #93c5fd; }
.jc-as-state-paused  { background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.4); }

/* Progress */
.jc-as-progress-row {
  display: flex;
  align-items: center;
  gap: 7px;
}
.jc-as-progress-bar {
  flex: 1;
  height: 6px;
  background: rgba(255,255,255,0.1);
  border-radius: 3px;
  overflow: hidden;
}
.jc-as-progress-fill {
  position: relative;
  z-index: 1;
  height: 100%;
  background: var(--jc-as-accent, #00a4dc);
  border-radius: 3px;
  transition: width 0.4s;
}
.jc-as-progress-time {
  font-size: 10px;
  color: rgba(255,255,255,0.35);
  white-space: nowrap;
}

/* Badges */
.jc-as-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 2px;
}
.jc-as-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
  letter-spacing: 0.3px;
}
.jc-as-badge-direct    { background: rgba(16,185,129,0.15); color: #6ee7b7; }
.jc-as-badge-transcode { background: rgba(245,158,11,0.15); color: #fcd34d; }
.jc-as-badge-neutral   { background: rgba(255,255,255,0.07); color: rgba(255,255,255,0.45); }
.jc-as-badge-reason    { background: rgba(239,68,68,0.12); color: #fca5a5; font-style: italic; }

/* User row */
.jc-as-user {
  font-size: 11px;
  color: rgba(255,255,255,0.35);
  display: flex;
  align-items: center;
  gap: 4px;
}
.jc-as-user .material-icons { font-size: 13px; opacity: 0.5; }
.jc-as-avatar {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}

/* Panel open animation */
@keyframes jc-as-fadein {
  from { opacity: 0; transform: translateY(-6px); }
  to   { opacity: 1; transform: translateY(0); }
}
#jc-active-streams-panel.jc-as-panel-open {
  animation: jc-as-fadein 150ms ease forwards;
}

@media (max-width: 400px) {
  #jc-active-streams-panel {
    right: 8px;
    left: 8px;
    width: auto;
  }
}

/* Poster thumbnail */
.jc-as-card-with-poster {
  flex-direction: row !important;
  align-items: flex-start;
  gap: 10px !important;
}
.jc-as-poster {
  width: 40px;
  height: 60px;
  border-radius: 4px;
  object-fit: cover;
  flex-shrink: 0;
  background: rgba(255,255,255,0.06);
}
.jc-as-poster-placeholder {
  width: 40px;
  height: 60px;
  border-radius: 4px;
  background: rgba(255,255,255,0.06);
  flex-shrink: 0;
}
.jc-as-card-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }

/* Clickable title */
.jc-as-card-title-link {
  cursor: pointer;
  text-decoration: none;
  color: inherit;
}
.jc-as-card-title-link:hover { text-decoration: underline; }

/* Transcode buffer behind the progress bar */
.jc-as-progress-bar { position: relative; }
.jc-as-transcode-fill {
  position: absolute;
  top: 0; left: 0;
  z-index: 0;
  height: 100%;
  background: rgba(245,158,11,0.8);
  border-radius: 3px;
  transition: width 0.4s;
}

/* Last updated footer */
.jc-as-panel-footer {
  font-size: 10px;
  color: rgba(255,255,255,0.45);
  text-align: right;
  padding-top: 6px;
  border-top: 1px solid rgba(255,255,255,0.08);
  margin-top: 2px;
}

/* Refresh button */
.jc-as-refresh-btn {
  background: none;
  border: none;
  color: rgba(255,255,255,0.4);
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  padding: 0;
  display: flex;
  align-items: center;
  margin-right: 4px;
  transition: color 0.2s;
}
.jc-as-refresh-btn:hover { color: rgba(255,255,255,0.8); }
.jc-as-refresh-btn.jc-as-refreshing { animation: jc-as-spin 0.6s linear; }
@keyframes jc-as-spin {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}

/* ── Broadcast button ──────────────────────────────────────────────────── */
.jc-as-broadcast-btn {
  background: none;
  border: none;
  color: rgba(255,255,255,0.4);
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  padding: 0;
  display: flex;
  align-items: center;
  margin-right: 4px;
  transition: color 0.2s;
}
.jc-as-broadcast-btn:hover { color: var(--jc-as-accent, #00a4dc); }
.jc-as-broadcast-btn.jc-as-broadcast-active { color: var(--jc-as-accent, #00a4dc); }

/* ── Broadcast compose form ────────────────────────────────────────────── */
.jc-as-broadcast-form {
  display: none;
  flex-direction: column;
  gap: 6px;
  padding: 10px 0 4px;
  border-bottom: 1px solid rgba(255,255,255,0.08);
  animation: jc-as-fadein 150ms ease forwards;
}
.jc-as-broadcast-form.jc-as-broadcast-form-open {
  display: flex;
}
.jc-as-broadcast-input,
.jc-as-broadcast-textarea {
  background: rgba(255,255,255,0.07);
  border: 1px solid rgba(255,255,255,0.15);
  border-radius: 6px;
  color: #fff;
  padding: 8px 10px;
  font-size: 12px;
  font-family: inherit;
  outline: none;
  width: 100%;
  box-sizing: border-box;
  transition: border-color 0.2s;
}
.jc-as-broadcast-input:focus,
.jc-as-broadcast-textarea:focus {
  border-color: var(--jc-as-accent, #00a4dc);
}
.jc-as-broadcast-input::placeholder,
.jc-as-broadcast-textarea::placeholder {
  color: rgba(255,255,255,0.3);
  font-style: italic;
}
.jc-as-broadcast-textarea {
  resize: vertical;
  min-height: 72px;
}
.jc-as-broadcast-field-label {
  font-size: 11px;
  font-weight: 600;
  color: rgba(255,255,255,0.65);
  letter-spacing: 0.3px;
  text-transform: uppercase;
  margin-bottom: 2px;
}
.jc-as-broadcast-timeout-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.jc-as-broadcast-timeout-label {
  font-size: 11px;
  color: rgba(255,255,255,0.45);
  white-space: nowrap;
}
.jc-as-broadcast-timeout-input {
  background: rgba(255,255,255,0.07);
  border: 1px solid rgba(255,255,255,0.15);
  border-radius: 6px;
  color: #fff;
  padding: 6px 8px;
  font-size: 12px;
  font-family: inherit;
  outline: none;
  width: 72px;
  box-sizing: border-box;
  transition: border-color 0.2s;
}
.jc-as-broadcast-timeout-input:focus {
  border-color: var(--jc-as-accent, #00a4dc);
}
.jc-as-broadcast-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.jc-as-broadcast-send {
  background: var(--jc-as-accent, #00a4dc);
  border: none;
  border-radius: 6px;
  color: #fff;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  padding: 6px 14px;
  transition: opacity 0.2s;
}
.jc-as-broadcast-send:hover { opacity: 0.85; }
.jc-as-broadcast-send:disabled { opacity: 0.5; cursor: not-allowed; }
.jc-as-broadcast-cancel {
  background: rgba(255,255,255,0.08);
  border: 1px solid rgba(255,255,255,0.15);
  border-radius: 6px;
  color: rgba(255,255,255,0.7);
  cursor: pointer;
  font-size: 12px;
  padding: 6px 12px;
  transition: background 0.2s;
}
.jc-as-broadcast-cancel:hover { background: rgba(255,255,255,0.14); }
.jc-as-broadcast-result {
  font-size: 11px;
  padding: 5px 8px;
  border-radius: 5px;
  display: none;
}
.jc-as-broadcast-result.jc-as-broadcast-ok {
  display: block;
  background: rgba(16,185,129,0.15);
  color: #6ee7b7;
}
.jc-as-broadcast-result.jc-as-broadcast-err {
  display: block;
  background: rgba(239,68,68,0.12);
  color: #fca5a5;
}
.jc-as-broadcast-field-note {
  font-size: 10px;
  color: rgba(255,193,7,0.8);
  line-height: 1.4;
  padding: 3px 0 1px;
}

/* ── Per-session admin actions (stop / message) ────────────────────────── */
.jc-as-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}
.jc-as-action-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: rgba(255,255,255,0.07);
  border: 1px solid rgba(255,255,255,0.14);
  border-radius: 6px;
  color: rgba(255,255,255,0.75);
  cursor: pointer;
  font-size: 11px;
  font-weight: 600;
  padding: 4px 9px;
  font-family: inherit;
  transition: background 0.2s, color 0.2s, border-color 0.2s;
}
.jc-as-action-btn:hover { background: rgba(255,255,255,0.14); color: #fff; }
.jc-as-action-btn .material-icons { font-size: 15px; }
.jc-as-action-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.jc-as-action-btn-stop { color: #fca5a5; border-color: rgba(239,68,68,0.35); }
.jc-as-action-btn-stop:hover { background: rgba(239,68,68,0.18); color: #fecaca; }
.jc-as-action-btn-stop.jc-as-confirming {
  background: rgba(239,68,68,0.22);
  color: #fee2e2;
  border-color: rgba(239,68,68,0.6);
}
.jc-as-action-btn.jc-as-action-active {
  background: var(--jc-as-accent, #00a4dc);
  border-color: var(--jc-as-accent, #00a4dc);
  color: #fff;
}

/* Per-session message form (reuses the broadcast field styling) */
.jc-as-msg-form {
  display: none;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
  padding-top: 8px;
  border-top: 1px solid rgba(255,255,255,0.08);
  animation: jc-as-fadein 150ms ease forwards;
}
.jc-as-msg-form.jc-as-msg-form-open { display: flex; }

/* Quick-preset chips (shared by broadcast + per-session forms) */
.jc-as-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.jc-as-preset {
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 12px;
  color: rgba(255,255,255,0.65);
  cursor: pointer;
  font-size: 10px;
  padding: 3px 9px;
  font-family: inherit;
  transition: background 0.2s, color 0.2s;
}
.jc-as-preset:hover { background: rgba(255,255,255,0.14); color: #fff; }`;
    document.head.appendChild(style);
};

// ── Visibility check ─────────────────────────────────────────────────────
// Admins always see it. Non-admins only if ActiveStreamsAllUsers is enabled.
const isVisible = (): boolean => {
    const isAdmin = JC?.currentUser?.Policy?.IsAdministrator === true;
    if (isAdmin) return true;
    return JC?.pluginConfig?.ActiveStreamsAllUsers === true;
};

// ── API — uses plugin proxy so non-admins don't need Sessions permission ─
const fetchSessions = async (context: IdentityContext): Promise<SessionView[] | null> => {
    if (!isCurrentContext(context)) return null;
    try {
        // Core throws on non-OK responses — caught below, returning null
        // exactly like the old !resp.ok branch.
        const sessions = await JC.core.api.plugin('/active-streams/sessions') as SessionView[];
        return isCurrentContext(context) ? sessions : null;
    } catch (_) {
        return null;
    }
};

// ── Badge builder ────────────────────────────────────────────────────────
const buildBadgeElements = (session: SessionView): HTMLElement[] => {
    const badges: Array<{ label: string; cls: string }> = [];
    const ts = session.TranscodingInfo;
    const ps: SessionPlayState = session.PlayState || {};

    if (ts && ts.IsVideoDirect === false) {
        badges.push({ label: 'Transcoding', cls: 'jc-as-badge-transcode' });
        if (ts.VideoCodec) badges.push({ label: ts.VideoCodec.toUpperCase(), cls: 'jc-as-badge-neutral' });
        if (ts.AudioCodec) badges.push({ label: ts.AudioCodec.toUpperCase(), cls: 'jc-as-badge-neutral' });
        if (ts.Bitrate) {
            const kbps = Math.round(ts.Bitrate / 1000);
            badges.push({ label: kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} kbps`, cls: 'jc-as-badge-neutral' });
        }
        if (ts.Width && ts.Height) {
            badges.push({ label: `${ts.Width}×${ts.Height}`, cls: 'jc-as-badge-neutral' });
        }
        if (ts.Framerate) {
            badges.push({ label: `${Math.round(ts.Framerate)}fps`, cls: 'jc-as-badge-neutral' });
        }
    } else {
        badges.push({ label: 'Direct Play', cls: 'jc-as-badge-direct' });
        const stream = session.NowPlayingItem?.MediaStreams?.find((s) => s.Type === 'Video');
        if (stream?.Codec) badges.push({ label: stream.Codec.toUpperCase(), cls: 'jc-as-badge-neutral' });
        if (stream?.BitRate) {
            const kbps = Math.round(stream.BitRate / 1000);
            badges.push({ label: kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} kbps`, cls: 'jc-as-badge-neutral' });
        }
    }

    if (ps.PlayMethod === 'Transcode' && ts?.TranscodeReasons?.length) {
        const streams: SessionMediaStream[] = session.NowPlayingItem?.MediaStreams || [];
        for (const rawReason of ts.TranscodeReasons) {
            const reason = rawReason.replace(/([A-Z])/g, ' $1').trim();
            badges.push({ label: reason, cls: 'jc-as-badge-reason' });

            // Append codec conversion arrow for codec-related reasons
            if (rawReason === 'AudioCodecNotSupported') {
                const srcCodec = streams.find((s) => s.Type === 'Audio')?.Codec;
                const dstCodec = ts.AudioCodec;
                if (srcCodec && dstCodec && srcCodec.toLowerCase() !== dstCodec.toLowerCase()) {
                    badges.push({ label: `${srcCodec.toUpperCase()} → ${dstCodec.toUpperCase()}`, cls: 'jc-as-badge-reason' });
                }
            } else if (rawReason === 'VideoCodecNotSupported') {
                const srcCodec = streams.find((s) => s.Type === 'Video')?.Codec;
                const dstCodec = ts.VideoCodec;
                if (srcCodec && dstCodec && srcCodec.toLowerCase() !== dstCodec.toLowerCase()) {
                    badges.push({ label: `${srcCodec.toUpperCase()} → ${dstCodec.toUpperCase()}`, cls: 'jc-as-badge-reason' });
                }
            }
        }
    }

    return badges.map(b => {
        const span = document.createElement('span');
        span.className = `jc-as-badge ${b.cls}`;
        span.textContent = b.label;
        return span;
    });
};

// ── Session card builder ─────────────────────────────────────────────────
const buildSessionCard = (
    session: SessionView,
    context: IdentityContext,
    index?: number,
    restore?: CardUiState,
): HTMLElement => {
    // Caller (renderPanel) only passes sessions with a NowPlayingItem.
    const item = session.NowPlayingItem as SessionNowPlaying;
    const ps: SessionPlayState = session.PlayState || {};
    const isPaused = ps.IsPaused;

    const title = item.SeriesName || item.Name || 'Unknown';
    const subtitle = item.SeriesName
        ? `S${String(item.ParentIndexNumber || 0).padStart(2, '0')}E${String(item.IndexNumber || 0).padStart(2, '0')} · ${item.Name}`
        : (item.ProductionYear ? String(item.ProductionYear) : '');

    const pos = ps.PositionTicks || 0;
    const dur = item.RunTimeTicks || 0;
    const pct = dur ? Math.max(0, Math.min(100, (pos / dur) * 100)).toFixed(1) : 0;

    const card = stampOwner(document.createElement('div'), context);
    card.className = 'jc-as-card jc-as-card-with-poster';
    // Stable key + structural signature for in-place live updates — see
    // applyLiveUpdate / panelMatchesSessions.
    card.setAttribute('data-session-id', sessionCardKey(session, index));
    card.setAttribute('data-live-sig', sessionSig(session));

    // ── Poster thumbnail ─────────────────────────────────────────────────
    // For episodes, prefer the series poster over the episode thumbnail.
    const seriesTag = item.SeriesPrimaryImageTag;
    const seriesId  = item.SeriesId;
    const primaryTag = item.ImageTags?.Primary;
    const posterId  = (seriesId && seriesTag) ? seriesId : item.Id;
    const posterTag = (seriesId && seriesTag) ? seriesTag : primaryTag;
    if (posterTag && posterId && typeof ApiClient !== 'undefined') {
        const poster = document.createElement('img');
        poster.className = 'jc-as-poster';
        poster.alt = '';
        poster.loading = 'lazy';
        poster.src = (ApiClient as any).getImageUrl(posterId, { type: 'Primary', tag: posterTag, height: 120, quality: 80 });
        poster.addEventListener('error', () => {
            if (!isCurrentContext(context)) return;
            poster.replaceWith(placeholder());
        });
        card.appendChild(poster);
    } else {
        card.appendChild(placeholder());
    }

    function placeholder(): HTMLElement {
        const ph = document.createElement('div');
        ph.className = 'jc-as-poster-placeholder';
        return ph;
    }

    // ── Main content column ──────────────────────────────────────────────
    const main = document.createElement('div');
    main.className = 'jc-as-card-main';

    // Top row
    const top = document.createElement('div');
    top.className = 'jc-as-card-top';

    const info = document.createElement('div');
    info.className = 'jc-as-card-info';

    const titleEl = document.createElement('div');
    titleEl.className = 'jc-as-card-title';

    // Make title clickable if we have an item ID
    if (item.Id && typeof ApiClient !== 'undefined') {
        const link = document.createElement('a');
        link.className = 'jc-as-card-title-link';
        link.textContent = title;
        link.href = '#';
        link.addEventListener('click', (e) => {
            if (!isCurrentContext(context)) return;
            e.preventDefault();
            try {
                if (typeof Emby !== 'undefined' && (Emby as any).Page?.showItem) {
                    (Emby as any).Page.showItem(item.Id);
                } else {
                    window.location.hash = `#!/details?id=${item.Id}`;
                }
            } catch (_) {
                window.location.hash = `#!/details?id=${item.Id}`;
            }
        });
        titleEl.appendChild(link);
    } else {
        titleEl.textContent = title;
    }
    info.appendChild(titleEl);

    if (subtitle) {
        const subEl = document.createElement('div');
        subEl.className = 'jc-as-card-subtitle';
        subEl.textContent = subtitle;
        info.appendChild(subEl);
    }

    const stateEl = document.createElement('span');
    stateEl.className = `jc-as-state ${isPaused ? 'jc-as-state-paused' : 'jc-as-state-playing'}`;
    stateEl.textContent = isPaused
        ? (JC.t?.('downloads_status_paused') || 'Paused')
        : (JC.t?.('toast_playing') || 'Playing');

    top.appendChild(info);
    top.appendChild(stateEl);
    main.appendChild(top);

    // Progress row
    const ts = session.TranscodingInfo;
    if (dur) {
        const progressRow = document.createElement('div');
        progressRow.className = 'jc-as-progress-row';

        const bar = document.createElement('div');
        bar.className = 'jc-as-progress-bar';
        bar.setAttribute('role', 'progressbar');
        bar.setAttribute('aria-valuemin', '0');
        bar.setAttribute('aria-valuemax', '100');
        bar.setAttribute('aria-valuenow', String(pct));
        bar.setAttribute('aria-valuetext', `${ticksToTime(pos)} / ${ticksToTime(dur)}`);

        // Transcoding buffer — amber layer behind playback position
        if (ts && ts.CompletionPercentage != null) {
            const transcodeFill = document.createElement('div');
            transcodeFill.className = 'jc-as-transcode-fill';
            transcodeFill.style.width = `${Math.max(0, Math.min(100, ts.CompletionPercentage)).toFixed(1)}%`;
            bar.appendChild(transcodeFill);
        }

        const fill = document.createElement('div');
        fill.className = 'jc-as-progress-fill';
        fill.style.width = `${pct}%`;
        bar.appendChild(fill);

        const timeEl = document.createElement('span');
        timeEl.className = 'jc-as-progress-time';
        timeEl.textContent = `${ticksToTime(pos)} / ${ticksToTime(dur)}`;

        progressRow.appendChild(bar);
        progressRow.appendChild(timeEl);
        main.appendChild(progressRow);
    }

    // Badges
    const badgesRow = document.createElement('div');
    badgesRow.className = 'jc-as-badges';
    buildBadgeElements(session).forEach(b => badgesRow.appendChild(b));
    main.appendChild(badgesRow);

    // User row
    const userRow = document.createElement('div');
    userRow.className = 'jc-as-user';

    if (session.UserId && typeof ApiClient !== 'undefined') {
        const img = document.createElement('img');
        img.className = 'jc-as-avatar';
        img.alt = '';
        img.src = ApiClient.getUrl(`Users/${session.UserId}/Images/Primary`) + '?height=20&quality=80';

        const fallback = document.createElement('span');
        fallback.className = 'material-icons';
        fallback.textContent = 'person';
        fallback.style.display = 'none';

        img.addEventListener('error', () => {
            if (!isCurrentContext(context)) return;
            img.style.display = 'none';
            fallback.style.display = 'inline';
        });

        userRow.appendChild(img);
        userRow.appendChild(fallback);
    } else {
        const icon = document.createElement('span');
        icon.className = 'material-icons';
        icon.textContent = 'person';
        userRow.appendChild(icon);
    }

    const clientParts = [session.UserName, session.Client, session.DeviceName].filter(Boolean);
    const userLabel = document.createElement('span');
    userLabel.textContent = clientParts.join(' · ');
    userRow.appendChild(userLabel);

    main.appendChild(userRow);

    // Admin session-control actions (stop / targeted message). Only offered to
    // admins on sessions the client can actually remote-control.
    if (isAdmin() && session.SupportsRemoteControl && session.Id) {
        main.appendChild(buildSessionActions(session, context, restore));
    }

    // RemoteEndPoint — null for non-admins (stripped server-side)
    if (session.RemoteEndPoint) {
        const ipRow = document.createElement('div');
        ipRow.className = 'jc-as-user';
        const ipIcon = document.createElement('span');
        ipIcon.className = 'material-icons';
        ipIcon.textContent = 'router';
        const ipLabel = document.createElement('span');
        ipLabel.textContent = session.RemoteEndPoint;
        ipRow.appendChild(ipIcon);
        ipRow.appendChild(ipLabel);
        main.appendChild(ipRow);
    }

    card.appendChild(main);
    return card;
};

// ── Quick-preset messages (localized; static, so safe as textContent) ──────
const messagePresets = (): string[] => [
    JC.t?.('session_control_preset_stopping') || 'Your stream is being stopped by an administrator.',
    JC.t?.('session_control_preset_restart') || 'The server will restart shortly — please stop your stream.',
    JC.t?.('session_control_preset_bandwidth') || 'Please lower your playback quality — the server is under heavy load.',
    JC.t?.('session_control_preset_takedown') || 'This title is being removed; playback will stop shortly.',
];

/** A row of preset chips; clicking one fills the target textarea. */
const buildPresetRow = (target: HTMLTextAreaElement, context: IdentityContext): HTMLElement => {
    const row = document.createElement('div');
    row.className = 'jc-as-presets';
    for (const preset of messagePresets()) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'jc-as-preset';
        chip.textContent = preset;
        chip.addEventListener('click', (e) => {
            if (!isCurrentContext(context)) return;
            e.stopPropagation();
            target.value = preset;
            target.focus();
        });
        row.appendChild(chip);
    }
    return row;
};

// ── Per-session admin actions ──────────────────────────────────────────────
const sendSessionStop = async (sessionId: string, context: IdentityContext): Promise<void> => {
    if (!isCurrentContext(context)) return;
    try {
        // skipRetry: stopping is not idempotent-safe to auto-repeat.
        await JC.core.api.plugin(`/active-streams/sessions/${encodeURIComponent(sessionId)}/stop`, {
            method: 'POST',
            skipRetry: true,
        });
        if (!isCurrentContext(context)) return;
        notify(JC.t?.('session_control_stopped') || 'Stream stopped');
        void updateCounter({ live: true }, context);
    } catch (err) {
        if (!isCurrentContext(context)) return;
        notify(JC.t?.('session_control_stop_failed') || 'Failed to stop the stream');
        console.warn(`${LOG} stop session failed:`, err);
    }
};

const sendSessionMessage = async (
    sessionId: string,
    text: string,
    timeoutMs: number,
    resultEl: HTMLElement,
    context: IdentityContext,
): Promise<void> => {
    if (!isCurrentContext(context)) return;
    try {
        await JC.core.api.plugin(`/active-streams/sessions/${encodeURIComponent(sessionId)}/message`, {
            method: 'POST',
            body: { text, timeoutMs },
            skipRetry: true,
        });
        if (!isCurrentContext(context)) return;
        resultEl.className = 'jc-as-broadcast-result jc-as-broadcast-ok';
        resultEl.textContent = JC.t?.('session_control_message_sent') || 'Message sent';
    } catch (err) {
        if (!isCurrentContext(context)) return;
        resultEl.className = 'jc-as-broadcast-result jc-as-broadcast-err';
        resultEl.textContent = JC.t?.('session_control_message_failed') || 'Failed to send message';
        console.warn(`${LOG} message session failed:`, err);
    }
};

/** The stop + message action row (with an inline per-session message form). */
const buildSessionActions = (
    session: SessionView,
    context: IdentityContext,
    restore?: CardUiState,
): HTMLElement => {
    const sessionId = String(session.Id);
    const wrap = stampOwner(document.createElement('div'), context);

    const row = document.createElement('div');
    row.className = 'jc-as-actions';

    // ── Stop (two-click confirm — no blocking dialog) ─────────────────────
    const stopBtn = document.createElement('button');
    stopBtn.type = 'button';
    stopBtn.className = 'jc-as-action-btn jc-as-action-btn-stop';
    const stopIcon = document.createElement('span');
    stopIcon.className = 'material-icons';
    stopIcon.textContent = 'stop_circle';
    const stopLabel = document.createElement('span');
    stopLabel.textContent = JC.t?.('session_control_stop') || 'Stop';
    stopBtn.appendChild(stopIcon);
    stopBtn.appendChild(stopLabel);

    let confirmTimer: ReturnType<typeof setTimeout> | null = null;
    const resetStop = (): void => {
        if (!isCurrentContext(context)) return;
        stopBtn.classList.remove('jc-as-confirming');
        stopLabel.textContent = JC.t?.('session_control_stop') || 'Stop';
        if (confirmTimer) { clearTimeout(confirmTimer); confirmTimer = null; }
    };
    // Arm the two-click confirm state (also used to restore it across a rebuild),
    // always (re)starting the 4s auto-reset timer so a restored confirm can't
    // stay armed forever.
    const armConfirm = (): void => {
        if (!isCurrentContext(context)) return;
        stopBtn.classList.add('jc-as-confirming');
        stopLabel.textContent = JC.t?.('session_control_stop_confirm') || 'Confirm stop?';
        if (confirmTimer) clearTimeout(confirmTimer);
        confirmTimer = setTimeout(resetStop, 4000);
    };
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- async click handler
    stopBtn.addEventListener('click', async (e) => {
        if (!isCurrentContext(context)) return;
        e.stopPropagation();
        if (!stopBtn.classList.contains('jc-as-confirming')) {
            armConfirm();
            return;
        }
        resetStop();
        stopBtn.disabled = true;
        await sendSessionStop(sessionId, context);
        if (!isCurrentContext(context)) return;
        stopBtn.disabled = false;
    });

    // ── Message (toggles an inline compose form) ──────────────────────────
    const msgBtn = document.createElement('button');
    msgBtn.type = 'button';
    msgBtn.className = 'jc-as-action-btn';
    const msgIcon = document.createElement('span');
    msgIcon.className = 'material-icons';
    msgIcon.textContent = 'message';
    const msgLabel = document.createElement('span');
    msgLabel.textContent = JC.t?.('session_control_message') || 'Message';
    msgBtn.appendChild(msgIcon);
    msgBtn.appendChild(msgLabel);

    row.appendChild(stopBtn);
    row.appendChild(msgBtn);
    wrap.appendChild(row);

    // ── Compose form ──────────────────────────────────────────────────────
    const form = document.createElement('div');
    form.className = 'jc-as-msg-form';

    const textArea = document.createElement('textarea');
    textArea.className = 'jc-as-broadcast-textarea';
    textArea.placeholder = JC.t?.('session_control_message_placeholder') || 'Message to this session…';
    textArea.maxLength = 1000;

    const presets = buildPresetRow(textArea, context);

    const resultEl = document.createElement('div');
    resultEl.className = 'jc-as-broadcast-result';

    const actions = document.createElement('div');
    actions.className = 'jc-as-broadcast-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'jc-as-broadcast-cancel';
    cancelBtn.textContent = JC.t?.('session_control_cancel') || 'Cancel';
    const sendBtn = document.createElement('button');
    sendBtn.type = 'button';
    sendBtn.className = 'jc-as-broadcast-send';
    sendBtn.textContent = JC.t?.('session_control_send') || 'Send';
    actions.appendChild(cancelBtn);
    actions.appendChild(sendBtn);

    form.appendChild(presets);
    form.appendChild(textArea);
    form.appendChild(resultEl);
    form.appendChild(actions);
    wrap.appendChild(form);

    const closeForm = (): void => {
        if (!isCurrentContext(context)) return;
        msgBtn.classList.remove('jc-as-action-active');
        form.classList.remove('jc-as-msg-form-open');
        resultEl.className = 'jc-as-broadcast-result';
        resultEl.textContent = '';
    };
    msgBtn.addEventListener('click', (e) => {
        if (!isCurrentContext(context)) return;
        e.stopPropagation();
        const open = form.classList.toggle('jc-as-msg-form-open');
        msgBtn.classList.toggle('jc-as-action-active', open);
        if (open) { resultEl.textContent = ''; resultEl.className = 'jc-as-broadcast-result'; textArea.focus(); }
    });
    cancelBtn.addEventListener('click', (e) => {
        if (!isCurrentContext(context)) return;
        e.stopPropagation();
        closeForm();
    });
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- async click handler
    sendBtn.addEventListener('click', async (e) => {
        if (!isCurrentContext(context)) return;
        e.stopPropagation();
        const text = textArea.value.trim();
        if (!text) { textArea.focus(); return; }
        sendBtn.disabled = true;
        resultEl.className = 'jc-as-broadcast-result';
        resultEl.textContent = '';
        await sendSessionMessage(sessionId, text, 10000, resultEl, context);
        if (!isCurrentContext(context)) return;
        sendBtn.disabled = false;
    });

    // Restore transient interaction state carried over from a structural
    // rebuild (see captureCardUiState): a re-armed stop-confirm keeps its 4s
    // auto-reset; a re-opened compose form keeps its typed text (no auto-focus,
    // to avoid yanking focus on an unrelated background rebuild).
    if (restore?.confirmArmed) armConfirm();
    if (restore?.composeOpen) {
        form.classList.add('jc-as-msg-form-open');
        msgBtn.classList.add('jc-as-action-active');
        textArea.value = restore.composeText;
    }

    return wrap;
};

// ── Live-update helpers ────────────────────────────────────────────────────
// Stable per-card key. Admins get the real session Id (also the action target);
// non-admins get a non-sensitive composite (fields already shown on the card).
// The composite folds in the now-playing item id and a per-refresh occurrence
// index so two non-admin sessions that share user/client/device (identical
// composites) still resolve to DISTINCT cards — otherwise they collide and one
// card stops receiving live updates. `index` is the position within the
// fetched active-session list, which renderPanel / applyLiveUpdate /
// panelMatchesSessions all iterate in the same order, so the key is consistent
// across a refresh. Exported for unit testing.
export const sessionCardKey = (s: SessionView, index?: number): string => {
    if (s.Id) return String(s.Id);
    const composite = `${s.UserName || ''}|${s.Client || ''}|${s.DeviceName || ''}|${s.NowPlayingItem?.Id || ''}`;
    return index == null ? composite : `${composite}#${index}`;
};

// Structural signature: an in-place tick is only safe when the card's identity
// AND its non-progress structure are unchanged. If the session switches item,
// flips direct-play↔transcode, or its badge-driving quality fields shift, the
// signature changes → a full rebuild (so the title/poster/badges never go stale
// under a moving progress bar). The tick path (applyLiveUpdate) only refreshes
// progress/state, so the live-varying badge fields (transcode bitrate /
// resolution / framerate / reasons) must be folded in here — otherwise the
// badges would freeze until an unrelated structural change forced a rebuild.
// Exported for unit testing.
export const sessionSig = (s: SessionView): string => {
    const item: SessionNowPlaying = s.NowPlayingItem || {};
    const ps: SessionPlayState = s.PlayState || {};
    const ts = s.TranscodingInfo;
    const mode = ts ? (ts.IsVideoDirect === false ? 'tc' : 'dp') : 'none';
    const badgeSig = ts
        ? `${ts.Bitrate || ''}/${ts.Width || ''}x${ts.Height || ''}/${ts.Framerate || ''}/${(ts.TranscodeReasons || []).join(',')}`
        : '';
    return `${item.Id || ''}|${ps.PlayMethod || ''}|${mode}|${badgeSig}`;
};

const activeSessions = (sessions: SessionView[] | null): SessionView[] => (sessions || []).filter(s => s.NowPlayingItem);

/** Update the panel title to reflect the current active-stream count. */
const updatePanelTitle = (active: SessionView[], context: IdentityContext): void => {
    if (!isCurrentContext(context)) return;
    const titleEl = document.querySelector('#jc-active-streams-panel .jc-as-panel-title');
    if (!titleEl) return;
    if (active.length) {
        const tpl = JC.t?.('active_streams_count') || '{count} Active Stream|{count} Active Streams';
        const parts = tpl.split('|');
        const singular = parts[0] || '{count} Active Stream';
        const plural = parts[1] || parts[0] || '{count} Active Streams';
        titleEl.textContent = (active.length === 1 ? singular : plural).replace('{count}', String(active.length));
    } else {
        titleEl.textContent = JC.t?.('active_streams_none') || 'No Active Streams';
    }
};

/** Update (creating if needed) the "last updated" footer. */
const updateFooter = (context: IdentityContext): void => {
    if (!isCurrentContext(context)) return;
    const panel = document.getElementById('jc-active-streams-panel');
    if (!panel) return;
    let footer = panel.querySelector('.jc-as-panel-footer');
    if (!footer) {
        footer = document.createElement('div');
        footer.className = 'jc-as-panel-footer';
        panel.appendChild(footer);
    }
    if (_lastUpdated) footer.textContent = `Updated ${_lastUpdated.toLocaleTimeString()}`;
};

/**
 * Does the open panel already show exactly this set of sessions? When true a
 * live tick updates progress/state IN PLACE (R2/R7) instead of rebuilding every
 * card (which would reload posters and flicker). A structural change (a stream
 * started/stopped) returns false → a full renderPanel.
 */
export const panelMatchesSessions = (sessions: SessionView[]): boolean => {
    const body = document.querySelector('#jc-active-streams-panel .jc-as-panel-body');
    if (!body) return false;
    const cards = Array.from(body.querySelectorAll('.jc-as-card[data-session-id]'));
    const active = activeSessions(sessions);
    if (cards.length !== active.length || active.length === 0) return false;
    // Match on identity AND structural signature: a card whose session switched
    // item, flipped direct-play↔transcode, or changed a badge-driving quality
    // field must be rebuilt, not tick-updated.
    const renderedSig = new Map(cards.map(c => [c.getAttribute('data-session-id'), c.getAttribute('data-live-sig')]));
    return active.every((s, i) => renderedSig.get(sessionCardKey(s, i)) === sessionSig(s));
};

/** Update progress bars / play-state in place, leaving card structure intact. */
const applyLiveUpdate = (sessions: SessionView[], context: IdentityContext): void => {
    if (!isCurrentContext(context)) return;
    const body = document.querySelector('#jc-active-streams-panel .jc-as-panel-body');
    if (!body) return;
    const byId = new Map<string | null, Element>();
    body.querySelectorAll('.jc-as-card[data-session-id]').forEach(c => byId.set(c.getAttribute('data-session-id'), c));

    const active = activeSessions(sessions);
    active.forEach((s, i) => {
        const card = byId.get(sessionCardKey(s, i));
        if (!card) return;
        const ps: SessionPlayState = s.PlayState || {};
        const item: SessionNowPlaying = s.NowPlayingItem || {};
        const pos = ps.PositionTicks || 0;
        const dur = item.RunTimeTicks || 0;

        const fill = card.querySelector<HTMLElement>('.jc-as-progress-fill');
        if (fill && dur) fill.style.width = `${Math.min(100, (pos / dur) * 100).toFixed(1)}%`;

        const ts = s.TranscodingInfo;
        const tfill = card.querySelector<HTMLElement>('.jc-as-transcode-fill');
        if (tfill && ts && ts.CompletionPercentage != null) {
            tfill.style.width = `${Math.min(100, ts.CompletionPercentage).toFixed(1)}%`;
        }

        const timeEl = card.querySelector<HTMLElement>('.jc-as-progress-time');
        if (timeEl && dur) timeEl.textContent = `${ticksToTime(pos)} / ${ticksToTime(dur)}`;

        const stateEl = card.querySelector<HTMLElement>('.jc-as-state');
        if (stateEl) {
            const isPaused = ps.IsPaused;
            stateEl.className = `jc-as-state ${isPaused ? 'jc-as-state-paused' : 'jc-as-state-playing'}`;
            stateEl.textContent = isPaused
                ? (JC.t?.('downloads_status_paused') || 'Paused')
                : (JC.t?.('toast_playing') || 'Playing');
        }
    });
    updatePanelTitle(active, context);
    updateFooter(context);
};

// ── Card UI-state preservation across structural rebuilds ──────────────────
// A structural rebuild (renderPanel) discards every card DOM node. If an admin
// had a per-session compose form open (with typed text) or a stop-confirm
// armed, that transient interaction state would be lost mid-action. Capture it
// keyed by card id before the rebuild and restore it (in buildSessionActions)
// for cards still present afterwards.
interface CardUiState { composeOpen: boolean; composeText: string; confirmArmed: boolean }

const captureCardUiState = (body: Element): Map<string, CardUiState> => {
    const state = new Map<string, CardUiState>();
    body.querySelectorAll('.jc-as-card[data-session-id]').forEach(card => {
        const key = card.getAttribute('data-session-id');
        if (!key) return;
        const composeOpen = card.querySelector('.jc-as-msg-form')?.classList.contains('jc-as-msg-form-open') === true;
        const composeText = card.querySelector<HTMLTextAreaElement>('.jc-as-msg-form .jc-as-broadcast-textarea')?.value || '';
        const confirmArmed = card.querySelector('.jc-as-action-btn-stop')?.classList.contains('jc-as-confirming') === true;
        if (composeOpen || confirmArmed) state.set(key, { composeOpen, composeText, confirmArmed });
    });
    return state;
};

// ── Panel renderer ───────────────────────────────────────────────────────
const renderPanel = (sessions: SessionView[] | null, context: IdentityContext): void => {
    if (!isCurrentContext(context)) return;
    const panel = document.getElementById('jc-active-streams-panel');
    if (!panel) return;

    // A null sessions arg means the fetch failed (not "zero streams"). Show an
    // error row so the open panel agrees with the header button's red error
    // state instead of collapsing null → "No active streams" (W4-ERR-7).
    if (sessions === null) {
        const errText = JC.t?.('active_streams_load_error') || 'Failed to fetch sessions';
        const titleErr = panel.querySelector('.jc-as-panel-title');
        if (titleErr) titleErr.textContent = errText;
        const errBody = panel.querySelector('.jc-as-panel-body');
        if (errBody) {
            while (errBody.firstChild) errBody.removeChild(errBody.firstChild);
            const errRow = document.createElement('div');
            errRow.className = 'jc-as-panel-empty jc-as-panel-error';
            errRow.textContent = errText;
            errBody.appendChild(errRow);
        }
        return;
    }

    const active = activeSessions(sessions);
    updatePanelTitle(active, context);

    const body = panel.querySelector('.jc-as-panel-body');
    if (!body) return;

    // Preserve open compose forms / armed stop-confirms across the rebuild.
    const prevState = captureCardUiState(body);

    while (body.firstChild) body.removeChild(body.firstChild);

    if (!active.length) {
        const empty = document.createElement('div');
        empty.className = 'jc-as-panel-empty';
        empty.textContent = JC.t?.('active_streams_none') || 'No active streams';
        body.appendChild(empty);
    } else {
        active.forEach((session, i) => body.appendChild(buildSessionCard(
            session,
            context,
            i,
            prevState.get(sessionCardKey(session, i)),
        )));
    }

    updateFooter(context);
};

// ── Counter updater ──────────────────────────────────────────────────────
const updateHeaderButton = (sessions: SessionView[] | null, context: IdentityContext): void => {
    if (!isCurrentContext(context)) return;
    const btn = document.getElementById('jc-active-streams');
    if (!btn) return;

    const iconEl = btn.querySelector<HTMLElement>('.jc-as-icon')!;
    const supEl = btn.querySelector<HTMLElement>('.jc-as-sup')!;
    btn.classList.remove('jc-as-active', 'jc-as-err');

    if (!sessions) {
        iconEl.textContent = 'cast';
        supEl.textContent = '';
        btn.classList.add('jc-as-err');
        btn.title = JC.t?.('active_streams_load_error') || 'Failed to fetch sessions';
    } else {
        const playing = sessions.filter(s => s.NowPlayingItem && !s.PlayState?.IsPaused);
        const paused  = sessions.filter(s => s.NowPlayingItem &&  s.PlayState?.IsPaused);
        const total   = playing.length + paused.length;

        if (total === 0) {
            // Nothing playing — show a neutral "ready" icon, no badge
            iconEl.textContent = 'play_circle';
            supEl.textContent = '';
            btn.title = 'No active streams';
        } else if (playing.length === 0) {
            // Everything paused
            iconEl.textContent = 'pause_circle';
            supEl.textContent = `${total}`;
            btn.classList.add('jc-as-active');
            btn.title = `${total} stream${total > 1 ? 's' : ''} paused`;
        } else if (total === 1) {
            // Single active stream
            iconEl.textContent = 'person';
            supEl.textContent = '1';
            btn.classList.add('jc-as-active');
            btn.title = '1 active stream';
        } else {
            // Multiple streams — show playing count, note paused in tooltip
            iconEl.textContent = 'group';
            supEl.textContent = `${total}`;
            btn.classList.add('jc-as-active');
            const pausedNote = paused.length ? `, ${paused.length} paused` : '';
            btn.title = `${playing.length} playing${pausedNote}`;
        }
    }
};

// Fetch sessions once, then update the header badge and (if open) the panel.
// A `live` refresh updates progress/state in place when the session set is
// unchanged (R2/R7); a structural change rebuilds the card list.
const updateCounter = async (
    opts?: { live?: boolean },
    requestedContext: IdentityContext | null = _identityContext,
): Promise<void> => {
    const context = requestedContext;
    if (!isCurrentContext(context)) return;
    // Request-ordering guard: ws nudges, the fallback interval, manual refresh
    // and post-action refreshes can overlap. Drop a response that a newer
    // request has already superseded so a slow reply can't roll back the panel.
    const seq = ++_refreshSeq;
    const sessions = await fetchSessions(context);
    if (seq !== _refreshSeq || !isCurrentContext(context)) return;
    _lastUpdated = new Date();
    updateHeaderButton(sessions, context);
    if (!_panelOpen) return;
    if (opts?.live && sessions && panelMatchesSessions(sessions)) applyLiveUpdate(sessions, context);
    else renderPanel(sessions, context);
};

// ── Fetch on demand (no background polling) ──────────────────────────────
const startPolling = (context: IdentityContext): void => {
    if (!isCurrentContext(context)) return;
    void updateCounter(undefined, context); // initial fetch only; panel open & refresh button drive updates
};

const stopPolling = (): void => {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
};

// ── Live updates (active only while the panel is open) ─────────────────────
// Debounced nudge: coalesce a burst of core `Sessions` websocket pushes into a
// single live refresh. Not self-rescheduling — the timer fires once and clears.
const nudgeLive = (context: IdentityContext): void => {
    if (!isCurrentContext(context) || !_panelOpen || _nudgeTimer) return;
    _nudgeTimer = setTimeout(() => {
        _nudgeTimer = null;
        if (isCurrentContext(context) && _panelOpen) void updateCounter({ live: true }, context);
    }, LIVE_NUDGE_DEBOUNCE_MS);
};

const startLive = (context: IdentityContext): void => {
    if (!isCurrentContext(context)) return;
    // Push channel: the core `Sessions` websocket message (same one the native
    // dashboard's live-sessions view subscribes to). Best-effort — fails soft
    // when the SDK socket bridge is unavailable (older hosts / jsdom).
    if (!_liveUnsub && typeof ApiClient !== 'undefined' && typeof ApiClient.subscribe === 'function') {
        try {
            _liveUnsub = ApiClient.subscribe(['Sessions'], () => nudgeLive(context));
        } catch (_) {
            _liveUnsub = null;
        }
    }
    // Fallback cadence — ONLY when the websocket push is unavailable (R5:
    // push-nudged is the mechanism, the interval is the fallback). Page-scoped
    // (panel open) + visibility-gated. When the socket is subscribed we rely on
    // its pushes plus the on-focus refresh below.
    if (!_liveUnsub && !_liveTimer) {
        _liveTimer = setInterval(() => {
            if (!isCurrentContext(context)) return;
            if (document.visibilityState === 'hidden') return;
            void updateCounter({ live: true }, context);
        }, LIVE_FALLBACK_MS);
    }
    // Refresh immediately when the tab regains focus (the interval skipped
    // hidden ticks, so the panel could be stale on return).
    if (!_visListener) {
        _visListener = (): void => {
            if (isCurrentContext(context) && _panelOpen && document.visibilityState === 'visible') {
                void updateCounter({ live: true }, context);
            }
        };
        document.addEventListener('visibilitychange', _visListener);
    }
};

const stopLive = (): void => {
    if (_liveUnsub) { try { _liveUnsub(); } catch (_) { /* non-fatal */ } _liveUnsub = null; }
    if (_liveTimer) { clearInterval(_liveTimer); _liveTimer = null; }
    if (_nudgeTimer) { clearTimeout(_nudgeTimer); _nudgeTimer = null; }
    if (_visListener) { document.removeEventListener('visibilitychange', _visListener); _visListener = null; }
};

// Close the panel and tear down its live-update resources.
const closePanel = (panel: HTMLElement, context: IdentityContext): void => {
    if (!isCurrentContext(context)) return;
    _panelOpen = false;
    panel.classList.remove('jc-as-panel-open');
    stopLive();
};

// ── Broadcast ────────────────────────────────────────────────────────────
let _broadcastFormOpen = false;
let _broadcastCollapseTimer: ReturnType<typeof setTimeout> | null = null;

const injectBroadcastButton = (panel: HTMLElement, context: IdentityContext): void => {
    if (!isCurrentContext(context) || !panel) return;
    if (panel.querySelector('.jc-as-broadcast-btn')) return;

    const header = panel.querySelector('.jc-as-panel-header');
    if (!header) return;

    // ── Compose form ──────────────────
    const form = document.createElement('div');
    form.className = 'jc-as-broadcast-form';

    // Title field
    const headerLabel = document.createElement('div');
    headerLabel.className = 'jc-as-broadcast-field-label';
    headerLabel.textContent = 'Title (optional)';

    const headerInput = document.createElement('input');
    headerInput.type = 'text';
    headerInput.className = 'jc-as-broadcast-input';
    headerInput.placeholder = 'e.g. Server Message';
    headerInput.maxLength = 200;

    // Message field
    const messageLabel = document.createElement('div');
    messageLabel.className = 'jc-as-broadcast-field-label';
    messageLabel.textContent = 'Message (required)';

    const textArea = document.createElement('textarea');
    textArea.className = 'jc-as-broadcast-textarea';
    textArea.placeholder = 'e.g. Server shutting down in 10 minutes';
    textArea.maxLength = 1000;

    // Warning note — below both fields
    const headerNote = document.createElement('div');
    headerNote.className = 'jc-as-broadcast-field-note';
    headerNote.textContent = '⚠ Title may not show on all clients (web UI). Message is always visible.';

    // Timeout row
    const timeoutRow = document.createElement('div');
    timeoutRow.className = 'jc-as-broadcast-timeout-row';
    const timeoutLabel = document.createElement('span');
    timeoutLabel.className = 'jc-as-broadcast-timeout-label';
    timeoutLabel.textContent = 'Timeout (s):';
    const timeoutInput = document.createElement('input');
    timeoutInput.type = 'number';
    timeoutInput.className = 'jc-as-broadcast-timeout-input';
    timeoutInput.value = '10';
    timeoutInput.min = '1';
    timeoutInput.max = '3600';
    timeoutRow.appendChild(timeoutLabel);
    timeoutRow.appendChild(timeoutInput);

    const resultEl = document.createElement('div');
    resultEl.className = 'jc-as-broadcast-result';

    const actions = document.createElement('div');
    actions.className = 'jc-as-broadcast-actions';

    const sendBtn = document.createElement('button');
    sendBtn.className = 'jc-as-broadcast-send';
    sendBtn.textContent = 'Send';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'jc-as-broadcast-cancel';
    cancelBtn.textContent = 'Cancel';

    actions.appendChild(cancelBtn);
    actions.appendChild(sendBtn);

    form.appendChild(headerLabel);
    form.appendChild(headerInput);
    form.appendChild(messageLabel);
    form.appendChild(textArea);
    form.appendChild(buildPresetRow(textArea, context));
    form.appendChild(headerNote);
    form.appendChild(timeoutRow);
    form.appendChild(resultEl);
    form.appendChild(actions);

    // ── Broadcast icon button ────────────────────────────────────────────
    const broadcastBtn = document.createElement('button');
    broadcastBtn.className = 'jc-as-broadcast-btn';
    broadcastBtn.setAttribute('aria-label', 'Broadcast message to all sessions');
    broadcastBtn.title = 'Broadcast message';
    const broadcastIcon = document.createElement('span');
    broadcastIcon.className = 'material-icons';
    broadcastIcon.style.fontSize = '18px';
    broadcastIcon.textContent = 'campaign';
    broadcastBtn.appendChild(broadcastIcon);

    // Insert button before the close button
    const closeBtn = header.querySelector('.jc-as-panel-close');
    header.insertBefore(broadcastBtn, closeBtn);

    // Insert form between header and body
    const body = panel.querySelector('.jc-as-panel-body');
    panel.insertBefore(form, body);

    // ── Event wiring ─────────────────────────────────────────────────────
    broadcastBtn.addEventListener('click', (e) => {
        if (!isCurrentContext(context)) return;
        e.stopPropagation();
        toggleBroadcastForm(broadcastBtn, form, resultEl, textArea, headerInput, timeoutInput, context);
    });

    cancelBtn.addEventListener('click', (e) => {
        if (!isCurrentContext(context)) return;
        e.stopPropagation();
        collapseBroadcastForm(broadcastBtn, form, resultEl, textArea, headerInput, timeoutInput, context);
    });

    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- async click handler, matches the pre-conversion behavior
    sendBtn.addEventListener('click', async (e) => {
        if (!isCurrentContext(context)) return;
        e.stopPropagation();
        const text = textArea.value.trim();
        if (!text) {
            textArea.focus();
            return;
        }
        const header = headerInput.value.trim() || undefined;
        const secs = parseFloat(timeoutInput.value) || 10;
        const timeoutMs = Math.round(secs * 1000);

        sendBtn.disabled = true;
        resultEl.className = 'jc-as-broadcast-result';
        resultEl.textContent = '';

        await sendBroadcast(header, text, timeoutMs, resultEl, context);

        if (!isCurrentContext(context)) return;
        sendBtn.disabled = false;

        // Auto-collapse after 3 s
        if (_broadcastCollapseTimer) clearTimeout(_broadcastCollapseTimer);
        _broadcastCollapseTimer = setTimeout(() => {
            if (!isCurrentContext(context)) return;
            collapseBroadcastForm(broadcastBtn, form, resultEl, textArea, headerInput, timeoutInput, context);
        }, 3000);
    });
};

const toggleBroadcastForm = (btn: HTMLElement, form: HTMLElement, resultEl: HTMLElement, textArea: HTMLTextAreaElement, headerInput: HTMLInputElement, timeoutInput: HTMLInputElement, context: IdentityContext): void => {
    if (!isCurrentContext(context)) return;
    _broadcastFormOpen = !_broadcastFormOpen;
    btn.classList.toggle('jc-as-broadcast-active', _broadcastFormOpen);
    form.classList.toggle('jc-as-broadcast-form-open', _broadcastFormOpen);
    if (_broadcastFormOpen) {
        resultEl.className = 'jc-as-broadcast-result';
        resultEl.textContent = '';
        textArea.value = '';
        headerInput.value = '';
        timeoutInput.value = '10';
        textArea.focus();
    }
};

const collapseBroadcastForm = (btn: HTMLElement, form: HTMLElement, resultEl: HTMLElement, textArea: HTMLTextAreaElement, headerInput: HTMLInputElement, timeoutInput: HTMLInputElement, context: IdentityContext): void => {
    if (!isCurrentContext(context)) return;
    _broadcastFormOpen = false;
    btn.classList.remove('jc-as-broadcast-active');
    form.classList.remove('jc-as-broadcast-form-open');
    resultEl.className = 'jc-as-broadcast-result';
    resultEl.textContent = '';
    textArea.value = '';
    headerInput.value = '';
    timeoutInput.value = '10';
};

const sendBroadcast = async (header: string | undefined, text: string, timeoutMs: number, resultEl: HTMLElement, context: IdentityContext): Promise<void> => {
    if (!isCurrentContext(context)) return;
    try {
        // skipRetry: broadcasting is not idempotent — never auto-repeat it.
        const data = await JC.core.api.plugin('/active-streams/broadcast', {
            method: 'POST',
            body: { header: header || null, text, timeoutMs },
            skipRetry: true
        }) as any;
        if (!isCurrentContext(context)) return;
        const errNote = data.errors?.length ? ` (${data.errors.length} error${data.errors.length > 1 ? 's' : ''})` : '';
        resultEl.className = 'jc-as-broadcast-result jc-as-broadcast-ok';
        resultEl.textContent = `Sent to ${data.sent} of ${data.sent + data.skipped} sessions${errNote}`;
    } catch (err: any) {
        if (!isCurrentContext(context)) return;
        resultEl.className = 'jc-as-broadcast-result jc-as-broadcast-err';
        if (err && err.status) {
            // HTTP error: surface a sanitized upstream message (never a raw
            // URL-bearing / HTML blob) like the old `await resp.text()` path did.
            resultEl.textContent = `Error: ${describeFetchError(err, err.message || 'Request failed')}`;
        } else {
            resultEl.textContent = `Failed: ${err.message}`;
        }
    }
};

// ── Panel ────────────────────────────────────────────────────────────────
const togglePanel = (context: IdentityContext): void => {
    if (!isCurrentContext(context)) return;
    const panel = document.getElementById('jc-active-streams-panel');
    if (!panel) return;
    _panelOpen = !_panelOpen;
    panel.classList.toggle('jc-as-panel-open', _panelOpen);
    if (_panelOpen) { void updateCounter(undefined, context); startLive(context); }
    else stopLive();
};

const injectPanel = (context: IdentityContext): void => {
    if (!isCurrentContext(context)) return;
    if (document.getElementById('jc-active-streams-panel')) return;

    const panel = stampOwner(document.createElement('div'), context);
    panel.id = 'jc-active-streams-panel';

    const header = document.createElement('div');
    header.className = 'jc-as-panel-header';

    const titleEl = document.createElement('span');
    titleEl.className = 'jc-as-panel-title';
    titleEl.textContent = 'Sessions';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'jc-as-panel-close';
    closeBtn.setAttribute('aria-label', 'Close sessions panel');
    const closeIcon = document.createElement('span');
    closeIcon.className = 'material-icons';
    closeIcon.style.fontSize = '18px';
    closeIcon.textContent = 'close';
    closeBtn.appendChild(closeIcon);
    closeBtn.addEventListener('click', (e) => {
        if (!isCurrentContext(context)) return;
        e.stopPropagation();
        closePanel(panel, context);
    });

    header.appendChild(titleEl);
    header.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'jc-as-panel-body';

    panel.appendChild(header);
    panel.appendChild(body);
    document.body.appendChild(panel);

    const skinHeader = document.querySelector('.skinHeader');
    const skinHeaderHeight = skinHeader?.getBoundingClientRect().height || 0;
    if (skinHeaderHeight > 0) {
        panel.style.top = (skinHeaderHeight + 2) + 'px';
    } else {
        // Jellyfin 12 experimental layout: the legacy .skinHeader is hidden,
        // measure the new MUI AppBar toolbar instead.
        const appBar = document.querySelector('.MuiAppBar-root');
        if (appBar) {
            panel.style.top = (appBar.getBoundingClientRect().height + 2) + 'px';
        }
    }

    // Refresh button — available to all users who can see the panel
    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'jc-as-refresh-btn';
    refreshBtn.setAttribute('aria-label', 'Refresh sessions');
    refreshBtn.title = 'Refresh';
    const refreshIcon = document.createElement('span');
    refreshIcon.className = 'material-icons';
    refreshIcon.style.fontSize = '18px';
    refreshIcon.textContent = 'refresh';
    refreshBtn.appendChild(refreshIcon);
    refreshBtn.addEventListener('click', (e) => {
        if (!isCurrentContext(context)) return;
        e.stopPropagation();
        refreshBtn.classList.add('jc-as-refreshing');
        refreshBtn.addEventListener('animationend', () => {
            if (isCurrentContext(context)) refreshBtn.classList.remove('jc-as-refreshing');
        }, { once: true });
        void updateCounter(undefined, context);
    });
    header.insertBefore(refreshBtn, closeBtn);

    // Inject broadcast button for admins only
    if (JC?.currentUser?.Policy?.IsAdministrator === true) {
        injectBroadcastButton(panel, context);
    }

    _outsideClickListener = (e) => {
        if (!isCurrentContext(context)) return;
        const btn = document.getElementById('jc-active-streams');
        if (_panelOpen && !panel.contains(e.target as Node) && btn && !btn.contains(e.target as Node)) {
            closePanel(panel, context);
        }
    };
    document.addEventListener('click', _outsideClickListener);
};

// ── Header button ────────────────────────────────────────────────────────
const tryInjectHeader = (attempts: number, context: IdentityContext): void => {
    if (!isCurrentContext(context)) return;
    if (document.getElementById('jc-active-streams')) return;
    if (attempts > 20) return;

    const headerRight = JC.helpers.getHeaderRightContainer();
    if (!headerRight) {
        _headerRetryTimer = setTimeout(() => tryInjectHeader(attempts + 1, context), 500);
        return;
    }

    const btn = stampOwner(document.createElement('button'), context);
    btn.id = 'jc-active-streams';
    btn.type = 'button';
    btn.setAttribute('is', 'paper-icon-button-light');
    btn.className = 'headerButton headerButtonRight paper-icon-button-light';
    btn.title = 'No active streams';

    const icon = document.createElement('i');
    icon.className = 'material-icons jc-as-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = 'play_circle';

    const sup = document.createElement('span');
    sup.className = 'jc-as-sup';
    sup.setAttribute('aria-hidden', 'true');

    btn.appendChild(icon);
    btn.appendChild(sup);
    btn.addEventListener('click', (e) => {
        if (!isCurrentContext(context)) return;
        e.stopPropagation();
        togglePanel(context);
    });

    insertHeaderTrayButton(headerRight, btn, HeaderTrayOrder.activeStreams);
    // PERF(R1, doctrine: reserved-space entrance + pre-paint re-mounts): the
    // button keeps its designed leading slot. Boot/toggle-on injection is
    // post-paint (JC loads after the native header paints) so the first
    // injection expands from width 0 over 150ms instead of snap-shifting the
    // tray. Re-mounts re-inject synchronously from the shared body-observer
    // callback — inside the mutation batch that rebuilt the toolbar, before
    // its first paint — so they attach instantly with no animation.
    JC.core?.ui?.expandIn(btn, { instant: _headerInjectedOnce });
    _headerInjectedOnce = true;
    injectPanel(context);
    applyThemeVars(context);
    startPolling(context);
};

// ── Observer ─────────────────────────────────────────────────────────────
const startObserver = (context: IdentityContext): void => {
    if (!isCurrentContext(context)) return;
    if (_observer) return;
    const callback = (): void => {
        if (!isCurrentContext(context)) return;
        if (!document.getElementById('jc-active-streams')) tryInjectHeader(0, context);
    };
    if (JC?.helpers?.onBodyMutation) {
        _observer = JC.helpers.onBodyMutation('active-streams', callback);
    } else {
        const mo = new MutationObserver(callback);
        mo.observe(document.body, { childList: true, subtree: true });
        _observer = { unsubscribe() { mo.disconnect(); } };
    }
};

const stopObserver = (): void => {
    if (_observer) { _observer.unsubscribe(); _observer = null; }
    // The observer callback re-invokes tryInjectHeader; cancel any pending
    // header-injection retry so it can't re-inject after teardown.
    if (_headerRetryTimer) { clearTimeout(_headerRetryTimer); _headerRetryTimer = null; }
};

// ── Public API ───────────────────────────────────────────────────────────
const activeStreamsApi = {
    initialize() {
        // Re-entry is allowed after an identity/config activation. Always drain
        // the prior controller before evaluating the new user's visibility gate.
        if (_observer || _pollTimer || _lifecycle || document.getElementById('jc-active-streams')) {
            activeStreamsApi.destroy();
        }
        if (!JC?.pluginConfig?.ActiveStreamsEnabled) {
            return;
        }
        if (!isVisible()) {
            console.log(`${LOG} Active Streams: skipping — not visible for this user.`);
            return;
        }
        _identityContext = immutableOwner(JC.identity.capture());
        if (!_identityContext) return;
        const context = _identityContext;
        console.log(`${LOG} Active Streams: initializing.`);
        injectStyles();
        startObserver(context);
        tryInjectHeader(0, context);
        // Re-apply theme vars on every navigation (hashchange, popstate
        // and pushState — the old raw hashchange listener missed the
        // latter). Tracked via a lifecycle handle so destroy() removes it.
        _lifecycle = JC.core.lifecycle.register('active-streams');
        _lifecycle.track(JC.core.navigation.onNavigate(() => applyThemeVars(context)));
    },

    destroy() {
        console.log(`${LOG} Active Streams: destroying.`);
        stopPolling();
        stopLive();
        stopObserver();
        if (_lifecycle) { _lifecycle.teardown(); _lifecycle = null; }
        if (_outsideClickListener) { document.removeEventListener('click', _outsideClickListener); _outsideClickListener = null; }
        if (_broadcastCollapseTimer) { clearTimeout(_broadcastCollapseTimer); _broadcastCollapseTimer = null; }
        if (_headerRetryTimer) { clearTimeout(_headerRetryTimer); _headerRetryTimer = null; }
        document.getElementById('jc-active-streams')?.remove();
        document.getElementById('jc-active-streams-panel')?.remove();
        document.getElementById('jc-active-streams-styles')?.remove();
        _panelOpen = false;
        _broadcastFormOpen = false;
        _headerInjectedOnce = false; // next enable cycle re-animates its boot injection
        _refreshSeq++;
        _lastUpdated = null;
        _identityContext = null;
    }
};

const stableActiveStreams = createStableMethodFacade<typeof activeStreamsApi>({
    initialize() {},
    destroy() {},
});

/**
 * Publish the frozen public facade and install this activation's delegate.
 * Importing the module alone intentionally performs no browser/global work.
 */
export function installActiveStreams(): () => void {
    const uninstall = stableActiveStreams.install(activeStreamsApi);
    JC.activeStreams = stableActiveStreams.facade;
    const unregisterReset = JC.identity.registerReset('active-streams', () => activeStreamsApi.destroy());
    let disposed = false;
    return () => {
        if (disposed) return;
        disposed = true;
        activeStreamsApi.destroy();
        unregisterReset();
        uninstall();
    };
}

/** Start the currently installed activation without resolving through globals. */
export function initializeActiveStreams(): void {
    activeStreamsApi.initialize();
}
