// #463 — the Request Collection modal renders each movie as a rich, responsive
// card. The required Docker seed owns hermetic Seerr collection 10:
// Fight Club is available/disabled, while a deliberately long Matrix fixture
// and Toy Story are selectable. Drive the booted facade directly so this
// covers the real proxy,
// modal factory, row markup, styles, and native label/checkbox interaction
// without forwarding external integration credentials.
import type { Locator, Page } from 'playwright/test';
import {
    test,
    expect,
    loginAs,
    showRoute,
    assertNoRuntimeErrors,
} from './fixtures/auth';
import {
    POPULAR_MOBILE_DEVICES,
    type PopularMobileDevice,
} from './fixtures/popular-mobile-device-viewports';

/* eslint-disable @typescript-eslint/no-explicit-any */

type Layout = 'modern' | 'legacy';
type ViewportKind = 'mobile' | 'desktop';

const LAYOUT_STAMP: Record<Layout, string> = {
    modern: 'jc-modern-layout',
    legacy: 'jc-legacy-layout',
};

const LONG_COLLECTION_TITLE =
    'The Extraordinary Matrix Collection Chronicle With SupercalifragilisticexpialidociousRevisited';
const VISUAL_REVIEW_DIR = process.env.JC_COLLECTION_VISUAL_REVIEW_DIR?.replace(/\/+$/, '');
const VISUAL_REVIEW_VIEWPORTS = new Set([
    '360x780',
    '375x667',
    '402x681',
    '440x763',
    '480x1040',
    '656x944',
    '800x1280',
    '1024x1366',
]);

interface PopularViewportCoverage {
    key: string;
    viewport: { width: number; height: number };
    devices: PopularMobileDevice[];
}

const POPULAR_VIEWPORTS: ReadonlyArray<PopularViewportCoverage> = Array.from(
    POPULAR_MOBILE_DEVICES.reduce((viewports, device) => {
        const key = `${device.viewport.width}x${device.viewport.height}`;
        const existing = viewports.get(key);
        if (existing) {
            existing.devices.push(device);
        } else {
            viewports.set(key, { key, viewport: device.viewport, devices: [device] });
        }
        return viewports;
    }, new Map<string, PopularViewportCoverage>()).values()
);

const CASES: ReadonlyArray<{
    layout: Layout;
    viewportKind: ViewportKind;
    viewport: { width: number; height: number };
    seed: string;
}> = [
    { layout: 'modern', viewportKind: 'mobile', viewport: { width: 320, height: 568 }, seed: 'modern' },
    { layout: 'modern', viewportKind: 'desktop', viewport: { width: 1280, height: 640 }, seed: 'modern' },
    { layout: 'legacy', viewportKind: 'mobile', viewport: { width: 320, height: 568 }, seed: 'mobile-legacy' },
    { layout: 'legacy', viewportKind: 'desktop', viewport: { width: 1280, height: 640 }, seed: 'desktop-legacy' },
];

interface RowVisual {
    backgroundColor: string;
    borderColor: string;
    boxShadow: string;
    cursor: string;
    opacity: number;
}

async function seedLayout(page: Page, value: string): Promise<void> {
    await page.addInitScript((layout) => localStorage.setItem('layout', layout), value);
}

