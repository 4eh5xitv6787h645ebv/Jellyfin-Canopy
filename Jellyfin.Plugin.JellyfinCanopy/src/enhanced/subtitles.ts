// src/enhanced/subtitles.ts
//
// Manages subtitle customization, including presets and style application.
// (Converted from js/enhanced/subtitles.js — bodies semantically identical.)

import { JC } from '../globals';
import { onBodyMutation } from '../core/dom-observer';
import { cssColorOr } from '../core/css-safe';
import { createStableMethodFacade } from '../core/feature-loader';
import type { BodySubscriberHandle, IdentityContext } from '../types/jc';
import { publishSubtitlePresets } from './subtitle-presets';
import {
    clampSubtitleHorizontal,
    clampSubtitleVertical,
    isFullyTransparentColor,
    resolveSubtitleStyle,
} from './subtitle-style-contract';
import {
    applyCueGeometry,
    applySubtitleContainerGeometry,
} from './subtitle-geometry';

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

type StylePropertySnapshot = Readonly<{ value: string; priority: string }>;
type StyleSnapshot = ReadonlyMap<string, StylePropertySnapshot>;

const subtitleStyleProperties = [
    'background-color', 'color', 'font-size', 'font-family', 'text-shadow',
    'border-radius', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'font-weight', 'font-style', 'font-variant', 'position', 'left', 'right', 'top',
    'bottom', 'transform', 'width', 'max-width', 'box-sizing', 'margin-top',
    'margin-right', 'margin-bottom', 'margin-left',
] as const;
const containerStyleProperties = [
    'position', 'left', 'right', 'top', 'bottom', 'transform', 'width', 'max-width', 'text-align',
] as const;
const subtitleStyleSnapshots = new WeakMap<HTMLElement, StyleSnapshot>();
const containerStyleSnapshots = new WeakMap<HTMLElement, StyleSnapshot>();
const styledSubtitleElements = new Set<HTMLElement>();
const positionedSubtitleContainers = new Set<HTMLElement>();

function rememberStyles(
    element: HTMLElement,
    properties: readonly string[],
    snapshots: WeakMap<HTMLElement, StyleSnapshot>,
    owned: Set<HTMLElement>,
): void {
    if (!snapshots.has(element)) {
        snapshots.set(element, new Map(properties.map((property) => [property, {
            value: element.style.getPropertyValue(property),
            priority: element.style.getPropertyPriority(property),
        }])));
    }
    owned.add(element);
}

function restoreStyles(
    element: HTMLElement,
    snapshots: WeakMap<HTMLElement, StyleSnapshot>,
    owned: Set<HTMLElement>,
): void {
    const snapshot = snapshots.get(element);
    if (snapshot) {
        for (const [property, { value, priority }] of snapshot) {
            // Remove the generated declaration first. Some engines expand an
            // !important shorthand into important longhands that a later
            // non-important shorthand cannot otherwise replace.
            element.style.removeProperty(property);
            if (value) element.style.setProperty(property, value, priority);
        }
    }
    snapshots.delete(element);
    owned.delete(element);
}

function hasVisibleBackground(value: string | undefined): boolean {
    return Boolean(value) && !isFullyTransparentColor(value);
}

function restoreOwnedTree(node: Node): void {
    if (!(node instanceof HTMLElement)) return;
    if (styledSubtitleElements.has(node)) {
        restoreStyles(node, subtitleStyleSnapshots, styledSubtitleElements);
    }
    if (positionedSubtitleContainers.has(node)) {
        restoreStyles(node, containerStyleSnapshots, positionedSubtitleContainers);
    }
    node.querySelectorAll<HTMLElement>('.videoSubtitlesInner').forEach((element) => {
        if (styledSubtitleElements.has(element)) {
            restoreStyles(element, subtitleStyleSnapshots, styledSubtitleElements);
        }
    });
    node.querySelectorAll<HTMLElement>('.videoSubtitles').forEach((container) => {
        if (positionedSubtitleContainers.has(container)) {
            restoreStyles(container, containerStyleSnapshots, positionedSubtitleContainers);
        }
    });
}

