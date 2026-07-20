/**
 * Semantic Theme Studio adapters for Canopy-owned surfaces (issue #393).
 *
 * The selectors below are intentionally limited to stable Canopy hooks. They
 * only change presentation: protection, authorization, identity ownership,
 * hidden state and feature lifecycle remain owned by their feature modules.
 */

export interface ThemeCanopySurfaceModule {
    readonly id: string;
    readonly outcome: string;
    readonly tokens: readonly string[];
    readonly modernRoles: readonly string[];
    readonly policyHooks: readonly string[];
    readonly decorativeHooks: readonly string[];
}

/** Machine-readable component/surface contract for the complete #393 group. */
export const THEME_CANOPY_SURFACE_MODULES: readonly ThemeCanopySurfaceModule[] = Object.freeze([
    {
        id: 'canopy-shell-v1',
        outcome: 'Enhanced launcher, native tabs, settings panes and header actions',
        tokens: ['color.*', 'type.*', 'shape.*', 'elevation.*', 'space.*', 'motion.*'],
        modernRoles: [
            '#jellyfin-canopy-panel',
            '#jellyfin-canopy-panel-backdrop',
            '#jellyfin-canopy-panel .jc-panel-header',
            '#jellyfin-canopy-panel .jc-panel-body',
            '#jellyfin-canopy-panel .jc-panel-nav',
            '#jellyfin-canopy-panel .jc-panel-search',
            '#jellyfin-canopy-panel .jc-panel-main',
            '#jellyfin-canopy-panel .jc-pane',
            '#jellyfin-canopy-panel .jc-pane-title',
            '#jellyfin-canopy-panel .jc-pane-back',
            '#jellyfin-canopy-panel .panel-footer',
            '#jellyfin-canopy-panel .jc-quality-cat-expander',
            '#jellyfin-canopy-panel .jc-quality-cat-list',
            '#jellyfin-canopy-panel .jc-quality-cat-row',
            '#jellyfin-canopy-panel .jc-cat-btn',
            '#jc-native-tabs-group',
            '#jc-native-tabs-separator',
            '[id^="jc-native-tab-btn-"]',
            '[id^="jc-native-tab-link-"]',
            '[id^="jc-native-tab-panel-"]',
            '#jellyfinCanopySettingsLink',
            '#jellyfinCanopyUserPrefsLink',
            '#enhancedSettingsBtn',
            '#randomItemButton',
            '.jc-theme-editor-root',
            '.jc-theme-hint',
        ],
        policyHooks: [],
        decorativeHooks: [
            '.jc-panel-nav-items',
            '.jc-pane-open',
            '.jc-theme-pane-active',
            '.jc-interior-page-top',
        ],
    },
    {
        id: 'canopy-protection-v1',
        outcome: 'Spoiler Guard and hidden-content controls, confirmations and admin views',
        tokens: ['color.*', 'type.*', 'shape.*', 'elevation.*', 'space.*', 'motion.*'],
        modernRoles: [
            '.jc-spoiler-blur-btn',
            '.jc-spoiler-pending-btn',
            '.jc-spoiler-confirm-overlay',
            '.jc-spoiler-confirm-dialog',
            '.jc-spoiler-confirm-title',
            '.jc-spoiler-confirm-snooze',
            '.jc-spoiler-disable-snooze',
            '.jc-spoiler-confirm-buttons',
            '.jc-spoiler-confirm-cancel',
            '.jc-spoiler-confirm-ok',
            '.jc-hide-btn',
            '.jc-detail-hide-btn',
            '.jc-hide-confirm-overlay',
            '.jc-hide-confirm-dialog',
            '.jc-hide-confirm-options',
            '.jc-hide-confirm-buttons',
            '.jc-hide-confirm-cancel',
            '.jc-hide-confirm-hide',
            '.jc-hidden-management-overlay',
            '.jc-hidden-management-panel',
            '.jc-hidden-management-header',
            '.jc-hidden-management-close',
            '.jc-hidden-management-toolbar',
            '.jc-hidden-management-search',
            '.jc-hidden-management-grid',
            '.jc-hidden-management-empty',
            '.jc-hidden-management-unhide-all',
            '.jc-hidden-item-card',
            '.jc-hidden-item-poster',
            '.jc-hidden-item-info',
            '.jc-hidden-item-name',
            '.jc-hidden-item-meta',
            '.jc-hidden-item-unhide',
            '.jc-hidden-item-identity-resolution',
            '.jc-hidden-content-page',
            '.jc-hidden-content-container',
            '.jc-hidden-content-header',
            '.jc-hidden-content-title',
            '.jc-hidden-content-count',
            '.jc-hidden-content-toolbar',
            '.jc-hidden-content-page-search',
            '.jc-hidden-content-page-grid',
            '.jc-hidden-content-page-empty',
            '.jc-hidden-content-page-unhide-all',
            '.jc-hidden-scoped-filter',
            '.jc-hidden-scoped-badge',
            '.jc-hidden-admin-user-filter',
            '.jc-hidden-admin-edit-toggle',
            '.jc-hidden-admin-add-btn',
            '.jc-hidden-admin-viewing-badge',
            '.jc-hidden-admin-viewing-icon',
            '.jc-hidden-admin-viewing-user',
            '.jc-hidden-group-card',
            '.jc-hidden-group-poster-link',
            '.jc-hidden-group-poster',
            '.jc-hidden-group-info',
            '.jc-hidden-group-name',
            '.jc-hidden-group-meta',
            '.jc-hidden-group-expand',
            '.jc-hidden-group-items',
            '.jc-hidden-group-item',
            '.jc-hidden-group-item-info',
            '.jc-hidden-group-item-label',
            '.jc-hidden-group-item-unhide',
            '.jc-hidden-group-unhide',
            '.jc-hidden-group-unhide-all',
            '.jc-hidden-group-section-title',
            '.jc-hidden-expand-all-btn',
            '.jc-hidden-section-header-title',
            '.jc-more-info-modal',
            '.jc-more-info-secondary-actions',
        ],
        policyHooks: [
            '.jc-hidden',
            '.jc-already-hidden',
            '[data-jc-spoiler-state]',
            '[data-jc-hidden-direct]',
            '[data-jc-hidden-checked]',
            '[data-jc-hidden-parent-series-id]',
            '[data-jc-hidden-scope-signature]',
            '[data-jc-item-id]',
            '[data-jc-media-type]',
            '[data-jc-spoiler-kind]',
            '[data-jc-tmdb-id]',
            '[data-jc-hidden-page-owner="true"]',
            '[data-jc-identity-owned="true"]',
        ],
        decorativeHooks: [
            '.jc-hidden-item-removing',
            '.jc-hidden-admin-editing',
            '.jc-hidden-group-section',
            '.jc-hidden-section-header',
            '#jc-hidden-content',
            '#jc-hidden-content-page-styles',
            '#jc-spoiler-guard-css',
        ],
    },
    {
        id: 'canopy-card-overlays-v1',
        outcome: 'Collision-safe tag lanes, filler warnings, ratings and card metadata',
        tokens: ['color.*', 'type.*', 'shape.*', 'elevation.*', 'space.*', 'motion.*', 'icon.*'],
        modernRoles: [
            '.jc-tag-host',
            '.jc-tag-lane[data-jc-tag-position]',
            '.genre-overlay-container',
            '.genre-tag',
            '.language-overlay-container',
            '.language-flag',
            '.quality-overlay-container',
            '.quality-overlay-label',
            '.rating-overlay-container',
            '.rating-tag',
            '.jc-userreview-tag',
            '.jc-anime-filler-marker',
            '.mediaInfoOfficialRating[data-jc-colored-rating="true"]',
            '.jc-people-age-container',
            '.jc-people-age-chip',
            '.jc-people-age-icon',
            '.jc-people-age-text',
            '.jc-people-place-banner',
            '.jc-people-place-icon',
            '.jc-people-place-text',
            '.jc-people-flag',
            '.jc-people-tag-banner',
        ],
        policyHooks: [
            '.jc-tags-hide-on-hover',
            '.jc-deceased-poster',
            '[data-jc-colored-rating="true"]',
        ],
        decorativeHooks: [
            '.jc-anime-filler-anchor',
            '.rating-star-icon',
            '.rating-tomato-icon',
            '.rating-text',
            '.genre-text',
            '.jc-userreview-icon',
            '#jc-anime-filler-warning-styles',
            '#jc-people-tags-styles',
            '#jc-userreview-tags-css',
        ],
    },
    {
        id: 'canopy-transient-ui-v1',
        outcome: 'Home actions, notifications, loading/error state and owned overlays',
        tokens: ['color.*', 'type.*', 'shape.*', 'elevation.*', 'space.*', 'motion.*'],
        modernRoles: [
            '.jellyfin-canopy-toast',
            '.jc-undo-toast',
            '.jc-undo-btn',
            '#jellyfin-release-notes-notification',
            '.jc-remove-confirm-overlay',
            '.jc-remove-confirm-title',
            '[data-jc-theme-component="destructive-confirmation"]',
            '.actionSheetMenuItem[data-id="remove-continue-watching"]',
            '.actionSheetMenuItem[data-id="jc-multiselect-remove"]',
        ],
        policyHooks: ['[data-jc-home-removed]', '[data-jc-home-section-hidden]'],
        decorativeHooks: ['.jc-visible', '.loading', '.shake-error', '.jc-modal-open'],
    },
]);

