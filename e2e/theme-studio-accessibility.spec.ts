import AxeBuilder from '@axe-core/playwright';
import type { Page } from 'playwright/test';
import { assertNoRuntimeErrors, expect, loginAs, test, USERS } from './fixtures/auth';
import { api, authenticate, PLUGIN_ID, type Session } from './fixtures/api';
import { installThemeStudioVisualFont } from './helpers/theme-studio-visual';

const CONFIG_PATH = `/Plugins/${PLUGIN_ID}/Configuration`;
const ACCESSIBILITY_SCAN_SCOPE = '#jc-theme-accessibility-fixture';
const ACCESSIBILITY_STANDARD_TAGS = [
    'wcag2a',
    'wcag2aa',
    'wcag21a',
    'wcag21aa',
    'wcag22aa',
];

async function expectNoAutomatedAccessibilityViolations(page: Page, surface: string): Promise<void> {
    const results = await new AxeBuilder({ page })
        .include(ACCESSIBILITY_SCAN_SCOPE)
        .withTags(ACCESSIBILITY_STANDARD_TAGS)
        .analyze();
    const violations = results.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        help: violation.help,
        targets: violation.nodes.flatMap((node) => node.target),
    }));
    expect(violations, `${surface} automated accessibility violations:\n${JSON.stringify(violations, null, 2)}`)
        .toEqual([]);
}

async function seedModernCoarseLayout(page: Page): Promise<void> {
    await page.addInitScript(() => {
        localStorage.setItem('layout', 'experimental');
        const nativeMatchMedia = window.matchMedia.bind(window);
        window.matchMedia = ((query: string): MediaQueryList => {
            const list = nativeMatchMedia(query);
            if (query !== '(pointer: coarse)') return list;
            return new Proxy(list, {
                get(target, property, receiver) {
                    if (property === 'matches') return true;
                    const value = Reflect.get(target, property, receiver) as unknown;
                    return typeof value === 'function' ? value.bind(target) : value;
                },
            });
        }) as typeof window.matchMedia;
    });
}

async function waitForThemeRuntime(page: Page, breakpoint: 'phone' | 'desktop' | 'wide'): Promise<void> {
    await page.waitForFunction((expected) => {
        const root = document.documentElement;
        return root.getAttribute('data-jc-theme-active') === 'true'
            && root.getAttribute('data-jc-theme-breakpoint') === expected
            && document.querySelectorAll('#jc-theme-studio-committed').length === 1;
    }, breakpoint);
}

async function previewAccessibleTheme(page: Page): Promise<void> {
    const accepted = await page.evaluate(() => {
        const runtime = window.JellyfinCanopy.core.themeStudio;
        const draft = runtime?.getConfiguration();
        const active = draft?.Profiles.find((profile) => profile.Id === draft.ActiveProfileId)
            ?? draft?.Profiles[0];
        if (!runtime || !draft || !active) throw new Error('Theme Studio configuration is unavailable');
        active.BasePreset = 'high-contrast';
        active.Palette = 'canopy-night';
        active.Accent = 'violet';
        active.Mode = 'dark';
        active.Accessibility = {
            ...active.Accessibility,
            Motion: 'off',
            Contrast: 'on',
            Transparency: 'off',
            FocusEmphasis: 'strong',
            UnderlineLinks: true,
        };
        active.Tokens = {
            ...active.Tokens,
            'accessibility.text-scale': 2,
            'effects.level': 'full',
            'effects.material': 'glass',
            'motion.profile': 'expressive',
            'layout.card-actions': 'hover',
        };
        return runtime.preview(draft, { allowScheduling: false });
    });
    expect(accepted).toBe(true);
    await expect.poll(() => page.evaluate(() => {
        const root = document.documentElement;
        return {
            contrast: root.getAttribute('data-jc-theme-contrast'),
            transparency: root.getAttribute('data-jc-theme-transparency'),
            motion: root.getAttribute('data-jc-theme-motion'),
            effects: root.getAttribute('data-jc-theme-effects-level'),
            actions: root.getAttribute('data-jc-theme-card-actions'),
            font: getComputedStyle(root).getPropertyValue('--jc-effective-font-size').trim(),
        };
    })).toEqual({
        contrast: 'more', transparency: 'reduced', motion: 'reduced', effects: 'minimal',
        actions: 'always', font: '2rem',
    });
}