/** Enter the owning route, call the real facade, and prove collection 10 came from the proxy. */
async function openHermeticCollection(page: Page): Promise<Locator> {
    await showRoute(page, '/search');
    await page.waitForFunction(
        () => typeof (window as any).JellyfinCanopy?.seerrUI?.showCollectionRequestModal === 'function',
        undefined,
        { timeout: 60_000 }
    );

    const [response] = await Promise.all([
        page.waitForResponse((candidate) => {
            const url = new URL(candidate.url());
            return candidate.request().method() === 'GET'
                && url.pathname === '/JellyfinCanopy/seerr/collection/10';
        }),
        page.evaluate(async () => {
            await (window as any).JellyfinCanopy.seerrUI.showCollectionRequestModal(
                10,
                'JC Fixture Collection'
            );
        }),
    ]);
    expect(response.ok(), 'hermetic collection 10 proxy response').toBe(true);

    const modal = page.locator('.seerr-season-modal.show');
    await expect(modal).toBeVisible();
    await expect(modal.locator('#seerr-modal-title')).toHaveText(/Request Collection/i);
    await expect(modal.locator('.seerr-season-subtitle')).toHaveText('JC Fixture Collection');

    // Finish only the modal's entrance transitions so geometry assertions read
    // its settled card sizes rather than an intermediate scale frame.
    await modal.evaluate((element) => {
        for (const animation of element.getAnimations({ subtree: true })) {
            try { animation.finish(); } catch { /* a non-finite host animation is irrelevant */ }
        }
    });
    return modal;
}

async function rowVisual(row: Locator): Promise<RowVisual> {
    return row.evaluate((element) => {
        // Force style resolution, then finish the row's short state transition.
        void getComputedStyle(element).backgroundColor;
        for (const animation of element.getAnimations({ subtree: true })) {
            try { animation.finish(); } catch { /* no finite transition to settle */ }
        }
        const style = getComputedStyle(element);
        return {
            backgroundColor: style.backgroundColor,
            borderColor: style.borderTopColor,
            boxShadow: style.boxShadow,
            cursor: style.cursor,
            opacity: Number.parseFloat(style.opacity),
        };
    });
}

async function clickWithMouse(target: Locator, page: Page): Promise<void> {
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    expect(box, 'card surface has clickable geometry').not.toBeNull();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
}

