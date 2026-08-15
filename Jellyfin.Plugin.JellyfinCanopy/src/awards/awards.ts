import type { FeatureScope } from '../core/feature-loader';
import type { HttpError } from '../types/jc';
import { installModalA11y, type ModalA11yHandle } from '../core/modal-a11y';
import {
    registerDetailsIntegration,
    type DetailsIntegration,
    type DetailsIntegrationContext,
} from '../enhanced/features/details-page';
import { JC } from '../globals';

const SUPPORTED_TYPES = new Set(['Movie', 'Series']);
const MAX_FACTS_PER_GROUP = 250;
const MAX_NAME_LENGTH = 200;
const RETRY_DELAYS_MS = [750, 1500] as const;
const STYLE_ID = 'jc-awards-styles';

class InvalidAwardsResponseError extends Error {
    constructor() {
        super('Invalid awards response');
        this.name = 'InvalidAwardsResponseError';
    }
}

export interface AwardDisplayFact {
    name: string;
    year: number | null;
}

export interface AwardsDisplayResponse {
    wins: AwardDisplayFact[];
    nominations: AwardDisplayFact[];
}

function objectValue(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function parseFacts(value: unknown): AwardDisplayFact[] | null {
    if (!Array.isArray(value) || value.length > MAX_FACTS_PER_GROUP) return null;
    const facts: AwardDisplayFact[] = [];
    for (const raw of value) {
        const object = objectValue(raw);
        if (!object || Object.keys(object).sort().join(',') !== 'name,year'
            || typeof object.name !== 'string'
            || object.name.length > MAX_NAME_LENGTH
            || /[\u0000-\u001f\u007f]/.test(object.name)) return null;
        const name = object.name.trim();
        const year = object.year;
        if (!name || (year !== null && (!Number.isInteger(year) || (year as number) < 1800 || (year as number) > 3000))) {
            return null;
        }
        facts.push({ name, year: year as number | null });
    }
    return facts;
}

export function parseAwardsResponse(value: unknown): AwardsDisplayResponse | null {
    const object = objectValue(value);
    if (!object || Object.keys(object).sort().join(',') !== 'nominations,wins') return null;
    const wins = parseFacts(object.wins);
    const nominations = parseFacts(object.nominations);
    return wins && nominations ? { wins, nominations } : null;
}

function translated(key: string, fallback: string): string {
    const value = JC.t?.(key);
    return value && value !== key ? value : fallback;
}

function removeAwardsTriggers(page: ParentNode = document): void {
    page.querySelectorAll('.jc-awards-trigger').forEach((node) => node.remove());
}

function appendGroup(
    section: HTMLElement,
    headingText: string,
    facts: readonly AwardDisplayFact[],
): void {
    if (facts.length === 0) return;
    const group = document.createElement('div');
    group.className = 'jc-awards-group';
    const heading = document.createElement('h3');
    heading.className = 'jc-awards-group-title';
    heading.textContent = headingText;
    group.appendChild(heading);
    const list = document.createElement('ul');
    list.className = 'jc-awards-list';
    for (const fact of facts) {
        const row = document.createElement('li');
        const name = document.createElement('span');
        name.className = 'jc-awards-name';
        name.textContent = fact.name;
        row.appendChild(name);
        if (fact.year !== null) {
            const year = document.createElement('span');
            year.className = 'jc-awards-year';
            year.textContent = String(fact.year);
            row.appendChild(year);
        }
        list.appendChild(row);
    }
    group.appendChild(list);
    section.appendChild(group);
}

function buildAwardsDialog(
    context: DetailsIntegrationContext,
    response: AwardsDisplayResponse,
    onClose: () => void,
): { overlay: HTMLElement; close: HTMLButtonElement } {
    const overlay = document.createElement('div');
    overlay.className = 'jc-awards-overlay';
    overlay.dataset.itemId = context.itemId;
    const dialog = document.createElement('div');
    dialog.className = 'jc-awards-dialog';
    const headingId = `jc-awards-heading-${context.itemId}`;
    const section = JC.core.ui!.sectionContainer({
        title: translated('awards_title', 'Awards and nominations'),
        className: 'jc-awards-section',
    });
    const heading = section.querySelector<HTMLElement>('.sectionTitle');
    if (!heading) throw new Error('Awards section heading was not created');
    heading.id = headingId;
    section.dataset.itemId = context.itemId;
    const groups = document.createElement('div');
    groups.className = 'jc-awards-groups';
    appendGroup(groups, translated('awards_wins', 'Wins'), response.wins);
    appendGroup(groups, translated('awards_nominations', 'Nominations'), response.nominations);
    section.appendChild(groups);
    const source = document.createElement('a');
    source.className = 'jc-awards-source';
    source.href = 'https://www.wikidata.org/';
    source.target = '_blank';
    source.rel = 'noopener noreferrer';
    source.textContent = translated('awards_source', 'Data from Wikidata');
    section.appendChild(source);
    const close = JC.core.ui!.muiIconButton({
        icon: 'close',
        title: translated('button_close', 'Close'),
        className: 'jc-awards-close',
        onClick: onClose,
    });
    dialog.append(close, section);
    overlay.appendChild(dialog);
    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) onClose();
    });
    overlay.setAttribute('aria-labelledby', headingId);
    return { overlay, close };
}

