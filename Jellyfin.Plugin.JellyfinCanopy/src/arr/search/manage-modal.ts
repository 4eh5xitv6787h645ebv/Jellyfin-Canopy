// src/arr/search/manage-modal.ts
//
// The "Sonarr/Radarr…" management modal: monitor/unmonitor per tracking instance, Add to an
// instance that doesn't track the item yet, an automatic Search button, and live download
// progress that reuses /arr/search/status (the same queue the Downloads page renders) with a
// deep-link to that page — never a second downloads view. All dynamic text is set via
// textContent; no HTML sinks.

import { JC } from '../../globals';
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
    const modal = createArrModal({ title: JC.t!('arr_search_manage'), subtitle: JC.t!('arr_search_loading'), icon: 'dns' });
    modal.body.replaceChildren(centered(spinner()));
    await new ManageView(modal, itemId).load();
}

class ManageView {
    private ctx: ArrContext | null = null;
    private queue: ArrQueueRow[] = [];
    private queueError: string | null = null;

    constructor(private modal: ArrModalHandle, private itemId: string) {}

    async load(): Promise<void> {
        if (!this.modal.isActive()) return;
        this.modal.body.replaceChildren(centered(spinner()));
        try {
            const [ctx, queueResult] = await Promise.all([
                fetchContext(this.itemId),
                fetchStatus(this.itemId)
                    .then(queue => ({ queue, error: null as string | null }))
                    .catch(error => ({ queue: [] as ArrQueueRow[], error: errorMessage(error) })),
            ]);
            if (!this.modal.isActive()) return;
            this.ctx = ctx;
            this.queue = queueResult.queue;
            this.queueError = queueResult.error;
        } catch (e) {
            if (!this.modal.isActive()) return;
            this.modal.body.replaceChildren(centered(message('error', errorMessage(e))));
            return;
        }
        this.render();
    }

    private render(): void {
        if (!this.modal.isActive()) return;
        const ctx = this.ctx!;
        this.modal.setSubtitle(ctx.name || '');

        if (ctx.kind === 'unknown' || !ctx.service) {
            this.modal.body.replaceChildren(centered(message('info', JC.t!('arr_search_not_arr_item'))));
            return;
        }
        if (!ctx.serviceConfigured) {
            this.modal.body.replaceChildren(centered(message('info', JC.t!('arr_search_service_not_configured'))));
            return;
        }

        const frag = document.createDocumentFragment();

        // Live download progress (shared with the Downloads page).
        // An incomplete upstream collection is unknown, not an empty/completed queue.
        if (this.queueError) frag.appendChild(message('error', this.queueError));
        if (this.queue.length > 0) frag.appendChild(this.buildProgress());

        // Tracked instances with a monitor toggle.
        if (ctx.targets.length > 0) {
            const section = el('div', 'jc-arr-section');
            section.appendChild(el('div', 'jc-arr-section-title', JC.t!('arr_search_tracked_in')));
            for (const target of ctx.targets) section.appendChild(this.buildTargetRow(target.instanceName, target.monitored, target.hasFile));
            frag.appendChild(section);
        } else {
            frag.appendChild(message('info', JC.t!('arr_search_not_tracked')));
        }

        // Add to instances that don't track it yet (movie/series only).
        if (ctx.canManage && ctx.addableInstances.length > 0) {
            const section = el('div', 'jc-arr-section');
            section.appendChild(el('div', 'jc-arr-section-title', JC.t!('arr_search_add_to')));
            for (const name of ctx.addableInstances) section.appendChild(this.buildAddRow(ctx.service, name));
            frag.appendChild(section);
        }

        this.modal.body.replaceChildren(frag);
        this.renderFooter();
    }

    private renderFooter(): void {
        if (!this.modal.isActive()) return;
        const ctx = this.ctx!;
        const footer = this.modal.footer;
        footer.replaceChildren();

        if (ctx.targets.length > 0) {
            const search = button('search', JC.t!('arr_search_search_now'), 'jc-arr-btn-primary');
            search.addEventListener('click', () => void this.doAutoSearch(search));
            footer.appendChild(search);
        }
        if (downloadsPageAvailable() && this.queue.length > 0) {
            const dl = button('download', JC.t!('arr_search_view_downloads'), 'jc-arr-btn');
            dl.addEventListener('click', () => {
                if (!this.modal.isActive()) return;
                navigateToDownloads();
                this.modal.close();
            });
            footer.appendChild(dl);
        }
    }

