// src/discovery/pane.ts
//
// The shared Discovery surface used by every placement (library tab, home tab, dedicated page, …):
// a toolbar (optional Movies/TV media-type toggle + a per-user "Customize" button) above a feed
// host that renders the rows for the current media type. Extracting this here means the placements
// are thin mounts and the customize/re-render/toggle logic lives in ONE place. A render sequence
// guard discards a stale render's feed handle if a newer render (toggle switch, customize save)
// started first, so switching fast never leaks an IntersectionObserver/AbortController.

import { JE } from '../globals';
import { injectCss } from '../core/ui-kit';
import type { DiscoveryMediaType } from './rows';
import { renderFeed, type DiscoveryFeedHandle } from './feed';
import { fetchGenres } from './data';
import { getUserRowIds } from './prefs';
import { openCustomize } from './customize';

const CSS_ID = 'je-discovery-pane-css';

function ensureCss(): void {
    injectCss(CSS_ID, `
        .je-discovery-toolbar { display: flex; align-items: center; gap: 8px; padding: 0.4em 1.2em 0; flex-wrap: wrap; }
        .je-discovery-mtoggle { display: inline-flex; gap: 4px; }
        .je-discovery-mtoggle button {
            background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.14);
            color: rgba(255,255,255,0.75); border-radius: 6px; padding: 5px 14px; font-size: 13px; cursor: pointer;
        }
        .je-discovery-mtoggle button.is-active { background: var(--theme-primary-color, #00a4dc); border-color: transparent; color: #fff; }
        .je-discovery-customize-btn {
            display: inline-flex; align-items: center; gap: 6px; cursor: pointer; margin-left: auto;
            background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.14);
            color: rgba(255,255,255,0.85); border-radius: 6px; padding: 5px 12px; font-size: 13px;
        }
        .je-discovery-customize-btn:hover { background: rgba(255,255,255,0.14); }
        .je-discovery-customize-btn .material-icons { font-size: 16px; }
    `);
}

function mkToggleButton(label: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
}

export interface DiscoveryPaneHandle {
    element: HTMLElement;
    destroy: () => void;
}

/**
 * Builds a self-contained Discovery surface for `initialMt`. When `showMediaTypeToggle` is true a
 * Movies/TV toggle is shown (for mixed placements like the home tab); the library tab omits it
 * since the page already scopes the media type. The returned handle's destroy() aborts the feed.
 */
export function createDiscoveryPane(initialMt: DiscoveryMediaType, showMediaTypeToggle: boolean): DiscoveryPaneHandle {
    ensureCss();
    let mt = initialMt;
    let feed: DiscoveryFeedHandle | null = null;
    let destroyed = false;
    let renderSeq = 0;

    const root = document.createElement('div');
    root.className = 'je-discovery-surface';
    const toolbar = document.createElement('div');
    toolbar.className = 'je-discovery-toolbar';
    const feedHost = document.createElement('div');
    root.append(toolbar, feedHost);

    let movieBtn: HTMLButtonElement | null = null;
    let tvBtn: HTMLButtonElement | null = null;
    if (showMediaTypeToggle) {
        const group = document.createElement('div');
        group.className = 'je-discovery-mtoggle';
        movieBtn = mkToggleButton(JE.t!('discovery_toggle_movies'), () => setMediaType('movie'));
        tvBtn = mkToggleButton(JE.t!('discovery_toggle_tv'), () => setMediaType('tv'));
        group.append(movieBtn, tvBtn);
        toolbar.appendChild(group);
    }

    const customizeBtn = document.createElement('button');
    customizeBtn.type = 'button';
    customizeBtn.className = 'je-discovery-customize-btn';
    const icon = document.createElement('span');
    icon.className = 'material-icons';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = 'tune';
    const lbl = document.createElement('span');
    lbl.textContent = JE.t!('discovery_customize_button');
    customizeBtn.append(icon, lbl);
    customizeBtn.addEventListener('click', () => {
        void fetchGenres(mt).then((genres) => openCustomize(mt, genres, () => { void render(); }));
    });
    toolbar.appendChild(customizeBtn);

    function syncToggle(): void {
        movieBtn?.classList.toggle('is-active', mt === 'movie');
        tvBtn?.classList.toggle('is-active', mt === 'tv');
    }

    async function render(): Promise<void> {
        const seq = ++renderSeq;
        feed?.destroy();
        feed = null;
        feedHost.textContent = '';
        const handle = await renderFeed(feedHost, mt, getUserRowIds(mt));
        // A newer render (toggle/customize) started while we awaited, or we were destroyed — discard.
        if (destroyed || seq !== renderSeq) { handle.destroy(); return; }
        feed = handle;
    }

    function setMediaType(next: DiscoveryMediaType): void {
        if (next === mt) return;
        mt = next;
        syncToggle();
        void render();
    }

    syncToggle();
    void render();

    return {
        element: root,
        destroy: () => { destroyed = true; renderSeq++; feed?.destroy(); feed = null; },
    };
}
