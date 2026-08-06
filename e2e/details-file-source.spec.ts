// #670 — file source is an independent details-page chip. Exercise a real
// Jellyfin 12 item whose probed media-source path contains the `.disc` marker,
// cached details navigation, the poster-source setting boundary, and the real
// acknowledged per-user toggle. The exact original setting is restored.
import type { Page, Response } from 'playwright/test';
import {
    test,
    expect,
    loginAs,
    showRoute,
    waitForHash,
    assertNoRuntimeErrors,
} from './fixtures/auth';

/* eslint-disable @typescript-eslint/no-explicit-any */

const FILE_SOURCE_PATH = '/media/Movies/JC File Source BluRay.disc.mkv';

async function openUiPane(page: Page) {
    const panel = page.locator('#jellyfin-canopy-panel');
    if (!await panel.isVisible()) {
        await page.evaluate(() => { void (window as any).JellyfinCanopy.showEnhancedPanel(); });
    }
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await panel.locator('.tab-button[data-tab="ui"]').click();
    await expect(panel.locator('.jc-pane[data-pane="ui"]')).toBeVisible();
    return panel;
}

async function readPersistedToggle(page: Page): Promise<boolean> {
    return page.evaluate(async () => {
        const api = (window as any).ApiClient;
        const value = await api.ajax({
            type: 'GET',
            url: api.getUrl(
                `/JellyfinCanopy/user-settings/${encodeURIComponent(api.getCurrentUserId())}/settings.json`
            ),
            dataType: 'json',
        });
        return (value.ShowFileSource ?? value.showFileSource) === true;
    });
}

interface PosterSettingsSnapshot {
    qualityTagsEnabled: boolean;
    showSourceTag: boolean;
}

async function readPersistedPosterSettings(page: Page): Promise<PosterSettingsSnapshot> {
    return page.evaluate(async () => {
        const api = (window as any).ApiClient;
        const value = await api.ajax({
            type: 'GET',
            url: api.getUrl(
                `/JellyfinCanopy/user-settings/${encodeURIComponent(api.getCurrentUserId())}/settings.json`
            ),
            dataType: 'json',
        });
        return {
            qualityTagsEnabled: (value.QualityTagsEnabled ?? value.qualityTagsEnabled) === true,
            showSourceTag: (value.ShowSourceTag ?? value.showSourceTag) === true,
        };
    });
}

async function applyLivePosterSettings(page: Page, settings: PosterSettingsSnapshot): Promise<void> {
    await page.evaluate((values) => {
        const canopy = (window as any).JellyfinCanopy;
        canopy.currentSettings.qualityTagsEnabled = values.qualityTagsEnabled;
        canopy.currentSettings.showSourceTag = values.showSourceTag;
        canopy.reinitializeQualityTags();
    }, settings);
}

function isExactSaveResponse(response: Response, on: boolean): boolean {
    if (!response.ok()
        || response.request().method() !== 'POST'
        || !/\/JellyfinCanopy\/user-settings\/[^/?]+\/settings\.json(?:\?|$)/.test(response.url())) {
        return false;
    }
    const body = response.request().postDataJSON() as Record<string, unknown> | null;
    return (body?.ShowFileSource ?? body?.showFileSource) === on;
}

async function setToggle(page: Page, on: boolean): Promise<void> {
    const panel = await openUiPane(page);
    const toggle = panel.locator('#showFileSourceToggle');
    await toggle.scrollIntoViewIfNeeded();
    expect(await toggle.isChecked(), 'each helper call must perform a real mutation').not.toBe(on);
    const [response] = await Promise.all([
        page.waitForResponse((candidate) => isExactSaveResponse(candidate, on), { timeout: 30_000 }),
        toggle.setChecked(on),
    ]);
    const acknowledgement = await response.json() as Record<string, any>;
    const data = acknowledgement.Data ?? acknowledgement.data;
    expect(acknowledgement.Success ?? acknowledgement.success, 'settings write was acknowledged').toBe(true);
    expect(acknowledgement.File ?? acknowledgement.file).toBe('settings.json');
    expect(data?.ShowFileSource ?? data?.showFileSource).toBe(on);
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden({ timeout: 10_000 });
}

