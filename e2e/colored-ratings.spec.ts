// German FSK acceptance proof against the real Jellyfin 12 browser surface.
// The unit suite pins every supported alias; this spec proves that production
// canonicalization, the shipped stylesheet, accessible names, and computed
// contrast survive representative host themes and forced-colors mode.
import type { Page } from 'playwright/test';
import {
    test,
    expect,
    loginAs,
    showRoute,
    waitForHash,
    assertNoRuntimeErrors,
    USERS,
} from './fixtures/auth';
import { api, authenticate } from './fixtures/api';

/* eslint-disable @typescript-eslint/no-explicit-any */

const THEMES = ['dark', 'light', 'blueradiance'] as const;
const FSK_FIXTURES = [
    { source: 'DE-0', canonical: 'FSK-0', background: 'rgb(255, 255, 255)' },
    { source: 'FSK6', canonical: 'FSK-6', background: 'rgb(255, 232, 0)' },
    { source: 'FSK 12', canonical: 'FSK-12', background: 'rgb(51, 181, 64)' },
    { source: 'FSK-16', canonical: 'FSK-16', background: 'rgb(56, 167, 228)' },
    { source: 'DE-18', canonical: 'FSK-18', background: 'rgb(237, 28, 36)' },
] as const;

async function switchTheme(page: Page, selectedTheme: string): Promise<void> {
    await page.evaluate(async (theme) => {
        const themeLink = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')]
            .find((link) => /\/themes\/[^/]+\/theme\.css$/i.test(
                new URL(link.href, location.href).pathname
            ));
        if (!themeLink) throw new Error('Jellyfin theme stylesheet link was not found');

        const target = new URL(themeLink.href, location.href);
        target.pathname = target.pathname.replace(
            /\/themes\/[^/]+\/theme\.css$/i,
            `/themes/${theme}/theme.css`
        );
        document.documentElement.dataset.theme = theme;
        if (themeLink.href !== target.href) {
            await new Promise<void>((resolve, reject) => {
                const timeout = window.setTimeout(
                    () => reject(new Error(`theme stylesheet ${target.pathname} did not load`)),
                    30_000
                );
                themeLink.addEventListener('load', () => {
                    window.clearTimeout(timeout);
                    resolve();
                }, { once: true });
                themeLink.addEventListener('error', () => {
                    window.clearTimeout(timeout);
                    reject(new Error(`theme stylesheet ${target.pathname} failed to load`));
                }, { once: true });
                themeLink.href = target.href;
            });
        }
        await new Promise<void>((resolve) => requestAnimationFrame(
            () => requestAnimationFrame(() => resolve())
        ));
    }, selectedTheme);
}

async function auditComputedRatings(page: Page) {
    return page.locator('#jc-fsk-browser-proof .mediaInfoOfficialRating').evaluateAll((elements) => {
        type Rgb = [number, number, number];
        const rgb = (value: string): Rgb => {
            const match = value.match(/rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/i);
            if (!match) throw new Error(`unparseable computed color: ${value}`);
            return [Number(match[1]), Number(match[2]), Number(match[3])];
        };
        const luminance = (value: Rgb): number => {
            const channels = value.map((channel) => {
                const normalized = channel / 255;
                return normalized <= 0.04045
                    ? normalized / 12.92
                    : ((normalized + 0.055) / 1.055) ** 2.4;
            });
            return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
        };
        return elements.map((element) => {
            const style = getComputedStyle(element);
            const foreground = rgb(style.color);
            const background = rgb(style.backgroundColor);
            const foregroundLuminance = luminance(foreground);
            const backgroundLuminance = luminance(background);
            return {
                text: element.textContent,
                rating: element.getAttribute('rating'),
                ariaLabel: element.getAttribute('aria-label'),
                title: element.getAttribute('title'),
                foreground: style.color,
                background: style.backgroundColor,
                contrast: (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
                    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05),
                borderWidth: Number.parseFloat(style.borderWidth),
            };
        });
    });
}

