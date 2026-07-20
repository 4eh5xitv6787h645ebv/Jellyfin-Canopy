// src/enhanced/hidden-content/panel.ts
//
// Hidden Content — management panel overlay (searchable grid of hidden
// items with unhide actions) and the shared hidden-item card factory.
// (Converted from js/enhanced/hidden-content-panel.js — bodies semantically identical.)

import { JC } from '../../globals';
import { getAllHiddenItems, resolveLegacyIdentity, unhideItem, unhideAll } from './data';
import type { HiddenItem } from './data';
import type { IdentityContext } from '../../types/jc';
import { identityFromSource } from './media-identity';

/** Max poster width when loading images from TMDB / Jellyfin. */
const POSTER_MAX_WIDTH = 300;

interface PanelFence {
    readonly generation: number;
    readonly context: IdentityContext | null;
}

let panelGeneration = 0;
let activeManagementClose: (() => void) | null = null;
const panelTimeouts = new Set<number>();

function capturePanelFence(): PanelFence {
    return { generation: panelGeneration, context: JC.identity?.capture?.() || null };
}

function isPanelFenceCurrent(fence: PanelFence): boolean {
    return fence.generation === panelGeneration
        && (!fence.context || JC.identity.isCurrent(fence.context));
}

function schedulePanelTimeout(callback: () => void, delay: number, fence: PanelFence): number {
    const handle = window.setTimeout(() => {
        panelTimeouts.delete(handle);
        if (isPanelFenceCurrent(fence)) callback();
    }, delay);
    panelTimeouts.add(handle);
    return handle;
}

function cancelPanelTimeout(handle: number): void {
    clearTimeout(handle);
    panelTimeouts.delete(handle);
}

export function resetPanelUi(): void {
    panelGeneration += 1;
    activeManagementClose?.();
    activeManagementClose = null;
    for (const handle of panelTimeouts) clearTimeout(handle);
    panelTimeouts.clear();
    document.querySelectorAll('.jc-hidden-management-overlay').forEach((node) => node.remove());
}

// ============================================================
// Management panel (overlay)
// ============================================================

/**
 * Creates the header bar for the management panel overlay.
 * @param count Current number of hidden items.
 * @returns The header element with title and close button.
 */
function createManagementHeader(count: number): HTMLElement {
    const header = document.createElement('div');
    header.className = 'jc-hidden-management-header';
    const h2 = document.createElement('h2');
    h2.textContent = `${JC.t!('hidden_content_manage_title')} (${count})`;
    header.appendChild(h2);
    const closeBtn = document.createElement('button');
    closeBtn.className = 'jc-hidden-management-close';
    closeBtn.textContent = '×';
    header.appendChild(closeBtn);
    return header;
}

/**
 * Creates a card element for a single hidden item in the management panel.
 * Includes poster, name link, type/date metadata, and an Unhide button.
 * @param item Hidden item data object.
 * @param onNavigate Callback when the user clicks to navigate (closes the panel).
 * @returns The card element.
 */