    private buildProgress(): HTMLElement {
        const section = el('div', 'jc-arr-section');
        section.appendChild(el('div', 'jc-arr-section-title', JC.t!('arr_search_downloading')));
        for (const row of this.queue) {
            const item = el('div', 'jc-arr-progress-row');
            item.appendChild(el('div', 'jc-arr-progress-title', row.title || '—'));
            const barWrap = el('div', 'jc-arr-progress-bar');
            const fill = el('div', 'jc-arr-progress-fill');
            fill.style.width = `${Math.max(0, Math.min(100, Number(row.progress) || 0))}%`;
            barWrap.appendChild(fill);
            item.appendChild(barWrap);
            const meta = el('div', 'jc-arr-progress-meta');
            meta.appendChild(el('span', undefined, `${(Number(row.progress) || 0).toFixed(0)}%`));
            if (row.timeRemaining) meta.appendChild(el('span', 'jc-arr-dim', row.timeRemaining));
            if (row.status) meta.appendChild(el('span', 'jc-arr-dim', row.status));
            item.appendChild(meta);
            section.appendChild(item);
        }
        return section;
    }

    private buildTargetRow(instanceName: string, monitored: boolean, hasFile: boolean): HTMLElement {
        const row = el('div', 'jc-arr-manage-row');
        const left = el('div', 'jc-arr-manage-left');
        left.appendChild(el('span', 'jc-arr-manage-name', instanceName));
        if (hasFile) left.appendChild(el('span', 'jc-arr-badge jc-arr-badge-ok', JC.t!('arr_search_has_file')));
        row.appendChild(left);

        const toggle = el('label', 'jc-arr-switch');
        const input = el('input');
        input.type = 'checkbox';
        input.checked = monitored;
        input.addEventListener('change', () => void this.toggleMonitor(instanceName, input));
        toggle.appendChild(input);
        toggle.appendChild(el('span', 'jc-arr-switch-track'));
        toggle.appendChild(el('span', 'jc-arr-switch-label', JC.t!('arr_search_monitored')));
        row.appendChild(toggle);
        return row;
    }

    private buildAddRow(service: ArrService, instanceName: string): HTMLElement {
        const row = el('div', 'jc-arr-manage-row');
        row.appendChild(el('span', 'jc-arr-manage-name', instanceName));
        const add = button('add', JC.t!('arr_search_add'), 'jc-arr-btn');
        add.addEventListener('click', () => void this.openAddForm(service, instanceName));
        row.appendChild(add);
        return row;
    }

    private async toggleMonitor(instanceName: string, input: HTMLInputElement): Promise<void> {
        if (!this.modal.isActive()) return;
        const wanted = input.checked;
        input.disabled = true;
        try {
            const result = await setMonitored(this.itemId, wanted, instanceName);
            if (!this.modal.isActive()) return;
            if (result.errors.length > 0 && result.dispatched.length === 0) throw new Error(result.errors[0].reason);
            toastSuccess(wanted ? JC.t!('arr_search_monitor_on') : JC.t!('arr_search_monitor_off'));
        } catch (e) {
            if (!this.modal.isActive()) return;
            input.checked = !wanted; // revert
            toastError(errorMessage(e));
        } finally {
            if (this.modal.isActive()) input.disabled = false;
        }
    }

    private async doAutoSearch(btn: HTMLButtonElement): Promise<void> {
        if (!this.modal.isActive()) return;
        btn.disabled = true;
        try {
            const result = await autoSearch(this.itemId);
            if (!this.modal.isActive()) return;
            reportDispatch(result.dispatched.length, result.errors.length);
        } catch (e) {
            if (!this.modal.isActive()) return;
            toastError(errorMessage(e));
        } finally {
            if (this.modal.isActive()) btn.disabled = false;
        }
    }

