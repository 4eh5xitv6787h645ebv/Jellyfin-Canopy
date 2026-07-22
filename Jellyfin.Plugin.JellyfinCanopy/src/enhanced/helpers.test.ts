// Unit tests for src/enhanced/helpers.ts — the per-navigation cache in
// getHeaderRightContainer (PERF(R4) fix: offsetParent is a forced layout read and
// used to be re-read on every observer tick; it must now be read at most once
// per navigation).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
// Importing ui-kit populates JC.core.ui (real injectCss → appends a <style> to
// document.head). getHeaderRightContainer now installs the shared header-tray
// stylesheet via addCSS → JC.core.ui.injectCss on every resolution, so the real
// sink must be present for these tests.
import '../core/ui-kit';
import {
    clearItemCache, getHeaderRightContainer, getItemCached,
    resetHeaderTrayCSSForTests,
    ITEM_CACHE_MAX_ENTRIES, ITEM_CACHE_MAX_IN_FLIGHT,
} from './helpers';
import { insertHeaderTrayButton, HeaderTrayOrder } from './header-tray';
import { resetLayoutCacheForTests } from '../core/layout';

/** Builds a `.headerRight` whose offsetParent getter counts layout reads. */
function buildLegacyHeader(reads: { count: number }): HTMLElement {
    const header = document.createElement('div');
    header.className = 'headerRight';
    Object.defineProperty(header, 'offsetParent', {
        get: () => {
            reads.count++;
            return document.body; // visible
        }
    });
    return header;
}

describe('getHeaderRightContainer per-navigation cache', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('reads offsetParent at most once per navigation, not per call', () => {
        const reads = { count: 0 };
        const header = buildLegacyHeader(reads);
        document.body.appendChild(header);

        expect(getHeaderRightContainer()).toBe(header);
        expect(getHeaderRightContainer()).toBe(header);
        expect(getHeaderRightContainer()).toBe(header);
        expect(reads.count).toBe(1);

        // Navigation invalidates the cache → exactly one more layout read.
        history.pushState({}, '', '/test-header-cache-nav');
        expect(getHeaderRightContainer()).toBe(header);
        expect(getHeaderRightContainer()).toBe(header);
        expect(reads.count).toBe(2);
    });

    it('re-resolves when the cached container is detached (header remount)', () => {
        const readsA = { count: 0 };
        const headerA = buildLegacyHeader(readsA);
        document.body.appendChild(headerA);
        expect(getHeaderRightContainer()).toBe(headerA);

        // Host rebuilds the header without a navigation.
        headerA.remove();
        const readsB = { count: 0 };
        const headerB = buildLegacyHeader(readsB);
        document.body.appendChild(headerB);

        expect(getHeaderRightContainer()).toBe(headerB);
    });

    it('does not cache a failed resolution (early-boot retries still work)', () => {
        expect(getHeaderRightContainer()).toBeNull();

        const reads = { count: 0 };
        const header = buildLegacyHeader(reads);
        document.body.appendChild(header);

        // Found on the next probe without requiring a navigation in between.
        expect(getHeaderRightContainer()).toBe(header);
    });
});

