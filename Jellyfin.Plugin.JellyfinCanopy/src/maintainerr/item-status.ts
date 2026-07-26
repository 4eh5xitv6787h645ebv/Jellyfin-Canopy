import type { FeatureScope } from '../core/feature-loader';
import {
    registerDetailsIntegration,
    type DetailsIntegration,
    type DetailsIntegrationContext,
} from '../enhanced/features/details-page';
import { JC } from '../globals';
import { optionalHref } from './types';
import { describeMaintainerrRequestError } from './request-error';
import {
    injectMaintainerrItemStatusStyles,
    removeMaintainerrItemStatusStyles,
} from './item-status-styles';

const SUPPORTED_TYPES = new Set(['Movie', 'Series', 'Season', 'Episode']);
const MAX_DETAIL_ENTRIES = 100;
const MAX_LABEL_LENGTH = 256;

export interface MaintainerrItemStatusReference {
    label: string;
    href?: string;
}

export interface MaintainerrRegularItemStatus {
    protectedFromCleanup: boolean;
    manuallyManaged: boolean;
}

export interface MaintainerrAdminItemStatus extends MaintainerrRegularItemStatus {
    excludedFrom: MaintainerrItemStatusReference[];
    manuallyAddedTo: MaintainerrItemStatusReference[];
}

type MaintainerrItemStatus = MaintainerrRegularItemStatus | MaintainerrAdminItemStatus;
type Phase = 'idle' | 'loading' | 'success' | 'error';

