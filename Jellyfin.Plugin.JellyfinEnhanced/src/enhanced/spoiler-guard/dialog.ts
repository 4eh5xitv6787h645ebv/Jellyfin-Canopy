// src/enhanced/spoiler-guard/dialog.ts
//
// Disable-confirm dialog. Unlike the legacy build (which leaned on
// Dashboard.confirm + DOMPurify), the v12 modules build native overlays with
// DOM APIs and route them through core/modal-a11y for focus-trap / Escape /
// shortcut-suppression. All text is set via textContent (never innerHTML), so
// there is no interpolation to escape (X1: no HTML sink at all).

import { JE } from '../../globals';
import { installModalA11y } from '../../core/modal-a11y';
import { whenLoaded } from './state';
import { getUserPrefs } from './state';
import { isDisableSnoozed, setDisableSnooze } from './snooze';

const logPrefix = '🪼 Jellyfin Enhanced [SpoilerGuard]:';

/**
 * Ask the user to confirm disabling Spoiler Guard. Only shown on DISABLE.
 * Skipped (resolves true immediately) when the user set SkipDisableConfirm or
 * the per-browser snooze is active. Awaits whenLoaded() first so a user who
 * opted into SkipDisableConfirm doesn't get the dialog during the cold-load
 * window before loadState() resolves.
 * @returns true to proceed with the disable, false to cancel.
 */
export function confirmDisableSpoiler(): Promise<boolean> {
    return whenLoaded().then(() => {
        if (getUserPrefs().SkipDisableConfirm) return true;
        if (isDisableSnoozed()) return true;
        return showConfirmDialog();
    });
}

/** Builds and shows the native confirm overlay. Resolves true/false. */
function showConfirmDialog(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        document.querySelector('.je-spoiler-confirm-overlay')?.remove();

        const overlay = document.createElement('div');
        overlay.className = 'je-spoiler-confirm-overlay';

        const dialog = document.createElement('div');
        dialog.className = 'je-spoiler-confirm-dialog';

        const title = document.createElement('h3');
        title.id = 'je-spoiler-confirm-title';
        title.textContent = JE.t!('spoiler_disable_confirm_title');

        const body = document.createElement('p');
        body.textContent = JE.t!('spoiler_disable_confirm_body');

        const snoozeLabel = document.createElement('label');
        snoozeLabel.className = 'je-spoiler-confirm-snooze';
        const snoozeCheck = document.createElement('input');
        snoozeCheck.type = 'checkbox';
        snoozeLabel.appendChild(snoozeCheck);
        snoozeLabel.appendChild(document.createTextNode(JE.t!('spoiler_disable_confirm_snooze')));

        const buttons = document.createElement('div');
        buttons.className = 'je-spoiler-confirm-buttons';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'je-spoiler-confirm-cancel';
        cancelBtn.textContent = JE.t!('spoiler_disable_confirm_cancel') !== 'spoiler_disable_confirm_cancel'
            ? JE.t!('spoiler_disable_confirm_cancel')
            : (JE.t!('button_cancel') !== 'button_cancel' ? JE.t!('button_cancel') : 'Cancel');

        const confirmBtn = document.createElement('button');
        confirmBtn.type = 'button';
        confirmBtn.className = 'je-spoiler-confirm-ok';
        confirmBtn.textContent = JE.t!('spoiler_disable_confirm_ok') !== 'spoiler_disable_confirm_ok'
            ? JE.t!('spoiler_disable_confirm_ok')
            : (JE.t!('button_confirm') !== 'button_confirm' ? JE.t!('button_confirm') : 'Disable');

        buttons.appendChild(cancelBtn);
        buttons.appendChild(confirmBtn);

        dialog.appendChild(title);
        dialog.appendChild(body);
        dialog.appendChild(snoozeLabel);
        dialog.appendChild(buttons);
        overlay.appendChild(dialog);

        const a11y = installModalA11y(dialog, {
            labelledBy: 'je-spoiler-confirm-title',
            initialFocus: confirmBtn,
            onEscape: () => finish(false),
        });

        let settled = false;
        function finish(confirmed: boolean): void {
            if (settled) return;
            settled = true;
            try {
                if (confirmed && snoozeCheck.checked) setDisableSnooze();
            } catch (e) {
                console.warn(`${logPrefix} snooze persist failed:`, e);
            }
            a11y.release();
            overlay.remove();
            resolve(confirmed);
        }

        cancelBtn.addEventListener('click', () => finish(false));
        confirmBtn.addEventListener('click', () => finish(true));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(false); });

        document.body.appendChild(overlay);
    });
}
