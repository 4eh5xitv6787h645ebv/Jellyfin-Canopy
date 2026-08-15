// Tag pipeline: library cards on the home screen get the renderers'
// data-jc-*-tagged processed markers (quality/genre/language/rating renderers
// share tag-renderer-base, which stamps `spec.taggedAttr` on each card).
//
// The spec skips itself when no tag renderer is enabled for the logged-in
// user, so it stays meaningful across differently-configured servers.
import {
    test,
    expect,
    loginAs,
    showRoute,
    waitForHash,
    assertNoRuntimeErrors,
} from './fixtures/auth';

/* eslint-disable @typescript-eslint/no-explicit-any */

// setting flag → the marker each family's renderer stamps on a tagged card.
const FAMILIES = [
    { setting: 'qualityTagsEnabled', attr: 'data-jc-quality-tagged' },
    { setting: 'genreTagsEnabled', attr: 'data-jc-genre-tagged' },
    { setting: 'languageTagsEnabled', attr: 'data-jc-language-tagged' },
    { setting: 'ratingTagsEnabled', attr: 'data-jc-rating-tagged' },
] as const;

test.describe('tags', () => {
    test.use({ serviceWorkers: 'block' });

    test('language allowlist orders regional poster flags before the three-item limit', async ({ page, consoleErrors }) => {
        await page.addInitScript(() => localStorage.setItem('layout', 'experimental'));
        const cacheRoute = '**/JellyfinCanopy/tag-cache/**';
        await page.route(cacheRoute, async (route) => {
            const response = await route.fetch();
            const body = await response.json() as Record<string, any>;
            const items = body.items ?? body.Items;
            if (items && typeof items === 'object') {
                for (const entry of Object.values(items) as any[]) {
                    if (entry && typeof entry === 'object' && entry.Type !== 'BoxSet') {
                        entry.AudioLanguages = ['de-DE', 'en-US', 'fr-FR', 'pt-BR'];
                    }
                }
            }
            await route.fulfill({ response, json: body });
        });
        await loginAs(page, 'admin', consoleErrors);
        const original = await page.evaluate(() => {
            const settings = (window as any).JellyfinCanopy.currentSettings;
            return ['languageTagsEnabled', 'languageTagFilter']
                .reduce((snapshot: Record<string, { has: boolean; value: unknown }>, key) => {
                    snapshot[key] = {
                        has: Object.prototype.hasOwnProperty.call(settings, key),
                        value: structuredClone(settings[key]),
                    };
                    return snapshot;
                }, {});
        });
        const fixtureItemId = await page.evaluate(async () => {
            const api = (window as any).ApiClient;
            const result = await api.getItems(api.getCurrentUserId(), {
                IncludeItemTypes: 'Movie',
                Recursive: true,
                Fields: 'Path,MediaSources,MediaStreams',
                Limit: 100,
            });
            const item = (result?.Items || []).find((candidate: any) =>
                candidate.Path === '/media/Movies/Echo Meridian (2025).mkv');
            if (!item?.Id) throw new Error('issue 718 multilingual fixture is missing');
            return item.Id as string;
        });
        try {
            await showRoute(page, `/details?id=${fixtureItemId}`);
            await waitForHash(page, fixtureItemId);
            await page.waitForSelector('#itemDetailPage:not(.hide) .detailPagePrimaryContainer', {
                timeout: 60_000,
            });

            const readPersistedPolicy = async (): Promise<unknown> => page.evaluate(async () => {
                const api = (window as any).ApiClient;
                const value = await api.ajax({
                    type: 'GET',
                    url: api.getUrl(
                        `/JellyfinCanopy/user-settings/${encodeURIComponent(api.getCurrentUserId())}/settings.json`
                    ),
                    dataType: 'json',
                });
                return structuredClone(value.LanguageTagFilter ?? value.languageTagFilter ?? null);
            });
            const openLanguageChoices = async () => {
                await page.evaluate(() => { void (window as any).JellyfinCanopy.showEnhancedPanel(); });
                const panel = page.locator('#jellyfin-canopy-panel');
                await expect(panel).toBeVisible({ timeout: 15_000 });
                await panel.locator('.tab-button[data-tab="ui"]').click();
                await expect(panel.locator('.jc-pane[data-pane="ui"]')).toBeVisible();
                const enabled = panel.locator('#languageTagsToggle');
                if (!await enabled.isChecked()) await enabled.setChecked(true);
                await panel.locator('#languageTagFilterMode').selectOption('custom');
                return {
                    panel,
                    choices: panel.locator('#languageTagFilterLanguages'),
                };
            };
            const closePanel = async (panel: ReturnType<typeof page.locator>): Promise<void> => {
                await page.keyboard.press('Escape');
                await expect(panel).toBeHidden({ timeout: 10_000 });
            };

            // The real settings surface is a bounded selection populated by the
            // acting user's server-side accessible-library projection. It has no
            // free-form input or DOM-derived datalist escape hatch.
            const firstEditor = await openLanguageChoices();
            const inventory = await page.evaluate(async () => {
                const api = (window as any).ApiClient;
                return api.ajax({
                    type: 'GET',
                    url: api.getUrl(
                        `/JellyfinCanopy/language-tag-inventory/${encodeURIComponent(api.getCurrentUserId())}`
                    ),
                    dataType: 'json',
                });
            }) as Record<string, any>;
            const inventoryLanguages = inventory.Languages ?? inventory.languages;
            expect(inventoryLanguages).toEqual([...inventoryLanguages].sort());
            expect(inventoryLanguages.length).toBeLessThanOrEqual(128);
            expect(inventoryLanguages).toEqual(expect.arrayContaining(['en-US', 'pt-BR']));
            expect(await firstEditor.choices.locator('option[data-known="true"]').allTextContents())
                .toEqual(inventoryLanguages);
            expect(await firstEditor.choices.evaluate((element) => element.tagName)).toBe('SELECT');
            await expect(firstEditor.panel.locator('datalist')).toHaveCount(0);
            await expect(firstEditor.panel.locator('#languageTagKnownValues')).toHaveCount(0);

            // Establish one known policy through the real control, then change it
            // again while the details route remains open. The second acknowledged
            // save must replace both existing poster and details rows without a
            // navigation or reload.
            await firstEditor.choices.selectOption(['en-US']);
            const englishPolicy = {
                schemaVersion: 1,
                languages: ['en-US'],
                includeOriginal: false,
            };
            await expect.poll(readPersistedPolicy, {
                timeout: 60_000,
                message: 'the first inventory-backed policy is acknowledged',
            }).toEqual(englishPolicy);
            await closePanel(firstEditor.panel);

            const detailsLanguages = page.locator(
                '#itemDetailPage:not(.hide) .itemMiscInfo-primary '
                + '.mediaInfoItem-audioLanguage .audio-language-item',
            );
            await expect(detailsLanguages).toHaveCount(1, { timeout: 60_000 });
            await expect(detailsLanguages.first()).toHaveAttribute('data-lang', 'en-US');

            const secondEditor = await openLanguageChoices();
            await secondEditor.choices.selectOption(['en-US', 'pt-BR']);
            await secondEditor.choices.locator('option[value="pt-BR"]').evaluate((option) => {
                option.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            const movesToFirst = await secondEditor.choices.locator('option[value="pt-BR"]')
                .evaluate((option) => (option as HTMLOptionElement).index);
            for (let index = 0; index < movesToFirst; index++) {
                await secondEditor.panel.locator('#languageTagFilterMoveUp').click();
            }
            const regionalPolicy = {
                schemaVersion: 1,
                languages: ['pt-BR', 'en-US'],
                includeOriginal: false,
            };
            await expect.poll(readPersistedPolicy, {
                timeout: 60_000,
                message: 'the reordered inventory-backed policy is acknowledged',
            }).toEqual(regionalPolicy);
            await expect.poll(() => page.evaluate(() =>
                structuredClone((window as any).JellyfinCanopy.currentSettings?.languageTagFilter ?? null)), {
                timeout: 60_000,
                message: 'the acknowledged policy is active in the acting-user runtime',
            }).toEqual(regionalPolicy);
            await closePanel(secondEditor.panel);

            const detailPoster = page.locator(
                '#itemDetailPage:not(.hide) .detailPagePrimaryContainer .card, '
                + '#itemDetailPage:not(.hide) .detailImageContainer .card',
            ).filter({ has: page.locator('.language-overlay-container') }).first();
            await expect(detailPoster.locator('.language-tag-presentation[data-region="BR"]'))
                .toHaveCount(1, { timeout: 60_000 });
            const posterRegions = await detailPoster.locator('.language-tag-presentation')
                .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.region));
            expect(posterRegions).toEqual(['BR', 'US']);
            expect(posterRegions).toHaveLength(2);

            await expect(detailsLanguages).toHaveCount(2, { timeout: 60_000 });
            expect(await detailsLanguages.evaluateAll((nodes) => nodes.map((node) => ({
                language: (node as HTMLElement).dataset.lang,
                region: (node as HTMLElement).dataset.region,
            })))).toEqual([
                { language: 'pt-BR', region: 'BR' },
                { language: 'en-US', region: 'US' },
            ]);

            await showRoute(page, '/home');
            await page.waitForSelector('#indexPage .card', { timeout: 60_000 });
            const cardRegions = await page.locator('#indexPage .card .language-overlay-container')
                .first().locator('.language-tag-presentation')
                .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.region));
            expect(cardRegions).toEqual(['BR', 'US']);
            expect(consoleErrors.real()).toEqual([]);
        } finally {
            await page.waitForFunction(() => !!(window as any).JellyfinCanopy.currentSettings, undefined, {
                timeout: 60_000,
            });
            await page.evaluate(async (snapshot) => {
                const canopy = (window as any).JellyfinCanopy;
                for (const [key, state] of Object.entries(snapshot) as Array<[
                    string,
                    { has: boolean; value: unknown },
                ]>) {
                    if (state.has) canopy.currentSettings[key] = state.value;
                    else delete canopy.currentSettings[key];
                }
                await canopy.saveUserSettings('settings.json', canopy.currentSettings);
            }, original);
            await page.unroute(cacheRoute);
        }
    });

    test('8K dimensions render from a title-sanitized server-cache projection', async ({ page, consoleErrors }) => {
        let injectedEntries = 0;
        const cacheRoute = '**/JellyfinCanopy/tag-cache/**';
        await page.route(cacheRoute, async (route) => {
            if (route.request().method() !== 'GET') {
                await route.continue();
                return;
            }

            const response = await route.fetch();
            const body = await response.json() as Record<string, any>;
            const items = body.items ?? body.Items;
            if (items && typeof items === 'object') {
                for (const entry of Object.values(items) as any[]) {
                    if (!entry || typeof entry !== 'object') continue;
                    entry.StreamData = {
                        ...(entry.StreamData || {}),
                        Streams: [{
                            Type: 'Video',
                            Codec: 'hevc',
                            Width: 8192,
                            Height: 4096,
                            DisplayTitle: null,
                        }],
                        Sources: [],
                    };
                    injectedEntries++;
                }
            }
            await route.fulfill({ response, json: body });
        });

        await loginAs(page, 'admin', consoleErrors);
        const original = await page.evaluate(() => {
            const settings = (window as any).JellyfinCanopy.currentSettings;
            return {
                hasEnabled: Object.prototype.hasOwnProperty.call(settings, 'qualityTagsEnabled'),
                enabled: settings.qualityTagsEnabled,
                hasResolution: Object.prototype.hasOwnProperty.call(settings, 'showResolutionTag'),
                resolution: settings.showResolutionTag,
            };
        });

        try {
            await page.evaluate(async () => {
                const jc = (window as any).JellyfinCanopy;
                jc.currentSettings.qualityTagsEnabled = true;
                jc.currentSettings.showResolutionTag = true;
                await jc.saveUserSettings('settings.json', jc.currentSettings);
            });
            await page.reload({ waitUntil: 'domcontentloaded' });
            consoleErrors.reset();
            await page.waitForFunction(
                () => (window as any).JellyfinCanopy?.initialized === true
                    && (window as any).JellyfinCanopy?.currentSettings?.qualityTagsEnabled === true,
                undefined,
                { timeout: 60_000 },
            );
            await page.waitForSelector('#indexPage .card', { timeout: 60_000 });

            const tag = page.locator('.quality-overlay-label[data-quality="8K"]').first();
            await expect(tag).toBeVisible({ timeout: 60_000 });
            await expect(tag).toHaveText('8K');
            expect(injectedEntries, 'the real per-user tag-cache response was dimension-injected')
                .toBeGreaterThan(0);
            expect(consoleErrors.unexpected5xx(), 'unexpected 5xx responses').toEqual([]);
            expect(consoleErrors.real()).toEqual([]);
        } finally {
            await page.evaluate(async (snapshot) => {
                const jc = (window as any).JellyfinCanopy;
                const settings = jc.currentSettings;
                if (snapshot.hasEnabled) settings.qualityTagsEnabled = snapshot.enabled;
                else delete settings.qualityTagsEnabled;
                if (snapshot.hasResolution) settings.showResolutionTag = snapshot.resolution;
                else delete settings.showResolutionTag;
                await jc.saveUserSettings('settings.json', settings);
            }, original);
            await page.unroute(cacheRoute);
        }
    });

    test('home library cards get data-jc-*-tagged markers per enabled family', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);

        // Only the families ENABLED for this user are asserted — but each of
        // them independently. (The old test summed all four and asserted the
        // total > 0, so one working family masked three dead ones.)
        const enabled: string[] = await page.evaluate((families) => {
            const settings = (window as any).JellyfinCanopy?.currentSettings || {};
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

        expect(consoleErrors.unexpected5xx(), 'unexpected 5xx responses').toEqual([]);
        expect(consoleErrors.real()).toEqual([]);
    });

    test('Series and season language coverage render full and partial states', async ({
        page,
        consoleErrors,
    }, testInfo) => {
            await page.addInitScript(() => localStorage.setItem('layout', 'experimental'));
            await loginAs(page, 'admin', consoleErrors);
            const fixture = await page.evaluate(async () => {
                const api = (window as any).ApiClient;
                const canopy = (window as any).JellyfinCanopy;
                const userId = api.getCurrentUserId();
                const result = await api.getItems(userId, {
                    IncludeItemTypes: 'Series',
                    Recursive: true,
                    SearchTerm: 'Guard Test Show',
                    Limit: 10,
                });
                const matches = (result?.Items || []).filter((item: any) => item.Name === 'Guard Test Show');
                const series = matches[0];
                const seasonResult = series
                    ? await api.getItems(userId, {
                        ParentId: series.Id,
                        IncludeItemTypes: 'Season',
                        Recursive: false,
                    })
                    : null;
                const seasonOne = (seasonResult?.Items || []).find((item: any) => item.Name === 'Season 1');
                const hadSetting = Object.prototype.hasOwnProperty.call(
                    canopy.currentSettings,
                    'languageTagsEnabled',
                );
                const setting = canopy.currentSettings.languageTagsEnabled;
                return {
                    matchCount: matches.length,
                    seriesId: series?.Id || '',
                    seasonOneId: seasonOne?.Id || '',
                    hadSetting,
                    setting,
                    modern: document.documentElement.classList.contains('jc-modern-layout'),
                };
            });

            expect(fixture.matchCount).toBe(1);
            expect(fixture.seriesId).not.toBe('');
            expect(fixture.seasonOneId).not.toBe('');
            expect(fixture.modern).toBe(true);

            try {
                const coverage = await page.evaluate(async ({ seriesId, seasonOneId }) => {
                    const api = (window as any).ApiClient;
                    const canopy = (window as any).JellyfinCanopy;
                    canopy.currentSettings.languageTagsEnabled = true;
                    await canopy.saveUserSettings('settings.json', canopy.currentSettings);
                    canopy.reinitializeLanguageTags();

                    const userId = api.getCurrentUserId();
                    const cache = await api.ajax({
                        type: 'GET',
                        url: api.getUrl(`/JellyfinCanopy/tag-cache/${userId}`),
                        dataType: 'json',
                    });
                    const coverageFor = (id: unknown) => {
                        const key = String(id || '').replace(/-/g, '').toLowerCase();
                        return cache?.languageCoverage?.[key] || null;
                    };
                    return {
                        series: coverageFor(seriesId),
                        seasonOne: coverageFor(seasonOneId),
                    };
                }, { seriesId: fixture.seriesId, seasonOneId: fixture.seasonOneId });

                expect(coverage.series).toMatchObject({
                    EligibleEpisodeCount: 4,
                    ObservedEpisodeCount: 4,
                    Complete: true,
                    FullLanguages: ['en'],
                    PartialLanguages: ['ja'],
                    UnknownLanguages: [],
                    Truncated: false,
                });
                expect(coverage.seasonOne).toMatchObject({
                    EligibleEpisodeCount: 2,
                    ObservedEpisodeCount: 2,
                    Complete: true,
                    FullLanguages: ['en'],
                    PartialLanguages: ['ja'],
                    UnknownLanguages: [],
                    Truncated: false,
                });

                await showRoute(page, `/details?id=${fixture.seriesId}`);
                await waitForHash(page, fixture.seriesId);
                const poster = page.locator(
                    '#itemDetailPage:not(.hide) .detailImageContainer .card',
                ).filter({ has: page.locator('.language-coverage-partial') }).first();
                const full = poster.locator('.language-coverage-full');
                const partial = poster.locator('.language-coverage-partial');
                await expect(full).toHaveCount(1, { timeout: 60_000 });
                await expect(partial).toHaveCount(1);
                await expect(full).toHaveAttribute('data-lang-tags', '["en"]');
                await expect(partial).toHaveAttribute('data-lang-tags', '["ja"]');
                const fullLabel = await full.getAttribute('aria-label');
                const partialLabel = await partial.getAttribute('aria-label');
                const fullCount = fullLabel?.match(/full coverage across (\d+) eligible episodes/)?.[1];
                const partialCount = partialLabel?.match(/partial coverage across (\d+) eligible episodes/)?.[1];
                expect(fullCount).toBe(String(coverage.series.EligibleEpisodeCount));
                expect(partialCount).toBe(fullCount);
                expect(await full.evaluate((element) => getComputedStyle(element, '::after').content)).toBe('"✓"');
                expect(await partial.evaluate((element) => getComputedStyle(element, '::after').content)).toBe('"◐"');

                await page.setViewportSize({ width: 390, height: 844 });
                const bounds = await poster.locator('.language-overlay-container').evaluate((element) => {
                    const overlay = element as HTMLElement;
                    const card = overlay.closest<HTMLElement>('.card');
                    const overlayRect = overlay.getBoundingClientRect();
                    const cardRect = card?.getBoundingClientRect();
                    return {
                        insideCard: !!cardRect
                            && overlayRect.left >= cardRect.left - 1
                            && overlayRect.right <= cardRect.right + 1,
                        noHorizontalOverflow: overlay.scrollWidth <= overlay.clientWidth + 1,
                    };
                });
                expect(bounds).toEqual({ insideCard: true, noHorizontalOverflow: true });
                await poster.screenshot({ path: testInfo.outputPath('issue-667-modern.png') });

                await showRoute(page, `/details?id=${fixture.seasonOneId}`);
                await waitForHash(page, fixture.seasonOneId);
                const seasonPoster = page.locator(
                    '#itemDetailPage:not(.hide) .detailImageContainer .card',
                ).filter({ has: page.locator('.language-coverage-partial') }).first();
                const seasonCount = String(coverage.seasonOne.EligibleEpisodeCount);
                await expect(seasonPoster.locator('.language-coverage-full')).toHaveAttribute(
                    'aria-label',
                    new RegExp(`full coverage across ${seasonCount} eligible episodes`),
                    { timeout: 60_000 },
                );
                await expect(seasonPoster.locator('.language-coverage-partial')).toHaveAttribute(
                    'aria-label',
                    new RegExp(`partial coverage across ${seasonCount} eligible episodes`),
                );
                assertNoRuntimeErrors(consoleErrors);
            } finally {
                if (!page.isClosed()) {
                    await page.evaluate(async ({ hadSetting, setting }) => {
                        const canopy = (window as any).JellyfinCanopy;
                        if (hadSetting) canopy.currentSettings.languageTagsEnabled = setting;
                        else delete canopy.currentSettings.languageTagsEnabled;
                        await canopy.saveUserSettings('settings.json', canopy.currentSettings);
                        canopy.reinitializeLanguageTags();
                    }, { hadSetting: fixture.hadSetting, setting: fixture.setting });
                }
            }
        });

    test('Collection language coverage has poster and details parity', async ({
        page,
        consoleErrors,
    }, testInfo) => {
        await page.addInitScript(() => localStorage.setItem('layout', 'experimental'));
        await loginAs(page, 'admin', consoleErrors);
        const fixture = await page.evaluate(async () => {
            const api = (window as any).ApiClient;
            const canopy = (window as any).JellyfinCanopy;
            const userId = api.getCurrentUserId();
            const result = await api.getItems(userId, {
                IncludeItemTypes: 'Movie',
                Recursive: true,
                Fields: 'Path,MediaStreams,MediaSources',
                Limit: 200,
            });
            const expectedPaths = [
                '/media/Movies/Alpha Adventure (2021).mp4',
                '/media/Movies/Beta Voyage (2022).mp4',
            ];
            const members = expectedPaths.map((path) =>
                (result?.Items || []).find((item: any) => item.Path === path));
            if (members.some((item) => !item?.Id)) {
                throw new Error('issue 668 deterministic English movie fixtures are missing');
            }
            const memberLanguages = members.map((item) => {
                const streams = [
                    ...(item.MediaStreams || []),
                    ...(item.MediaSources || []).flatMap((source: any) => source.MediaStreams || []),
                ];
                return [...new Set(streams
                    .filter((stream: any) => stream?.Type === 'Audio')
                    .map((stream: any) => String(stream.Language || '').toLowerCase())
                    .filter(Boolean))];
            });
            if (memberLanguages.some((languages) =>
                !languages.some((language) => language === 'en' || language === 'eng'))) {
                throw new Error('issue 668 movie fixtures do not expose deterministic English audio');
            }
            const settings = ['languageTagsEnabled', 'showAudioLanguages']
                .reduce((snapshot: Record<string, { has: boolean; value: unknown }>, key) => {
                    snapshot[key] = {
                        has: Object.prototype.hasOwnProperty.call(canopy.currentSettings, key),
                        value: canopy.currentSettings[key],
                    };
                    return snapshot;
                }, {});
            return {
                memberIds: members.map((item) => item.Id),
                memberLanguages,
                settings,
            };
        });

        expect(fixture.memberIds).toHaveLength(2);
        expect(fixture.memberLanguages.every((languages) =>
            languages.some((language) => language === 'en' || language === 'eng'))).toBe(true);
        let collectionId = '';

        try {
            collectionId = await page.evaluate(async (memberIds) => {
                const api = (window as any).ApiClient;
                const name = `JC Issue 668 Coverage ${Date.now()}-${Math.random().toString(36).slice(2)}`;
                const created = await api.ajax({
                    type: 'POST',
                    url: api.getUrl('Collections', { Name: name, Ids: memberIds.join(',') }),
                    dataType: 'json',
                });
                if (!created?.Id) throw new Error('issue 668 BoxSet creation returned no item ID');
                return created.Id;
            }, fixture.memberIds);
            expect(collectionId).not.toBe('');

            await page.evaluate(async () => {
                const canopy = (window as any).JellyfinCanopy;
                canopy.currentSettings.languageTagsEnabled = true;
                canopy.currentSettings.showAudioLanguages = true;
                await canopy.saveUserSettings('settings.json', canopy.currentSettings);
                canopy.reinitializeLanguageTags();
            });

            await expect.poll(async () => page.evaluate(async (id) => {
                const api = (window as any).ApiClient;
                const cache = await api.ajax({
                    type: 'GET',
                    url: api.getUrl(`/JellyfinCanopy/tag-cache/${api.getCurrentUserId()}`),
                    dataType: 'json',
                });
                const key = String(id).replace(/-/g, '').toLowerCase();
                return cache?.collectionLanguageCoverage?.[key] || null;
            }, collectionId), {
                timeout: 60_000,
                intervals: [250, 500, 1_000],
                message: 'new BoxSet reaches caller-scoped tag-cache projection',
            }).toEqual({
                EligibleMemberCount: 2,
                ObservedMemberCount: 2,
                Complete: true,
                FullLanguages: ['en'],
                PartialLanguages: [],
                UnknownLanguages: [],
                Truncated: false,
                OmittedLanguageCount: 0,
            });

            await showRoute(page, `/details?id=${collectionId}`);
            await waitForHash(page, collectionId);
            const detailPoster = page.locator(
                '#itemDetailPage:not(.hide) .detailPagePrimaryContainer .card, '
                + '#itemDetailPage:not(.hide) .detailImageContainer .card',
            ).filter({ has: page.locator('.language-coverage-full') }).first();
            const posterCoverage = detailPoster.locator('.language-coverage-full');
            const detailsCoverage = page.locator(
                '#itemDetailPage:not(.hide) .mediaInfoItem-audioLanguage '
                + '.audio-language-coverage-full',
            ).first();
            await expect(posterCoverage).toHaveAttribute('data-lang-tags', '["en"]', {
                timeout: 60_000,
            });
            await expect(detailsCoverage).toHaveAttribute('data-lang-tags', '["en"]', {
                timeout: 60_000,
            });
            await expect(posterCoverage).toHaveAttribute(
                'aria-label',
                /full coverage across 2 eligible members/,
            );
            await expect(detailsCoverage).toHaveAttribute(
                'aria-label',
                /full coverage across 2 eligible members/,
            );
            await detailPoster.screenshot({ path: testInfo.outputPath('issue-668-modern.png') });
            assertNoRuntimeErrors(consoleErrors);
        } finally {
            if (!page.isClosed()) {
                await page.evaluate(async ({ id, settings }) => {
                    const api = (window as any).ApiClient;
                    const canopy = (window as any).JellyfinCanopy;
                    window.location.hash = '#/home';
                    if (id) {
                        await api.ajax({ type: 'DELETE', url: api.getUrl(`Items/${id}`) });
                    }
                    for (const [key, snapshot] of Object.entries(settings) as Array<[
                        string,
                        { has: boolean; value: unknown },
                    ]>) {
                        if (snapshot.has) canopy.currentSettings[key] = snapshot.value;
                        else delete canopy.currentSettings[key];
                    }
                    await canopy.saveUserSettings('settings.json', canopy.currentSettings);
                    canopy.reinitializeLanguageTags();
                }, { id: collectionId, settings: fixture.settings });
            }
        }
    });

    test('single-digit Jellyfin critic values stay single-digit on real poster cards', async ({ page, consoleErrors }) => {
        const routePattern = '**/JellyfinCanopy/tag-cache/**';
        const injectedIds = new Set<string>();
        await page.route(routePattern, async (route) => {
            const response = await route.fetch();
            const url = new URL(route.request().url());
            const body = await response.json() as {
                items?: Record<string, Record<string, unknown>>;
                Items?: Record<string, Record<string, unknown>>;
            };

            // Modify only the full projected snapshot. Cursor validation/delta
            // responses must remain byte-semantically honest or the pipeline
            // will correctly discard the prefetch and request another snapshot.
            const items = body.items ?? body.Items;
            if (url.search === '' && items && typeof items === 'object') {
                for (const [id, rawEntry] of Object.entries(items)) {
                    if (!rawEntry || rawEntry.RatingSuppressed === true) continue;
                    items[id] = {
                        ...rawEntry,
                        CommunityRating: null,
                        CriticRating: 7,
                    };
                    injectedIds.add(id.replace(/-/g, '').toLowerCase());
                }
            }

            await route.fulfill({ response, json: body });
        });

        try {
            await loginAs(page, 'admin', consoleErrors);
            expect(await page.evaluate(() => (
                (window as any).JellyfinCanopy?.currentSettings?.ratingTagsEnabled
            ))).toBe(true);
            await expect.poll(() => injectedIds.size, { timeout: 60_000 }).toBeGreaterThan(0);
            await page.waitForSelector('#indexPage .card', { timeout: 60_000 });

            const ids = [...injectedIds];
            await page.waitForFunction((expectedIds) => {
                const expected = new Set(expectedIds);
                return [...document.querySelectorAll<HTMLElement>('#indexPage .cardImageContainer')]
                    .some((image) => {
                        const backgroundId = image.style.backgroundImage
                            .match(/Items\/([a-f0-9]{32})\//i)?.[1];
                        const owner = image.closest<HTMLElement>('[data-id], [data-itemid]');
                        const rawId = backgroundId
                            ?? owner?.getAttribute('data-id')
                            ?? owner?.getAttribute('data-itemid');
                        const id = rawId?.replace(/-/g, '').toLowerCase();
                        return !!id
                            && expected.has(id)
                            && !!image.closest('.card')?.querySelector('.rating-tag-critic .rating-text');
                    });
            }, ids, { timeout: 60_000 });
            const rendered = await page.evaluate((expectedIds) => {
                const expected = new Set(expectedIds);
                return [...document.querySelectorAll<HTMLElement>('#indexPage .cardImageContainer')]
                    .flatMap((image) => {
                        const backgroundId = image.style.backgroundImage
                            .match(/Items\/([a-f0-9]{32})\//i)?.[1];
                        const owner = image.closest<HTMLElement>('[data-id], [data-itemid]');
                        const rawId = backgroundId
                            ?? owner?.getAttribute('data-id')
                            ?? owner?.getAttribute('data-itemid');
                        const id = rawId?.replace(/-/g, '').toLowerCase();
                        if (!id || !expected.has(id)) return [];
                        const text = image.closest('.card')
                            ?.querySelector<HTMLElement>('.rating-tag-critic .rating-text')
                            ?.textContent;
                        return text ? [text] : [];
                    });
            }, ids);
            expect(rendered.length).toBeGreaterThan(0);
            expect(rendered.every((text) => text === '7%')).toBe(true);

            expect(consoleErrors.unexpected5xx(), 'unexpected 5xx responses').toEqual([]);
            expect(consoleErrors.real()).toEqual([]);
        } finally {
            await page.unroute(routePattern);
        }
    });

    test('rating scope hides Episode posters without affecting Movie posters', async ({ page, consoleErrors }) => {
        const routePattern = '**/JellyfinCanopy/tag-cache/**';
        await page.route(routePattern, async (route) => {
            const response = await route.fetch();
            const url = new URL(route.request().url());
            const body = await response.json() as {
                items?: Record<string, Record<string, unknown>>;
                Items?: Record<string, Record<string, unknown>>;
            };
            const items = body.items ?? body.Items;
            if (url.search === '' && items && typeof items === 'object') {
                for (const [id, entry] of Object.entries(items)) {
                    if (!entry) continue;
                    items[id] = {
                        ...entry,
                        CommunityRating: 8.4,
                        CriticRating: 84,
                        RatingSuppressed: false,
                    };
                }
            }
            await route.fulfill({ response, json: body });
        });

        await loginAs(page, 'user', consoleErrors);
        const fixture = await page.evaluate(async () => {
            const api = (window as any).ApiClient;
            const canopy = (window as any).JellyfinCanopy;
            const userId = api.getCurrentUserId();
            const [movies, episodes] = await Promise.all([
                api.getItems(userId, { IncludeItemTypes: 'Movie', Recursive: true, Limit: 1 }),
                api.getItems(userId, { IncludeItemTypes: 'Episode', Recursive: true, Limit: 1 }),
            ]);
            const settings = canopy.currentSettings;
            return {
                movieId: movies?.Items?.[0]?.Id || '',
                episodeId: episodes?.Items?.[0]?.Id || '',
                hadEnabled: Object.prototype.hasOwnProperty.call(settings, 'ratingTagsEnabled'),
                enabled: settings.ratingTagsEnabled,
                hadPolicy: Object.prototype.hasOwnProperty.call(settings, 'ratingTagScopeOverrides'),
                policy: settings.ratingTagScopeOverrides,
            };
        });
        expect(fixture.movieId).not.toBe('');
        expect(fixture.episodeId).not.toBe('');

        const poster = '#itemDetailPage:not(.hide) .detailPagePrimaryContainer .card, '
            + '#itemDetailPage:not(.hide) .detailImageContainer .card';
        try {
            await page.evaluate(async () => {
                const canopy = (window as any).JellyfinCanopy;
                canopy.currentSettings.ratingTagsEnabled = true;
                canopy.currentSettings.ratingTagScopeOverrides = {
                    version: 1,
                    disabledItemTypes: ['Episode'],
                    disabledSurfaces: [],
                };
                await canopy.saveUserSettings('settings.json', canopy.currentSettings);
                canopy.reinitializeRatingTags();
            });

            await showRoute(page, `/details?id=${fixture.movieId}`);
            await waitForHash(page, fixture.movieId);
            const moviePoster = page.locator(poster).first();
            await expect(moviePoster.locator('.rating-overlay-container')).toBeVisible({ timeout: 60_000 });
            await expect(moviePoster.locator('.rating-tag-critic .rating-text')).toHaveText('84%');

            await showRoute(page, `/details?id=${fixture.episodeId}`);
            await waitForHash(page, fixture.episodeId);
            const episodePoster = page.locator(poster).first();
            await expect(episodePoster).toHaveAttribute('data-jc-rating-tagged', '1', { timeout: 60_000 });
            await expect(episodePoster.locator('.rating-overlay-container')).toHaveCount(0);

            // Exercise a real Home row after the asynchronous per-user
            // DisplayPreferences read. With no surface deny, the seeded Next Up
            // Episode must remain visible; applying NextUp live then removes the
            // stale tag without affecting the same Movie on the Other surface.
            await page.evaluate(async () => {
                const canopy = (window as any).JellyfinCanopy;
                canopy.currentSettings.ratingTagScopeOverrides = {
                    version: 1,
                    disabledItemTypes: [],
                    disabledSurfaces: [],
                };
                await canopy.saveUserSettings('settings.json', canopy.currentSettings);
                canopy.reinitializeRatingTags();
            });
            const preferencesRead = page.waitForResponse(
                (response) => response.url().includes('/DisplayPreferences/usersettings')
                    && response.status() === 200,
                { timeout: 60_000 },
            );
            await showRoute(page, '/home');
            await waitForHash(page, '/home');
            const preferences = await (await preferencesRead).json() as {
                CustomPrefs?: Record<string, unknown>;
            };
            const defaultSections = [
                'smalllibrarytiles',
                'resume',
                'resumeaudio',
                'resumebook',
                'livetv',
                'nextup',
                'latestmedia',
                'none',
                'none',
                'none',
            ];
            const nextUpSlot = defaultSections.findIndex((fallback, index) => {
                const raw = preferences.CustomPrefs?.[`homesection${index}`];
                return (typeof raw === 'string' ? raw.trim().toLowerCase() : fallback) === 'nextup';
            });
            expect(nextUpSlot, 'DisplayPreferences must configure a Next Up Home slot')
                .toBeGreaterThanOrEqual(0);
            const nextUpCard = page.locator(
                `.homeSectionsContainer .section${nextUpSlot} .card[data-type="Episode"]`,
            ).first();
            await expect(nextUpCard).toBeVisible({ timeout: 60_000 });
            await expect(nextUpCard.locator('.rating-tag-critic .rating-text')).toHaveText(
                '84%',
                { timeout: 60_000 },
            );

            await page.evaluate(async () => {
                const canopy = (window as any).JellyfinCanopy;
                canopy.currentSettings.ratingTagScopeOverrides = {
                    version: 1,
                    disabledItemTypes: [],
                    disabledSurfaces: ['NextUp'],
                };
                await canopy.saveUserSettings('settings.json', canopy.currentSettings);
                canopy.reinitializeRatingTags();
            });
            await expect(nextUpCard).toHaveAttribute('data-jc-rating-tagged', '1', { timeout: 60_000 });
            await expect(nextUpCard.locator('.rating-overlay-container')).toHaveCount(0);

            await showRoute(page, `/details?id=${fixture.movieId}`);
            await waitForHash(page, fixture.movieId);
            const movieAfterNextUpDeny = page.locator(poster).first();
            await expect(movieAfterNextUpDeny.locator('.rating-tag-critic .rating-text')).toHaveText(
                '84%',
                { timeout: 60_000 },
            );
            assertNoRuntimeErrors(consoleErrors);
        } finally {
            if (!page.isClosed()) {
                await page.evaluate(async (snapshot) => {
                    const canopy = (window as any).JellyfinCanopy;
                    if (snapshot.hadEnabled) canopy.currentSettings.ratingTagsEnabled = snapshot.enabled;
                    else delete canopy.currentSettings.ratingTagsEnabled;
                    if (snapshot.hadPolicy) canopy.currentSettings.ratingTagScopeOverrides = snapshot.policy;
                    else delete canopy.currentSettings.ratingTagScopeOverrides;
                    await canopy.saveUserSettings('settings.json', canopy.currentSettings);
                    canopy.reinitializeRatingTags();
                }, fixture);
            }
            await page.unroute(routePattern);
        }
    });

    test('preferred audio language selects one real track and rerenders without a mixed badge', async ({
        page,
        consoleErrors,
    }) => {
        await loginAs(page, 'admin', consoleErrors);
        const settingKeys = [
            'qualityTagsEnabled',
            'showResolutionTag',
            'showSourceTag',
            'showDynamicRangeTag',
            'showSpecialFormatTag',
            'showVideoCodecTag',
            'showAudioInfoTag',
            'preferredAudioLanguage',
        ];
        const fixture = await page.evaluate(async (keys) => {
            const api = (window as any).ApiClient;
            const canopy = (window as any).JellyfinCanopy;
            const userId = api.getCurrentUserId();
            const result = await api.getItems(userId, {
                IncludeItemTypes: 'Movie',
                Recursive: true,
                Fields: 'Path,MediaSources,MediaStreams',
                Limit: 100,
            });
            const expectedPath = '/media/Movies/Echo Meridian (2025).mkv';
            const matches = (result?.Items || []).filter((item: any) => item.Path === expectedPath);
            const item = matches[0];
            const snapshot: Record<string, { has: boolean; value: unknown }> = {};
            for (const key of keys) {
                snapshot[key] = {
                    has: Object.prototype.hasOwnProperty.call(canopy.currentSettings, key),
                    value: canopy.currentSettings[key],
                };
            }
            const cache = item
                ? await api.ajax({
                    type: 'GET',
                    url: api.getUrl(`/JellyfinCanopy/tag-cache/${userId}`),
                    dataType: 'json',
                })
                : null;
            const projected = (cache?.items?.[item?.Id]?.StreamData?.Streams || [])
                .filter((stream: any) => stream?.Type === 'Audio')
                .map((stream: any) => ({
                    language: String(stream.Language || '').toLowerCase(),
                    codec: String(stream.Codec || '').toLowerCase(),
                    channels: stream.Channels,
                    isDefault: stream.IsDefault === true,
                    sourceIndex: stream.SourceIndex,
                }))
                .sort((a: any, b: any) => a.language.localeCompare(b.language));
            return { matchCount: matches.length, itemId: item?.Id || '', projected, snapshot };
        }, settingKeys);

        expect(fixture.matchCount).toBe(1);
        expect(fixture.itemId).not.toBe('');
        expect(fixture.projected).toEqual([
            { language: 'en-us', codec: 'aac', channels: 6, isDefault: true, sourceIndex: 0 },
            { language: 'pt-br', codec: 'eac3', channels: 2, isDefault: false, sourceIndex: 0 },
        ]);

        const applyPreference = async (preference: string) => {
            await page.evaluate(async ({ next }) => {
                const canopy = (window as any).JellyfinCanopy;
                Object.assign(canopy.currentSettings, {
                    qualityTagsEnabled: true,
                    showResolutionTag: false,
                    showSourceTag: false,
                    showDynamicRangeTag: false,
                    showSpecialFormatTag: false,
                    showVideoCodecTag: false,
                    showAudioInfoTag: true,
                    preferredAudioLanguage: next,
                });
                await canopy.saveUserSettings('settings.json', canopy.currentSettings);
                canopy.reinitializeQualityTags();
            }, { next: preference });
        };

        try {
            await applyPreference('pt-BR');
            await showRoute(page, `/details?id=${fixture.itemId}`);
            await waitForHash(page, fixture.itemId);
            const poster = page.locator(
                '#itemDetailPage:not(.hide) .detailPagePrimaryContainer .card, '
                + '#itemDetailPage:not(.hide) .detailImageContainer .card'
            ).filter({ has: page.locator('.quality-overlay-container') }).first();
            const soundBadge = poster.locator('.quality-overlay-label');
            await expect(soundBadge).toHaveText(['Dolby Digital+ 2.0'], { timeout: 60_000 });

            await applyPreference('');
            await expect(soundBadge).toHaveText(['5.1'], { timeout: 60_000 });

            await applyPreference('pt');
            await expect(soundBadge).toHaveText(['Dolby Digital+ 2.0'], { timeout: 60_000 });
            assertNoRuntimeErrors(consoleErrors);
        } finally {
            await page.evaluate(async ({ keys, snapshot }) => {
                const canopy = (window as any).JellyfinCanopy;
                for (const key of keys) {
                    if (snapshot[key].has) canopy.currentSettings[key] = snapshot[key].value;
                    else delete canopy.currentSettings[key];
                }
                await canopy.saveUserSettings('settings.json', canopy.currentSettings);
                canopy.reinitializeQualityTags();
            }, { keys: settingKeys, snapshot: fixture.snapshot });
        }
    });

    test('regional audio metadata renders the same explicit flag on poster and details', async ({
        page,
        consoleErrors,
    }) => {
        await page.addInitScript(() => localStorage.setItem('layout', 'experimental'));
        await loginAs(page, 'admin', consoleErrors);

        const fixture = await page.evaluate(async () => {
            const api = (window as any).ApiClient;
            const canopy = (window as any).JellyfinCanopy;
            const userId = api.getCurrentUserId();
            const result = await api.getItems(userId, {
                IncludeItemTypes: 'Movie',
                Recursive: true,
                Fields: 'Path,MediaSources,MediaStreams',
                Limit: 100,
            });
            const expectedPath = '/media/Movies/Delta Horizon (2024).mkv';
            const matches = (result?.Items || []).filter((item: any) => item.Path === expectedPath);
            const item = matches[0];
            const neutralPath = '/media/Movies/Alpha Adventure (2021).mp4';
            const neutralMatches = (result?.Items || []).filter((candidate: any) =>
                candidate.Path === neutralPath);
            const neutralItem = neutralMatches[0];
            const streams = item
                ? [
                    ...(Array.isArray(item.MediaStreams) ? item.MediaStreams : []),
                    ...(Array.isArray(item.MediaSources)
                        ? item.MediaSources.flatMap((source: any) =>
                            Array.isArray(source?.MediaStreams) ? source.MediaStreams : [])
                        : []),
                ]
                : [];
            const neutralStreams = neutralItem
                ? [
                    ...(Array.isArray(neutralItem.MediaStreams) ? neutralItem.MediaStreams : []),
                    ...(Array.isArray(neutralItem.MediaSources)
                        ? neutralItem.MediaSources.flatMap((source: any) =>
                            Array.isArray(source?.MediaStreams) ? source.MediaStreams : [])
                        : []),
                ]
                : [];
            const liveTags = [...new Set(streams
                .filter((stream: any) => stream?.Type === 'Audio')
                .map((stream: any) => String(stream.Language || '').toLowerCase())
                .filter(Boolean))].sort();

            let serverTags: string[] = [];
            if (item) {
                const url = api.getUrl(`/JellyfinCanopy/tag-cache/${userId}`);
                const cache = await api.ajax({ type: 'GET', url, dataType: 'json' });
                const entry = cache?.items?.[item.Id];
                serverTags = (Array.isArray(entry?.AudioLanguages) ? entry.AudioLanguages : [])
                    .map((tag: unknown) => String(tag).toLowerCase())
                    .sort();
            }

            return {
                matchCount: matches.length,
                itemId: item?.Id || '',
                liveTags,
                neutralMatchCount: neutralMatches.length,
                neutralItemId: neutralItem?.Id || '',
                neutralLiveTags: [...new Set(neutralStreams
                    .filter((stream: any) => stream?.Type === 'Audio')
                    .map((stream: any) => String(stream.Language || '').toLowerCase())
                    .filter(Boolean))].sort(),
                serverTags,
                languageTagsEnabled: canopy?.currentSettings?.languageTagsEnabled === true,
                showAudioLanguages: canopy?.currentSettings?.showAudioLanguages === true,
                serverCacheEnabled: canopy?.pluginConfig?.TagCacheServerMode === true,
                modernLayout: document.documentElement.classList.contains('jc-modern-layout'),
            };
        });

        expect(fixture).toMatchObject({
            matchCount: 1,
            liveTags: ['pt-br'],
            neutralMatchCount: 1,
            neutralLiveTags: ['eng'],
            serverTags: ['pt-br'],
            languageTagsEnabled: true,
            showAudioLanguages: true,
            serverCacheEnabled: true,
            modernLayout: true,
        });
        expect(fixture.itemId).not.toBe('');
        expect(fixture.neutralItemId).not.toBe('');

        await showRoute(page, `/details?id=${fixture.itemId}`);
        await waitForHash(page, fixture.itemId);

        const posterCard = page.locator(
            '#itemDetailPage:not(.hide) .detailPagePrimaryContainer .card, '
            + '#itemDetailPage:not(.hide) .detailImageContainer .card'
        ).filter({ has: page.locator('.language-overlay-container') }).first();
        const posterLanguage = posterCard.locator(
            '.language-tag-presentation[data-region="BR"]'
        );
        await expect(posterLanguage).toHaveCount(1, { timeout: 60_000 });
        await expect(posterLanguage).toHaveAttribute('data-lang-tags', '["pt-BR"]');
        await expect(posterLanguage).toHaveAttribute('aria-label', /\(pt-BR\)/);
        const posterFlag = posterLanguage.locator('img.language-flag');
        await expect(posterFlag).toHaveAttribute('src', /\/JellyfinCanopy\/assets\/flags\/4x3\/br\.svg$/);

        const detailsLanguage = page.locator(
            '#itemDetailPage:not(.hide) .itemMiscInfo-primary '
            + '.mediaInfoItem-audioLanguage .audio-language-item[data-region="BR"]'
        );
        await expect(detailsLanguage).toHaveCount(1, { timeout: 60_000 });
        await expect(detailsLanguage).toHaveAttribute('data-lang', 'pt-BR');
        await expect(detailsLanguage).toHaveAttribute('data-lang-tags', '["pt-BR"]');
        await expect(detailsLanguage).toHaveAttribute('title', /\(pt-BR\)/);
        await expect(detailsLanguage).toHaveAttribute('aria-label', /\(pt-BR\)/);
        const detailsFlag = detailsLanguage.locator('img');
        await expect(detailsFlag).toHaveAttribute('src', /\/JellyfinCanopy\/assets\/flags\/4x3\/br\.svg$/);

        expect(await detailsFlag.getAttribute('src')).toBe(await posterFlag.getAttribute('src'));

        // Phone-width proof for the neutral fallback presentation. The normal
        // English fixture has no explicit country and must remain a bounded
        // text badge rather than inheriting a national flag.
        await page.setViewportSize({ width: 390, height: 844 });
        await showRoute(page, `/details?id=${fixture.neutralItemId}`);
        await waitForHash(page, fixture.neutralItemId);
        const neutralPosterCard = page.locator(
            '#itemDetailPage:not(.hide) .detailPagePrimaryContainer .card, '
            + '#itemDetailPage:not(.hide) .detailImageContainer .card'
        ).filter({ has: page.locator('.language-overlay-container') }).first();
        const neutralBadge = neutralPosterCard.locator(
            '.language-code-badge[data-region=""]'
        );
        await expect(neutralBadge).toHaveCount(1, { timeout: 60_000 });
        await expect(neutralBadge).toHaveAttribute('data-lang-tags', '["en"]');
        await expect(neutralBadge).toHaveAttribute('aria-label', /\(en\)/);
        await expect(neutralBadge.locator('img')).toHaveCount(0);
        const mobileMetrics = await neutralBadge.evaluate((element) => {
            const badge = element as HTMLElement;
            const overlay = badge.closest<HTMLElement>('.language-overlay-container');
            const card = badge.closest<HTMLElement>('.card');
            const badgeRect = badge.getBoundingClientRect();
            const cardRect = card?.getBoundingClientRect();
            return {
                minWidth: Number.parseFloat(getComputedStyle(badge).minWidth),
                insideCard: !!cardRect && badgeRect.left >= cardRect.left - 1
                    && badgeRect.right <= cardRect.right + 1,
                noHorizontalOverflow: !!overlay && overlay.scrollWidth <= overlay.clientWidth + 1,
            };
        });
        expect(mobileMetrics).toEqual({
            minWidth: 16,
            insideCard: true,
            noHorizontalOverflow: true,
        });
        assertNoRuntimeErrors(consoleErrors);
    });

    // Regression: "Hide Tags on Hover" must hide the tags on the detail-page
    // primary poster too. That poster is a `.card` with NO `.cardOverlayContainer`,
    // so its tags render straight into `.cardScalable` with no `.jc-tag-host`
    // wrapper — the old `.card:hover .jc-tag-host` rule never matched it, so the
    // poster tags stayed visible on hover (movie/series/episode posters). The
    // broadened rule targets the overlay containers directly.
    test('hide-on-hover fades the detail-page primary poster tags', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);

        const anyTagsEnabled = await page.evaluate(() => {
            const settings = (window as any).JellyfinCanopy?.currentSettings || {};
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

        // The primary poster is the `.card` in the detail header that carries a JC
        // overlay container but NOT a `.jc-tag-host` (no hover menu on that card).
        const POSTER = '.detailPagePrimaryContainer .card, .detailImageContainer .card';
        const isPosterTagged = (sel: string) => [...document.querySelectorAll(sel)]
            .some((c) => c.querySelector('[class*="-overlay-container"]') && !c.querySelector('.jc-tag-host'));

        await page.waitForFunction(isPosterTagged, POSTER, { timeout: 60_000 }).catch(() => {});
        const posterTagged = await page.evaluate(isPosterTagged, POSTER);
        test.skip(!posterTagged, 'primary poster carries no JC tags (no media info)');

        // Enable "Hide Tags on Hover" (the body class the setting toggles).
        await page.evaluate(() => document.body.classList.add('jc-tags-hide-on-hover'));

        // Mark the poster, then wait for its tag layer to SETTLE at full opacity.
        // The overlay containers fade in via a 150ms `jc-tag-fadein` intro, so a
        // one-shot read of the baseline would race that animation and flake.
        await page.evaluate((sel) => {
            const card = [...document.querySelectorAll(sel)]
                .find((c) => c.querySelector('[class*="-overlay-container"]') && !c.querySelector('.jc-tag-host'));
            card!.setAttribute('data-jc-test-poster', '1');
        }, POSTER);
        await page.waitForFunction(() => {
            const oc = document.querySelector('[data-jc-test-poster] [class*="-overlay-container"]') as HTMLElement | null;
            return !!oc && getComputedStyle(oc).opacity === '1';
        }, undefined, { timeout: 10_000 });

        // Hovering the poster must fade its (fully-visible) tag layer to transparent.
        await page.hover('[data-jc-test-poster]');
        await page.waitForFunction(() => {
            const oc = document.querySelector('[data-jc-test-poster] [class*="-overlay-container"]') as HTMLElement | null;
            return !!oc && getComputedStyle(oc).opacity === '0';
        }, undefined, { timeout: 5_000 });

        expect(consoleErrors.unexpected5xx(), 'unexpected 5xx responses').toEqual([]);
        expect(consoleErrors.real()).toEqual([]);
    });
});