function transientFailure(reason: unknown): boolean {
    const error = reason as HttpError;
    return error?.name !== 'AbortError'
        && error?.name !== 'InvalidAwardsResponseError'
        && (error?.status === undefined || [408, 429, 500, 502, 503, 504].includes(error.status));
}

export function createAwardsIntegration(scope: FeatureScope): DetailsIntegration {
    let key = '';
    let generation = 0;
    let response: AwardsDisplayResponse | null = null;
    let settled = false;
    let target: DetailsIntegrationContext | null = null;
    let requestController: AbortController | null = null;
    let retryTimer: number | null = null;
    let dialog: HTMLElement | null = null;
    let dialogA11y: ModalA11yHandle | null = null;

    const closeDialog = (restoreFocus = true): void => {
        dialogA11y?.release(restoreFocus);
        dialogA11y = null;
        dialog?.remove();
        dialog = null;
    };
    const openDialog = (context: DetailsIntegrationContext, value: AwardsDisplayResponse): void => {
        if (!context.isCurrent() || !scope.isCurrent()) return;
        closeDialog(false);
        const built = buildAwardsDialog(context, value, () => closeDialog());
        dialog = built.overlay;
        // Build the variable-height content while detached, then append it as a
        // fixed overlay. It never participates in the detail page's flow.
        document.body.appendChild(built.overlay);
        dialogA11y = installModalA11y(built.overlay, {
            labelledBy: `jc-awards-heading-${context.itemId}`,
            initialFocus: built.close,
            onEscape: () => closeDialog(),
        });
    };
    const renderTrigger = (context: DetailsIntegrationContext, value: AwardsDisplayResponse | null): void => {
        if (!context.isCurrent()) return;
        removeAwardsTriggers(context.page);
        if (!value || (value.wins.length === 0 && value.nominations.length === 0)) return;
        const host = context.page.querySelector<HTMLElement>(
            '.detailButtons, .itemActionsBottom, .mainDetailButtons, .detailButtonsContainer',
        );
        if (!host) return;
        const triggerKey = key;
        const triggerGeneration = generation;
        const trigger = JC.core.ui!.muiIconButton({
            icon: 'emoji_events',
            title: translated('awards_title', 'Awards and nominations'),
            className: 'detailButton jc-awards-trigger',
            onClick: () => {
                if (isOwned(triggerKey, triggerGeneration) && context.isCurrent()) openDialog(context, value);
            },
        });
        trigger.dataset.itemId = context.itemId;
        host.appendChild(trigger);
        // PERF(R1): this late fixed-size native action reserves its exact width
        // before paint, then uses the shared shift-free tray entrance.
        JC.core.ui!.expandIn(trigger);
    };

    const stop = (): void => {
        requestController?.abort();
        requestController = null;
        if (retryTimer !== null) window.clearTimeout(retryTimer);
        retryTimer = null;
    };
    const isOwned = (requestKey: string, requestGeneration: number): boolean =>
        !scope.signal.aborted && scope.isCurrent()
        && key === requestKey && generation === requestGeneration;

    const load = async (requestKey: string, requestGeneration: number, attempt: number): Promise<void> => {
        const controller = new AbortController();
        requestController = controller;
        try {
            const payload = await JC.core.api!.plugin(
                `/awards/${encodeURIComponent(target?.itemId ?? '')}`,
                {
                    signal: controller.signal,
                    skipCache: true,
                    skipRetry: true,
                    timeoutMs: 8_000,
                },
            );
            if (!isOwned(requestKey, requestGeneration) || controller.signal.aborted) return;
            const parsed = parseAwardsResponse(payload);
            if (!parsed) throw new InvalidAwardsResponseError();
            response = parsed;
            settled = true;
            if (target?.isCurrent()) renderTrigger(target, response);
        } catch (reason) {
            if (!isOwned(requestKey, requestGeneration) || controller.signal.aborted) return;
            if (attempt < RETRY_DELAYS_MS.length && transientFailure(reason)) {
                retryTimer = window.setTimeout(() => {
                    retryTimer = null;
                    if (isOwned(requestKey, requestGeneration)) {
                        void load(requestKey, requestGeneration, attempt + 1);
                    }
                }, RETRY_DELAYS_MS[attempt]);
                return;
            }
            settled = true;
            response = null;
            removeAwardsTriggers(target?.page ?? document);
            closeDialog(false);
            console.warn('🪼 Jellyfin Canopy: awards unavailable');
        } finally {
            if (requestController === controller) requestController = null;
        }
    };

    const reset = (): void => {
        generation++;
        stop();
        key = '';
        response = null;
        settled = false;
        target = null;
        removeAwardsTriggers();
        closeDialog(false);
    };

    return {
        render(context): void {
            if (!SUPPORTED_TYPES.has(context.itemType)) {
                reset();
                removeAwardsTriggers(context.page);
                return;
            }
            target = context;
            const nextKey = `${context.identity.serverId}:${context.identity.userId}:${context.identity.epoch}:${context.itemId}:${context.itemType}`;
            if (nextKey !== key) {
                generation++;
                stop();
                key = nextKey;
                response = null;
                settled = false;
                // Identity and route changes can replace the details owner before
                // the old page is detached. Remove every prior awards surface so
                // account-scoped text cannot survive a no-reload transition.
                removeAwardsTriggers();
                closeDialog(false);
                void load(nextKey, generation, 0);
                return;
            }
            if (settled) renderTrigger(context, response);
        },
        reset,
    };
}