async function mountAccessibilityFixture(page: Page): Promise<void> {
    await page.evaluate(() => {
        document.getElementById('jc-theme-accessibility-fixture')?.remove();
        document.getElementById('jc-theme-accessibility-fixture-style')?.remove();
        const style = document.createElement('style');
        style.id = 'jc-theme-accessibility-fixture-style';
        style.textContent = `
          html, body { inline-size:100%; max-inline-size:100%; overflow:hidden!important; }
          body > :not(#jc-theme-accessibility-fixture) { display:none!important; }
          #jc-theme-accessibility-fixture {
            position:fixed; inset:0; z-index:1000000; box-sizing:border-box; overflow:auto;
            min-inline-size:0; background:var(--jc-color-canvas); color:var(--jc-color-text);
            font-family:var(--jc-type-family-ui); font-size:var(--jc-effective-font-size);
            line-height:var(--jc-type-line-height); padding:clamp(.6rem,2vw,1.5rem);
          }
          #jc-theme-accessibility-fixture * { box-sizing:border-box; }
          #jc-theme-accessibility-fixture header { display:flex; flex-wrap:wrap; gap:.55rem; align-items:center; max-inline-size:76rem; margin-inline:auto; }
          #jc-theme-accessibility-fixture header strong { overflow-wrap:anywhere; }
          #jc-theme-accessibility-fixture nav { display:flex; flex-wrap:wrap; gap:.45rem; margin-inline-start:auto; }
          #jc-theme-accessibility-fixture a,
          #jc-theme-accessibility-fixture button,
          #jc-theme-accessibility-fixture input { min-block-size:44px; max-inline-size:100%; font:inherit; }
          #jc-theme-accessibility-fixture a,
          #jc-theme-accessibility-fixture button { display:inline-flex; align-items:center; justify-content:center; padding:.45rem .75rem; }
          #jc-theme-accessibility-fixture button,
          #jc-theme-accessibility-fixture input { border:2px solid var(--jc-color-control-border); border-radius:var(--jc-shape-control-radius); background:var(--jc-color-surface); color:var(--jc-color-text); }
          #jc-theme-accessibility-fixture main { display:grid; grid-template-columns:minmax(0,1.25fr) minmax(17rem,.75fr); gap:1rem; max-inline-size:76rem; margin:1rem auto 0; }
          #jc-theme-accessibility-fixture section,
          #jc-theme-accessibility-fixture aside { min-inline-size:0; border:2px solid var(--jc-color-control-border); border-radius:var(--jc-shape-dialog-radius); padding:clamp(.7rem,2vw,1.25rem); background:var(--jc-color-surface); }
          #jc-theme-accessibility-fixture h1,
          #jc-theme-accessibility-fixture h2,
          #jc-theme-accessibility-fixture p { margin-block:.25em .6em; overflow-wrap:anywhere; }
          #jc-theme-accessibility-fixture .muted { color:var(--jc-color-text-muted); }
          #jc-theme-accessibility-fixture .states { display:flex; flex-wrap:wrap; gap:.4rem; margin-block:.7rem; }
          #jc-theme-accessibility-fixture .states span { border:2px solid currentColor; border-radius:999px; padding:.25rem .5rem; font-weight:800; }
          #jc-theme-accessibility-fixture .positive { color:var(--jc-color-positive); }
          #jc-theme-accessibility-fixture .caution { color:var(--jc-color-caution); }
          #jc-theme-accessibility-fixture .negative { color:var(--jc-color-negative); }
          #jc-theme-accessibility-fixture .info { color:var(--jc-color-info); }
          #jc-theme-accessibility-fixture .selected { border:3px double currentColor; font-weight:800; }
          #jc-theme-accessibility-fixture #jc-osd-rating-container { display:flex; flex-wrap:wrap; gap:.4rem; margin-block:.7rem; }
          #jc-theme-accessibility-fixture #jc-osd-rating-container .jc-chip { display:inline-flex; gap:.25rem; padding:.3rem .55rem; }
          #jc-theme-accessibility-fixture .image { min-block-size:12rem; display:grid; align-content:end; border-radius:var(--jc-shape-card-radius); background:linear-gradient(125deg,#f7c65a,#58358a 48%,#0c798c); overflow:hidden; }
          #jc-theme-accessibility-fixture .jc-theme-image-scrim { padding:1rem; }
          #jc-theme-accessibility-fixture label { display:grid; gap:.35rem; }
          #jc-theme-accessibility-fixture [role="alert"] { margin-block-start:.45rem; }
          #jc-theme-accessibility-fixture footer { grid-column:1/-1; display:flex; flex-wrap:wrap; gap:.55rem; align-items:center; }
          @media (max-width:760px) {
            #jc-theme-accessibility-fixture main { grid-template-columns:minmax(0,1fr); }
            #jc-theme-accessibility-fixture footer { grid-column:auto; }
            #jc-theme-accessibility-fixture header nav { margin-inline-start:0; }
          }
          @media (orientation:landscape) and (max-height:599px) {
            #jc-theme-accessibility-fixture { padding:.45rem; }
            #jc-theme-accessibility-fixture main { grid-template-columns:minmax(0,1fr) minmax(0,1fr); margin-block-start:.45rem; }
            #jc-theme-accessibility-fixture .image { min-block-size:7rem; }
          }
        `;
        const fixture = document.createElement('div');
        fixture.id = 'jc-theme-accessibility-fixture';
        fixture.tabIndex = -1;
        fixture.lang = 'ar';
        fixture.dir = 'rtl';
        fixture.innerHTML = `
          <header><strong>مظلّة جيلي‌فن · تخصيص شامل وسهل القراءة</strong>
            <nav aria-label="التنقل الرئيسي"><a href="#details">التفاصيل والإعدادات المتقدمة</a><button id="jc-a11y-primary" type="button" aria-pressed="true">تشغيل الآن</button></nav></header>
          <main>
            <section id="details"><p class="muted">واجهة حديثة لسطح المكتب والهاتف تحافظ على النصوص المحلية الطويلة وإعادة التدفق.</p>
              <h1>مكتبتك، واضحة ومميزة للجميع.</h1>
              <div class="states" aria-label="حالات الوسائط"><span class="positive">متاح</span><span class="caution">قريبًا</span><span class="negative">مباشر</span><span class="info">جديد</span></div>
              <div id="jc-osd-rating-container" aria-label="تقييمات الوسائط"><span class="jc-chip tmdb"><span class="jc-star">★</span><span class="jc-text">8.8</span></span><span class="jc-chip critic"><span class="jc-text">92%</span></span></div>
              <div class="image" role="img" aria-label="تدرج زخرفي مع لوحة نصية عالية التباين"><div class="jc-theme-image-scrim"><strong>النص فوق الصورة</strong><p>تضمن اللوحة الخلفية بقاء النص مقروءًا مهما تغيّرت الصورة.</p></div></div>
            </section>
            <aside><h2>نموذج ذو أخطاء دلالية</h2><label for="jc-a11y-name">اسم الملف الشخصي الطويل جدًا للاختبار</label>
              <input id="jc-a11y-name" aria-invalid="true" aria-errormessage="jc-a11y-error" value="">
              <p id="jc-a11y-error" role="alert">أدخل اسمًا صالحًا؛ لا يعتمد الخطأ على اللون وحده.</p>
              <button type="button" disabled>إجراء غير متاح</button></aside>
            <footer><span class="selected" aria-current="true">الملف المحدد</span><span lang="he" dir="rtl">תווית עברית ארוכה נשברת לשורות בלי להסתיר שום פעולה</span></footer>
          </main>`;
        document.head.append(style);
        document.body.append(fixture);
    });
}

