import { formatDate, formatTime, getDisplayLocale } from '../core/locale';
import { JC } from '../globals';
import type { PageContext, PageDescriptor } from '../enhanced/pages/types';
import type { IdentityContext, LifecycleHandle } from '../types/jc';
import { describeMaintainerrRequestError } from './request-error';
import {
    parseMaintainerrCollectionContent,
    parseMaintainerrDashboard,
    type MaintainerrCollectionContent,
    type MaintainerrCollectionSummary,
    type MaintainerrCollectionStorageSummary,
    type MaintainerrCleanupTotals,
    type MaintainerrDashboard,
    type MaintainerrMediaType,
} from './types';
import { injectMaintainerrPageStyles, removeMaintainerrPageStyles } from './styles';

const CONTENT_PAGE_SIZE = 25;
const MAX_SEARCH_LENGTH = 100;

type CollectionFilter = 'all' | 'active' | 'inactive' | 'manual';
type CollectionSort = 'title' | 'mediaCount' | 'handled';
type MaintainerrView = 'collections' | 'rules';

interface CollectionView {
    summary: MaintainerrCollectionSummary;
    page: number;
    loading: boolean;
    error: string | null;
    content: MaintainerrCollectionContent | null;
    generation: number;
}

interface ActivePage {
    context: IdentityContext;
    container: HTMLElement;
    handle: LifecycleHandle;
    signal: AbortSignal;
    dashboard: MaintainerrDashboard | null;
    loading: boolean;
    error: string | null;
    loadPromise: Promise<void> | null;
    collection: CollectionView | null;
    contentController: AbortController | null;
    search: string;
    filter: CollectionFilter;
    sort: CollectionSort;
    view: MaintainerrView;
    returnCollectionId: number | null;
}

let activePage: ActivePage | null = null;

function text(key: string, fallback: string, params?: Record<string, unknown>): string {
    const translated = JC.t?.(key, params);
    return translated && translated !== key ? translated : fallback;
}

function isCurrent(owner: ActivePage): boolean {
    return activePage === owner
        && !owner.signal.aborted
        && owner.container.isConnected
        && JC.identity.isCurrent(owner.context);
}

function appendIcon(parent: Element, name: string): void {
    const icon = document.createElement('span');
    icon.className = 'material-icons';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = name;
    parent.appendChild(icon);
}

function button(label: string, action: string, iconName?: string): HTMLButtonElement {
    const result = document.createElement('button');
    result.type = 'button';
    result.className = 'jc-maintainerr-button';
    result.dataset.action = action;
    if (iconName) appendIcon(result, iconName);
    result.appendChild(document.createTextNode(label));
    return result;
}

function link(label: string, href: string | undefined, iconName?: string): HTMLAnchorElement | null {
    if (!href) return null;
    const result = document.createElement('a');
    result.className = 'jc-maintainerr-link';
    result.href = href;
    result.target = '_blank';
    result.rel = 'noopener noreferrer';
    if (iconName) appendIcon(result, iconName);
    result.appendChild(document.createTextNode(label));
    return result;
}

function number(value: number): string {
    return new Intl.NumberFormat(getDisplayLocale()).format(value);
}

function bytes(value: number | undefined): string | null {
    if (value === undefined) return null;
    if (value < 1024) return `${number(value)} B`;
    const units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
    let amount = value;
    let unit = -1;
    do {
        amount /= 1024;
        unit++;
    } while (amount >= 1024 && unit < units.length - 1);
    return `${new Intl.NumberFormat(getDisplayLocale(), { maximumFractionDigits: 1 }).format(amount)} ${units[unit]}`;
}

function duration(seconds: number | undefined): string | null {
    if (seconds === undefined) return null;
    if (seconds < 60) return text('maintainerr_seconds_short', `${number(Math.round(seconds))} s`, {
        count: Math.round(seconds),
    });
    const minutes = Math.round(seconds / 60);
    return text('maintainerr_minutes_short', `${number(minutes)} min`, { count: minutes });
}

function generatedAt(value: string | undefined): string | null {
    if (!value) return null;
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    return `${formatDate(date, { year: 'numeric', month: 'short', day: 'numeric' })} `
        + `${formatTime(date, { hour: 'numeric', minute: '2-digit' })}`;
}

function mediaTypeLabel(type: MaintainerrMediaType): string {
    switch (type) {
        case 'movie':
            return text('maintainerr_media_type_movie', 'Movie');
        case 'show':
            return text('maintainerr_media_type_show', 'TV series');
        case 'season':
            return text('maintainerr_media_type_season', 'Season');
        case 'episode':
            return text('maintainerr_media_type_episode', 'Episode');
    }
}

function metric(label: string, value: string, detail?: string): HTMLElement {
    const card = document.createElement('div');
    card.className = 'jc-maintainerr-metric';
    const labelNode = document.createElement('div');
    labelNode.className = 'jc-maintainerr-metric-label';
    labelNode.textContent = label;
    const valueNode = document.createElement('div');
    valueNode.className = 'jc-maintainerr-metric-value';
    valueNode.textContent = value;
    card.append(labelNode, valueNode);
    if (detail) {
        const detailNode = document.createElement('div');
        detailNode.className = 'jc-maintainerr-status-detail';
        detailNode.textContent = detail;
        card.appendChild(detailNode);
    }
    return card;
}

interface StorageMetric {
    key: string;
    labelKey: string;
    label: string;
    bytes?: boolean;
}