test.describe('Seerr collection request rich cards (#463)', () => {
    for (const testCase of CASES) {
        test(`${testCase.layout} / ${testCase.viewportKind}`, async ({ page, consoleErrors }) => {
            await page.setViewportSize(testCase.viewport);
            await seedLayout(page, testCase.seed);
            await loginAs(page, 'admin', consoleErrors);

            const wantedStamp = LAYOUT_STAMP[testCase.layout];
            const otherStamp = LAYOUT_STAMP[testCase.layout === 'modern' ? 'legacy' : 'modern'];
            await page.waitForFunction(
                (stamp) => document.documentElement.classList.contains(stamp),
                wantedStamp,
                { timeout: 20_000 }
            );
            const stamps = await page.locator('html').evaluate(
                (root, values) => ({
                    wanted: root.classList.contains(values.wanted),
                    other: root.classList.contains(values.other),
                }),
                { wanted: wantedStamp, other: otherStamp }
            );
            expect(stamps).toEqual({ wanted: true, other: false });

            const modal = await openHermeticCollection(page);
            const rows = modal.locator('.seerr-collection-movie-row');
            await expect(rows).toHaveCount(3);
            expect(
                await rows.evaluateAll((elements) => elements.map((element) => element.tagName)),
                'each whole card is the native checkbox label'
            ).toEqual(['LABEL', 'LABEL', 'LABEL']);

            const fightClub = modal.locator('.seerr-collection-movie-row:has([data-tmdb-id="550"])');
            const matrix = modal.locator('.seerr-collection-movie-row:has([data-tmdb-id="603"])');
            const toyStory = modal.locator('.seerr-collection-movie-row:has([data-tmdb-id="862"])');
            await expect(fightClub.locator('.title')).toHaveText('Fight Club');
            await expect(matrix.locator('.title')).toHaveText(LONG_COLLECTION_TITLE);
            await expect(toyStory.locator('.title')).toHaveText('Toy Story');
            const selectAll = modal.locator('#seerr-select-all-movies');
            const collectionCount = modal.locator('#seerr-collection-movie-count');
            await expect(collectionCount).toBeVisible();
            await expect(collectionCount).toHaveText('Movies in collection: 3');
            await expect(selectAll).toHaveAttribute('aria-describedby', 'seerr-collection-movie-count');
            await expect(selectAll).toHaveAccessibleDescription('Movies in collection: 3');
            await expect(fightClub.locator('.seerr-season-status')).toHaveClass(/seerr-season-status-available/);
            await expect(matrix.locator('.seerr-season-status')).toHaveClass(/seerr-season-status-not-requested/);
            await expect(toyStory.locator('.seerr-season-status')).toHaveClass(/seerr-season-status-not-requested/);

            const geometry = await modal.evaluate((root) => {
                const body = root.querySelector<HTMLElement>('.seerr-modal-body')!;
                const content = root.querySelector<HTMLElement>('.seerr-season-content')!;
                const list = root.querySelector<HTMLElement>('.seerr-collection-list')!;
                const footer = root.querySelector<HTMLElement>('.seerr-modal-footer')!;
                const collectionHeader = root.querySelector<HTMLElement>('.seerr-collection-header-row')!;
                const collectionCount = root.querySelector<HTMLElement>('.seerr-collection-count')!;
                const collectionHeaderLabel = root.querySelector<HTMLElement>('.seerr-collection-header-label')!;
                const bodyRect = body.getBoundingClientRect();
                const collectionHeaderRect = collectionHeader.getBoundingClientRect();
                const collectionCountRect = collectionCount.getBoundingClientRect();
                const collectionHeaderLabelRect = collectionHeaderLabel.getBoundingClientRect();
                const overflowers = [content, body, list, footer,
                    collectionHeader, collectionCount,
                    ...root.querySelectorAll<HTMLElement>('.seerr-collection-movie-row'),
                    ...root.querySelectorAll<HTMLElement>('.seerr-collection-movie-details > .title')]
                    .filter((element) => element.scrollWidth > element.clientWidth + 1)
                    .map((element) => element.className);
                const movieRows = Array.from(
                    root.querySelectorAll<HTMLElement>('.seerr-collection-movie-row')
                ).map((row) => {
                    const checkbox = row.querySelector<HTMLInputElement>('.seerr-collection-checkbox')!;
                    const poster = row.querySelector<HTMLElement>('.seerr-collection-movie-poster')!;
                    const details = row.querySelector<HTMLElement>('.seerr-collection-movie-details')!;
                    const title = details.querySelector<HTMLElement>(':scope > .title')!;
                    const meta = details.querySelector<HTMLElement>(':scope > .seerr-collection-movie-meta')!;
                    const year = meta.querySelector<HTMLElement>(':scope > .year')!;
                    const separator = meta.querySelector<HTMLElement>(':scope > .seerr-collection-meta-separator')!;
                    const status = meta.querySelector<HTMLElement>(':scope > .seerr-season-status')!;
                    const posterRect = poster.getBoundingClientRect();
                    const rowRect = row.getBoundingClientRect();
                    const yearRect = year.getBoundingClientRect();
                    const statusRect = status.getBoundingClientRect();
                    const titleStyle = getComputedStyle(title);
                    const titleRect = title.getBoundingClientRect();
                    const titleRange = document.createRange();
                    titleRange.selectNodeContents(title);
                    const textRects = Array.from(titleRange.getClientRects())
                        .filter((rect) => rect.width > 0 && rect.height > 0);
                    return {
                        id: checkbox.dataset.tmdbId,
                        title: title.textContent?.trim(),
                        year: year.textContent?.trim(),
                        separator: separator.textContent?.trim(),
                        detailsIsDirectChild: details.parentElement === row,
                        metaIsDirectChild: meta.parentElement === details,
                        statusIsInMeta: status.parentElement === meta,
                        posterWidth: posterRect.width,
                        posterHeight: posterRect.height,
                        metaCenterDelta: Math.abs(
                            yearRect.top + yearRect.height / 2
                            - (statusRect.top + statusRect.height / 2)
                        ),
                        yearToStatusGap: statusRect.left - yearRect.right,
                        titleOverflow: titleStyle.overflow,
                        titleOverflowWrap: titleStyle.overflowWrap,
                        titleTextOverflow: titleStyle.textOverflow,
                        titleWhiteSpace: titleStyle.whiteSpace,
                        titleWebkitLineClamp: titleStyle.webkitLineClamp,
                        titleClippedX: title.scrollWidth > title.clientWidth + 1,
                        titleClippedY: title.scrollHeight > title.clientHeight + 1,
                        titleLineCount: new Set(textRects.map((rect) => Math.round(rect.top))).size,
                        titleTextInside: textRects.every((rect) => (
                            rect.left >= titleRect.left - 1
                            && rect.right <= titleRect.right + 1
                            && rect.top >= titleRect.top - 1
                            && rect.bottom <= titleRect.bottom + 1
                        )),
                        insideBody: rowRect.left >= bodyRect.left - 1
                            && rowRect.right <= bodyRect.right + 1,
                    };
                });
                return {
                    overflowers,
                    movieRows,
                    collectionCountInsideHeader:
                        collectionCountRect.left >= collectionHeaderRect.left - 1
                        && collectionCountRect.right <= collectionHeaderRect.right + 1
                        && collectionCountRect.top >= collectionHeaderRect.top - 1
                        && collectionCountRect.bottom <= collectionHeaderRect.bottom + 1,
                    collectionCountBelowLabel:
                        collectionCountRect.top >= collectionHeaderLabelRect.bottom - 1,
                    bodyOverflowY: getComputedStyle(body).overflowY,
                    footerButtonCount: footer.querySelectorAll('button').length,
                    bodyAndFooterAreSiblings: body.parentElement === content
                        && footer.parentElement === content
                        && body.nextElementSibling === footer,
                };
            });

            expect(geometry.overflowers, 'modal cards have no horizontal overflow').toEqual([]);
            expect(geometry.bodyOverflowY, 'modal body owns internal scrolling').toMatch(/auto|scroll/);
            expect(geometry.collectionCountInsideHeader, 'collection total stays inside its header').toBe(true);
            expect(geometry.collectionCountBelowLabel, 'collection total does not overlap the select-all label').toBe(true);
            expect(geometry.footerButtonCount, 'Cancel and Request buttons remain intact').toBe(2);
            expect(geometry.bodyAndFooterAreSiblings, 'footer stays outside the scrolling body').toBe(true);
            expect(geometry.movieRows.map((row) => [row.id, row.title, row.year])).toEqual([
                ['550', 'Fight Club', '1999'],
                ['603', LONG_COLLECTION_TITLE, '1999'],
                ['862', 'Toy Story', '1995'],
            ]);
            for (const row of geometry.movieRows) {
                expect(row.detailsIsDirectChild).toBe(true);
                expect(row.metaIsDirectChild).toBe(true);
                expect(row.statusIsInMeta).toBe(true);
                expect(row.separator).toBe('·');
                expect(row.posterWidth, `${row.title} poster width`).toBeGreaterThanOrEqual(46);
                expect(row.posterWidth, `${row.title} poster width`).toBeLessThanOrEqual(56);
                expect(
                    row.posterHeight / row.posterWidth,
                    `${row.title} poster keeps an approximately 2:3 aspect ratio`
                ).toBeGreaterThanOrEqual(1.48);
                expect(row.posterHeight / row.posterWidth).toBeLessThanOrEqual(1.52);
                expect(row.metaCenterDelta, `${row.title} year and status share one line`).toBeLessThanOrEqual(2);
                expect(row.yearToStatusGap, `${row.title} year sits beside its status`).toBeGreaterThan(0);
                expect(row.yearToStatusGap, `${row.title} has no orphaned meta gap`).toBeLessThan(24);
                expect(row.titleOverflow).toBe('visible');
                expect(row.titleOverflowWrap).toBe('anywhere');
                expect(row.titleTextOverflow).toBe('clip');
                expect(row.titleWhiteSpace).toBe('normal');
                expect(row.titleWebkitLineClamp).toBe('none');
                expect(row.titleClippedX, `${row.title} is not horizontally clipped`).toBe(false);
                expect(row.titleClippedY, `${row.title} is not vertically clipped`).toBe(false);
                expect(row.titleTextInside, `${row.title} glyphs stay inside the title box`).toBe(true);
                expect(row.insideBody, `${row.title} card stays inside the modal body`).toBe(true);
            }
            expect(
                geometry.movieRows.find((row) => row.id === '603')?.titleLineCount,
                'the deliberately long title visibly wraps instead of truncating'
            ).toBeGreaterThan(1);

            // A click on readable card content (not the small checkbox) toggles
            // the native input and changes all three selected-card visual cues.
            const matrixCheckbox = matrix.locator('.seerr-collection-checkbox');
            await expect(matrixCheckbox).toBeChecked();
            const selectedVisual = await rowVisual(matrix);
            expect(selectedVisual.boxShadow, 'selected card has an inset highlight').not.toBe('none');
            await matrix.locator('.title').click();
            await expect(matrixCheckbox).not.toBeChecked();
            await page.mouse.move(0, 0);
            const unselectedVisual = await rowVisual(matrix);
            expect(unselectedVisual.backgroundColor).not.toBe(selectedVisual.backgroundColor);
            expect(unselectedVisual.borderColor).not.toBe(selectedVisual.borderColor);
            expect(unselectedVisual.boxShadow).not.toBe(selectedVisual.boxShadow);
            await matrix.locator('.seerr-collection-movie-poster').click();
            await expect(matrixCheckbox).toBeChecked();

            // The available row is visibly disabled and a trusted mouse click on
            // its card surface cannot change the disabled native control.
            const fightCheckbox = fightClub.locator('.seerr-collection-checkbox');
            await expect(fightCheckbox).toBeDisabled();
            await expect(fightCheckbox).not.toBeChecked();
            const disabledVisual = await rowVisual(fightClub);
            expect(disabledVisual.cursor).toBe('not-allowed');
            expect(disabledVisual.opacity, 'disabled card is visually subdued').toBeLessThan(0.9);
            await clickWithMouse(fightClub.locator('.title'), page);
            await expect(fightCheckbox).toBeDisabled();
            await expect(fightCheckbox).not.toBeChecked();

            // The real checkbox remains keyboard/screen-reader operable and its
            // request-handler data contract survives the richer card structure.
            const toyCheckbox = toyStory.locator('.seerr-collection-checkbox');
            await expect(toyCheckbox).toHaveAttribute('data-tmdb-id', '862');
            await expect(toyCheckbox).toHaveAccessibleName(/Toy Story/i);
            await expect(toyCheckbox).toBeChecked();
            await toyCheckbox.focus();
            await expect(toyCheckbox).toBeFocused();
            await toyCheckbox.press('Space');
            await expect(toyCheckbox).not.toBeChecked();
            await toyCheckbox.press('Space');
            await expect(toyCheckbox).toBeChecked();

            // Force real overflow in the deliberately short viewport: only the
            // modal body scrolls, while the footer remains visible and stationary.
            const scrollProof = await modal.evaluate((root) => {
                const body = root.querySelector<HTMLElement>('.seerr-modal-body')!;
                const content = root.querySelector<HTMLElement>('.seerr-season-content')!;
                const footer = root.querySelector<HTMLElement>('.seerr-modal-footer')!;
                body.scrollTop = 0;
                const footerTopBefore = footer.getBoundingClientRect().top;
                const windowScrollBefore = window.scrollY;
                body.scrollTop = body.scrollHeight;
                const footerRect = footer.getBoundingClientRect();
                const contentRect = content.getBoundingClientRect();
                return {
                    bodyScrollTop: body.scrollTop,
                    bodyMaxScroll: body.scrollHeight - body.clientHeight,
                    footerMovement: Math.abs(footerRect.top - footerTopBefore),
                    footerVisible: footerRect.top >= contentRect.top - 1
                        && footerRect.bottom <= contentRect.bottom + 1,
                    windowScrollMovement: Math.abs(window.scrollY - windowScrollBefore),
                    bodyLocked: document.body.classList.contains('seerr-modal-is-open')
                        && getComputedStyle(document.body).overflow === 'hidden',
                };
            });
            expect(scrollProof.bodyMaxScroll, 'fixture content exceeds the internal body').toBeGreaterThan(0);
            expect(scrollProof.bodyScrollTop, 'modal body accepts internal scrolling').toBeGreaterThan(0);
            expect(scrollProof.footerMovement, 'footer stays fixed while the body scrolls').toBeLessThanOrEqual(1);
            expect(scrollProof.footerVisible, 'footer remains inside the modal').toBe(true);
            expect(scrollProof.windowScrollMovement, 'the page does not scroll behind the modal').toBe(0);
            expect(scrollProof.bodyLocked, 'the host page is locked while the modal is open').toBe(true);

            if (VISUAL_REVIEW_DIR && testCase.viewportKind === 'mobile') {
                await modal.locator('.seerr-modal-body').evaluate((body) => {
                    body.scrollTop = 0;
                });
                await modal.locator('.seerr-season-content').screenshot({
                    path: `${VISUAL_REVIEW_DIR}/after-${testCase.layout}-320x568-overview.png`,
                    animations: 'disabled',
                });
                await matrix.scrollIntoViewIfNeeded();
                await matrix.screenshot({
                    path: `${VISUAL_REVIEW_DIR}/after-${testCase.layout}-320x568-long-title-card.png`,
                    animations: 'disabled',
                });
            }

            assertNoRuntimeErrors(consoleErrors);
        });
    }
});