async function themePresentationEvidence(page: Page): Promise<{
    readonly committed: number;
    readonly preview: number;
    readonly active: string | null;
    readonly previewAttribute: string | null;
    readonly breakpoint: string | null;
    readonly route: string | null;
    readonly preset: string | null;
}> {
    return page.evaluate(() => {
        const root = document.documentElement;
        return {
            committed: document.querySelectorAll('#jc-theme-studio-committed').length,
            preview: document.querySelectorAll('#jc-theme-studio-preview').length,
            active: root.getAttribute('data-jc-theme-active'),
            previewAttribute: root.getAttribute('data-jc-theme-preview'),
            breakpoint: root.getAttribute('data-jc-theme-breakpoint'),
            route: root.getAttribute('data-jc-theme-route'),
            preset: root.getAttribute('data-jc-theme-preset'),
        };
    });
}

const ABSENT_THEME_PRESENTATION = {
    committed: 0,
    preview: 0,
    active: null,
    previewAttribute: null,
    breakpoint: null,
    route: null,
    preset: null,
} as const;

async function layoutEvidence(page: Page): Promise<{
    readonly documentOverflow: number;
    readonly fixtureOverflow: number;
    readonly direction: string;
    readonly minimumTarget: number;
    readonly columns: number;
}> {
    return page.evaluate(() => {
        const fixture = document.getElementById('jc-theme-accessibility-fixture')!;
        const targets = [...fixture.querySelectorAll<HTMLElement>('a,button,input')]
            .filter((element) => {
                const box = element.getBoundingClientRect();
                return box.width > 0 && box.height > 0;
            });
        return {
            documentOverflow: document.scrollingElement!.scrollWidth - innerWidth,
            fixtureOverflow: fixture.scrollWidth - fixture.clientWidth,
            direction: getComputedStyle(fixture).direction,
            minimumTarget: Math.min(...targets.map((target) => target.getBoundingClientRect().height)),
            columns: getComputedStyle(fixture.querySelector('main')!).gridTemplateColumns.split(' ').length,
        };
    });
}

