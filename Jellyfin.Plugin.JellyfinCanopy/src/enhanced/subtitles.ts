// src/enhanced/subtitles.ts
//
// Manages subtitle customization, including presets and style application.
// (Converted from js/enhanced/subtitles.js — bodies semantically identical.)

import { JC } from '../globals';
import { onBodyMutation } from '../core/dom-observer';
import { cssColorOr } from '../core/css-safe';
import { createStableMethodFacade } from '../core/feature-loader';
import type { BodySubscriberHandle, IdentityContext } from '../types/jc';
import { fontFamilyPresets, fontSizePresets, publishSubtitlePresets } from './subtitle-presets';

interface SubtitleStyle {
    textColor?: string;
    bgColor?: string;
    fontSize?: number;
    fontFamily?: string;
    textShadow?: string;
}

let subtitleObserver: BodySubscriberHandle | null = null;
let currentSubtitleStyle: SubtitleStyle = {};
let activeSubtitleContext: IdentityContext | null = null;

/**
 * Applies subtitle position to the .videoSubtitles container element.
 * xPct and yPct are percentages (0-100) representing the center anchor point
 * of the subtitle text within the video area.
 * Using top+transform(translate -50%,-50%) means the anchor is always the
 * center of the text, so font size changes don't shift the visual position.
 * When disableCustomSubtitleStyles is true, removes JC position overrides entirely.
 */
function applySubtitlePosition(context: IdentityContext | null = activeSubtitleContext): void {
    if (context && !JC.identity.isCurrent(context)) return;
    const containers = document.querySelectorAll<HTMLElement>('.videoSubtitles');
    if (!containers.length) return;

    const disabled = JC.currentSettings?.disableCustomSubtitleStyles;

    containers.forEach(container => {
        if (disabled) {
            // Remove JC overrides — let vanilla Jellyfin control position
            container.style.removeProperty('position');
            container.style.removeProperty('left');
            container.style.removeProperty('top');
            container.style.removeProperty('bottom');
            container.style.removeProperty('transform');
            container.style.removeProperty('width');
            container.style.removeProperty('text-align');
        } else {
            const xPct = (JC.currentSettings?.subtitleHorizontalPosition as number | undefined) ?? 50;
            const yPct = (JC.currentSettings?.subtitleVerticalPosition as number | undefined) ?? 85;
            // Position the container so its center sits at (xPct, yPct) of the video
            container.style.setProperty('position', 'absolute', 'important');
            container.style.setProperty('left', `${xPct}%`, 'important');
            container.style.setProperty('top', `${yPct}%`, 'important');
            container.style.setProperty('bottom', 'auto', 'important');
            container.style.setProperty('transform', 'translate(-50%, -50%)', 'important');
            container.style.setProperty('text-align', 'center', 'important');
        }
    });
}

/**
 * Removes all JC-injected subtitle styles from existing elements.
 * Called when the user disables custom subtitle styles.
 */
function removeInjectedStyles(): void {
    // Clear the native-cue override too (Chrome/native rendering path).
    const cueOverride = document.getElementById('jc-html-videoplayer-cuestyle') as HTMLStyleElement | null;
    if (cueOverride?.sheet) {
        while (cueOverride.sheet.cssRules.length > 0) cueOverride.sheet.deleteRule(0);
    }
    document.querySelectorAll<HTMLElement>('.videoSubtitlesInner').forEach(el => {
        el.style.removeProperty('background-color');
        el.style.removeProperty('color');
        el.style.removeProperty('font-size');
        el.style.removeProperty('font-family');
        el.style.removeProperty('text-shadow');
        el.style.removeProperty('border-radius');
        el.style.removeProperty('padding');
        el.style.removeProperty('font-weight');
        el.style.removeProperty('font-style');
        el.style.removeProperty('font-variant');
    });
    document.querySelectorAll<HTMLElement>('.videoSubtitles').forEach(container => {
        container.style.removeProperty('position');
        container.style.removeProperty('left');
        container.style.removeProperty('top');
        container.style.removeProperty('bottom');
        container.style.removeProperty('transform');
        container.style.removeProperty('width');
        container.style.removeProperty('max-width');
        container.style.removeProperty('text-align');
    });
    // Stop the observer — no point watching when styles are disabled
    if (subtitleObserver) {
        subtitleObserver.unsubscribe();
        subtitleObserver = null;
    }
}

/**
 * Directly modifies the inline style of a subtitle element to ensure overrides.
 * Jellyfin renders subtitles into .videoSubtitlesInner DOM elements; inline
 * !important styles win over the client's own stylesheet.
 */
