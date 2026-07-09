// src/enhanced/settings-panel/styles.ts
//
// Global CSS injected once for plugin features (JE.injectGlobalStyles).
// Split from ui.js (code motion; bodies verbatim).
// (Converted from js/enhanced/ui-styles.js — bodies semantically identical.)

import { JE } from '../../globals';
import { ensureMaterialSymbolsFont } from '../../core/ui-kit';

/**
 * Injects custom CSS for plugin features.
 */
JE.injectGlobalStyles = (): void => {
    // Shared icon font: ONE @font-face for all features, woff2 served from the
    // local asset cache (see core/asset-urls.ts) instead of fonts.gstatic.com.
    ensureMaterialSymbolsFont();
    const styleId = 'jellyfin-elevate-styles';
    if (document.getElementById(styleId)) return;
    const style = document.createElement('style');
    style.id = styleId;
    style.innerHTML = `
            @keyframes dice { 0%, 100% { transform: rotate(0deg) scale(1); } 10%, 30%, 50% { transform: rotate(-10deg) scale(1.1); } 20%, 40% { transform: rotate(10deg) scale(1.1); } 60% { transform: rotate(360deg) scale(1); } }
            button#randomItemButton:not(.loading):hover .material-icons { animation: dice 1.5s; }
            .layout-desktop #enhancedSettingsBtn { display: none !important; }
            /* Shared top offset for JE standalone interior pages (Hidden Content,
               Calendar, Requests) — the single source every one of those page
               containers inherits, replacing a per-page hardcoded padding-top:5em.
               Both the modern and legacy layouts already position .mainAnimatedPages
               below the fixed header, so this padding is breathing room, not header
               clearance; the old fixed 5em wasted roughly a third of a phone screen
               (the page heading sat far down the viewport). Keyed on the viewport so
               phones get a compact offset while desktop keeps its generous spacing. */
            .je-interior-page-top { padding-top: 5em; }
            @media (max-width: 768px) { .je-interior-page-top { padding-top: 1.25em; } }
            /* Remove menu items render like native action-sheet items; only dim them while the removal is in flight. */
            .actionSheetMenuItem[data-id="remove-continue-watching"]:disabled,
            .actionSheetMenuItem[data-id="je-multiselect-remove"]:disabled { opacity: 0.6; cursor: default; }
            /* Phone layout for the settings/help panel. Keyed on the VIEWPORT
               (@media), not the legacy .layout-mobile html class: on the Jellyfin 12
               modern (MUI) layout the html carries layout-desktop at every viewport
               (docs/v12-platform.md §1 — "html classes cannot discriminate layouts"),
               so a .layout-mobile-gated rule never applied on a real phone and the
               panel kept its desktop widths (50vw settings tab, two 400px shortcut
               columns) → horizontal clipping. The .layout-mobile selectors are kept
               as a belt-and-braces for the legacy mobile layout. */
            .layout-mobile #jellyfin-elevate-panel { width: 95vw; max-width: 95vw; }
            .layout-mobile #jellyfin-elevate-panel .shortcuts-container { flex-direction: column; }
            .layout-mobile #jellyfin-elevate-panel #settings-content { width: auto !important; }
            .layout-mobile #jellyfin-elevate-panel .panel-main-content { padding: 0 15px; }
            .layout-mobile #jellyfin-elevate-panel .panel-footer { flex-direction: row; gap: 16px; }
            .layout-mobile #jellyfin-elevate-panel .close-helptext { display: none; }
            .layout-mobile #jellyfin-elevate-panel .footer-buttons { flex-direction: column; align-items: flex-end !important; width: 100%; gap: 10px; }
            .layout-mobile #jellyfin-elevate-panel .footer-buttons > * { justify-content: center; }
            @media (max-width: 768px) {
                /* Fill the viewport width; drop the desktop min-width (350px would
                   overflow a 320px phone) and the 90vw inline max-width. */
                #jellyfin-elevate-panel { width: 95vw !important; max-width: 95vw !important; min-width: 0 !important; }
                /* Shortcuts: stack the two columns and release the 400px min-width
                   inline on each so they fit the narrow panel instead of clipping. */
                #jellyfin-elevate-panel .shortcuts-container { flex-direction: column; gap: 14px; }
                #jellyfin-elevate-panel .shortcuts-container > div { min-width: 0 !important; flex: 1 1 auto !important; }
                /* Settings tab: fill the panel instead of the fixed 50vw. */
                #jellyfin-elevate-panel #settings-content { width: auto !important; }
                #jellyfin-elevate-panel .panel-main-content { padding: 0 15px; }
                #jellyfin-elevate-panel .panel-footer { flex-direction: row; gap: 16px; }
                #jellyfin-elevate-panel .close-helptext { display: none; }
                #jellyfin-elevate-panel .footer-buttons { flex-direction: column; align-items: flex-end !important; width: 100%; gap: 10px; }
                #jellyfin-elevate-panel .footer-buttons > * { justify-content: center; }
            }
            @keyframes longPressGlow { from { box-shadow: 0 0 5px 2px var(--primary-accent-color, #fff); } to { box-shadow: 0 0 8px 15px transparent; } }
            .headerUserButton.long-press-active { animation: longPressGlow 750ms ease-out; }
            #jellyfin-elevate-panel kbd {
                background-color: rgba(255,255,255,0.1);
                border: 1px solid rgba(255,255,255,0.2);
                border-radius: 4px;
                padding: 2px 6px;
                font-size: 0.9em;
                font-family: inherit;
                box-shadow: 0 1px 1px rgba(0,0,0,0.2);
            }
            .mediaInfoItem-fileSize .material-icons,
            .mediaInfoItem-watchProgress .material-icons,
            .mediaInfoItem-audioLanguage .material-icons {
              font-family: 'Material Symbols Rounded' !important;
              line-height: 1;
              letter-spacing: normal;
              text-transform: none;
              display: inline-block;
              white-space: nowrap;
              word-wrap: normal;
              direction: ltr;
              -webkit-font-feature-settings: 'liga';
              -moz-font-feature-settings: 'liga';
              font-feature-settings: 'liga';
              -webkit-font-smoothing: antialiased;
            }
            .jellyseerr-issue-radio-group {
              display: flex;
              justify-content: center;
              flex-wrap: wrap;
              gap: 12px;
              margin-top: 12px;
            }
            .jellyseerr-radio-label {
                display: inline-flex;
                align-items: center;
                gap: 8px;
                cursor: pointer;
                position: relative;
            }
            .jellyseerr-radio-input {
                position: absolute;
                opacity: 0;
                width: 1px;
                height: 1px;
                margin: 0;
                padding: 0;
                clip: rect(0 0 0 0);
                border: 0;
            }
            .jellyseerr-radio-option {
                padding: 8px 12px;
                border-radius: 6px;
                border: 2px solid rgba(255,255,255,0.2);
                background-color: rgba(255,255,255,0.05);
                transition: all 0.2s ease;
                user-select: none;
                font-weight: 500;
                display: inline-flex;
                align-items: center;
            }
            .jellyseerr-radio-input:checked + .jellyseerr-radio-option {
                border-color: var(--primary-accent-color, #1e88e5);
                background-color: var(--primary-accent-color, #1e88e5);
                color: white;
            }
            .jellyseerr-radio-input:focus + .jellyseerr-radio-option {
                box-shadow: 0 0 0 4px rgba(30,136,229,0.12);
                outline: none;
            }
            .jellyseerr-radio-input:hover + .jellyseerr-radio-option {
                border-color: var(--primary-accent-color, #1e88e5);
                background-color: rgba(30,136,229,0.1);
            }
            .jellyseerr-issue-textarea {
              max-width: 96%;
              box-sizing: border-box;
            }
            /* Quality-tag category sub-panel — themed expander + reorderable
               rows. Lives inside the user Settings panel under the master
               Quality Tags toggle. Visual treatment mirrors the rest of the
               panel: subtle borders, accent on hover, material-icon arrows
               that match other JE icon buttons. */
            #jellyfin-elevate-panel .je-quality-cat-wrap { margin: 8px 0 0 30px; }
            #jellyfin-elevate-panel .je-quality-cat-expander {
                background: transparent;
                border: none;
                color: rgba(255,255,255,0.7);
                cursor: pointer;
                padding: 4px 0;
                font: inherit;
                font-size: 12px;
                display: flex;
                align-items: center;
                gap: 4px;
                transition: color 0.15s;
            }
            #jellyfin-elevate-panel .je-quality-cat-expander:hover { color: #fff; }
            #jellyfin-elevate-panel .je-cat-chevron {
                font-size: 18px !important;
                transition: transform 0.2s ease;
            }
            #jellyfin-elevate-panel .je-quality-cat-expander[aria-expanded="true"] .je-cat-chevron {
                transform: rotate(90deg);
                color: var(--primary-accent-color, #00a4dc);
            }
            #jellyfin-elevate-panel .je-quality-cat-list {
                margin: 6px 0 0 30px;
                padding: 8px 10px;
                background: rgba(0,0,0,0.18);
                border: 1px solid rgba(255,255,255,0.08);
                border-radius: 6px;
            }
            #jellyfin-elevate-panel .je-quality-cat-row {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 4px 2px;
            }
            #jellyfin-elevate-panel .je-quality-cat-row + .je-quality-cat-row {
                border-top: 1px solid rgba(255,255,255,0.06);
            }
            #jellyfin-elevate-panel .je-quality-cat-label-wrap {
                flex: 1;
                display: flex;
                align-items: center;
                gap: 8px;
                cursor: pointer;
                min-width: 0;
            }
            #jellyfin-elevate-panel .je-quality-cat-label-wrap input[type="checkbox"] {
                width: 16px;
                height: 16px;
                flex-shrink: 0;
                cursor: pointer;
            }
            #jellyfin-elevate-panel .je-quality-cat-label { font-size: 13px; }
            #jellyfin-elevate-panel .je-cat-btn {
                background: rgba(255,255,255,0.04);
                border: 1px solid rgba(255,255,255,0.15);
                color: rgba(255,255,255,0.85);
                border-radius: 4px;
                padding: 3px 6px;
                cursor: pointer;
                line-height: 1;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                transition: background 0.15s, border-color 0.15s, color 0.15s;
            }
            #jellyfin-elevate-panel .je-cat-btn .material-icons { font-size: 16px !important; }
            #jellyfin-elevate-panel .je-cat-btn:not([disabled]):hover {
                background: rgba(255,255,255,0.1);
                border-color: var(--primary-accent-color, rgba(255,255,255,0.35));
                color: #fff;
            }
            #jellyfin-elevate-panel .je-cat-btn[disabled] {
                opacity: 0.35;
                cursor: not-allowed;
            }
        `;
    document.head.appendChild(style);
};