const COLLECTION_STORAGE_METRICS: readonly StorageMetric[] = [
    { key: 'reclaimableCount', labelKey: 'maintainerr_storage_reclaimable_count', label: 'Reclaimable collections' },
    { key: 'activeSizeBytes', labelKey: 'maintainerr_storage_active_size', label: 'Reclaimable storage', bytes: true },
    { key: 'reclaimableSizedCount', labelKey: 'maintainerr_storage_reclaimable_sized_count', label: 'Reclaimable collections with size data' },
    { key: 'inactiveCount', labelKey: 'maintainerr_storage_inactive_count', label: 'Inactive collections' },
    { key: 'totalCollectionCount', labelKey: 'maintainerr_storage_collection_count', label: 'Total collections' },
    { key: 'movieSizeBytes', labelKey: 'maintainerr_storage_movie_size', label: 'Reclaimable movie storage', bytes: true },
    { key: 'showSizeBytes', labelKey: 'maintainerr_storage_show_size', label: 'Reclaimable show storage', bytes: true },
    { key: 'seasonSizeBytes', labelKey: 'maintainerr_storage_season_size', label: 'Reclaimable season storage', bytes: true },
    { key: 'episodeSizeBytes', labelKey: 'maintainerr_storage_episode_size', label: 'Reclaimable episode storage', bytes: true },
    { key: 'reclaimableMovieCount', labelKey: 'maintainerr_storage_reclaimable_movies', label: 'Reclaimable movie collections' },
    { key: 'reclaimableShowCount', labelKey: 'maintainerr_storage_reclaimable_shows', label: 'Reclaimable show collections' },
    { key: 'reclaimableSeasonCount', labelKey: 'maintainerr_storage_reclaimable_seasons', label: 'Reclaimable season collections' },
    { key: 'reclaimableEpisodeCount', labelKey: 'maintainerr_storage_reclaimable_episodes', label: 'Reclaimable episode collections' },
];

const CLEANUP_TOTAL_METRICS: readonly StorageMetric[] = [
    { key: 'itemsHandled', labelKey: 'maintainerr_cleanup_items', label: 'Items handled' },
    { key: 'moviesHandled', labelKey: 'maintainerr_cleanup_movies', label: 'Movies handled' },
    { key: 'showsHandled', labelKey: 'maintainerr_cleanup_shows', label: 'Shows handled' },
    { key: 'seasonsHandled', labelKey: 'maintainerr_cleanup_seasons', label: 'Seasons handled' },
    { key: 'episodesHandled', labelKey: 'maintainerr_cleanup_episodes', label: 'Episodes handled' },
    { key: 'bytesHandled', labelKey: 'maintainerr_cleanup_size', label: 'Storage reclaimed', bytes: true },
    { key: 'movieBytesHandled', labelKey: 'maintainerr_cleanup_movie_size', label: 'Movie storage reclaimed', bytes: true },
    { key: 'showBytesHandled', labelKey: 'maintainerr_cleanup_show_size', label: 'Show storage reclaimed', bytes: true },
    { key: 'seasonBytesHandled', labelKey: 'maintainerr_cleanup_season_size', label: 'Season storage reclaimed', bytes: true },
    { key: 'episodeBytesHandled', labelKey: 'maintainerr_cleanup_episode_size', label: 'Episode storage reclaimed', bytes: true },
];

function renderRecord(
    root: HTMLElement,
    values: MaintainerrCollectionStorageSummary | MaintainerrCleanupTotals | undefined,
    metrics: readonly StorageMetric[],
): boolean {
    if (!values) return false;
    const list = document.createElement('dl');
    list.className = 'jc-maintainerr-records';
    let rendered = false;
    for (const metricDefinition of metrics) {
        const value = (values as unknown as Record<string, number | undefined>)[metricDefinition.key];
        if (value === undefined) continue;
        rendered = true;
        const row = document.createElement('div');
        row.className = 'jc-maintainerr-record';
        const term = document.createElement('dt');
        term.textContent = text(metricDefinition.labelKey, metricDefinition.label);
        const description = document.createElement('dd');
        description.textContent = metricDefinition.bytes ? bytes(value) || number(value) : number(value);
        row.append(term, description);
        list.appendChild(row);
    }
    if (rendered) root.appendChild(list);
    return rendered;
}

function renderStatus(dashboard: MaintainerrDashboard): HTMLElement {
    const status = dashboard.status;
    const state = !status.ready
        ? 'error'
        : status.degraded || !status.capable || !status.jellyfinMode || !status.identityMatch
            ? 'warn'
            : 'ok';
    const root = document.createElement('section');
    root.className = `jc-maintainerr-status jc-state-${state}`;
    root.setAttribute('role', state === 'error' ? 'alert' : 'status');
    const line = document.createElement('div');
    line.className = 'jc-maintainerr-status-line';
    appendIcon(line, state === 'ok' ? 'check_circle' : state === 'warn' ? 'warning' : 'error');
    const title = document.createElement('div');
    title.className = 'jc-maintainerr-status-title';
    title.textContent = state === 'ok'
        ? text('maintainerr_connected', 'Connected and ready')
        : state === 'warn'
            ? text('maintainerr_degraded', 'Connected with warnings')
            : text('maintainerr_unavailable', 'Maintainerr is unavailable');
    line.appendChild(title);
    if (status.version) {
        const version = document.createElement('span');
        version.className = 'jc-maintainerr-chip';
        version.textContent = text('maintainerr_version', `Version ${status.version}`, {
            version: status.version,
        });
        line.appendChild(version);
    }
    root.appendChild(line);
    const identityWarning = status.identityWarning === 'identity_mismatch'
        ? text('maintainerr_identity_mismatch', 'The configured Jellyfin server identity does not match.')
        : status.identityWarning === 'identity_unknown'
            ? text('maintainerr_identity_unknown', 'Maintainerr could not confirm the configured Jellyfin server identity.')
            : status.identityWarning
                ? text('maintainerr_identity_warning', 'Maintainerr reported a Jellyfin identity warning.')
                : '';
    const error = status.error
        ? text('maintainerr_status_error', 'Maintainerr could not provide its current status.')
        : '';
    const detailText = identityWarning || error
        || (!status.identityMatch ? text('maintainerr_identity_mismatch', 'The configured Jellyfin server identity does not match.')
            : !status.jellyfinMode ? text('maintainerr_jellyfin_mode_required', 'Maintainerr is not configured for Jellyfin.')
                : !status.capable ? text('maintainerr_capability_missing', 'This Maintainerr version does not expose all required read-only data.')
                    : '');
    if (detailText) {
        const detail = document.createElement('div');
        detail.className = 'jc-maintainerr-status-detail';
        detail.textContent = detailText;
        root.appendChild(detail);
    }
    return root;
}