function forceApplyInlineStyles(
    element: HTMLElement | null,
    context: IdentityContext | null = activeSubtitleContext
): void {
    if (!element || !context || !JC.identity.isCurrent(context)
        || JC.currentSettings?.disableCustomSubtitleStyles) return;

    // Apply all custom styles directly to videoSubtitlesInner
    element.style.setProperty('background-color', currentSubtitleStyle.bgColor!, 'important');
    element.style.setProperty('color', currentSubtitleStyle.textColor!, 'important');
    element.style.setProperty('font-size', `${currentSubtitleStyle.fontSize!}vw`, 'important');
    element.style.setProperty('font-family', currentSubtitleStyle.fontFamily!, 'important');
    element.style.setProperty('text-shadow', currentSubtitleStyle.textShadow || 'none', 'important');

    // Border radius, not configurable in the UI ***
    element.style.setProperty('border-radius', '5px', 'important');

    // Some padding when a background is visible to prevent text touching the edges
    if (currentSubtitleStyle.bgColor && currentSubtitleStyle.bgColor !== 'transparent') {
        element.style.setProperty('padding', '0.2em 0.4em', 'important');
    } else {
        element.style.setProperty('padding', '0', 'important');
    }

    // Explicitly reset vanilla Jellyfin properties that could conflict with our styling
    element.style.setProperty('font-weight', 'normal', 'important');
    element.style.setProperty('font-style', 'normal', 'important');
    element.style.setProperty('font-variant', 'normal', 'important');
}

/**
 * Watches for subtitle elements and applies styles to them as they appear.
 */
function startSubtitleObserver(context: IdentityContext): void {
    if (subtitleObserver) subtitleObserver.unsubscribe();
    subtitleObserver = onBodyMutation('subtitles', (mutations) => {
        if (!JC.identity.isCurrent(context)) return;
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType === 1) {
                    const el = node as HTMLElement;
                    if (el.classList.contains('videoSubtitlesInner')) {
                        forceApplyInlineStyles(el, context);
                    } else if (el.querySelector) {
                        const inner = el.querySelector<HTMLElement>('.videoSubtitlesInner');
                        if (inner) forceApplyInlineStyles(inner, context);
                    }
                    // Also reapply position whenever a subtitle container appears
                    if (el.classList.contains('videoSubtitles') || el.querySelector?.('.videoSubtitles')) {
                        applySubtitlePosition(context);
                    }
                }
            }
        }
    });
}

/**
 * Main function to apply styles. It sets the desired style and starts the process.
 */
function applySubtitleStyles(textColor: string, bgColor: string, fontSize: number, fontFamily: string, textShadow: string): void {
    const context = JC.identity.capture();
    if (!context) return;
    activeSubtitleContext = context;
    // THEME-6: the video-page driver re-invokes this on every ~100ms tick with
    // the same resolved style. Skip the observer teardown/re-subscribe and the
    // ::cue rewrite when nothing changed and the pipeline is already live; only
    // do the heavy work when the resolved style actually changed.
    const unchanged = currentSubtitleStyle.textColor === textColor
        && currentSubtitleStyle.bgColor === bgColor
        && currentSubtitleStyle.fontSize === fontSize
        && currentSubtitleStyle.fontFamily === fontFamily
        && currentSubtitleStyle.textShadow === textShadow;
    const cueSheetLive = !!(document.getElementById('jc-html-videoplayer-cuestyle') as HTMLStyleElement | null)?.sheet?.cssRules.length;
    if (unchanged && subtitleObserver && cueSheetLive) {
        // Position is cheap + idempotent — keep it; skip the rest.
        applySubtitlePosition(context);
        return;
    }

    // Store the chosen style globally for the observer to use
    currentSubtitleStyle = { textColor, bgColor, fontSize, fontFamily, textShadow };

    // Force-apply to any subtitle elements that might already exist
    document.querySelectorAll<HTMLElement>('.videoSubtitlesInner')
        .forEach((element) => forceApplyInlineStyles(element, context));

    // Apply position to the container
    applySubtitlePosition(context);

    // Start the observer to catch any new subtitle elements
    startSubtitleObserver(context);

    // NATIVE cue rendering path: on Jellyfin 12, .videoSubtitlesInner only
    // exists when jellyfin-web's useCustomSubtitles() is true (Firefox/
    // Safari/Edge/TVs). Chrome/Chromium with the default "Auto" styling
    // renders native VTT cues instead, styled by the client's
    // #htmlvideoplayer-cuestyle sheet — mirror our style into a ::cue
    // override there, or every JC subtitle setting silently no-ops on the
    // most common browser. Position settings cannot apply to native cues
    // (::cue supports style properties only).
    applyNativeCueStyles(context);
}

/**
 * Upserts (or clears) the JC ::cue override sheet for the native-cue path.
 * Keyed on the client's own #htmlvideoplayer-cuestyle element, which
 * jellyfin-web creates via setCueAppearance() once a text track is selected —
 * the video-page observer re-invokes the style pipeline after that, so this
 * lands even when the track is picked mid-playback.
 */
