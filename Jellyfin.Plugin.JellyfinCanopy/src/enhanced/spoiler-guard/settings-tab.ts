// src/enhanced/spoiler-guard/settings-tab.ts
//
// Settings-panel wiring for the Spoiler Guard per-user override section (the
// HTML for which lives in settings-panel/template.ts). Each checkbox has a
// data-pref (the SpoilerBlurUserPrefs field) and an id prefixed "sbPref" — the
// selector anchors on that prefix so an unrelated module's bare data-pref can't
// trigger this save path. Checked = inherit admin (pref=null); unchecked = user
// opt-out (pref=false). SkipDisableConfirm is the exception: a direct boolean.

import { JC } from '../../globals';
import type { SpoilerUserPrefs } from './state';
import type { IdentityContext } from '../../types/jc';
import type { PanelContext } from '../settings-panel/panel';
import { AdminTargetPersistenceError } from '../settings-panel/editor-context';
import { escapeHtml, toast } from '../../core/ui-kit';

interface SettingsBinding {
    context: IdentityContext;
    boxes: HTMLInputElement[];
    cleanup(): void;
}

const settingsBindings = new Set<SettingsBinding>();

const logPrefix = '🪼 Jellyfin Canopy [SpoilerGuard]:';
const OVERRIDE_PAGE_SIZE = 50;

type TargetOverrideKind = 'series' | 'movie' | 'collection' | 'pending-tv' | 'pending-movie';

interface TargetOverrideRow {
    section: 'Series' | 'Movies' | 'Collections' | 'PendingTmdb';
    key: string;
    typeLabel: string;
    displayName: string;
}

function recordOf(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function setOwnDataProperty(
    target: Record<string, unknown>,
    key: string,
    value: unknown,
): void {
    Object.defineProperty(target, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
    });
}