function renderNetworkWarning(): HTMLElement {
    const warning = document.createElement('aside');
    warning.className = 'jc-maintainerr-warning';
    warning.setAttribute('role', 'note');
    appendIcon(warning, 'security');
    const content = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = text('maintainerr_network_warning_title', 'Private-network access only');
    const detail = document.createElement('div');
    detail.textContent = text(
        'maintainerr_network_warning',
        'Maintainerr has no built-in authentication. Keep it on a trusted private network and do not expose its links to the public internet.',
    );
    content.append(title, detail);
    warning.appendChild(content);
    return warning;
}

function sectionStateText(state: 'partial' | 'unsupported' | 'unavailable'): string {
    if (state === 'partial') {
        return text('maintainerr_section_partial', 'Some data in this section is temporarily unavailable.');
    }
    if (state === 'unsupported') {
        return text('maintainerr_section_unsupported', 'This section is not supported by the connected Maintainerr version.');
    }
    return text('maintainerr_section_unavailable', 'This section is temporarily unavailable.');
}

function appendSectionNotice(
    section: HTMLElement,
    state: 'partial' | 'unsupported' | 'unavailable',
): void {
    const notice = document.createElement('div');
    notice.className = `jc-maintainerr-section-state jc-state-${state}`;
    notice.setAttribute('role', state === 'unavailable' ? 'alert' : 'status');
    notice.textContent = sectionStateText(state);
    section.appendChild(notice);
}

function renderRules(dashboard: MaintainerrDashboard): HTMLElement {
    const section = document.createElement('section');
    section.className = 'jc-maintainerr-section jc-maintainerr-metric';
    section.id = 'jc-maintainerr-rules-panel';
    section.setAttribute('role', 'tabpanel');
    section.setAttribute('aria-labelledby', 'jc-maintainerr-rules-tab');
    const heading = document.createElement('div');
    heading.className = 'jc-maintainerr-section-heading';
    const title = document.createElement('h2');
    title.textContent = text('maintainerr_rules_automation', 'Rules & Automation');
    heading.appendChild(title);
    const rulesLink = link(
        text('maintainerr_open_rules', 'Open rules in Maintainerr'),
        dashboard.links?.rules,
        'open_in_new',
    );
    if (rulesLink) heading.appendChild(rulesLink);
    section.appendChild(heading);
    const rules = dashboard.rules;
    if (rules.state === 'unsupported' || rules.state === 'unavailable') {
        appendSectionNotice(section, rules.state);
        return section;
    }
    if (rules.state === 'partial') appendSectionNotice(section, 'partial');

    const grid = document.createElement('div');
    grid.className = 'jc-maintainerr-rules-grid';
    if (rules.count !== undefined) {
        grid.appendChild(metric(text('maintainerr_rule_count', 'Configured rules'), number(rules.count)));
    }
    if (rules.pendingCount !== undefined) {
        grid.appendChild(metric(text('maintainerr_pending_count', 'Pending'), number(rules.pendingCount)));
    }
    if (rules.queueCount !== undefined) {
        grid.appendChild(metric(text('maintainerr_queue_count', 'Queued'), number(rules.queueCount)));
    }
    const ruleState = rules.executing === true
        ? text('maintainerr_executing', 'Executing')
        : rules.processingQueue === true
            ? text('maintainerr_processing_queue', 'Processing queue')
            : rules.executing !== undefined && rules.processingQueue !== undefined
                ? text('maintainerr_idle', 'Idle')
                : null;
    if (ruleState) grid.appendChild(metric(text('maintainerr_rule_state', 'Rule state'), ruleState));
    section.appendChild(grid);
    return section;
}

function renderOverlays(dashboard: MaintainerrDashboard): HTMLElement {
    const section = document.createElement('section');
    section.className = 'jc-maintainerr-section jc-maintainerr-metric';
    const heading = document.createElement('div');
    heading.className = 'jc-maintainerr-section-heading';
    const title = document.createElement('h2');
    title.textContent = text('maintainerr_overlays', 'Overlays');
    heading.appendChild(title);
    section.appendChild(heading);
    const overlays = dashboard.overlays;
    if (overlays.state === 'unsupported' || overlays.state === 'unavailable') {
        appendSectionNotice(section, overlays.state);
        return section;
    }
    const state = overlays.status === 'running'
        ? text('maintainerr_overlays_running', 'Running')
        : overlays.status === 'error'
            ? text('maintainerr_overlays_error', 'Last run failed')
            : text('maintainerr_overlays_idle', 'Idle');
    const lastRun = generatedAt(overlays.lastRun);
    section.appendChild(metric(
        text('maintainerr_overlay_state', 'Overlay state'),
        state,
        lastRun
            ? text('maintainerr_overlay_last_run', `Last run ${lastRun}`, { date: lastRun })
            : undefined,
    ));
    return section;
}

function renderStorage(dashboard: MaintainerrDashboard): HTMLElement {
    const storage = document.createElement('section');
    storage.className = 'jc-maintainerr-section jc-maintainerr-metric';
    const storageHeading = document.createElement('div');
    storageHeading.className = 'jc-maintainerr-section-heading';
    const storageTitle = document.createElement('h2');
    storageTitle.textContent = text('maintainerr_storage', 'Storage and cleanup totals');
    storageHeading.appendChild(storageTitle);
    const storageLink = link(
        text('maintainerr_open_storage', 'Open storage metrics'),
        dashboard.links?.storageMetrics,
        'open_in_new',
    );
    if (storageLink) storageHeading.appendChild(storageLink);
    storage.appendChild(storageHeading);
    const summary = dashboard.storage;
    if (summary.state === 'unsupported' || summary.state === 'unavailable') {
        appendSectionNotice(storage, summary.state);
        return storage;
    }
    renderRecord(storage, summary.collectionSummary, COLLECTION_STORAGE_METRICS);
    renderRecord(storage, summary.cleanupTotals, CLEANUP_TOTAL_METRICS);
    if (summary.reclaimableUsingFallback) {
        const warning = document.createElement('div');
        warning.className = 'jc-maintainerr-section-state jc-state-partial';
        warning.setAttribute('role', 'note');
        warning.textContent = text(
            'maintainerr_storage_fallback_warning',
            'Reclaimable storage uses an estimate and may overcount shared media.',
        );
        storage.appendChild(warning);
    }
    return storage;
}

