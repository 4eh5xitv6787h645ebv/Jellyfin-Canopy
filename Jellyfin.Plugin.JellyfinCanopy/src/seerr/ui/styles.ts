// src/seerr/ui/styles.ts
// CSS for Seerr search cards, buttons, popovers and the season modal.
import { ui } from './internal';

// ================================
// STYLING SYSTEM
// ================================

/**
 * Adds main CSS styles for Seerr integration.
 */
ui.addMainStyles = function () {
    const styleId = 'seerr-styles';
    if (document.getElementById(styleId)) return;
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
        /* LAYOUT & ICONS */
        .seerr-section { margin-bottom: 1em; }
        .seerr-section .itemsContainer { }
        #seerr-search-icon { position: absolute; right: 10px; top: 68%; transform: translateY(-50%); user-select: none; z-index: 10; transition: filter .2s, opacity .2s, transform .2s; }
        .inputContainer { position: relative !important; }
        .seerr-icon { width: 30px; height: 50px; filter: drop-shadow(2px 2px 6px #000); }
        #seerr-search-icon.is-active { filter: drop-shadow(2px 2px 6px #000); opacity: 1; }
        #seerr-search-icon.is-disabled { filter: grayscale(1); opacity: .8; }
        #seerr-search-icon.is-no-user { filter: hue-rotate(125deg) brightness(100%); }
        #seerr-search-icon.is-filter-active { filter: drop-shadow(2px 2px 6px #3b82f6) brightness(1.2); transform: translateY(-50%) scale(1.1); }
        #seerr-search-icon:hover { transform: translateY(-50%) scale(1.05); transition: transform 0.2s ease; }
        /* CARDS & BADGES */
        .seerr-card { position: relative; }
        .seerr-card .cardScalable { contain: paint; }
        .seerr-icon-on-card { width: 1.2em !important; height: 1.2em !important; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.6)); flex-shrink: 0; }
        .seerr-status-badge { position: absolute; top: 8px; right: 8px; z-index: 100; width: 1.5em; height: 1.5em; border-radius: 50%; display: flex; align-items: center; justify-content: center; border: 1.5px solid rgba(255,255,255,0.3); box-shadow: 0 0 1px rgba(255,255,255,0.4) inset, 0 4px 12px rgba(0,0,0,0.6); }
        .seerr-status-badge svg { width: 1.4em; height: 1.4em; filter: drop-shadow(0 1px 3px rgba(0,0,0,0.6)); }
        .seerr-status-badge.status-available { background-color: rgba(34, 197, 94, 0.7); border-color: rgba(34, 197, 94, 0.3); }
        .seerr-status-badge.status-processing { background-color: rgba(99, 102, 241, 0.7); border-color: rgba(99, 102, 241, 0.3); }
        .seerr-status-badge.status-requested { background-color: rgba(136, 61, 206, 0.7); border-color: rgba(147, 51, 234, 0.3); }
        .seerr-status-badge.status-pending { background-color: rgba(251, 146, 60, 0.7); border-color: rgba(251, 146, 60, 0.3); }
        .seerr-status-badge.status-partially-available { background-color: rgba(34, 197, 94, 0.7); border-color: rgba(34, 197, 94, 0.3); }
        .seerr-status-badge.status-blocklisted { background-color: rgba(120, 53, 15, 0.7); border-color: rgba(120, 53, 15, 0.3); }
        .seerr-status-badge.status-deleted { background-color: rgba(220, 38, 38, 0.78); border-color: rgba(248, 113, 113, 0.6); }
        @keyframes seerr-spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .seerr-status-badge.status-processing svg { animation: seerr-spin 1s linear infinite; }
        .seerr-media-badge { position: absolute; top: 8px; left: 8px; z-index: 100; color: #fff; padding: 2px 8px; border-radius: 999px; border: 1px solid rgba(0,0,0,0.2); font-size: 1em; font-weight: 500; text-transform: uppercase; letter-spacing: 1.5px; text-shadow: 1px 1px 3px rgba(0, 0, 0, 0.8); box-shadow: 0 4px 4px -1px rgba(0,0,0,0.1), 0 2px 2px -2px rgba(0,0,0,0.1); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }
        .layout-mobile .seerr-media-badge { font-size: 0.8em !important; }
        .seerr-media-badge-movie { background-color: rgba(59, 130, 246, .9); box-shadow: 0 0 0 1px rgba(59,130,246,.35), 0 8px 24px rgba(59,130,246,.25); }
        .seerr-media-badge-series { background-color: rgba(243, 51, 214, .9); box-shadow: 0 0 0 1px rgba(236,72,153,.35), 0 8px 24px rgba(236,72,153,.25); }
        .seerr-media-badge-collection { background-color: rgba(16, 185, 129, .9); box-shadow: 0 0 0 1px rgba(16,185,129,.35), 0 8px 24px rgba(16,185,129,.25); }
        .seerr-collection-badge { position: absolute; bottom: 40px; left: 50%; transform: translateX(-50%); z-index: 1000; color: #fff; padding: 6px 16px; border-radius: 999px; border: 1px solid rgba(0,0,0,0.2); font-size: 0.8em; font-weight: 600; display: flex; align-items: center; justify-content: center; gap: 6px; text-transform: none; letter-spacing: .25px; text-shadow: 1px 1px 3px rgba(0, 0, 0, 0.8); background-color: rgba(16, 185, 129, .85); box-shadow: 0 0 0 1px rgba(16,185,129,.35), 0 8px 24px rgba(16,185,129,.25); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); cursor: pointer; transition: all 0.2s ease; max-width: 85%; pointer-events: auto; }
        .cardImageContainer:has(.seerr-elsewhere-icons:not(.has-icons)) .seerr-collection-badge { bottom: 10px; }
        .seerr-collection-badge:hover { transform: translateX(-50%) translateY(-2px); box-shadow: 0 0 0 1px rgba(16,185,129,.5), 0 12px 32px rgba(16,185,129,.35); }
        .seerr-collection-badge .material-icons { font-size: 1.1em; flex-shrink: 0; }
        .seerr-collection-badge span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .seerr-overview { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(0,0,0,0) 30%, rgba(0,0,0,.78) 75%, rgba(0,0,0,.92) 100%); color: #e5e7eb; padding: 12px 12px 14px; line-height: 1.5; opacity: 1; pointer-events: auto; transform: translateY(0); transition: opacity .18s ease, transform .18s ease; overflow: hidden; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; gap: 10px; backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px); }
        .seerr-overview .content { width: 100%; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; white-space: normal; }
        /* SHOW OVERVIEW: When card has 'is-touch' class (mobile/click) */
        .seerr-card.is-touch .seerr-overview { opacity: 1; pointer-events: auto; }
        .seerr-card .cardScalable:focus-within .seerr-overview { opacity: 1; pointer-events: auto; }

        /* SHOW OVERVIEW: Desktop Hover (Media Query Handles Desktop vs Touch separation properly) */
        @media (hover: hover) {
            .seerr-card .cardScalable:hover .seerr-overview { opacity: 1; pointer-events: auto; }
        }

        .seerr-overview .title { font-weight: 600; display: block; margin-bottom: .35em; }
        .seerr-elsewhere-icons { display: none; position: absolute; bottom: 0; left:0; right:0; z-index: 3; justify-content: center; gap: 0.6em; pointer-events: none; background: rgba(0,0,0,0.8); border-top-left-radius: 1.5em; border-top-right-radius: 1.5em; padding: 0.5em 0 0.2em 0; }
        .seerr-elsewhere-icons.has-icons {display: flex;}
        .seerr-elsewhere-icons img { width: 1.8em; border-radius: 0.7em; background-color: rgba(255,255,255,0.5); padding: 2px;}
        .seerr-meta { display: flex; justify-content: center; align-items: center; gap: 1em; padding: 0 .75em; }
        .seerr-rating { display: flex; align-items: center; gap: .3em; color: #bdbdbd; }
        .cardText-first > a.seerr-more-info-link { padding: 0 !important; margin: 0 !important; color: inherit; text-decoration: none; }
        /* REQUEST BUTTONS */
        .seerr-request-button { display: flex; justify-content: center; align-items: center; gap: 0.5em; white-space: normal; text-align: center; padding: 0.6em 1.2em; line-height: 1.2; font-size: 0.9em; transition: background .2s, border-color .2s, color .2s, transform .2s; border-radius: 8px; border: none; font-weight: 600; cursor: pointer; position: relative; z-index: 10; }
        .seerr-request-button svg { width: 1.2em; height: 1.2em; flex-shrink: 0; vertical-align: middle; }
        .layout-mobile .seerr-request-button svg { width: 1em; height: 1em; }
        .layout-mobile .seerr-request-button span { font-size: 0.8em !important; }
        /* Phone sizing for Seerr card overlays — keyed on the VIEWPORT, not the
           inert .layout-mobile html class. On the Jellyfin 12 modern layout the
           html carries layout-desktop at every viewport (see the layout modes
           and enforcement section in docs/developers.md), so the .layout-mobile
           rules above never fired on a real phone:
           the MOVIE/SERIES badge, provider-logo strip, request button and hide
           overlay all stayed desktop-sized on top of the cards — most visible in
           the collection "Missing from …" grid once the cards match native width. */
        @media (max-width: 768px) {
            .seerr-media-badge { font-size: 0.75em; padding: 2px 7px; letter-spacing: 1px; }
            .seerr-request-button svg { width: 1em; height: 1em; }
            .seerr-request-button span { font-size: 0.8em !important; }
            .seerr-elsewhere-icons { gap: 0.4em; padding: 0.35em 0 0.15em 0; }
            .seerr-elsewhere-icons img { width: 1.4em; }
            .seerr-card .jc-hide-btn,
            .seerr-card .jc-hide-btn.jc-already-hidden { width: 24px; height: 24px; font-size: 14px; }
            .seerr-card .jc-hide-btn .material-icons { font-size: 14px; }
        }
        .seerr-request-button.seerr-button-offline, .seerr-request-button.seerr-button-no-user { opacity: .6; cursor: not-allowed; }
        .seerr-request-button.seerr-button-request { background-color: #5a3fb8 !important; color: #fff !important; }
        .seerr-request-button.seerr-button-request:hover:not(:disabled) { background-color: #6b4bb5 !important; transform: translateY(-2px); box-shadow: 0 4px 12px rgba(90, 63, 184, 0.4); }
        .seerr-request-button.seerr-button-pending { background-color: #b45309 !important; color: #fff !important; }
        .seerr-request-button.seerr-button-pending:hover:not(:disabled) { background-color: #d97706 !important; transform: translateY(-2px); }
        .seerr-request-button.seerr-button-processing { background-color: #581c87 !important; color: #fff !important; }
        .seerr-request-button.seerr-button-blocklisted { background-color: #78350f !important; color: #fff !important; }
        .seerr-request-button.seerr-button-deleted { background-color: #dc2626 !important; color: #fff !important; }
        .seerr-request-button.seerr-button-partially-available { background-color: #4ca46c !important; color: #fff !important; }
        .seerr-request-button.seerr-button-partially-available:hover:not(:disabled) { background-color: #5bb876 !important; transform: translateY(-2px); }
        .seerr-request-button.seerr-button-available { background-color: #16a34a !important; color: #fff !important; }
        .seerr-request-button.seerr-button-available-updating { background-color: #0d6d30ff !important; color: #fff !important; }
        .seerr-request-button.seerr-button-error { background: #dc3545 !important; color: #fff !important; }
        .seerr-request-button.seerr-button-tv:not(.seerr-button-available):not(.seerr-button-offline):not(.seerr-button-no-user):not(.seerr-button-error)::after { content: '▼'; margin-left: 6px; font-size: 0.7em; opacity: 0.8; }
        .seerr-season-summary { font-size: 0.85em; opacity: 0.9; display: block; margin-top: 2px; }
        /* SPLIT BUTTON FOR 4K */
        /* Allow button group and popup to overflow card footer */
        .seerr-card .cardFooter {
            overflow: visible !important;
        }
        .seerr-card .cardBox { overflow: visible !important; }
        .seerr-section .vertical-wrap { overflow: visible !important; }

        /* Library item styling */
        .seerr-card-in-library .cardText-first a {
            color: #00d084;
            font-weight: 500;
        }
        /* SPLIT BUTTON FOR 4K */
        .seerr-button-group {
            display: inline-flex;
            width: auto;
            position: relative;
            gap: 0;
            align-items: stretch;
            border-radius: 8px;
            overflow: hidden;
        }
        .seerr-button-group .seerr-split-main {
            border-top-right-radius: 0px !important;
            border-bottom-right-radius: 0px !important;
            margin: 0 !important;
            flex: 1;
        }
        button.seerr-split-arrow {
            border-top-left-radius: 0px !important;
            border-bottom-left-radius: 0px !important;
            cursor: pointer;
            color: #fff !important;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            transition: background .2s, opacity .2s;
            flex-shrink: 0;
            position: relative;
            z-index: 1;
            margin: 0 !important;
            padding: 0.6em 0.4em !important;
            border-left: 2px solid rgba(0, 0, 0, 0.4);
            border-bottom-width: 0px;
            border-top-width: 0px;
            border-right-width: 0px;
        }
        /* Match arrow button color to main button */
        .seerr-button-group .seerr-button-request ~ .seerr-split-arrow {
            background-color: #5a3fb8 !important;
        }
        .seerr-button-group .seerr-button-pending ~ .seerr-split-arrow {
            background-color: #b45309 !important;
        }
        .seerr-button-group .seerr-button-available ~ .seerr-split-arrow {
            background-color: #16a34a !important;
        }
        .seerr-button-group .seerr-button-available-updating ~ .seerr-split-arrow {
            background-color: #16a34a !important;
        }
        .seerr-button-group .seerr-button-processing ~ .seerr-split-arrow {
            background-color: #581c87 !important;
        }
        .seerr-button-group .seerr-button-blocklisted ~ .seerr-split-arrow {
            background-color: #78350f !important;
        }
        .seerr-button-group .seerr-button-deleted ~ .seerr-split-arrow {
            background-color: #dc2626 !important;
        }
        .seerr-button-group .seerr-button-partially-available ~ .seerr-split-arrow {
            background-color: #4ca46c !important;
        }
        /* Override for 4K specific states */
        .seerr-split-arrow.seerr-4k-available {
            background-color: #16a34a !important;
        }
        .seerr-split-arrow.seerr-4k-pending {
            background-color: #b45309 !important;
        }
        .seerr-split-arrow svg {
            width: 1em;
            height: 1em;
        }
        .seerr-split-arrow:hover:not(:disabled) { opacity: 0.8; }
        .seerr-split-arrow:active:not(:disabled) { opacity: 0.7; }
        .seerr-split-arrow:disabled,
        .seerr-split-arrow.seerr-split-arrow-disabled {
            opacity: 0.5;
            cursor: default;
        }

        /* 4K POPUP MENU */
        .seerr-4k-popup {
            position: absolute;
            top: 100%;
            left: 0;
            right: 0;
            background: rgba(0, 0, 0, 0.5);
            border: 1px solid rgba(148, 163, 184, 0.2);
            border-radius: 8px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.45);
            z-index: 10000;
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.2s ease;
            margin-top: 4px;
            overflow: visible;
        }
        .seerr-4k-popup.show {
            opacity: 1;
            pointer-events: all;
            width: fit-content;
        }
        .seerr-4k-popup-item {
            width: 100%;
            border: none;
            background: transparent;
            color: #f8fafc;
            text-align: left;
            cursor: pointer;
            transition: background 0.2s;
            font-size: 0.95rem;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 8px;
            white-space: nowrap;
            padding: 0.5em 0.75em;
            min-height: 2.5em;
        }
        .seerr-4k-popup-item:not(:disabled):hover {
            background: rgba(59, 130, 246, 0.5);
        }
        .seerr-4k-popup-item:not(:disabled):active {
            background: rgba(59, 130, 246, 0.3);
        }
        .seerr-4k-popup-item:disabled {
            opacity: 0.8;
            cursor: default;
            color: #07e659;
        }
        .seerr-4k-popup-item.seerr-4k-available {
            color: #16a34a;
        }
        /* Status-based popup colors matching button styles */
        .seerr-4k-popup.show { background: #5a3fb8 !important; }
        .seerr-4k-popup.show .seerr-4k-popup-item { color: #fff !important; }
        .seerr-4k-popup-item.chip-requested { background-color: #5a3fb8 !important; color: #fff !important; }
        .seerr-4k-popup-item.chip-pending { background-color: #b45309 !important; color: #fff !important; }
        .seerr-4k-popup-item.chip-processing { background-color: #581c87 !important; color: #fff !important; }
        .seerr-4k-popup-item.chip-available { background-color: #16a34a !important; color: #fff !important; }
        .seerr-4k-popup-item svg {
            flex-shrink: 0;
            width: 18px;
            height: 18px;
        }
        /* SPINNERS & LOADERS */
        .seerr-spinner, .seerr-loading-spinner, .seerr-button-spinner { display: inline-block; border-radius: 50%; animation: seerr-spin 1s linear infinite; }
        .seerr-loading-spinner { width: 20px; height: 20px; border: 3px solid rgba(255,255,255,.3); border-top-color: #fff; margin-left: 10px; vertical-align: middle; }
        .seerr-button-spinner { width: 1em; height: 1em; border: 2px solid currentColor; border-right-color: transparent; margin-left: .5em; flex-shrink: 0; }
        /* HOVER POPOVER STYLES */
        .seerr-hover-popover { position: fixed; min-width: 260px; max-width: 340px; padding: 10px 12px; background: #1f2937; color: #e5e7eb; border-radius: 10px; z-index: 9999; box-shadow: 0 10px 30px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,252, .06); opacity: 0; pointer-events: none; transition: opacity .12s ease, transform .12s ease; }
        .seerr-hover-popover.show { opacity: 1; }
        .seerr-popover-item { margin-bottom: 10px; }
        .seerr-popover-item:last-child { margin-bottom: 0; }
        .seerr-popover-item:not(:last-child) { padding-bottom: 10px; border-bottom: 1px solid rgba(255,255,255,.08); }
        .seerr-hover-popover .title { font-weight: 600; font-size: .9rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 8px; }
        .seerr-hover-popover .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 6px; }
        .seerr-hover-popover .status { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: .75rem; font-weight: 600; background: #4f46e5; color: #fff; }
        .seerr-hover-popover .seerr-hover-progress { height: 7px; width: 100%; background: rgba(255,255,255,.12); border-radius: 999px; overflow: hidden; }
        .seerr-hover-popover .seerr-hover-progress .bar { height: 100%; background: linear-gradient(90deg, #3b82f6, #8b5cf6); transition: width .2s ease; }
        .seerr-hover-popover .eta { margin-left: auto; font-size: .75rem; color: #cbd5e1; opacity: .9; white-space: nowrap; }
        /* UTILITY CLASSES */
        @keyframes seerr-spin { to { transform: rotate(360deg) } }
        .section-hidden { display: none !important; }
    `;
    document.head.appendChild(style);
};

/**
 * Adds enhanced CSS styles for season selection modal.
 */
ui.addSeasonModalStyles = function () {
    const seasonStyleId = 'seerr-season-styles';
    if (document.getElementById(seasonStyleId)) return;
    const style = document.createElement('style');
    style.id = seasonStyleId;
    style.textContent = `
        /* MODAL STYLES */
        .seerr-season-modal { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 10, 20, 0.85); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); z-index: 10000; display: flex; align-items: center; justify-content: center; opacity: 0; pointer-events: none; transition: opacity 0.3s ease; }
        .seerr-season-modal.show { opacity: 1; pointer-events: all; }
        body.seerr-modal-is-open { overflow: hidden; }
        .seerr-season-content { background: linear-gradient(145deg, #1e293b 0%, #0f172a 100%); border: 1px solid rgba(148, 163, 184, 0.1); border-radius: 16px; padding: 0; max-width: 700px; width: 90%; max-height: 80vh; overflow: hidden; box-shadow: 0 25px 80px rgba(0,0,0,0.8), 0 0 0 1px rgba(148, 163, 184, 0.05), inset 0 1px 0 rgba(148, 163, 184, 0.1); transform: scale(0.95); transition: transform 0.3s ease; display: flex; flex-direction: column; }
        .seerr-season-modal.show .seerr-season-content { transform: scale(1); }
        .seerr-season-header { position: relative; padding: 24px; border-radius: 16px 16px 0 0; overflow: hidden; height: 8em; flex-shrink: 0; }
        .seerr-season-header::before { content: ''; position: absolute; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none; backdrop-filter: blur(2px); background: rgba(0, 0, 0, 0.8); }
        .seerr-season-title { position: relative; font-size: 1.8rem; font-weight: 700; margin-bottom: 6px; background: linear-gradient(45deg, #3b82f6, #8b5cf6); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .seerr-season-subtitle { position: relative; font-size: 1.4rem; color: rgba(255,255,255,0.9); font-weight: 500; }
        .seerr-modal-body { padding: 24px; overflow-y: auto; }
        .seerr-advanced-options { margin-top: 1em; padding-top: 1em; border-top: 1px solid rgba(148, 163, 184, 0.1); }
        .seerr-advanced-options h3 { margin-top: 0; }
        .seerr-form-row { display: flex; gap: 1em; margin-bottom: 1em; }
        .seerr-form-group { flex: 1; }
        .seerr-form-group label { display: block; margin-bottom: 0.5em; font-weight: 600; color: #e2e8f0; }
        .seerr-form-group select, .seerr-form-group input, .seerr-form-group textarea { width: 100%; padding: 0.75em 0.875em; border-radius: 6px; border: 1px solid rgba(71, 85, 105, 0.5); background-color: rgba(30, 41, 59, 0.7); color: #e2e8f0; font-size: 0.95rem; transition: border-color 0.2s ease, background-color 0.2s ease; }
        .seerr-form-group select:hover, .seerr-form-group input:hover, .seerr-form-group textarea:hover { border-color: rgba(59, 130, 246, 0.4); background-color: rgba(30, 41, 59, 1); }
        .seerr-form-group select:focus, .seerr-form-group input:focus, .seerr-form-group textarea:focus { outline: none; border-color: rgba(59, 130, 246, 0.8); background-color: rgba(30, 41, 59, 1); box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1); }
        .seerr-form-group textarea { resize: vertical; font-family: inherit; }
        .seerr-form-group select[is="emby-select"] { background-color: rgba(30, 41, 59, 0.7) !important; color: #e2e8f0 !important; border: 1px solid rgba(51, 65, 85, 0.5) !important; border-radius: 8px !important; padding: 12px 16px !important; font-size: 0.95rem !important; -webkit-appearance: none; -moz-appearance: none; appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='%2394a3b8' viewBox='0 0 16 16'%3E%3Cpath fill-rule='evenodd' d='M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708z'/%3E%3C/svg%3E") !important; background-repeat: no-repeat !important; background-position: right 16px center !important; transition: border-color 0.2s ease, background-color 0.2s ease !important; }
        .seerr-form-group select[is="emby-select"]:hover { border-color: rgba(59, 130, 246, 0.4) !important; background-color: rgba(30, 41, 59, 1) !important; }
        .seerr-issue-form { padding: 0; }
        .seerr-issue-select { width: 100%; padding: 0.75em 0.875em; border-radius: 6px; border: 1px solid rgba(71, 85, 105, 0.5); background-color: rgba(30, 41, 59, 0.7); color: #e2e8f0; font-size: 0.95rem; transition: border-color 0.2s ease; }
        .seerr-issue-select:hover { border-color: rgba(59, 130, 246, 0.4); background-color: rgba(30, 41, 59, 1); }
        .seerr-issue-select:focus { outline: none; border-color: rgba(59, 130, 246, 0.8); box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1); }
        .seerr-issue-textarea { width: 100%; padding: 0.75em 0.875em; border-radius: 6px; border: 1px solid rgba(71, 85, 105, 0.5); background-color: rgba(30, 41, 59, 0.7); color: #e2e8f0; font-size: 0.95rem; font-family: inherit; resize: vertical; transition: border-color 0.2s ease; }
        .seerr-issue-textarea:hover { border-color: rgba(59, 130, 246, 0.4); background-color: rgba(30, 41, 59, 1); }
        .seerr-issue-textarea:focus { outline: none; border-color: rgba(59, 130, 246, 0.8); background-color: rgba(30, 41, 59, 1); box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1); }
        .seerr-season-list { display: grid; gap: 4px; margin-bottom: 24px; }
        .seerr-season-header-row { display: grid; grid-template-columns: 40px 1fr auto auto; align-items: center; gap: 16px; padding: 12px 20px; background: rgba(51, 65, 85, 0.3); border: 1px solid rgba(71, 85, 105, 0.4); border-radius: 12px; margin-bottom: 8px; font-weight: 600; color: #e2e8f0; }
        .seerr-season-header-row .seerr-season-checkbox { cursor: pointer; }
        .seerr-season-header-label { font-size: 0.95rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #cbd5e1; }
        .seerr-season-item { display: grid; grid-template-columns: 40px 1fr auto auto; align-items: center; gap: 16px; padding: 16px 20px; background: rgba(30, 41, 59, 0.4); border: 1px solid rgba(51, 65, 85, 0.3); border-radius: 12px; transition: all 0.2s ease; position: relative; }
        .seerr-season-item:hover:not(.disabled) { background: rgba(30, 41, 59, 0.7); border-color: rgba(59, 130, 246, 0.3); transform: translateY(-1px); }
        .seerr-season-item.disabled { background: rgba(15, 23, 42, 0.6); opacity: 0.6; border-color: rgba(51, 65, 85, 0.2); }
        .seerr-season-checkbox { width: 20px; height: 20px; accent-color: #4f46e5; border-radius: 4px; }
        .seerr-season-checkbox:disabled { opacity: 0.4; cursor: not-allowed; }
        .seerr-season-info { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
        .seerr-season-name { font-weight: 600; color: #e2e8f0; font-size: 1rem; }
        .seerr-season-meta { font-size: 0.875rem; color: #94a3b8; }
        .seerr-season-episodes { font-size: 0.875rem; color: #64748b; text-align: right; min-width: 70px; font-weight: 500; }
        .seerr-season-status { padding: 6px 12px; border-radius: 20px; font-size: 0.75rem; font-weight: 700; text-transform: uppercase; min-width: 110px; text-align: center; letter-spacing: 0.5px; border: 1px solid transparent; }
        .seerr-season-status-available { background: rgba(34, 197, 94, 0.15); color: #4ade80; border-color: rgba(34, 197, 94, 0.3); }
        .seerr-season-status-pending { background: rgba(251, 146, 60, 0.15); color: #fb923c; border-color: rgba(251, 146, 60, 0.3); }
        .seerr-season-status-processing { background: rgba(147, 51, 234, 0.15); color: #a855f7; border-color: rgba(147, 51, 234, 0.3); }
        .seerr-season-status-partially-available { background: rgba(34, 197, 94, 0.15); color: #4ade80; border-color: rgba(34, 197, 94, 0.3); }
        .seerr-season-status-not-requested { background: rgba(99, 102, 241, 0.15); color: #818cf8; border-color: rgba(99, 102, 241, 0.3); }
        .seerr-inline-progress { grid-column: 1 / -1; padding: 8px 12px; background: rgba(15, 23, 42, 0.5); border-radius: 8px; border: 1px solid rgba(59, 130, 246, 0.2); }
        .seerr-inline-progress-bar { height: .5rem; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden; margin-bottom: .5rem; }
        .seerr-inline-progress-fill { height: 100%; background: linear-gradient(90deg, #3b82f6, #8b5cf6); transition: width 0.3s ease; border-radius: 3px; }
        .seerr-inline-progress-text { font-size: 0.75rem; color: #94a3b8; font-weight: 500; }
        .seerr-collection-4k-toggle { display: inline-flex; align-items: center; gap: 8px; padding: 10px 16px; margin-bottom: 12px; background: rgba(51, 65, 85, 0.3); border: 1px solid rgba(71, 85, 105, 0.4); border-radius: 12px; font-weight: 600; color: #e2e8f0; cursor: pointer; }
        .seerr-collection-4k-toggle input { width: 20px; height: 20px; accent-color: #4f46e5; border-radius: 4px; cursor: pointer; }
        .seerr-collection-list { display: grid; gap: 6px; min-width: 0; }
        .seerr-collection-header-row { display: grid; grid-template-columns: 40px minmax(0, 1fr); align-items: center; gap: 16px; padding: 12px 20px; background: rgba(51, 65, 85, 0.3); border: 1px solid rgba(71, 85, 105, 0.4); border-radius: 12px; margin-bottom: 8px; font-weight: 600; color: #e2e8f0; }
        .seerr-collection-header-row .seerr-collection-checkbox { cursor: pointer; }
        .seerr-collection-header-copy { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
        .seerr-collection-header-label { font-size: 0.95rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #cbd5e1; }
        .seerr-collection-count { color: #94a3b8; font-size: 0.82rem; font-weight: 500; line-height: 1.25; overflow-wrap: anywhere; }
        .seerr-collection-checkbox { width: 22px; height: 22px; margin: 0; accent-color: var(--theme-primary-color, #4f46e5); border-radius: 4px; cursor: pointer; }
        .seerr-collection-checkbox:disabled { opacity: 0.4; cursor: not-allowed; }
        .seerr-collection-movie-row { box-sizing: border-box; display: grid; grid-template-columns: 52px minmax(0, 1fr) 22px; align-items: center; gap: 14px; width: 100%; min-width: 0; padding: 12px 14px; background: rgba(30, 41, 59, 0.4); border: 1px solid rgba(71, 85, 105, 0.38); border-radius: 12px; cursor: pointer; touch-action: manipulation; transition: background-color 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease; }
        .seerr-collection-movie-row:hover:not(:has(.seerr-collection-checkbox:disabled)) { background: rgba(30, 41, 59, 0.7); border-color: rgba(99, 102, 241, 0.52); }
        .seerr-collection-movie-row:has(.seerr-collection-checkbox:checked:not(:disabled)) { background: rgba(79, 70, 229, 0.14); border-color: var(--theme-primary-color, #6366f1); box-shadow: inset 0 0 0 1px var(--theme-primary-color, #6366f1); }
        .seerr-collection-movie-row:has(.seerr-collection-checkbox:disabled) { background: rgba(15, 23, 42, 0.58); border-color: rgba(71, 85, 105, 0.24); cursor: not-allowed; opacity: 0.58; }
        .seerr-collection-movie-row:focus-within { outline: 2px solid var(--theme-primary-color, #6366f1); outline-offset: 2px; }
        .seerr-collection-movie-poster { display: block; width: 52px; height: 78px; object-fit: cover; border-radius: 7px; background: rgba(15, 23, 42, 0.72); }
        .seerr-collection-movie-details { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
        .seerr-collection-movie-details .title { display: block; min-width: 0; font-weight: 700; color: #f1f5f9; font-size: 1rem; line-height: 1.25; overflow: visible; overflow-wrap: anywhere; text-overflow: clip; white-space: normal; }
        .seerr-collection-movie-meta { display: flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; color: #94a3b8; white-space: nowrap; }
        .seerr-collection-movie-meta .year { flex: 0 0 auto; font-size: 0.82rem; line-height: 1; }
        .seerr-collection-meta-separator { flex: 0 0 auto; color: #64748b; font-size: 0.85rem; line-height: 1; }
        .seerr-collection-movie-meta .seerr-season-status { flex: 0 1 auto; min-width: 0; max-width: 100%; padding: 3px 8px; border-radius: 999px; font-size: 0.68rem; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .seerr-collection-movie-meta .seerr-season-status-not-requested { background: rgba(148, 163, 184, 0.13); color: #cbd5e1; border-color: rgba(148, 163, 184, 0.28); }
        .seerr-collection-movie-meta .seerr-season-status-available,
        .seerr-collection-movie-meta .seerr-season-status-partially-available { background: rgba(34, 197, 94, 0.15); color: #4ade80; border-color: rgba(34, 197, 94, 0.32); }
        .seerr-collection-movie-meta .seerr-season-status-pending,
        .seerr-collection-movie-meta .seerr-season-status-processing { background: rgba(245, 158, 11, 0.16); color: #fbbf24; border-color: rgba(245, 158, 11, 0.34); }
        .seerr-collection-movie-meta .seerr-season-status-blocklisted { background: rgba(239, 68, 68, 0.15); color: #f87171; border-color: rgba(239, 68, 68, 0.34); }
        .seerr-collection-movie-row > .seerr-collection-checkbox { justify-self: end; }
        @media (max-width: 430px) {
            .seerr-collection-movie-row { grid-template-columns: 48px minmax(0, 1fr) 22px; gap: 10px; padding: 10px 12px; }
            .seerr-collection-movie-poster { width: 48px; height: 72px; border-radius: 6px; }
            .seerr-collection-movie-details .title { font-size: 0.95rem; }
        }
        .seerr-modal-footer { padding: 20px 24px; background: rgba(15, 23, 42, 0.3); border-top: 1px solid rgba(51, 65, 85, 0.3); display: flex; gap: 12px; justify-content: flex-end; flex-shrink: 0; }
        .seerr-modal-button { padding: 12px 24px; border-radius: 8px; border: none; cursor: pointer; font-weight: 600; font-size: 0.875rem; transition: all 0.2s ease; min-width: 120px; }
        .seerr-modal-button:disabled { opacity: 0.6; cursor: not-allowed; }
        .seerr-modal-button-primary { background: linear-gradient(135deg, #4f46e5, #7c3aed); color: white; box-shadow: 0 4px 12px rgba(79, 70, 229, 0.3); }
        .seerr-modal-button-primary:hover:not(:disabled) { background: linear-gradient(135deg, #4338ca, #6d28d9); transform: translateY(-1px); box-shadow: 0 6px 20px rgba(79, 70, 229, 0.4); }
        .seerr-modal-button-secondary { background: rgba(71, 85, 105, 0.8); color: #e2e8f0; border: 1px solid rgba(148, 163, 184, 0.2); }
        .seerr-modal-button-secondary:hover { background: rgba(71, 85, 105, 1); border-color: rgba(148, 163, 184, 0.3); }

        /* Quota chip — shown above request modals when a per-user limit applies. */
        .seerr-quota-chip { padding: 12px 16px; margin-bottom: 16px; background: rgba(30, 41, 59, 0.7); border: 1px solid rgba(99, 102, 241, 0.3); border-radius: 10px; color: #cbd5e1; font-size: 0.9rem; font-weight: 500; line-height: 1.4; display: flex; flex-direction: column; gap: 4px; }
        .seerr-quota-chip-warning { background: rgba(180, 83, 9, 0.18); border-color: rgba(251, 146, 60, 0.45); color: #fdba74; }
        .seerr-quota-chip-restricted { background: rgba(127, 29, 29, 0.25); border-color: rgba(248, 113, 113, 0.55); color: #fca5a5; }
        .seerr-quota-chip-sub { font-size: 0.8rem; opacity: 0.85; font-weight: 400; }
    `;
    document.head.appendChild(style);
};
/** Install the shared Seerr styles and remove only nodes owned by this activation. */
export function installSeerrStyles(): () => void {
    const owned: HTMLElement[] = [];
    if (!document.getElementById('seerr-styles')) {
        ui.addMainStyles();
        const style = document.getElementById('seerr-styles');
        if (style) owned.push(style);
    }
    if (!document.getElementById('seerr-season-styles')) {
        ui.addSeasonModalStyles();
        const style = document.getElementById('seerr-season-styles');
        if (style) owned.push(style);
    }
    let installed = true;
    return () => {
        if (!installed) return;
        installed = false;
        for (const style of owned.splice(0).reverse()) style.remove();
    };
}