function injectStyles(): void {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
        .jc-awards-trigger { box-sizing: border-box; flex: 0 0 3.25rem; width: 3.25rem; height: 3.25rem; min-width: 3.25rem; }
        .jc-awards-overlay { position: fixed; inset: 0; z-index: 1300; display: grid; place-items: center; padding: 1rem; background: rgba(0,0,0,.72); }
        .jc-awards-dialog { position: relative; box-sizing: border-box; width: min(46rem, 100%); max-height: min(44rem, calc(100vh - 2rem)); overflow: auto; padding: 1.25rem; border-radius: .5rem; background: var(--jf-palette-background-paper, #181818); color: var(--jf-palette-text-primary, inherit); box-shadow: 0 1rem 3rem rgba(0,0,0,.45); }
        .jc-awards-close { position: absolute; top: .4rem; right: .4rem; z-index: 1; }
        .jc-awards-section { margin: 0; padding-top: .25rem; }
        .jc-awards-section > .sectionTitle { padding-right: 3.5rem; }
        .jc-awards-groups { display: grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); gap: 1rem; }
        .jc-awards-group { background: rgba(255,255,255,.06); border-radius: .5rem; padding: .85rem 1rem; }
        .jc-awards-group-title { font-size: 1.05rem; margin: 0 0 .5rem; }
        .jc-awards-list { list-style: none; margin: 0; padding: 0; }
        .jc-awards-list li { display: flex; justify-content: space-between; gap: 1rem; padding: .25rem 0; }
        .jc-awards-year { opacity: .75; white-space: nowrap; }
        .jc-awards-source { display: inline-block; font-size: .85rem; margin-top: .65rem; }
    `;
    document.head.appendChild(style);
}

export function activateAwards(scope: FeatureScope): void {
    if (!scope.isCurrent()) return;
    injectStyles();
    const integration = createAwardsIntegration(scope);
    const unregister = registerDetailsIntegration('awards', integration);
    scope.track(() => {
        unregister();
        integration.reset();
        document.getElementById(STYLE_ID)?.remove();
    });
}