function shell(selector: string): string {
    return `
/* Adapter canopy-shell-v1: launcher, tabs, settings and header actions. */
${selector} #jellyfin-canopy-panel-backdrop {
  background: color-mix(in srgb, var(--jc-color-scrim) 88%, transparent) !important;
  -webkit-backdrop-filter: blur(var(--jc-effects-blur)) !important;
  backdrop-filter: blur(var(--jc-effects-blur)) !important;
}
${selector} #jellyfin-canopy-panel {
  box-sizing: border-box;
  max-inline-size: min(72rem, calc(100vw - var(--jc-page-gutter) - var(--jc-page-gutter))) !important;
  max-block-size: calc(var(--jc-visual-viewport-height) - var(--jc-safe-area-top) - var(--jc-safe-area-bottom) - var(--jc-page-gutter)) !important;
  border: var(--jc-shape-border-width) solid var(--jc-color-divider) !important;
  border-radius: var(--jc-shape-dialog-radius) !important;
  background: var(--jc-color-surface) !important;
  box-shadow: var(--jc-elevation-dialog-shadow) !important;
  color: var(--jc-color-text) !important;
  font-family: var(--jc-type-family-ui) !important;
}
${selector} #jellyfin-canopy-panel :where(.jc-panel-header, .panel-footer) {
  border-color: var(--jc-color-divider) !important;
  background: var(--jc-color-elevated) !important;
  color: var(--jc-color-text) !important;
}
${selector} #jellyfin-canopy-panel .jc-panel-body {
  background: var(--jc-color-surface) !important;
}
${selector} #jellyfin-canopy-panel .jc-panel-nav {
  border-left: 0 !important;
  border-right: 0 !important;
  border-inline-end: var(--jc-shape-border-width) solid var(--jc-color-divider) !important;
  background: color-mix(in srgb, var(--jc-color-canvas) 42%, var(--jc-color-surface)) !important;
}
${selector} #jellyfin-canopy-panel :where(.jc-panel-main, .jc-pane-title, .jc-theme-label) {
  color: var(--jc-color-text) !important;
}
${selector} #jellyfin-canopy-panel :where(
  .jc-panel-search,
  input:not([type="checkbox"]):not([type="radio"]),
  select,
  textarea
) {
  box-sizing: border-box;
  min-block-size: max(2.75rem, 44px);
  max-inline-size: 100%;
  border-color: var(--jc-color-control-border) !important;
  border-radius: var(--jc-shape-control-radius) !important;
  background: var(--jc-color-canvas) !important;
  color: var(--jc-color-text) !important;
}
${selector} :where(
  #jellyfin-canopy-panel label:has(input[type="checkbox"]),
  .jc-spoiler-confirm-snooze,
  .jc-spoiler-disable-snooze
) {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  min-block-size: max(2.75rem, 44px);
  touch-action: manipulation;
}
${selector} #jellyfin-canopy-panel :where(.jc-panel-search, input, select, textarea):focus-visible,
${selector} #jellyfin-canopy-panel :where(button, [role="button"], .shortcut-key):focus-visible,
${selector} :where(
  [id^="jc-native-tab-btn-"],
  [id^="jc-native-tab-link-"],
  #jellyfinCanopySettingsLink,
  #jellyfinCanopyUserPrefsLink,
  #enhancedSettingsBtn,
  #randomItemButton
):focus-visible {
  outline: var(--jc-elevation-focus-ring) solid var(--jc-color-focus) !important;
  outline-offset: 2px;
}
${selector} #jellyfin-canopy-panel .tab-button {
  min-block-size: max(2.75rem, 44px);
  overflow: hidden;
  border-radius: var(--jc-shape-control-radius) !important;
  color: var(--jc-color-text-muted) !important;
  text-align: start !important;
  text-overflow: ellipsis;
  white-space: nowrap;
}
${selector} #jellyfin-canopy-panel .tab-button:is(:hover, :focus-visible) {
  background: color-mix(in srgb, var(--jc-color-primary) 12%, transparent) !important;
  color: var(--jc-color-text) !important;
}
${selector} #jellyfin-canopy-panel .tab-button.active {
  background: color-mix(in srgb, var(--jc-color-primary) 20%, transparent) !important;
  color: var(--jc-color-text) !important;
}
${selector} #jellyfin-canopy-panel .tab-button.active::before {
  inset-inline-start: 0 !important;
  inset-inline-end: auto !important;
  background: var(--jc-color-primary) !important;
}
${selector} #jellyfin-canopy-panel :where(.jc-pane-back, .jc-cat-btn, .jc-quality-cat-expander, .jc-theme-button) {
  min-block-size: max(2.75rem, 44px);
  border-color: var(--jc-color-control-border) !important;
  border-radius: var(--jc-shape-control-radius) !important;
  color: var(--jc-color-text) !important;
}
${selector} #jellyfin-canopy-panel button {
  min-block-size: max(2.75rem, 44px);
  touch-action: manipulation;
}
${selector} #jellyfin-canopy-panel :where(.jc-quality-cat-list, .jc-quality-cat-row) {
  border-color: var(--jc-color-divider) !important;
  background: color-mix(in srgb, var(--jc-color-canvas) 50%, transparent) !important;
}
${selector} :where(#jc-native-tabs-group, [id^="jc-native-tab-panel-"]) {
  min-inline-size: 0;
  color: var(--jc-color-text);
}
${selector} #jc-native-tabs-group {
  gap: calc(var(--jc-control-gap) / 2);
  max-inline-size: 100%;
  overflow-x: auto !important;
  scrollbar-width: none;
}
${selector} #jc-native-tabs-separator {
  background: var(--jc-color-divider) !important;
}
${selector} :where(
  [id^="jc-native-tab-btn-"],
  [id^="jc-native-tab-link-"],
  #jellyfinCanopySettingsLink,
  #jellyfinCanopyUserPrefsLink,
  #enhancedSettingsBtn
) {
  min-block-size: max(2.75rem, 44px);
  border-radius: var(--jc-shape-control-radius) !important;
  color: var(--jc-color-text) !important;
  white-space: nowrap;
}
${selector} #randomItemButton.loading {
  color: var(--jc-color-info) !important;
  cursor: progress;
}
${selector} #randomItemButton {
  min-inline-size: max(2.75rem, 44px);
  min-block-size: max(2.75rem, 44px);
  touch-action: manipulation;
}
${selector}[data-jc-theme-breakpoint="phone"] #jellyfin-canopy-panel {
  inset: var(--jc-visual-viewport-top) 0 auto 0 !important;
  inline-size: 100vw !important;
  max-inline-size: 100vw !important;
  block-size: var(--jc-visual-viewport-height) !important;
  max-block-size: var(--jc-visual-viewport-height) !important;
  border: 0 !important;
  border-radius: 0 !important;
}
${selector}[data-jc-theme-breakpoint="phone"] #jellyfin-canopy-panel :where(.jc-panel-header, .panel-footer) {
  padding-inline-start: max(var(--jc-control-gap), var(--jc-safe-area-left)) !important;
  padding-inline-end: max(var(--jc-control-gap), var(--jc-safe-area-right)) !important;
}
${selector}[dir="rtl"][data-jc-theme-breakpoint="phone"] #jellyfin-canopy-panel :where(.jc-panel-header, .panel-footer) {
  padding-inline-start: max(var(--jc-control-gap), var(--jc-safe-area-right)) !important;
  padding-inline-end: max(var(--jc-control-gap), var(--jc-safe-area-left)) !important;
}
${selector}[data-jc-theme-breakpoint="phone"] #jellyfin-canopy-panel .panel-footer {
  padding-block-end: max(var(--jc-control-gap), var(--jc-safe-area-bottom)) !important;
}
${selector}[data-jc-theme-breakpoint="phone"] #jellyfin-canopy-panel .jc-panel-main {
  padding-inline-start: max(var(--jc-control-gap), var(--jc-safe-area-left)) !important;
  padding-inline-end: max(var(--jc-control-gap), var(--jc-safe-area-right)) !important;
  background: var(--jc-color-surface) !important;
}
${selector}[dir="rtl"][data-jc-theme-breakpoint="phone"] #jellyfin-canopy-panel .jc-panel-main {
  padding-inline-start: max(var(--jc-control-gap), var(--jc-safe-area-right)) !important;
  padding-inline-end: max(var(--jc-control-gap), var(--jc-safe-area-left)) !important;
  transform: translateX(-102%) !important;
}
${selector}[dir="rtl"][data-jc-theme-breakpoint="phone"] #jellyfin-canopy-panel .jc-panel-body.jc-pane-open .jc-panel-main {
  transform: translateX(0) !important;
}
`;
}

