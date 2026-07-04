// Tag pipeline: library cards on the home screen get the renderers'
// data-je-*-tagged processed markers (quality/genre/language/rating renderers
// share tag-renderer-base, which stamps `spec.taggedAttr` on each card).
//
// The spec skips itself when no tag renderer is enabled for the logged-in
// user, so it stays meaningful across differently-configured servers.
import { test, expect, loginAs } from './fixtures/auth';

/* eslint-disable @typescript-eslint/no-explicit-any */

const TAGGED_ATTRS = [
    'data-je-quality-tagged',
    'data-je-genre-tagged',
    'data-je-language-tagged',
    'data-je-rating-tagged',
];

test.describe('tags', () => {
    test('home library cards get data-je-*-tagged markers', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);

        const anyTagsEnabled = await page.evaluate(() => {
            const settings = (window as any).JellyfinEnhanced?.currentSettings || {};
            return ['qualityTagsEnabled', 'genreTagsEnabled', 'languageTagsEnabled', 'ratingTagsEnabled']
                .some((key) => settings[key] === true);
        });
        test.skip(!anyTagsEnabled, 'no tag renderer enabled for this user');

        await page.waitForSelector('#indexPage .card', { timeout: 60_000 });

        // The pipeline tags cards asynchronously (item lookups + batching).
        await page.waitForFunction(
            (attrs) => attrs.some((attr) => document.querySelectorAll(`[${attr}]`).length > 0),
            TAGGED_ATTRS,
            { timeout: 60_000 }
        );

        const counts = await page.evaluate((attrs) => {
            const byAttr: Record<string, number> = {};
            for (const attr of attrs) byAttr[attr] = document.querySelectorAll(`[${attr}]`).length;
            return { byAttr, cards: document.querySelectorAll('#indexPage .card').length };
        }, TAGGED_ATTRS);

        expect(counts.cards).toBeGreaterThan(0);
        const totalTagged = Object.values(counts.byAttr).reduce((sum, n) => sum + n, 0);
        expect(totalTagged).toBeGreaterThan(0);

        expect(consoleErrors.real()).toEqual([]);
    });
});
