/**
 * Modern-phone environment and CSS adapters owned by Theme Studio issue #389.
 *
 * The adapter is intentionally capability- and breakpoint-gated. It does not
 * match tablet, legacy, or TV layouts and never changes Jellyfin DOM order.
 */

export const MOBILE_ENVIRONMENT_STYLE_ID = 'jc-theme-studio-mobile-environment';

export interface MobileEnvironmentInput {
    readonly phone: boolean;
    readonly layoutWidth: number;
    readonly layoutHeight: number;
    readonly visualHeight: number;
    readonly visualOffsetTop: number;
    readonly visualScale: number;
    readonly editableFocused: boolean;
    readonly reducedTransparency: boolean;
    readonly backdropFilterSupported: boolean;
    readonly deviceMemory: number | null;
    readonly hardwareConcurrency: number | null;
}

export interface ResolvedMobileEnvironment {
    readonly orientation: 'portrait' | 'landscape';
    readonly keyboard: 'open' | 'closed';
    readonly performance: 'full' | 'reduced';
    readonly visualHeight: number;
    readonly visualOffsetTop: number;
    readonly keyboardInset: number;
}

function boundedPixel(value: number, fallback: number): number {
    if (!Number.isFinite(value)) return fallback;
    return Math.max(0, Math.min(10_000, Math.floor(value)));
}

function constrainedCapability(value: number | null): number | null {
    return value !== null && Number.isFinite(value) && value > 0 ? value : null;
}

/** Pure phone capability resolution shared by runtime and unit evidence. */
export function resolveMobileEnvironment(input: MobileEnvironmentInput): ResolvedMobileEnvironment {
    const layoutWidth = Math.max(1, boundedPixel(input.layoutWidth, 1));
    const layoutHeight = Math.max(1, boundedPixel(input.layoutHeight, 1));
    const visualHeight = Math.max(1, boundedPixel(input.visualHeight, layoutHeight));
    const visualOffsetTop = boundedPixel(input.visualOffsetTop, 0);
    const occludedHeight = Math.max(0, layoutHeight - visualOffsetTop - visualHeight);
    // Browser chrome can reduce the visual viewport slightly. Require both a
    // material inset and a substantial height loss while an editable control
    // owns focus. Pinch zoom also shrinks the visual viewport, so only an
    // effectively unscaled viewport can be classified as keyboard occlusion.
    const visualScale = Number.isFinite(input.visualScale) && input.visualScale > 0
        ? input.visualScale
        : 1;
    const unscaledViewport = Math.abs(visualScale - 1) <= 0.05;
    const keyboardOpen = input.phone
        && input.editableFocused
        && unscaledViewport
        && occludedHeight >= 120
        && visualHeight <= layoutHeight * 0.8;
    const memory = constrainedCapability(input.deviceMemory);
    const concurrency = constrainedCapability(input.hardwareConcurrency);
    const constrainedPhone = input.phone && (
        !input.backdropFilterSupported
        || (memory !== null && memory <= 2)
        || (concurrency !== null && concurrency <= 2)
    );
    return Object.freeze({
        orientation: layoutWidth > layoutHeight ? 'landscape' : 'portrait',
        keyboard: keyboardOpen ? 'open' : 'closed',
        performance: input.phone && (input.reducedTransparency || constrainedPhone) ? 'reduced' : 'full',
        visualHeight,
        visualOffsetTop,
        keyboardInset: keyboardOpen ? occludedHeight : 0,
    });
}

/** Runtime-owned viewport variables; input is bounded before serialization. */
export function serializeMobileEnvironmentStyle(
    rootSelector: string,
    environment: ResolvedMobileEnvironment,
): string {
    return `${rootSelector} {
  --jc-visual-viewport-height: ${environment.visualHeight}px;
  --jc-visual-viewport-top: ${environment.visualOffsetTop}px;
  --jc-keyboard-inset: ${environment.keyboardInset}px;
}`;
}