test.describe('colored ratings', () => {
    test('FSK aliases remain readable and accessible across host themes and forced colors', async ({
        page,
        consoleErrors,
        baseURL,
    }) => {
        await loginAs(page, 'admin', consoleErrors);
        const admin = await authenticate(baseURL!, USERS.admin.username, USERS.admin.password);
        const items = await api<{ Items: Array<{ Id: string }> }>(
            baseURL!,
            `/Items?Recursive=true&IncludeItemTypes=Movie,Series&Limit=1&userId=${admin.userId}`,
            admin.token
        );
        const itemId = items?.Items?.[0]?.Id;
        expect(itemId, 'a seeded detail item is required').toBeTruthy();

        const originalEnabled = await page.evaluate(() => {
            const canopy = (window as any).JellyfinCanopy;
            const original = canopy.pluginConfig.ColoredRatingsEnabled;
            canopy.pluginConfig.ColoredRatingsEnabled = true;
            return original;
        });

        try {
            await showRoute(page, `/details?id=${itemId}`);
            await waitForHash(page, '/details');
            await page.waitForFunction(
                () => typeof (window as any).JellyfinCanopy.initializeColoredRatings === 'function',
                undefined,
                { timeout: 30_000 }
            );
            await page.evaluate((fixtures) => {
                document.getElementById('jc-fsk-browser-proof')?.remove();
                const owner = document.createElement('section');
                owner.id = 'jc-fsk-browser-proof';
                for (const fixture of fixtures) {
                    const badge = document.createElement('span');
                    badge.className = 'mediaInfoOfficialRating';
                    badge.textContent = fixture.source;
                    owner.appendChild(badge);
                }
                document.body.appendChild(owner);
                (window as any).JellyfinCanopy.initializeColoredRatings();
            }, FSK_FIXTURES);

            await expect(page.locator('#jellyfin-ratings-style')).toHaveCount(1);
            for (let index = 0; index < FSK_FIXTURES.length; index += 1) {
                const fixture = FSK_FIXTURES[index];
                const badge = page.locator('#jc-fsk-browser-proof .mediaInfoOfficialRating').nth(index);
                await expect(badge).toHaveText(fixture.canonical);
                await expect(badge).toHaveAttribute('rating', fixture.canonical);
                await expect(badge).toHaveAccessibleName(`Content rated ${fixture.canonical}`);
                await expect(badge).toHaveAttribute('title', `Rating: ${fixture.canonical}`);
            }

            for (const theme of THEMES) {
                await page.emulateMedia({ forcedColors: 'none' });
                await switchTheme(page, theme);
                const audit = await auditComputedRatings(page);
                expect(audit).toHaveLength(FSK_FIXTURES.length);
                expect(await page.locator('html').getAttribute('data-theme')).toBe(theme);
                for (let index = 0; index < FSK_FIXTURES.length; index += 1) {
                    expect(audit[index].background, `${theme}/${FSK_FIXTURES[index].canonical} background`)
                        .toBe(FSK_FIXTURES[index].background);
                    expect(audit[index].foreground, `${theme}/${FSK_FIXTURES[index].canonical} foreground`)
                        .toBe('rgb(0, 0, 0)');
                    expect(audit[index].contrast, `${theme}/${FSK_FIXTURES[index].canonical} contrast`)
                        .toBeGreaterThanOrEqual(4.5);
                }
            }

            await page.emulateMedia({ forcedColors: 'active' });
            await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(
                () => requestAnimationFrame(() => resolve())
            )));
            const forcedColors = await auditComputedRatings(page);
            expect(forcedColors).toHaveLength(FSK_FIXTURES.length);
            for (let index = 0; index < FSK_FIXTURES.length; index += 1) {
                expect(forcedColors[index].contrast, `forced-colors/${FSK_FIXTURES[index].canonical} contrast`)
                    .toBeGreaterThanOrEqual(4.5);
                expect(forcedColors[index].borderWidth, `forced-colors/${FSK_FIXTURES[index].canonical} border`)
                    .toBeGreaterThanOrEqual(1);
                expect(forcedColors[index].ariaLabel).toBe(`Content rated ${FSK_FIXTURES[index].canonical}`);
            }
        } finally {
            await page.emulateMedia({ forcedColors: 'none' });
            await page.evaluate((enabled) => {
                const canopy = (window as any).JellyfinCanopy;
                canopy.pluginConfig.ColoredRatingsEnabled = false;
                canopy.initializeColoredRatings?.();
                canopy.pluginConfig.ColoredRatingsEnabled = enabled;
                document.getElementById('jc-fsk-browser-proof')?.remove();
                if (enabled) canopy.initializeColoredRatings?.();
            }, originalEnabled);
        }

        assertNoRuntimeErrors(consoleErrors);
    });
});
