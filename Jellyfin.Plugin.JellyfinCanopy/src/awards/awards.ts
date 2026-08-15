import type { FeatureScope } from '../core/feature-loader';
import type { HttpError } from '../types/jc';
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

function removeAwardsNodes(page: ParentNode = document): void {
    page.querySelectorAll('.jc-awards-section').forEach((node) => node.remove());
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

function renderAwards(context: DetailsIntegrationContext, response: AwardsDisplayResponse | null): void {
    if (!context.isCurrent()) return;
    removeAwardsNodes(context.page);
    if (!response || (response.wins.length === 0 && response.nominations.length === 0)) return;

    const section = document.createElement('section');
    section.className = 'jc-awards-section';
    section.dataset.itemId = context.itemId;
    section.setAttribute('aria-labelledby', `jc-awards-heading-${context.itemId}`);
    const heading = document.createElement('h2');
    heading.id = `jc-awards-heading-${context.itemId}`;
    heading.className = 'jc-awards-title';
    heading.textContent = translated('awards_title', 'Awards and nominations');
    section.appendChild(heading);
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

    const host = context.page.querySelector('.detailPageSecondaryContainer') ?? context.page;
    const anchor = host.querySelector('#castCollapsible, #similarCollapsible');
    if (anchor) anchor.before(section);
    else host.appendChild(section);
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
            if (target?.isCurrent()) renderAwards(target, response);
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
            removeAwardsNodes(target?.page ?? document);
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
        removeAwardsNodes();
    };

    return {
        render(context): void {
            if (!SUPPORTED_TYPES.has(context.itemType)) {
                reset();
                removeAwardsNodes(context.page);
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
                removeAwardsNodes(context.page);
                void load(nextKey, generation, 0);
                return;
            }
            if (settled) renderAwards(context, response);
        },
        reset,
    };
}

function injectStyles(): void {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
        .jc-awards-section { margin: 1.5rem 0; }
        .jc-awards-title { font-size: 1.45rem; margin: 0 0 .75rem; }
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
