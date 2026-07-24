// #466 finding 4 — user-review headers and edit controls at narrow widths.
//
// The route fixture supplies three deterministic review shapes (short, long
// spaced, and long unbroken display names) while the real details-page feature
// builds the cards, carousel, actions, and edit form. No review is written.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Locator, Page } from 'playwright/test';
import {
    test,
    expect,
    loginAs,
    showRoute,
    waitForHash,
    assertNoRuntimeErrors,
    USERS,
} from './fixtures/auth';
import {
    api,
    authenticate,
    PLUGIN_ID,
    type Session,
} from './fixtures/api';

const VISUAL_REVIEW_DIR = process.env.JC_RESPONSIVE_VISUAL_REVIEW_DIR?.replace(/\/+$/, '');
const CONFIG_PATH = `/Plugins/${PLUGIN_ID}/Configuration`;
const TRANSPARENT_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
);

type Layout = 'modern' | 'legacy';

const PHONE_LAYOUTS: ReadonlyArray<{
    layout: Layout;
    seed: 'modern' | 'mobile-legacy';
}> = [
    { layout: 'modern', seed: 'modern' },
    { layout: 'legacy', seed: 'mobile-legacy' },
];

const WIDE_LAYOUTS: ReadonlyArray<{
    layout: Layout;
    seed: 'modern' | 'desktop-legacy';
}> = [
    { layout: 'modern', seed: 'modern' },
    { layout: 'legacy', seed: 'desktop-legacy' },
];

const LAYOUT_STAMP: Record<Layout, string> = {
    modern: 'jc-modern-layout',
    legacy: 'jc-legacy-layout',
};

interface JellyfinItem {
    Id: string;
    ProviderIds?: { Tmdb?: string | number };
}

interface ItemsResponse {
    Items?: JellyfinItem[];
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

async function settleResponsiveLayout(page: Page): Promise<void> {
    await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
}

async function keepBelowStickyHeader(page: Page, target: Locator): Promise<void> {
    await target.scrollIntoViewIfNeeded();
    await target.evaluate((element) => {
        const headerBottom = Math.max(
            0,
            ...[...document.querySelectorAll<HTMLElement>('.skinHeader, .MuiAppBar-root')]
                .filter((header) => header.getClientRects().length > 0)
                .map((header) => header.getBoundingClientRect().bottom)
        );
        const correction = element.getBoundingClientRect().top - headerBottom - 8;
        if (correction >= 0) return;

        let scroller = element.parentElement;
        while (scroller && scroller !== document.body) {
            const style = getComputedStyle(scroller);
            if (
                scroller.scrollHeight > scroller.clientHeight
                && /(auto|scroll)/.test(style.overflowY)
            ) {
                scroller.scrollTop += correction;
                return;
            }
            scroller = scroller.parentElement;
        }
        window.scrollBy(0, correction);
    });
    await settleResponsiveLayout(page);
}

async function installReviewRoutes(
    page: Page,
    adminUserId: string,
    otherUserId: string
): Promise<void> {
    const now = '2026-07-24T08:00:00.000Z';
    const reviews = [
        {
            userId: adminUserId,
            userName: 'JC Admin',
            content: 'A short test-owned review with real edit and delete controls.',
            rating: 5,
            createdAt: now,
            updatedAt: now,
        },
        {
            userId: otherUserId,
            userName:
                'Alexandria Cassandra Montgomery the Third With A Deliberately Long Display Name',
            content:
                'A deliberately long spaced review that proves ordinary words wrap '
                + 'inside the responsive card without displacing its rating or admin action.',
            rating: 4,
            createdAt: now,
            updatedAt: now,
        },
        {
            userId: '11111111111111111111111111111111',
            userName:
                'UnbrokenReviewerNameThatMustWrapInsideTheCardAtEverySupportedViewportWidth',
            content:
                'UnbrokenReviewContentThatMustAlsoRemainInsideTheCardWithoutCreatingDocumentOverflow'
                + 'EvenWhenTheViewportIsOnlyThreeHundredAndTwentyCssPixelsWide',
            rating: 3,
            createdAt: now,
            updatedAt: now,
        },
    ];

    await page.route('**/JellyfinCanopy/reviews/**', async (route) => {
        if (route.request().method() !== 'GET') {
            await route.continue();
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ reviews, nextCursor: null }),
        });
    });

    // Review cards deliberately render avatars. Keep those real image elements
    // present without allowing absent test-user artwork to create unrelated
    // URL-aware 404 failures in the shared runtime assertion.
    await page.route('**/Users/*/Images/Primary*', (route) => route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: TRANSPARENT_PNG,
    }));
}

