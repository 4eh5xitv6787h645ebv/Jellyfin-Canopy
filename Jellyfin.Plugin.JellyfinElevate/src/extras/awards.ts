// src/extras/awards.ts
//
// Awards — an "Awards" section on Movie and Series detail pages listing the
// wins and nominations the title received (Oscars, Golden Globes, BAFTA,
// Cannes, Venice, Berlin, SAG, Critics' Choice, Emmys). The data is served by
// the plugin's /JellyfinElevate/awards/{itemId} endpoint out of a server-side
// index the scheduled task builds from Wikidata; the client just renders it.
// There is no external request from the browser and no per-item TMDB/Wikidata
// call — the server resolves the item's IMDb/TMDb id against its in-memory
// index, so even a huge library pays one cheap, cached request per detail view.
//
// Performance rules (docs/advanced/performance-rules.md):
//   R3  No own body-wide observer — rides the shared JE.core.dom multiplexer
//       via onBodyMutation, gated to the visible details page.
//   R5  No polling — mutation + navigation + viewpage triggers only.
//   R6  No remote assets — the trophy glyphs use the shared Material Symbols
//       font from core/ui-kit (local asset cache), never a CDN.
//   R7  The section is built fully off-DOM and inserted once, below the fold,
//       only after its data is resolved — never an empty box that later grows.
//   R9  Fail open — a transient fetch failure is retried per view (bounded),
//       never cached like a genuine "no awards" answer.
// Security (docs/advanced/client-security.md):
//   X1  Every dynamic value is written via textContent (never innerHTML), so
//       ceremony/category strings cannot open a tag or break an attribute.

import { JE as JEBase } from '../globals';
import { ensureMaterialSymbolsFont } from '../core/ui-kit';
import { isDetailsPageVisible, getItemIdFromUrl } from '../core/details-view';
import { onBodyMutation } from '../core/dom-observer';
import { onNavigate, onViewPage } from '../core/navigation';
import { prettifyCategory, groupByCeremony, applyTransient, type AwardEntry, type TransientRetryState } from './awards-format';
import type { ApiApi, PluginConfig } from '../types/je';

/** Response shape of GET /JellyfinElevate/awards/{itemId} (ItemAwardsResponse.cs). */
interface ItemAwardsResponse {
    enabled: boolean;
    version: number;
    indexEmpty: boolean;
    awards: AwardEntry[];
}

/** Local view of the shared namespace: the member this module owns + the core api/i18n it reads. */
const JE = JEBase as typeof JEBase & {
    initializeAwardsScript?: () => void;
    pluginConfig: PluginConfig & { ShowAwards?: boolean };
    core: { api: ApiApi };
    t?: (key: string, params?: Record<string, unknown>) => string;
};

const SECTION_CLASS = 'je-awards-section';
const STYLE_ID = 'je-awards-styles';

// Registered exactly once. Guards against double-registration when the initializer is invoked
// both by the bootstrap loader and by the live-config re-init hook below.
let awardsStarted = false;

