// src/arr/search/interactive-modal.ts
//
// The Interactive Search release picker: a scrollable, filterable, sortable list of candidate
// releases from one Sonarr/Radarr instance with a per-row Grab button. All rows are built with
// createElement + textContent (no HTML sinks), so nothing here can inject markup from a release
// title/indexer name. Opened from the action-sheet "Interactive Search" item (a user action), so
// it shows a spinner then swaps in content — it is not a pre-paint main-page injection.

import { JE } from '../../globals';
import { createArrModal, type ArrModalHandle } from './modal';
import { fetchContext, fetchReleases, grabRelease, errorMessage, toastSuccess, downloadsPageAvailable, toastInfo } from './actions';
import { formatSize, formatAge } from './format';
import type { ArrContext, ArrRelease, ArrService } from './types';

type SortKey = 'default' | 'size' | 'age' | 'seeders' | 'score';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

/** Opens the interactive search modal for a Jellyfin item id. */
export async function openInteractiveSearch(itemId: string): Promise<void> {
    const modal = createArrModal({ title: JE.t!('arr_search_interactive'), subtitle: JE.t!('arr_search_loading'), icon: 'travel_explore' });
    renderCentered(modal.body, spinner());

    let ctx: ArrContext;
    try {
        ctx = await fetchContext(itemId);
    } catch (e) {
        renderCentered(modal.body, message('error', errorMessage(e)));
        return;
    }

    modal.setSubtitle(headerSubtitle(ctx));

    if (ctx.kind === 'unknown' || !ctx.service) {
        renderCentered(modal.body, message('info', JE.t!('arr_search_not_arr_item')));
        return;
    }
    if (!ctx.supportsInteractive) {
        renderCentered(modal.body, message('info', JE.t!('arr_search_interactive_unsupported')));
        return;
    }
    if (ctx.targets.length === 0) {
        renderCentered(modal.body, message('info', JE.t!('arr_search_not_tracked')));
        return;
    }

    new ReleaseView(modal, itemId, ctx.service, ctx.targets.map((t) => t.instanceName)).mount();
}

function headerSubtitle(ctx: ArrContext): string {
    let sub = ctx.name || '';
    if (ctx.kind === 'season' && ctx.seasonNumber != null) sub += ` · ${JE.t!('arr_search_season')} ${ctx.seasonNumber}`;
    if (ctx.kind === 'episode' && ctx.seasonNumber != null) {
        const ep = ctx.episodeNumber != null ? `E${String(ctx.episodeNumber).padStart(2, '0')}` : '';
        sub += ` · S${String(ctx.seasonNumber).padStart(2, '0')}${ep}`;
    }
    return sub;
}

/** Owns the toolbar + list for one item, re-fetching only when the instance changes. */
class ReleaseView {
    private releases: ArrRelease[] = [];
    private filterText = '';
    private hideRejected = true;
    private sortKey: SortKey = 'default';
    private instanceName: string;
    // The instance the currently-rendered releases actually came from — Grab must target THIS, not
    // the (possibly since-changed) selection, so an out-of-order slow load can't grab cross-instance.
    private loadedInstance: string;
    // Monotonic load token: only the newest load() may apply its result.
    private loadSeq = 0;
    private listEl = el('div', 'je-arr-release-list');
    private countEl = el('div', 'je-arr-release-count');

    constructor(
        private modal: ArrModalHandle,
        private itemId: string,
        private service: ArrService,
        private instances: string[],
    ) {
        this.instanceName = instances[0];
        this.loadedInstance = instances[0];
    }

    mount(): void {
        this.modal.body.replaceChildren(this.buildToolbar(), this.countEl, this.listEl);
        void this.load();
    }

    private buildToolbar(): HTMLElement {
        const bar = el('div', 'je-arr-toolbar');

        if (this.instances.length > 1) {
            const select = el('select', 'je-arr-select');
            for (const name of this.instances) {
                const opt = el('option');
                opt.value = name;
                opt.textContent = name;
                select.appendChild(opt);
            }
            select.value = this.instanceName;
            select.addEventListener('change', () => { this.instanceName = select.value; void this.load(); });
            bar.appendChild(labeled(JE.t!('arr_search_instance'), select));
        }

        const filter = el('input', 'je-arr-filter');
        filter.type = 'search';
        filter.placeholder = JE.t!('arr_search_filter_placeholder');
        filter.addEventListener('input', () => { this.filterText = filter.value.toLowerCase(); this.renderList(); });
        bar.appendChild(filter);

        const sort = el('select', 'je-arr-select');
        for (const [value, key] of [['default', 'arr_search_sort_default'], ['size', 'arr_search_sort_size'], ['age', 'arr_search_sort_age'], ['seeders', 'arr_search_sort_seeders'], ['score', 'arr_search_sort_score']] as const) {
            const opt = el('option'); opt.value = value; opt.textContent = JE.t!(key); sort.appendChild(opt);
        }
        sort.addEventListener('change', () => { this.sortKey = sort.value as SortKey; this.renderList(); });
        bar.appendChild(labeled(JE.t!('arr_search_sort'), sort));

        const rejectLabel = el('label', 'je-arr-check');
        const reject = el('input');
        reject.type = 'checkbox';
        reject.checked = this.hideRejected;
        reject.addEventListener('change', () => { this.hideRejected = reject.checked; this.renderList(); });
        rejectLabel.appendChild(reject);
        rejectLabel.appendChild(document.createTextNode(JE.t!('arr_search_hide_rejected')));
        bar.appendChild(rejectLabel);

        return bar;
    }