function applyNativeCueStyles(context: IdentityContext): void {
    if (!JC.identity.isCurrent(context)) return;
    const clientCueSheet = document.getElementById('htmlvideoplayer-cuestyle') as HTMLStyleElement | null;
    if (!clientCueSheet?.sheet) return;

    let styleElement = document.getElementById('jc-html-videoplayer-cuestyle') as HTMLStyleElement | null;
    if (!styleElement?.sheet) {
        styleElement = document.createElement('style');
        styleElement.id = 'jc-html-videoplayer-cuestyle';
        styleElement.setAttribute('data-jc-identity-owned', 'true');
        JC.identity.own(styleElement, context);
        document.head.appendChild(styleElement);
    }

    try {
        const sheet = styleElement.sheet;
        if (!sheet) return;
        while (sheet.cssRules.length > 0) sheet.deleteRule(0);
        if (JC.currentSettings?.disableCustomSubtitleStyles) return;
        const { textColor, bgColor, fontSize, fontFamily, textShadow } = currentSubtitleStyle;
        // THEME-1: bgColor/textColor are free-text per-user settings landing in a
        // live stylesheet rule — gate them through cssColorOr so a payload like
        // `red;background-image:url(https://attacker/beacon)` can't inject an
        // extra declaration; coerce the numeric font-size. fontFamily comes from
        // the fixed fontFamilyPresets table and textShadow is a derived constant
        // (transparent-bg ternary), so both are trusted producers left as-is.
        const bg = cssColorOr(bgColor, '#00000000');
        const fg = cssColorOr(textColor, '#FFFFFFFF');
        const size = Number(fontSize) || 1.2;
        const cueRule = `
        video.htmlvideoplayer::cue {
            background-color: ${bg} !important;
            color: ${fg} !important;
            font-size: ${size}vw !important;
            font-family: ${fontFamily!} !important;
            text-shadow: ${textShadow || 'none'} !important;
        }`;
        sheet.insertRule(cueRule, 0);
    } catch (e) {
        console.error('🪼 Jellyfin Canopy: Failed to apply native ::cue styles:', e);
    }
}

/**
 * Loads saved settings and triggers the style application.
 * When custom styles are disabled, removes all JC-injected styles cleanly.
 */
function applySavedStylesWhenReady(): void {
    const context = JC.identity.capture();
    if (!context) return;
    activeSubtitleContext = context;
    if (!document.querySelector('video')) {
        removeInjectedStyles();
        currentSubtitleStyle = {};
        return;
    }

    if (JC.currentSettings?.disableCustomSubtitleStyles) {
        removeInjectedStyles();
        return;
    }

    const textColor = (JC.currentSettings?.customSubtitleTextColor as string | undefined) || '#FFFFFFFF';
    const bgColor = (JC.currentSettings?.customSubtitleBgColor as string | undefined) || '#00000000';
    const textShadow = bgColor === 'transparent' || bgColor === '#00000000'
        ? '0 0 4px #000, 0 0 8px #000, 1px 1px 2px #000'
        : 'none';

    const fontSizePreset = fontSizePresets[(JC.currentSettings?.selectedFontSizePresetIndex as number | undefined) ?? 2];
    const fontFamilyPreset = fontFamilyPresets[(JC.currentSettings?.selectedFontFamilyPresetIndex as number | undefined) ?? 0];

    if (fontSizePreset && fontFamilyPreset) {
        applySubtitleStyles(
            textColor,
            bgColor,
            fontSizePreset.size,
            fontFamilyPreset.family,
            textShadow
        );
    }
}

function resetSubtitleIdentity(): void {
    activeSubtitleContext = null;
    currentSubtitleStyle = {};
    removeInjectedStyles();
}

const subtitlesApi = { applySubtitlePosition, applySubtitleStyles, applySavedStylesWhenReady };
const stableSubtitles = createStableMethodFacade<typeof subtitlesApi>({
    applySubtitlePosition() {},
    applySubtitleStyles() {},
    applySavedStylesWhenReady() {},
});

/** Publish subtitle styling methods and reset ownership for one activation. */
export function installSubtitles(): () => void {
    publishSubtitlePresets();
    const uninstall = stableSubtitles.install(subtitlesApi);
    JC.applySubtitlePosition = stableSubtitles.facade.applySubtitlePosition;
    JC.applySubtitleStyles = stableSubtitles.facade.applySubtitleStyles;
    JC.applySavedStylesWhenReady = stableSubtitles.facade.applySavedStylesWhenReady;
    const unregisterReset = JC.identity.registerReset('enhanced-subtitles', resetSubtitleIdentity);
    let disposed = false;
    return () => {
        if (disposed) return;
        disposed = true;
        resetSubtitleIdentity();
        unregisterReset();
        uninstall();
    };
}

/** Apply current settings to an already-mounted player. */
export function initializeSubtitles(): void {
    applySavedStylesWhenReady();
}