async function openReviews(page: Page, itemId: string): Promise<Locator> {
    await showRoute(page, `/details?id=${itemId}`);
    await waitForHash(page, itemId);
    const section = page.locator(
        '#itemDetailPage:not(.hide) .tmdb-reviews-section'
    ).first();
    await expect(section).toBeVisible({ timeout: 30_000 });
    await expect(section.locator('.jc-user-review-card')).toHaveCount(3, {
        timeout: 30_000,
    });

    if (!(await section.getAttribute('open'))) {
        const save = page.waitForResponse(
            (response) =>
                /\/JellyfinCanopy\/user-settings\/.+\/settings\.json/.test(response.url())
                && response.request().method() === 'POST',
            { timeout: 30_000 }
        );
        await section.locator('summary').click();
        await expect(section).toHaveAttribute('open', '');
        expect((await save).ok(), 'expanding Reviews persists cleanly').toBe(true);
    }
    return section;
}

async function expectReviewCardsContained(page: Page, section: Locator): Promise<void> {
    const proof = await section.evaluate((root) => {
        const sectionRect = root.getBoundingClientRect();
        const swipe = root.querySelector<HTMLElement>('.tmdb-review-swipe-container')!;
        const swipeRect = swipe.getBoundingClientRect();
        const cards = [...root.querySelectorAll<HTMLElement>('.jc-user-review-card')]
            .map((card, cardIndex) => {
                const cardRect = card.getBoundingClientRect();
                const nodes = [
                    card.querySelector<HTMLElement>('.jc-user-review-header')!,
                    card.querySelector<HTMLElement>('.jc-user-review-avatar-wrapper')!,
                    card.querySelector<HTMLElement>('.tmdb-review-author-info')!,
                    card.querySelector<HTMLElement>('.tmdb-review-author')!,
                    card.querySelector<HTMLElement>('.jc-user-review-rating')!,
                    card.querySelector<HTMLElement>('.jc-user-review-actions')!,
                    card.querySelector<HTMLElement>('.tmdb-review-content-wrapper')!,
                    card.querySelector<HTMLElement>('.tmdb-review-text')!,
                ].filter(Boolean);
                return {
                    cardIndex,
                    cardHeight: cardRect.height,
                    cardClientWidth: card.clientWidth,
                    cardScrollWidth: card.scrollWidth,
                    nodes: nodes.map((node) => {
                        const rect = node.getBoundingClientRect();
                        return {
                            name: node.className,
                            left: rect.left,
                            right: rect.right,
                            clientWidth: node.clientWidth,
                            scrollWidth: node.scrollWidth,
                            cardLeft: cardRect.left,
                            cardRight: cardRect.right,
                        };
                    }),
                };
            });
        return {
            documentOverflow:
                document.scrollingElement!.scrollWidth - window.innerWidth,
            sectionLeft: sectionRect.left,
            sectionRight: sectionRect.right,
            sectionClientWidth: root.clientWidth,
            sectionScrollWidth: root.scrollWidth,
            swipeLeft: swipeRect.left,
            swipeRight: swipeRect.right,
            swipeClientWidth: swipe.clientWidth,
            cards,
        };
    });

    expect(proof.documentOverflow, 'Reviews document horizontal overflow')
        .toBeLessThanOrEqual(1);
    // The owning details section can be a few pixels wider than its client box
    // because Jellyfin paints borders/shadows around the intentionally
    // horizontal carousel. The swipe viewport and every card/child below are
    // the actual containment contract.
    expect(proof.swipeLeft, 'review carousel left section edge')
        .toBeGreaterThanOrEqual(proof.sectionLeft - 1);
    expect(proof.swipeRight, 'review carousel right section edge')
        .toBeLessThanOrEqual(proof.sectionRight + 1);
    expect(proof.swipeClientWidth, 'review carousel has usable width').toBeGreaterThan(0);
    expect(
        proof.cards[2].cardHeight - proof.cards[0].cardHeight,
        'short review card keeps its natural height instead of stretching to the longest review'
    ).toBeGreaterThan(40);
    if ((await page.viewportSize())!.width <= 420) {
        expect(
            proof.swipeClientWidth - proof.cards[0].cardClientWidth,
            'phone review cards use the available carousel width'
        ).toBeLessThanOrEqual(36);
    }

    for (const card of proof.cards) {
        expect(
            card.cardScrollWidth - card.cardClientWidth,
            `review card ${card.cardIndex + 1} horizontal overflow`
        ).toBeLessThanOrEqual(1);
        for (const node of card.nodes) {
            expect(
                node.scrollWidth - node.clientWidth,
                `review card ${card.cardIndex + 1} ${node.name} internal overflow`
            ).toBeLessThanOrEqual(1);
            expect(
                node.left,
                `review card ${card.cardIndex + 1} ${node.name} left edge`
            ).toBeGreaterThanOrEqual(node.cardLeft - 1);
            expect(
                node.right,
                `review card ${card.cardIndex + 1} ${node.name} right edge`
            ).toBeLessThanOrEqual(node.cardRight + 1);
        }
    }
}

