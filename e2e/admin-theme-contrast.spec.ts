import {
    test,
    expect,
    loginAs,
    assertNoRuntimeErrors,
    type ConsoleErrors,
} from './fixtures/auth';

const CONFIG_HASH = '#/configurationpage?name=Jellyfin%20Canopy';
const DASHBOARD_CHROME =
    /scrollHandler is not a function|\/Users\/[^/]+\/Images\/Primary|\/JellyfinCanopy\/BrandingImage/i;

function assertNoConfigPageRuntimeErrors(consoleErrors: ConsoleErrors): void {
    assertNoRuntimeErrors({
        ...consoleErrors,
        real: () => consoleErrors.real().filter((text) => !DASHBOARD_CHROME.test(text)),
        realDetails: () => consoleErrors.realDetails().filter(
            ({ text }) => !DASHBOARD_CHROME.test(text)
        ),
        unexpected4xx: () => consoleErrors.unexpected4xx().filter(
            ({ url }) => !DASHBOARD_CHROME.test(url)
        ),
    });
}

const THEMES = [
    { name: 'dark', expectedClass: 'jc-dark-theme' },
    { name: 'light', expectedClass: 'jc-light-theme' },
    { name: 'blueradiance', expectedClass: 'jc-dark-theme' },
] as const;

const VIEWPORTS = [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'mobile', width: 390, height: 844 },
] as const;