test.describe('details file source (#670)', () => {
    test('real .disc source is independent, navigation-safe, and removed live when disabled', async ({
        page,
        consoleErrors,
    }) => {
        await loginAs(page, 'admin', consoleErrors);
        const originalToggle = await readPersistedToggle(page);
        const originalPosterSettings = await readPersistedPosterSettings(page);
        const fixture = await page.evaluate(async (path) => {
            const api = (window as any).ApiClient;
            const result = await api.getItems(api.getCurrentUserId(), {
                IncludeItemTypes: 'Movie',
                Recursive: true,
                Fields: 'Path,MediaSources,MediaStreams',
                Limit: 100,
            });
            const items = result?.Items || [];
            const matches = items.filter((item: any) => item.Path === path);
            const ordinary = items.find((item: any) => item.Path !== path && !String(item.Path || '').includes('.disc'));
            const item = matches[0];
            return {
                matchCount: matches.length,
                itemId: item?.Id || '',
                mediaSourcePathCount: (item?.MediaSources || []).filter(
                    (source: any) => source?.Path === path
                ).length,
                ordinaryId: ordinary?.Id || '',
            };
        }, FILE_SOURCE_PATH);
        expect(fixture.matchCount).toBe(1);
        expect(fixture.mediaSourcePathCount).toBe(1);
        expect(fixture.itemId).not.toBe('');
        expect(fixture.ordinaryId).not.toBe('');

        try {
            if (!originalToggle) await setToggle(page, true);

            await showRoute(page, `/details?id=${fixture.itemId}`);
            await waitForHash(page, fixture.itemId);
            const visible = page.locator('#itemDetailPage:not(.hide)');
            const chip = visible.locator(
                `.mediaInfoItem-fileSource[data-item-id="${fixture.itemId}"]`
            );
            await expect(chip).toBeVisible({ timeout: 30_000 });
            await expect(chip).toContainText('BluRay');
            await expect(chip).not.toContainText('/media');

            // Apply the poster-only values after the persisted details toggle
            // write, then restore them before any later full-settings POST.
            await applyLivePosterSettings(page, {
                qualityTagsEnabled: true,
                showSourceTag: false,
            });
            await expect(visible.locator('.quality-overlay-label')).not.toHaveCount(0, { timeout: 30_000 });
            await expect(visible.locator('.quality-overlay-label[data-quality="BluRay"]')).toHaveCount(0);
            await expect(chip).toContainText('BluRay');

            await showRoute(page, `/details?id=${fixture.ordinaryId}`);
            await waitForHash(page, fixture.ordinaryId);
            await expect(page.locator('#itemDetailPage:not(.hide) .mediaInfoItem-fileSource')).toHaveCount(0);

            await page.goBack();
            await waitForHash(page, fixture.itemId);
            await expect(page.locator(
                `#itemDetailPage:not(.hide) .mediaInfoItem-fileSource[data-item-id="${fixture.itemId}"]`
            )).toContainText('BluRay', { timeout: 30_000 });

            await applyLivePosterSettings(page, originalPosterSettings);
            await setToggle(page, false);
            await expect(page.locator('.mediaInfoItem-fileSource')).toHaveCount(0);

            // Ensure finally always performs an acknowledged restoration write.
            if (!originalToggle) await setToggle(page, true);
        } finally {
            if (!page.isClosed()) {
                await applyLivePosterSettings(page, originalPosterSettings);
                const current = await readPersistedToggle(page);
                if (current !== originalToggle) await setToggle(page, originalToggle);
                await applyLivePosterSettings(page, originalPosterSettings);
            }
        }

        expect(await readPersistedToggle(page), 'the exact original server value is restored')
            .toBe(originalToggle);
        expect(
            await readPersistedPosterSettings(page),
            'temporary poster values never reach persisted settings'
        ).toEqual(originalPosterSettings);
        assertNoRuntimeErrors(consoleErrors);
    });
});