function renderViewTabs(owner: ActivePage): HTMLElement {
    const tabs = document.createElement('div');
    tabs.className = 'jc-maintainerr-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', text('maintainerr_views', 'Maintainerr views'));
    const definitions: Array<{ view: MaintainerrView; key: string; fallback: string }> = [
        { view: 'collections', key: 'maintainerr_collections', fallback: 'Collections' },
        { view: 'rules', key: 'maintainerr_rules_automation', fallback: 'Rules & Automation' },
    ];
    for (const definition of definitions) {
        const tab = document.createElement('button');
        const selected = owner.view === definition.view;
        tab.type = 'button';
        tab.className = 'jc-maintainerr-tab';
        tab.id = `jc-maintainerr-${definition.view}-tab`;
        tab.dataset.action = 'select-view';
        tab.dataset.view = definition.view;
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', String(selected));
        tab.setAttribute('aria-controls', `jc-maintainerr-${definition.view}-panel`);
        tab.tabIndex = selected ? 0 : -1;
        tab.textContent = text(definition.key, definition.fallback);
        tabs.appendChild(tab);
    }
    return tabs;
}

function appendOption(select: HTMLSelectElement, value: string, label: string): void {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
}

function filteredCollections(
    owner: ActivePage,
    collections: readonly MaintainerrCollectionSummary[],
): MaintainerrCollectionSummary[] {
    const query = owner.search.trim().toLocaleLowerCase(getDisplayLocale());
    const filtered = collections.filter((collection) => {
        if (owner.filter === 'active' && !collection.isActive) return false;
        if (owner.filter === 'inactive' && collection.isActive) return false;
        if (owner.filter === 'manual' && !collection.manualCollection) return false;
        return !query
            || collection.title.toLocaleLowerCase(getDisplayLocale()).includes(query)
            || collection.type.toLocaleLowerCase(getDisplayLocale()).includes(query)
            || mediaTypeLabel(collection.type).toLocaleLowerCase(getDisplayLocale()).includes(query);
    });
    return filtered
        .map((collection, index) => ({ collection, index }))
        .sort((left, right) => {
            let result = 0;
            if (owner.sort === 'mediaCount') {
                result = right.collection.mediaCount - left.collection.mediaCount;
            } else if (owner.sort === 'handled') {
                result = (right.collection.handledMediaAmount ?? 0)
                    - (left.collection.handledMediaAmount ?? 0);
            } else {
                result = left.collection.title.localeCompare(
                    right.collection.title,
                    getDisplayLocale(),
                    { sensitivity: 'base' },
                );
            }
            return result || left.index - right.index;
        })
        .map(({ collection }) => collection);
}

function renderCollections(owner: ActivePage, root: HTMLElement, collections: MaintainerrCollectionSummary[]): void {
    const section = document.createElement('section');
    section.className = 'jc-maintainerr-section';
    const heading = document.createElement('div');
    heading.className = 'jc-maintainerr-section-heading';
    const title = document.createElement('h2');
    title.textContent = text('maintainerr_collections', 'Collections');
    const count = document.createElement('span');
    count.className = 'jc-maintainerr-chip';
    const visibleCollections = filteredCollections(owner, collections);
    const countKey = collections.length === 1
        ? 'maintainerr_collection_filtered_count_one'
        : 'maintainerr_collection_filtered_count_many';
    count.textContent = text(
        countKey,
        `${number(visibleCollections.length)} of ${number(collections.length)} `
            + (collections.length === 1 ? 'collection' : 'collections'),
        {
            count: visibleCollections.length,
            total: collections.length,
        },
    );
    heading.append(title, count);
    section.appendChild(heading);

    const controls = document.createElement('div');
    controls.className = 'jc-maintainerr-controls';
    const searchLabel = document.createElement('label');
    searchLabel.className = 'jc-maintainerr-control jc-maintainerr-search';
    const searchText = document.createElement('span');
    searchText.textContent = text('maintainerr_search_collections', 'Search collections');
    const search = document.createElement('input');
    search.type = 'search';
    search.maxLength = MAX_SEARCH_LENGTH;
    search.value = owner.search;
    search.dataset.control = 'collection-search';
    search.placeholder = text('maintainerr_search_placeholder', 'Title or type');
    searchLabel.append(searchText, search);

    const filterLabel = document.createElement('label');
    filterLabel.className = 'jc-maintainerr-control';
    const filterText = document.createElement('span');
    filterText.textContent = text('maintainerr_filter_collections', 'Filter');
    const filter = document.createElement('select');
    filter.dataset.control = 'collection-filter';
    appendOption(filter, 'all', text('maintainerr_filter_all', 'All'));
    appendOption(filter, 'active', text('maintainerr_filter_active', 'Active'));
    appendOption(filter, 'inactive', text('maintainerr_filter_inactive', 'Inactive'));
    appendOption(filter, 'manual', text('maintainerr_filter_manual', 'Manual'));
    filter.value = owner.filter;
    filterLabel.append(filterText, filter);

    const sortLabel = document.createElement('label');
    sortLabel.className = 'jc-maintainerr-control';
    const sortText = document.createElement('span');
    sortText.textContent = text('maintainerr_sort_collections', 'Sort');
    const sort = document.createElement('select');
    sort.dataset.control = 'collection-sort';
    appendOption(sort, 'title', text('maintainerr_sort_title', 'Title'));
    appendOption(sort, 'mediaCount', text('maintainerr_sort_media_count', 'Most media'));
    appendOption(sort, 'handled', text('maintainerr_sort_handled', 'Most handled'));
    sort.value = owner.sort;
    sortLabel.append(sortText, sort);
    controls.append(searchLabel, filterLabel, sortLabel);
    section.appendChild(controls);

    if (collections.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'jc-maintainerr-empty';
        empty.textContent = text('maintainerr_no_collections', 'No Maintainerr collections were returned.');
        section.appendChild(empty);
        root.appendChild(section);
        return;
    }
    if (visibleCollections.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'jc-maintainerr-empty';
        empty.textContent = text('maintainerr_no_matching_collections', 'No collections match these filters.');
        section.appendChild(empty);
        root.appendChild(section);
        return;
    }

    const grid = document.createElement('div');
    grid.className = 'jc-maintainerr-grid';
    for (const collection of visibleCollections) {
        const card = document.createElement('article');
        card.className = 'jc-maintainerr-collection';
        const cardTitle = document.createElement('div');
        cardTitle.className = 'jc-maintainerr-collection-title';
        cardTitle.textContent = collection.title;
        const meta = document.createElement('div');
        meta.className = 'jc-maintainerr-collection-meta';
        const type = document.createElement('span');
        type.className = 'jc-maintainerr-chip';
        type.textContent = mediaTypeLabel(collection.type);
        const active = document.createElement('span');
        active.className = `jc-maintainerr-chip ${collection.isActive ? 'jc-active' : 'jc-inactive'}`;
        active.textContent = collection.isActive
            ? text('maintainerr_active', 'Active')
            : text('maintainerr_inactive', 'Inactive');
        meta.append(type, active);
        if (collection.manualCollection) {
            const manual = document.createElement('span');
            manual.className = 'jc-maintainerr-chip';
            manual.textContent = text('maintainerr_manual', 'Manual');
            meta.appendChild(manual);
        }
        card.append(cardTitle, meta);

        const details = document.createElement('div');
        details.className = 'jc-maintainerr-status-detail';
        const parts = [
            text('maintainerr_media_count', `${number(collection.mediaCount)} media`, {
                count: collection.mediaCount,
            }),
        ];
        if (collection.handledMediaAmount !== undefined) {
            parts.push(text('maintainerr_handled_count', `${number(collection.handledMediaAmount)} handled`, {
                count: collection.handledMediaAmount,
            }));
        }
        if (collection.deleteAfterDays !== undefined) {
            const retentionKey = collection.deleteAfterDays === 1
                ? 'maintainerr_retention_day'
                : 'maintainerr_retention_days';
            parts.push(text(retentionKey, `${number(collection.deleteAfterDays)} `
                + (collection.deleteAfterDays === 1 ? 'day' : 'days') + ' retention', {
                count: collection.deleteAfterDays,
            }));
        }
        const total = bytes(collection.totalSizeBytes);
        const handled = bytes(collection.handledMediaSizeBytes);
        const lastDuration = duration(collection.lastDurationInSeconds);
        if (total) parts.push(text('maintainerr_total_size', `${total} total`, { size: total }));
        if (handled) parts.push(text('maintainerr_handled_size', `${handled} handled`, { size: handled }));
        if (lastDuration) parts.push(text('maintainerr_last_duration', `Last run ${lastDuration}`, {
            duration: lastDuration,
        }));
        details.textContent = parts.join(' · ');
        card.appendChild(details);

        const actions = document.createElement('div');
        actions.className = 'jc-maintainerr-collection-actions';
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'jc-maintainerr-collection-open';
        open.dataset.action = 'open-collection';
        open.dataset.collectionId = String(collection.id);
        appendIcon(open, 'list');
        open.appendChild(document.createTextNode(text('maintainerr_view_content', 'View content')));
        actions.appendChild(open);
        const external = link(text('maintainerr_open_in_maintainerr', 'Open in Maintainerr'), collection.href, 'open_in_new');
        if (external) actions.appendChild(external);
        card.appendChild(actions);
        grid.appendChild(card);
    }
    section.appendChild(grid);
    root.appendChild(section);
}

