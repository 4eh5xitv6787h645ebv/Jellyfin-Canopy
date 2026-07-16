// src/enhanced/spoiler-guard/styles.ts
//
// One stable-id stylesheet for every Spoiler Guard surface: the detail-page
// toggle button on-state, the Seerr pending toggle (ghost) button, and the
// disable-confirm dialog overlay. Injected once via core/ui-kit injectCss.

import { injectCss, removeCss } from '../../core/ui-kit';

const STYLE_ID = 'jc-spoiler-guard-css';

/** Inject (idempotently) the Spoiler Guard stylesheet. */
export function injectSpoilerGuardCss(): void {
    injectCss(STYLE_ID, `
        /* Detail-page toggle button: tint the icon when guarding is ON. */
        .jc-spoiler-blur-btn.jc-spoiler-blur-on .detailButton-icon {
            color: #d6c8ff;
        }

        /* Seerr more-info modal — secondary actions row + pending toggle button. */
        .jc-more-info-modal .jc-more-info-secondary-actions {
            display: flex;
            flex-wrap: wrap;
            gap: 0.5rem;
            margin-top: 0.75rem;
        }
        .jc-more-info-modal .jc-more-info-secondary-actions:empty {
            display: none;
        }
        .jc-spoiler-pending-btn {
            display: inline-flex;
            align-items: center;
            gap: 0.4em;
            padding: 0.45em 0.9em;
            font-size: 0.85em;
            font-weight: 500;
            line-height: 1.2;
            background: rgba(255, 255, 255, 0.06);
            color: rgba(255, 255, 255, 0.85);
            border: 1px solid rgba(255, 255, 255, 0.14);
            border-radius: 999px;
            cursor: pointer;
            transition: background 0.2s, border-color 0.2s, color 0.2s;
        }
        .jc-spoiler-pending-btn:hover:not(:disabled) {
            background: rgba(255, 255, 255, 0.1);
            border-color: rgba(255, 255, 255, 0.25);
            color: #fff;
        }
        .jc-spoiler-pending-btn:disabled {
            opacity: 0.55;
            cursor: progress;
        }
        .jc-spoiler-pending-btn.jc-spoiler-pending-on {
            background: rgba(90, 63, 184, 0.22);
            color: #d6c8ff;
            border-color: rgba(90, 63, 184, 0.55);
        }
        .jc-spoiler-pending-btn.jc-spoiler-pending-on:hover:not(:disabled) {
            background: rgba(90, 63, 184, 0.32);
            border-color: rgba(90, 63, 184, 0.75);
            color: #fff;
        }
        .jc-spoiler-pending-btn .material-icons {
            font-size: 1.1em;
        }

        /* Disable-confirm dialog. */
        .jc-spoiler-confirm-overlay {
            position: fixed;
            inset: 0;
            z-index: 100001;
            background: rgba(0,0,0,0.75);
            backdrop-filter: blur(6px);
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .jc-spoiler-confirm-dialog {
            background: linear-gradient(135deg, rgba(30,30,35,0.98), rgba(20,20,25,0.98));
            border: 1px solid rgba(255,255,255,0.12);
            border-radius: 12px;
            padding: 24px;
            max-width: 420px;
            width: 90%;
            color: #fff;
        }
        .jc-spoiler-confirm-dialog h3 {
            margin: 0 0 12px 0;
            font-size: 18px;
            font-weight: 600;
        }
        .jc-spoiler-confirm-dialog p {
            margin: 0 0 16px 0;
            font-size: 14px;
            color: rgba(255,255,255,0.7);
            line-height: 1.5;
        }
        .jc-spoiler-confirm-snooze {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 13px;
            color: rgba(255,255,255,0.6);
            cursor: pointer;
            margin-bottom: 20px;
        }
        .jc-spoiler-confirm-snooze input[type="checkbox"] {
            width: 16px;
            height: 16px;
            accent-color: #b9a6ff;
            cursor: pointer;
        }
        .jc-spoiler-confirm-buttons {
            display: flex;
            justify-content: flex-end;
            gap: 10px;
        }
        .jc-spoiler-confirm-cancel {
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
        .jc-spoiler-confirm-cancel:hover {
            background: rgba(255,255,255,0.2);
        }
        .jc-spoiler-confirm-ok {
            background: rgba(90, 63, 184, 0.6);
            border: 1px solid rgba(90, 63, 184, 0.75);
            color: #fff;
            padding: 8px 20px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 600;
            transition: background 0.2s ease;
        }
        .jc-spoiler-confirm-ok:hover {
            background: rgba(90, 63, 184, 0.8);
        }
    `);
}

/** Remove the activation-owned stylesheet. */
export function removeSpoilerGuardCss(): void {
    removeCss(STYLE_ID);
}
