// src/arr/search/manage-modal.ts
//
// The "Sonarr/Radarr…" management modal: monitor/unmonitor per tracking instance, Add to an
// instance that doesn't track the item yet, an automatic Search button, and live download
// progress that reuses /arr/search/status (the same queue the Downloads page renders) with a
// deep-link to that page — never a second downloads view. All dynamic text is set via
// textContent; no HTML sinks.

import { JE } from '../../globals';
import { createArrModal, type ArrModalHandle } from './modal';
import {
    fetchContext, fetchStatus, setMonitored, autoSearch, fetchAddOptions, addItem,
    errorMessage, toastSuccess, toastError, toastInfo, navigateToDownloads, downloadsPageAvailable,
} from './actions';
import type { ArrContext, ArrService, ArrQueueRow, ArrAddOptions } from './types';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

/** Opens the management modal for a Jellyfin item id. */
export async function openManage(itemId: string): Promise<void> {
    const modal = createArrModal({ title: JE.t!('arr_search_manage'), subtitle: JE.t!('arr_search_loading'), icon: 'dns' });
    modal.body.replaceChildren(centered(spinner()));
    await new ManageView(modal, itemId).load();
}

class ManageView {
    private ctx: ArrContext | null = null;
    private queue: ArrQueueRow[] = [];

    constructor(private modal: ArrModalHandle, private itemId: string) {}

    async load(): Promise<void> {
        this.modal.body.replaceChildren(centered(spinner()));
        try {
            const [ctx, queue] = await Promise.all([fetchContext(this.itemId), fetchStatus(this.itemId).catch(() => [])]);
            this.ctx = ctx;
            this.queue = queue;
        } catch (e) {
            this.modal.body.replaceChildren(centered(message('error', errorMessage(e))));
            return;
        }
        this.render();
    }

    private render(): void {
        const ctx = this.ctx!;
        this.modal.setSubtitle(ctx.name || '');

        if (ctx.kind === 'unknown' || !ctx.service) {
            this.modal.body.replaceChildren(centered(message('info', JE.t!('arr_search_not_arr_item'))));
            return;
        }
        if (!ctx.serviceConfigured) {
            this.modal.body.replaceChildren(centered(message('info', JE.t!('arr_search_service_not_configured'))));
            return;
        }

        const frag = document.createDocumentFragment();

        // Live download progress (shared with the Downloads page).
        if (this.queue.length > 0) frag.appendChild(this.buildProgress());

        // Tracked instances with a monitor toggle.
        if (ctx.targets.length > 0) {
            const section = el('div', 'je-arr-section');
            section.appendChild(el('div', 'je-arr-section-title', JE.t!('arr_search_tracked_in')));
            for (const target of ctx.targets) section.appendChild(this.buildTargetRow(target.instanceName, target.monitored, target.hasFile));
            frag.appendChild(section);
        } else {
            frag.appendChild(message('info', JE.t!('arr_search_not_tracked')));
        }

        // Add to instances that don't track it yet (movie/series only).
        if (ctx.canManage && ctx.addableInstances.length > 0) {
            const section = el('div', 'je-arr-section');
            section.appendChild(el('div', 'je-arr-section-title', JE.t!('arr_search_add_to')));
            for (const name of ctx.addableInstances) section.appendChild(this.buildAddRow(ctx.service, name));
            frag.appendChild(section);
        }

        this.modal.body.replaceChildren(frag);
        this.renderFooter();
    }

    private renderFooter(): void {
        const ctx = this.ctx!;
        const footer = this.modal.footer;
        footer.replaceChildren();

        if (ctx.targets.length > 0) {
            const search = button('search', JE.t!('arr_search_search_now'), 'je-arr-btn-primary');
            search.addEventListener('click', () => void this.doAutoSearch(search));
            footer.appendChild(search);
        }
        if (downloadsPageAvailable() && this.queue.length > 0) {
            const dl = button('download', JE.t!('arr_search_view_downloads'), 'je-arr-btn');
            dl.addEventListener('click', () => { navigateToDownloads(); this.modal.close(); });
            footer.appendChild(dl);
        }
    }