function protection(selector: string): string {
    return `
/* Adapter canopy-protection-v1: presentation only; policy hooks remain feature-owned. */
${selector} :where(.jc-spoiler-blur-btn, .jc-spoiler-pending-btn)[aria-pressed="true"] {
  border-color: var(--jc-color-primary) !important;
  background: color-mix(in srgb, var(--jc-color-primary) 22%, transparent) !important;
  color: var(--jc-color-text) !important;
}
${selector} .jc-spoiler-blur-btn[data-jc-spoiler-state="loading"],
${selector} .jc-spoiler-pending-btn:disabled {
  border-color: var(--jc-color-control-border) !important;
  color: var(--jc-color-disabled) !important;
  cursor: progress;
}
${selector} :where(.jc-spoiler-confirm-overlay, .jc-hide-confirm-overlay, .jc-hidden-management-overlay) {
  box-sizing: border-box;
  padding: max(var(--jc-page-gutter), var(--jc-safe-area-top)) max(var(--jc-page-gutter), var(--jc-safe-area-right)) max(var(--jc-page-gutter), var(--jc-safe-area-bottom)) max(var(--jc-page-gutter), var(--jc-safe-area-left)) !important;
  background: color-mix(in srgb, var(--jc-color-scrim) 88%, transparent) !important;
  -webkit-backdrop-filter: blur(var(--jc-effects-blur)) !important;
  backdrop-filter: blur(var(--jc-effects-blur)) !important;
}
${selector} :where(.jc-spoiler-confirm-dialog, .jc-hide-confirm-dialog, .jc-hidden-management-panel) {
  box-sizing: border-box;
  max-inline-size: min(48rem, 100%) !important;
  max-block-size: calc(var(--jc-visual-viewport-height) - var(--jc-safe-area-top) - var(--jc-safe-area-bottom) - var(--jc-page-gutter) - var(--jc-page-gutter));
  overflow: auto;
  border: var(--jc-shape-border-width) solid var(--jc-color-divider) !important;
  border-radius: var(--jc-shape-dialog-radius) !important;
  background: var(--jc-color-surface) !important;
  box-shadow: var(--jc-elevation-dialog-shadow) !important;
  color: var(--jc-color-text) !important;
}
${selector} :where(.jc-spoiler-confirm-dialog, .jc-hide-confirm-dialog, .jc-hidden-management-panel) :where(p, label, .jc-hidden-item-meta) {
  color: var(--jc-color-text-muted) !important;
  overflow-wrap: anywhere;
}
${selector} :where(
  .jc-spoiler-confirm-cancel,
  .jc-spoiler-confirm-ok,
  .jc-hide-confirm-cancel,
  .jc-hide-confirm-hide,
  .jc-hidden-management-close,
  .jc-hidden-management-unhide-all,
  .jc-hidden-item-unhide,
  .jc-hidden-content-page-unhide-all,
  .jc-hidden-group-unhide,
  .jc-hidden-group-unhide-all,
  .jc-hidden-group-item-unhide,
  .jc-hidden-expand-all-btn,
  .jc-hidden-admin-edit-toggle,
  .jc-hidden-admin-add-btn
) {
  min-inline-size: max(2.75rem, 44px);
  min-block-size: max(2.75rem, 44px);
  border-radius: var(--jc-shape-control-radius) !important;
  touch-action: manipulation;
}
${selector} :where(.jc-hide-confirm-hide, .jc-hidden-management-unhide-all, .jc-hidden-content-page-unhide-all) {
  border-color: var(--jc-color-negative) !important;
  background: color-mix(in srgb, var(--jc-color-negative) 28%, var(--jc-color-surface)) !important;
  color: var(--jc-color-text) !important;
}
${selector} :where(.jc-spoiler-confirm-ok, .jc-hidden-item-unhide, .jc-hidden-group-unhide, .jc-hidden-group-unhide-all, .jc-hidden-group-item-unhide) {
  border-color: var(--jc-color-primary) !important;
  background: color-mix(in srgb, var(--jc-color-primary) 24%, var(--jc-color-surface)) !important;
  color: var(--jc-color-text) !important;
}
${selector} :where(.jc-spoiler-confirm-buttons, .jc-hide-confirm-buttons) {
  flex-wrap: wrap;
  gap: var(--jc-control-gap) !important;
}
${selector} :where(.jc-hidden-management-header, .jc-hidden-management-toolbar, .jc-hidden-content-header, .jc-hidden-content-toolbar) {
  box-sizing: border-box;
  border-color: var(--jc-color-divider) !important;
  gap: var(--jc-control-gap) !important;
}
${selector} :where(.jc-hidden-management-search, .jc-hidden-content-page-search, .jc-hidden-admin-user-filter) {
  box-sizing: border-box;
  min-block-size: max(2.75rem, 44px);
  min-inline-size: 0;
  border-color: var(--jc-color-control-border) !important;
  border-radius: var(--jc-shape-control-radius) !important;
  background: var(--jc-color-canvas) !important;
  color: var(--jc-color-text) !important;
}
${selector} :where(.jc-hidden-item-card, .jc-hidden-group-card, .jc-hidden-group-item) {
  min-inline-size: 0;
  border-color: var(--jc-color-divider) !important;
  border-radius: var(--jc-shape-card-radius) !important;
  background: var(--jc-color-elevated) !important;
  box-shadow: var(--jc-elevation-card-shadow) !important;
  color: var(--jc-color-text) !important;
}
${selector} :where(.jc-hidden-item-name, .jc-hidden-group-name, .jc-hidden-group-item-label) {
  color: var(--jc-color-text) !important;
  overflow-wrap: anywhere;
}
${selector} :where(.jc-hidden-item-meta, .jc-hidden-group-meta, .jc-hidden-admin-viewing-badge, .jc-hidden-scoped-badge) {
  color: var(--jc-color-text-muted) !important;
}
${selector} .jc-hidden-admin-viewing-badge.jc-hidden-admin-editing {
  border-color: var(--jc-color-caution) !important;
  color: var(--jc-color-caution) !important;
}
${selector} .jc-hide-btn {
  inset-block-start: 0.35rem !important;
  inset-inline-end: 0.35rem !important;
  inset-inline-start: auto !important;
  min-inline-size: max(2.75rem, 44px) !important;
  min-block-size: max(2.75rem, 44px) !important;
  border-color: var(--jc-color-control-border) !important;
  background: color-mix(in srgb, var(--jc-color-scrim) 88%, transparent) !important;
  color: var(--jc-color-on-scrim) !important;
}
${selector}[data-jc-theme-pointer="coarse"] .jc-hide-btn,
${selector} .card:focus-within .jc-hide-btn {
  opacity: 1;
}
${selector} :where(
  .jc-spoiler-blur-btn,
  .jc-spoiler-pending-btn,
  .jc-spoiler-confirm-cancel,
  .jc-spoiler-confirm-ok,
  .jc-hide-btn,
  .jc-detail-hide-btn,
  .jc-hide-confirm-cancel,
  .jc-hide-confirm-hide,
  .jc-hidden-management-close,
  .jc-hidden-management-unhide-all,
  .jc-hidden-item-unhide,
  .jc-hidden-content-page-unhide-all,
  .jc-hidden-group-unhide,
  .jc-hidden-group-unhide-all,
  .jc-hidden-group-item-unhide,
  .jc-hidden-expand-all-btn,
  .jc-hidden-admin-edit-toggle,
  .jc-hidden-admin-add-btn,
  .jc-hidden-management-search,
  .jc-hidden-content-page-search,
  .jc-hidden-admin-user-filter
):focus-visible {
  outline: var(--jc-elevation-focus-ring) solid var(--jc-color-focus) !important;
  outline-offset: 2px;
}
${selector}[data-jc-theme-breakpoint="phone"] :where(.jc-hidden-management-toolbar, .jc-hidden-content-toolbar) {
  align-items: stretch;
  flex-direction: column;
}
${selector}[data-jc-theme-breakpoint="phone"] :where(.jc-hidden-management-grid, .jc-hidden-content-page-grid) {
  grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
  gap: var(--jc-card-gap) !important;
  padding: var(--jc-page-gutter) !important;
}
${selector}[data-jc-theme-breakpoint="phone"] :where(.jc-spoiler-confirm-dialog, .jc-hide-confirm-dialog) {
  inline-size: 100% !important;
}
`;
}

