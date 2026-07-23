// #463 — the Request Collection modal renders each movie as a rich, responsive
// card. The required Docker seed owns hermetic Seerr collection 10:
// Fight Club is available/disabled, while The Matrix and Toy Story are
// selectable. Drive the booted facade directly so this covers the real proxy,
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

/* eslint-disable @typescript-eslint/no-explicit-any */

type Layout = 'modern' | 'legacy';
type ViewportKind = 'mobile' | 'desktop';

const LAYOUT_STAMP: Record<Layout, string> = {
    modern: 'jc-modern-layout',
    legacy: 'jc-legacy-layout',
};

const CASES: ReadonlyArray<{
    layout: Layout;
    viewportKind: ViewportKind;
    viewport: { width: number; height: number };
    seed: string;
}> = [
    { layout: 'modern', viewportKind: 'mobile', viewport: { width: 390, height: 640 }, seed: 'modern' },
    { layout: 'modern', viewportKind: 'desktop', viewport: { width: 1280, height: 640 }, seed: 'modern' },
    { layout: 'legacy', viewportKind: 'mobile', viewport: { width: 390, height: 640 }, seed: 'mobile-legacy' },
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
            await expect(matrix.locator('.title')).toHaveText('The Matrix');
            await expect(toyStory.locator('.title')).toHaveText('Toy Story');
            await expect(fightClub.locator('.seerr-season-status')).toHaveClass(/seerr-season-status-available/);
            await expect(matrix.locator('.seerr-season-status')).toHaveClass(/seerr-season-status-not-requested/);
            await expect(toyStory.locator('.seerr-season-status')).toHaveClass(/seerr-season-status-not-requested/);

            const geometry = await modal.evaluate((root) => {
                const body = root.querySelector<HTMLElement>('.seerr-modal-body')!;
                const content = root.querySelector<HTMLElement>('.seerr-season-content')!;
                const list = root.querySelector<HTMLElement>('.seerr-collection-list')!;
                const footer = root.querySelector<HTMLElement>('.seerr-modal-footer')!;
                const bodyRect = body.getBoundingClientRect();
                const overflowers = [content, body, list, footer,
                    ...root.querySelectorAll<HTMLElement>('.seerr-collection-movie-row')]
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
                        titleTextOverflow: titleStyle.textOverflow,
                        titleWhiteSpace: titleStyle.whiteSpace,
                        insideBody: rowRect.left >= bodyRect.left - 1
                            && rowRect.right <= bodyRect.right + 1,
                    };
                });
                return {
                    overflowers,
                    movieRows,
                    bodyOverflowY: getComputedStyle(body).overflowY,
                    footerButtonCount: footer.querySelectorAll('button').length,
                    bodyAndFooterAreSiblings: body.parentElement === content
                        && footer.parentElement === content
                        && body.nextElementSibling === footer,
                };
            });

            expect(geometry.overflowers, 'modal cards have no horizontal overflow').toEqual([]);
            expect(geometry.bodyOverflowY, 'modal body owns internal scrolling').toMatch(/auto|scroll/);
            expect(geometry.footerButtonCount, 'Cancel and Request buttons remain intact').toBe(2);
            expect(geometry.bodyAndFooterAreSiblings, 'footer stays outside the scrolling body').toBe(true);
            expect(geometry.movieRows.map((row) => [row.id, row.title, row.year])).toEqual([
                ['550', 'Fight Club', '1999'],
                ['603', 'The Matrix', '1999'],
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
                expect(row.titleOverflow).toBe('hidden');
                expect(row.titleTextOverflow).toBe('ellipsis');
                expect(row.titleWhiteSpace).toBe('nowrap');
                expect(row.insideBody, `${row.title} card stays inside the modal body`).toBe(true);
            }

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

            assertNoRuntimeErrors(consoleErrors);
        });
    }
});
