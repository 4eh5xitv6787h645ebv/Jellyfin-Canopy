// #466 findings 1–2 — populated Bookmarks geometry and the offset modal.
//
// The lifecycle-only Bookmarks coverage normally renders an empty store, which
// cannot expose either failure. These cases add revisioned, test-owned records
// for one real item, exercise the real route/modal, and delete only those exact
// records in a finally block.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Locator, Page } from 'playwright/test';
import {
    test,
    expect,
    loginAs,
    assertNoRuntimeErrors,
    USERS,
} from './fixtures/auth';
import {
    api,
    apiRaw,
    authenticate,
    PLUGIN_ID,
    type Session,
} from './fixtures/api';

const VISUAL_REVIEW_DIR = process.env.JC_RESPONSIVE_VISUAL_REVIEW_DIR?.replace(/\/+$/, '');
const CONFIG_PATH = `/Plugins/${PLUGIN_ID}/Configuration`;
const LONG_ITEM_NAME =
    'The Extraordinary Adventures of the Last Bookmark Keeper Beyond the Known Galaxy';

type Layout = 'modern' | 'legacy';

const LAYOUTS: ReadonlyArray<{
    layout: Layout;
    seed: 'modern' | 'mobile-legacy';
}> = [
    { layout: 'modern', seed: 'modern' },
    { layout: 'legacy', seed: 'mobile-legacy' },
];

const LAYOUT_STAMP: Record<Layout, string> = {
    modern: 'jc-modern-layout',
    legacy: 'jc-legacy-layout',
};

interface BookmarkItem {
    ItemId: string;
    ItemType?: string;
    MediaType?: string;
    Name?: string;
    Timestamp: number;
    Label?: string;
    SyncedFrom?: string;
}

interface BookmarkState {
    Revision: number;
    Bookmarks: Record<string, BookmarkItem>;
}

interface JellyfinItem {
    Id: string;
    Name?: string;
    Type?: string;
}

interface ItemsResponse {
    Items?: JellyfinItem[];
}

interface BookmarkFixture {
    ids: string[];
    labelPrefix: string;
}

async function writePluginConfig(
    baseURL: string,
    session: Session,
    config: Record<string, unknown>
): Promise<void> {
    await api(baseURL, CONFIG_PATH, session.token, {
        method: 'POST',
        body: JSON.stringify(config),
    });
}

async function readBookmarkState(baseURL: string, session: Session): Promise<BookmarkState> {
    const response = await apiRaw(
        baseURL,
        `/JellyfinCanopy/user-settings/${encodeURIComponent(session.userId)}/bookmark.json`,
        session.token
    );
    expect(response.status, 'bookmark fixture GET status').toBe(200);
    return (await response.json()) as BookmarkState;
}

async function bookmarkBatch(
    baseURL: string,
    session: Session,
    revision: number,
    operations: Array<Record<string, unknown>>
): Promise<Response> {
    return apiRaw(
        baseURL,
        `/JellyfinCanopy/user-settings/${encodeURIComponent(session.userId)}/bookmark.json/batch`,
        session.token,
        {
            method: 'POST',
            body: JSON.stringify({ Revision: revision, Operations: operations }),
        }
    );
}

async function addBookmarkFixture(
    baseURL: string,
    session: Session,
    item: JellyfinItem,
    count: number,
    synced: boolean
): Promise<BookmarkFixture> {
    const nonce = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const labelPrefix = `JC responsive ${nonce}`;
    const ids = Array.from({ length: count }, (_, index) => `bm_responsive_${nonce}_${index}`);
    const operations = ids.map((id, index) => ({
        Type: 'add',
        BookmarkId: id,
        Bookmark: {
            ItemId: item.Id,
            ItemType: item.Type || 'Movie',
            MediaType: 'movie',
            Name: LONG_ITEM_NAME,
            Timestamp: 60 + (index * 15),
            Label: `${labelPrefix} ${index + 1}`,
            SyncedFrom: synced ? `JC synthetic source ${index + 1}` : '',
        },
    }));

    for (let attempt = 0; attempt < 6; attempt++) {
        const current = await readBookmarkState(baseURL, session);
        const response = await bookmarkBatch(baseURL, session, current.Revision, operations);
        if (response.status === 200) return { ids, labelPrefix };
        if (response.status !== 409) {
            throw new Error(`bookmark fixture add -> ${response.status}`);
        }
    }
    throw new Error('bookmark fixture add could not acquire a stable revision');
}