function wireTargetOverrideManager(panel: PanelContext): void {
    const overrides = panel.editor.spoilerGuardOverrides;
    const saveTarget =
        panel.editor.saveSpoilerGuardOverrides?.bind(panel.editor);
    const host = panel.help.querySelector<HTMLElement>('#spoilerGuardTargetOverrides');
    const list = host?.querySelector<HTMLElement>('#spoilerGuardOverrideList');
    const pager = host?.querySelector<HTMLElement>('#spoilerGuardOverridePager');
    const form = host?.querySelector<HTMLFormElement>('#spoilerGuardOverrideAddForm');
    const typeSelect = host?.querySelector<HTMLSelectElement>('#spoilerGuardOverrideType');
    const idInput = host?.querySelector<HTMLInputElement>('#spoilerGuardOverrideId');
    const nameInput = host?.querySelector<HTMLInputElement>('#spoilerGuardOverrideName');
    const status = host?.querySelector<HTMLElement>('#spoilerGuardOverrideStatus');
    if (!overrides || !saveTarget || !host || !list || !pager || !form
        || !typeSelect || !idInput || !nameInput || !status) {
        return;
    }

    let active = true;
    let busy = false;
    let page = 0;
    const isLive = (): boolean => active
        && panel.editor.isCurrent()
        && host.isConnected;
    const requiredTranslation = (
        key: string,
        params?: Record<string, unknown>,
    ): string => JC.t?.(key, params) || key;
    const typeLabel = (kind: TargetOverrideKind): string => {
        const labels: Record<TargetOverrideKind, string> = {
            series: 'panel_settings_spoiler_guard_type_series',
            movie: 'panel_settings_spoiler_guard_type_movie',
            collection: 'panel_settings_spoiler_guard_type_collection',
            'pending-tv': 'panel_settings_spoiler_guard_type_pending_tv',
            'pending-movie': 'panel_settings_spoiler_guard_type_pending_movie',
        };
        return requiredTranslation(labels[kind]);
    };
    const targetOverrideSection = (
        name: TargetOverrideRow['section'],
    ): Record<string, unknown> => {
        const existing = recordOf(overrides[name]);
        if (existing) return existing;
        const created = { __proto__: null } as unknown as Record<string, unknown>;
        setOwnDataProperty(overrides, name, created);
        return created;
    };
    const storedKey = (
        values: Record<string, unknown>,
        canonicalKey: string,
    ): string => Object.keys(values).find(key =>
        key.toLowerCase() === canonicalKey.toLowerCase()) ?? canonicalKey;
    const rows = (): TargetOverrideRow[] => {
        const result: TargetOverrideRow[] = [];
        const append = (
            sectionName: TargetOverrideRow['section'],
            kind: TargetOverrideKind,
            nameField: string,
        ): void => {
            for (const [key, raw] of Object.entries(targetOverrideSection(sectionName))) {
                const entry = recordOf(raw);
                const displayName = typeof entry?.[nameField] === 'string'
                    ? String(entry[nameField]).trim()
                    : '';
                let resolvedKind = kind;
                if (sectionName === 'PendingTmdb') {
                    const mediaType = typeof entry?.MediaType === 'string'
                        ? entry.MediaType
                        : key.split(':', 1)[0];
                    resolvedKind = mediaType.toLowerCase() === 'movie'
                        ? 'pending-movie'
                        : 'pending-tv';
                }
                result.push({
                    section: sectionName,
                    key,
                    typeLabel: typeLabel(resolvedKind),
                    displayName: displayName || key,
                });
            }
        };
        append('Series', 'series', 'SeriesName');
        append('Movies', 'movie', 'MovieName');
        append('Collections', 'collection', 'CollectionName');
        append('PendingTmdb', 'pending-tv', 'DisplayName');
        return result.sort((left, right) =>
            left.typeLabel.localeCompare(right.typeLabel)
            || left.displayName.localeCompare(right.displayName)
            || left.key.localeCompare(right.key));
    };
    const setBusy = (value: boolean): void => {
        busy = value;
        for (const control of host.querySelectorAll<
            HTMLButtonElement | HTMLInputElement | HTMLSelectElement
        >('button,input,select')) {
            control.disabled = value;
        }
        host.setAttribute('aria-busy', String(value));
    };
    const setStatus = (message: string, error = false): void => {
        status.textContent = message;
        status.setAttribute('role', error ? 'alert' : 'status');
        status.setAttribute('aria-live', error ? 'assertive' : 'polite');
    };
    const persistenceErrorMessage = (error: unknown): string => {
        const classified = error instanceof AdminTargetPersistenceError
            ? error
            : null;
        if (classified?.kind === 'authorization') {
            return requiredTranslation('panel_admin_target_unauthorized');
        }
        if (classified?.kind === 'conflict') {
            return requiredTranslation('panel_admin_target_conflict_error');
        }
        return requiredTranslation('panel_admin_target_save_error');
    };
    status.tabIndex = -1;

    type RenderFocus =
        | { kind: 'page-summary' }
        | { kind: 'removed-neighbor'; index: number }
        | { kind: 'status' };
    const render = (focus?: RenderFocus): void => {
        if (!isLive()) return;
        const allRows = rows();
        const pageCount = Math.max(1, Math.ceil(allRows.length / OVERRIDE_PAGE_SIZE));
        page = Math.min(page, pageCount - 1);
        const visible = allRows.slice(
            page * OVERRIDE_PAGE_SIZE,
            (page + 1) * OVERRIDE_PAGE_SIZE,
        );
        const fragment = document.createDocumentFragment();
        if (visible.length === 0) {
            const empty = document.createElement('div');
            empty.textContent = requiredTranslation(
                'panel_settings_spoiler_guard_persistent_empty',
            );
            empty.style.color = 'rgba(255,255,255,0.6)';
            empty.style.fontSize = '12px';
            fragment.appendChild(empty);
        }
        for (const row of visible) {
            const item = document.createElement('div');
            item.className = 'jc-spoiler-override-row';
            const text = document.createElement('div');
            text.className = 'jc-spoiler-override-row-text';
            const title = document.createElement('div');
            title.textContent = row.displayName;
            title.style.fontSize = '12px';
            title.style.fontWeight = '600';
            const meta = document.createElement('div');
            meta.textContent = `${row.typeLabel} · ${row.key}`;
            meta.style.fontSize = '10px';
            meta.style.color = 'rgba(255,255,255,0.55)';
            text.append(title, meta);
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.textContent = requiredTranslation(
                'panel_settings_spoiler_guard_persistent_remove',
            );
            remove.setAttribute('aria-label', requiredTranslation(
                'panel_settings_spoiler_guard_persistent_remove_named',
                { name: row.displayName },
            ));
            remove.style.padding = '6px 9px';
            remove.style.borderRadius = '5px';
            remove.style.border = '1px solid rgba(255,255,255,0.18)';
            remove.style.background = 'rgba(255,255,255,0.06)';
            remove.style.color = '#fff';
            remove.disabled = busy;
            remove.addEventListener('click', () => {
                if (!isLive() || busy) return;
                const removedIndex = rows().findIndex(candidate =>
                    candidate.section === row.section
                    && candidate.key === row.key);
                delete targetOverrideSection(row.section)[row.key];
                setBusy(true);
                setStatus(requiredTranslation('panel_admin_target_saving'));
                void saveTarget().then(
                    () => {
                        if (!isLive()) return;
                        setBusy(false);
                        setStatus(requiredTranslation('panel_admin_target_saved'));
                        render({
                            kind: 'removed-neighbor',
                            index: Math.max(0, removedIndex),
                        });
                    },
                    async (error: unknown) => {
                        if (!isLive()) return;
                        console.warn(`${logPrefix} target override removal failed`, error);
                        setBusy(false);
                        setStatus(persistenceErrorMessage(error), true);
                        render({ kind: 'status' });
                        await panel.reconcileAfterSaveFailure();
                    },
                );
                panel.resetAutoCloseTimer();
            });
            item.append(text, remove);
            fragment.appendChild(item);
        }
        list.replaceChildren(fragment);

        const previous = document.createElement('button');
        previous.type = 'button';
        previous.textContent = requiredTranslation(
            'panel_settings_spoiler_guard_persistent_previous',
        );
        previous.disabled = busy || page === 0;
        previous.addEventListener('click', () => {
            if (!isLive() || page === 0) return;
            page--;
            render({ kind: 'page-summary' });
        });
        const summary = document.createElement('span');
        summary.tabIndex = -1;
        summary.textContent = requiredTranslation(
            'panel_settings_spoiler_guard_persistent_page',
            { current: page + 1, total: pageCount },
        );
        summary.style.fontSize = '11px';
        const next = document.createElement('button');
        next.type = 'button';
        next.textContent = requiredTranslation(
            'panel_settings_spoiler_guard_persistent_next',
        );
        next.disabled = busy || page + 1 >= pageCount;
        next.addEventListener('click', () => {
            if (!isLive() || page + 1 >= pageCount) return;
            page++;
            render({ kind: 'page-summary' });
        });
        pager.replaceChildren(previous, summary, next);
        if (focus?.kind === 'page-summary') {
            summary.focus();
        } else if (focus?.kind === 'removed-neighbor') {
            const nextGlobalIndex = Math.min(
                focus.index,
                allRows.length - 1,
            );
            const nextVisibleIndex = nextGlobalIndex
                - page * OVERRIDE_PAGE_SIZE;
            const nextRemove = list.querySelectorAll<HTMLButtonElement>(
                '.jc-spoiler-override-row button',
            )[nextVisibleIndex];
            if (nextRemove) nextRemove.focus();
            else status.focus();
        } else if (focus?.kind === 'status') {
            status.focus();
        }
    };

    const normalizeGuid = (value: string): string => {
        const normalized = value.trim().replace(/-/g, '').toLowerCase();
        return /^[0-9a-f]{32}$/.test(normalized)
            && normalized !== '00000000000000000000000000000000'
            ? normalized
            : '';
    };
    const normalizeTmdb = (value: string): string => {
        const normalized = value.trim();
        if (!/^[0-9]{1,10}$/.test(normalized)) return '';
        const parsed = Number(normalized);
        return Number.isSafeInteger(parsed)
            && parsed > 0
            && parsed <= 2_147_483_647
            ? String(parsed)
            : '';
    };
    const onSubmit = (event: SubmitEvent): void => {
        event.preventDefault();
        if (!isLive() || busy) return;
        const kind = typeSelect.value as TargetOverrideKind;
        const pending = kind === 'pending-tv' || kind === 'pending-movie';
        const id = pending
            ? normalizeTmdb(idInput.value)
            : normalizeGuid(idInput.value);
        const displayName = nameInput.value.trim();
        if (!id || !displayName || displayName.length > 512) {
            setStatus(requiredTranslation(
                'panel_settings_spoiler_guard_persistent_invalid',
            ), true);
            (!id ? idInput : nameInput).focus();
            return;
        }

        const now = new Date().toISOString();
        let sectionName: TargetOverrideRow['section'];
        let key: string;
        let entry: Record<string, unknown>;
        if (kind === 'series') {
            sectionName = 'Series';
            const values = targetOverrideSection(sectionName);
            key = storedKey(values, id);
            const existing = recordOf(values[key]);
            entry = {
                ...(existing || {}),
                SeriesId: key,
                SeriesName: displayName,
                EnabledAt: existing?.EnabledAt || now,
            };
        } else if (kind === 'movie') {
            sectionName = 'Movies';
            const values = targetOverrideSection(sectionName);
            key = storedKey(values, id);
            const existing = recordOf(values[key]);
            entry = {
                ...(existing || {}),
                MovieId: key,
                MovieName: displayName,
                EnabledAt: existing?.EnabledAt || now,
            };
        } else if (kind === 'collection') {
            sectionName = 'Collections';
            const values = targetOverrideSection(sectionName);
            key = storedKey(values, id);
            const existing = recordOf(values[key]);
            entry = {
                ...(existing || {}),
                CollectionId: key,
                CollectionName: displayName,
                EnabledAt: existing?.EnabledAt || now,
            };
        } else {
            sectionName = 'PendingTmdb';
            const mediaType = kind === 'pending-movie' ? 'movie' : 'tv';
            const values = targetOverrideSection(sectionName);
            key = storedKey(values, `${mediaType}:${id}`);
            const existing = recordOf(values[key]);
            entry = {
                ...(existing || {}),
                MediaType: mediaType,
                TmdbId: id,
                DisplayName: displayName,
                RequestedAt: existing?.RequestedAt || now,
            };
        }
        setOwnDataProperty(targetOverrideSection(sectionName), key, entry);
        setBusy(true);
        setStatus(requiredTranslation('panel_admin_target_saving'));
        void saveTarget().then(
            () => {
                if (!isLive()) return;
                idInput.value = '';
                nameInput.value = '';
                page = Math.max(0, Math.ceil(rows().length / OVERRIDE_PAGE_SIZE) - 1);
                setBusy(false);
                setStatus(requiredTranslation('panel_admin_target_saved'));
                render();
                idInput.focus();
            },
            async (error: unknown) => {
                if (!isLive()) return;
                console.warn(`${logPrefix} target override add failed`, error);
                setBusy(false);
                setStatus(persistenceErrorMessage(error), true);
                render();
                status.focus();
                await panel.reconcileAfterSaveFailure();
            },
        );
        panel.resetAutoCloseTimer();
    };
    form.addEventListener('submit', onSubmit);
    panel.registerCleanup(() => {
        active = false;
        form.removeEventListener('submit', onSubmit);
        setBusy(true);
    });
    render();
}