test.describe.serial('Theme Studio accessibility and internationalization', () => {
    let admin: Session;
    let original: Record<string, unknown>;

    test.beforeAll(async ({ baseURL }) => {
        admin = await authenticate(baseURL!, USERS.admin.username, USERS.admin.password);
        const configuration = await api<Record<string, unknown>>(baseURL!, CONFIG_PATH, admin.token);
        expect(configuration, 'plugin configuration must be readable').toBeTruthy();
        original = configuration!;
    });

    test.beforeEach(async ({ baseURL, page }) => {
        await installThemeStudioVisualFont(page);
        await api(baseURL!, CONFIG_PATH, admin.token, {
            method: 'POST',
            body: JSON.stringify({
                ...original,
                ThemeStudioEnabled: true,
                ThemeStudioDashboardEnabled: false,
                ThemeStudioMaximumEffectsLevel: 'full',
                ThemeStudioAllowDynamicColor: false,
                ThemeSelectorEnabled: false,
                LayoutEnforcement: 'None',
            }),
        });
        await seedModernCoarseLayout(page);
        await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce', forcedColors: 'none' });
    });

    test.afterEach(async ({ baseURL }) => {
        if (!admin || !original) return;
        await api(baseURL!, CONFIG_PATH, admin.token, {
            method: 'POST', body: JSON.stringify(original),
        });
    });

    test.afterAll(async ({ baseURL }) => {
        if (!admin || !original) return;
        await api(baseURL!, CONFIG_PATH, admin.token, {
            method: 'POST', body: JSON.stringify(original),
        });
    });

    test('preserves focus, states, Arabic/Hebrew RTL, 200% text and 400%-equivalent reflow', async ({
        page,
        consoleErrors,
    }) => {
        await page.setViewportSize({ width: 1366, height: 768 });
        await loginAs(page, 'admin', consoleErrors);
        await waitForThemeRuntime(page, 'desktop');
        await previewAccessibleTheme(page);
        await mountAccessibilityFixture(page);
        await expectNoAutomatedAccessibilityViolations(page, 'modern desktop');

        let evidence = await layoutEvidence(page);
        expect(evidence).toMatchObject({ direction: 'rtl', columns: 2 });
        expect(evidence.documentOverflow).toBeLessThanOrEqual(1);
        expect(evidence.fixtureOverflow).toBeLessThanOrEqual(1);
        expect(evidence.minimumTarget).toBeGreaterThanOrEqual(44);
        await expect(page.locator('#jc-theme-accessibility-fixture #jc-osd-rating-container .jc-chip').first())
            .toBeVisible();
        await expect(page).toHaveScreenshot('theme-studio-accessibility-desktop.png', {
            animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02,
        });

        const fixture = page.locator('#jc-theme-accessibility-fixture');
        await fixture.focus();
        await page.keyboard.press('Tab');
        await expect.poll(() => page.evaluate(() => {
            const styles = getComputedStyle(document.activeElement as Element);
            return {
                tag: document.activeElement?.tagName,
                outline: styles.outlineStyle,
                focusVisible: document.activeElement?.matches(':focus-visible'),
            };
        })).toMatchObject({ tag: 'A', outline: 'solid', focusVisible: true });
        await expect.poll(() => page.evaluate(() =>
            Number.parseFloat(getComputedStyle(document.activeElement as Element).outlineWidth)))
            .toBeGreaterThanOrEqual(3);
        await page.locator('#jc-a11y-primary').focus();
        expect(await page.locator('#jc-a11y-primary').evaluate((element) =>
            getComputedStyle(element).outlineStyle)).toBe('solid');

        const semantics = await page.evaluate(() => {
            const fixture = document.getElementById('jc-theme-accessibility-fixture')!;
            const resolvedVariable = (name: string): string => {
                const probe = document.createElement('span');
                probe.style.color = `var(${name})`;
                fixture.append(probe);
                const value = getComputedStyle(probe).color;
                probe.remove();
                return value;
            };
            const osdChip = fixture.querySelector('#jc-osd-rating-container .jc-chip')!;
            const chipStyle = getComputedStyle(osdChip);
            const osdBox = osdChip.getBoundingClientRect();
            return {
                selected: getComputedStyle(document.querySelector('.selected')!).borderStyle,
                disabled: getComputedStyle(document.querySelector('button:disabled')!).borderStyle,
                invalid: getComputedStyle(document.querySelector('[aria-invalid="true"]')!).borderStyle,
                errorRole: document.getElementById('jc-a11y-error')?.getAttribute('role'),
                errorReference: document.getElementById('jc-a11y-name')?.getAttribute('aria-errormessage'),
                imageName: document.querySelector('#jc-theme-accessibility-fixture [role="img"]')?.getAttribute('aria-label'),
                scrim: getComputedStyle(document.querySelector('.jc-theme-image-scrim')!).backgroundColor,
                osdColor: chipStyle.color,
                osdChildColor: getComputedStyle(osdChip.querySelector('.jc-star')!).color,
                osdBorderColor: chipStyle.borderColor,
                osdBackground: chipStyle.backgroundColor,
                osdWidth: osdBox.width,
                osdHeight: osdBox.height,
                textColor: resolvedVariable('--jc-color-text'),
                surfaceColor: resolvedVariable('--jc-color-surface'),
            };
        });
        expect(semantics).toMatchObject({
            selected: 'double', disabled: 'dashed', invalid: 'double', errorRole: 'alert',
            errorReference: 'jc-a11y-error',
        });
        expect(semantics.imageName?.length).toBeGreaterThan(20);
        expect(semantics.scrim).not.toBe('rgba(0, 0, 0, 0)');
        expect(semantics.osdColor).toBe(semantics.textColor);
        expect(semantics.osdChildColor).toBe(semantics.textColor);
        expect(semantics.osdBorderColor).toBe(semantics.textColor);
        expect(semantics.osdBackground).toBe(semantics.surfaceColor);
        expect(semantics.osdWidth).toBeGreaterThan(0);
        expect(semantics.osdHeight).toBeGreaterThan(0);

        await page.setViewportSize({ width: 1920, height: 1080 });
        await waitForThemeRuntime(page, 'wide');
        evidence = await layoutEvidence(page);
        expect(evidence.documentOverflow).toBeLessThanOrEqual(1);
        expect(evidence.fixtureOverflow).toBeLessThanOrEqual(1);

        await page.setViewportSize({ width: 390, height: 844 });
        await waitForThemeRuntime(page, 'phone');
        evidence = await layoutEvidence(page);
        expect(evidence).toMatchObject({ direction: 'rtl', columns: 1 });
        expect(evidence.documentOverflow).toBeLessThanOrEqual(1);
        expect(evidence.fixtureOverflow).toBeLessThanOrEqual(1);
        expect(evidence.minimumTarget).toBeGreaterThanOrEqual(44);
        await expectNoAutomatedAccessibilityViolations(page, 'modern phone portrait');
        await expect(page).toHaveScreenshot('theme-studio-accessibility-phone.png', {
            animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02,
        });

        await page.setViewportSize({ width: 844, height: 390 });
        await waitForThemeRuntime(page, 'phone');
        evidence = await layoutEvidence(page);
        expect(evidence.documentOverflow).toBeLessThanOrEqual(1);
        expect(evidence.fixtureOverflow).toBeLessThanOrEqual(1);
        expect(evidence.minimumTarget).toBeGreaterThanOrEqual(44);

        // 1280 CSS px at 400% browser zoom has a 320 CSS-pixel reflow viewport.
        await page.setViewportSize({ width: 320, height: 568 });
        await waitForThemeRuntime(page, 'phone');
        evidence = await layoutEvidence(page);
        expect(evidence.columns).toBe(1);
        expect(evidence.documentOverflow).toBeLessThanOrEqual(1);
        expect(evidence.fixtureOverflow).toBeLessThanOrEqual(1);

        await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce', forcedColors: 'active' });
        await expect.poll(() => page.evaluate(() =>
            document.documentElement.getAttribute('data-jc-theme-forced-colors'))).toBe('active');
        const forced = await page.evaluate(() => ({
            selected: getComputedStyle(document.querySelector('.selected')!).borderStyle,
            disabled: getComputedStyle(document.querySelector('button:disabled')!).borderStyle,
            scrimShadow: getComputedStyle(document.querySelector('.jc-theme-image-scrim')!).boxShadow,
            styles: document.getElementById('jc-theme-studio-preview')?.textContent ?? '',
        }));
        expect(forced.selected).toBe('double');
        expect(forced.disabled).toBe('dashed');
        expect(forced.scrimShadow).toBe('none');
        expect(forced.styles).toContain('--jf-palette-primary-main: Highlight');
        assertNoRuntimeErrors(consoleErrors);
    });

    test('keeps the accessible theme layer absent on tablet, legacy and TV layouts', async ({
        page,
        consoleErrors,
    }) => {
        await page.setViewportSize({ width: 1366, height: 768 });
        await loginAs(page, 'admin', consoleErrors);
        await waitForThemeRuntime(page, 'desktop');

        await page.setViewportSize({ width: 820, height: 1180 });
        await expect.poll(() => themePresentationEvidence(page)).toEqual(ABSENT_THEME_PRESENTATION);

        await page.evaluate(() => {
            document.documentElement.classList.remove('jc-modern-layout');
            document.documentElement.classList.add('jc-legacy-layout');
            window.dispatchEvent(new Event('resize'));
        });
        await expect.poll(() => themePresentationEvidence(page)).toEqual(ABSENT_THEME_PRESENTATION);

        await page.evaluate(() => {
            document.documentElement.classList.remove('jc-legacy-layout');
            document.documentElement.classList.add('jc-modern-layout', 'layout-tv');
            document.documentElement.setAttribute('data-layout', 'tv');
            window.dispatchEvent(new Event('resize'));
        });
        await expect.poll(() => themePresentationEvidence(page)).toEqual(ABSENT_THEME_PRESENTATION);
        assertNoRuntimeErrors(consoleErrors);
    });
});