async function removeBookmarkFixture(
    baseURL: string,
    session: Session,
    ids: readonly string[]
): Promise<void> {
    for (let attempt = 0; attempt < 6; attempt++) {
        const current = await readBookmarkState(baseURL, session);
        const operations = ids
            .filter((id) => Object.hasOwn(current.Bookmarks, id))
            .map((id) => ({ Type: 'delete', BookmarkId: id }));
        if (operations.length === 0) return;
        const response = await bookmarkBatch(baseURL, session, current.Revision, operations);
        if (response.status === 200) return;
        if (response.status !== 409) {
            throw new Error(`bookmark fixture cleanup -> ${response.status}`);
        }
    }
    throw new Error('bookmark fixture cleanup could not acquire a stable revision');
}

async function seedLayout(page: Page, seed: string): Promise<void> {
    await page.addInitScript((value) => localStorage.setItem('layout', value), seed);
}

async function expectExactLayout(page: Page, layout: Layout): Promise<void> {
    const wanted = LAYOUT_STAMP[layout];
    const other = LAYOUT_STAMP[layout === 'modern' ? 'legacy' : 'modern'];
    await page.waitForFunction(
        (stamp) => document.documentElement.classList.contains(stamp),
        wanted,
        { timeout: 20_000 }
    );
    expect(await page.locator('html').evaluate(
        (root, stamps) => ({
            wanted: root.classList.contains(stamps.wanted),
            other: root.classList.contains(stamps.other),
        }),
        { wanted, other }
    )).toEqual({ wanted: true, other: false });
}

async function capture(target: Locator, fileName: string): Promise<void> {
    if (!VISUAL_REVIEW_DIR) return;
    await mkdir(VISUAL_REVIEW_DIR, { recursive: true });
    await target.screenshot({
        path: join(VISUAL_REVIEW_DIR, fileName),
        animations: 'disabled',
    });
}

async function openBookmarks(page: Page, labelPrefix: string): Promise<Locator> {
    await page.evaluate(() => {
        (window as any).JellyfinCanopy.bookmarksPage.showPage();
    });
    const wrapper = page.locator('#jc-bookmarks-container .jc-bookmarks-wrapper');
    await expect(wrapper).toBeVisible({ timeout: 30_000 });
    await expect(
        page.locator('.jc-bookmark-item').filter({ hasText: labelPrefix }).first()
    ).toBeVisible({ timeout: 30_000 });
    return wrapper;
}

async function expectPopulatedPageContained(page: Page): Promise<void> {
    const proof = await page.evaluate(() => {
        const selectors = [
            '#jc-bookmarks-container',
            '.jc-bookmarks-wrapper',
            '.bookmarks-container',
            '.jc-bookmarks-grid',
            '.jc-bookmark-actions-footer',
        ];
        const roots = selectors.map((selector) => {
            const element = document.querySelector<HTMLElement>(selector)!;
            const rect = element.getBoundingClientRect();
            return {
                selector,
                clientWidth: element.clientWidth,
                scrollWidth: element.scrollWidth,
                left: rect.left,
                right: rect.right,
            };
        });
        const footer = document.querySelector<HTMLElement>('.jc-bookmark-actions-footer')!;
        const footerRect = footer.getBoundingClientRect();
        const escapedButtons = [...footer.querySelectorAll<HTMLElement>('.jc-btn-footer')]
            .map((button) => {
                const rect = button.getBoundingClientRect();
                return {
                    left: rect.left,
                    right: rect.right,
                    scrollWidth: button.scrollWidth,
                    clientWidth: button.clientWidth,
                };
            })
            .filter((button) =>
                button.left < footerRect.left - 1
                || button.right > footerRect.right + 1
                || button.scrollWidth > button.clientWidth + 1);
        const escapedCards = [...document.querySelectorAll<HTMLElement>('.jc-bookmark-item')]
            .map((card) => {
                const rect = card.getBoundingClientRect();
                return {
                    left: rect.left,
                    right: rect.right,
                    scrollWidth: card.scrollWidth,
                    clientWidth: card.clientWidth,
                };
            })
            .filter((card) =>
                card.left < -1
                || card.right > window.innerWidth + 1
                || card.scrollWidth > card.clientWidth + 1);
        const phoneRows = [...document.querySelectorAll<HTMLElement>('.jc-bookmark-main')]
            .map((row) => {
                const info = row.querySelector<HTMLElement>('.jc-bookmark-info')!;
                const label = row.querySelector<HTMLElement>('.jc-bookmark-label')!;
                const actions = row.querySelector<HTMLElement>('.jc-bookmark-actions')!;
                const infoRect = info.getBoundingClientRect();
                const labelRect = label.getBoundingClientRect();
                const actionsRect = actions.getBoundingClientRect();
                return {
                    labelWidth: labelRect.width,
                    actionsBelowInfo: actionsRect.top >= infoRect.bottom - 1,
                };
            });
        return {
            documentOverflow:
                document.scrollingElement!.scrollWidth - window.innerWidth,
            roots,
            escapedButtons,
            escapedCards,
            phoneRows,
        };
    });

    expect(proof.documentOverflow, 'Bookmarks document horizontal overflow').toBeLessThanOrEqual(1);
    for (const root of proof.roots) {
        expect(
            root.scrollWidth - root.clientWidth,
            `${root.selector} internal horizontal overflow`
        ).toBeLessThanOrEqual(1);
        expect(root.left, `${root.selector} left viewport edge`).toBeGreaterThanOrEqual(-1);
        expect(root.right, `${root.selector} right viewport edge`).toBeLessThanOrEqual(
            (await page.viewportSize())!.width + 1
        );
    }
    expect(proof.escapedButtons, 'every footer button stays inside the wrapped footer').toEqual([]);
    expect(proof.escapedCards, 'every populated bookmark card stays inside the viewport').toEqual([]);
    expect(proof.phoneRows.length, 'populated bookmark rows are rendered').toBeGreaterThan(0);
    for (const [index, row] of proof.phoneRows.entries()) {
        expect(
            row.labelWidth,
            `bookmark row ${index + 1} keeps a readable title column`
        ).toBeGreaterThanOrEqual(160);
        expect(
            row.actionsBelowInfo,
            `bookmark row ${index + 1} puts actions below the title on phones`
        ).toBe(true);
    }
}

