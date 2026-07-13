// Bug fix guard (issue 689): the Requests Page requirements banner must treat
// its two data sources as INDEPENDENT and either-sufficient. A movie-only setup
// with only Radarr configured (no Sonarr, no Seerr) is enough for the downloads
// list, so the "Requirements:" line must hide — the old behaviour forced Sonarr
// AND Radarr AND Seerr all at once, blocking movie-only Radarr users.
//
// Drives the real embedded config page and manipulates the live DOM (never
// saving) so the scenario is deterministic regardless of the dev server's
// stored config.
import { test, expect, loginAs } from './fixtures/auth';
import { tmdbReady } from './fixtures/seerr';

/* eslint-disable @typescript-eslint/no-explicit-any */

const CONFIG_HASH = '#/configurationpage?name=Jellyfin%20Canopy';

// The reproducible docker seed is bare: with no TMDB key the config page never
// populates TMDB_API_KEY (this spec's "config page fully loaded" signal), so
// the 60s waitForFunction would time out rather than guard anything. Skip
// cleanly when TMDB is unconfigured (set TMDB_API_KEY at seed time to run).
const NEEDS_TMDB = 'TMDB not configured — set TMDB_API_KEY at seed time to run';

test.describe('requests page requirements gating', () => {
    test('Radarr-only (no Sonarr, no Seerr) satisfies the Requests Page requirement', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);
        test.skip(!(await tmdbReady(page)), NEEDS_TMDB);

        await page.evaluate((hash) => { window.location.hash = hash; }, CONFIG_HASH);

        // config-page.js is fetched + executed asynchronously AFTER the static
        // HTML is injected, and only it wires the reactive listeners, the add
        // buttons and the dependency passes. Waiting for static elements alone
        // would let the test run against the pre-config-page.js DOM. A populated
        // TMDB key only appears once loadConfig's getPluginConfiguration() has
        // resolved — i.e. after all of config-page.js's synchronous wiring — so
        // it is a reliable "config page fully ready" signal (same guard the
        // reviews-gating test uses).
        await page.waitForFunction(() => {
            const tmdb = document.getElementById('TMDB_API_KEY') as HTMLInputElement | null;
            return !!(tmdb && tmdb.value.trim().length > 0
                && document.getElementById('sonarrInstancesList')
                && document.getElementById('radarrInstancesList')
                && document.getElementById('addRadarrInstance')
                && document.getElementById('seerrUrls')
                && document.getElementById('SeerrApiKey')
                && document.getElementById('requestsPageRequirementsLine'));
        }, undefined, { timeout: 60_000 });

        // Build the exact reported scenario in the live DOM: blank every Sonarr
        // instance and both Seerr fields, then configure a single Radarr instance.
        const result = await page.evaluate(() => {
            function fire(el: Element) {
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }
            function setVal(el: HTMLInputElement | HTMLTextAreaElement | null, val: string) {
                if (!el) return;
                el.value = val;
                fire(el);
            }

            // 1. Clear all Sonarr instances (blank URL + API key on each card).
            document.querySelectorAll('#sonarrInstancesList .arr-instance-card').forEach((card) => {
                setVal(card.querySelector('.arr-instance-url'), '');
                setVal(card.querySelector('.arr-instance-apikey'), '');
            });

            // 2. Clear Seerr connection fields.
            setVal(document.getElementById('seerrUrls') as HTMLTextAreaElement, '');
            setVal(document.getElementById('SeerrApiKey') as HTMLInputElement, '');

            // 3. Ensure exactly one enabled Radarr instance with URL + API key.
            let radarrCard = document.querySelector('#radarrInstancesList .arr-instance-card');
            if (!radarrCard) {
                (document.getElementById('addRadarrInstance') as HTMLButtonElement).click();
                radarrCard = document.querySelector('#radarrInstancesList .arr-instance-card');
            }
            const enabled = radarrCard?.querySelector('.arr-instance-enabled') as HTMLInputElement | null;
            if (enabled && !enabled.checked) { enabled.checked = true; fire(enabled); }
            setVal(radarrCard?.querySelector('.arr-instance-url') as HTMLInputElement, 'http://127.0.0.1:7878');
            setVal(radarrCard?.querySelector('.arr-instance-apikey') as HTMLInputElement, 'deadbeefdeadbeefdeadbeefdeadbeef');

            const line = document.getElementById('requestsPageRequirementsLine') as HTMLElement;
            return { lineDisplay: line.style.display };
        });

        // The fix: with a working Radarr and nothing else, the requirement is met
        // and the banner hides. Under the old AND-of-three logic this stayed shown.
        expect(result.lineDisplay, 'Requests requirements line must hide with Radarr-only configured').toBe('none');
    });

    test('With nothing configured, the requirement does not single out Sonarr as mandatory', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);
        test.skip(!(await tmdbReady(page)), NEEDS_TMDB);

        await page.evaluate((hash) => { window.location.hash = hash; }, CONFIG_HASH);
        // Wait for config-page.js to finish loading (populated TMDB key) so the
        // reactive banner logic is wired before we manipulate fields.
        await page.waitForFunction(() => {
            const tmdb = document.getElementById('TMDB_API_KEY') as HTMLInputElement | null;
            return !!(tmdb && tmdb.value.trim().length > 0
                && document.getElementById('requestsPageRequirementsLine')
                && document.getElementById('seerrUrls')
                && document.getElementById('SeerrApiKey'));
        }, undefined, { timeout: 60_000 });

        const state = await page.evaluate(() => {
            function fire(el: Element) {
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }
            function setVal(el: HTMLInputElement | HTMLTextAreaElement | null, val: string) {
                if (!el) return;
                el.value = val;
                fire(el);
            }
            // Blank both arr services and Seerr.
            document.querySelectorAll('#sonarrInstancesList .arr-instance-card, #radarrInstancesList .arr-instance-card').forEach((card) => {
                setVal(card.querySelector('.arr-instance-url'), '');
                setVal(card.querySelector('.arr-instance-apikey'), '');
            });
            setVal(document.getElementById('seerrUrls') as HTMLTextAreaElement, '');
            setVal(document.getElementById('SeerrApiKey') as HTMLInputElement, '');

            const line = document.getElementById('requestsPageRequirementsLine') as HTMLElement;
            const list = document.getElementById('requestsPageRequirementsList') as HTMLElement;
            return { lineDisplay: line.style.display, text: (list.textContent || '') };
        });

        // With nothing configured the line is shown, but it offers Sonarr and
        // Radarr as alternatives ("Sonarr or Radarr") rather than demanding both.
        expect(state.lineDisplay, 'Requirements line should show when nothing is configured').not.toBe('none');
        expect(state.text).toContain('Sonarr or Radarr');
        expect(state.text.toLowerCase()).toContain('and/or');
    });
});
