// src/core/ui-kit.ts
//
// Small shared UI primitives: THE escapeHtml (previously defined 3+ times),
// the toast notification (moved from enhanced/ui.js), and dedupe-by-id CSS
// injection (previously helpers.addCSS).
//
// Public surface: JE.core.ui { escapeHtml, toast, injectCss, removeCss }.
// Aliases kept: JE.escapeHtml, JE.toast, JE.helpers.addCSS/removeCSS/escHtml.

import { JE } from '../globals';
import type {
    MuiIconButtonOptions,
    MuiMenuItemOptions,
    SectionContainerOptions,
    UiApi
} from '../types/je';

JE.core = JE.core || {};

/**
 * Escapes HTML special characters to prevent XSS when interpolating into
 * HTML strings (innerHTML sinks, template literals, JE.toast, ...).
 * Non-string values are stringified first (null/undefined become '').
 * @param str - The value to escape.
 * @returns The escaped string safe for HTML interpolation.
 */
export function escapeHtml(str: unknown): string {
    // Frozen behavior: non-strings coerce via String() — objects intentionally
    // become '[object Object]' rather than throwing, exactly as pre-TS.
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    const s = typeof str === 'string' ? str : String(str ?? '');
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Add custom CSS to the page, deduped by id. Injecting the same id again
 * replaces the previous style element.
 * @param id - Unique ID for the style element
 * @param css - The CSS content
 */
export function injectCss(id: string, css: string): void {
    // Remove existing style with same ID
    const existing = document.getElementById(id);
    if (existing) {
        existing.remove();
    }

    const style = document.createElement('style');
    style.id = id;
    style.textContent = css;
    document.head.appendChild(style);

    console.log(`🪼 Jellyfin Enhanced: Added CSS: ${id}`);
}

/**
 * Remove injected CSS by ID.
 * @param id - The style element ID
 * @returns True if removed
 */
export function removeCss(id: string): boolean {
    const existing = document.getElementById(id);
    if (existing) {
        existing.remove();
        console.log(`🪼 Jellyfin Enhanced: Removed CSS: ${id}`);
        return true;
    }
    return false;
}

/**
 * Displays a short-lived toast notification (moved from enhanced/ui.js).
 * NOTE: renders via innerHTML — escape user-controlled content with
 * JE.core.ui.escapeHtml before passing it in.
 * @param html The (already localized/escaped) content to display.
 * @param duration How long to show the toast, in ms.
 */
export function toast(html: string, duration?: number): void {
    const ms = duration ?? (JE.CONFIG?.TOAST_DURATION || 1500);

    // Use the theme system to get appropriate colors
    const themeVars = JE.themer?.getThemeVariables?.() || {};
    const toastBg = themeVars.secondaryBg || 'linear-gradient(135deg, rgba(0,0,0,0.9), rgba(40,40,40,0.9))';
    const toastBorder = `1px solid ${themeVars.primaryAccent || 'rgba(255,255,255,0.1)'}`;
    const blurValue = themeVars.blur || '30px';

    const t = document.createElement('div');
    t.className = 'jellyfin-enhanced-toast';
    Object.assign(t.style, {
        position: 'fixed',
        bottom: '20px',
        right: '20px',
        transform: 'translateX(100%)',
        background: toastBg,
        color: '#fff',
        padding: '10px 14px',
        borderRadius: '8px',
        zIndex: 99999,
        fontSize: 'clamp(13px, 2vw, 16px)',
        textShadow: '-1px -1px 10px black',
        fontWeight: '500',
        boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
        backdropFilter: `blur(${blurValue})`,
        border: toastBorder,
        transition: 'transform 0.3s ease-out',
        maxWidth: 'clamp(280px, 80vw, 350px)'
    });
    t.innerHTML = html; // Note: the calling function should pass the localized string
    document.body.appendChild(t);
    setTimeout(() => { t.style.transform = 'translateX(0)'; }, 10);
    setTimeout(() => {
        t.style.transform = 'translateX(100%)';
        setTimeout(() => t.remove(), 300);
    }, ms);
}

// ── MUI component kit (v12 React/MUI markup match) ──────────────────────────
//
// Builders that produce plain DOM carrying the SAME class names the v12
// React/MUI client emits (verified against the jellyfin-web source, e.g.
// components/toolbar/UserMenuButton.tsx → MUI <IconButton size="large">).
// Because jellyfin-web's MUI stylesheet is global and its theme is emitted as
// CSS custom properties (createTheme({ cssVariables: { cssVarPrefix: 'jf' } }),
// selector [data-theme="%s"]), a hand-built element wearing those classes is
// styled natively by the running theme — so light/dark/custom themes all work
// with ZERO hardcoded colors. Where we add our own chrome we reference the same
// `--jf-palette-*` tokens (with non-color fallbacks) rather than literal colors.
//
// On the LEGACY layout the MUI stylesheet is present too; pass legacy classes
// via `className` when a button must live in both headers (dual-layout support).
//
// Usage:
//   const btn = JE.core.ui.muiIconButton({ icon: 'casino', title: 'Random',
//                                           onClick: () => run() });
//   trayContainer.prepend(btn);                       // native AppBar look
//   const item = JE.core.ui.muiMenuItem({ label: 'Settings', icon: 'tune',
//                                          onClick: open });
//   const section = JE.core.ui.sectionContainer({ title: 'Enhanced' });
//   section.appendChild(myCards);                     // matches home sections

const KIT_CSS_ID = 'je-ui-kit-css';
let kitCssInjected = false;

/** Inject the kit's small supplemental stylesheet once (theme-token driven). */
function ensureKitCss(): void {
    if (kitCssInjected) return;
    kitCssInjected = true;
    injectCss(KIT_CSS_ID, `
        /* IconButton glyph: MUI IconButton sizes its child SvgIcon; our glyph is
           a material-icons font span, so pin it to MUI's own icon sizes. Colour
           is inherited (colorInherit) — no hardcoded value. */
        .je-mui-icon-button .material-icons { font-size: 1.5rem; line-height: 1; }
        .je-mui-icon-button.MuiIconButton-sizeSmall .material-icons { font-size: 1.25rem; }
        /* MenuItem leading icon uses the secondary text token. */
        .je-mui-menu-item { display: flex; align-items: center; gap: 0.75rem; }
        .je-mui-menu-item .je-mui-menu-item-icon .material-icons {
            font-size: 1.5rem;
            color: var(--jf-palette-text-secondary, currentColor);
        }
    `);
}

/**
 * Build an MUI IconButton clone (the AppBar action-button markup). Styled
 * natively by the running theme via the MUI classes; the glyph is a
 * material-icons font ligature.
 * @param options - See {@link MuiIconButtonOptions}.
 * @returns The `<button>` (not yet attached — caller places it).
 */
export function muiIconButton(options: MuiIconButtonOptions): HTMLButtonElement {
    ensureKitCss();
    const size = options.size || 'large';
    const sizeClass = size === 'large'
        ? 'MuiIconButton-sizeLarge'
        : size === 'small' ? 'MuiIconButton-sizeSmall' : 'MuiIconButton-sizeMedium';

    const btn = document.createElement('button');
    btn.type = 'button';
    // MuiButtonBase-root + MuiIconButton-root + size + colorInherit are exactly
    // what MUI renders for <IconButton size=… color='inherit'>.
    btn.className = `MuiButtonBase-root MuiIconButton-root ${sizeClass} MuiIconButton-colorInherit je-mui-icon-button`;
    if (options.className) btn.className += ` ${options.className}`;
    if (options.id) btn.id = options.id;
    if (options.title) btn.title = options.title;
    const label = options.ariaLabel ?? options.title;
    if (label) btn.setAttribute('aria-label', label);

    const glyph = document.createElement('span');
    glyph.className = 'material-icons';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = options.icon;
    btn.appendChild(glyph);

    if (options.onClick) btn.addEventListener('click', options.onClick);
    return btn;
}

/**
 * Build an MUI MenuItem clone (`<li class="MuiMenuItem-root">`) with an optional
 * leading icon and a typography label. Styled natively by the MUI stylesheet.
 * @param options - See {@link MuiMenuItemOptions}.
 * @returns The `<li>` (not yet attached).
 */
export function muiMenuItem(options: MuiMenuItemOptions): HTMLLIElement {
    ensureKitCss();
    const li = document.createElement('li');
    li.className = 'MuiButtonBase-root MuiMenuItem-root MuiMenuItem-gutters je-mui-menu-item';
    if (options.className) li.className += ` ${options.className}`;
    if (options.id) li.id = options.id;
    li.setAttribute('role', 'menuitem');
    li.tabIndex = -1;

    if (options.icon) {
        const iconWrap = document.createElement('div');
        iconWrap.className = 'MuiListItemIcon-root je-mui-menu-item-icon';
        const glyph = document.createElement('span');
        glyph.className = 'material-icons';
        glyph.setAttribute('aria-hidden', 'true');
        glyph.textContent = options.icon;
        iconWrap.appendChild(glyph);
        li.appendChild(iconWrap);
    }

    const text = document.createElement('span');
    text.className = 'MuiTypography-root MuiTypography-body1';
    text.textContent = options.label;
    li.appendChild(text);

    if (options.onClick) li.addEventListener('click', options.onClick);
    return li;
}

/**
 * Build a `.verticalSection` matching the home-sections markup (the React home
 * wrapper hosts the legacy hometab controller inside `.homeSectionsContainer`;
 * each block is a `.verticalSection` with a `.sectionTitle`). Append content
 * directly into the returned element.
 * @param options - See {@link SectionContainerOptions}.
 * @returns The section `<div>` (title prepended when provided).
 */
export function sectionContainer(options: SectionContainerOptions = {}): HTMLDivElement {
    ensureKitCss();
    const section = document.createElement('div');
    section.className = 'verticalSection';
    if (options.className) section.className += ` ${options.className}`;
    if (options.id) section.id = options.id;

    if (options.title) {
        const heading = document.createElement('h2');
        heading.className = 'sectionTitle sectionTitle-cards';
        heading.textContent = options.title;
        section.appendChild(heading);
    }
    return section;
}

const ui: UiApi = {
    escapeHtml,
    toast,
    injectCss,
    removeCss,
    muiIconButton,
    muiMenuItem,
    sectionContainer
};

JE.core.ui = ui;

// Frozen-contract aliases: these are the canonical implementations now.
JE.escapeHtml = escapeHtml;
JE.toast = toast;

console.log('🪼 Jellyfin Enhanced: UI kit core initialized');