function renderCollectionDialog(owner: ActivePage, root: HTMLElement): void {
    const view = owner.collection;
    if (!view) return;
    const modal = document.createElement('div');
    modal.className = 'jc-maintainerr-modal';
    modal.dataset.action = 'close-collection-backdrop';
    const dialog = document.createElement('section');
    dialog.className = 'jc-maintainerr-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'jc-maintainerr-dialog-title');
    const header = document.createElement('div');
    header.className = 'jc-maintainerr-dialog-header';
    const title = document.createElement('h2');
    title.id = 'jc-maintainerr-dialog-title';
    title.textContent = view.summary.title;
    const close = button(text('maintainerr_close', 'Close'), 'close-collection', 'close');
    header.append(title, close);
    dialog.appendChild(header);

    if (view.loading) {
        const loading = document.createElement('div');
        loading.className = 'jc-maintainerr-empty';
        loading.setAttribute('role', 'status');
        loading.textContent = text('maintainerr_loading_collection', 'Loading collection content…');
        dialog.appendChild(loading);
    } else if (view.error) {
        const error = document.createElement('div');
        error.className = 'jc-maintainerr-error';
        error.setAttribute('role', 'alert');
        error.textContent = view.error;
        dialog.appendChild(error);
    } else if (view.content) {
        const content = view.content;
        if (content.items.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'jc-maintainerr-empty';
            empty.textContent = text('maintainerr_collection_empty', 'This collection has no content.');
            dialog.appendChild(empty);
        } else {
            const list = document.createElement('ul');
            list.className = 'jc-maintainerr-content-list';
            for (const item of content.items) {
                const row = document.createElement('li');
                row.className = 'jc-maintainerr-content-item';
                const itemTitle = document.createElement('div');
                itemTitle.className = 'jc-maintainerr-content-title';
                itemTitle.textContent = item.title;
                const itemType = document.createElement('span');
                itemType.className = 'jc-maintainerr-chip';
                itemType.textContent = mediaTypeLabel(item.type);
                row.append(itemTitle, itemType);
                const external = link(text('maintainerr_open_in_maintainerr', 'Open in Maintainerr'), item.href, 'open_in_new');
                if (external) row.appendChild(external);
                list.appendChild(row);
            }
            dialog.appendChild(list);
        }
        const pages = Math.max(1, Math.ceil(content.totalSize / content.size));
        const pagination = document.createElement('div');
        pagination.className = 'jc-maintainerr-pagination';
        const previous = button(text('maintainerr_previous', 'Previous'), 'collection-previous', 'chevron_left');
        previous.disabled = content.page <= 1;
        const indicator = document.createElement('span');
        indicator.textContent = text(
            'maintainerr_page_of',
            `Page ${number(content.page)} of ${number(pages)}`,
            { page: content.page, pages },
        );
        const next = button(text('maintainerr_next', 'Next'), 'collection-next', 'chevron_right');
        next.disabled = content.page >= pages;
        pagination.append(previous, indicator, next);
        dialog.appendChild(pagination);
    }
    modal.appendChild(dialog);
    root.appendChild(modal);
}