    private buildProgress(): HTMLElement {
        const section = el('div', 'je-arr-section');
        section.appendChild(el('div', 'je-arr-section-title', JE.t!('arr_search_downloading')));
        for (const row of this.queue) {
            const item = el('div', 'je-arr-progress-row');
            item.appendChild(el('div', 'je-arr-progress-title', row.title || '—'));
            const barWrap = el('div', 'je-arr-progress-bar');
            const fill = el('div', 'je-arr-progress-fill');
            fill.style.width = `${Math.max(0, Math.min(100, Number(row.progress) || 0))}%`;
            barWrap.appendChild(fill);
            item.appendChild(barWrap);
            const meta = el('div', 'je-arr-progress-meta');
            meta.appendChild(el('span', undefined, `${(Number(row.progress) || 0).toFixed(0)}%`));
            if (row.timeRemaining) meta.appendChild(el('span', 'je-arr-dim', row.timeRemaining));
            if (row.status) meta.appendChild(el('span', 'je-arr-dim', row.status));
            item.appendChild(meta);
            section.appendChild(item);
        }
        return section;
    }

    private buildTargetRow(instanceName: string, monitored: boolean, hasFile: boolean): HTMLElement {
        const row = el('div', 'je-arr-manage-row');
        const left = el('div', 'je-arr-manage-left');
        left.appendChild(el('span', 'je-arr-manage-name', instanceName));
        if (hasFile) left.appendChild(el('span', 'je-arr-badge je-arr-badge-ok', JE.t!('arr_search_has_file')));
        row.appendChild(left);

        const toggle = el('label', 'je-arr-switch');
        const input = el('input');
        input.type = 'checkbox';
        input.checked = monitored;
        input.addEventListener('change', () => void this.toggleMonitor(instanceName, input));
        toggle.appendChild(input);
        toggle.appendChild(el('span', 'je-arr-switch-track'));
        toggle.appendChild(el('span', 'je-arr-switch-label', JE.t!('arr_search_monitored')));
        row.appendChild(toggle);
        return row;
    }

    private buildAddRow(service: ArrService, instanceName: string): HTMLElement {
        const row = el('div', 'je-arr-manage-row');
        row.appendChild(el('span', 'je-arr-manage-name', instanceName));
        const add = button('add', JE.t!('arr_search_add'), 'je-arr-btn');
        add.addEventListener('click', () => void this.openAddForm(service, instanceName));
        row.appendChild(add);
        return row;
    }

    private async toggleMonitor(instanceName: string, input: HTMLInputElement): Promise<void> {
        const wanted = input.checked;
        input.disabled = true;
        try {
            const result = await setMonitored(this.itemId, wanted, instanceName);
            if (result.errors.length > 0 && result.dispatched.length === 0) throw new Error(result.errors[0].reason);
            toastSuccess(wanted ? JE.t!('arr_search_monitor_on') : JE.t!('arr_search_monitor_off'));
        } catch (e) {
            input.checked = !wanted; // revert
            toastError(errorMessage(e));
        } finally {
            input.disabled = false;
        }
    }

    private async doAutoSearch(btn: HTMLButtonElement): Promise<void> {
        btn.disabled = true;
        try {
            const result = await autoSearch(this.itemId);
            reportDispatch(result.dispatched.length, result.errors.length);
        } catch (e) {
            toastError(errorMessage(e));
        } finally {
            btn.disabled = false;
        }
    }

    private async openAddForm(service: ArrService, instanceName: string): Promise<void> {
        this.modal.body.replaceChildren(centered(spinner()));
        let options: ArrAddOptions;
        try {
            options = await fetchAddOptions(service, instanceName);
        } catch (e) {
            this.modal.body.replaceChildren(centered(message('error', errorMessage(e))));
            return;
        }
        if (options.error) { this.modal.body.replaceChildren(centered(message('error', options.error))); return; }
        new AddForm(this.modal, this.itemId, service, instanceName, options, () => void this.load()).render();
    }
}

/** Inline add form rendered into the manage modal body. */
class AddForm {
    constructor(
        private modal: ArrModalHandle,
        private itemId: string,
        private service: ArrService,
        private instanceName: string,
        private options: ArrAddOptions,
        private onDone: () => void,
    ) {}