JE.initializeAwardsScript = function () {
    const logPrefix = '🪼 Jellyfin Elevate: Awards:';

    if (awardsStarted) return;
    if (!JE?.pluginConfig?.ShowAwards) {
        // Not started — a later admin enable (via the je:config-changed hook below) re-invokes this.
        console.log(`${logPrefix} feature disabled.`);
        return;
    }
    awardsStarted = true;

    console.log(`${logPrefix} initializing...`);

    // TERMINAL per-item state: awards rendered, a genuine "no awards" answer, or the feature
    // turned off. Never re-fetched for this page view. Distinct from the TRANSIENT retry state
    // below, so a transport error or a not-ready index is never cached like a real answer (R9).
    const resolved = new Set<string>();

    // TRANSIENT per-item retry budget (transport errors + index-not-ready). Page-view scoped and
    // MONOTONIC: `windowDeadline` is set once per item and never reset by a later trigger, so a
    // mutation storm can't restart the budget; `nextAllowedAt` rate-limits fetches. Within the
    // window we schedule timed backoff retries; after it, external triggers may still retry but
    // only once per cooldown — so a still-down server or a long first build can't hammer, yet the
    // open page still recovers once the server/index is ready.
    const retry = new Map<string, TransientRetryState>();
    const RETRY_WINDOW_MS = 3 * 60 * 1000;   // absolute per-view budget for timed retries
    const RETRY_COOLDOWN_MS = 30 * 1000;     // min gap between post-window trigger-driven retries
    const MAX_BACKOFF_MS = 15 * 1000;
    const ERROR_BASE_DELAY_MS = 2000;
    const NOT_READY_BASE_DELAY_MS = 2000;

    let lastVisibleItemId: string | null = null;
    let inFlight = false;
    // PERF(R9)/lifecycle: if a trigger fires while a request is in flight (e.g. navigation to a
    // new item), remember to run one more pass when it finishes so the new item isn't dropped.
    let rerunRequested = false;

    injectStyles();

    function getRetry(itemId: string): TransientRetryState {
        let r = retry.get(itemId);
        if (!r) {
            r = { attempts: 0, windowDeadline: Date.now() + RETRY_WINDOW_MS, nextAllowedAt: 0 };
            retry.set(itemId, r);
        }
        return r;
    }

    // Unified transient handler for both the transport-error and index-not-ready paths. Never
    // marks the item resolved; schedules a bounded timed retry while inside the window, then falls
    // back to cooldown-gated recovery so it stays fail-open without ever hammering. The decision
    // is the pure applyTransient() (unit-tested); this just applies its result.
    function handleTransient(itemId: string, baseDelayMs: number): void {
        const { state, action } = applyTransient(
            getRetry(itemId), Date.now(), baseDelayMs, MAX_BACKOFF_MS, RETRY_COOLDOWN_MS);
        retry.set(itemId, state);
        if (action.kind === 'retry') {
            scheduleDelayedRetry(itemId, action.delayMs);
        }
    }

    async function processAwards(): Promise<void> {
        if (inFlight) {
            rerunRequested = true;
            return;
        }

        const visiblePage = document.querySelector<HTMLElement>('#itemDetailPage:not(.hide)');
        if (!visiblePage) return;

        const itemId = getItemIdFromUrl();
        if (!itemId) return;

        // Navigated to a different item — allow the new one to render and drop stale state, so a
        // genuinely new page view starts with a fresh (monotonic) retry budget.
        if (lastVisibleItemId && lastVisibleItemId !== itemId) {
            resolved.clear();
            retry.clear();
        }
        lastVisibleItemId = itemId;

        // Clean any award section left on now-hidden cached detail pages (v12 keeps up to
        // three #itemDetailPage slots around) so it can't resurface against the wrong item.
        document.querySelectorAll(`#itemDetailPage.hide .${SECTION_CLASS}`).forEach(el => el.remove());

        if (resolved.has(itemId)) return;
        if (visiblePage.querySelector(`.${SECTION_CLASS}`)) {
            resolved.add(itemId);
            return;
        }

        // Cooldown gate: after the retry window is spent, external triggers (mutation/nav) may
        // still retry, but no more than once per cooldown — a mutation storm can't hammer.
        const pending = retry.get(itemId);
        if (pending && Date.now() < pending.nextAllowedAt) return;

        inFlight = true;
        try {
            // skipCache: the shared GET cache's 30-min TTL would otherwise pin a transient
            // "index not built yet" response and hide awards for the rest of that window. This
            // endpoint is a cheap server-side dictionary lookup, so per-view fetches are fine.
            const data = await JE.core.api.plugin(`/awards/${encodeURIComponent(itemId)}`, { skipCache: true }) as ItemAwardsResponse | null;

            if (data && data.enabled === false) {
                // Admin turned the feature off since bootstrap — terminal for this view.
                resolved.add(itemId);
                retry.delete(itemId);
                return;
            }

            // PERF(R9): the index hasn't been built yet (first install). Transient not-ready
            // state, NOT "no awards" — never cache it; retry (bounded) so the open page fills in.
            if (data?.indexEmpty) {
                handleTransient(itemId, NOT_READY_BASE_DELAY_MS);
                return;
            }

            const awards = Array.isArray(data?.awards) ? data.awards : [];
            if (awards.length === 0) {
                // Genuine "no awards" (index is built) — terminal for this view.
                resolved.add(itemId);
                retry.delete(itemId);
                return;
            }

            // The user may have navigated away while the request was in flight.
            const stillVisible = document.querySelector<HTMLElement>('#itemDetailPage:not(.hide)');
            if (!stillVisible || getItemIdFromUrl() !== itemId) return;
            if (stillVisible.querySelector(`.${SECTION_CLASS}`)) {
                resolved.add(itemId);
                retry.delete(itemId);
                return;
            }

            const section = buildAwardsSection(awards);
            insertSection(stillVisible, section);
            resolved.add(itemId);
            retry.delete(itemId);
        } catch (err) {
            // PERF(R9): fail open — a transient failure schedules a bounded, nav-guarded retry and
            // is NEVER marked resolved, so a recovered server is picked up on the open page (within
            // the window via a timer, after it via a cooldown-gated trigger). Never cached as "no awards".
            console.warn(`${logPrefix} failed to load awards for ${itemId}:`, err);
            handleTransient(itemId, ERROR_BASE_DELAY_MS);
        } finally {
            inFlight = false;
            // A trigger that fired mid-request (or a completed request for an item that is no
            // longer the visible one) — re-evaluate once so the current item isn't left unrendered.
            if (rerunRequested) {
                rerunRequested = false;
                schedule();
            }
        }
    }

    // PERF(R9)/R5: bounded, nav-guarded single-shot retry used by both the transport-error and
    // index-not-ready paths. Not a standing timer — each caller caps its own attempt count, and
    // the timer aborts if the user navigated away or the item already rendered.
    function scheduleDelayedRetry(itemId: string, delayMs: number): void {
        window.setTimeout(() => {
            if (getItemIdFromUrl() !== itemId) return; // navigated away
            if (resolved.has(itemId)) return;           // already resolved
            schedule();
        }, delayMs);
    }

    // Coalesced, idle-scheduled pass shared by every trigger (R5 — no standing timer).
    let scheduled = false;
    function schedule(): void {
        if (scheduled) return;
        scheduled = true;
        const run = () => { scheduled = false; void processAwards(); };
        if (typeof requestIdleCallback !== 'undefined') {
            requestIdleCallback(run, { timeout: 800 });
        } else {
            setTimeout(run, 100);
        }
    }

    // PERF(R3): ride the shared multiplexed body observer, gated to the visible details page.
    // The work is gated on ShowAwards at runtime (not torn down on disable) so an admin can
    // toggle the feature off and back on live — a disabled pass is a cheap early return.
    onBodyMutation('je-awards', () => {
        if (!JE?.pluginConfig?.ShowAwards) return;
        if (!isDetailsPageVisible()) return;
        schedule();
    });
    // A cached-page re-show is a class flip the structural observer drops, so cover it via nav.
    onNavigate(() => { if (JE?.pluginConfig?.ShowAwards) schedule(); });
    onViewPage(() => { if (JE?.pluginConfig?.ShowAwards) schedule(); });

    // React to a live enable/disable toggle without a page reload. On disable, strip any rendered
    // sections and forget the resolved items so a later re-enable re-renders them; on (re-)enable,
    // clear per-item state and re-run so the current item paints. Registered once (init runs once).
    try {
        window.addEventListener('je:config-changed', () => {
            if (JE?.pluginConfig?.ShowAwards) {
                resolved.clear();
                retry.clear();
                schedule();
            } else {
                document.querySelectorAll(`.${SECTION_CLASS}`).forEach(el => el.remove());
                resolved.clear();
                retry.clear();
            }
        });
    } catch { /* addEventListener unavailable — ignore */ }

    schedule();
    console.log(`${logPrefix} initialized.`);
};