function cardOverlays(selector: string): string {
    return `
/* Adapter canopy-card-overlays-v1: one non-colliding lane per configured corner. */
${selector} .jc-tag-host > .jc-tag-lane[data-jc-tag-position] {
  position: absolute;
  z-index: 4;
  display: flex;
  flex-direction: column;
  gap: calc(var(--jc-control-gap) / 3);
  max-inline-size: calc(100% - 0.8rem);
  max-block-size: calc(100% - 0.8rem);
  overflow: hidden;
  pointer-events: none;
}
${selector} .jc-tag-host > .jc-tag-lane[data-jc-tag-position^="top-"] { inset-block-start: 0.4rem; }
${selector} .jc-tag-host > .jc-tag-lane[data-jc-tag-position^="bottom-"] {
  inset-block-end: 0.4rem;
  flex-direction: column-reverse;
}
${selector} .jc-tag-host > .jc-tag-lane[data-jc-tag-position$="-left"] {
  inset-inline-start: 0.4rem;
  align-items: flex-start;
}
${selector} .jc-tag-host > .jc-tag-lane[data-jc-tag-position$="-right"] {
  inset-inline-end: 0.4rem;
  align-items: flex-end;
}
${selector} .cardScalable:has(.cardIndicators) > .jc-tag-host > .jc-tag-lane[data-jc-tag-position="top-right"],
${selector} .cardScalable:has(> .jc-anime-filler-marker) > .jc-tag-host > .jc-tag-lane[data-jc-tag-position="top-right"] {
  inset-block-start: max(2.75rem, calc(var(--jc-control-gap) + 2rem)) !important;
}
${selector} .card:has(.jc-hide-btn) .jc-tag-lane[data-jc-tag-position="top-right"] {
  inset-block-start: max(3.5rem, calc(var(--jc-control-gap) + 2.75rem)) !important;
}
${selector} .card:has(.jc-hide-btn):has(.jc-anime-filler-marker) .jc-hide-btn {
  inset-inline-start: 0.35rem !important;
  inset-inline-end: auto !important;
}
${selector} .card:has(.jc-hide-btn):has(.jc-anime-filler-marker) .jc-tag-lane[data-jc-tag-position="top-left"] {
  inset-block-start: max(3.5rem, calc(var(--jc-control-gap) + 2.75rem)) !important;
}
${selector} .card:has(.jc-hide-btn):has(.jc-anime-filler-marker) .jc-tag-lane[data-jc-tag-position="top-right"] {
  inset-block-start: max(2.75rem, calc(var(--jc-control-gap) + 2rem)) !important;
}
${selector} .jc-tag-lane[data-jc-tag-position] > :where(
  .genre-overlay-container,
  .language-overlay-container,
  .quality-overlay-container,
  .rating-overlay-container
) {
  position: static !important;
  inset: auto !important;
  max-inline-size: 100% !important;
  max-block-size: none !important;
  margin: 0 !important;
  flex: 0 0 auto;
}
${selector} :where(.genre-tag, .quality-overlay-label, .rating-tag, .jc-userreview-tag) {
  box-sizing: border-box;
  max-inline-size: 100%;
  border-color: color-mix(in srgb, var(--jc-color-on-scrim) 32%, transparent) !important;
  border-radius: var(--jc-shape-control-radius) !important;
  background: var(--jc-color-scrim) !important;
  box-shadow: var(--jc-elevation-card-shadow) !important;
  color: var(--jc-color-on-scrim) !important;
}
${selector} :where(.quality-overlay-label, .rating-tag, .jc-userreview-tag, .genre-text) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
${selector} .genre-tag .genre-text {
  max-inline-size: min(16rem, 70vw);
  border: var(--jc-shape-border-width) solid var(--jc-color-divider);
  background: var(--jc-color-scrim) !important;
  color: var(--jc-color-on-scrim) !important;
}
${selector} .card:focus-within .genre-tag .genre-text {
  opacity: 1;
}
${selector} .language-flag {
  border: var(--jc-shape-border-width) solid color-mix(in srgb, var(--jc-color-on-scrim) 45%, transparent);
  box-shadow: var(--jc-elevation-card-shadow) !important;
}
${selector} :where(.jc-people-age-chip, .jc-people-place-banner, .jc-people-tag-banner) {
  box-sizing: border-box;
  max-inline-size: 100%;
  border: var(--jc-shape-border-width) solid color-mix(in srgb, var(--jc-color-on-scrim) 32%, transparent) !important;
  border-radius: var(--jc-shape-control-radius) !important;
  background: var(--jc-color-scrim) !important;
  box-shadow: var(--jc-elevation-card-shadow) !important;
  color: var(--jc-color-on-scrim) !important;
}
${selector} :where(.jc-people-age-text, .jc-people-place-text) {
  min-inline-size: 0;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
  white-space: nowrap !important;
}
${selector} .jc-people-flag {
  border: var(--jc-shape-border-width) solid color-mix(in srgb, var(--jc-color-on-scrim) 45%, transparent);
}
${selector} .jc-anime-filler-marker {
  inset-block-start: 0.4rem !important;
  inset-inline-end: 0.4rem !important;
  inset-inline-start: auto !important;
  max-inline-size: calc(100% - 0.8rem);
  min-block-size: 1.75rem;
  overflow: hidden;
  border: var(--jc-shape-border-width) solid var(--jc-color-negative);
  border-radius: var(--jc-shape-control-radius) !important;
  background: color-mix(in srgb, var(--jc-color-negative) 88%, var(--jc-color-scrim)) !important;
  color: var(--jc-color-on-negative) !important;
  text-overflow: ellipsis;
  white-space: nowrap;
}
${selector} .card:has(.jc-hide-btn):has(.jc-anime-filler-marker) .jc-anime-filler-marker {
  max-inline-size: calc(100% - 4rem) !important;
}
${selector} .mediaInfoOfficialRating[data-jc-colored-rating="true"] {
  border-color: var(--jc-color-control-border) !important;
  border-radius: var(--jc-shape-control-radius) !important;
  box-shadow: none !important;
}
${selector}[data-jc-theme-pointer="coarse"] .mediaInfoOfficialRating[data-jc-colored-rating="true"]:hover {
  transform: none !important;
}
${selector}[data-jc-theme-breakpoint="phone"] .jc-tag-host > .jc-tag-lane[data-jc-tag-position] {
  gap: 2px;
  max-inline-size: calc(100% - 0.5rem);
  max-block-size: calc(100% - 0.5rem);
}
${selector}[data-jc-theme-breakpoint="phone"] .jc-tag-host > .jc-tag-lane[data-jc-tag-position^="top-"] { inset-block-start: 0.25rem; }
${selector}[data-jc-theme-breakpoint="phone"] .jc-tag-host > .jc-tag-lane[data-jc-tag-position^="bottom-"] { inset-block-end: 0.25rem; }
${selector}[data-jc-theme-breakpoint="phone"] .jc-tag-host > .jc-tag-lane[data-jc-tag-position$="-left"] { inset-inline-start: 0.25rem; }
${selector}[data-jc-theme-breakpoint="phone"] .jc-tag-host > .jc-tag-lane[data-jc-tag-position$="-right"] { inset-inline-end: 0.25rem; }
${selector}[data-jc-theme-breakpoint="phone"] :where(.quality-overlay-label, .rating-tag, .jc-userreview-tag) {
  max-inline-size: min(7.5rem, 62vw);
  font-size: clamp(0.6rem, 2.8vw, 0.72rem) !important;
}
`;
}