/**
 * Applies subtitle position to the .videoSubtitles container element.
 * xPct and yPct are percentages (0-100). Horizontal position is center-anchored;
 * vertical position is bottom-anchored so additional cue lines grow upward
 * without moving the selected bottom edge.
 * When disableCustomSubtitleStyles is true, removes JC position overrides entirely.
 */
function applySubtitlePosition(context: IdentityContext | null = activeSubtitleContext): void {
    if (context && !JC.identity.isCurrent(context)) return;
    const containers = document.querySelectorAll<HTMLElement>('.videoSubtitles');
    if (!containers.length) return;

    const disabled = JC.currentSettings?.disableCustomSubtitleStyles;

    containers.forEach(container => {
        if (disabled) {
            restoreStyles(container, containerStyleSnapshots, positionedSubtitleContainers);
            container.querySelectorAll<HTMLElement>('.videoSubtitlesInner').forEach((element) => {
                restoreStyles(element, subtitleStyleSnapshots, styledSubtitleElements);
            });
        } else {
            const xPct = clampSubtitleHorizontal(JC.currentSettings?.subtitleHorizontalPosition);
            const yPct = clampSubtitleVertical(JC.currentSettings?.subtitleVerticalPosition);
            rememberStyles(container, containerStyleProperties, containerStyleSnapshots, positionedSubtitleContainers);
            applySubtitleContainerGeometry(container, yPct);
            container.querySelectorAll<HTMLElement>('.videoSubtitlesInner').forEach((element) => {
                rememberStyles(element, subtitleStyleProperties, subtitleStyleSnapshots, styledSubtitleElements);
                applyCueGeometry(element, xPct);
            });
        }
    });
}

/**
 * Removes all JC-injected subtitle styles from existing elements.
 * Called when the user disables custom subtitle styles.
 */
function removeInjectedStyles(): void {
    // Clear the native-cue override too (Chrome/native rendering path).
    document.getElementById('jc-html-videoplayer-cuestyle')?.remove();
    for (const element of [...styledSubtitleElements]) {
        restoreStyles(element, subtitleStyleSnapshots, styledSubtitleElements);
    }
    for (const container of [...positionedSubtitleContainers]) {
        restoreStyles(container, containerStyleSnapshots, positionedSubtitleContainers);
    }
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

    rememberStyles(element, subtitleStyleProperties, subtitleStyleSnapshots, styledSubtitleElements);
    applyCueGeometry(element, clampSubtitleHorizontal(JC.currentSettings?.subtitleHorizontalPosition));

    // Apply all custom styles directly to videoSubtitlesInner
    element.style.setProperty('background-color', currentSubtitleStyle.bgColor!, 'important');
    element.style.setProperty('color', currentSubtitleStyle.textColor!, 'important');
    element.style.setProperty('font-size', `${currentSubtitleStyle.fontSize!}vw`, 'important');
    element.style.setProperty('font-family', currentSubtitleStyle.fontFamily!, 'important');
    element.style.setProperty('text-shadow', currentSubtitleStyle.textShadow || 'none', 'important');

    // Keep opaque cue boxes compact; transparent cues must not retain a box.
    if (hasVisibleBackground(currentSubtitleStyle.bgColor)) {
        element.style.setProperty('border-radius', '0.15em', 'important');
        element.style.setProperty('padding-top', '0.08em', 'important');
        element.style.setProperty('padding-right', '0.2em', 'important');
        element.style.setProperty('padding-bottom', '0.08em', 'important');
        element.style.setProperty('padding-left', '0.2em', 'important');
    } else {
        element.style.removeProperty('border-radius');
        element.style.setProperty('padding-top', '0', 'important');
        element.style.setProperty('padding-right', '0', 'important');
        element.style.setProperty('padding-bottom', '0', 'important');
        element.style.setProperty('padding-left', '0', 'important');
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
            mutation.removedNodes.forEach(restoreOwnedTree);
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

    const style = resolveSubtitleStyle(JC.currentSettings || {});
    applySubtitleStyles(
        style.textColor,
        style.backgroundColor,
        style.fontSizeVw,
        style.fontFamily,
        style.textShadow
    );
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
