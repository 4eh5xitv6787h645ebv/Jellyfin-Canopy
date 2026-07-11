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
import { prettifyCategory, groupByCeremony, type AwardEntry } from './awards-format';
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

JE.initializeAwardsScript = function () {
    const logPrefix = '🪼 Jellyfin Elevate: Awards:';

    if (!JE?.pluginConfig?.ShowAwards) {
        console.log(`${logPrefix} feature disabled.`);
        return;
    }

    console.log(`${logPrefix} initializing...`);

    // Per-item render dedup + fail-open retry bookkeeping (mirrors letterboxd-links).
    const processedItemIds = new Set<string>();
    const errorAttempts = new Map<string, number>();
    const ERROR_MAX_ATTEMPTS = 3;
    let lastVisibleItemId: string | null = null;
    let inFlight = false;

    injectStyles();

    async function processAwards(): Promise<void> {
        if (inFlight) return;

        const visiblePage = document.querySelector<HTMLElement>('#itemDetailPage:not(.hide)');
        if (!visiblePage) return;

        const itemId = getItemIdFromUrl();
        if (!itemId) return;

        // Navigated to a different item — allow the new one to render and drop stale state.
        if (lastVisibleItemId && lastVisibleItemId !== itemId) {
            processedItemIds.clear();
            errorAttempts.clear();
        }
        lastVisibleItemId = itemId;

        // Clean any award section left on now-hidden cached detail pages (v12 keeps up to
        // three #itemDetailPage slots around) so it can't resurface against the wrong item.
        document.querySelectorAll(`#itemDetailPage.hide .${SECTION_CLASS}`).forEach(el => el.remove());

        if (processedItemIds.has(itemId)) return;
        if (visiblePage.querySelector(`.${SECTION_CLASS}`)) {
            processedItemIds.add(itemId);
            return;
        }

        inFlight = true;
        try {
            const data = await JE.core.api.plugin(`/awards/${encodeURIComponent(itemId)}`) as ItemAwardsResponse | null;

            if (data && data.enabled === false) {
                // Admin turned the feature off since bootstrap — stop retrying this view.
                processedItemIds.add(itemId);
                return;
            }

            const awards = Array.isArray(data?.awards) ? data.awards : [];
            if (awards.length === 0) {
                // Genuine "no awards" (or index not built yet) — remember it; don't re-fetch.
                processedItemIds.add(itemId);
                return;
            }

            // The user may have navigated away while the request was in flight.
            const stillVisible = document.querySelector<HTMLElement>('#itemDetailPage:not(.hide)');
            if (!stillVisible || getItemIdFromUrl() !== itemId) return;
            if (stillVisible.querySelector(`.${SECTION_CLASS}`)) {
                processedItemIds.add(itemId);
                return;
            }

            const section = buildAwardsSection(awards);
            insertSection(stillVisible, section);
            processedItemIds.add(itemId);
        } catch (err) {
            // PERF(R9): fail open — only give up on this item after repeated failures;
            // the shared observer / nav probes retry until then. A blip never caches "no awards".
            console.warn(`${logPrefix} failed to load awards for ${itemId}:`, err);
            const attempts = (errorAttempts.get(itemId) || 0) + 1;
            if (attempts >= ERROR_MAX_ATTEMPTS) {
                processedItemIds.add(itemId);
                errorAttempts.delete(itemId);
            } else {
                errorAttempts.set(itemId, attempts);
            }
        } finally {
            inFlight = false;
        }
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
    const subscription = onBodyMutation('je-awards', () => {
        if (!JE?.pluginConfig?.ShowAwards) {
            subscription.unsubscribe();
            console.log(`${logPrefix} stopped — feature disabled.`);
            return;
        }
        if (!isDetailsPageVisible()) return;
        schedule();
    });
    // A cached-page re-show is a class flip the structural observer drops, so cover it via nav.
    onNavigate(() => { if (JE?.pluginConfig?.ShowAwards) schedule(); });
    onViewPage(() => { if (JE?.pluginConfig?.ShowAwards) schedule(); });

    schedule();
    console.log(`${logPrefix} initialized.`);
};

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
