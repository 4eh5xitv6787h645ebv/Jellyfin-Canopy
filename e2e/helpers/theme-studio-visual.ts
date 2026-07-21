import type { Page } from 'playwright/test';

/**
 * Pins visual evidence to a font that is present in Playwright's supported
 * Linux environments. Production intentionally uses the host system stack,
 * but that stack resolves to different fonts on developer and CI machines.
 * Keeping this override inside the E2E harness preserves production behavior
 * while making layout-sensitive screenshots portable.
 */
export async function installThemeStudioVisualFont(page: Page): Promise<void> {
    await page.addInitScript((css) => {
        const install = (): void => {
            if (document.querySelector('style[data-jc-e2e-visual-font="deterministic"]')) return;
            const style = document.createElement('style');
            style.dataset.jcE2eVisualFont = 'deterministic';
            style.textContent = css;
            document.head.append(style);
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', install, { once: true });
        } else {
            install();
        }
    }, `
        :root {
            --jc-type-family-ui: "DejaVu Sans", sans-serif !important;
            --jc-type-family-display: "DejaVu Sans", sans-serif !important;
            --jc-type-family-mono: "DejaVu Sans Mono", monospace !important;
        }
        html,
        body,
        button,
        input,
        select,
        textarea {
            font-family: "DejaVu Sans", sans-serif !important;
        }
        code,
        pre {
            font-family: "DejaVu Sans Mono", monospace !important;
        }
    `);
}