test.describe('Seerr collection responsive device audit (#463 follow-up)', () => {
    for (const layout of ['modern', 'legacy'] as const) {
        test(`${layout} / 50-device popularity proxy / 23 portrait viewports`, async ({ page, consoleErrors }) => {
            expect(POPULAR_MOBILE_DEVICES, 'the researched device roster stays complete').toHaveLength(50);
            expect(
                POPULAR_MOBILE_DEVICES.map((device) => device.rosterOrder),
                'roster order is explicit rather than presented as one global sales rank'
            ).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));
            expect(
                POPULAR_MOBILE_DEVICES
                    .every((device) => (
                        device.viewportBasis === 'Playwright'
                        || device.viewportDerivation.trim().length > 0
                    )),
                'every proxy/reference viewport records its derivation'
            ).toBe(true);
            expect(POPULAR_VIEWPORTS, 'duplicate device dimensions are executed once').toHaveLength(23);

            await page.setViewportSize({ width: 390, height: 664 });
            await seedLayout(page, layout === 'modern' ? 'modern' : 'mobile-legacy');
            await loginAs(page, 'admin', consoleErrors);

            const wantedStamp = LAYOUT_STAMP[layout];
            await page.waitForFunction(
                (stamp) => document.documentElement.classList.contains(stamp),
                wantedStamp,
                { timeout: 20_000 }
            );

            const modal = await openHermeticCollection(page);
            const longTitle = modal.locator(
                '.seerr-collection-movie-row:has([data-tmdb-id="603"]) .title'
            );
            await expect(longTitle).toHaveText(LONG_COLLECTION_TITLE);

            for (const coverage of POPULAR_VIEWPORTS) {
                await page.setViewportSize(coverage.viewport);
                await page.evaluate(() => new Promise<void>((resolve) => {
                    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
                }));
                await modal.locator('.seerr-modal-body').evaluate((body) => {
                    body.scrollTop = 0;
                    const list = body.querySelector<HTMLElement>('.seerr-collection-list');
                    if (list) list.scrollTop = 0;
                });

                const deviceNames = coverage.devices.map((device) => device.name).join(', ');
                const assertionContext =
                    `${layout} ${coverage.key} (${deviceNames})`;
                await expect(
                    modal.locator('#seerr-collection-movie-count'),
                    `${assertionContext}: collection total is visible`
                ).toHaveText('Movies in collection: 3');

                const geometry = await modal.evaluate((root, expectedLongTitle) => {
                    const content = root.querySelector<HTMLElement>('.seerr-season-content')!;
                    const header = root.querySelector<HTMLElement>('.seerr-season-header')!;
                    const body = root.querySelector<HTMLElement>('.seerr-modal-body')!;
                    const list = root.querySelector<HTMLElement>('.seerr-collection-list')!;
                    const collectionHeader = root.querySelector<HTMLElement>(
                        '.seerr-collection-header-row'
                    )!;
                    const collectionHeaderLabel = root.querySelector<HTMLElement>(
                        '.seerr-collection-header-label'
                    )!;
                    const count = root.querySelector<HTMLElement>('.seerr-collection-count')!;
                    const footer = root.querySelector<HTMLElement>('.seerr-modal-footer')!;
                    const title = Array.from(
                        root.querySelectorAll<HTMLElement>('.seerr-collection-movie-details > .title')
                    ).find((candidate) => candidate.textContent?.trim() === expectedLongTitle)!;
                    const row = title.closest<HTMLElement>('.seerr-collection-movie-row')!;
                    const buttons = Array.from(
                        footer.querySelectorAll<HTMLElement>('.seerr-modal-button')
                    );
                    const horizontalCandidates = [
                        content,
                        header,
                        body,
                        list,
                        collectionHeader,
                        count,
                        footer,
                        ...buttons,
                        ...root.querySelectorAll<HTMLElement>('.seerr-collection-movie-row'),
                        ...root.querySelectorAll<HTMLElement>(
                            '.seerr-collection-movie-details > .title'
                        ),
                    ];
                    const horizontalOverflowers = horizontalCandidates
                        .filter((element) => element.scrollWidth > element.clientWidth + 1)
                        .map((element) => element.className || element.tagName);

                    const contentRect = content.getBoundingClientRect();
                    const bodyRect = body.getBoundingClientRect();
                    const collectionHeaderRect = collectionHeader.getBoundingClientRect();
                    const collectionHeaderLabelRect = collectionHeaderLabel.getBoundingClientRect();
                    const countRect = count.getBoundingClientRect();
                    const footerRect = footer.getBoundingClientRect();
                    const buttonRects = buttons.map((button) => button.getBoundingClientRect());
                    const titleRect = title.getBoundingClientRect();
                    const rowRect = row.getBoundingClientRect();
                    const titleRange = document.createRange();
                    titleRange.selectNodeContents(title);
                    const titleTextRects = Array.from(titleRange.getClientRects())
                        .filter((rect) => rect.width > 0 && rect.height > 0);
                    const titleStyle = getComputedStyle(title);

                    return {
                        horizontalOverflowers,
                        viewport: { width: window.innerWidth, height: window.innerHeight },
                        contentInsideViewport:
                            contentRect.left >= -1
                            && contentRect.right <= window.innerWidth + 1
                            && contentRect.top >= -1
                            && contentRect.bottom <= window.innerHeight + 1,
                        bodyOwnsVerticalOverflow: /auto|scroll/.test(getComputedStyle(body).overflowY),
                        footerInsideContent:
                            footerRect.left >= contentRect.left - 1
                            && footerRect.right <= contentRect.right + 1
                            && footerRect.top >= contentRect.top - 1
                            && footerRect.bottom <= contentRect.bottom + 1,
                        footerButtonsInside:
                            buttonRects.length === 2
                            && buttonRects.every((rect) => (
                                rect.left >= footerRect.left - 1
                                && rect.right <= footerRect.right + 1
                                && rect.top >= footerRect.top - 1
                                && rect.bottom <= footerRect.bottom + 1
                            )),
                        footerButtonsDoNotOverlap:
                            buttonRects.length === 2
                            && buttonRects[0].right <= buttonRects[1].left + 1,
                        countInsideHeader:
                            countRect.left >= collectionHeaderRect.left - 1
                            && countRect.right <= collectionHeaderRect.right + 1
                            && countRect.top >= collectionHeaderRect.top - 1
                            && countRect.bottom <= collectionHeaderRect.bottom + 1,
                        countBelowLabel: countRect.top >= collectionHeaderLabelRect.bottom - 1,
                        longRowInsideBody:
                            rowRect.left >= bodyRect.left - 1
                            && rowRect.right <= bodyRect.right + 1,
                        titleWhiteSpace: titleStyle.whiteSpace,
                        titleOverflowWrap: titleStyle.overflowWrap,
                        titleTextOverflow: titleStyle.textOverflow,
                        titleWebkitLineClamp: titleStyle.webkitLineClamp,
                        titleClippedX: title.scrollWidth > title.clientWidth + 1,
                        titleClippedY: title.scrollHeight > title.clientHeight + 1,
                        titleLineCount:
                            new Set(titleTextRects.map((rect) => Math.round(rect.top))).size,
                        titleTextInside: titleTextRects.every((rect) => (
                            rect.left >= titleRect.left - 1
                            && rect.right <= titleRect.right + 1
                            && rect.top >= titleRect.top - 1
                            && rect.bottom <= titleRect.bottom + 1
                        )),
                        bodyLocked: document.body.classList.contains('seerr-modal-is-open')
                            && getComputedStyle(document.body).overflow === 'hidden',
                    };
                }, LONG_COLLECTION_TITLE);

                expect(
                    geometry.horizontalOverflowers,
                    `${assertionContext}: modal has no horizontal overflow`
                ).toEqual([]);
                expect(
                    geometry.viewport,
                    `${assertionContext}: browser applied the requested viewport`
                ).toEqual(coverage.viewport);
                expect(
                    geometry.contentInsideViewport,
                    `${assertionContext}: modal content stays inside the viewport`
                ).toBe(true);
                expect(
                    geometry.bodyOwnsVerticalOverflow,
                    `${assertionContext}: modal body retains internal scrolling`
                ).toBe(true);
                expect(
                    geometry.footerInsideContent,
                    `${assertionContext}: footer stays inside the modal`
                ).toBe(true);
                expect(
                    geometry.footerButtonsInside,
                    `${assertionContext}: both actions stay inside the footer`
                ).toBe(true);
                expect(
                    geometry.footerButtonsDoNotOverlap,
                    `${assertionContext}: footer actions do not overlap`
                ).toBe(true);
                expect(
                    geometry.countInsideHeader,
                    `${assertionContext}: collection total stays inside its header`
                ).toBe(true);
                expect(
                    geometry.countBelowLabel,
                    `${assertionContext}: collection total does not overlap its label`
                ).toBe(true);
                expect(
                    geometry.longRowInsideBody,
                    `${assertionContext}: long-title card stays inside the body`
                ).toBe(true);
                expect(geometry.titleWhiteSpace, `${assertionContext}: title wrapping`).toBe('normal');
                expect(geometry.titleOverflowWrap, `${assertionContext}: long-token wrapping`).toBe('anywhere');
                expect(geometry.titleTextOverflow, `${assertionContext}: no ellipsis`).toBe('clip');
                expect(geometry.titleWebkitLineClamp, `${assertionContext}: no line clamp`).toBe('none');
                expect(geometry.titleClippedX, `${assertionContext}: title is not clipped on x`).toBe(false);
                expect(geometry.titleClippedY, `${assertionContext}: title is not clipped on y`).toBe(false);
                expect(geometry.titleLineCount, `${assertionContext}: full title wraps`).toBeGreaterThan(1);
                expect(
                    geometry.titleTextInside,
                    `${assertionContext}: every rendered title glyph stays visible`
                ).toBe(true);
                expect(geometry.bodyLocked, `${assertionContext}: background remains locked`).toBe(true);

                if (VISUAL_REVIEW_DIR && VISUAL_REVIEW_VIEWPORTS.has(coverage.key)) {
                    await modal.locator('.seerr-season-content').screenshot({
                        path: `${VISUAL_REVIEW_DIR}/after-${layout}-${coverage.key}.png`,
                        animations: 'disabled',
                    });
                }
            }

            assertNoRuntimeErrors(consoleErrors);
        });
    }
});
