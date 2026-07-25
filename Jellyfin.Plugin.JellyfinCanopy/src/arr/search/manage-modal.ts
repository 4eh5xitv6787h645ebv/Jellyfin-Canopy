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
import type {
    ArrAddOptions,
    ArrContext,
    ArrDownloadLifecycle,
    ArrDownloadSection,
    ArrQueueRow,
    ArrQueueStatus,
    ArrService,
} from './types';

const STATUS_POLL_INTERVAL_MS = 10_000;
const MAX_STATUS_POLLS = 60;

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
    private queueErrors: ArrQueueStatus['errors'] = [];
    private queueComplete = true;
    private statusTransportError = false;
    private progressHost: HTMLElement | null = null;
    private readAbort: AbortController | null = null;
    private statusAbort: AbortController | null = null;
    private pollTimer: ReturnType<typeof setTimeout> | null = null;
    private pollsRemaining = MAX_STATUS_POLLS;
    private pollingEnabled = false;
    private disposed = false;

    constructor(private modal: ArrModalHandle, private itemId: string) {
        this.modal.onClose(() => this.dispose());
        document.addEventListener('visibilitychange', this.onVisibilityChange);
    }

    async load(): Promise<void> {
        if (!this.modal.isActive()) return;
        this.stopPolling();
        this.pollsRemaining = MAX_STATUS_POLLS;
        this.readAbort?.abort();
        const controller = new AbortController();
        this.readAbort = controller;
        const lastKnownStatus: ArrQueueStatus = {
            items: [...this.queue],
            errors: [...this.queueErrors],
            isComplete: false,
        };
        this.modal.body.replaceChildren(centered(spinner()));
        try {
            const [ctx, queueResult] = await Promise.all([
                fetchContext(this.itemId, controller.signal),
                fetchStatus(this.itemId, controller.signal)
                    .then(status => ({ status, failed: false }))
                    .catch(() => ({ status: lastKnownStatus, failed: true })),
            ]);
            if (!this.modal.isActive() || controller.signal.aborted) return;
            this.ctx = ctx;
            this.applyStatus(queueResult.status);
            this.statusTransportError = queueResult.failed;
        } catch (e) {
            if (!this.modal.isActive() || controller.signal.aborted || isAbortError(e)) return;
            this.modal.body.replaceChildren(centered(message('error', errorMessage(e))));
            return;
        } finally {
            if (this.readAbort === controller) this.readAbort = null;
        }
        this.render();
        if (this.canPoll()) this.startPolling();
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

        // Live normalized lifecycle status. The dedicated host is refreshed in place so polling
        // never replaces monitor/add controls or steals their focus.
        this.progressHost = el('div', 'jc-arr-progress-host');
        frag.appendChild(this.progressHost);
        this.renderProgress();

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
                if (navigateToDownloads()) this.modal.close();
            });
            footer.appendChild(dl);
        }
    }

    private renderProgress(): void {
        const host = this.progressHost;
        if (!host || !this.modal.isActive()) return;
        const frag = document.createDocumentFragment();

        if (this.statusTransportError) {
            const notice = message(
                'error',
                JC.t?.('downloads_snapshot_refresh_failed')
                    || 'Latest refresh failed. Showing the last known snapshot.'
            );
            notice.setAttribute('role', 'status');
            frag.appendChild(notice);
        }

        if (!this.queueComplete || this.queueErrors.length > 0) {
            frag.appendChild(this.buildDegradedNotice());
        }

        const sectionOrder: readonly ArrDownloadSection[] = ['downloading', 'processing', 'history'];
        for (const sectionName of sectionOrder) {
            const rows = this.queue.filter((row) => row.section === sectionName);
            if (rows.length === 0) continue;
            const section = el('div', 'jc-arr-section');
            section.appendChild(el('div', 'jc-arr-section-title', sectionLabel(sectionName)));
            for (const row of rows) section.appendChild(this.buildProgressRow(row));
            frag.appendChild(section);
        }
        host.replaceChildren(frag);
    }

    private buildDegradedNotice(): HTMLElement {
        const notice = message(
            'error',
            JC.t?.('downloads_snapshot_degraded')
                || 'Some download sources returned incomplete data.'
        );
        notice.classList.add('jc-arr-status-degraded');
        notice.setAttribute('role', 'status');
        if (this.queueErrors.length > 0) {
            const sources = el('div', 'jc-arr-status-errors');
            for (const sourceError of this.queueErrors) {
                sources.appendChild(el(
                    'div',
                    'jc-arr-dim',
                    sourceError.instanceName
                        ? `${sourceError.instanceName}: ${sourceError.reason}`
                        : sourceError.reason
                ));
            }
            notice.appendChild(sources);
        }
        return notice;
    }

    private buildProgressRow(row: ArrQueueRow): HTMLElement {
        const item = el('div', 'jc-arr-progress-row');
        // Downloader/release titles are intentionally absent from ArrQueueRow. The resolved
        // Jellyfin context is the only media name published in this admin consumer.
        item.appendChild(el('div', 'jc-arr-progress-title', this.ctx?.name || '—'));

        const progress = clampProgress(row.progress);
        if (progress !== null) {
            const roundedProgress = Math.round(progress * 10) / 10;
            const progressText = JC.t?.('downloads_transfer_progress', {
                progress: roundedProgress,
            }) || `Transfer progress: ${roundedProgress}%`;
            const barWrap = el('div', 'jc-arr-progress-bar');
            barWrap.setAttribute('role', 'progressbar');
            barWrap.setAttribute('aria-label', progressText);
            barWrap.setAttribute('aria-valuemin', '0');
            barWrap.setAttribute('aria-valuemax', '100');
            barWrap.setAttribute('aria-valuenow', String(roundedProgress));
            barWrap.setAttribute('aria-valuetext', progressText);
            const fill = el('div', 'jc-arr-progress-fill');
            fill.style.width = `${progress}%`;
            barWrap.appendChild(fill);
            item.appendChild(barWrap);
        }

        const meta = el('div', 'jc-arr-progress-meta');
        if (progress !== null) {
            meta.appendChild(el('span', undefined, `${progress.toFixed(0)}%`));
        }
        meta.appendChild(el('span', 'jc-arr-dim', lifecycleLabel(row.lifecycle)));
        if (row.timeRemaining) {
            meta.appendChild(el(
                'span',
                'jc-arr-dim',
                JC.t?.('downloads_time_remaining', { time: row.timeRemaining })
                    || `Time remaining: ${row.timeRemaining}`
            ));
        }
        const reason = reasonLabel(row.reasonCode, row.lifecycle);
        if (reason) meta.appendChild(el('span', 'jc-arr-dim', reason));
        if (row.instanceName) {
            const serviceName = row.service === 'sonarr' ? 'Sonarr' : 'Radarr';
            meta.appendChild(el('span', 'jc-arr-dim', `${serviceName} · ${row.instanceName}`));
        }
        item.appendChild(meta);
        return item;
    }

    private applyStatus(status: Readonly<ArrQueueStatus>): void {
        this.queue = [...status.items];
        this.queueErrors = [...status.errors];
        this.queueComplete = status.isComplete;
        this.statusTransportError = false;
    }

    private canPoll(): boolean {
        return !this.disposed
            && this.modal.isActive()
            && !!this.ctx?.service
            && this.ctx.serviceConfigured
            && this.ctx.targets.length > 0;
    }

    private startPolling(): void {
        if (!this.canPoll()) return;
        this.pollingEnabled = true;
        this.schedulePoll(STATUS_POLL_INTERVAL_MS);
    }

    private stopPolling(): void {
        this.pollingEnabled = false;
        this.clearPollTimer();
        this.statusAbort?.abort();
        this.statusAbort = null;
    }

    private clearPollTimer(): void {
        if (this.pollTimer == null) return;
        clearTimeout(this.pollTimer);
        this.pollTimer = null;
    }

    private schedulePoll(delayMs: number): void {
        if (!this.pollingEnabled
            || !this.canPoll()
            || this.pollsRemaining <= 0
            || document.visibilityState !== 'visible') return;
        this.clearPollTimer();
        this.pollTimer = setTimeout(() => {
            this.pollTimer = null;
            void this.pollStatus();
        }, delayMs);
    }

    private async pollStatus(): Promise<void> {
        if (!this.pollingEnabled
            || !this.canPoll()
            || this.pollsRemaining <= 0
            || document.visibilityState !== 'visible') return;

        this.pollsRemaining -= 1;
        const controller = new AbortController();
        this.statusAbort?.abort();
        this.statusAbort = controller;
        const hadRows = this.queue.length > 0;
        try {
            const status = await fetchStatus(this.itemId, controller.signal);
            if (!this.pollingEnabled
                || !this.modal.isActive()
                || controller.signal.aborted) return;
            this.applyStatus(status);
            this.renderProgress();
            if (hadRows !== (this.queue.length > 0)) this.renderFooter();
        } catch (error) {
            if (!this.pollingEnabled
                || !this.modal.isActive()
                || controller.signal.aborted
                || isAbortError(error)) return;
            // A transport failure is not an empty queue. Keep the last successful rows and make
            // the degraded state persistent until a later successful envelope replaces it.
            this.statusTransportError = true;
            this.renderProgress();
        } finally {
            if (this.statusAbort === controller) this.statusAbort = null;
            this.schedulePoll(STATUS_POLL_INTERVAL_MS);
        }
    }

    private readonly onVisibilityChange = (): void => {
        if (!this.pollingEnabled || !this.modal.isActive()) return;
        if (document.visibilityState !== 'visible') {
            this.clearPollTimer();
            this.statusAbort?.abort();
            this.statusAbort = null;
            return;
        }
        if (!this.statusAbort) this.schedulePoll(0);
    };

    private dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.stopPolling();
        this.readAbort?.abort();
        this.readAbort = null;
        this.progressHost = null;
        document.removeEventListener('visibilitychange', this.onVisibilityChange);
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
            if (result.dispatched.length > 0 && this.pollingEnabled) {
                this.schedulePoll(0);
            }
        } catch (e) {
            if (!this.modal.isActive()) return;
            toastError(errorMessage(e));
        } finally {
            if (this.modal.isActive()) btn.disabled = false;
        }
    }

    private async openAddForm(service: ArrService, instanceName: string): Promise<void> {
        if (!this.modal.isActive()) return;
        this.stopPolling();
        this.progressHost = null;
        this.readAbort?.abort();
        const controller = new AbortController();
        this.readAbort = controller;
        this.modal.body.replaceChildren(centered(spinner()));
        let options: ArrAddOptions;
        try {
            options = await fetchAddOptions(service, instanceName, controller.signal);
        } catch (e) {
            if (!this.modal.isActive() || controller.signal.aborted || isAbortError(e)) return;
            this.modal.body.replaceChildren(centered(message('error', errorMessage(e))));
            return;
        } finally {
            if (this.readAbort === controller) this.readAbort = null;
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

function sectionLabel(section: ArrDownloadSection): string {
    const labels: Record<ArrDownloadSection, string> = {
        downloading: JC.t?.('downloads_tab_downloading') || 'Downloading',
        processing: JC.t?.('downloads_tab_processing') || 'Processing & attention',
        history: JC.t?.('downloads_tab_history') || 'History',
    };
    return labels[section];
}

function lifecycleLabel(lifecycle: ArrDownloadLifecycle): string {
    const labels: Record<ArrDownloadLifecycle, string> = {
        queued: JC.t?.('downloads_lifecycle_queued') || 'Queued',
        downloading: JC.t?.('downloads_lifecycle_downloading') || 'Downloading',
        paused: JC.t?.('downloads_lifecycle_paused') || 'Paused',
        delayed: JC.t?.('downloads_lifecycle_delayed') || 'Delayed',
        postProcessing: JC.t?.('downloads_lifecycle_post_processing') || 'Post-processing',
        importPending: JC.t?.('downloads_lifecycle_import_pending') || 'Import pending',
        importing: JC.t?.('downloads_lifecycle_importing') || 'Importing',
        waitingForImport: JC.t?.('downloads_lifecycle_waiting_for_import') || 'Waiting for import',
        attention: JC.t?.('downloads_lifecycle_attention') || 'Needs attention',
        warning: JC.t?.('downloads_lifecycle_warning') || 'Warning',
        failed: JC.t?.('downloads_lifecycle_failed') || 'Failed',
        canceled: JC.t?.('downloads_lifecycle_canceled') || 'Canceled',
        removed: JC.t?.('downloads_lifecycle_removed') || 'Removed',
        imported: JC.t?.('downloads_lifecycle_imported') || 'Imported',
        unknown: JC.t?.('downloads_lifecycle_unknown') || 'Unknown state',
    };
    return labels[lifecycle] || labels.unknown;
}

function reasonLabel(
    reasonCode: string | null | undefined,
    lifecycle: ArrDownloadLifecycle
): string | null {
    const labels: Record<string, string> = {
        downloadClientUnavailable: JC.t?.('downloads_reason_download_client_unavailable')
            || 'The download client is unavailable.',
        fallback: JC.t?.('downloads_reason_fallback')
            || 'Only limited lifecycle information is available.',
        importBlocked: JC.t?.('downloads_reason_import_blocked')
            || 'Import is blocked and may need administrator attention.',
        failedPending: JC.t?.('downloads_reason_failed_pending')
            || 'A failure is still being reconciled.',
        downloadWarning: JC.t?.('downloads_reason_download_warning')
            || 'The download has an upstream warning.',
        downloadFailed: JC.t?.('downloads_reason_download_failed')
            || 'The download failed.',
        downloadIgnored: JC.t?.('downloads_reason_download_ignored')
            || 'The download was ignored by the library manager.',
        partialImport: JC.t?.('downloads_reason_partial_import')
            || 'Only part of this download has been imported.',
        transitionPending: JC.t?.('downloads_reason_transition_pending')
            || 'Waiting for authoritative lifecycle confirmation.',
        unknownState: JC.t?.('downloads_reason_unknown_state')
            || 'The upstream lifecycle state is not yet supported.',
    };
    if (reasonCode && Object.hasOwn(labels, reasonCode)) return labels[reasonCode];
    if (reasonCode
        || lifecycle === 'attention'
        || lifecycle === 'warning'
        || lifecycle === 'failed'
        || lifecycle === 'unknown') {
        return JC.t?.('downloads_reason_generic')
            || 'Additional lifecycle details are unavailable.';
    }
    return null;
}

function clampProgress(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return Math.max(0, Math.min(100, value));
}

function isAbortError(error: unknown): boolean {
    return (error as { name?: string } | null)?.name === 'AbortError';
}