export function createItemCard(item: HiddenItem, onNavigate?: () => void): HTMLElement {
    const fence = capturePanelFence();
    const card = document.createElement('div');
    card.className = 'jc-hidden-item-card';
    card.dataset.itemId = item.itemId;
    card.dataset.jcIdentityOwned = 'true';

    const hasJellyfinId = !!item.itemId;
    const hasTmdbId = !!item.tmdbId;
    const hasResolvedTmdbId = hasTmdbId && item._identityStatus === 'resolved';
    const mediaType = identityFromSource(item)?.mediaType || (item.type === 'Series' ? 'tv' : 'movie');

    // Clickable poster area that navigates to item detail
    const posterLink = document.createElement('a');
    posterLink.className = 'jc-hidden-item-poster-link';
    if (hasJellyfinId) {
        posterLink.href = `#/details?id=${item.itemId}`;
    } else if (hasResolvedTmdbId) {
        posterLink.href = '#';
        posterLink.dataset.tmdbId = String(item.tmdbId);
        posterLink.dataset.mediaType = mediaType;
    }

    if (item.posterPath && hasResolvedTmdbId) {
        const img = document.createElement('img');
        img.className = 'jc-hidden-item-poster';
        img.src = `https://image.tmdb.org/t/p/w${POSTER_MAX_WIDTH}${item.posterPath}`;
        img.alt = '';
        img.loading = 'lazy';
        posterLink.appendChild(img);
    } else if (hasJellyfinId) {
        const img = document.createElement('img');
        img.className = 'jc-hidden-item-poster';
        img.src = `${(ApiClient as { getUrl(path: string, params?: unknown): string }).getUrl('/Items/' + item.itemId + '/Images/Primary', { maxWidth: POSTER_MAX_WIDTH })}`;
        img.alt = '';
        img.loading = 'lazy';
        img.onerror = () => {
            if (!isPanelFenceCurrent(fence)) return;
            const self = img;
            // Switch card to Seerr navigation
            if (hasResolvedTmdbId && (JC as any).seerrMoreInfo) {
                card.dataset.jellyfinRemoved = '1';
            }
            // Item removed from Jellyfin — fall back to TMDB poster
            if (hasResolvedTmdbId && item.posterPath) {
                self.src = `https://image.tmdb.org/t/p/w${POSTER_MAX_WIDTH}${item.posterPath}`;
                self.onerror = function(this: HTMLImageElement) {
                    if (isPanelFenceCurrent(fence)) this.style.display = 'none';
                };
            } else if (hasResolvedTmdbId && (JC as any).seerrAPI) {
                // No posterPath stored — fetch it from Seerr
                self.onerror = function(this: HTMLImageElement) {
                    if (isPanelFenceCurrent(fence)) this.style.display = 'none';
                };
                const fetchFn = mediaType === 'tv'
                    ? (JC as any).seerrAPI.fetchTvShowDetails
                    : (JC as any).seerrAPI.fetchMovieDetails;
                fetchFn(parseInt(String(item.tmdbId), 10)).then(function(details: any) {
                    if (!isPanelFenceCurrent(fence)) return;
                    const path = details && (details.posterPath || details.poster_path);
                    if (path) {
                        self.src = `https://image.tmdb.org/t/p/w${POSTER_MAX_WIDTH}${path}`;
                    } else {
                        self.style.display = 'none';
                    }
                }).catch(function() {
                    if (isPanelFenceCurrent(fence)) self.style.display = 'none';
                });
            } else if (item._identityStatus !== 'unsupported'
                && item.type !== 'Person' && item.name && (JC as any).seerrAPI && (JC as any).seerrMoreInfo) {
                // No TMDB id stored and the Jellyfin media is gone — resolve via a Seerr search
                // so the card opens the more-info modal instead of a blank poster + dead link.
                self.style.display = 'none';
                const wantType = (item.type === 'Series' || item.type === 'Episode' || item.type === 'Season') ? 'tv' : 'movie';
                (JC as any).seerrAPI.search(item.name).then(function(res: any) {
                    if (!isPanelFenceCurrent(fence)) return;
                    const results = (res && res.results) || [];
                    const hit = results.find(function(r: any) { return r.mediaType === wantType; })
                        || results.find(function(r: any) { return r.mediaType === 'movie' || r.mediaType === 'tv'; });
                    if (hit && hit.id) {
                        card.dataset.jellyfinRemoved = '1';
                        card.dataset.resolvedTmdbId = String(hit.id);
                        card.dataset.resolvedMediaType = hit.mediaType || wantType;
                        const p = hit.posterPath || hit.poster_path;
                        if (p) {
                            self.src = `https://image.tmdb.org/t/p/w${POSTER_MAX_WIDTH}${p}`;
                            self.style.display = '';
                            self.onerror = function(this: HTMLImageElement) {
                                if (isPanelFenceCurrent(fence)) this.style.display = 'none';
                            };
                        }
                    }
                }).catch(function() {});
            } else {
                self.style.display = 'none';
            }
        };
        posterLink.appendChild(img);
    } else {
        const placeholder = document.createElement('div');
        placeholder.className = 'jc-hidden-item-poster';
        posterLink.appendChild(placeholder);
    }
    card.appendChild(posterLink);

    const info = document.createElement('div');
    info.className = 'jc-hidden-item-info';

    const nameLink = document.createElement('a');
    nameLink.className = 'jc-hidden-item-name';
    nameLink.title = item.name || '';
    nameLink.textContent = item.name || 'Unknown';
    if (hasJellyfinId) {
        nameLink.href = `#/details?id=${item.itemId}`;
    } else if (hasResolvedTmdbId) {
        nameLink.href = '#';
        nameLink.dataset.tmdbId = String(item.tmdbId);
        nameLink.dataset.mediaType = mediaType;
    }
    info.appendChild(nameLink);

    // Attach navigation click handlers
    const navigableLinks = [posterLink, nameLink];
    for (const link of navigableLinks) {
        link.addEventListener('click', (e) => {
            if (!isPanelFenceCurrent(fence)) {
                e.preventDefault();
                return;
            }
            // If item was removed from Jellyfin, fall back to the Seerr modal — using the
            // stored TMDB id, or one resolved at render time by a Seerr search.
            const removedId = (card.dataset.jellyfinRemoved === '1')
                ? (hasResolvedTmdbId ? item.tmdbId : card.dataset.resolvedTmdbId)
                : '';
            if (hasJellyfinId && removedId && (JC as any).seerrMoreInfo) {
                e.preventDefault();
                (JC as any).seerrMoreInfo.open(parseInt(String(removedId), 10), hasResolvedTmdbId ? mediaType : (card.dataset.resolvedMediaType || mediaType));
                if (onNavigate) onNavigate();
            } else if (hasJellyfinId) {
                if (onNavigate) onNavigate();
            } else if (hasResolvedTmdbId && (JC as any).seerrMoreInfo) {
                e.preventDefault();
                (JC as any).seerrMoreInfo.open(parseInt(String(item.tmdbId), 10), mediaType);
                if (onNavigate) onNavigate();
            } else if (!hasJellyfinId) {
                e.preventDefault();
            }
        });
    }

    const metaDiv = document.createElement('div');
    metaDiv.className = 'jc-hidden-item-meta';
    const hiddenDate = item.hiddenAt ? new Date(item.hiddenAt).toLocaleDateString() : '';
    const _scope = (item.hideScope || 'global').toLowerCase();
    const _scopeText =
        _scope === 'continuewatching' ? JC.t!('hidden_content_scope_cw_label') :
        _scope === 'nextup'           ? JC.t!('hidden_content_scope_nextup_label') :
        _scope === 'homesections'     ? JC.t!('hidden_content_scope_homesections_label') :
        '';
    const identityText = item._identityStatus === 'legacy-unresolved'
        ? 'Legacy identity — review required'
        : (item._identityStatus === 'unsupported' ? 'Unsupported identity — update required' : '');
    metaDiv.textContent = [item.type, identityText, _scopeText, hiddenDate].filter(Boolean).join(' · ');
    info.appendChild(metaDiv);

    if (item._identityStatus === 'legacy-unresolved' && item._key && !item._identityReadOnly) {
        const resolution = document.createElement('div');
        resolution.className = 'jc-hidden-item-identity-resolution';
        const prompt = document.createElement('span');
        prompt.textContent = 'Treat this TMDB item as: ';
        resolution.appendChild(prompt);
        for (const [mediaType, label] of [['movie', 'Movie'], ['tv', 'TV']] as const) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = label;
            button.addEventListener('click', () => {
                if (!isPanelFenceCurrent(fence)) return;
                if (resolveLegacyIdentity(item._key!, mediaType)) {
                    item._identityStatus = 'resolved';
                    item.type = mediaType === 'tv' ? 'Series' : 'Movie';
                    metaDiv.textContent = [item.type, _scopeText, hiddenDate].filter(Boolean).join(' · ');
                    resolution.remove();
                }
            });
            resolution.appendChild(button);
        }
        info.appendChild(resolution);
    }

    const unhideBtn = document.createElement('button');
    unhideBtn.className = 'jc-hidden-item-unhide';
    unhideBtn.textContent = _scope === 'continuewatching'
        ? JC.t!('hidden_content_add_back_to_cw')
        : JC.t!('hidden_content_unhide');
    info.appendChild(unhideBtn);

    card.appendChild(info);
    return card;
}