function renderPage(owner: ActivePage): void {
    if (!isCurrent(owner)) return;
    const existingDialog = owner.container.querySelector('.jc-maintainerr-dialog');
    const shouldFocusDialog = owner.collection !== null
        && (!existingDialog || existingDialog.contains(document.activeElement));
    const root = document.createElement('div');
    root.className = 'jc-maintainerr-page';
    const header = document.createElement('header');
    header.className = 'jc-maintainerr-header';
    const heading = document.createElement('div');
    const title = document.createElement('h1');
    title.className = 'jc-maintainerr-title';
    title.textContent = text('maintainerr_title', 'Maintainerr');
    const subtitle = document.createElement('p');
    subtitle.className = 'jc-maintainerr-subtitle';
    subtitle.textContent = text(
        'maintainerr_subtitle',
        'Read-only cleanup rules, collections, storage, and queue status.',
    );
    heading.append(title, subtitle);
    const actions = document.createElement('div');
    actions.className = 'jc-maintainerr-header-actions';
    const refreshing = owner.loading && owner.dashboard !== null;
    const refresh = button(
        refreshing
            ? text('maintainerr_refreshing', 'Refreshing…')
            : text('maintainerr_refresh', 'Refresh'),
        'refresh',
        refreshing ? 'sync' : 'refresh',
    );
    // Keep an explicit refresh focusable while it is coalesced in flight.
    // Native `disabled` would move keyboard focus to <body> when this
    // replaceChildren render swaps the button.
    refresh.disabled = owner.loading && owner.dashboard === null;
    refresh.setAttribute('aria-disabled', String(owner.loading));
    refresh.setAttribute('aria-busy', String(owner.loading));
    actions.appendChild(refresh);
    const overview = link(
        text('maintainerr_open_overview', 'Open Maintainerr'),
        owner.dashboard?.links?.overview,
        'open_in_new',
    );
    if (overview) actions.appendChild(overview);
    header.append(heading, actions);
    root.append(header, renderNetworkWarning());
    if (refreshing) {
        const refreshStatus = document.createElement('div');
        refreshStatus.className = 'jc-maintainerr-section-state jc-state-partial';
        refreshStatus.setAttribute('role', 'status');
        refreshStatus.textContent = text('maintainerr_refreshing', 'Refreshing…');
        root.appendChild(refreshStatus);
    }

    if (owner.loading && !owner.dashboard) {
        const loading = document.createElement('div');
        loading.className = 'jc-maintainerr-empty';
        loading.setAttribute('role', 'status');
        loading.textContent = text('maintainerr_loading', 'Loading Maintainerr dashboard…');
        root.appendChild(loading);
    } else if (owner.error && !owner.dashboard) {
        const error = document.createElement('div');
        error.className = 'jc-maintainerr-error';
        error.setAttribute('role', 'alert');
        error.textContent = owner.error;
        root.appendChild(error);
    } else if (owner.dashboard) {
        const dashboard = owner.dashboard;
        if (owner.error) {
            const error = document.createElement('div');
            error.className = 'jc-maintainerr-error';
            error.setAttribute('role', 'alert');
            error.textContent = owner.error;
            root.appendChild(error);
        }
        root.appendChild(renderStatus(dashboard));
        const grid = document.createElement('section');
        grid.className = 'jc-maintainerr-grid';
        grid.setAttribute('aria-label', text('maintainerr_storage', 'Storage and cleanup totals'));
        grid.appendChild(metric(
            text('maintainerr_active_collections', 'Active collections'),
            number(dashboard.collections.filter((entry) => entry.isActive).length),
        ));
        const storageState = dashboard.storage.state === 'available'
            ? text('maintainerr_not_reported', 'Not reported')
            : sectionStateText(dashboard.storage.state);
        const collectionSummary = dashboard.storage.collectionSummary;
        const cleanupTotals = dashboard.storage.cleanupTotals;
        grid.appendChild(metric(
            text('maintainerr_storage_collection_count', 'Total collections'),
            collectionSummary ? number(collectionSummary.totalCollectionCount) : storageState,
        ));
        grid.appendChild(metric(
            text('maintainerr_storage_reclaimable_count', 'Reclaimable collections'),
            collectionSummary ? number(collectionSummary.reclaimableCount) : storageState,
        ));
        grid.appendChild(metric(
            text('maintainerr_storage_active_size', 'Reclaimable storage'),
            collectionSummary ? bytes(collectionSummary.activeSizeBytes) || number(collectionSummary.activeSizeBytes) : storageState,
        ));
        grid.appendChild(metric(
            text('maintainerr_cleanup_items', 'Items handled'),
            cleanupTotals ? number(cleanupTotals.itemsHandled) : storageState,
        ));
        grid.appendChild(metric(
            text('maintainerr_cleanup_size', 'Storage reclaimed'),
            cleanupTotals ? bytes(cleanupTotals.bytesHandled) || number(cleanupTotals.bytesHandled) : storageState,
        ));
        const generated = generatedAt(dashboard.storage.generatedAt);
        grid.appendChild(metric(
            text('maintainerr_storage_snapshot', 'Storage snapshot'),
            dashboard.storage.state === 'available' && generated
                ? generated
                : dashboard.storage.state === 'available'
                    ? text('maintainerr_not_reported', 'Not reported')
                    : sectionStateText(dashboard.storage.state),
        ));
        root.appendChild(grid);
        root.appendChild(renderOverlays(dashboard));
        root.appendChild(renderViewTabs(owner));
        if (owner.view === 'rules') {
            root.appendChild(renderRules(dashboard));
        } else {
            const collectionsPanel = document.createElement('div');
            collectionsPanel.id = 'jc-maintainerr-collections-panel';
            collectionsPanel.setAttribute('role', 'tabpanel');
            collectionsPanel.setAttribute('aria-labelledby', 'jc-maintainerr-collections-tab');
            collectionsPanel.appendChild(renderStorage(dashboard));
            renderCollections(owner, collectionsPanel, dashboard.collections);
            root.appendChild(collectionsPanel);
        }
    }
    renderCollectionDialog(owner, root);
    owner.container.replaceChildren(root);
    if (shouldFocusDialog) {
        owner.container.querySelector<HTMLButtonElement>(
            '.jc-maintainerr-dialog [data-action="close-collection"]',
        )?.focus();
    }
}

