// src/enhanced/spoiler-guard/seerr-toggle.ts
//
// The Seerr more-info modal "Spoiler Guard" pending toggle. Lets a user arm
// Spoiler Guard for a title regardless of request status: pre-arm before
// requesting, or register intent on a title someone else already requested so
// it auto-applies when the content arrives. The server resolves "already in
// library" and promotes Series/Movies itself, so the UI doesn't special-case it.

import { JC } from '../../globals';

const logPrefix = '🪼 Jellyfin Canopy [SpoilerGuard]:';

/**
 * Build the pending toggle button for a Seerr modal item, or null when not
 * applicable (feature off, bad media type, missing tmdb id). Matches the
 * modal's ghost secondary-action styling. Built with DOM APIs (no HTML sink).
 * @param data - The Seerr media detail payload (id, title/name, mediaInfo).
 * @param mediaType - 'tv' | 'movie'.
 */
export function buildSeerrPendingToggle(data: any, mediaType: string): HTMLButtonElement | null { // eslint-disable-line @typescript-eslint/no-explicit-any
    const context = JC.identity.capture();
    if (!context || !JC.identity.isCurrent(context)) return null;
    if (JC.pluginConfig?.SpoilerBlurEnabled !== true) return null;
    if (!JC.spoilerGuard) return null;
    const spoilerGuard = JC.spoilerGuard;
    if (mediaType !== 'tv' && mediaType !== 'movie') return null;
    const tmdbId = data?.id;
    if (!tmdbId) return null;

    const jellyfinMediaId: string | null = data?.mediaInfo?.jellyfinMediaId || null;
    const displayName: string = data?.title || data?.name || '';

    const btn = document.createElement('button');
    btn.type = 'button';
    // Deliberately NOT the primary request CTA class — this is a quieter
    // secondary action with its own ghost styling.
    btn.className = 'jc-spoiler-pending-btn';
    btn.dataset.jcIdentityOwned = 'true';
    btn.dataset.jcThemeSurface = 'seerr-details';
    btn.dataset.jcThemeComponent = 'protection-toggle';
    btn.setAttribute('data-jc-tmdb-id', String(tmdbId));
    btn.setAttribute('data-jc-media-type', mediaType);
    JC.identity.own(btn, context);

    const iconSpan = document.createElement('span');
    iconSpan.className = 'material-icons';
    const labelSpan = document.createElement('span');
    btn.appendChild(iconSpan);
    btn.appendChild(labelSpan);

    function isOwnedButton(requireConnected = false): boolean {
        return JC.identity.isCurrent(context)
            && JC.identity.isOwned(btn, context)
            && (!requireConnected || btn.isConnected);
    }

    function refreshLabel(): void {
        if (!isOwnedButton()) return;
        const enabled = spoilerGuard.isTmdbEnabled(mediaType, String(tmdbId), jellyfinMediaId);
        const label = enabled ? JC.t!('spoiler_blur_pending_button_on') : JC.t!('spoiler_blur_pending_button_off');
        btn.classList.toggle('jc-spoiler-pending-on', enabled);
        btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
        btn.setAttribute('title', label);
        iconSpan.textContent = enabled ? 'blur_on' : 'blur_off';
        labelSpan.textContent = label;
    }
    refreshLabel();
    // Cold-load fix: state may load after the modal mounts, so an initial
    // refreshLabel could read empty sets. whenLoaded resolves immediately if
    // already loaded, else awaits the in-flight load.
    spoilerGuard.whenLoaded().then(() => {
        if (isOwnedButton()) refreshLabel();
    }).catch(() => { /* refresh best-effort */ });

    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!isOwnedButton(true)) return;
        if (btn.disabled) return;
        btn.disabled = true;
        const wasEnabled = spoilerGuard.isTmdbEnabled(mediaType, String(tmdbId), jellyfinMediaId);
        void (async () => {
            try {
                if (wasEnabled) {
                    const proceed = await spoilerGuard.confirmDisableSpoiler();
                    if (!isOwnedButton(true) || !proceed) return;
                    await spoilerGuard.disableForTmdb(mediaType, String(tmdbId));
                    if (!isOwnedButton(true)) return;
                    JC.toast?.(JC.t!('spoiler_blur_pending_disabled_toast'));
                } else {
                    await spoilerGuard.enableForTmdb(mediaType, String(tmdbId), displayName);
                    if (!isOwnedButton(true)) return;
                    JC.toast?.(JC.t!('spoiler_blur_pending_enabled_toast'));
                }
            } catch (err) {
                if (!isOwnedButton(true)) return;
                console.warn(`${logPrefix} pending toggle failed:`, err);
                JC.toast?.(JC.t!('spoiler_blur_pending_error_toast'));
            } finally {
                if (isOwnedButton(true)) {
                    refreshLabel();
                    btn.disabled = false;
                }
            }
        })();
    });

    return btn;
}

export function resetSpoilerSeerrControls(): void {
    document.querySelectorAll('.jc-spoiler-pending-btn').forEach((node) => node.remove());
}