function transientUi(selector: string): string {
    return `
/* Adapter canopy-transient-ui-v1: notifications, home actions and owned overlays. */
${selector} :where(.jellyfin-canopy-toast, .jc-undo-toast, #jellyfin-release-notes-notification) {
  box-sizing: border-box;
  right: auto !important;
  left: auto !important;
  inset-inline-start: auto !important;
  inset-inline-end: max(var(--jc-page-gutter), var(--jc-safe-area-right)) !important;
  inset-block-end: max(var(--jc-page-gutter), var(--jc-safe-area-bottom)) !important;
  max-inline-size: min(26rem, calc(100vw - var(--jc-safe-area-left) - var(--jc-safe-area-right) - var(--jc-page-gutter) - var(--jc-page-gutter))) !important;
  border: var(--jc-shape-border-width) solid var(--jc-color-divider) !important;
  border-radius: var(--jc-shape-dialog-radius) !important;
  background: var(--jc-color-elevated) !important;
  box-shadow: var(--jc-elevation-dialog-shadow) !important;
  color: var(--jc-color-text) !important;
  text-shadow: none !important;
  overflow-wrap: anywhere;
}
${selector} #jellyfin-release-notes-notification {
  inset-block-start: 50% !important;
  inset-block-end: auto !important;
}
${selector}[dir="rtl"] .jc-undo-toast:not(.jc-visible) {
  transform: translateX(-100%);
}
${selector}[dir="rtl"] .jellyfin-canopy-toast[data-jc-theme-visibility="hidden"] {
  transform: translateX(-100%) !important;
}
${selector}[dir="rtl"] #jellyfin-release-notes-notification[data-jc-theme-visibility="hidden"] {
  transform: translateY(-50%) translateX(-100%) !important;
}
${selector}[dir="rtl"] :where(.jellyfin-canopy-toast, .jc-undo-toast, #jellyfin-release-notes-notification) {
  inset-inline-end: max(var(--jc-page-gutter), var(--jc-safe-area-left)) !important;
}
${selector}[dir="rtl"] .jellyfin-canopy-toast[data-jc-theme-visibility="visible"] {
  transform: translateX(0) !important;
}
${selector}[dir="rtl"] #jellyfin-release-notes-notification[data-jc-theme-visibility="visible"] {
  transform: translateY(-50%) translateX(0) !important;
}
${selector}[dir="rtl"] .jc-undo-toast.jc-visible {
  transform: translateX(0);
}
${selector} .jc-undo-btn {
  min-inline-size: max(2.75rem, 44px);
  min-block-size: max(2.75rem, 44px);
  border-color: var(--jc-color-control-border) !important;
  border-radius: var(--jc-shape-control-radius) !important;
  background: color-mix(in srgb, var(--jc-color-primary) 18%, transparent) !important;
  color: var(--jc-color-text) !important;
}
${selector} .jc-remove-confirm-overlay {
  background: color-mix(in srgb, var(--jc-color-scrim) 88%, transparent) !important;
}
${selector} [data-jc-theme-component="destructive-confirmation"] {
  box-sizing: border-box;
  max-inline-size: min(32rem, 100%) !important;
  border: var(--jc-shape-border-width) solid var(--jc-color-divider) !important;
  border-radius: var(--jc-shape-dialog-radius) !important;
  background: var(--jc-color-surface) !important;
  box-shadow: var(--jc-elevation-dialog-shadow) !important;
  color: var(--jc-color-text) !important;
}
${selector} .jc-remove-confirm-title {
  color: var(--jc-color-text) !important;
  overflow-wrap: anywhere;
}
${selector} :where(
  .jc-undo-btn,
  #jellyfin-release-notes-notification button,
  .actionSheetMenuItem[data-id="remove-continue-watching"],
  .actionSheetMenuItem[data-id="jc-multiselect-remove"]
):focus-visible {
  outline: var(--jc-elevation-focus-ring) solid var(--jc-color-focus) !important;
  outline-offset: 2px;
}
${selector} :where(
  .actionSheetMenuItem[data-id="remove-continue-watching"],
  .actionSheetMenuItem[data-id="jc-multiselect-remove"]
):disabled {
  color: var(--jc-color-disabled) !important;
  cursor: progress;
}
${selector}[data-jc-theme-breakpoint="phone"] :where(.jellyfin-canopy-toast, .jc-undo-toast, #jellyfin-release-notes-notification) {
  inset-inline-start: max(var(--jc-control-gap), var(--jc-safe-area-left)) !important;
  inset-inline-end: max(var(--jc-control-gap), var(--jc-safe-area-right)) !important;
  inline-size: auto !important;
  max-inline-size: none !important;
}
${selector}[dir="rtl"][data-jc-theme-breakpoint="phone"] :where(.jellyfin-canopy-toast, .jc-undo-toast, #jellyfin-release-notes-notification) {
  inset-inline-start: max(var(--jc-control-gap), var(--jc-safe-area-right)) !important;
  inset-inline-end: max(var(--jc-control-gap), var(--jc-safe-area-left)) !important;
}
`;
}