test.describe('admin theme contrast', () => {
    test('owned surfaces, controls and focus remain legible across themes and viewports', async ({
        page,
        consoleErrors,
    }) => {
        await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
        await loginAs(page, 'admin', consoleErrors);

        for (const viewport of VIEWPORTS) {
            await page.setViewportSize(viewport);
            for (const theme of THEMES) {
                    await page.reload({ waitUntil: 'domcontentloaded' });
                    await page.evaluate((hash) => { window.location.hash = hash; }, CONFIG_HASH);
                    await page.waitForSelector('#JellyfinCanopyPage #JellyfinCanopyForm', {
                        state: 'visible',
                        timeout: 60_000,
                    });
                    await page.waitForSelector('#JellyfinCanopyPage .jc-group-btn', { timeout: 60_000 });
                    await page.addStyleTag({
                        content: '#JellyfinCanopyPage * { animation-duration: 0s !important; transition-duration: 0s !important; }',
                    });
                    await page.evaluate(async (selectedTheme) => {
                        const themeLink = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')]
                            .find((link) => /\/themes\/[^/]+\/theme\.css$/i.test(
                                new URL(link.href, location.href).pathname
                            ));
                        if (!themeLink) throw new Error('Jellyfin theme stylesheet link was not found');

                        const target = new URL(themeLink.href, location.href);
                        target.pathname = target.pathname.replace(
                            /\/themes\/[^/]+\/theme\.css$/i,
                            `/themes/${selectedTheme}/theme.css`
                        );
                        document.documentElement.dataset.theme = selectedTheme;
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
                        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(
                            () => resolve()
                        )));
                        window.dispatchEvent(new Event('load'));
                    }, theme.name);
                    await page.waitForFunction((selectedTheme) => {
                        const htmlTheme = document.documentElement.dataset.theme;
                        const themeSheetLoaded = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')]
                            .some((link) => new URL(link.href, location.href).pathname
                                .toLowerCase().endsWith(`/themes/${selectedTheme}/theme.css`));
                        return htmlTheme === selectedTheme && themeSheetLoaded;
                    }, theme.name, { timeout: 60_000 });
                    await page.waitForFunction(
                        (expectedClass) => document.getElementById('JellyfinCanopyPage')
                            ?.classList.contains(expectedClass),
                        theme.expectedClass
                    );
                    const auditVisibleText = async (phase: string): Promise<void> => {
                        const audit = await page.evaluate(() => {
                            const root = document.getElementById('JellyfinCanopyPage') as HTMLElement;
                            const selectors = [
                                '.jc-service-name', '.jc-service-detail',
                                '.jc-feature-name', '.jc-feature-detail',
                                '.jc-optional-plugin-name', '.jc-optional-plugin-status', '.jc-optional-plugin-purpose',
                                '.jc-group-btn', '.jellyfin-tab-button:not(.active)',
                                'legend.sectionTitle', '.configSection label', '.fieldDescription',
                                '.emby-input', '.emby-select',
                                '.jc-branding-label-bold', '.jc-branding-size-hint', '.jc-branding-label',
                                '.jc-branding-meta', '.jc-branding-hint', '.jc-branding-maxsize',
                                '.jc-branding-dimensions', '.jc-audit-error',
                            ];

                            type Color = [number, number, number, number];
                            function rgba(value: string): Color | null {
                                const match = value.match(/rgba?\(([^)]+)\)/i);
                                if (!match) return null;
                                const parts = match[1].split(/[ ,/]+/).filter(Boolean).map(Number);
                                if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return null;
                                return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
                            }

                            function luminance(color: Color): number {
                                const linear = color.slice(0, 3).map((channel) => {
                                    const normalized = channel / 255;
                                    return normalized <= 0.04045
                                        ? normalized / 12.92
                                        : ((normalized + 0.055) / 1.055) ** 2.4;
                                });
                                return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
                            }

                            function contrast(left: Color, right: Color): number {
                                const a = luminance(left);
                                const b = luminance(right);
                                return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
                            }

                            function background(element: HTMLElement): Color {
                                let current: HTMLElement | null = element;
                                while (current) {
                                    const candidate = rgba(getComputedStyle(current).backgroundColor);
                                    if (candidate && candidate[3] >= 0.99) return candidate;
                                    current = current.parentElement;
                                }
                                return [255, 255, 255, 1];
                            }

                            function effectiveOpacity(element: HTMLElement): number {
                                let opacity = 1;
                                let current: HTMLElement | null = element;
                                while (current && current !== root.parentElement) {
                                    opacity *= Number.parseFloat(getComputedStyle(current).opacity || '1');
                                    current = current.parentElement;
                                }
                                return opacity;
                            }

                            function composite(foreground: Color, backdrop: Color, opacity: number): Color {
                                return [
                                    (foreground[0] * opacity) + (backdrop[0] * (1 - opacity)),
                                    (foreground[1] * opacity) + (backdrop[1] * (1 - opacity)),
                                    (foreground[2] * opacity) + (backdrop[2] * (1 - opacity)),
                                    1,
                                ];
                            }

                            const failures: string[] = [];
                            let checked = 0;
                            for (const selector of selectors) {
                                for (const element of root.querySelectorAll<HTMLElement>(selector)) {
                                    const rect = element.getBoundingClientRect();
                                    const style = getComputedStyle(element);
                                    if (rect.width === 0 || rect.height === 0 || style.visibility === 'hidden') continue;
                                    const foreground = rgba(style.color);
                                    if (!foreground) {
                                        failures.push(`${selector}: unparseable foreground ${style.color}`);
                                        continue;
                                    }
                                    const backdrop = background(element);
                                    const opacity = effectiveOpacity(element) * foreground[3];
                                    const ratio = contrast(composite(foreground, backdrop, opacity), backdrop);
                                    checked++;
                                    if (ratio < 4.5) {
                                        failures.push(
                                            `${selector}: ${ratio.toFixed(2)}:1 opacity=${opacity.toFixed(2)}`
                                            + ` fg=${foreground.join(',')} bg=${backdrop.join(',')}`
                                        );
                                    }
                                }
                            }

                            const activeTab = root.querySelector<HTMLElement>('.jellyfin-tab-button.active');
                            if (activeTab) {
                                const foreground = rgba(getComputedStyle(activeTab).color);
                                const rootStyle = getComputedStyle(root);
                                for (const token of ['--jc-control-start', '--jc-control-mid', '--jc-control-end']) {
                                    const probe = document.createElement('span');
                                    probe.style.backgroundColor = `var(${token})`;
                                    root.appendChild(probe);
                                    const stop = rgba(getComputedStyle(probe).backgroundColor);
                                    probe.remove();
                                    if (!foreground || !stop || contrast(foreground, stop) < 4.5) {
                                        failures.push(`active-tab/${token}: insufficient contrast`);
                                    }
                                }
                                if (!rootStyle.getPropertyValue('--jc-grad-control').includes('gradient')) {
                                    failures.push('active-tab: control gradient is absent');
                                }
                            }

                            return {
                                failures,
                                checked,
                                horizontalOverflow: root.scrollWidth - root.clientWidth,
                                realTheme: document.documentElement.dataset.theme,
                            };
                        });
                        expect(audit.realTheme, `${theme.name}/${viewport.name}/${phase} real Jellyfin theme`).toBe(theme.name);
                        expect(audit.checked, `${theme.name}/${viewport.name}/${phase} actual-element coverage`).toBeGreaterThan(10);
                        expect(audit.failures, `${theme.name}/${viewport.name}/${phase} actual contrast`).toEqual([]);
                        expect(audit.horizontalOverflow, `${theme.name}/${viewport.name}/${phase} horizontal overflow`)
                            .toBeLessThanOrEqual(1);
                    };

                    await auditVisibleText('overview');

                    const focusTarget = viewport.name === 'mobile'
                        ? page.locator('#JellyfinCanopyPage .jc-nav-toggle:visible').first()
                        : page.locator('#JellyfinCanopyPage .jc-group-btn:visible').first();
                    await focusTarget.focus();
                    const focus = await focusTarget.evaluate((element) => {
                        const style = getComputedStyle(element);
                        return {
                            active: document.activeElement === element,
                            width: Number.parseFloat(style.outlineWidth),
                            style: style.outlineStyle,
                        };
                    });
                    expect(focus.active, `${theme.name}/${viewport.name} keyboard focus target`).toBe(true);
                    expect(focus.style, `${theme.name}/${viewport.name} focus style`).not.toBe('none');
                    expect(focus.width, `${theme.name}/${viewport.name} focus width`).toBeGreaterThanOrEqual(3);

                    if (viewport.name === 'mobile') {
                        await page.locator('#JellyfinCanopyPage .jc-nav-toggle').click();
                        await expect(page.locator('#JellyfinCanopyPage .jc-shell')).toHaveClass(/jc-nav-open/);
                    }
                    await page.locator('#JellyfinCanopyPage .jc-group-btn[data-group="experience"]').click();
                    await page.locator('#JellyfinCanopyPage .jellyfin-tab-button[data-tab="display"]').click();
                    await expect(page.locator('#JellyfinCanopyPage #display')).toBeVisible();
                    await auditVisibleText('branding');

                    if (viewport.name === 'mobile') {
                        await page.locator('#JellyfinCanopyPage .jc-nav-toggle').click();
                        await expect(page.locator('#JellyfinCanopyPage .jc-shell')).toHaveClass(/jc-nav-open/);
                    }
                    await page.locator('#JellyfinCanopyPage .jc-group-btn[data-group="command-center"]').click();
                    await expect(page.locator('#JellyfinCanopyPage #overview')).toBeVisible();
                    await expect(page.locator('#JellyfinCanopyPage')).toHaveScreenshot(
                        `admin-${theme.name}-${viewport.name}.png`,
                        { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.005 }
                    );

                    if (theme.name === 'light') {
                        const fallback = await page.evaluate(() => {
                            const root = document.getElementById('JellyfinCanopyPage') as HTMLElement;
                            const tokens = [
                                '--jc-card-bg', '--jc-accent', '--jc-on-accent', '--jc-success',
                                '--jc-warning', '--jc-danger', '--jc-info', '--jc-surface-1',
                                '--jc-surface-2', '--jc-surface-3', '--jc-text-strong', '--jc-text-muted',
                                '--jc-text-subtle', '--jc-text-dim', '--jc-border', '--jc-border-focus',
                                '--jc-select-chevron', '--jc-select-chevron-focus',
                            ];
                            const before = Object.fromEntries(tokens.map(
                                (token) => [token, getComputedStyle(root).getPropertyValue(token).trim()]
                            ));
                            root.classList.remove('jc-light-theme', 'jc-dark-theme');
                            const after = Object.fromEntries(tokens.map(
                                (token) => [token, getComputedStyle(root).getPropertyValue(token).trim()]
                            ));
                            return {
                                before,
                                after,
                                chevron: getComputedStyle(root.querySelector('select.emby-select')!).backgroundImage,
                            };
                        });
                        expect(fallback.after, `${viewport.name} browser light-preference fallback`).toEqual(fallback.before);
                        expect(fallback.chevron, `${viewport.name} fallback select chevron`).toContain('%23344054');
                    }

                    assertNoConfigPageRuntimeErrors(consoleErrors);
                    consoleErrors.reset();
            }
        }
    });
});
