// issue 34: the tag pipeline is a poster-CARD decorator only — list-view rows must
// never receive card-sized tag overlays. isListViewRow is the single shared gate
// (used by shouldSkipElement, before any renderer runs) that excludes every
// `.listItem` row. These cases lock the gate's behaviour: a `.cardImageContainer`
// nested in a list row is a list row (skipped), a bare card is not, and the legacy
// no-image `.listItemImage.cardImageContainer` variant — the one shape the modern
// card scan selector could otherwise surface — is still caught.
import { afterAll, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import { getItemCached } from './helpers';
import {
    applyContentResponse,
    decideContentResponse,
    decideProjectionResponse,
    extractUserDataChangedIds,
    isListViewRow,
    normalizeProjectionKey,
    readProjectionIdentity,
    readContentIdentity,
    installTagPipeline,
    resetTagPipelineIdentity,
    TagProjectionDependencyIndex,
} from './tag-pipeline';

const uninstallTagPipeline = installTagPipeline();
const offPipelineReset = JC.identity.registerReset('tag-pipeline-test', resetTagPipelineIdentity);
const offPipelineActivate = JC.identity.registerActivate(
    'tag-pipeline-test',
    () => JC.tagPipeline?.initialize?.()
);

afterAll(async () => {
    // Retire identity-owned scans while jsdom is still alive, then let the
    // uncancellable requestIdleCallback fallback drain its generation guard.
    // Otherwise a real 16 ms timer can reach runScan() after environment
    // teardown and turn an entirely passing suite into an unhandled failure.
    JC.identity.transition('', '', 'tag-pipeline-test-teardown');
    offPipelineActivate();
    offPipelineReset();
    uninstallTagPipeline();
    await new Promise((resolve) => setTimeout(resolve, 25));
    document.body.innerHTML = '';
});

/** Build a `.cardImageContainer` nested inside a `.listItem` row. */
function listRowImage(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'listItem';
    const img = document.createElement('div');
    img.className = 'cardImageContainer';
    row.appendChild(img);
    return img;
}

/** Build a bare poster-card `.cardImageContainer` (grid/home rail — should be tagged). */
function gridCardImage(): HTMLElement {
    const card = document.createElement('div');
    card.className = 'card';
    const scalable = document.createElement('div');
    scalable.className = 'cardScalable';
    const img = document.createElement('div');
    img.className = 'cardImageContainer';
    scalable.appendChild(img);
    card.appendChild(scalable);
    return img;
}

/** Legacy no-image row: native renders the image element as `.listItemImage.cardImageContainer`. */
function legacyNoImageRow(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'listItem';
    const img = document.createElement('div');
    img.className = 'listItemImage cardImageContainer';
    row.appendChild(img);
    return img;
}

describe('isListViewRow — the single list-view gate (issue 34)', () => {
    it('treats a .cardImageContainer nested in a .listItem row as a list row (skipped)', () => {
        expect(isListViewRow(listRowImage())).toBe(true);
    });

    it('does NOT treat a bare poster-card .cardImageContainer as a list row (still tagged)', () => {
        expect(isListViewRow(gridCardImage())).toBe(false);
    });

    it('catches the legacy .listItemImage.cardImageContainer no-image variant', () => {
        expect(isListViewRow(legacyNoImageRow())).toBe(true);
    });
});

describe('watched/privacy projection response ordering (BI-SEC-035)', () => {
    const userA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const userB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

    const response = (userId: string, epoch: string, revision: number, projectionReset = false) => ({
        projectionUserId: userId,
        projectionEpoch: epoch,
        projectionRevision: revision,
        projectionReset,
    });

    it('normalizes dashed ids and binds a full response to user + epoch + revision', () => {
        expect(normalizeProjectionKey(userA)).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
        expect(readProjectionIdentity(response(userA, 'process-1', 7))).toEqual({
            userId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            epoch: 'process-1',
            revision: 7,
        });
    });

    it('rejects delayed revision N after revision N+1 was already applied', () => {
        const current = readProjectionIdentity(response(userA, 'process-1', 11));
        expect(decideProjectionResponse(current, response(userA, 'process-1', 10), userA)).toBe('ignore');
        expect(decideProjectionResponse(current, response(userA, 'process-1', 12), userA)).toBe('apply');
    });

    it('never applies another user projection even when its revision is newer', () => {
        const current = readProjectionIdentity(response(userA, 'process-1', 4));
        expect(decideProjectionResponse(current, response(userB, 'process-1', 999), userA)).toBe('ignore');
    });

    it('requires a full reset on process epoch change or journal reset', () => {
        const current = readProjectionIdentity(response(userA, 'old-process', 40));
        expect(decideProjectionResponse(current, response(userA, 'new-process', 1), userA)).toBe('reset');
        expect(decideProjectionResponse(current, response(userA, 'old-process', 41, true), userA)).toBe('reset');
    });

    it('extracts and deduplicates same-user item ids but ignores an explicit other user', () => {
        const episode = '11111111-1111-1111-1111-111111111111';
        const season = '22222222-2222-2222-2222-222222222222';
        expect(extractUserDataChangedIds({
            UserId: userA,
            UserDataList: [{ ItemId: episode }, { ItemId: episode }, { ItemId: season }],
        }, userA)).toEqual([
            '11111111111111111111111111111111',
            '22222222222222222222222222222222',
        ]);
        expect(extractUserDataChangedIds({
            UserId: userB,
            UserDataList: [{ ItemId: episode }],
        }, userA)).toEqual([]);
    });

    it('expands Episode and Season pushes without scanning and reports incomplete relationships', () => {
        const series = '11111111111111111111111111111111';
        const season = '22222222222222222222222222222222';
        const episode = '33333333333333333333333333333333';
        const unknown = '44444444444444444444444444444444';
        const index = new TagProjectionDependencyIndex();
        index.replaceAll(new Map([
            [episode, { Type: 'Episode', SeriesId: series, SeasonNumber: 2 }],
            [series, { Type: 'Series' }],
            [season, { Type: 'Season', SeriesId: series, SeasonNumber: 2 }],
        ]));

        const episodeExpansion = index.expand([episode]);
        expect(episodeExpansion.complete).toBe(true);
        expect(new Set(episodeExpansion.ids)).toEqual(new Set([episode, season, series]));
        const seasonExpansion = index.expand([season]);
        expect(seasonExpansion.complete).toBe(true);
        expect(new Set(seasonExpansion.ids)).toEqual(new Set([season, series]));
        expect(index.expand([unknown])).toEqual({ ids: [unknown], complete: false });

        index.remove(season);
        expect(index.expand([episode]).complete).toBe(false);
        index.replace(season, { Type: 'Season', SeriesId: series, SeasonNumber: 2 });
        expect(index.expand([episode]).complete).toBe(true);
        index.replace(episode, { Type: 'Episode', SeriesId: series, SeasonNumber: null });
        expect(index.expand([episode]).complete).toBe(false);
    });

    it('blanks exact Episode dependencies synchronously across overlapping native pushes', async () => {
        document.body.innerHTML = '';
        const episode = '11111111111111111111111111111111';
        const siblingEpisode = '99999999999999999999999999999999';
        const season = '22222222222222222222222222222222';
        const series = '33333333333333333333333333333333';
        const unrelated = '44444444444444444444444444444444';
        const oldConfig = JC.pluginConfig;
        JC.pluginConfig = { ...oldConfig, TagCacheServerMode: true };
        JC._tagCachePrefetch = null;
        const currentUser = vi.spyOn(ApiClient, 'getCurrentUserId').mockReturnValue(userA);
        let enabled = true;
        const requestResolvers: Array<(value: unknown) => void> = [];
        let call = 0;
        const ajax = vi.spyOn(ApiClient, 'ajax').mockImplementation(() => {
            call++;
            if (call === 1) {
                return Promise.resolve({
                    version: 1,
                    timestamp: 100,
                    contentEpoch: 'content-process-1',
                    contentRevision: 1,
                    items: {
                        [episode]: { Type: 'Episode', SeriesId: series, SeasonNumber: 2, label: 'episode' },
                        [siblingEpisode]: { Type: 'Episode', SeriesId: series, SeasonNumber: 2, label: 'sibling' },
                        [season]: { Type: 'Season', SeriesId: series, SeasonNumber: 2, label: 'season' },
                        [series]: { Type: 'Series', label: 'series' },
                        [unrelated]: { Type: 'Movie', label: 'unrelated' },
                    },
                    projectionUserId: userA,
                    projectionEpoch: 'process-1',
                    projectionRevision: 1,
                    projectionIds: [],
                    projectionReset: false,
                });
            }
            return new Promise((resolve) => { requestResolvers.push(resolve); });
        });

        JC.tagPipeline!.registerRenderer('projection-dependency-test', {
            render: () => undefined,
            isEnabled: () => enabled,
            renderFromServerCache: (target: HTMLElement, entry: unknown) => {
                const label = (entry as { label?: string }).label;
                if (!label) return;
                const marker = document.createElement('div');
                marker.className = 'projection-test-secret';
                marker.dataset.projectionLabel = label;
                target.appendChild(marker);
            },
            invalidateCard: (target: HTMLElement) => {
                target.querySelectorAll('.projection-test-secret').forEach((node) => node.remove());
            },
        });

        const mount = (id: string, type: string): void => {
            const image = gridCardImage();
            const card = image.closest<HTMLElement>('.card')!;
            card.dataset.id = id;
            card.dataset.type = type;
            document.body.appendChild(card);
        };
        mount(episode, 'Episode');
        mount(siblingEpisode, 'Episode');
        mount(season, 'Season');
        mount(series, 'Series');
        mount(unrelated, 'Movie');

        await JC.tagPipeline!.invalidateServerCache?.();
        await vi.waitFor(() => {
            expect(document.querySelector('[data-projection-label="episode"]')).not.toBeNull();
            expect(document.querySelector('[data-projection-label="sibling"]')).not.toBeNull();
            expect(document.querySelector('[data-projection-label="season"]')).not.toBeNull();
            expect(document.querySelector('[data-projection-label="series"]')).not.toBeNull();
            expect(document.querySelector('[data-projection-label="unrelated"]')).not.toBeNull();
        });

        const pendingFirst = JC.tagPipeline!.refreshServerProjection!({
            UserId: userA,
            UserDataList: [{ ItemId: episode }],
        });

        // Jellyfin's native event contains only E. The local index must blank its
        // dependent Season/Series before the server journal round trip finishes.
        expect(document.querySelector('[data-projection-label="episode"]')).toBeNull();
        expect(document.querySelector('[data-projection-label="season"]')).toBeNull();
        expect(document.querySelector('[data-projection-label="series"]')).toBeNull();
        expect(document.querySelector('[data-projection-label="sibling"]')).not.toBeNull();
        expect(document.querySelector('[data-projection-label="unrelated"]')).not.toBeNull();

        // A sibling push can overlap while E1's request is unresolved. The last
        // authoritative relationship snapshot must remain available so this is
        // another bounded closure, not a global blank/reset.
        const pendingSecond = JC.tagPipeline!.refreshServerProjection!({
            UserId: userA,
            UserDataList: [{ ItemId: siblingEpisode }],
        });
        expect(document.querySelector('[data-projection-label="sibling"]')).toBeNull();
        expect(document.querySelector('[data-projection-label="unrelated"]')).not.toBeNull();

        // Cards mounted during the request are held behind the same parent gate.
        mount(season, 'Season');
        JC.tagPipeline!.scheduleScan?.();
        await new Promise((resolve) => setTimeout(resolve, 220));
        expect(document.querySelector('[data-projection-label="season"]')).toBeNull();
        // Waiting past the longest batch debounce proves the pending gate stopped
        // both server/local rendering and a fallback /tag-data request.
        expect(ajax).toHaveBeenCalledTimes(3);

        requestResolvers[0]({
            version: 1,
            timestamp: 100,
            contentEpoch: 'content-process-1',
            contentRevision: 1,
            items: {
                [episode]: { Type: 'Episode', SeriesId: series, SeasonNumber: 2 },
                [season]: { Type: 'Season', SeriesId: series, SeasonNumber: 2 },
                [series]: { Type: 'Series' },
            },
            projectionUserId: userA,
            projectionEpoch: 'process-1',
            projectionRevision: 2,
            projectionIds: [episode, season, series],
            projectionReset: false,
        });
        await pendingFirst;

        requestResolvers[1]({
            version: 1,
            timestamp: 100,
            contentEpoch: 'content-process-1',
            contentRevision: 1,
            items: {
                [episode]: { Type: 'Episode', SeriesId: series, SeasonNumber: 2 },
                [siblingEpisode]: { Type: 'Episode', SeriesId: series, SeasonNumber: 2 },
                [season]: { Type: 'Season', SeriesId: series, SeasonNumber: 2 },
                [series]: { Type: 'Series' },
            },
            projectionUserId: userA,
            projectionEpoch: 'process-1',
            projectionRevision: 3,
            projectionIds: [episode, siblingEpisode, season, series],
            projectionReset: false,
        });
        await pendingSecond;
        await new Promise((resolve) => setTimeout(resolve, 30));

        expect(document.querySelector('[data-projection-label="episode"]')).toBeNull();
        expect(document.querySelector('[data-projection-label="sibling"]')).toBeNull();
        expect(document.querySelector('[data-projection-label="season"]')).toBeNull();
        expect(document.querySelector('[data-projection-label="series"]')).toBeNull();
        expect(document.querySelector('[data-projection-label="unrelated"]')).not.toBeNull();

        enabled = false;
        ajax.mockRestore();
        currentUser.mockRestore();
        JC.pluginConfig = oldConfig;
        document.body.innerHTML = '';
    });

    it('clears an owner-bound server projection when the active user becomes null', async () => {
        document.body.innerHTML = '';
        const itemId = '55555555555555555555555555555555';
        const oldConfig = JC.pluginConfig;
        JC.pluginConfig = { ...oldConfig, TagCacheServerMode: true };
        JC._tagCachePrefetch = null;
        let activeUser: string | null = userA;
        const currentUser = vi.spyOn(ApiClient, 'getCurrentUserId').mockImplementation(() => activeUser as string);
        const ajax = vi.spyOn(ApiClient, 'ajax').mockResolvedValue({
            version: 1,
            timestamp: 100,
            contentEpoch: 'owner-content-process',
            contentRevision: 1,
            items: { [itemId]: { Type: 'Movie', label: 'owner-a-secret' } },
            projectionUserId: userA,
            projectionEpoch: 'owner-process',
            projectionRevision: 1,
            projectionIds: [],
            projectionReset: false,
        });
        let enabled = true;
        const renders = vi.fn();
        JC.tagPipeline!.registerRenderer('null-owner-projection-test', {
            render: () => undefined,
            isEnabled: () => enabled,
            renderFromServerCache: (target: HTMLElement, entry: unknown) => {
                renders();
                if ((entry as { label?: string }).label !== 'owner-a-secret') return;
                const marker = document.createElement('div');
                marker.className = 'owner-a-projection-secret';
                target.appendChild(marker);
            },
            invalidateCard: (target: HTMLElement) => {
                target.querySelectorAll('.owner-a-projection-secret').forEach((node) => node.remove());
            },
        });

        const mount = (): void => {
            const image = gridCardImage();
            const card = image.closest<HTMLElement>('.card')!;
            card.dataset.id = itemId;
            card.dataset.type = 'Movie';
            document.body.appendChild(card);
        };
        mount();
        await JC.tagPipeline!.invalidateServerCache?.();
        await vi.waitFor(() => expect(document.querySelector('.owner-a-projection-secret')).not.toBeNull());
        const rendersBeforeLogout = renders.mock.calls.length;

        activeUser = null;
        mount();
        JC.tagPipeline!.scheduleScan?.();
        await new Promise((resolve) => setTimeout(resolve, 30));

        expect(document.querySelector('.owner-a-projection-secret')).toBeNull();
        expect(renders).toHaveBeenCalledTimes(rendersBeforeLogout);

        enabled = false;
        ajax.mockRestore();
        currentUser.mockRestore();
        JC.pluginConfig = oldConfig;
        document.body.innerHTML = '';
    });

    it('does not replay a warm helper DTO after an accepted projection tombstone', async () => {
        document.body.innerHTML = '';
        const itemId = '66666666666666666666666666666666';
        const oldConfig = JC.pluginConfig;
        JC.pluginConfig = { ...oldConfig, TagCacheServerMode: true };
        JC._tagCachePrefetch = null;
        const currentUser = vi.spyOn(ApiClient, 'getCurrentUserId').mockReturnValue(userA);
        const getItem = vi.spyOn(ApiClient, 'getItem')
            .mockResolvedValueOnce({ Id: itemId, Type: 'Movie', label: 'stale-helper-secret' })
            .mockResolvedValueOnce({ Id: itemId, Type: 'Movie', label: 'fresh-helper-safe' });
        let ajaxCall = 0;
        const ajax = vi.spyOn(ApiClient, 'ajax').mockImplementation(() => {
            ajaxCall++;
            if (ajaxCall === 1) {
                return Promise.resolve({
                    version: 1,
                    timestamp: 100,
                    contentEpoch: 'helper-content-process',
                    contentRevision: 1,
                    items: { [itemId]: { Type: 'Movie' } },
                    projectionUserId: userA,
                    projectionEpoch: 'helper-process',
                    projectionRevision: 1,
                    projectionIds: [],
                    projectionReset: false,
                });
            }
            if (ajaxCall === 2) {
                return Promise.resolve({
                    version: 1,
                    timestamp: 100,
                    contentEpoch: 'helper-content-process',
                    contentRevision: 1,
                    items: {},
                    projectionUserId: userA,
                    projectionEpoch: 'helper-process',
                    projectionRevision: 2,
                    projectionIds: [itemId],
                    projectionReset: false,
                });
            }
            return Promise.reject(new Error('tag-data unavailable'));
        });
        let enabled = true;
        const renderedLabels: string[] = [];
        JC.tagPipeline!.registerRenderer('helper-tombstone-projection-test', {
            isEnabled: () => enabled,
            render: (_target: HTMLElement, item: unknown) => {
                const label = (item as { label?: string }).label;
                if (label) renderedLabels.push(label);
            },
            renderFromCache: () => false,
        });

        const image = gridCardImage();
        const card = image.closest<HTMLElement>('.card')!;
        card.dataset.id = itemId;
        card.dataset.type = 'Movie';
        document.body.appendChild(card);
        await JC.tagPipeline!.invalidateServerCache?.();
        await getItemCached(itemId, { userId: userA });
        expect(getItem).toHaveBeenCalledTimes(1);

        await JC.tagPipeline!.refreshServerProjection!({
            UserId: userA,
            UserDataList: [{ ItemId: itemId }],
        });
        await vi.waitFor(() => expect(getItem).toHaveBeenCalledTimes(2));

        expect(renderedLabels).not.toContain('stale-helper-secret');
        expect(renderedLabels).toContain('fresh-helper-safe');

        enabled = false;
        ajax.mockRestore();
        getItem.mockRestore();
        currentUser.mockRestore();
        JC.pluginConfig = oldConfig;
        document.body.innerHTML = '';
    });

    it('gates navigation first paint and keeps the shared content cursor behind projection-only updates', async () => {
        document.body.innerHTML = '';
        const itemId = '33333333333333333333333333333333';
        const oldConfig = JC.pluginConfig;
        const oldUi = JC.core.ui;
        JC.pluginConfig = { ...oldConfig, TagCacheServerMode: true };
        JC.core.ui = { injectCss: vi.fn() } as unknown as NonNullable<typeof JC.core.ui>;
        JC._tagCachePrefetch = null;
        const currentUser = vi.spyOn(ApiClient, 'getCurrentUserId').mockReturnValue(userA);

        let call = 0;
        const navigationResolvers: Array<(value: unknown) => void> = [];
        const urls: string[] = [];
        const projectedLabels: string[] = [];
        const ajax = vi.spyOn(ApiClient, 'ajax').mockImplementation((options) => {
            urls.push(String(options.url));
            call++;
            if (call === 1) {
                return Promise.resolve({
                    version: 1,
                    timestamp: 100,
                    contentEpoch: 'nav-content-process',
                    contentRevision: 1,
                    items: { [itemId]: { label: 'initial' } },
                    projectionUserId: userA,
                    projectionEpoch: 'nav-process',
                    projectionRevision: 1,
                    projectionIds: [],
                    projectionReset: false,
                });
            }
            if (call === 2) {
                // Projection-only carries a newer shared timestamp that must not
                // advance the content-delta cursor because it did not fetch it.
                return Promise.resolve({
                    version: 1,
                    timestamp: 200,
                    contentEpoch: 'nav-content-process',
                    contentRevision: 1,
                    items: { [itemId]: { label: 'watched-secret' } },
                    projectionUserId: userA,
                    projectionEpoch: 'nav-process',
                    projectionRevision: 2,
                    projectionIds: [itemId],
                    projectionReset: false,
                });
            }
            return new Promise((resolve) => { navigationResolvers.push(resolve); });
        });

        JC.tagPipeline!.registerRenderer('navigation-projection-test', {
            render: () => undefined,
            isEnabled: () => true,
            renderFromServerCache: (target: HTMLElement, entry: unknown) => {
                const label = (entry as { label?: string }).label;
                if (label) projectedLabels.push(label);
                if (label !== 'watched-secret') return;
                const secret = document.createElement('div');
                secret.className = 'navigation-projection-secret';
                target.appendChild(secret);
            },
            invalidateCard: (target: HTMLElement) => {
                target.querySelector('.navigation-projection-secret')?.remove();
            },
        });
        JC.tagPipeline!.initialize?.();
        await vi.waitFor(() => expect(ajax).toHaveBeenCalledTimes(1));

        const mountCard = (): void => {
            const image = gridCardImage();
            const card = image.closest<HTMLElement>('.card')!;
            card.dataset.id = itemId;
            card.dataset.type = 'Movie';
            document.body.appendChild(card);
        };
        mountCard();
        JC.tagPipeline!.scheduleScan?.();
        await new Promise((resolve) => setTimeout(resolve, 30));

        // Local watched flip installs a sensitive projected row.
        await JC.tagPipeline!.refreshServerProjection!({
            UserId: userA,
            UserDataList: [{ ItemId: itemId }],
        });
        await vi.waitFor(() => {
            expect(document.querySelector('.navigation-projection-secret')).not.toBeNull();
        });

        // Simulate a missed cross-client unplay: no native push reaches this tab.
        // Navigation must blank synchronously and hold the incoming card behind
        // the revision request, never painting the watched-secret row first.
        history.pushState({}, '', `/projection-nav-${Date.now()}`);
        expect(document.querySelector('.navigation-projection-secret')).toBeNull();
        document.body.innerHTML = '';
        mountCard();
        JC.tagPipeline!.scheduleScan?.();
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(document.querySelector('.navigation-projection-secret')).toBeNull();

        await vi.waitFor(() => expect(ajax).toHaveBeenCalledTimes(3));
        expect(urls[2]).toContain('contentEpoch=nav-content-process');
        expect(urls[2]).toContain('contentRevision=1');

        // A second navigation supersedes the first validation. Its gate must not
        // be released by nav A's delayed but otherwise valid r2 response.
        history.pushState({}, '', `/projection-nav-newer-${Date.now()}`);
        document.body.innerHTML = '';
        mountCard();
        JC.tagPipeline!.scheduleScan?.();
        await vi.waitFor(() => expect(ajax).toHaveBeenCalledTimes(4));
        expect(urls[3]).toContain('contentRevision=1');

        const watchedPaints = projectedLabels.filter((label) => label === 'watched-secret').length;
        navigationResolvers[0]({
            version: 1,
            timestamp: 225,
            contentEpoch: 'nav-content-process',
            contentRevision: 2,
            items: {},
            projectionUserId: userA,
            projectionEpoch: 'nav-process',
            projectionRevision: 2,
            projectionIds: [],
            projectionReset: false,
        });
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(projectedLabels.filter((label) => label === 'watched-secret')).toHaveLength(watchedPaints);
        expect(document.querySelector('.navigation-projection-secret')).toBeNull();

        navigationResolvers[1]({
            version: 1,
            timestamp: 250,
            contentEpoch: 'nav-content-process',
            contentRevision: 3,
            items: { [itemId]: { label: 'stripped' } },
            projectionUserId: userA,
            projectionEpoch: 'nav-process',
            projectionRevision: 3,
            projectionIds: [itemId],
            projectionReset: false,
        });
        await vi.waitFor(() => expect(projectedLabels).toContain('stripped'));
        expect(document.querySelector('.navigation-projection-secret')).toBeNull();

        ajax.mockRestore();
        currentUser.mockRestore();
        JC.core.ui = oldUi;
        JC.pluginConfig = oldConfig;
        document.body.innerHTML = '';
    });

    it('does not destroy batch caches for watched events when Spoiler Guard is off', async () => {
        const itemId = '77777777777777777777777777777777';
        const oldConfig = JC.pluginConfig;
        JC.pluginConfig = {
            ...oldConfig,
            TagCacheServerMode: false,
            SpoilerBlurEnabled: false,
        };
        const currentUser = vi.spyOn(ApiClient, 'getCurrentUserId').mockReturnValue(userA);
        const ajax = vi.spyOn(ApiClient, 'ajax');

        await JC.tagPipeline!.refreshServerProjection!({
            UserId: userA,
            UserDataList: [{ ItemId: itemId }],
        });

        expect(ajax).not.toHaveBeenCalled();
        ajax.mockRestore();
        currentUser.mockRestore();
        JC.pluginConfig = oldConfig;
    });

    it('keeps batch-mode privacy ids blank when tag-data fails instead of replaying caches', async () => {
        document.body.innerHTML = '';
        const itemId = '44444444444444444444444444444444';
        const oldConfig = JC.pluginConfig;
        JC.pluginConfig = {
            ...oldConfig,
            TagCacheServerMode: false,
            SpoilerBlurEnabled: true,
        };
        const currentUser = vi.spyOn(ApiClient, 'getCurrentUserId').mockReturnValue(userA);
        const getItem = vi.spyOn(ApiClient, 'getItem');
        const ajax = vi.spyOn(ApiClient, 'ajax').mockRejectedValue(new Error('tag-data unavailable'));
        const renderFromCache = vi.fn((target: HTMLElement) => {
            const secret = document.createElement('div');
            secret.className = 'batch-cache-secret';
            target.appendChild(secret);
            return true;
        });

        JC.tagPipeline!.registerRenderer('batch-projection-test', {
            render: () => undefined,
            isEnabled: () => true,
            renderFromCache,
            invalidateCard: (target: HTMLElement) => {
                target.querySelector('.batch-cache-secret')?.remove();
            },
        });

        const image = gridCardImage();
        const card = image.closest<HTMLElement>('.card')!;
        card.dataset.id = itemId;
        card.dataset.type = 'Movie';
        document.body.appendChild(card);

        await JC.tagPipeline!.invalidateServerCache?.();
        await new Promise((resolve) => setTimeout(resolve, 250));

        expect(ajax).toHaveBeenCalled();
        expect(renderFromCache).not.toHaveBeenCalled();
        expect(getItem).not.toHaveBeenCalled();
        expect(document.querySelector('.batch-cache-secret')).toBeNull();

        ajax.mockRestore();
        getItem.mockRestore();
        currentUser.mockRestore();
        JC.pluginConfig = oldConfig;
        document.body.innerHTML = '';
    });

    it('never paints a delayed batch response onto a recycled card element', async () => {
        document.body.innerHTML = '';
        const itemA = '55555555555555555555555555555555';
        const itemB = '66666666666666666666666666666666';
        const oldConfig = JC.pluginConfig;
        JC.pluginConfig = {
            ...oldConfig,
            TagCacheServerMode: false,
            SpoilerBlurEnabled: true,
        };
        const currentUser = vi.spyOn(ApiClient, 'getCurrentUserId').mockReturnValue(userA);
        const resolvers: Array<(value: unknown) => void> = [];
        const ajax = vi.spyOn(ApiClient, 'ajax').mockImplementation(
            () => new Promise((resolve) => { resolvers.push(resolve); }),
        );

        JC.tagPipeline!.registerRenderer('recycled-projection-test', {
            isEnabled: () => true,
            render: (target: HTMLElement, rawItem: unknown) => {
                const item = rawItem as { Id: string };
                const marker = document.createElement('div');
                marker.className = `recycled-item-${normalizeProjectionKey(item.Id)}`;
                target.appendChild(marker);
            },
            invalidateCard: (target: HTMLElement) => {
                target.querySelectorAll('[class^="recycled-item-"]').forEach((node) => node.remove());
            },
        });

        const image = gridCardImage();
        const card = image.closest<HTMLElement>('.card')!;
        card.dataset.id = itemA;
        card.dataset.type = 'Movie';
        document.body.appendChild(card);

        await JC.tagPipeline!.invalidateServerCache?.();
        await vi.waitFor(() => expect(ajax).toHaveBeenCalledTimes(1));

        // Reuse the exact image/target for B while A's POST is still in flight.
        card.dataset.id = itemB;
        JC.tagPipeline!.scheduleScan?.();
        await new Promise((resolve) => setTimeout(resolve, 30));

        resolvers[0]({ Items: [{ Id: itemA, Type: 'Movie' }] });
        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(document.querySelector(`.recycled-item-${itemA}`)).toBeNull();

        await vi.waitFor(() => expect(ajax).toHaveBeenCalledTimes(2));
        resolvers[1]({ Items: [{ Id: itemB, Type: 'Movie' }] });
        await vi.waitFor(() => {
            expect(document.querySelector(`.recycled-item-${itemB}`)).not.toBeNull();
        });

        ajax.mockRestore();
        currentUser.mockRestore();
        JC.pluginConfig = oldConfig;
        document.body.innerHTML = '';
    });

    it('fully resets A, ignores its late cache load, and activates B without duplicate wiring', async () => {
        document.body.innerHTML = '';
        const itemId = '88888888888888888888888888888888';
        const originalIdentity = JC.identity.capture()!;
        const oldConfig = JC.pluginConfig;
        const oldUi = JC.core.ui;
        JC.pluginConfig = { ...oldConfig, TagCacheServerMode: true, SpoilerBlurEnabled: false };
        JC.core.ui = { injectCss: vi.fn() } as unknown as NonNullable<typeof JC.core.ui>;
        JC._tagCachePrefetch = null;

        let activeUser = userA;
        const currentUser = vi.spyOn(ApiClient, 'getCurrentUserId').mockImplementation(() => activeUser);
        let resolveA!: (value: unknown) => void;
        const ajax = vi.spyOn(ApiClient, 'ajax')
            .mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; }))
            .mockResolvedValueOnce({
                version: 1,
                timestamp: 2,
                contentEpoch: 'content-process-b',
                contentRevision: 1,
                items: { [itemId]: { Type: 'Movie', label: 'owner-b' } },
                projectionUserId: userB,
                projectionEpoch: 'process-b',
                projectionRevision: 1,
                projectionIds: [],
                projectionReset: false,
            });

        JC.tagPipeline!.registerRenderer('identity-switch-projection-test', {
            render: () => undefined,
            isEnabled: () => true,
            renderFromServerCache: (target: HTMLElement, entry: unknown) => {
                const marker = document.createElement('span');
                marker.className = `identity-${String((entry as { label?: string }).label)}`;
                target.appendChild(marker);
            },
            invalidateCard: (target: HTMLElement) => {
                target.querySelectorAll('[class^="identity-owner-"]').forEach((node) => node.remove());
            },
        });

        const image = gridCardImage();
        const card = image.closest<HTMLElement>('.card')!;
        card.dataset.id = itemId;
        card.dataset.type = 'Movie';
        const staleHost = document.createElement('div');
        staleHost.className = 'jc-tag-host';
        staleHost.innerHTML = '<span class="identity-owner-a"></span>';
        card.querySelector('.cardScalable')!.appendChild(staleHost);
        document.body.appendChild(card);

        const identityA = JC.identity.transition('server-a', userA, 'tag-pipeline-a')!;
        const activationA = JC.identity.activate(identityA);
        // Activation handlers begin in a promise microtask in the real loader.
        // Prove A's cache read is actually held before accepting B; otherwise B
        // can consume the first mock response and this is not a late-A race.
        await vi.waitFor(() => expect(ajax).toHaveBeenCalledTimes(1));

        activeUser = userB;
        const identityB = JC.identity.transition('server-b', userB, 'tag-pipeline-b')!;
        expect(document.querySelector('.identity-owner-a')).toBeNull();
        const subscriberCount = JC.core.dom!.getBodySubscriberCount();
        await JC.identity.activate(identityB);
        await vi.waitFor(() => expect(document.querySelector('.identity-owner-b')).not.toBeNull());

        JC.tagPipeline!.initialize?.();
        JC.tagPipeline!.initialize?.();
        expect(JC.core.dom!.getBodySubscriberCount()).toBe(subscriberCount);
        expect(ajax).toHaveBeenCalledTimes(2);

        resolveA({
            version: 1,
            timestamp: 1,
            contentEpoch: 'content-process-a',
            contentRevision: 1,
            items: { [itemId]: { Type: 'Movie', label: 'owner-a' } },
            projectionUserId: userA,
            projectionEpoch: 'process-a',
            projectionRevision: 1,
            projectionIds: [],
            projectionReset: false,
        });
        await activationA;
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(document.querySelector('.identity-owner-a')).toBeNull();
        expect(document.querySelector('.identity-owner-b')).not.toBeNull();

        JC.pluginConfig = oldConfig;
        activeUser = originalIdentity.userId;
        const restored = JC.identity.transition(
            originalIdentity.serverId,
            originalIdentity.userId,
            'tag-pipeline-restore',
        );
        if (restored) await JC.identity.activate(restored);
        JC.core.ui = oldUi;
        ajax.mockRestore();
        currentUser.mockRestore();
        document.body.innerHTML = '';
    });
});