// #459: the header button tray must stay a single horizontally-scrollable row
// (never wrap to 2–3 rows) on both layouts, with the modern profile avatar
// pinned. The fix lives at the shared resolver: an idempotent, layout-scoped
// stylesheet plus a `jc-header-tray` marker on every resolved container.
describe('header-tray single-row scroll containment (#459)', () => {
    const STYLE_ID = 'jc-mui-header-button-fix';
    const trayCss = (): string => document.getElementById(STYLE_ID)?.textContent ?? '';

    beforeEach(() => {
        document.body.innerHTML = '';
        document.documentElement.classList.remove('jc-modern-layout', 'jc-legacy-layout');
        // Layout is cached once per page in production; reset it so each test's
        // resolver stamps from a clean slate (and never leaks into the R4 block).
        resetLayoutCacheForTests();
        // The stylesheet-install guard is module-private and set true by the
        // earlier R4 describe block (which resolves a container). Clear it AND
        // remove the injected <style> so each #459 test's resolver genuinely
        // (re)installs the sheet on the path under test, instead of asserting
        // against lingering head state that would pass even if the install call
        // were moved to an unreachable spot.
        resetHeaderTrayCSSForTests();
        // Force a fresh nav so the per-navigation container cache never serves a
        // node from a previous test.
        history.pushState({}, '', `/tray-459-${Math.random().toString(36).slice(2)}`);
    });

    afterEach(() => {
        resetLayoutCacheForTests();
        document.documentElement.classList.remove('jc-modern-layout', 'jc-legacy-layout');
    });

    /** A visible legacy `.headerRight` (offsetParent !== null). */
    function buildLegacy(): HTMLElement {
        const header = document.createElement('div');
        header.className = 'headerRight';
        Object.defineProperty(header, 'offsetParent', { configurable: true, get: () => document.body });
        document.body.appendChild(header);
        return header;
    }

    /** A modern MUI toolbar: [action tray][profile Box(user-menu button)]. */
    function buildModern(): { toolbar: HTMLElement; tray: HTMLElement; profileBox: HTMLElement } {
        const appbar = document.createElement('div');
        appbar.className = 'MuiAppBar-root';
        const toolbar = document.createElement('div');
        toolbar.className = 'MuiToolbar-root';
        appbar.appendChild(toolbar);

        const tray = document.createElement('div');
        tray.className = 'jc-test-action-tray';
        toolbar.appendChild(tray);

        const profileBox = document.createElement('div');
        profileBox.className = 'jc-test-profile-box';
        const userMenuButton = document.createElement('button');
        userMenuButton.setAttribute('aria-controls', 'app-user-menu');
        profileBox.appendChild(userMenuButton);
        toolbar.appendChild(profileBox);

        document.body.appendChild(appbar);
        return { toolbar, tray, profileBox };
    }

    it('installs the tray stylesheet on the legacy-first path and marks the legacy tray', () => {
        const header = buildLegacy();

        // Guard reset in beforeEach removed any lingering sheet, so this proves
        // the legacy path itself installs it (would catch the sheet install being
        // moved after the legacy early return).
        expect(document.querySelectorAll(`#${STYLE_ID}`).length).toBe(0);
        expect(getHeaderRightContainer()).toBe(header);
        // Installed despite the legacy early return (legacy-only sessions must
        // still get the fix).
        expect(document.querySelectorAll(`#${STYLE_ID}`).length).toBe(1);
        expect(header.classList.contains('jc-header-tray')).toBe(true);
        // Resolving the visible legacy header stamps jc-legacy-layout on <html>
        // so the layout-scoped tray CSS actually applies (no reliance on a later
        // navigation to stamp it).
        expect(document.documentElement.classList.contains('jc-legacy-layout')).toBe(true);
        expect(document.documentElement.classList.contains('jc-modern-layout')).toBe(false);

        // Repeated cached calls leave exactly one style element and re-marking
        // is idempotent (single class token).
        getHeaderRightContainer();
        getHeaderRightContainer();
        expect(document.querySelectorAll(`#${STYLE_ID}`).length).toBe(1);
        expect(header.className.split(/\s+/).filter((c) => c === 'jc-header-tray').length).toBe(1);
    });

    it('scopes every tray rule to a layout stamp with nowrap + horizontal scroll + containment', () => {
        buildLegacy();
        getHeaderRightContainer();
        const css = trayCss();

        expect(css).toContain('.jc-modern-layout .jc-header-tray');
        expect(css).toContain('.jc-legacy-layout .jc-header-tray');
        expect(css).toContain('flex-wrap: nowrap');
        expect(css).toContain('overflow-x: auto');
        expect(css).toContain('min-width: 0');
        // Direct children never shrink → they cannot collapse or wrap.
        expect(css).toContain('flex: 0 0 auto');
        // Legacy: the native .headerRight is content-sized with justify-content:
        // flex-end; override to flex-start so overflowing leading buttons pack from
        // the scroll origin and stay reachable. In the fit case .headerRight has no
        // free space (no flex-grow), so flex-start is pixel-identical to native
        // flex-end — no reposition on sheet load, no R1 jank.
        expect(css).toMatch(/\.jc-legacy-layout \.jc-header-tray\s*\{[^}]*justify-content:\s*flex-start/);
        // No dependency on the safe/unsafe overflow-alignment keyword (r7f2/r7f7):
        // an engine that does not parse `safe flex-end` would keep native flex-end
        // and strand the leading buttons in unreachable negative overflow, so it
        // must NOT be what ships on either layout.
        expect(css).not.toContain('safe flex-end');
        // Modern-only: the tray must carry a 0 flex-basis (not merely
        // flex-shrink:1). The parent MUI Toolbar is flex-wrap:wrap and collects
        // flex lines from each child's hypothetical main size BEFORE flex-shrink
        // resolves; an `auto`/content basis makes the tray claim a full line and
        // pushes the sibling profile avatar onto a 2nd row (#459, worst at 390px).
        // `flex: 1 1 0` (basis 0 + min-width:0) lets the tray collapse during line
        // collection so the avatar stays on the row, then grow to fill the space
        // left of it. Legacy .headerRight shrinks by default and needs no override.
        expect(css).toMatch(/\.jc-modern-layout \.jc-header-tray\s*\{[^}]*flex:\s*1\s+1\s+0/);
        // Regression guard: the bare flex-shrink:1 form was insufficient (it does
        // not affect flex-line construction), so it must NOT be what ships.
        expect(css).not.toContain('flex-shrink: 1');
        // Modern-only: because the grown (flex:1 1 0) tray is wider than its content
        // in the fit case, the buttons are right-aligned against the avatar with an
        // auto inline-start margin on the VISUALLY-LEADING child — not justify-content.
        // Auto margins are universal (no safe/unsafe keyword) and resolve to 0 on
        // overflow, so leading buttons stay reachable on every engine. The
        // visually-leading child is NOT always the DOM :first-child: native-tabs.ts
        // appends #jc-native-tabs-group as the DOM-last child but with order:-1, so
        // when it exists it renders first. The margin therefore goes on the group when
        // present, and on the DOM :first-child only when the group is absent
        // (:not(:has(...))) — never both, which would split the free space and strand
        // the reordered group at the tray's left edge (a visible split, not the native
        // contiguous tray).
        expect(css).toMatch(
            /\.jc-modern-layout \.jc-header-tray > #jc-native-tabs-group\s*\{[^}]*margin-inline-start:\s*auto/,
        );
        expect(css).toMatch(
            /\.jc-modern-layout \.jc-header-tray:not\(:has\(> #jc-native-tabs-group\)\) > \*:first-child\s*\{[^}]*margin-inline-start:\s*auto/,
        );
        // Regression guard for the reordered-group split: the bare `> *:first-child`
        // form (margin on the DOM first child regardless of the order:-1 group) must
        // NOT be what ships — it stranded the native-tabs group at the tray's left
        // edge whenever the group was present and the row fit.
        expect(css).not.toMatch(
            /\.jc-modern-layout \.jc-header-tray > \*:first-child\s*\{/,
        );

        // The horizontal scrollbar is suppressed on BOTH engines so an
        // overflowing tray never grows a gutter that would (a) render a
        // non-native OS scrollbar, (b) shrink the content box below the button
        // height and let the promoted overflow-y clip the .jc-as-sup badge, or
        // (c) shift the header as it crosses the fit->overflow threshold (R1).
        expect(css).toContain('scrollbar-width: none');
        expect(css).toMatch(/\.jc-(modern|legacy)-layout \.jc-header-tray::-webkit-scrollbar/);
        // Legacy only: the native profile button (.headerUserButton) lives INSIDE
        // the resolved .headerRight scrollport (unlike modern, where the avatar is a
        // separate sibling Box outside the tray), so it is sticky-pinned to the
        // scrollport's inline-end edge — visible at rest and stationary while the
        // icon buttons scroll under it (the binding pinned-avatar criterion,
        // r9f2/r9f7/r9f11). In the fit case .headerRight is content-sized (no
        // overflow), so sticky is inert and the avatar sits at its native right-edge
        // position — no R1 shift. The rule is legacy-scoped and z-indexed above the
        // scrolling buttons.
        expect(css).toMatch(
            /\.jc-legacy-layout \.jc-header-tray > \.headerUserButton\s*\{[^}]*position:\s*sticky/,
        );
        expect(css).toMatch(
            /\.jc-legacy-layout \.jc-header-tray > \.headerUserButton\s*\{[^}]*inset-inline-end:\s*0/,
        );
        // The pin is legacy-only — no .headerUserButton rule leaks onto modern (where
        // the avatar is already outside the tray and needs no pin).
        expect(css).not.toMatch(/\.jc-modern-layout \.jc-header-tray[^{]*\.headerUserButton/);

        // No broad MUI Box selector (would hit unrelated toolbar boxes / profile).
        expect(css).not.toMatch(/\.MuiBox-root/);
        // The scroll container is the tray itself — exactly one overflow-x:auto
        // declaration and no overflow-y (which would clip the .jc-as-sup badge).
        expect(css).not.toMatch(/overflow-y\s*:/);
        expect((css.match(/overflow-x\s*:/g) ?? []).length).toBe(1);
        // Every `.jc-header-tray` selector is layout-stamped — no bare occurrence
        // that would leak the rules onto an unresolved/unstamped session.
        for (const line of css.split('\n')) {
            if (line.includes('.jc-header-tray') && !line.trim().startsWith('.jc-header-tray >')) {
                expect(line).toMatch(/\.jc-(modern|legacy)-layout \.jc-header-tray/);
            }
        }
    });

    it('modern auto-margin selectors target the visually-leading child, not the DOM first child, when the native-tabs order:-1 group is present', () => {
        // native-tabs.ts appends #jc-native-tabs-group as the DOM-LAST child but with
        // order:-1, so it renders FIRST. The fit-case right-align margin must land on
        // that reordered group, never on the DOM :first-child — otherwise the group is
        // stranded alone at the tray's left edge with a gap to the right-packed buttons
        // (r8f2/r8f4-r8f8/r8f10). Prove the shipped selectors resolve to the right node
        // for both group-present and group-absent states.
        document.documentElement.classList.add('jc-modern-layout');
        const tray = document.createElement('div');
        tray.className = 'jc-header-tray';
        const leadingButton = document.createElement('button');
        leadingButton.id = 'dom-first-action';
        tray.appendChild(leadingButton);
        // Mirror native-tabs.getOrCreateGroup: appended last, order:-1 (visually first).
        const group = document.createElement('div');
        group.id = 'jc-native-tabs-group';
        group.style.cssText = 'display:flex;align-items:center;order:-1;';
        tray.appendChild(group);
        document.body.appendChild(tray);

        const GROUP_RULE = '.jc-modern-layout .jc-header-tray > #jc-native-tabs-group';
        const FIRST_CHILD_RULE =
            '.jc-modern-layout .jc-header-tray:not(:has(> #jc-native-tabs-group)) > *:first-child';

        // Group present: the margin rule selects the reordered group…
        expect(document.querySelector(GROUP_RULE)).toBe(group);
        // …and the DOM-first-child rule selects NOTHING (its :not(:has) gate is false),
        // so the DOM first action never steals the auto margin.
        expect(document.querySelector(FIRST_CHILD_RULE)).toBeNull();

        // Group absent: the DOM first child is the visually-leading one and carries it.
        group.remove();
        expect(document.querySelector(GROUP_RULE)).toBeNull();
        expect(document.querySelector(FIRST_CHILD_RULE)).toBe(leadingButton);
    });

    it('marks only the action tray on modern — the profile Box stays an unmarked sibling', () => {
        const { tray, profileBox } = buildModern();

        expect(getHeaderRightContainer()).toBe(tray);
        expect(tray.classList.contains('jc-header-tray')).toBe(true);
        expect(profileBox.classList.contains('jc-header-tray')).toBe(false);
        // Reaching the MUI toolbar stamps jc-modern-layout (never jc-legacy).
        expect(document.documentElement.classList.contains('jc-modern-layout')).toBe(true);
        expect(document.documentElement.classList.contains('jc-legacy-layout')).toBe(false);
    });

    it('returns null when no header is present yet (retryable, nothing marked)', () => {
        expect(getHeaderRightContainer()).toBeNull();
        expect(document.querySelectorAll('.jc-header-tray').length).toBe(0);
    });

    it('resolves the real action Box (toolbar last child) during preload, never synthesizing a container', () => {
        // Preload window: AppToolbar has rendered its always-present action-tray Box
        // (flexGrow:1) but not yet the user-menu Box (the user has not loaded). The
        // resolver must target that real Box — the toolbar's last child — so Canopy's
        // buttons land in the same tray as the native play/cast buttons, and must
        // NOT append a synthetic `.headerRight` (a second flexGrow sibling would split
        // the row / R1 jank, and the cache would pin the fake Box for the whole page
        // once the real user-menu mounts — r9f3/r9f4/r9f5/r9f6).
        const appbar = document.createElement('div');
        appbar.className = 'MuiAppBar-root';
        const toolbar = document.createElement('div');
        toolbar.className = 'MuiToolbar-root';
        const actionBox = document.createElement('div');
        actionBox.className = 'jc-test-action-box';
        toolbar.appendChild(actionBox);
        appbar.appendChild(toolbar);
        document.body.appendChild(appbar);

        const container = getHeaderRightContainer();
        expect(container).toBe(actionBox);
        expect(container!.classList.contains('jc-header-tray')).toBe(true);
        // No synthetic container was appended to the toolbar.
        expect(toolbar.querySelectorAll(':scope > .headerRight').length).toBe(0);
        expect(toolbar.children.length).toBe(1);
    });

    it('returns null (retryable) when the modern toolbar has no resolvable action Box yet', () => {
        // Earliest render: the toolbar exists but is still empty. Nothing to mark,
        // nothing synthesized — callers retry until the action Box renders.
        const appbar = document.createElement('div');
        appbar.className = 'MuiAppBar-root';
        const toolbar = document.createElement('div');
        toolbar.className = 'MuiToolbar-root';
        appbar.appendChild(toolbar);
        document.body.appendChild(appbar);

        expect(getHeaderRightContainer()).toBeNull();
        expect(document.querySelectorAll('.jc-header-tray').length).toBe(0);
        expect(toolbar.querySelectorAll(':scope > .headerRight').length).toBe(0);
    });

    it('re-resolves and re-marks a remounted tray without leaving a duplicate connected container', () => {
        const first = buildModern();
        expect(getHeaderRightContainer()).toBe(first.tray);

        // Host rebuilds the header without a navigation.
        first.toolbar.closest('.MuiAppBar-root')!.remove();
        const second = buildModern();

        expect(getHeaderRightContainer()).toBe(second.tray);
        expect(second.tray.classList.contains('jc-header-tray')).toBe(true);
        // Only the connected replacement carries the marker in the live document.
        expect(document.querySelectorAll('.jc-header-tray').length).toBe(1);
    });

    it('reads legacy offsetParent at most once per navigation (PERF R4 not regressed)', () => {
        const reads = { count: 0 };
        const header = document.createElement('div');
        header.className = 'headerRight';
        Object.defineProperty(header, 'offsetParent', {
            configurable: true,
            get: () => { reads.count++; return document.body; },
        });
        document.body.appendChild(header);

        getHeaderRightContainer();
        getHeaderRightContainer();
        getHeaderRightContainer();
        expect(reads.count).toBe(1);

        history.pushState({}, '', '/tray-459-perf-nav');
        getHeaderRightContainer();
        getHeaderRightContainer();
        expect(reads.count).toBe(2);
    });
});

describe('privacy reset item-cache invalidation (BI-SEC-035)', () => {
    it('drops only the selected user\'s cached native DTOs', async () => {
        const getItem = vi.spyOn(ApiClient, 'getItem').mockImplementation(
            (userId, itemId) => Promise.resolve({ userId, itemId }),
        );
        const itemId = 'privacy-reset-item';

        await getItemCached(itemId, { userId: 'user-a' });
        await getItemCached(itemId, { userId: 'user-b' });
        expect(getItem).toHaveBeenCalledTimes(2);

        clearItemCache('user-a');
        await getItemCached(itemId, { userId: 'user-a' });
        await getItemCached(itemId, { userId: 'user-b' });

        expect(getItem).toHaveBeenCalledTimes(3);
        getItem.mockRestore();
    });

    it('does not let a retired in-flight DTO overwrite the post-reset value', async () => {
        let resolveStale!: (value: unknown) => void;
        const stale = new Promise<unknown>((resolve) => { resolveStale = resolve; });
        const getItem = vi.spyOn(ApiClient, 'getItem')
            .mockImplementationOnce(() => stale)
            .mockResolvedValueOnce({ projection: 'fresh' });
        const itemId = 'in-flight-privacy-reset';

        const oldRequest = getItemCached(itemId, { userId: 'race-user' });
        clearItemCache('race-user', [itemId]);
        const freshRequest = getItemCached(itemId, { userId: 'race-user' });
        await expect(freshRequest).resolves.toEqual({ projection: 'fresh' });

        resolveStale({ projection: 'stale' });
        await expect(oldRequest).resolves.toEqual({ projection: 'stale' });
        await expect(getItemCached(itemId, { userId: 'race-user' }))
            .resolves.toEqual({ projection: 'fresh' });
        expect(getItem).toHaveBeenCalledTimes(2);
        getItem.mockRestore();
    });

    it('drops a held DTO and refetches when the same user id switches servers', async () => {
        let resolveA!: (value: unknown) => void;
        const heldA = new Promise<unknown>((resolve) => { resolveA = resolve; });
        const getItem = vi.spyOn(ApiClient, 'getItem')
            .mockImplementationOnce(() => heldA)
            .mockResolvedValueOnce({ server: 'b' });

        JC.identity.transition('server-a', 'same-user', 'helpers-server-a');
        const requestA = getItemCached('same-item', { userId: 'same-user' });
        JC.identity.transition('server-b', 'same-user', 'helpers-server-switch');
        resolveA({ server: 'a' });

        await expect(requestA).resolves.toBeNull();
        await expect(getItemCached('same-item', { userId: 'same-user' }))
            .resolves.toEqual({ server: 'b' });
        expect(getItem).toHaveBeenCalledTimes(2);
        getItem.mockRestore();
    });
});

describe('shared item DTO cache bounds', () => {
    beforeEach(() => {
        clearItemCache();
        vi.useFakeTimers();
        vi.setSystemTime(0);
    });

    afterEach(() => {
        clearItemCache();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('drops an expired DTO before publishing its replacement', async () => {
        const getItem = vi.spyOn(ApiClient, 'getItem')
            .mockResolvedValueOnce({ version: 1 })
            .mockResolvedValueOnce({ version: 2 });

        await expect(getItemCached('ttl-item', { userId: 'ttl-user' }))
            .resolves.toEqual({ version: 1 });
        await expect(getItemCached('ttl-item', { userId: 'ttl-user' }))
            .resolves.toEqual({ version: 1 });
        expect(getItem).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(30_001);
        await expect(getItemCached('ttl-item', { userId: 'ttl-user' }))
            .resolves.toEqual({ version: 2 });
        expect(getItem).toHaveBeenCalledTimes(2);
    });

    it('evicts the least-recently-used DTO at one over the hard cap', async () => {
        const getItem = vi.spyOn(ApiClient, 'getItem')
            .mockImplementation((_userId, itemId) => Promise.resolve({ itemId }));

        for (let index = 0; index <= ITEM_CACHE_MAX_ENTRIES; index += 1) {
            await getItemCached(`bounded-${index}`, { userId: 'bounded-user' });
        }
        expect(getItem).toHaveBeenCalledTimes(ITEM_CACHE_MAX_ENTRIES + 1);

        await getItemCached(`bounded-${ITEM_CACHE_MAX_ENTRIES}`, { userId: 'bounded-user' });
        expect(getItem).toHaveBeenCalledTimes(ITEM_CACHE_MAX_ENTRIES + 1);
        await getItemCached('bounded-0', { userId: 'bounded-user' });
        expect(getItem).toHaveBeenCalledTimes(ITEM_CACHE_MAX_ENTRIES + 2);
    });

    it('keeps in-flight deduplication independent from resolved-cache eviction', async () => {
        const resolvers: Array<(value: unknown) => void> = [];
        const getItem = vi.spyOn(ApiClient, 'getItem').mockImplementation(
            (_userId, itemId) => new Promise((resolve) => {
                resolvers.push(() => resolve({ itemId }));
            }),
        );
        const pending = Array.from(
            { length: ITEM_CACHE_MAX_IN_FLIGHT },
            (_, index) => getItemCached(`pending-${index}`, { userId: 'pending-user' }),
        );
        const duplicateOldest = getItemCached('pending-0', { userId: 'pending-user' });

        expect(getItem).toHaveBeenCalledTimes(ITEM_CACHE_MAX_IN_FLIGHT);
        await expect(getItemCached('pending-overflow', { userId: 'pending-user' }))
            .rejects.toThrow(/capacity exceeded/i);
        expect(getItem).toHaveBeenCalledTimes(ITEM_CACHE_MAX_IN_FLIGHT);
        resolvers.forEach((resolve) => resolve({}));
        await Promise.all([...pending, duplicateOldest]);
        expect(getItem).toHaveBeenCalledTimes(ITEM_CACHE_MAX_IN_FLIGHT);
    });
});

// INT-2: independent header-tray injectors (random button, active streams) used
// to each prepend, so the winner of the injection race took the leading slot →
// nondeterministic order. insertHeaderTrayButton keeps them in a stable order.
describe('insertHeaderTrayButton deterministic order (INT-2)', () => {
    function tray(): HTMLElement {
        const t = document.createElement('div');
        t.appendChild(Object.assign(document.createElement('button'), { className: 'native-a' }));
        t.appendChild(Object.assign(document.createElement('button'), { className: 'native-b' }));
        return t;
    }
    const btn = (id: string): HTMLElement => Object.assign(document.createElement('button'), { id });
    const ids = (t: HTMLElement): string[] => Array.from(t.children).map(c => c.id || c.className);

    it('yields the same order regardless of which injector runs first', () => {
        const forward = tray();
        insertHeaderTrayButton(forward, btn('active'), HeaderTrayOrder.activeStreams);
        insertHeaderTrayButton(forward, btn('random'), HeaderTrayOrder.randomButton);

        const reverse = tray();
        insertHeaderTrayButton(reverse, btn('random'), HeaderTrayOrder.randomButton);
        insertHeaderTrayButton(reverse, btn('active'), HeaderTrayOrder.activeStreams);

        expect(ids(forward)).toEqual(['active', 'random', 'native-a', 'native-b']);
        expect(ids(reverse)).toEqual(ids(forward));
    });

    it('keeps JC tray buttons leading, before the native buttons', () => {
        const t = tray();
        insertHeaderTrayButton(t, btn('random'), HeaderTrayOrder.randomButton);
        insertHeaderTrayButton(t, btn('active'), HeaderTrayOrder.activeStreams);
        expect(ids(t)).toEqual(['active', 'random', 'native-a', 'native-b']);
    });

    it('re-inserting an already-present button repositions it without duplicating', () => {
        const t = tray();
        const active = btn('active');
        insertHeaderTrayButton(t, active, HeaderTrayOrder.activeStreams);
        insertHeaderTrayButton(t, active, HeaderTrayOrder.activeStreams); // e.g. an observer re-run
        expect(t.querySelectorAll('#active').length).toBe(1);
        expect(ids(t)).toEqual(['active', 'native-a', 'native-b']);
    });
});