// Live enable from a disabled bootstrap: if the admin turns Awards on while a session is open,
// live-config refreshes JE.pluginConfig and fires je:config-changed. Start the feature then — no
// page reload needed. A no-op when already started or still disabled (the in-init listener above
// then owns subsequent toggles).
try {
    window.addEventListener('je:config-changed', () => {
        if (JE?.pluginConfig?.ShowAwards) JE.initializeAwardsScript?.();
    });
} catch { /* addEventListener unavailable — bootstrap path still covers the enabled-at-load case */ }

/** Builds the whole Awards section off-DOM (R7). All dynamic text via textContent (X1). */
function buildAwardsSection(awards: AwardEntry[]): HTMLElement {
    ensureMaterialSymbolsFont();

    const section = document.createElement('div');
    section.className = `${SECTION_CLASS} verticalSection detailVerticalSection`;

    const header = document.createElement('h2');
    header.className = 'sectionTitle';
    header.textContent = JE.t ? JE.t('awards_section_title') : 'Awards';
    section.appendChild(header);

    const list = document.createElement('div');
    list.className = 'je-awards-list';

    for (const group of groupByCeremony(awards)) {
        const groupEl = document.createElement('div');
        groupEl.className = 'je-awards-ceremony';

        const name = document.createElement('div');
        name.className = 'je-awards-ceremony-name';
        name.textContent = group.ceremony;
        groupEl.appendChild(name);

        const chips = document.createElement('div');
        chips.className = 'je-awards-chips';
        for (const entry of group.entries) {
            chips.appendChild(buildChip(entry));
        }
        groupEl.appendChild(chips);
        list.appendChild(groupEl);
    }

    section.appendChild(list);
    return section;
}

