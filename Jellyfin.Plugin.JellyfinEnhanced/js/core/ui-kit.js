// @ts-check
// /js/core/ui-kit.js
//
// Small shared UI primitives: THE escapeHtml (previously defined 3+ times),
// the toast notification (moved from enhanced/ui.js), and dedupe-by-id CSS
// injection (previously helpers.addCSS).
//
// Public surface: JE.core.ui { escapeHtml, toast, injectCss, removeCss }.
// Aliases kept: JE.escapeHtml, JE.toast, JE.helpers.addCSS/removeCSS/escHtml.
(function(JE) {
    'use strict';

    JE.core = JE.core || {};

    /**
     * Escapes HTML special characters to prevent XSS when interpolating into
     * HTML strings (innerHTML sinks, template literals, JE.toast, ...).
     * Non-string values are stringified first (null/undefined become '').
     * @param {*} str - The value to escape.
     * @returns {string} The escaped string safe for HTML interpolation.
     */
    function escapeHtml(str) {
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
     * @param {string} id - Unique ID for the style element
     * @param {string} css - The CSS content
     */
    function injectCss(id, css) {
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
     * @param {string} id - The style element ID
     * @returns {boolean} True if removed
     */
    function removeCss(id) {
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
     * @param {string} html The (already localized/escaped) content to display.
     * @param {number} [duration] How long to show the toast, in ms.
     */
    function toast(html, duration) {
        const ms = duration ?? ((JE.CONFIG && JE.CONFIG.TOAST_DURATION) || 1500);

        // Use the theme system to get appropriate colors
        const themeVars = JE.themer?.getThemeVariables() || {};
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
        setTimeout(() => t.style.transform = 'translateX(0)', 10);
        setTimeout(() => {
            t.style.transform = 'translateX(100%)';
            setTimeout(() => t.remove(), 300);
        }, ms);
    }

    JE.core.ui = {
        escapeHtml,
        toast,
        injectCss,
        removeCss
    };

    // Frozen-contract aliases: these are the canonical implementations now.
    JE.escapeHtml = escapeHtml;
    JE.toast = toast;

    console.log('🪼 Jellyfin Enhanced: UI kit core initialized');

})(window.JellyfinEnhanced);
