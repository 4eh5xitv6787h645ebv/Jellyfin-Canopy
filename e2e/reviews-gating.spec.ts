// Bug fix guard: "Show TMDB Reviews" must be independently toggleable and is
// NOT gated behind the "Enable Elsewhere" master switch. TMDB Reviews render
// off (ShowReviews && TmdbEnabled) with no Elsewhere dependency, so leaving the
// admin unable to turn reviews off while Elsewhere is disabled (the previous
// behaviour) both contradicted runtime and trapped the reviews as always-on.
//
// The dep only needs a TMDB API key (the INDIVIDUAL_DEP that legitimately gates
// showReviews). This spec drives the real embedded config page, which the dev
// server already has in the exact bug state (ElsewhereEnabled=false,
// ShowReviews=true, TMDB key set).
import { test, expect, loginAs } from './fixtures/auth';

/* eslint-disable @typescript-eslint/no-explicit-any */

const CONFIG_HASH = '#/configurationpage?name=Jellyfin%20Enhanced';

test.describe('reviews gating', () => {
    test('Show TMDB Reviews is toggleable with Elsewhere OFF + TMDB key set', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);

        // Route to the plugin config page and let config-page.js load values +
        // run its dependency passes.
        await page.evaluate((hash) => { window.location.hash = hash; }, CONFIG_HASH);

        // Wait for the config page controls to exist and config-page.js to have
        // populated the TMDB key and the Elsewhere/Reviews checkboxes.
        await page.waitForFunction(() => {
            const key = document.getElementById('TMDB_API_KEY') as HTMLInputElement | null;
            const elsewhere = document.getElementById('elsewhereEnabled') as HTMLInputElement | null;
            const reviews = document.getElementById('showReviews') as HTMLInputElement | null;
            return !!(key && elsewhere && reviews && key.value.trim().length > 0);
        }, undefined, { timeout: 60_000 });

        // Preconditions that make this test meaningful (the reported scenario).
        const state = await page.evaluate(() => {
            const elsewhere = document.getElementById('elsewhereEnabled') as HTMLInputElement;
            const reviews = document.getElementById('showReviews') as HTMLInputElement;
            const label = reviews.closest('label');
            const container = reviews.closest('.checkboxContainer');
            return {
                elsewhereChecked: elsewhere.checked,
                reviewsDisabled: reviews.disabled,
                // The parent-dep hint that WAS injected when Elsewhere gated reviews.
                hasElsewhereHint: !!(container?.querySelector('.parent-hint-elsewhereEnabled')
                    || label?.querySelector('.parent-hint-elsewhereEnabled')),
                depDisabledAttr: reviews.getAttribute('data-dep-disabled') || '',
            };
        });

        // Precondition: Elsewhere is OFF (the trigger for the old bug).
        expect(state.elsewhereChecked, 'Enable Elsewhere should be unchecked for this scenario').toBe(false);

        // The fix: with a TMDB key present, Show TMDB Reviews stays enabled and
        // carries no "Enable Elsewhere to configure" hint, so the admin can turn
        // reviews off independently.
        expect(state.reviewsDisabled, 'Show TMDB Reviews must not be disabled').toBe(false);
        expect(state.hasElsewhereHint, 'no "Enable Elsewhere to configure" hint on reviews').toBe(false);
        expect(state.depDisabledAttr).not.toContain('parent-elsewhereEnabled');

        // Belt-and-suspenders: the label carrying the greyed-out state must also be
        // clear of the parent-dep opacity/cursor styling that the old gating applied.
        const labelDimmed = await page.evaluate(() => {
            const reviews = document.getElementById('showReviews') as HTMLInputElement;
            const container = reviews.closest('.checkboxContainer') as HTMLElement | null;
            return container ? container.style.opacity === '0.5' : false;
        });
        expect(labelDimmed, 'Show TMDB Reviews container must not be dimmed by a parent dep').toBe(false);
    });
});