function buildChip(entry: AwardEntry): HTMLElement {
    const chip = document.createElement('span');
    chip.className = `je-award-chip ${entry.won ? 'je-award-won' : 'je-award-nominated'}`;

    const icon = document.createElement('span');
    icon.className = 'je-award-icon';
    // Material Symbols ligature glyphs (rendered by the shared local font): a filled trophy
    // for a win, an outline medal for a nomination.
    icon.textContent = entry.won ? 'emoji_events' : 'workspace_premium';
    icon.setAttribute('aria-hidden', 'true');
    chip.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'je-award-label';
    label.textContent = prettifyCategory(entry.category, entry.ceremony);
    chip.appendChild(label);

    const year = Number(entry.year);
    if (Number.isFinite(year) && year > 0) {
        const yr = document.createElement('span');
        yr.className = 'je-award-year';
        yr.textContent = String(year);
        chip.appendChild(yr);
    }

    // Full context (raw category + win/nominee) in the native tooltip.
    const status = entry.won
        ? (JE.t ? JE.t('awards_won') : 'Winner')
        : (JE.t ? JE.t('awards_nominated') : 'Nominee');
    chip.title = `${status} — ${entry.category}`;
    return chip;
}

/**
 * Inserts the section once (R7), below the external-links/genres area so it reads as a
 * normal detail section. Falls back through progressively broader anchors, and finally
 * appends to the primary detail content, so it lands somewhere sensible on both layouts.
 */
function insertSection(page: HTMLElement, section: HTMLElement): void {
    const afterAnchor = page.querySelector('.itemExternalLinks')
        || page.querySelector('.genresGroup')
        || page.querySelector('.tagline');
    if (afterAnchor && afterAnchor.parentNode) {
        afterAnchor.parentNode.insertBefore(section, afterAnchor.nextSibling);
        return;
    }

    const container = page.querySelector('.detailPagePrimaryContent')
        || page.querySelector('.detailPageContent')
        || page.querySelector('.detailSection')
        || page;
    container.appendChild(section);
}

function injectStyles(): void {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
        .${SECTION_CLASS} { margin: 1.5em 0; }
        .${SECTION_CLASS} .je-awards-list { display: flex; flex-direction: column; gap: 0.9em; }
        .${SECTION_CLASS} .je-awards-ceremony-name {
            font-weight: 600; opacity: 0.85; margin-bottom: 0.4em; font-size: 0.95em;
        }
        .${SECTION_CLASS} .je-awards-chips { display: flex; flex-wrap: wrap; gap: 0.5em; }
        .${SECTION_CLASS} .je-award-chip {
            display: inline-flex; align-items: center; gap: 0.35em;
            padding: 0.3em 0.7em; border-radius: 1em; font-size: 0.9em;
            background: rgba(127, 127, 127, 0.18); white-space: nowrap; line-height: 1.4;
        }
        .${SECTION_CLASS} .je-award-won { background: rgba(212, 175, 55, 0.20); }
        .${SECTION_CLASS} .je-award-nominated { opacity: 0.9; }
        .${SECTION_CLASS} .je-award-icon {
            font-family: 'Material Symbols Rounded';
            font-weight: normal; font-style: normal; line-height: 1; font-size: 1.15em;
            letter-spacing: normal; text-transform: none; display: inline-block;
            white-space: nowrap; word-wrap: normal; direction: ltr;
            -webkit-font-feature-settings: 'liga'; font-feature-settings: 'liga';
            -webkit-font-smoothing: antialiased;
        }
        .${SECTION_CLASS} .je-award-won .je-award-icon { color: #d4af37; }
        .${SECTION_CLASS} .je-award-year { opacity: 0.65; font-variant-numeric: tabular-nums; }
    `;
    document.head.appendChild(style);
}