describe('revisioned tag-cache content protocol (issue 72)', () => {
    const id = '11111111111111111111111111111111';
    const response = (
        revision: number,
        items: Record<string, unknown> = {},
        removedIds: string[] = [],
        contentReset = false,
    ) => ({ contentEpoch: 'content-process-1', contentRevision: revision, items, removedIds, contentReset });

    it('applies a removal-only delta and advances the cursor with zero upserts', () => {
        const full = applyContentResponse(null, new Map(), response(5, { [id]: { label: 'stale' } }), true);
        const removed = applyContentResponse(full.identity, full.entries, response(6, {}, [id]), false);

        expect(removed.decision).toBe('apply');
        expect(removed.entries.has(id)).toBe(false);
        expect(removed.identity).toEqual({ epoch: 'content-process-1', revision: 6 });
        expect(removed.changedIds).toEqual([id]);
    });

    it('publishes an authoritative full empty snapshot over an old non-empty map', () => {
        const old = new Map([[id, { label: 'stale' }]]);
        const empty = applyContentResponse(null, old, response(9), true);

        expect(empty.decision).toBe('apply');
        expect(empty.entries.size).toBe(0);
        expect(empty.changedIds).toEqual([id]);
        expect(empty.identity?.revision).toBe(9);
    });

    it('is deterministic in both N/N+1 completion orders and never resurrects stale rows', () => {
        const initial = readContentIdentity(response(9))!;
        const n = response(10, { [id]: { label: 'N' } });
        const nPlusOne = response(11, {}, [id]);

        const inOrderN = applyContentResponse(initial, new Map(), n, false);
        const inOrderNPlusOne = applyContentResponse(inOrderN.identity, inOrderN.entries, nPlusOne, false);
        expect(inOrderNPlusOne.entries.has(id)).toBe(false);
        expect(inOrderNPlusOne.identity?.revision).toBe(11);

        const newerFirst = applyContentResponse(initial, new Map(), nPlusOne, false);
        const olderLast = applyContentResponse(newerFirst.identity, newerFirst.entries, n, false);
        expect(olderLast.decision).toBe('ignore');
        expect(olderLast.entries).toBe(newerFirst.entries);
        expect(olderLast.entries.has(id)).toBe(false);
        expect(olderLast.identity?.revision).toBe(11);
    });

    it('requires reset for an epoch change or explicit server journal gap', () => {
        const current = readContentIdentity(response(20));
        expect(decideContentResponse(current, {
            ...response(1),
            contentEpoch: 'content-process-2',
        })).toBe('reset');
        expect(decideContentResponse(current, response(21, {}, [], true))).toBe('reset');
    });
});