function objectValue(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function parseReferences(value: unknown): MaintainerrItemStatusReference[] | null {
    if (!Array.isArray(value) || value.length > MAX_DETAIL_ENTRIES) return null;
    const references: MaintainerrItemStatusReference[] = [];
    for (const raw of value) {
        const object = objectValue(raw);
        if (!object
            || typeof object.label !== 'string'
            || object.label.length > MAX_LABEL_LENGTH
            || /[\u0000-\u001f\u007f]/.test(object.label)) return null;
        const label = object.label.trim();
        if (!label) return null;
        const href = optionalHref(object.href);
        if (object.href !== undefined && object.href !== null && !href) return null;
        references.push({ label, href });
    }
    return references;
}

/**
 * Parse role-specific DTOs. A regular response must contain exactly the two
 * generic booleans; receiving admin fields is treated as a contract failure,
 * not silently hidden after over-fetching.
 */
export function parseMaintainerrItemStatus(
    value: unknown,
    administrator: boolean,
): MaintainerrItemStatus | null {
    const object = objectValue(value);
    if (!object
        || typeof object.protectedFromCleanup !== 'boolean'
        || typeof object.manuallyManaged !== 'boolean') return null;
    if (!administrator) {
        const keys = Object.keys(object).sort();
        if (keys.length !== 2
            || keys[0] !== 'manuallyManaged'
            || keys[1] !== 'protectedFromCleanup') return null;
        return {
            protectedFromCleanup: object.protectedFromCleanup,
            manuallyManaged: object.manuallyManaged,
        };
    }
    const keys = Object.keys(object).sort();
    if (keys.length !== 4
        || keys[0] !== 'excludedFrom'
        || keys[1] !== 'manuallyAddedTo'
        || keys[2] !== 'manuallyManaged'
        || keys[3] !== 'protectedFromCleanup') return null;
    const excludedFrom = parseReferences(object.excludedFrom);
    const manuallyAddedTo = parseReferences(object.manuallyAddedTo);
    if (!excludedFrom || !manuallyAddedTo) return null;
    return {
        protectedFromCleanup: object.protectedFromCleanup,
        manuallyManaged: object.manuallyManaged,
        excludedFrom,
        manuallyAddedTo,
    };
}

function text(key: string, fallback: string): string {
    const translated = JC.t?.(key);
    return translated && translated !== key ? translated : fallback;
}

function removeStatusNodes(page?: Element): void {
    const root = page ?? document;
    root.querySelectorAll(
        '.jc-maintainerr-item-status-slot, .jc-maintainerr-item-status, '
            + '.jc-maintainerr-item-status-details',
    ).forEach((node) => node.remove());
}

function appendIcon(parent: Element, name: string): void {
    const icon = document.createElement('span');
    icon.className = 'material-icons';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = name;
    parent.appendChild(icon);
}

function addChip(
    slot: HTMLElement,
    context: DetailsIntegrationContext,
    className: string,
    iconName: string,
    label: string,
): void {
    const chip = document.createElement('span');
    chip.className = `mediaInfoItem jc-maintainerr-item-status ${className}`;
    chip.dataset.itemId = context.itemId;
    appendIcon(chip, iconName);
    const value = document.createElement('span');
    value.textContent = label;
    chip.appendChild(value);
    slot.appendChild(chip);
}

function addReferenceRow(
    root: HTMLElement,
    label: string,
    references: readonly MaintainerrItemStatusReference[],
): void {
    if (references.length === 0) return;
    const row = document.createElement('div');
    row.className = 'jc-maintainerr-item-status-row';
    const heading = document.createElement('span');
    heading.className = 'jc-maintainerr-item-status-label';
    heading.textContent = label;
    row.appendChild(heading);
    for (const reference of references) {
        if (reference.href) {
            const link = document.createElement('a');
            link.className = 'jc-maintainerr-item-status-link';
            link.href = reference.href;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = reference.label;
            row.appendChild(link);
        } else {
            const name = document.createElement('span');
            name.className = 'jc-maintainerr-item-status-name';
            name.textContent = reference.label;
            row.appendChild(name);
        }
    }
    root.appendChild(row);
}

function ensureStatusSlot(
    context: DetailsIntegrationContext,
): HTMLElement {
    let slot = Array.from(context.metadataContainer.querySelectorAll<HTMLElement>(
        '.jc-maintainerr-item-status-slot',
    )).find((candidate) => candidate.dataset.itemId === context.itemId);
    if (!slot) {
        slot = document.createElement('span');
        slot.className = 'jc-maintainerr-item-status-slot';
        slot.dataset.itemId = context.itemId;
        context.metadataContainer.appendChild(slot);
    }
    return slot;
}

function addReferenceDetails(
    slot: HTMLElement,
    context: DetailsIntegrationContext,
    status: MaintainerrAdminItemStatus,
): void {
    if (status.excludedFrom.length === 0 && status.manuallyAddedTo.length === 0) return;
    const details = document.createElement('details');
    details.className = 'jc-maintainerr-item-status-details';
    details.dataset.itemId = context.itemId;
    const summary = document.createElement('summary');
    summary.textContent = text('maintainerr_item_status_details', 'Maintainerr details');
    details.appendChild(summary);
    const body = document.createElement('div');
    body.className = 'jc-maintainerr-item-status-details-body';
    addReferenceRow(
        body,
        text('maintainerr_excluded_from', 'Excluded from'),
        status.excludedFrom,
    );
    addReferenceRow(
        body,
        text('maintainerr_manually_added_to', 'Manually added to'),
        status.manuallyAddedTo,
    );
    details.appendChild(body);
    details.addEventListener('toggle', () => {
        slot.classList.toggle('jc-expanded', details.open);
    });
    slot.appendChild(details);
}

function renderStatus(
    context: DetailsIntegrationContext,
    phase: Phase,
    status: MaintainerrItemStatus | null,
    error: string,
    administrator: boolean,
): void {
    if (!context.isCurrent()) return;
    context.page.querySelectorAll<HTMLElement>('.jc-maintainerr-item-status-slot').forEach((node) => {
        if (node.dataset.itemId !== context.itemId || !context.metadataContainer.contains(node)) {
            node.remove();
        }
    });
    context.page.querySelectorAll<HTMLElement>(
        '.jc-maintainerr-item-status, .jc-maintainerr-item-status-details',
    ).forEach((node) => {
        if (!node.closest('.jc-maintainerr-item-status-slot')) node.remove();
    });
    if (phase === 'idle') {
        removeStatusNodes(context.page);
        return;
    }
    const slot = ensureStatusSlot(context);
    slot.replaceChildren();
    slot.className = 'jc-maintainerr-item-status-slot';
    slot.setAttribute('aria-busy', phase === 'loading' ? 'true' : 'false');
    slot.setAttribute('aria-hidden', 'true');
    if (phase === 'loading') {
        slot.classList.add('jc-loading');
        return;
    }
    if (phase === 'error') {
        addChip(
            slot,
            context,
            'jc-error',
            'warning',
            error || text('maintainerr_item_status_unavailable', 'Maintainerr status unavailable'),
        );
        slot.setAttribute('aria-hidden', 'false');
        return;
    }
    if (!status) {
        slot.classList.add('jc-empty');
        return;
    }
    if (status.protectedFromCleanup) {
        addChip(
            slot,
            context,
            'jc-protected',
            'shield',
            text('maintainerr_protected_from_cleanup', 'Protected from cleanup'),
        );
    }
    if (status.manuallyManaged) {
        addChip(
            slot,
            context,
            'jc-manual',
            'playlist_add_check',
            text('maintainerr_manually_managed', 'Manually managed'),
        );
    }
    if (administrator && 'excludedFrom' in status) {
        addReferenceDetails(slot, context, status);
    }
    if (slot.childElementCount === 0) {
        slot.classList.add('jc-empty');
        return;
    }
    slot.setAttribute('aria-hidden', 'false');
}

/** Construct one activation-owned integration; exported for lifecycle contract tests. */
export function createMaintainerrItemStatusIntegration(scope: FeatureScope): DetailsIntegration {
    const administrator = JC.currentUser?.Policy?.IsAdministrator === true;
    let phase: Phase = 'idle';
    let status: MaintainerrItemStatus | null = null;
    let error = '';
    let key = '';
    let generation = 0;
    let target: DetailsIntegrationContext | null = null;
    let requestController: AbortController | null = null;

    const stopRequest = (): void => {
        requestController?.abort();
        requestController = null;
    };

    const reset = (): void => {
        generation++;
        stopRequest();
        phase = 'idle';
        status = null;
        error = '';
        key = '';
        target = null;
        removeStatusNodes();
    };

    const load = async (
        context: DetailsIntegrationContext,
        requestKey: string,
        requestGeneration: number,
        controller: AbortController,
    ): Promise<void> => {
        try {
            const payload = await JC.core.api!.plugin(
                `/maintainerr/item-status/${encodeURIComponent(context.itemId)}`,
                {
                    signal: controller.signal,
                    skipCache: true,
                    skipRetry: true,
                    timeoutMs: 10_000,
                },
            );
            if (controller.signal.aborted
                || scope.signal.aborted
                || !scope.isCurrent()
                || requestGeneration !== generation
                || requestKey !== key) return;
            const parsed = parseMaintainerrItemStatus(payload, administrator);
            if (!parsed) throw new Error('Invalid Maintainerr item-status response');
            status = parsed;
            phase = 'success';
        } catch (reason) {
            if (controller.signal.aborted
                || scope.signal.aborted
                || !scope.isCurrent()
                || requestGeneration !== generation
                || requestKey !== key) return;
            status = null;
            phase = 'error';
            error = administrator
                ? describeMaintainerrRequestError(
                    reason,
                    text('maintainerr_item_status_unavailable', 'Maintainerr status unavailable'),
                    text,
                )
                : text('maintainerr_item_status_unavailable', 'Maintainerr status unavailable');
        } finally {
            if (requestController === controller) requestController = null;
        }
        if (target && target.itemId === context.itemId && target.isCurrent()) {
            renderStatus(target, phase, status, error, administrator);
        }
    };

    return {
        render(context): void {
            if (!SUPPORTED_TYPES.has(context.itemType)) {
                removeStatusNodes(context.page);
                return;
            }
            target = context;
            const nextKey = `${context.identity.epoch}:${context.itemId}:${administrator ? 'admin' : 'user'}`;
            if (nextKey !== key) {
                generation++;
                stopRequest();
                key = nextKey;
                phase = 'loading';
                status = null;
                error = '';
                renderStatus(context, phase, status, error, administrator);
                const controller = new AbortController();
                requestController = controller;
                void load(context, nextKey, generation, controller);
                return;
            }
            renderStatus(context, phase, status, error, administrator);
        },
        reset,
    };
}

/** Activate without installing any observer: the shared details owner invokes us. */
export function activateMaintainerrItemStatus(scope: FeatureScope): void {
    if (!scope.isCurrent()) return;
    injectMaintainerrItemStatusStyles();
    const integration = createMaintainerrItemStatusIntegration(scope);
    const unregister = registerDetailsIntegration('maintainerr-item-status', integration);
    let disposed = false;
    scope.track(() => {
        if (disposed) return;
        disposed = true;
        unregister();
        removeMaintainerrItemStatusStyles();
    });
}