async function loadDashboard(owner: ActivePage, forceRefresh = false): Promise<void> {
    if (!isCurrent(owner)) return;
    if (owner.loadPromise) return owner.loadPromise;
    const restoreRefreshFocus = document.activeElement === owner.container.querySelector(
        '[data-action="refresh"]',
    );
    const run = (async (): Promise<void> => {
        owner.loading = true;
        owner.error = null;
        renderPage(owner);
        if (restoreRefreshFocus) {
            owner.container.querySelector<HTMLButtonElement>(
                '[data-action="refresh"]',
            )?.focus();
        }
        try {
            const payload = await JC.core.api!.plugin(
                forceRefresh ? '/maintainerr/dashboard?refresh=true' : '/maintainerr/dashboard',
                {
                signal: owner.signal,
                skipCache: true,
                skipRetry: true,
                timeoutMs: 15_000,
                },
            );
            if (!isCurrent(owner)) return;
            const parsed = parseMaintainerrDashboard(payload);
            if (!parsed) throw new Error('Invalid Maintainerr dashboard response');
            owner.dashboard = parsed;
        } catch (error) {
            if (!isCurrent(owner)) return;
            owner.error = describeMaintainerrRequestError(
                error,
                text('maintainerr_dashboard_error', 'Could not load the Maintainerr dashboard.'),
                text,
            );
        } finally {
            if (isCurrent(owner)) {
                owner.loading = false;
                renderPage(owner);
                if (restoreRefreshFocus) {
                    owner.container.querySelector<HTMLButtonElement>(
                        '[data-action="refresh"]',
                    )?.focus();
                }
            }
        }
    })();
    const ownedPromise = run.finally(() => {
        if (owner.loadPromise === ownedPromise) owner.loadPromise = null;
    });
    owner.loadPromise = ownedPromise;
    return ownedPromise;
}

function stopContentRequest(owner: ActivePage): void {
    if (!owner.contentController) return;
    owner.handle.untrack(owner.contentController);
    owner.contentController.abort();
    owner.contentController = null;
}

async function loadCollectionPage(owner: ActivePage, page: number): Promise<void> {
    const view = owner.collection;
    if (!view || !isCurrent(owner)) return;
    stopContentRequest(owner);
    const controller = new AbortController();
    owner.contentController = controller;
    owner.handle.track(controller);
    const generation = ++view.generation;
    view.loading = true;
    view.error = null;
    renderPage(owner);
    const query = new URLSearchParams({
        page: String(Math.max(1, page)),
        size: String(CONTENT_PAGE_SIZE),
        // Maintainerr 3.18 SQL-pages only the absent/default and
        // deleteSoonest shapes. Media-metadata sorts hydrate the complete
        // collection before slicing, so they are deliberately never emitted.
        sort: 'deleteSoonest',
        sortOrder: 'asc',
    });
    try {
        const payload = await JC.core.api!.plugin(
            `/maintainerr/collections/${encodeURIComponent(String(view.summary.id))}/content?${query.toString()}`,
            {
                signal: controller.signal,
                skipCache: true,
                skipRetry: true,
                timeoutMs: 10_000,
            },
        );
        if (!isCurrent(owner)
            || owner.collection !== view
            || generation !== view.generation
            || controller.signal.aborted) return;
        const parsed = parseMaintainerrCollectionContent(payload);
        if (!parsed) throw new Error('Invalid Maintainerr collection response');
        view.content = parsed;
        view.page = parsed.page;
    } catch (error) {
        if (!isCurrent(owner)
            || owner.collection !== view
            || generation !== view.generation
            || controller.signal.aborted) return;
        view.error = describeMaintainerrRequestError(
            error,
            text('maintainerr_collection_error', 'Could not load this Maintainerr collection.'),
            text,
        );
    } finally {
        if (owner.contentController === controller) {
            owner.handle.untrack(controller);
            owner.contentController = null;
        }
        if (isCurrent(owner) && owner.collection === view && generation === view.generation) {
            view.loading = false;
            renderPage(owner);
        }
    }
}

function openCollection(owner: ActivePage, collectionId: number): void {
    const summary = owner.dashboard?.collections.find((entry) => entry.id === collectionId);
    if (!summary) return;
    owner.returnCollectionId = collectionId;
    owner.collection = {
        summary,
        page: 1,
        loading: true,
        error: null,
        content: null,
        generation: 0,
    };
    void loadCollectionPage(owner, 1);
}

function closeCollection(owner: ActivePage): void {
    stopContentRequest(owner);
    const returnCollectionId = owner.returnCollectionId;
    owner.collection = null;
    owner.returnCollectionId = null;
    renderPage(owner);
    if (returnCollectionId !== null) {
        owner.container.querySelector<HTMLButtonElement>(
            `[data-action="open-collection"][data-collection-id="${returnCollectionId}"]`,
        )?.focus();
    }
}