/** Serialize bounded adapters only for supported modern browser breakpoints. */
export function serializeCanopySurfaceAdapters(rootSelector: string): string {
    const selector = `${rootSelector}[data-jc-theme-route]`
        + ':not([data-jc-theme-route="dashboard"])'
        + ':is('
        + '[data-jc-theme-breakpoint="phone"],'
        + '[data-jc-theme-breakpoint="desktop"],'
        + '[data-jc-theme-breakpoint="wide"]'
        + ')';
    const solidSurfaces = `:where(
  #jellyfin-canopy-panel,
  #jellyfin-canopy-panel-backdrop,
  .jc-spoiler-confirm-overlay,
  .jc-spoiler-confirm-dialog,
  .jc-hide-confirm-overlay,
  .jc-hide-confirm-dialog,
  .jc-hidden-management-overlay,
  .jc-hidden-management-panel,
  .jellyfin-canopy-toast,
  .jc-undo-toast,
  #jellyfin-release-notes-notification
)`;
    return [
        shell(selector),
        protection(selector),
        cardOverlays(selector),
        transientUi(selector),
        `
${selector}[data-jc-theme-transparency="reduced"] ${solidSurfaces},
${selector}[data-jc-theme-effects-level="minimal"] ${solidSurfaces} {
  -webkit-backdrop-filter: none !important;
  backdrop-filter: none !important;
  background-image: none !important;
  box-shadow: none !important;
}
@media (forced-colors: active) {
  ${selector} :where(
    #jellyfin-canopy-panel,
    .jc-spoiler-confirm-dialog,
    .jc-hide-confirm-dialog,
    .jc-hidden-management-panel,
    .jc-hidden-item-card,
    .jc-hidden-group-card,
    .genre-tag,
    .quality-overlay-label,
    .rating-tag,
    .jc-anime-filler-marker,
    .jellyfin-canopy-toast,
    .jc-undo-toast,
    #jellyfin-release-notes-notification
  ) {
    border: 1px solid CanvasText !important;
    background: Canvas !important;
    box-shadow: none !important;
    color: CanvasText !important;
    forced-color-adjust: auto;
  }
}
@media (orientation: landscape) and (max-height: 599px) {
  ${selector}[data-jc-theme-breakpoint="phone"] #jellyfin-canopy-panel .jc-panel-header {
    padding-block: calc(var(--jc-control-gap) / 2) !important;
  }
  ${selector}[data-jc-theme-breakpoint="phone"] :where(.jc-spoiler-confirm-dialog, .jc-hide-confirm-dialog) {
    max-block-size: calc(var(--jc-visual-viewport-height) - var(--jc-control-gap) - var(--jc-control-gap));
  }
}`,
    ].join('\n');
}
