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
import { tmdbReady } from './fixtures/seerr';

/* eslint-disable @typescript-eslint/no-explicit-any */

const CONFIG_HASH = '#/configurationpage?name=Jellyfin%20Enhanced';

// The reproducible docker seed is bare: with no TMDB key the config page never
// populates TMDB_API_KEY, so this scenario's precondition can't be met and the
// old 60s waitForFunction would time out rather than guard anything. Skip
// cleanly when TMDB is unconfigured (set TMDB_API_KEY at seed time to run).
const NEEDS_TMDB = 'TMDB not configured — set TMDB_API_KEY at seed time to run';

test.describe('reviews gating', () => {
    test('Show TMDB Reviews is toggleable with Elsewhere OFF + TMDB key set', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);
        test.skip(!(await tmdbReady(page)), NEEDS_TMDB);

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

    // Same bug class: Default Region / Default Providers / Ignore Providers are
    // read by TMDB Release Dates (Default Region) and the Seerr poster streaming
    // icons (all three) — neither depends on the Elsewhere panel — so they must
    // NOT be greyed out just because "Enable Elsewhere" is off. Only the custom
    // branding fields belong to Elsewhere alone.
    test('Provider inputs stay editable with Elsewhere OFF', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);
        test.skip(!(await tmdbReady(page)), NEEDS_TMDB);

        await page.evaluate((hash) => { window.location.hash = hash; }, CONFIG_HASH);
        // A populated TMDB key signals config-page.js has finished loadConfig and
        // run its dependency passes — waiting on the static inputs alone would let
        // us assert before the parent-dep gate has (or hasn't) disabled anything.
        await page.waitForFunction(() => {
            const tmdb = document.getElementById('TMDB_API_KEY') as HTMLInputElement | null;
            return !!(tmdb && tmdb.value.trim().length > 0
                && document.getElementById('elsewhereEnabled')
                && document.getElementById('DEFAULT_REGION')
                && document.getElementById('DEFAULT_PROVIDERS')
                && document.getElementById('IGNORE_PROVIDERS')
                && document.getElementById('ElsewhereCustomBrandingText'));
        }, undefined, { timeout: 60_000 });

        const state = await page.evaluate(() => {
            // Force Elsewhere OFF and re-run the dependency passes via a change event.
            const elsewhere = document.getElementById('elsewhereEnabled') as HTMLInputElement;
            if (elsewhere.checked) { elsewhere.checked = false; }
            elsewhere.dispatchEvent(new Event('change', { bubbles: true }));
            elsewhere.dispatchEvent(new Event('input', { bubbles: true }));

            function probe(id: string) {
                const el = document.getElementById(id) as HTMLInputElement;
                const container = el.closest('.inputContainer') as HTMLElement | null;
                return {
                    disabled: el.disabled,
                    depAttr: el.getAttribute('data-dep-disabled') || '',
                    dimmed: container ? container.style.opacity === '0.5' : false,
                };
            }
            return {
                elsewhereChecked: elsewhere.checked,
                region: probe('DEFAULT_REGION'),
                providers: probe('DEFAULT_PROVIDERS'),
                ignore: probe('IGNORE_PROVIDERS'),
                // Control: the branding field SHOULD still be gated by Elsewhere.
                brandingDisabled: (document.getElementById('ElsewhereCustomBrandingText') as HTMLInputElement | null)?.disabled ?? null,
            };
        });

        expect(state.elsewhereChecked, 'precondition: Elsewhere is OFF').toBe(false);

        for (const [name, p] of [['Default Region', state.region], ['Default Providers', state.providers], ['Ignore Providers', state.ignore]] as const) {
            expect(p.disabled, `${name} must not be disabled with Elsewhere off`).toBe(false);
            expect(p.depAttr, `${name} must carry no parent-dep tag`).not.toContain('parent-elsewhereEnabled');
            expect(p.dimmed, `${name} must not be dimmed by a parent dep`).toBe(false);
        }

        // The branding field is Elsewhere-only, so it SHOULD be disabled here —
        // proving the fix narrowed the gate rather than removing it wholesale.
        expect(state.brandingDisabled, 'Custom Branding stays gated by Elsewhere').toBe(true);
    });
});