async function expectReviewFormContained(form: Locator): Promise<void> {
    const proof = await form.evaluate((element) => {
        const placeholder = element.closest<HTMLElement>('.jc-review-form-placeholder')!;
        const picker = element.querySelector<HTMLElement>('.jc-review-star-picker')!;
        const formRect = element.getBoundingClientRect();
        const placeholderRect = placeholder.getBoundingClientRect();
        const pickerRect = picker.getBoundingClientRect();
        const nodes = [
            ...picker.querySelectorAll<HTMLElement>(
                '.jc-star-btn, .jc-star-clear-btn, .jc-star-label'
            ),
            element.querySelector<HTMLElement>('.jc-review-textarea')!,
            element.querySelector<HTMLElement>('.jc-review-form-btns')!,
        ];
        return {
            formClientWidth: element.clientWidth,
            formScrollWidth: element.scrollWidth,
            formLeft: formRect.left,
            formRight: formRect.right,
            placeholderLeft: placeholderRect.left,
            placeholderRight: placeholderRect.right,
            pickerClientWidth: picker.clientWidth,
            pickerScrollWidth: picker.scrollWidth,
            nodes: nodes.map((node) => {
                const rect = node.getBoundingClientRect();
                return {
                    name: node.className,
                    left: rect.left,
                    right: rect.right,
                    formLeft: formRect.left,
                    formRight: formRect.right,
                    pickerLeft: pickerRect.left,
                    pickerRight: pickerRect.right,
                };
            }),
        };
    });

    expect(proof.formScrollWidth - proof.formClientWidth, 'review form horizontal overflow')
        .toBeLessThanOrEqual(1);
    expect(proof.pickerScrollWidth - proof.pickerClientWidth, 'star picker horizontal overflow')
        .toBeLessThanOrEqual(1);
    expect(proof.formLeft, 'review form left placeholder edge')
        .toBeGreaterThanOrEqual(proof.placeholderLeft - 1);
    expect(proof.formRight, 'review form right placeholder edge')
        .toBeLessThanOrEqual(proof.placeholderRight + 1);
    for (const node of proof.nodes) {
        expect(node.left, `${node.name} left form edge`)
            .toBeGreaterThanOrEqual(node.formLeft - 1);
        expect(node.right, `${node.name} right form edge`)
            .toBeLessThanOrEqual(node.formRight + 1);
        if (/jc-star/.test(node.name)) {
            expect(node.left, `${node.name} left picker edge`)
                .toBeGreaterThanOrEqual(node.pickerLeft - 1);
            expect(node.right, `${node.name} right picker edge`)
                .toBeLessThanOrEqual(node.pickerRight + 1);
        }
    }
}

async function capture(section: Locator, fileName: string): Promise<void> {
    if (!VISUAL_REVIEW_DIR) return;
    await mkdir(VISUAL_REVIEW_DIR, { recursive: true });
    await section.screenshot({
        path: join(VISUAL_REVIEW_DIR, fileName),
        animations: 'disabled',
    });
}

async function restoreReviewsExpanded(
    page: Page,
    original: boolean | undefined
): Promise<void> {
    await page.evaluate(async (expanded) => {
        const JC = (window as any).JellyfinCanopy;
        const settings = JC.currentSettings;
        if (!settings || !JC.identity?.isOwned?.(settings)) {
            throw new Error('responsive Reviews cleanup lost the owned settings object');
        }
        if (expanded === undefined) {
            delete settings.reviewsExpandedByDefault;
        } else {
            settings.reviewsExpandedByDefault = expanded;
        }
        await JC.saveUserSettings('settings.json', settings);
    }, original);
}

