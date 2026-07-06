// Tag pipeline: library cards on the home screen get the renderers'
// data-je-*-tagged processed markers (quality/genre/language/rating renderers
// share tag-renderer-base, which stamps `spec.taggedAttr` on each card).
//
// The spec skips itself when no tag renderer is enabled for the logged-in
// user, so it stays meaningful across differently-configured servers.
import { test, expect, loginAs } from './fixtures/auth';

/* eslint-disable @typescript-eslint/no-explicit-any */

// setting flag → the marker each family's renderer stamps on a tagged card.
const FAMILIES = [
    { setting: 'qualityTagsEnabled', attr: 'data-je-quality-tagged' },
    { setting: 'genreTagsEnabled', attr: 'data-je-genre-tagged' },
    { setting: 'languageTagsEnabled', attr: 'data-je-language-tagged' },
    { setting: 'ratingTagsEnabled', attr: 'data-je-rating-tagged' },
] as const;

test.describe('tags', () => {
    test('home library cards get data-je-*-tagged markers per enabled family', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);

        // Only the families ENABLED for this user are asserted — but each of
        // them independently. (The old test summed all four and asserted the
        // total > 0, so one working family masked three dead ones.)
        const enabled: string[] = await page.evaluate((families) => {
            const settings = (window as any).JellyfinEnhanced?.currentSettings || {};
            return families.filter((f) => settings[f.setting] === true).map((f) => f.attr);
        }, FAMILIES.map((f) => ({ setting: f.setting, attr: f.attr })));
        test.skip(enabled.length === 0, 'no tag renderer enabled for this user');

        await page.waitForSelector('#indexPage .card', { timeout: 60_000 });

        // Wait for EVERY enabled family to have tagged a card (the whole pipeline
        // settled), not just one — a single stuck family must not be hidden by
        // the others. If a family stays at zero the wait times out; the caught
        // timeout lets the per-family assertion below report exactly which one.
        await page.waitForFunction(
            (attrs) => attrs.every((attr) => document.querySelectorAll(`[${attr}]`).length > 0),
            enabled,
            { timeout: 60_000 }
        ).catch(() => { /* fall through to the precise per-family assertion */ });

        const counts = await page.evaluate((attrs) => {
            const byAttr: Record<string, number> = {};
            for (const attr of attrs) byAttr[attr] = document.querySelectorAll(`[${attr}]`).length;
            return { byAttr, cards: document.querySelectorAll('#indexPage .card').length };
        }, enabled);

        expect(counts.cards).toBeGreaterThan(0);
        // Per-family: each enabled family must tag at least one card on its own.
        for (const attr of enabled) {
            expect(counts.byAttr[attr], `enabled tag family ${attr} must tag at least one card`)
                .toBeGreaterThan(0);
        }

        expect(consoleErrors.real()).toEqual([]);
    });

    // Regression: "Hide Tags on Hover" must hide the tags on the detail-page
    // primary poster too. That poster is a `.card` with NO `.cardOverlayContainer`,
    // so its tags render straight into `.cardScalable` with no `.je-tag-host`
    // wrapper — the old `.card:hover .je-tag-host` rule never matched it, so the
    // poster tags stayed visible on hover (movie/series/episode posters). The
    // broadened rule targets the overlay containers directly.
    test('hide-on-hover fades the detail-page primary poster tags', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);

        const anyTagsEnabled = await page.evaluate(() => {
            const settings = (window as any).JellyfinEnhanced?.currentSettings || {};
            return ['qualityTagsEnabled', 'genreTagsEnabled', 'languageTagsEnabled', 'ratingTagsEnabled']
                .some((key) => settings[key] === true);
        });
        test.skip(!anyTagsEnabled, 'no tag renderer enabled for this user');

        // Open the detail page of the first available movie.
        const movieId = await page.evaluate(async () => {
            const uid = (window as any).ApiClient.getCurrentUserId();
            const res = await (window as any).ApiClient.getItems(uid, {
                IncludeItemTypes: 'Movie', Recursive: true, Limit: 1, SortBy: 'DateCreated', SortOrder: 'Descending',
            });
            return res?.Items?.[0]?.Id || null;
        });
        test.skip(!movieId, 'no movie available to open');

        await page.evaluate((id) => { window.location.hash = `#/details?id=${id}`; }, movieId);

        // The primary poster is the `.card` in the detail header that carries a JE
        // overlay container but NOT a `.je-tag-host` (no hover menu on that card).
        const POSTER = '.detailPagePrimaryContainer .card, .detailImageContainer .card';
        const isPosterTagged = (sel: string) => [...document.querySelectorAll(sel)]
            .some((c) => c.querySelector('[class*="-overlay-container"]') && !c.querySelector('.je-tag-host'));

        await page.waitForFunction(isPosterTagged, POSTER, { timeout: 60_000 }).catch(() => {});
        const posterTagged = await page.evaluate(isPosterTagged, POSTER);
        test.skip(!posterTagged, 'primary poster carries no JE tags (no media info)');

        // Enable "Hide Tags on Hover" (the body class the setting toggles).
        await page.evaluate(() => document.body.classList.add('je-tags-hide-on-hover'));

        // Mark the poster, then wait for its tag layer to SETTLE at full opacity.
        // The overlay containers fade in via a 150ms `je-tag-fadein` intro, so a
        // one-shot read of the baseline would race that animation and flake.
        await page.evaluate((sel) => {
            const card = [...document.querySelectorAll(sel)]
                .find((c) => c.querySelector('[class*="-overlay-container"]') && !c.querySelector('.je-tag-host'));
            card!.setAttribute('data-je-test-poster', '1');
        }, POSTER);
        await page.waitForFunction(() => {
            const oc = document.querySelector('[data-je-test-poster] [class*="-overlay-container"]') as HTMLElement | null;
            return !!oc && getComputedStyle(oc).opacity === '1';
        }, undefined, { timeout: 10_000 });

        // Hovering the poster must fade its (fully-visible) tag layer to transparent.
        await page.hover('[data-je-test-poster]');
        await page.waitForFunction(() => {
            const oc = document.querySelector('[data-je-test-poster] [class*="-overlay-container"]') as HTMLElement | null;
            return !!oc && getComputedStyle(oc).opacity === '0';
        }, undefined, { timeout: 5_000 });

        expect(consoleErrors.real()).toEqual([]);
    });
});