    private async load(): Promise<void> {
        const seq = ++this.loadSeq;
        const instance = this.instanceName;
        renderCentered(this.listEl, spinner());
        this.countEl.textContent = '';
        try {
            const result = await fetchReleases(this.itemId, instance);
            if (seq !== this.loadSeq) return; // a newer instance selection superseded this load
            this.loadedInstance = instance;
            if (result.error) { renderCentered(this.listEl, message('error', result.error)); return; }
            this.releases = result.releases || [];
            this.renderList();
        } catch (e) {
            if (seq !== this.loadSeq) return;
            renderCentered(this.listEl, message('error', errorMessage(e)));
        }
    }

    private visibleReleases(): ArrRelease[] {
        let list = this.releases.slice();
        if (this.hideRejected) list = list.filter((r) => r.rejections.length === 0);
        if (this.filterText) list = list.filter((r) => (r.title || '').toLowerCase().includes(this.filterText));
        switch (this.sortKey) {
            case 'size': list.sort((a, b) => b.size - a.size); break;
            case 'age': list.sort((a, b) => a.ageHours - b.ageHours); break;
            case 'seeders': list.sort((a, b) => (b.seeders ?? -1) - (a.seeders ?? -1)); break;
            case 'score': list.sort((a, b) => b.customFormatScore - a.customFormatScore); break;
            default: break; // server order = best first
        }
        return list;
    }

    private renderList(): void {
        const list = this.visibleReleases();
        this.countEl.textContent = JE.t!('arr_search_release_count', { count: list.length, total: this.releases.length });
        if (list.length === 0) {
            renderCentered(this.listEl, message('info', this.releases.length === 0 ? JE.t!('arr_search_no_releases') : JE.t!('arr_search_no_matches')));
            return;
        }
        const frag = document.createDocumentFragment();
        for (const release of list) frag.appendChild(this.buildRow(release));
        this.listEl.replaceChildren(frag);
    }

    private buildRow(release: ArrRelease): HTMLElement {
        const row = el('div', 'je-arr-release');
        if (release.rejections.length > 0) row.classList.add('je-arr-rejected');

        const main = el('div', 'je-arr-release-main');
        main.appendChild(el('div', 'je-arr-release-title', release.title || '—'));

        const meta = el('div', 'je-arr-release-meta');
        if (release.quality) meta.appendChild(el('span', 'je-arr-badge', release.quality));
        meta.appendChild(el('span', 'je-arr-dim', formatSize(release.size)));
        meta.appendChild(el('span', 'je-arr-dim', formatAge(release.ageHours)));
        if (release.indexer) meta.appendChild(el('span', 'je-arr-dim', release.indexer));
        if (release.protocol === 'torrent') {
            meta.appendChild(el('span', 'je-arr-dim', JE.t!('arr_search_seeders', { seeders: release.seeders ?? 0, leechers: release.leechers ?? 0 })));
        } else if (release.protocol) {
            meta.appendChild(el('span', 'je-arr-dim', release.protocol));
        }
        if (release.releaseGroup) meta.appendChild(el('span', 'je-arr-dim', release.releaseGroup));
        if (release.customFormatScore) meta.appendChild(el('span', 'je-arr-dim', `CF ${release.customFormatScore}`));
        main.appendChild(meta);

        if (release.rejections.length > 0) {
            const rej = el('div', 'je-arr-release-rejections');
            const icon = el('span', 'material-icons warning');
            icon.setAttribute('aria-hidden', 'true');
            rej.appendChild(icon);
            rej.appendChild(document.createTextNode(release.rejections.join(' · ')));
            main.appendChild(rej);
        }

        const grab = el('button', 'je-arr-grab');
        grab.type = 'button';
        grab.title = JE.t!('arr_search_grab');
        const grabIcon = el('span', 'material-icons download');
        grabIcon.setAttribute('aria-hidden', 'true');
        grab.appendChild(grabIcon);
        grab.addEventListener('click', () => void this.grab(release, grab, grabIcon));

        row.appendChild(main);
        row.appendChild(grab);
        return row;
    }

    private async grab(release: ArrRelease, grab: HTMLButtonElement, icon: HTMLElement): Promise<void> {
        if (grab.disabled) return;
        grab.disabled = true;
        icon.className = 'material-icons hourglass_empty';
        try {
            await grabRelease(this.service, this.loadedInstance, release.guid, release.indexerId);
            grab.classList.add('je-arr-grabbed');
            icon.className = 'material-icons check';
            // Point the admin at the existing Downloads page for progress — never force-navigate
            // (that would yank them out of the picker mid-review) and never build a second view.
            toastSuccess(downloadsPageAvailable() ? JE.t!('arr_search_grab_sent_downloads') : JE.t!('arr_search_grab_sent'));
        } catch (e) {
            grab.disabled = false;
            icon.className = 'material-icons download';
            toastInfo(errorMessage(e));
        }
    }
}

function labeled(labelText: string, control: HTMLElement): HTMLElement {
    const wrap = el('label', 'je-arr-field');
    wrap.appendChild(el('span', 'je-arr-field-label', labelText));
    wrap.appendChild(control);
    return wrap;
}

function spinner(): HTMLElement {
    const s = el('div', 'je-arr-spinner');
    s.setAttribute('role', 'status');
    s.setAttribute('aria-label', JE.t!('arr_search_loading'));
    return s;
}

function message(kind: 'info' | 'error', text: string): HTMLElement {
    const wrap = el('div', `je-arr-message je-arr-message-${kind}`);
    const icon = el('span', `material-icons ${kind === 'error' ? 'error' : 'info'}`);
    icon.setAttribute('aria-hidden', 'true');
    wrap.appendChild(icon);
    wrap.appendChild(el('span', undefined, text));
    return wrap;
}

function renderCentered(container: HTMLElement, node: HTMLElement): void {
    const wrap = el('div', 'je-arr-center');
    wrap.appendChild(node);
    container.replaceChildren(wrap);
}
