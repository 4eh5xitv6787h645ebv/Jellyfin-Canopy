import type { FeatureScope } from '../core/feature-loader';
import {
    registerDetailsIntegration,
    type DetailsIntegration,
    type DetailsIntegrationContext,
} from '../enhanced/features/details-page';
import { JC } from '../globals';
import {
    injectQbittorrentTelemetryStyles,
    removeQbittorrentTelemetryStyles,
} from './item-telemetry-styles';

const SUPPORTED_TYPES = new Set(['Movie', 'Episode']);
const STATES = new Set([
    'unknown', 'downloading', 'seeding', 'stalled', 'queued', 'paused', 'checking', 'error',
]);
const MAX_TRACKER_LENGTH = 128;
const MAX_BACKOFF_MULTIPLIER = 8;

export interface QbittorrentTelemetry {
    state: string;
    progressPercent: number | null;
    ratio: number | null;
    trackerIdentity: string | null;
    addedAt: string | null;
    completedAt: string | null;
    lastActivityAt: string | null;
}

type Phase = 'idle' | 'loading' | 'success' | 'empty' | 'error';

function objectValue(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function nullableNumber(value: unknown, minimum: number, maximum: number): number | null | undefined {
    if (value === null) return null;
    return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
        ? value
        : undefined;
}

function nullableTimestamp(value: unknown): string | null | undefined {
    if (value === null) return null;
    if (typeof value !== 'string' || value.length > 64) return undefined;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? value : undefined;
}

/** Parse the exact redacted server projection; an empty object means no match. */
export function parseQbittorrentTelemetry(value: unknown): QbittorrentTelemetry | null | undefined {
    const object = objectValue(value);
    if (!object) return undefined;
    if (Object.keys(object).length === 0) return null;
    const keys = Object.keys(object).sort();
    const expected = [
        'addedAt', 'completedAt', 'lastActivityAt', 'progressPercent', 'ratio',
        'state', 'trackerIdentity',
    ];
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
        return undefined;
    }
    if (typeof object.state !== 'string' || !STATES.has(object.state)) return undefined;
    const progressPercent = nullableNumber(object.progressPercent, 0, 100);
    const ratio = nullableNumber(object.ratio, 0, 9_999);
    const addedAt = nullableTimestamp(object.addedAt);
    const completedAt = nullableTimestamp(object.completedAt);
    const lastActivityAt = nullableTimestamp(object.lastActivityAt);
    if (progressPercent === undefined || ratio === undefined
        || addedAt === undefined || completedAt === undefined || lastActivityAt === undefined) {
        return undefined;
    }
    const trackerIdentity = object.trackerIdentity;
    if (trackerIdentity !== null
        && (typeof trackerIdentity !== 'string'
            || trackerIdentity.length === 0
            || trackerIdentity.length > MAX_TRACKER_LENGTH
            || /[\u0000-\u001f\u007f/?#@:=]/.test(trackerIdentity))) return undefined;
    return {
        state: object.state,
        progressPercent,
        ratio,
        trackerIdentity,
        addedAt,
        completedAt,
        lastActivityAt,
    };
}

function text(key: string, fallback: string): string {
    const translated = JC.t?.(key);
    return translated && translated !== key ? translated : fallback;
}

function removeNodes(page: ParentNode = document): void {
    page.querySelectorAll('.jc-qbittorrent-telemetry-slot').forEach((node) => node.remove());
}

function ensureSlot(context: DetailsIntegrationContext): HTMLElement {
    let slot = Array.from(context.metadataContainer.querySelectorAll<HTMLElement>(
        '.jc-qbittorrent-telemetry-slot',
    )).find((candidate) => candidate.dataset.itemId === context.itemId);
    if (!slot) {
        slot = document.createElement('span');
        slot.className = 'jc-qbittorrent-telemetry-slot';
        slot.dataset.itemId = context.itemId;
        context.metadataContainer.appendChild(slot);
    }
    return slot;
}

function stateLabel(state: string): string {
    const labels: Record<string, [string, string]> = {
        downloading: ['qbittorrent_state_downloading', 'Downloading'],
        seeding: ['qbittorrent_state_seeding', 'Seeding'],
        stalled: ['qbittorrent_state_stalled', 'Stalled'],
        queued: ['qbittorrent_state_queued', 'Queued'],
        paused: ['qbittorrent_state_paused', 'Paused'],
        checking: ['qbittorrent_state_checking', 'Checking'],
        error: ['qbittorrent_state_error', 'Transfer error'],
        unknown: ['qbittorrent_state_unknown', 'Torrent active'],
    };
    const [key, fallback] = labels[state] ?? labels.unknown;
    return text(key, fallback);
}

function appendText(parent: Element, className: string, value: string): void {
    const span = document.createElement('span');
    span.className = className;
    span.textContent = value;
    parent.appendChild(span);
}

function render(
    context: DetailsIntegrationContext,
    phase: Phase,
    telemetry: QbittorrentTelemetry | null,
): void {
    if (!context.isCurrent()) return;
    context.page.querySelectorAll<HTMLElement>('.jc-qbittorrent-telemetry-slot').forEach((node) => {
        if (node.dataset.itemId !== context.itemId || !context.metadataContainer.contains(node)) node.remove();
    });
    if (phase === 'idle') {
        removeNodes(context.page);
        return;
    }
    const slot = ensureSlot(context);
    slot.replaceChildren();
    slot.className = 'jc-qbittorrent-telemetry-slot';
    slot.setAttribute('role', 'status');
    slot.setAttribute('aria-live', 'polite');
    slot.setAttribute('aria-busy', phase === 'loading' ? 'true' : 'false');
    if (phase === 'loading' || phase === 'empty') {
        slot.classList.add(phase === 'loading' ? 'jc-loading' : 'jc-empty');
        return;
    }
    const chip = document.createElement('span');
    chip.className = `mediaInfoItem jc-qbittorrent-telemetry${phase === 'error' ? ' jc-qbittorrent-telemetry-error' : ''}`;
    const icon = document.createElement('span');
    icon.className = 'material-icons';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = phase === 'error' ? 'sync_problem' : 'downloading';
    chip.appendChild(icon);
    if (phase === 'error' || !telemetry) {
        appendText(chip, '', text('qbittorrent_unavailable', 'Torrent telemetry unavailable'));
        slot.appendChild(chip);
        return;
    }
    appendText(chip, '', stateLabel(telemetry.state));
    const details = document.createElement('span');
    details.className = 'jc-qbittorrent-telemetry-details';
    if (telemetry.progressPercent !== null) {
        appendText(details, 'jc-qbittorrent-telemetry-detail', `${telemetry.progressPercent.toFixed(1)}%`);
    }
    if (telemetry.ratio !== null) {
        appendText(details, 'jc-qbittorrent-telemetry-detail', `↑ ${telemetry.ratio.toFixed(2)}`);
    }
    if (telemetry.trackerIdentity) {
        appendText(details, 'jc-qbittorrent-telemetry-detail', telemetry.trackerIdentity);
    }
    chip.appendChild(details);
    slot.appendChild(chip);
}

function pollIntervalMs(): number {
    const raw = Number(JC.pluginConfig?.QbittorrentPollIntervalSeconds ?? 30);
    return Math.max(30, Math.min(300, Number.isFinite(raw) ? raw : 30)) * 1000;
}

/** Construct one navigation-owned integration; exported for lifecycle tests. */
export function createQbittorrentTelemetryIntegration(scope: FeatureScope): DetailsIntegration {
    let phase: Phase = 'idle';
    let telemetry: QbittorrentTelemetry | null = null;
    let key = '';
    let generation = 0;
    let failures = 0;
    let target: DetailsIntegrationContext | null = null;
    let requestController: AbortController | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const stopTimer = (): void => {
        if (pollTimer) clearTimeout(pollTimer);
        pollTimer = null;
    };
    const stopRequest = (): void => {
        requestController?.abort();
        requestController = null;
    };
    const reset = (): void => {
        generation++;
        stopTimer();
        stopRequest();
        phase = 'idle';
        telemetry = null;
        key = '';
        failures = 0;
        target = null;
        removeNodes();
    };

    const schedule = (context: DetailsIntegrationContext, requestKey: string, requestGeneration: number): void => {
        stopTimer();
        const multiplier = Math.min(MAX_BACKOFF_MULTIPLIER, Math.pow(2, failures));
        pollTimer = setTimeout(() => {
            pollTimer = null;
            if (scope.signal.aborted || !scope.isCurrent()
                || requestGeneration !== generation || requestKey !== key
                || !context.isCurrent()) return;
            if (document.visibilityState === 'hidden') {
                schedule(context, requestKey, requestGeneration);
                return;
            }
            void load(context, requestKey, requestGeneration);
        }, pollIntervalMs() * multiplier);
    };

    const load = async (
        context: DetailsIntegrationContext,
        requestKey: string,
        requestGeneration: number,
    ): Promise<void> => {
        stopRequest();
        const controller = new AbortController();
        requestController = controller;
        try {
            const payload = await JC.core.api!.plugin(
                `/qbittorrent/telemetry/${encodeURIComponent(context.itemId)}`,
                { signal: controller.signal, skipCache: true, skipRetry: true, timeoutMs: 10_000 },
            );
            if (controller.signal.aborted || scope.signal.aborted || !scope.isCurrent()
                || requestGeneration !== generation || requestKey !== key) return;
            const parsed = parseQbittorrentTelemetry(payload);
            if (parsed === undefined) throw new Error('Invalid qBittorrent telemetry response');
            telemetry = parsed;
            phase = parsed ? 'success' : 'empty';
            failures = 0;
        } catch {
            if (controller.signal.aborted || scope.signal.aborted || !scope.isCurrent()
                || requestGeneration !== generation || requestKey !== key) return;
            telemetry = null;
            phase = 'error';
            failures = Math.min(failures + 1, 3);
        } finally {
            if (requestController === controller) requestController = null;
        }
        if (target?.itemId === context.itemId && target.isCurrent()) {
            render(target, phase, telemetry);
            schedule(target, requestKey, requestGeneration);
        }
    };

    return {
        render(context): void {
            if (!SUPPORTED_TYPES.has(context.itemType)) {
                reset();
                return;
            }
            target = context;
            const nextKey = `${context.identity.serverId}:${context.identity.userId}:${context.identity.epoch}:${context.itemId}`;
            if (nextKey !== key) {
                generation++;
                stopTimer();
                stopRequest();
                key = nextKey;
                failures = 0;
                phase = 'loading';
                telemetry = null;
                render(context, phase, telemetry);
                void load(context, nextKey, generation);
                return;
            }
            render(context, phase, telemetry);
        },
        reset,
    };
}

export function activateQbittorrentTelemetry(scope: FeatureScope): void {
    if (!scope.isCurrent()) return;
    injectQbittorrentTelemetryStyles();
    const integration = createQbittorrentTelemetryIntegration(scope);
    const unregister = registerDetailsIntegration('qbittorrent-item-telemetry', integration);
    let disposed = false;
    scope.track(() => {
        if (disposed) return;
        disposed = true;
        unregister();
        removeQbittorrentTelemetryStyles();
    });
}