/**
 * Wire the Spoiler Guard override checkboxes in the settings panel.
 * @param resetAutoCloseTimer - Panel helper to defer the auto-close timer.
 */
export function wireSpoilerGuardListeners(
    panelOrReset: unknown,
): void {
    const panel = typeof panelOrReset === 'function'
        ? null
        : panelOrReset as PanelContext;
    const resetAutoCloseTimer = typeof panelOrReset === 'function'
        ? panelOrReset as () => void
        : panel!.resetAutoCloseTimer;

    if (panel?.editor.mode === 'admin-target') {
        wireTargetOverrideManager(panel);
        const prefs = panel.editor.spoilerGuardPrefs;
        const saveTarget =
            panel.editor.saveSpoilerGuardPrefs?.bind(panel.editor);
        if (!prefs || !saveTarget) return;
        const boxes = Array.from(
            panel.help.querySelectorAll<HTMLInputElement>(
                'input[type="checkbox"][id^="sbPref"][data-pref]',
            ),
        );
        if (boxes.length === 0) return;
        const status = panel.help.querySelector<HTMLElement>('#spoilerGuardSaveStatus');
        const translatedStatus = (key: string): string => JC.t?.(key) || key;
        let active = true;
        const isLive = (box?: HTMLInputElement): boolean => active
            && panel.editor.isCurrent()
            && (!box || box.isConnected);
        const setDisabled = (value: boolean): void => {
            for (const box of boxes) box.disabled = value;
            status?.setAttribute('aria-busy', String(value));
        };
        const setStatus = (message: string, error = false): void => {
            if (!status) return;
            status.textContent = message;
            status.setAttribute('role', error ? 'alert' : 'status');
            status.setAttribute('aria-live', error ? 'assertive' : 'polite');
        };
        for (const box of boxes) {
            box.addEventListener('change', () => {
                if (!isLive(box)) return;
                const previousChecked = !box.checked;
                const key = box.dataset.pref!;
                prefs[key] = key === 'SkipDisableConfirm'
                    ? box.checked
                    : (box.checked ? null : false);
                setDisabled(true);
                setStatus(translatedStatus('panel_admin_target_saving'));
                void saveTarget().then(
                    () => {
                        if (!isLive(box)) return;
                        setDisabled(false);
                        setStatus(translatedStatus('panel_admin_target_saved'));
                    },
                    async (error: unknown) => {
                        if (!isLive(box)) return;
                        box.checked = previousChecked;
                        prefs[key] = key === 'SkipDisableConfirm'
                            ? previousChecked
                            : (previousChecked ? null : false);
                        const classified = error instanceof AdminTargetPersistenceError
                            ? error
                            : null;
                        const translationKey = classified?.kind === 'authorization'
                            ? 'panel_admin_target_unauthorized'
                            : classified?.kind === 'conflict'
                                ? 'panel_admin_target_conflict_error'
                                : 'panel_admin_target_save_error';
                        const message = translatedStatus(translationKey);
                        setStatus(`${message} ${translatedStatus(
                            'panel_admin_target_refresh_status',
                        )}`, true);
                        toast(escapeHtml(message));
                        setDisabled(false);
                        await panel.reconcileAfterSaveFailure();
                    },
                );
                resetAutoCloseTimer();
            });
        }
        panel.registerCleanup(() => {
            active = false;
            setDisabled(true);
        });
        return;
    }

    const context = JC.identity.capture();
    if (!context || !JC.identity.isCurrent(context)) return;
    if (JC.pluginConfig?.SpoilerBlurEnabled !== true) return;
    const spoilerGuard = JC.spoilerGuard;
    if (!spoilerGuard) return;

    // A normally-closed settings panel removes its DOM without notifying this
    // module. Prune that prior binding before wiring the next panel so the
    // synchronous reset registry stays bounded.
    for (const binding of Array.from(settingsBindings)) {
        if (!binding.boxes.some((box) => box.isConnected)) binding.cleanup();
    }

    const boxes = Array.from(
        document.querySelectorAll<HTMLInputElement>('input[type="checkbox"][id^="sbPref"][data-pref]')
    );
    if (boxes.length === 0) return;

    let active = true;
    const isLive = (box?: HTMLInputElement): boolean => active
        && JC.identity.isCurrent(context)
        && (!box || box.isConnected);
    const setBoxesDisabled = (disabled: boolean): void => { for (const b of boxes) b.disabled = disabled; };

    const saveSbPrefs = async (changedBox: HTMLInputElement, previousChecked: boolean): Promise<void> => {
        if (!isLive(changedBox)) return;
        setBoxesDisabled(true);
        try {
            // Avoid the cold-load race: don't write from the in-memory cache
            // until loadState() populated it, or an early toggle POSTs an
            // empty-cache payload that silently clobbers stored prefs.
            await spoilerGuard.whenLoaded();
            if (!isLive(changedBox)) return;
            // Refuse to save when the initial GET failed — the cache is empty
            // and writing from it would clobber stored prefs.
            if (!spoilerGuard.isLoadOk()) {
                throw new Error('Initial Spoiler Guard load failed; refusing to overwrite stored prefs.');
            }
            // Build the payload from the authoritative cache, then overlay ONLY
            // the box just clicked — a full-DOM read is unsafe if the panel
            // rendered before load resolved.
            const current: SpoilerUserPrefs = spoilerGuard.getUserPrefs();
            const k = changedBox.dataset.pref!;
            if (k === 'SkipDisableConfirm') {
                current[k] = changedBox.checked;
            } else {
                // Unchecked = user opts to SEE the field (false); checked = follow
                // admin (null, so later admin policy flips track through).
                current[k] = changedBox.checked ? null : false;
            }
            if (!isLive(changedBox)) return;
            await spoilerGuard.setUserPrefs(current);
            if (!isLive(changedBox)) return;
            // The server cache is a projection of these per-user preferences.
            // A rescan cannot restore ratings/tags stripped from its existing
            // bytes (or remove already-rendered values in the reverse direction),
            // so rebuild the authoritative projection after any policy override.
            if (k !== 'SkipDisableConfirm') {
                await JC.tagPipeline?.invalidateServerCache?.();
                if (!isLive(changedBox)) return;
            }
        } catch (err) {
            if (!isLive(changedBox)) return;
            console.error(`${logPrefix} saveSbPrefs failed:`, err);
            // Revert the box the user clicked so they see the change didn't stick.
            changedBox.checked = previousChecked;
            JC.toast?.(JC.t!('spoiler_blur_error_toast'));
        } finally {
            // A's stale finally must not re-enable a retained control after B
            // has synchronously torn the panel down.
            if (isLive(changedBox)) setBoxesDisabled(false);
        }
    };

    const listeners = new Map<HTMLInputElement, () => void>();
    for (const box of boxes) {
        const listener = (): void => {
            if (!isLive(box)) return;
            // .checked already flipped by the time `change` fires; negate for revert.
            const previousChecked = !box.checked;
            void saveSbPrefs(box, previousChecked);
            if (isLive(box)) resetAutoCloseTimer();
        };
        listeners.set(box, listener);
        box.addEventListener('change', listener);
    }

    const binding: SettingsBinding = {
        context,
        boxes,
        cleanup(): void {
            if (!active) return;
            active = false;
            for (const [box, listener] of listeners) {
                box.removeEventListener('change', listener);
                box.disabled = true;
            }
            settingsBindings.delete(binding);
        },
    };
    settingsBindings.add(binding);

    // Rows render from a synchronous getUserPrefs() that may run before the
    // initial load resolves (or after it fails), defaulting every box to
    // "checked" (inherit). Re-sync once the load settles; if it failed, disable
    // the section rather than show editable-but-wrong checkboxes.
    void (async () => {
        try {
            await spoilerGuard.whenLoaded();
            if (!isLive()) return;
            if (!spoilerGuard.isLoadOk()) {
                setBoxesDisabled(true);
                return;
            }
            const loaded = spoilerGuard.getUserPrefs();
            for (const b of boxes) {
                if (!isLive(b)) return;
                const k = b.dataset.pref!;
                b.checked = k === 'SkipDisableConfirm'
                    ? !!loaded[k]
                    : loaded[k] !== false; // checked = inherit; unchecked = opt-out (false)
            }
        } catch (syncErr) {
            if (isLive()) console.warn(`${logPrefix} pref re-sync failed:`, syncErr);
        }
    })();
}

export function resetSpoilerSettingsControls(): void {
    for (const binding of Array.from(settingsBindings)) binding.cleanup();
}