/**
 * Creates and displays the management panel overlay.
 * Shows all hidden items in a searchable grid with unhide actions.
 */
export function showManagementPanel(): void {
    const fence = capturePanelFence();
    if (!isPanelFenceCurrent(fence)) return;
    activeManagementClose?.();

    const items = getAllHiddenItems();

    const overlay = document.createElement('div');
    overlay.className = 'jc-hidden-management-overlay';
    overlay.dataset.jcIdentityOwned = 'true';
    overlay.dataset.jcThemeSurface = 'hidden-content';
    overlay.dataset.jcThemeComponent = 'modal-backdrop';

    const panel = document.createElement('div');
    panel.className = 'jc-hidden-management-panel';
    panel.dataset.jcThemeComponent = 'management-panel';

    const header = createManagementHeader(items.length);
    const overlayTimers = new Set<number>();
    const closeOverlay = (): void => {
        for (const handle of overlayTimers) cancelPanelTimeout(handle);
        overlayTimers.clear();
        overlay.remove();
        document.removeEventListener('keydown', escHandler);
        if (activeManagementClose === closeOverlay) activeManagementClose = null;
    };
    activeManagementClose = closeOverlay;
    header.querySelector('.jc-hidden-management-close')!.addEventListener('click', closeOverlay);
    panel.appendChild(header);

    const toolbar = createManagementToolbar();
    panel.appendChild(toolbar.element);

    const gridContainer = document.createElement('div');
    panel.appendChild(gridContainer);

    /**
     * Renders the item grid, optionally filtered by search text.
     * @param filter Search text to filter by name.
     */
    function renderGrid(filter?: string): void {
        if (!isPanelFenceCurrent(fence)) return;
        const filtered = filter
            ? items.filter(i => i.name?.toLowerCase().includes(filter.toLowerCase()))
            : items;

        filtered.sort((a, b) => {
            const da = a.hiddenAt ? new Date(a.hiddenAt).getTime() : 0;
            const db = b.hiddenAt ? new Date(b.hiddenAt).getTime() : 0;
            return db - da;
        });

        if (filtered.length === 0) {
            const emptyDiv = document.createElement('div');
            emptyDiv.className = 'jc-hidden-management-empty';
            emptyDiv.textContent = JC.t!('hidden_content_manage_empty');
            gridContainer.replaceChildren(emptyDiv);
            return;
        }

        const grid = document.createElement('div');
        grid.className = 'jc-hidden-management-grid';

        for (const item of filtered) {
            const card = createItemCard(item, closeOverlay);

            card.querySelector('.jc-hidden-item-unhide')!.addEventListener('click', () => {
                if (!isPanelFenceCurrent(fence) || !overlay.isConnected) return;
                card.classList.add('jc-hidden-item-removing');
                const handle = schedulePanelTimeout(() => {
                    overlayTimers.delete(handle);
                    if (!card.isConnected || !overlay.isConnected) return;
                    unhideItem(item._key || item.itemId!);
                    card.remove();
                    const remaining = gridContainer.querySelectorAll('.jc-hidden-item-card').length;
                    header.querySelector('h2')!.textContent = `${JC.t!('hidden_content_manage_title')} (${remaining})`;
                    if (remaining === 0) {
                        const emptyDiv = document.createElement('div');
                        emptyDiv.className = 'jc-hidden-management-empty';
                        emptyDiv.textContent = JC.t!('hidden_content_manage_empty');
                        gridContainer.replaceChildren(emptyDiv);
                    }
                }, 300, fence);
                overlayTimers.add(handle);
            });

            grid.appendChild(card);
        }

        gridContainer.replaceChildren(grid);
    }

    renderGrid();

    toolbar.searchInput.addEventListener('input', () => {
        if (isPanelFenceCurrent(fence)) renderGrid(toolbar.searchInput.value);
    });

    toolbar.unhideAllBtn.addEventListener('click', () => {
        if (!isPanelFenceCurrent(fence) || !overlay.isConnected) return;
        if (!confirm(JC.t!('hidden_content_clear_confirm'))) return;
        if (!isPanelFenceCurrent(fence)) return;
        unhideAll();
        const emptyDiv = document.createElement('div');
        emptyDiv.className = 'jc-hidden-management-empty';
        emptyDiv.textContent = JC.t!('hidden_content_manage_empty');
        gridContainer.replaceChildren(emptyDiv);
        header.querySelector('h2')!.textContent = `${JC.t!('hidden_content_manage_title')} (0)`;
    });

    overlay.appendChild(panel);

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeOverlay();
    });

    const escHandler = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') closeOverlay();
    };
    document.addEventListener('keydown', escHandler);

    document.body.appendChild(overlay);
}

/**
 * Creates the toolbar (search + unhide-all button) for the management panel.
 */
function createManagementToolbar(): { element: HTMLElement; searchInput: HTMLInputElement; unhideAllBtn: HTMLButtonElement } {
    const toolbar = document.createElement('div');
    toolbar.className = 'jc-hidden-management-toolbar';

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'jc-hidden-management-search';
    searchInput.placeholder = JC.t!('hidden_content_manage_search') || 'Search hidden items...';
    toolbar.appendChild(searchInput);

    const unhideAllBtn = document.createElement('button');
    unhideAllBtn.className = 'jc-hidden-management-unhide-all';
    unhideAllBtn.textContent = JC.t!('hidden_content_clear_all');
    toolbar.appendChild(unhideAllBtn);

    return { element: toolbar, searchInput, unhideAllBtn };
}
