// src/enhanced/hidden-content/styles.ts
//
// Hidden Content — CSS for hide buttons, undo toast, management panel,
// and the confirmation dialog.
// (Converted from js/enhanced/hidden-content-styles.js — CSS verbatim.)

import { addCSS } from '../helpers';

// ============================================================
// CSS injection
// ============================================================

/**
 * Injects the CSS rules used by hide buttons, undo toast, management panel,
 * and confirmation dialog.  No-ops if the stylesheet is already present.
 */
export function injectCSS(): void {
    addCSS('jc-hidden-content', `
        .jc-hidden { display: none !important; }
        .jc-hide-btn {
            --jc-danger-rgb: 220, 50, 50;
            position: absolute;
            top: 6px;
            right: 6px;
            z-index: 10;
            width: 28px;
            height: 28px;
            border-radius: 50%;
            background: rgba(0,0,0,0.7);
            border: 1px solid rgba(255,255,255,0.2);
            color: #fff;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0;
            transition: opacity 0.2s ease, background 0.2s ease;
            padding: 0;
            font-size: 16px;
            line-height: 1;
        }
        .jc-hide-btn .material-icons {
            font-size: 16px;
        }
        .cardBox:hover .jc-hide-btn,
        .jc-hide-btn:focus {
            opacity: 1;
        }
        .jc-hide-btn:hover {
            background: rgba(var(--jc-danger-rgb, 220, 50, 50), 0.85);
            border-color: rgba(255,255,255,0.4);
        }
        .jc-hide-btn.jc-already-hidden {
            opacity: 0;
            background: rgba(0,0,0,0.7);
            border-color: rgba(255,255,255,0.2);
            cursor: pointer;
            pointer-events: auto;
            font-size: 16px;
            width: 28px;
            border-radius: 50%;
            padding: 0;
            height: 28px;
            line-height: 1;
        }
        .cardBox:hover .jc-hide-btn.jc-already-hidden {
            opacity: 0.85;
        }
        .jc-hide-btn.jc-already-hidden:hover {
            background: rgba(0,0,0,0.82);
            border-color: rgba(255,255,255,0.28);
        }
        /*
         * Hidden Content's own no-jank containment: injecting the detail Hide
         * button adds one more in-flow button to the native detail action row,
         * which never wraps. On a narrow viewport (390px phone) the widened
         * row's min-content exceeds the viewport and the whole page scrolls
         * sideways — injected UI must never do that, on either layout. (First
         * measured by e2e/anime-filler-warnings.spec.ts's mobile scrollWidth
         * assertion, issue #454; isolation probes show the filler badge is an
         * absolute overlay contributing no width there, and the overflow
         * reproduces with the filler stylesheet reverted whenever this button
         * mounts.) Remedy: let ONLY a row that holds our button wrap, so every
         * button — native and ours — keeps its exact intrinsic size and tap
         * target. No media queries, no clipping, no overflow suppression, and
         * no compression of any button; rows without our button never match
         * the gated selector.
         */
        :is(.mainDetailButtons, .detailButtons, .itemActionsBottom, .detailButtonsContainer):has(> .jc-detail-hide-btn) {
            flex-wrap: wrap;
        }
        .jc-detail-hide-btn.jc-already-hidden {
            opacity: 0.85;
            pointer-events: auto;
            transition: background 0.2s ease, opacity 0.2s ease;
        }
        .jc-detail-hide-btn.jc-already-hidden:hover {
            opacity: 1;
            background: rgba(255,255,255,0.08);
        }

        .jc-undo-toast {
            position: fixed;
            bottom: 20px;
            right: 20px;
            color: #fff;
            padding: 12px 16px;
            border-radius: 8px;
            z-index: 99999;
            font-size: clamp(13px, 2vw, 16px);
            font-weight: 500;
            text-shadow: -1px -1px 10px black;
            box-shadow: 0 4px 20px rgba(0,0,0,0.3);
            display: flex;
            align-items: center;
            gap: 12px;
            transform: translateX(100%);
            transition: transform 0.3s ease-out;
            max-width: 380px;
        }
        .jc-undo-toast.jc-visible {
            transform: translateX(0);
        }
        .jc-undo-toast-text {
            flex: 1;
        }
        .jc-undo-btn {
            background: rgba(255,255,255,0.15);
            border: 1px solid rgba(255,255,255,0.25);
            color: #fff;
            padding: 4px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 600;
            white-space: nowrap;
            transition: background 0.2s ease, border-color 0.2s ease;
        }
        .jc-undo-btn:hover {
            filter: brightness(1.3);
        }

        .jc-hidden-management-overlay {
            position: fixed;
            inset: 0;
            z-index: 100000;
            background: rgba(0,0,0,0.85);
            backdrop-filter: blur(10px);
            display: flex;
            flex-direction: column;
            align-items: center;
            padding: 40px 20px;
            overflow-y: auto;
        }
        .jc-hidden-management-panel {
            width: 100%;
            max-width: 900px;
            background: linear-gradient(135deg, rgba(30,30,35,0.98), rgba(20,20,25,0.98));
            border-radius: 12px;
            border: 1px solid rgba(255,255,255,0.1);
            overflow: hidden;
        }
        .jc-hidden-management-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 20px 24px;
            border-bottom: 1px solid rgba(255,255,255,0.1);
        }
        .jc-hidden-management-header h2 {
            margin: 0;
            font-size: 20px;
            font-weight: 600;
            color: #fff;
        }
        .jc-hidden-management-close {
            background: rgba(255,255,255,0.1);
            border: 1px solid rgba(255,255,255,0.15);
            color: #fff;
            width: 32px;
            height: 32px;
            border-radius: 50%;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 18px;
            transition: background 0.2s ease;
        }
        .jc-hidden-management-close:hover {
            background: rgba(255,80,80,0.4);
        }
        .jc-hidden-management-toolbar {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 16px 24px;
            border-bottom: 1px solid rgba(255,255,255,0.06);
        }
        .jc-hidden-management-search {
            flex: 1;
            background: rgba(255,255,255,0.08);
            border: 1px solid rgba(255,255,255,0.12);
            border-radius: 6px;
            color: #fff;
            padding: 8px 12px;
            font-size: 14px;
            outline: none;
        }
        .jc-hidden-management-search::placeholder {
            color: rgba(255,255,255,0.4);
        }
        .jc-hidden-management-search:focus {
            border-color: rgba(255,255,255,0.3);
        }
        .jc-hidden-management-unhide-all {
            background: rgba(220,50,50,0.3);
            border: 1px solid rgba(220,50,50,0.5);
            color: #fff;
            padding: 8px 16px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
            white-space: nowrap;
            transition: background 0.2s ease;
        }
        .jc-hidden-management-unhide-all:hover {
            background: rgba(220,50,50,0.5);
        }
        .jc-hidden-management-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
            gap: 16px;
            padding: 24px;
        }
        .jc-hidden-management-empty {
            text-align: center;
            padding: 60px 24px;
            color: rgba(255,255,255,0.4);
            font-size: 15px;
        }
        .jc-hidden-item-card {
            background: rgba(255,255,255,0.05);
            border-radius: 8px;
            overflow: hidden;
            border: 1px solid rgba(255,255,255,0.08);
            transition: border-color 0.2s ease, transform 0.2s ease;
        }
        .jc-hidden-item-card:hover {
            border-color: rgba(255,255,255,0.2);
        }
        .jc-hidden-item-poster-link {
            display: block;
            cursor: pointer;
            text-decoration: none;
        }
        .jc-hidden-item-poster {
            width: 100%;
            aspect-ratio: 2/3;
            object-fit: cover;
            background: rgba(255,255,255,0.05);
            display: block;
            transition: opacity 0.2s ease;
        }
        .jc-hidden-item-poster-link:hover .jc-hidden-item-poster {
            opacity: 0.8;
        }
        .jc-hidden-item-info {
            padding: 10px;
        }
        .jc-hidden-item-name {
            font-size: 13px;
            font-weight: 500;
            color: #fff;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            margin-bottom: 4px;
            text-decoration: none;
            display: block;
        }
        .jc-hidden-item-name:hover {
            text-decoration: underline;
            color: #fff;
        }
        .jc-hidden-item-meta {
            font-size: 11px;
            color: rgba(255,255,255,0.4);
            margin-bottom: 8px;
        }
        .jc-hidden-item-unhide {
            width: 100%;
            background: rgba(255,255,255,0.1);
            border: 1px solid rgba(255,255,255,0.15);
            color: #fff;
            padding: 6px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 500;
            transition: background 0.2s ease;
        }
        .jc-hidden-item-unhide:hover {
            background: rgba(100,200,100,0.3);
            border-color: rgba(100,200,100,0.5);
        }
        .jc-hidden-item-removing {
            animation: jc-hidden-fadeout 0.3s ease forwards;
        }
        @keyframes jc-hidden-fadeout {
            to { opacity: 0; transform: scale(0.9); }
        }

        .jc-hide-confirm-overlay {
            position: fixed;
            inset: 0;
            z-index: 100001;
            background: rgba(0,0,0,0.75);
            backdrop-filter: blur(6px);
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .jc-hide-confirm-dialog {
            background: linear-gradient(135deg, rgba(30,30,35,0.98), rgba(20,20,25,0.98));
            border: 1px solid rgba(255,255,255,0.12);
            border-radius: 12px;
            padding: 24px;
            max-width: 420px;
            width: 90%;
            color: #fff;
        }
        .jc-hide-confirm-dialog h3 {
            margin: 0 0 12px 0;
            font-size: 18px;
            font-weight: 600;
        }
        .jc-hide-confirm-dialog p {
            margin: 0 0 16px 0;
            font-size: 14px;
            color: rgba(255,255,255,0.7);
            line-height: 1.5;
        }
        .jc-hide-confirm-options {
            display: flex;
            flex-direction: column;
            gap: 8px;
            margin-bottom: 20px;
        }
        .jc-hide-confirm-options label {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 13px;
            color: rgba(255,255,255,0.6);
            cursor: pointer;
        }
        .jc-hide-confirm-options input[type="checkbox"] {
            width: 16px;
            height: 16px;
            accent-color: #e0e0e0;
            cursor: pointer;
        }
        .jc-hide-confirm-buttons {
            display: flex;
            justify-content: flex-end;
            gap: 10px;
        }
        .jc-hide-confirm-cancel {
            background: rgba(255,255,255,0.1);
            border: 1px solid rgba(255,255,255,0.15);
            color: #fff;
            padding: 8px 20px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
            transition: background 0.2s ease;
        }
        .jc-hide-confirm-cancel:hover {
            background: rgba(255,255,255,0.2);
        }
        .jc-hide-confirm-hide {
            background: rgba(220,50,50,0.6);
            border: 1px solid rgba(220,50,50,0.7);
            color: #fff;
            padding: 8px 20px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 600;
            transition: background 0.2s ease;
        }
        .jc-hide-confirm-hide:hover {
            background: rgba(220,50,50,0.8);
        }
    `);
}