test.describe.serial('User Reviews responsive containment (#466 finding 4)', () => {
    let admin: Session;
    let otherUser: Session;
    let originalConfig: Record<string, unknown>;
    let movie: JellyfinItem;

    test.beforeAll(async ({ baseURL }) => {
        admin = await authenticate(baseURL!, USERS.admin.username, USERS.admin.password);
        otherUser = await authenticate(baseURL!, USERS.user.username, USERS.user.password);

        const items = await api<ItemsResponse>(
            baseURL!,
            `/Users/${encodeURIComponent(admin.userId)}/Items`
                + '?IncludeItemTypes=Movie&Recursive=true&Limit=100&Fields=ProviderIds',
            admin.token
        );
        movie = items?.Items?.find((item) => Boolean(item.ProviderIds?.Tmdb)) as JellyfinItem;
        expect(
            movie?.Id && movie.ProviderIds?.Tmdb,
            'hermetic server exposes a Movie with a TMDB provider id'
        ).toBeTruthy();

        const config = await api<Record<string, unknown>>(
            baseURL!,
            CONFIG_PATH,
            admin.token
        );
        expect(config, 'plugin configuration is readable').toBeTruthy();
        originalConfig = config!;
        await writePluginConfig(baseURL!, admin, {
            ...originalConfig,
            ShowUserReviews: true,
            ShowReviews: false,
            SpoilerBlurEnabled: false,
            LayoutEnforcement: 'None',
        });
    });

    test.afterAll(async ({ baseURL }) => {
        if (admin && originalConfig) {
            await writePluginConfig(baseURL!, admin, originalConfig);
        }
    });

    for (const testCase of PHONE_LAYOUTS) {
        test(`${testCase.layout}: phone review cards and edit form contain short, spaced, and unbroken names`, async ({
            page,
            consoleErrors,
        }) => {
            await page.setViewportSize({ width: 320, height: 568 });
            await seedLayout(page, testCase.seed);
            await loginAs(page, 'admin', consoleErrors);
            await expectExactLayout(page, testCase.layout);
            await installReviewRoutes(page, admin.userId, otherUser.userId);
            const originalExpanded = await page.evaluate(() => (
                (window as any).JellyfinCanopy.currentSettings.reviewsExpandedByDefault
            ) as boolean | undefined);

            try {
                const section = await openReviews(page, movie.Id);
                await settleResponsiveLayout(page);
                await expectReviewCardsContained(page, section);
                await capture(
                    section,
                    `fixed-reviews-cards-${testCase.layout}-320x568.png`
                );
                const longNameCard = section.locator('.jc-user-review-card').nth(1);
                await keepBelowStickyHeader(page, longNameCard);
                await capture(
                    longNameCard,
                    `fixed-reviews-long-card-${testCase.layout}-320x568.png`
                );

                const ownCard = section.locator(
                    '.jc-user-review-card:has(.jc-review-edit-btn)'
                );
                await expect(ownCard).toHaveCount(1);
                await ownCard.locator('.jc-review-edit-btn').click();
                const form = section.locator('.jc-review-form');
                await expect(form).toBeVisible();
                await form.locator('.jc-star-btn[data-value="5"]').click();
                await expect(form.locator('.jc-star-label')).toHaveText('5/5');
                await settleResponsiveLayout(page);
                await expectReviewFormContained(form);
                await keepBelowStickyHeader(page, form);
                await capture(
                    form,
                    `fixed-reviews-form-${testCase.layout}-320x568.png`
                );

                await form.locator('.jc-review-cancel-btn').click();
                await expect(form).toBeHidden();
                await page.setViewportSize({ width: 568, height: 320 });
                await settleResponsiveLayout(page);
                await expectReviewCardsContained(page, section);
                assertNoRuntimeErrors(consoleErrors);
            } finally {
                await restoreReviewsExpanded(page, originalExpanded);
            }
        });
    }

    for (const testCase of WIDE_LAYOUTS) {
        test(`${testCase.layout}: review cards contain long names at tablet and desktop widths`, async ({
            page,
            consoleErrors,
        }) => {
            await page.setViewportSize({ width: 800, height: 1280 });
            await seedLayout(page, testCase.seed);
            await loginAs(page, 'admin', consoleErrors);
            await expectExactLayout(page, testCase.layout);
            await installReviewRoutes(page, admin.userId, otherUser.userId);
            const originalExpanded = await page.evaluate(() => (
                (window as any).JellyfinCanopy.currentSettings.reviewsExpandedByDefault
            ) as boolean | undefined);

            try {
                const section = await openReviews(page, movie.Id);
                for (const viewport of [
                    { width: 800, height: 1280 },
                    { width: 1280, height: 720 },
                ]) {
                    await page.setViewportSize(viewport);
                    await settleResponsiveLayout(page);
                    await expectReviewCardsContained(page, section);
                    if (viewport.width === 800) {
                        await capture(
                            section,
                            `fixed-reviews-cards-${testCase.layout}-800x1280.png`
                        );
                    }
                }
                assertNoRuntimeErrors(consoleErrors);
            } finally {
                await restoreReviewsExpanded(page, originalExpanded);
            }
        });
    }
});
