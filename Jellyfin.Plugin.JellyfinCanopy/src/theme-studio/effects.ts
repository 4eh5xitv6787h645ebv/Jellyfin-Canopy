/**
 * Bounded effects and motion adapters for Theme Studio issue #391.
 *
 * The inventory is deliberately finite: no particles, layout animation,
 * per-card filters, text blur, or selector generated from user data.
 */

export const THEME_EFFECT_MODULES = Object.freeze([
    Object.freeze({ id: 'materials-v12', properties: Object.freeze(['background-color', 'backdrop-filter']) }),
    Object.freeze({ id: 'elevation-v12', properties: Object.freeze(['box-shadow']) }),
    Object.freeze({ id: 'backdrop-treatment-v12', properties: Object.freeze(['filter', 'mask-image', 'transform']) }),
    Object.freeze({
        id: 'motion-v12',
        properties: Object.freeze(['opacity', 'transform', 'background-color', 'color', 'box-shadow']),
    }),
]);

export function serializeEffectsAdapters(rootSelector: string): string {
    const selector = `${rootSelector}:is(`
        + '[data-jc-theme-breakpoint="phone"],'
        + '[data-jc-theme-breakpoint="desktop"],'
        + '[data-jc-theme-breakpoint="wide"])[data-jc-theme-route]';
    const surfaces = `:where(
  .MuiAppBar-root,
  .MuiDrawer-paper,
  .MuiDialog-paper,
  .MuiMenu-paper,
  .dialog,
  .formDialog,
  .actionSheet,
  .mainDrawer,
  .jc-arr-modal-overlay,
  .arr-dropdown-menu,
  .jc-discovery-customize-overlay,
  .jc-remove-confirm-overlay,
  .jc-hidden-management-overlay,
  .jc-hide-confirm-overlay,
  .jc-spoiler-confirm-overlay,
  .jc-elsewhere-blur-surface,
  #pause-screen-content,
  .videoOsdBottom,
  .sliderBubble,
  .chapterThumbContainer
)`;
    const elevationSurfaces = `:where(
  .MuiPaper-elevation1,
  .MuiPaper-elevation2,
  .MuiPaper-elevation3,
  .cardBox,
  .visualCardBox,
  .jc-card,
  .jc-theme-preview-card
)`;
    return `
/* Adapter materials-v12: finite modern surfaces, never text or per-card filters. */
${selector}[data-jc-theme-effects-material="solid"] ${surfaces} {
  -webkit-backdrop-filter: none !important;
  backdrop-filter: none !important;
  background-color: var(--jc-color-surface);
}
${selector}[data-jc-theme-effects-material="translucent"] ${surfaces} {
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  background-color: var(--jc-effects-surface-background);
}
${selector}[data-jc-theme-effects-material="glass"] ${surfaces} {
  -webkit-backdrop-filter: blur(var(--jc-effects-blur)) saturate(var(--jc-effects-saturation));
  backdrop-filter: blur(var(--jc-effects-blur)) saturate(var(--jc-effects-saturation));
  background-color: var(--jc-effects-surface-background);
}

/* Adapter elevation-v12: bounded shadows/glow; no generated or animated shadow lists. */
${selector}:not([data-jc-theme-effects-level="minimal"]) ${elevationSurfaces} {
  box-shadow: var(--jc-elevation-card-shadow);
}
${selector}:not([data-jc-theme-effects-level="minimal"]) :where(.MuiDialog-paper, .dialog, .formDialog, .actionSheet) {
  box-shadow: var(--jc-elevation-dialog-shadow), 0 0 1.75rem var(--jc-effects-glow-color);
}

/* Adapter backdrop-treatment-v12: only page-owned media backdrops are filtered. */
${selector}[data-jc-theme-image-treatment="dim"] :where(.backdropImage, .detailPagePrimaryContainer + .backgroundContainer img) {
  filter: brightness(.62) saturate(.9);
}
${selector}[data-jc-theme-image-treatment="gradient"] :where(.backdropImage, .detailPagePrimaryContainer + .backgroundContainer img) {
  -webkit-mask-image: linear-gradient(to bottom, rgb(0 0 0 / .96), transparent 96%);
  mask-image: linear-gradient(to bottom, rgb(0 0 0 / .96), transparent 96%);
}
${selector}[data-jc-theme-image-treatment="blur"][data-jc-theme-effects-level="full"] :where(.backdropImage, .detailPagePrimaryContainer + .backgroundContainer img) {
  filter: blur(min(var(--jc-effects-blur), 16px)) brightness(.7);
  transform: scale(1.025);
}

/* Adapter motion-v12: layout-stable, finite entry set, no layout properties. */
${selector}[data-jc-theme-motion-profile="calm"] :where(.MuiButtonBase-root, .emby-button, .cardBox) {
  transition-property: opacity, transform, background-color, color, box-shadow;
  transition-duration: var(--jc-motion-duration);
  transition-timing-function: var(--jc-motion-easing);
}
${selector}[data-jc-theme-motion-profile="expressive"][data-jc-theme-page-transition="true"] :where(.page:not(.hide), .MuiContainer-root) {
  animation: jc-theme-page-enter var(--jc-motion-duration) var(--jc-motion-easing) both;
}
${selector}[data-jc-theme-motion-profile="expressive"][data-jc-theme-stagger="true"] :where(.itemsContainer, .verticalSection) > :nth-child(-n + 8) {
  animation: jc-theme-item-enter var(--jc-motion-duration) var(--jc-motion-easing) both;
  animation-delay: calc((var(--jc-theme-stagger-index, 0)) * 24ms);
}
${selector}[data-jc-theme-motion-profile="expressive"][data-jc-theme-stagger="true"] :where(.itemsContainer, .verticalSection) > :nth-child(2) { --jc-theme-stagger-index: 1; }
${selector}[data-jc-theme-motion-profile="expressive"][data-jc-theme-stagger="true"] :where(.itemsContainer, .verticalSection) > :nth-child(3) { --jc-theme-stagger-index: 2; }
${selector}[data-jc-theme-motion-profile="expressive"][data-jc-theme-stagger="true"] :where(.itemsContainer, .verticalSection) > :nth-child(4) { --jc-theme-stagger-index: 3; }
${selector}[data-jc-theme-motion-profile="expressive"][data-jc-theme-stagger="true"] :where(.itemsContainer, .verticalSection) > :nth-child(5) { --jc-theme-stagger-index: 4; }
${selector}[data-jc-theme-motion-profile="expressive"][data-jc-theme-stagger="true"] :where(.itemsContainer, .verticalSection) > :nth-child(6) { --jc-theme-stagger-index: 5; }
${selector}[data-jc-theme-motion-profile="expressive"][data-jc-theme-stagger="true"] :where(.itemsContainer, .verticalSection) > :nth-child(7) { --jc-theme-stagger-index: 6; }
${selector}[data-jc-theme-motion-profile="expressive"][data-jc-theme-stagger="true"] :where(.itemsContainer, .verticalSection) > :nth-child(8) { --jc-theme-stagger-index: 7; }
@keyframes jc-theme-page-enter { from { opacity: .82; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes jc-theme-item-enter { from { opacity: .72; transform: translateY(4px); } to { opacity: 1; transform: none; } }

${selector}[data-jc-theme-motion-profile="off"] *,
${selector}[data-jc-theme-motion-profile="off"] *::before,
${selector}[data-jc-theme-motion-profile="off"] *::after {
  animation-duration: .01ms !important;
  animation-iteration-count: 1 !important;
  scroll-behavior: auto !important;
  transition-duration: .01ms !important;
}
@media (forced-colors: active), (prefers-reduced-motion: reduce) {
  ${selector} *, ${selector} *::before, ${selector} *::after {
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .01ms !important;
  }
}
@media (prefers-reduced-transparency: reduce) {
  ${selector} ${surfaces} {
    -webkit-backdrop-filter: none !important;
    backdrop-filter: none !important;
    background-color: var(--jc-color-surface) !important;
  }
}
@media (forced-colors: active) {
  ${selector} ${surfaces} {
    -webkit-backdrop-filter: none !important;
    backdrop-filter: none !important;
    background-color: Canvas !important;
  }
}`;
}