    private async openAddForm(service: ArrService, instanceName: string): Promise<void> {
        if (!this.modal.isActive()) return;
        this.modal.body.replaceChildren(centered(spinner()));
        let options: ArrAddOptions;
        try {
            options = await fetchAddOptions(service, instanceName);
        } catch (e) {
            if (!this.modal.isActive()) return;
            this.modal.body.replaceChildren(centered(message('error', errorMessage(e))));
            return;
        }
        if (!this.modal.isActive()) return;
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
        if (!this.modal.isActive()) return;
        const form = el('div', 'jc-arr-add-form');
        form.appendChild(el('div', 'jc-arr-section-title', JC.t!('arr_search_add_to_named', { name: this.instanceName })));

        const quality = selectFrom(this.options.qualityProfiles.map((p) => ({ value: String(p.id), label: p.name })));
        form.appendChild(field(JC.t!('arr_search_quality_profile'), quality));

        const root = selectFrom(this.options.rootFolders.map((r) => ({ value: r.path, label: r.path })));
        form.appendChild(field(JC.t!('arr_search_root_folder'), root));

        let minAvail: HTMLSelectElement | null = null;
        if (this.service === 'radarr' && this.options.minimumAvailabilityOptions?.length) {
            minAvail = selectFrom(this.options.minimumAvailabilityOptions.map((v) => ({ value: v, label: v })));
            minAvail.value = 'released';
            form.appendChild(field(JC.t!('arr_search_min_availability'), minAvail));
        }

        const monitored = checkbox(JC.t!('arr_search_monitored'), true);
        const search = checkbox(JC.t!('arr_search_search_on_add'), true);
        form.appendChild(monitored.label);
        form.appendChild(search.label);

        this.modal.body.replaceChildren(form);

        const footer = this.modal.footer;
        footer.replaceChildren();
        const cancel = button('arrow_back', JC.t!('arr_search_cancel'), 'jc-arr-btn');
        cancel.addEventListener('click', () => {
            if (this.modal.isActive()) this.onDone();
        });
        const submit = button('add', JC.t!('arr_search_add'), 'jc-arr-btn-primary');
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
        if (!this.modal.isActive()) return;
        if (!values.qualityProfileId || !values.rootFolderPath) { toastError(JC.t!('arr_search_add_missing_fields')); return; }
        btn.disabled = true;
        try {
            await addItem({ itemId: this.itemId, instanceName: this.instanceName, ...values });
            if (!this.modal.isActive()) return;
            toastSuccess(JC.t!('arr_search_add_success', { name: this.instanceName }));
            this.onDone();
        } catch (e) {
            if (!this.modal.isActive()) return;
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
            ? JC.t!('arr_search_started_downloads', { count: dispatched })
            : JC.t!('arr_search_started', { count: dispatched }));
    } else if (errors > 0) {
        toastError(JC.t!('arr_search_none_started'));
    } else {
        toastInfo(JC.t!('arr_search_not_tracked'));
    }
}

// ── small DOM builders ───────────────────────────────────────────────────────

function button(icon: string, text: string, className: string): HTMLButtonElement {
    const btn = el('button', `jc-arr-btn-base ${className}`);
    btn.type = 'button';
    const ic = el('span', `material-icons ${icon}`);
    ic.setAttribute('aria-hidden', 'true');
    btn.appendChild(ic);
    btn.appendChild(el('span', undefined, text));
    return btn;
}

function selectFrom(items: Array<{ value: string; label: string }>): HTMLSelectElement {
    const select = el('select', 'jc-arr-select');
    for (const item of items) {
        const opt = el('option');
        opt.value = item.value;
        opt.textContent = item.label;
        select.appendChild(opt);
    }
    return select;
}

function field(labelText: string, control: HTMLElement): HTMLElement {
    const wrap = el('div', 'jc-arr-form-field');
    wrap.appendChild(el('label', 'jc-arr-field-label', labelText));
    wrap.appendChild(control);
    return wrap;
}

function checkbox(labelText: string, checked: boolean): { label: HTMLElement; input: HTMLInputElement } {
    const label = el('label', 'jc-arr-check');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = checked;
    label.appendChild(input);
    label.appendChild(document.createTextNode(labelText));
    return { label, input };
}

function spinner(): HTMLElement {
    const s = el('div', 'jc-arr-spinner');
    s.setAttribute('role', 'status');
    s.setAttribute('aria-label', JC.t!('arr_search_loading'));
    return s;
}

function message(kind: 'info' | 'error', text: string): HTMLElement {
    const wrap = el('div', `jc-arr-message jc-arr-message-${kind}`);
    const icon = el('span', `material-icons ${kind === 'error' ? 'error' : 'info'}`);
    icon.setAttribute('aria-hidden', 'true');
    wrap.appendChild(icon);
    wrap.appendChild(el('span', undefined, text));
    return wrap;
}

function centered(node: HTMLElement): HTMLElement {
    const wrap = el('div', 'jc-arr-center');
    wrap.appendChild(node);
    return wrap;
}