    render(): void {
        const form = el('div', 'je-arr-add-form');
        form.appendChild(el('div', 'je-arr-section-title', JE.t!('arr_search_add_to_named', { name: this.instanceName })));

        const quality = selectFrom(this.options.qualityProfiles.map((p) => ({ value: String(p.id), label: p.name })));
        form.appendChild(field(JE.t!('arr_search_quality_profile'), quality));

        const root = selectFrom(this.options.rootFolders.map((r) => ({ value: r.path, label: r.path })));
        form.appendChild(field(JE.t!('arr_search_root_folder'), root));

        let minAvail: HTMLSelectElement | null = null;
        if (this.service === 'radarr' && this.options.minimumAvailabilityOptions?.length) {
            minAvail = selectFrom(this.options.minimumAvailabilityOptions.map((v) => ({ value: v, label: v })));
            minAvail.value = 'released';
            form.appendChild(field(JE.t!('arr_search_min_availability'), minAvail));
        }

        const monitored = checkbox(JE.t!('arr_search_monitored'), true);
        const search = checkbox(JE.t!('arr_search_search_on_add'), true);
        form.appendChild(monitored.label);
        form.appendChild(search.label);

        this.modal.body.replaceChildren(form);

        const footer = this.modal.footer;
        footer.replaceChildren();
        const cancel = button('arrow_back', JE.t!('arr_search_cancel'), 'je-arr-btn');
        cancel.addEventListener('click', () => this.onDone());
        const submit = button('add', JE.t!('arr_search_add'), 'je-arr-btn-primary');
        submit.addEventListener('click', () => void this.submit(submit, {
            qualityProfileId: Number(quality.value),
            rootFolderPath: root.value,
            monitored: monitored.input.checked,
            searchOnAdd: search.input.checked,
            minimumAvailability: minAvail?.value ?? null,
        }));
        footer.appendChild(cancel);
        footer.appendChild(submit);
    }

    private async submit(btn: HTMLButtonElement, values: { qualityProfileId: number; rootFolderPath: string; monitored: boolean; searchOnAdd: boolean; minimumAvailability: string | null }): Promise<void> {
        if (!values.qualityProfileId || !values.rootFolderPath) { toastError(JE.t!('arr_search_add_missing_fields')); return; }
        btn.disabled = true;
        try {
            await addItem({ itemId: this.itemId, instanceName: this.instanceName, ...values });
            toastSuccess(JE.t!('arr_search_add_success', { name: this.instanceName }));
            this.onDone();
        } catch (e) {
            btn.disabled = false;
            toastError(errorMessage(e));
        }
    }
}

// ── shared feedback ──────────────────────────────────────────────────────────

/** Toasts the outcome of an automatic search dispatch. */
export function reportDispatch(dispatched: number, errors: number): void {
    if (dispatched > 0) {
        toastSuccess(downloadsPageAvailable()
            ? JE.t!('arr_search_started_downloads', { count: dispatched })
            : JE.t!('arr_search_started', { count: dispatched }));
    } else if (errors > 0) {
        toastError(JE.t!('arr_search_none_started'));
    } else {
        toastInfo(JE.t!('arr_search_not_tracked'));
    }
}

// ── small DOM builders ───────────────────────────────────────────────────────

function button(icon: string, text: string, className: string): HTMLButtonElement {
    const btn = el('button', `je-arr-btn-base ${className}`);
    btn.type = 'button';
    const ic = el('span', `material-icons ${icon}`);
    ic.setAttribute('aria-hidden', 'true');
    btn.appendChild(ic);
    btn.appendChild(el('span', undefined, text));
    return btn;
}

function selectFrom(items: Array<{ value: string; label: string }>): HTMLSelectElement {
    const select = el('select', 'je-arr-select');
    for (const item of items) {
        const opt = el('option');
        opt.value = item.value;
        opt.textContent = item.label;
        select.appendChild(opt);
    }
    return select;
}

function field(labelText: string, control: HTMLElement): HTMLElement {
    const wrap = el('div', 'je-arr-form-field');
    wrap.appendChild(el('label', 'je-arr-field-label', labelText));
    wrap.appendChild(control);
    return wrap;
}

function checkbox(labelText: string, checked: boolean): { label: HTMLElement; input: HTMLInputElement } {
    const label = el('label', 'je-arr-check');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = checked;
    label.appendChild(input);
    label.appendChild(document.createTextNode(labelText));
    return { label, input };
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

function centered(node: HTMLElement): HTMLElement {
    const wrap = el('div', 'je-arr-center');
    wrap.appendChild(node);
    return wrap;
}