test.describe.serial('Bookmarks responsive containment (#466 findings 1–2)', () => {
    let admin: Session;
    let originalConfig: Record<string, unknown>;
    let movie: JellyfinItem;

    test.beforeAll(async ({ baseURL }) => {
        admin = await authenticate(baseURL!, USERS.admin.username, USERS.admin.password);
        const config = await api<Record<string, unknown>>(
            baseURL!,
            CONFIG_PATH,
            admin.token
        );
        expect(config, 'plugin configuration is readable').toBeTruthy();
        originalConfig = config!;
        await writePluginConfig(baseURL!, admin, {
            ...originalConfig,
            BookmarksEnabled: true,
            LayoutEnforcement: 'None',
        });

        const items = await api<ItemsResponse>(
            baseURL!,
            `/Users/${encodeURIComponent(admin.userId)}/Items`
                + '?IncludeItemTypes=Movie&Recursive=true&Limit=1&Fields=ProviderIds',
            admin.token
        );
        movie = items?.Items?.[0] as JellyfinItem;
        expect(movie?.Id, 'hermetic server exposes a Movie for the bookmark fixture').toBeTruthy();
    });

    test.afterAll(async ({ baseURL }) => {
        if (admin && originalConfig) {
            await writePluginConfig(baseURL!, admin, originalConfig);
        }
    });

    for (const testCase of LAYOUTS) {
        test(`${testCase.layout}: populated Bookmarks grid and footer fit 320px and 360px`, async ({
            page,
            consoleErrors,
            baseURL,
        }) => {
            const fixture = await addBookmarkFixture(baseURL!, admin, movie, 1, false);
            try {
                await page.setViewportSize({ width: 320, height: 568 });
                await seedLayout(page, testCase.seed);
                await loginAs(page, 'admin', consoleErrors);
                await expectExactLayout(page, testCase.layout);

                const wrapper = await openBookmarks(page, fixture.labelPrefix);
                const fixtureCard = page.locator('.jc-bookmark-item')
                    .filter({ hasText: fixture.labelPrefix })
                    .first();
                await expect(fixtureCard.locator('.jc-bookmark-item-title')).toHaveText(
                    LONG_ITEM_NAME
                );
                await expect(fixtureCard.locator('.jc-bookmark-item-meta')).toContainText(
                    /1\s+bookmark/i
                );
                for (const viewport of [
                    { width: 320, height: 568 },
                    { width: 360, height: 800 },
                ]) {
                    await page.setViewportSize(viewport);
                    await page.evaluate(() => new Promise<void>((resolve) => {
                        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
                    }));
                    await expectPopulatedPageContained(page);
                    await capture(
                        wrapper,
                        `fixed-bookmarks-${testCase.layout}`
                            + `-${viewport.width}x${viewport.height}.png`
                    );
                }
                assertNoRuntimeErrors(consoleErrors);
            } finally {
                await removeBookmarkFixture(baseURL!, admin, fixture.ids);
            }
        });

        test(`${testCase.layout}: Bookmark offset modal keeps close and actions reachable at 320x568`, async ({
            page,
            consoleErrors,
            baseURL,
        }) => {
            // Several records guarantee the affected-items list reaches its cap,
            // so the outer dialog must own real vertical overflow.
            const fixture = await addBookmarkFixture(baseURL!, admin, movie, 8, true);
            try {
                await page.setViewportSize({ width: 320, height: 568 });
                await seedLayout(page, testCase.seed);
                await loginAs(page, 'admin', consoleErrors);
                await expectExactLayout(page, testCase.layout);
                await openBookmarks(page, fixture.labelPrefix);

                const card = page.locator('.jc-bookmark-item')
                    .filter({ hasText: fixture.labelPrefix })
                    .first();
                await card.locator('.btnAdjustOffset').click();
                const overlay = page.locator('.jc-bm-library-modal-overlay');
                const modal = overlay.locator('.jc-bm-library-modal-container');
                const close = modal.locator('.jc-bm-library-modal-close');
                const apply = modal.locator('.btnApplyOffset');
                await expect(modal).toBeVisible();
                await expect(close).toBeVisible();

                const initial = await modal.evaluate((element) => {
                    const rect = element.getBoundingClientRect();
                    const closeRect = element.querySelector<HTMLElement>(
                        '.jc-bm-library-modal-close'
                    )!.getBoundingClientRect();
                    const style = getComputedStyle(element);
                    return {
                        top: rect.top,
                        bottom: rect.bottom,
                        left: rect.left,
                        right: rect.right,
                        clientHeight: element.clientHeight,
                        scrollHeight: element.scrollHeight,
                        overflowY: style.overflowY,
                        closeTop: closeRect.top,
                        closeBottom: closeRect.bottom,
                        closeLeft: closeRect.left,
                        closeRight: closeRect.right,
                    };
                });
                expect(initial.top, 'dialog top is visible').toBeGreaterThanOrEqual(-1);
                expect(initial.bottom, 'dialog bottom is visible').toBeLessThanOrEqual(569);
                expect(initial.left, 'dialog left is visible').toBeGreaterThanOrEqual(-1);
                expect(initial.right, 'dialog right is visible').toBeLessThanOrEqual(321);
                expect(initial.closeTop, 'close control top is visible').toBeGreaterThanOrEqual(-1);
                expect(initial.closeBottom, 'close control bottom is visible').toBeLessThanOrEqual(569);
                expect(initial.closeLeft, 'close control left is visible').toBeGreaterThanOrEqual(-1);
                expect(initial.closeRight, 'close control right is visible').toBeLessThanOrEqual(321);
                expect(initial.scrollHeight, 'fixture produces a genuinely scrollable dialog')
                    .toBeGreaterThan(initial.clientHeight);
                expect(initial.overflowY).toBe('auto');

                await capture(
                    modal,
                    `fixed-bookmark-offset-${testCase.layout}-320x568-top.png`
                );

                await apply.scrollIntoViewIfNeeded();
                await expect(apply).toBeVisible();
                const scrolled = await modal.evaluate((element) => {
                    const rect = element.getBoundingClientRect();
                    const actions = element.querySelector<HTMLElement>(
                        '.jc-bookmark-modal-actions'
                    )!.getBoundingClientRect();
                    return {
                        scrollTop: element.scrollTop,
                        actionsTop: actions.top,
                        actionsBottom: actions.bottom,
                        modalTop: rect.top,
                        modalBottom: rect.bottom,
                    };
                });
                expect(scrolled.scrollTop, 'actions are reached through the dialog scroller')
                    .toBeGreaterThan(0);
                expect(scrolled.actionsTop).toBeGreaterThanOrEqual(scrolled.modalTop - 1);
                expect(scrolled.actionsBottom).toBeLessThanOrEqual(scrolled.modalBottom + 1);

                await capture(
                    modal,
                    `fixed-bookmark-offset-${testCase.layout}-320x568-actions.png`
                );

                await modal.locator('.jc-bookmark-btn-cancel').click();
                await expect(overlay).toBeHidden();
                assertNoRuntimeErrors(consoleErrors);
            } finally {
                await removeBookmarkFixture(baseURL!, admin, fixture.ids);
            }
        });
    }
});