function render({ host, handle, signal }: PageContext): void {
    const context = JC.identity.capture();
    if (!context || JC.currentUser?.Policy?.IsAdministrator !== true) return;
    injectMaintainerrPageStyles();
    const content = document.createElement('div');
    content.setAttribute('data-role', 'content');
    const primary = document.createElement('div');
    primary.className = 'content-primary';
    const container = document.createElement('div');
    container.id = 'jc-maintainerr-container';
    container.className = 'jc-interior-page-top';
    JC.identity.own(container, context);
    primary.appendChild(container);
    content.appendChild(primary);
    host.appendChild(content);

    const owner: ActivePage = {
        context,
        container,
        handle,
        signal,
        dashboard: null,
        loading: false,
        error: null,
        loadPromise: null,
        collection: null,
        contentController: null,
        search: '',
        filter: 'all',
        sort: 'title',
        view: 'collections',
        returnCollectionId: null,
    };
    activePage = owner;
    handle.track(() => {
        stopContentRequest(owner);
        if (activePage === owner) activePage = null;
    });
    handle.addListener(host, 'click', (event: Event) => {
        if (!isCurrent(owner)) return;
        const target = event.target as Element | null;
        const actionable = target?.closest<HTMLElement>('[data-action]');
        if (!actionable) return;
        const action = actionable.dataset.action;
        if (action === 'close-collection-backdrop' && target !== actionable) return;
        event.preventDefault();
        event.stopPropagation();
        if (action === 'refresh') {
            if (!owner.loading) void loadDashboard(owner, true);
        } else if (action === 'select-view') {
            const view = actionable.dataset.view;
            if (view === 'collections' || view === 'rules') {
                owner.view = view;
                renderPage(owner);
                owner.container.querySelector<HTMLButtonElement>(
                    `[data-action="select-view"][data-view="${view}"]`,
                )?.focus();
            }
        } else if (action === 'open-collection') {
            const id = Number(actionable.dataset.collectionId);
            if (Number.isSafeInteger(id) && id > 0) openCollection(owner, id);
        } else if (action === 'close-collection' || action === 'close-collection-backdrop') {
            closeCollection(owner);
        } else if (action === 'collection-previous' && owner.collection?.content) {
            void loadCollectionPage(owner, Math.max(1, owner.collection.content.page - 1));
        } else if (action === 'collection-next' && owner.collection?.content) {
            void loadCollectionPage(owner, owner.collection.content.page + 1);
        }
    });
    handle.addListener(host, 'input', (event: Event) => {
        if (!isCurrent(owner)) return;
        const input = (event.target as Element | null)?.closest<HTMLInputElement>(
            '[data-control="collection-search"]',
        );
        if (!input) return;
        const value = input.value.slice(0, MAX_SEARCH_LENGTH);
        owner.search = value;
        if ((event as InputEvent).isComposing === true) return;
        const selection = Math.min(input.selectionStart ?? value.length, value.length);
        renderPage(owner);
        const next = owner.container.querySelector<HTMLInputElement>(
            '[data-control="collection-search"]',
        );
        next?.focus();
        next?.setSelectionRange(selection, selection);
    });
    handle.addListener(host, 'compositionend', (event: Event) => {
        if (!isCurrent(owner)) return;
        const input = (event.target as Element | null)?.closest<HTMLInputElement>(
            '[data-control="collection-search"]',
        );
        if (!input) return;
        const value = input.value.slice(0, MAX_SEARCH_LENGTH);
        const selection = Math.min(input.selectionStart ?? value.length, value.length);
        owner.search = value;
        renderPage(owner);
        const next = owner.container.querySelector<HTMLInputElement>(
            '[data-control="collection-search"]',
        );
        next?.focus();
        next?.setSelectionRange(selection, selection);
    });
    handle.addListener(host, 'change', (event: Event) => {
        if (!isCurrent(owner)) return;
        const select = (event.target as Element | null)?.closest<HTMLSelectElement>('[data-control]');
        if (!select) return;
        if (select.dataset.control === 'collection-filter'
            && ['all', 'active', 'inactive', 'manual'].includes(select.value)) {
            owner.filter = select.value as CollectionFilter;
            renderPage(owner);
            owner.container.querySelector<HTMLSelectElement>(
                '[data-control="collection-filter"]',
            )?.focus();
        } else if (select.dataset.control === 'collection-sort'
            && ['title', 'mediaCount', 'handled'].includes(select.value)) {
            owner.sort = select.value as CollectionSort;
            renderPage(owner);
            owner.container.querySelector<HTMLSelectElement>(
                '[data-control="collection-sort"]',
            )?.focus();
        }
    });
    handle.addListener(host, 'keydown', (event: Event) => {
        const keyboard = event as KeyboardEvent;
        const selectedTab = (keyboard.target as Element | null)?.closest<HTMLButtonElement>(
            '.jc-maintainerr-tab[role="tab"][data-view]',
        );
        if (selectedTab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(keyboard.key)) {
            keyboard.preventDefault();
            const nextView: MaintainerrView = keyboard.key === 'ArrowLeft'
                || keyboard.key === 'Home'
                ? 'collections'
                : 'rules';
            owner.view = nextView;
            renderPage(owner);
            owner.container.querySelector<HTMLButtonElement>(
                `[data-action="select-view"][data-view="${nextView}"]`,
            )?.focus();
            return;
        }
        if (keyboard.key === 'Escape' && owner.collection) {
            keyboard.preventDefault();
            closeCollection(owner);
            return;
        }
        if (keyboard.key !== 'Tab' || !owner.collection) return;
        const dialog = owner.container.querySelector<HTMLElement>('.jc-maintainerr-dialog');
        if (!dialog) return;
        const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
            'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), '
                + '[tabindex]:not([tabindex="-1"])',
        )).filter((element) => !element.hasAttribute('hidden'));
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (keyboard.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
            keyboard.preventDefault();
            last.focus();
        } else if (!keyboard.shiftKey
            && (document.activeElement === last || !dialog.contains(document.activeElement))) {
            keyboard.preventDefault();
            first.focus();
        }
    });
    renderPage(owner);
    void loadDashboard(owner);
}

function onHide(): void {
    if (activePage) {
        stopContentRequest(activePage);
        activePage = null;
    }
    removeMaintainerrPageStyles();
}

export const maintainerrPageDescriptor: PageDescriptor & { id: 'maintainerr' } = {
    id: 'maintainerr',
    route: '/maintainerr',
    titleKey: 'maintainerr_title',
    titleFallback: 'Maintainerr',
    icon: 'rule',
    isEnabled: () => JC.pluginConfig?.MaintainerrEnabled === true
        && JC.pluginConfig?.MaintainerrPageEnabled === true,
    adminOnly: true,
    render,
    onHide,
};

export interface MaintainerrPageApi {
    showPage(): void;
    refresh(): Promise<void>;
}

export const maintainerrPageFacade: Omit<MaintainerrPageApi, 'showPage'> = {
    refresh: () => activePage ? loadDashboard(activePage, true) : Promise.resolve(),
};