/** Static option branches; the runtime's exact root attributes select them. */
export function serializeMobileAdapters(rootSelector: string): string {
    const selector = `${rootSelector}[data-jc-theme-breakpoint="phone"]`
        + '[data-jc-theme-route]:not([data-jc-theme-route="dashboard"])';
    return `
/* Adapter mobile-safe-area-v12: modern phone viewport, touch and containment. */
${selector} {
  max-inline-size: 100%;
  overflow-x: clip;
  overscroll-behavior-inline: none;
}
${selector} body {
  box-sizing: border-box;
  min-inline-size: 0;
  min-block-size: var(--jc-visual-viewport-height);
  overflow-x: clip;
  overscroll-behavior-inline: none;
}
${selector} .MuiAppBar-root,
${selector} .MuiToolbar-root,
${selector} :where(.libraryPage, .page, .itemsContainer, .scrollSlider) {
  box-sizing: border-box;
  max-inline-size: 100%;
  min-inline-size: 0;
}
${selector} .MuiToolbar-root {
  padding-inline-start: max(var(--jc-control-gap), var(--jc-safe-area-left));
  padding-inline-end: max(var(--jc-control-gap), var(--jc-safe-area-right));
}
${selector}[data-jc-theme-navigation="bottom"] .MuiAppBar-root {
  inset-block-end: var(--jc-keyboard-inset) !important;
  max-block-size: calc(var(--jc-visual-viewport-height) - var(--jc-safe-area-top));
}
${selector}[data-jc-theme-navigation="bottom"] .MuiToolbar-root {
  scroll-padding-inline: max(var(--jc-control-gap), var(--jc-safe-area-left));
  touch-action: pan-x;
}
${selector} :where(
  .MuiButtonBase-root,
  .MuiButton-root,
  .MuiIconButton-root,
  .actionSheetMenuItem,
  .detailButton,
  .cardOverlayButton,
  .btnCardOptions,
  .emby-button,
  .raised,
  .fab
) {
  min-inline-size: max(2.75rem, 44px);
  min-block-size: max(2.75rem, 44px);
  touch-action: manipulation;
}
${selector} :where(.scrollSlider, .actionSheetScroller, .MuiDialogContent-root, .formDialogContent) {
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  -webkit-overflow-scrolling: touch;
}
${selector} .scrollSlider {
  scroll-padding-inline: max(var(--jc-page-gutter), var(--jc-safe-area-left));
  scroll-snap-type: inline proximity;
}
${selector} .scrollSlider > .card {
  max-inline-size: calc(100vw - var(--jc-safe-area-left) - var(--jc-safe-area-right));
  scroll-snap-align: start;
}
${selector} :where(.actionSheet, .dialog, .formDialog, .MuiDialog-paper, [role="dialog"]) {
  max-block-size: calc(var(--jc-visual-viewport-height) - var(--jc-safe-area-top) - var(--jc-safe-area-bottom));
  margin-block-start: max(var(--jc-control-gap), var(--jc-safe-area-top));
  margin-block-end: max(var(--jc-control-gap), var(--jc-safe-area-bottom));
}
${selector} :where(.formDialogFooter, .MuiDialogActions-root) {
  position: sticky;
  inset-block-end: 0;
  z-index: 1;
  padding-block-end: max(var(--jc-control-gap), var(--jc-safe-area-bottom));
}
${selector}[data-jc-theme-keyboard="open"] :where(.actionSheet, .dialog, .formDialog, .MuiDialog-paper, [role="dialog"]) {
  position: fixed;
  inset-block-start: auto !important;
  inset-block-end: calc(var(--jc-keyboard-inset) + var(--jc-control-gap)) !important;
  inset-inline-start: max(var(--jc-control-gap), var(--jc-safe-area-left));
  inset-inline-end: max(var(--jc-control-gap), var(--jc-safe-area-right));
  max-block-size: calc(var(--jc-visual-viewport-height) - var(--jc-control-gap) - var(--jc-control-gap));
  margin-block: var(--jc-control-gap);
  transform: none !important;
}
${selector}[data-jc-theme-route="player"] .videoOsdBottom {
  box-sizing: border-box;
  max-inline-size: 100vw;
  max-block-size: var(--jc-visual-viewport-height);
  padding-inline-start: max(var(--jc-control-gap), var(--jc-safe-area-left));
  padding-inline-end: max(var(--jc-control-gap), var(--jc-safe-area-right));
  padding-block-end: max(var(--jc-control-gap), var(--jc-safe-area-bottom));
}
${selector}[data-jc-theme-route="player"] .videoOsdBottom :where(button, .emby-button, .sliderContainer) {
  min-block-size: max(2.75rem, 44px);
  touch-action: manipulation;
}
${selector}[data-jc-theme-keyboard="open"][data-jc-theme-route="player"] .videoOsdBottom {
  position: fixed;
  inset-block-end: var(--jc-keyboard-inset) !important;
}
${selector}[data-jc-theme-performance="reduced"] {
  --jc-effects-blur: 0px;
  --jc-effects-backdrop-opacity: 1;
}
${selector}[data-jc-theme-performance="reduced"] :where(
  .MuiAppBar-root,
  .MuiDrawer-paper,
  .MuiDialog-paper,
  .dialog,
  .formDialog,
  .actionSheet,
  .jc-arr-modal-overlay,
  .arr-dropdown-menu,
  .jc-discovery-customize-overlay,
  .jc-remove-confirm-overlay,
  .jc-hidden-management-overlay,
  .jc-hide-confirm-overlay,
  .jc-spoiler-confirm-overlay,
  .jc-elsewhere-blur-surface,
  .jc-calendar-card-status-top,
  .jc-calendar-event-status-top,
  #pause-screen-content,
  .videoOsdBottom,
  .sliderBubble,
  .chapterThumbContainer,
  .seerr-media-badge,
  .seerr-collection-badge,
  .seerr-overview,
  .seerr-season-modal
) {
  -webkit-backdrop-filter: none !important;
  backdrop-filter: none !important;
  background-color: var(--jc-color-surface);
}
${selector}[data-jc-theme-performance="reduced"] :where(
  .videoOsdBottom,
  .sliderBubble,
  .chapterThumbContainer,
  #pause-screen-content
) {
  background-image: none !important;
}
${selector}[data-jc-theme-performance="reduced"] .seerr-season-header::before {
  -webkit-backdrop-filter: none !important;
  backdrop-filter: none !important;
  background-color: var(--jc-color-surface);
}
@media (orientation: landscape) and (max-height: 599px) {
  ${selector} :where(.sectionTitle, .pageTitle) {
    margin-block: calc(var(--jc-control-gap) / 2);
  }
  ${selector} :where(.actionSheet, .dialog, .formDialog, .MuiDialog-paper, [role="dialog"]) {
    max-block-size: calc(var(--jc-visual-viewport-height) - var(--jc-control-gap));
  }
  ${selector}[data-jc-theme-route="player"] .videoOsdBottom {
    overflow-y: auto;
    overscroll-behavior-block: contain;
  }
}`;
}
