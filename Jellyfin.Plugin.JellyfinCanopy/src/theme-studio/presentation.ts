/**
 * Bounded Jellyfin 12 presentation adapters owned by Theme Studio issue #388.
 *
 * These modules target only the modern MUI layout and its stable host roles.
 * They never inject, remove, move,
 * or reorder host DOM, so navigation destinations, media data, source order,
 * focus order, and application behavior remain Jellyfin-owned.
 */

export interface ThemePresentationModule {
    readonly id: string;
    readonly outcome: string;
    readonly tokens: readonly string[];
    readonly modernRoles: readonly string[];
}

/** Machine-readable surface matrix kept beside the adapters it guards. */
export const THEME_PRESENTATION_MODULES: readonly ThemePresentationModule[] = Object.freeze([
    {
        id: 'shell-navigation-v12',
        outcome: 'Header, drawer, pill, bottom navigation and page spacing',
        tokens: ['layout.navigation', 'layout.density', 'space.*', 'type.*', 'shape.*', 'elevation.*'],
        modernRoles: ['.MuiAppBar-root', '.MuiToolbar-root', '.MuiDrawer-paper', '.MuiButton-root', '.padded-left', '.padded-right'],
    },
    {
        id: 'home-hero-v12',
        outcome: 'Off, compact and cinematic first-row home presentation',
        tokens: ['layout.home-hero', 'space.*', 'elevation.card-shadow'],
        modernRoles: ['#indexPage .homeSectionsContainer', '.section0', '.card'],
    },
    {
        id: 'media-cards-v12',
        outcome: 'Rows, grids, card ratios, long text, actions and missing artwork',
        tokens: ['layout.poster-ratio', 'layout.card-actions', 'shape.card-radius', 'motion.hover-lift'],
        modernRoles: ['.itemsContainer', '.card', '.cardBox', '.cardImageContainer'],
    },
    {
        id: 'details-cast-v12',
        outcome: 'Classic, compact and cinematic details plus metadata and cast',
        tokens: ['layout.details', 'layout.cast-shape', 'type.max-reading-width', 'space.*'],
        modernRoles: ['.itemDetailPage', '.mainDetailButtons', '.itemBackdrop', '.detailRibbon', '#castCollapsible'],
    },
    {
        id: 'seasons-v12',
        outcome: 'Responsive season and episode list/grid presentation',
        tokens: ['layout.seasons', 'layout.poster-ratio', 'space.card-gap'],
        modernRoles: ['#childrenCollapsible', '#listChildrenCollapsible', '.itemsContainer', '.card'],
    },
    {
        id: 'progress-indicators-v12',
        outcome: 'Bottom, overlay and floating progress plus watched states',
        tokens: ['progress.position', 'progress.thickness', 'progress.watched-indicator', 'progress.unwatched-indicator'],
        modernRoles: ['.itemProgressBar', '.playedIndicator', '.countIndicator'],
    },
    {
        id: 'dialogs-forms-v12',
        outcome: 'Dialog, form, loading, empty and error presentation',
        tokens: ['shape.control-radius', 'shape.dialog-radius', 'elevation.dialog-shadow', 'space.control-gap'],
        modernRoles: ['.MuiDialog-paper', '.MuiInputBase-root', '.MuiButton-root', '.MuiAlert-root', '.dialog', '.formDialog'],
    },
]);

function shellNavigation(selector: string): string {
    return `
/* Adapter shell-navigation-v12: semantic shell, navigation and logical page spacing. */
${selector} body {
  background-color: var(--jc-color-canvas);
  color: var(--jc-color-text);
  font-family: var(--jc-type-family-ui);
  font-size: var(--jc-effective-font-size);
  line-height: var(--jc-type-line-height);
  letter-spacing: var(--jc-type-tracking);
}
${selector} :where(.material-icons, .material-icons-round, .MuiSvgIcon-root) {
  letter-spacing: normal;
}
${selector} :where(.sectionTitle, .itemName, .parentName, .pageTitle) {
  font-family: var(--jc-type-family-display);
  overflow-wrap: anywhere;
  text-wrap: pretty;
}
${selector} :where(.padded-left) {
  padding-inline-start: max(var(--jc-page-gutter), var(--jc-safe-area-left)) !important;
}
${selector} :where(.padded-right) {
  padding-inline-end: max(var(--jc-page-gutter), var(--jc-safe-area-right)) !important;
}
${selector} :where(.verticalSection, .detailVerticalSection) {
  margin-block-end: var(--jc-section-gap);
}
${selector} :where(#indexPage .homeSectionsContainer, .itemDetailPage .detailPageWrapperContainer) {
  inline-size: min(100%, var(--jc-content-max-inline-size));
  margin-inline: auto;
}
${selector} .MuiAppBar-root {
  background-color: var(--jc-color-surface);
  border-block-end: var(--jc-shape-border-width) solid var(--jc-color-divider);
  box-shadow: var(--jc-elevation-surface-shadow);
  color: var(--jc-color-text);
}
${selector} .MuiDrawer-paper {
  background-color: var(--jc-color-surface);
  border-inline-end: var(--jc-shape-border-width) solid var(--jc-color-divider);
  color: var(--jc-color-text);
}
${selector} .MuiDrawer-paper {
  padding-block-end: max(4.5rem, calc(3.5rem + var(--jc-safe-area-bottom)));
}
${selector}[data-jc-theme-navigation="sidebar"] .MuiDrawer-paper {
  inline-size: clamp(15rem, 28vw, 20rem) !important;
  box-shadow: var(--jc-elevation-surface-shadow);
}
${selector}[data-jc-theme-navigation="sidebar"] .MuiListItemButton-root {
  min-block-size: max(2.75rem, 44px);
  border-radius: var(--jc-shape-control-radius) !important;
  margin: 0.2rem var(--jc-control-gap) !important;
  padding-inline: var(--jc-control-gap) !important;
}
${selector}[data-jc-theme-navigation="pills"] .MuiToolbar-root > .MuiStack-root > .MuiButtonBase-root {
  min-block-size: max(2.75rem, 44px);
  border: var(--jc-shape-border-width) solid transparent;
  border-radius: 999px !important;
  padding-inline: max(0.75rem, var(--jc-control-gap)) !important;
}
${selector}[data-jc-theme-navigation="pills"] .MuiToolbar-root > .MuiStack-root > .MuiButtonBase-root[aria-current="page"] {
  background: rgba(var(--jf-palette-primary-mainChannel) / var(--jf-palette-action-selectedOpacity));
  border-color: var(--jc-color-primary);
  color: var(--jc-color-text);
}
${selector}[data-jc-theme-navigation="bottom"] .MuiAppBar-root {
  position: fixed !important;
  inset-block-start: auto !important;
  inset-block-end: 0 !important;
  padding-block-end: var(--jc-safe-area-bottom);
  border-block-start: var(--jc-shape-border-width) solid var(--jc-color-divider);
  border-block-end: 0;
}
${selector}[data-jc-theme-navigation="bottom"] .MuiAppBar-root + div[aria-hidden="true"] {
  block-size: 0 !important;
}
${selector}[data-jc-theme-navigation="bottom"] .MuiToolbar-root {
  flex-wrap: nowrap !important;
  min-block-size: 3.5rem;
  overflow-x: auto;
  overscroll-behavior-inline: contain;
  scrollbar-width: none;
}
${selector}[data-jc-theme-navigation="bottom"] .MuiToolbar-root::-webkit-scrollbar {
  display: none;
}
${selector}[data-jc-theme-navigation="bottom"] body {
  padding-block-end: max(5rem, calc(4rem + var(--jc-safe-area-bottom)));
}
${selector}[data-jc-theme-navigation="bottom"][data-jc-theme-route="browse"] body {
  padding-block-end: max(8rem, calc(7rem + var(--jc-safe-area-bottom)));
}
${selector}[data-jc-theme-navigation="bottom"] .libraryPage:not(.itemDetailPage) {
  padding-block-start: var(--jc-page-gutter) !important;
}
`;
}

function homeHero(selector: string): string {
    return `
/* Adapter home-hero-v12: reserved first-row compact/cinematic composition. */
${selector}[data-jc-theme-route="home"] #indexPage .homeSectionsContainer > .section0:not(.hide) {
  box-sizing: border-box;
  position: relative;
}
${selector}[data-jc-theme-route="home"][data-jc-theme-home-hero="compact"] #indexPage .section0:not(.hide) .itemsContainer > .card:first-child {
  inline-size: clamp(16rem, 48vw, 36rem) !important;
}
${selector}[data-jc-theme-route="home"][data-jc-theme-home-hero="cinematic"] #indexPage .homeSectionsContainer > .section0:not(.hide) {
  min-block-size: clamp(20rem, 55vh, 42rem);
  padding-block: var(--jc-section-gap);
}
${selector}[data-jc-theme-route="home"][data-jc-theme-home-hero="cinematic"] #indexPage .section0:not(.hide) .itemsContainer {
  align-items: flex-end;
}
${selector}[data-jc-theme-route="home"][data-jc-theme-home-hero="cinematic"] #indexPage .section0:not(.hide) .itemsContainer > .card:first-child {
  inline-size: clamp(20rem, 52vw, 48rem) !important;
}
${selector}[data-jc-theme-route="home"][data-jc-theme-home-hero="cinematic"] #indexPage .section0:not(.hide) .itemsContainer > .card:first-child .cardImageContainer {
  box-shadow: inset 0 -8rem 6rem -4rem var(--jc-color-canvas), var(--jc-elevation-card-shadow);
}
${selector}[data-jc-theme-route="home"][data-jc-theme-home-hero="cinematic"] #indexPage .section0:not(.hide) .itemsContainer > .card:first-child .cardText:not(.cardText-secondary) {
  font-family: var(--jc-type-family-display);
  font-size: clamp(1rem, 2vw, 1.45rem);
  font-weight: 700;
}
`;
}

function mediaCards(selector: string): string {
    return `
/* Adapter media-cards-v12: ratios, density, long labels and reachable actions. */
${selector} :where(.cardBox, .cardScalable, .visualCardBox, .cardImageContainer, .cardContent, .blurhash-canvas) {
  border-radius: var(--jc-shape-card-radius);
}
${selector} .cardBox {
  box-sizing: border-box;
  position: relative;
  margin: calc(var(--jc-card-gap) / 2) !important;
}
${selector} :where(.cardContent-shadow, .visualCardBox, .cardBox:not(.visualCardBox) .cardPadder) {
  box-shadow: var(--jc-elevation-card-shadow);
}
${selector} :where(.defaultCardBackground, .cardBox:not(.visualCardBox) .cardPadder) {
  background-color: var(--jc-color-elevated);
  color: var(--jc-color-text-muted);
}
${selector} .cardFooter {
  box-sizing: border-box;
  min-block-size: 3.25em;
  padding: 0.35em 0.3em 0.5em;
}
${selector} .cardFooter .cardText:not(.cardText-secondary) {
  display: -webkit-box;
  min-block-size: calc(2em * var(--jc-type-line-height));
  overflow: hidden;
  overflow-wrap: anywhere;
  text-overflow: ellipsis;
  white-space: normal;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
${selector}[data-jc-theme-poster-ratio="poster"] .cardScalable > [class*="cardPadder-"] {
  padding-block-end: 150% !important;
}
${selector}[data-jc-theme-poster-ratio="square"] .cardScalable > [class*="cardPadder-"] {
  padding-block-end: 100% !important;
}
${selector}[data-jc-theme-poster-ratio="backdrop"] .cardScalable > [class*="cardPadder-"] {
  padding-block-end: 56.25% !important;
}
${selector}[data-jc-theme-poster-ratio="poster"] .vertical-wrap > .card,
${selector}[data-jc-theme-poster-ratio="square"] .vertical-wrap > .card {
  inline-size: clamp(8rem, 14vw, 13rem) !important;
}
${selector}[data-jc-theme-poster-ratio="backdrop"] .vertical-wrap > .card {
  inline-size: clamp(14rem, 22vw, 24rem) !important;
}
${selector}[data-jc-theme-poster-ratio="poster"] .scrollSlider > .card,
${selector}[data-jc-theme-poster-ratio="square"] .scrollSlider > .card {
  inline-size: clamp(8rem, 20vw, 14rem) !important;
}
${selector}[data-jc-theme-poster-ratio="backdrop"] .scrollSlider > .card {
  inline-size: clamp(16rem, 40vw, 30rem) !important;
}
${selector}[data-jc-theme-hover="hover"][data-jc-theme-motion="full"] .card-hoverable:hover > .cardBox,
${selector}[data-jc-theme-hover="hover"][data-jc-theme-motion="full"] .card-hoverable:focus-within > .cardBox {
  transform: translateY(calc(0px - var(--jc-motion-hover-lift)));
  transition: transform var(--jc-motion-duration) var(--jc-motion-easing);
}
${selector}[data-jc-theme-card-actions="always"] :where(.cardOverlayContainer, .cardOverlayButton-hover) {
  opacity: 1;
}
${selector}[data-jc-theme-card-actions="menu"] .cardOverlayButton-hover {
  opacity: 0;
}
${selector}[data-jc-theme-card-actions="menu"] .card:focus-within .cardOverlayButton-hover,
${selector}[data-jc-theme-card-actions="menu"] .card:hover .cardOverlayButton-hover,
${selector}[data-jc-theme-card-actions="menu"] .btnCardOptions {
  opacity: 1;
}
${selector}[data-jc-theme-pointer="coarse"] :where(.cardOverlayButton, .btnCardOptions, .emby-scrollbuttons-button) {
  min-inline-size: max(2.75rem, 44px);
  min-block-size: max(2.75rem, 44px);
}
${selector} .card:focus-visible > .cardBox,
${selector} .card.show-focus:focus > .cardBox {
  box-shadow: 0 0 0 var(--jc-elevation-focus-ring) var(--jc-color-focus);
}
`;
}

function detailsCast(selector: string): string {
    return `
/* Adapter details-cast-v12: responsive details, metadata and cast roles. */
${selector}[data-jc-theme-route="details"] :where(.itemName, .parentName) {
  max-inline-size: 100%;
  overflow: visible;
  overflow-wrap: anywhere;
  text-overflow: clip;
  white-space: normal;
}
${selector}[data-jc-theme-route="details"] .itemMiscInfo {
  display: flex;
  flex-wrap: wrap;
  gap: calc(var(--jc-control-gap) / 2) var(--jc-control-gap);
  overflow: visible;
}
${selector}[data-jc-theme-route="details"] :where(.itemOverview, .overview) {
  max-inline-size: var(--jc-type-max-reading-width);
  font-family: var(--jc-type-family-reading);
  line-height: var(--jc-type-line-height);
  overflow-wrap: anywhere;
}
${selector}[data-jc-theme-route="details"] .mainDetailButtons {
  display: flex;
  flex-wrap: wrap;
  gap: calc(var(--jc-control-gap) / 2);
}
${selector}[data-jc-theme-route="details"] .detailButton {
  min-inline-size: max(2.75rem, 44px);
  min-block-size: max(2.75rem, 44px);
  border-radius: var(--jc-shape-control-radius) !important;
}
${selector}[data-jc-theme-route="details"][data-jc-theme-details="compact"] .itemBackdrop {
  block-size: clamp(12rem, 32vh, 24rem);
}
${selector}[data-jc-theme-route="details"][data-jc-theme-details="compact"] :where(.detailPagePrimaryContent, .detailPageSecondaryContainer) {
  padding-block-start: calc(var(--jc-section-gap) / 2);
}
${selector}[data-jc-theme-route="details"][data-jc-theme-details="compact"] .mainDetailButtons {
  margin-block: calc(var(--jc-section-gap) / 2);
}
${selector}[data-jc-theme-route="details"][data-jc-theme-details="cinematic"] .itemBackdrop {
  block-size: clamp(22rem, 62vh, 48rem);
  background-position: center 28%;
  box-shadow: inset 0 -15rem 10rem -7rem var(--jc-color-canvas);
}
${selector}[data-jc-theme-route="details"][data-jc-theme-details="cinematic"] .detailPageWrapperContainer {
  max-inline-size: none;
}
${selector}[data-jc-theme-route="details"][data-jc-theme-details="cinematic"] :where(.detailRibbon, .detailPagePrimaryContent, .detailPageSecondaryContainer) {
  padding-inline: max(var(--jc-page-gutter), 3.3%);
}
${selector}[data-jc-theme-route="details"][data-jc-theme-details="cinematic"] .detailRibbon {
  gap: var(--jc-control-gap);
}
${selector}[data-jc-theme-route="details"][data-jc-theme-breakpoint="phone"][data-jc-theme-details="cinematic"] .itemBackdrop {
  block-size: clamp(18rem, 54vh, 30rem);
}
${selector}[data-jc-theme-cast-shape] #castCollapsible .cardScalable > [class*="cardPadder-"] {
  padding-block-end: 100% !important;
}
${selector}[data-jc-theme-cast-shape] #castCollapsible .itemsContainer > .card {
  inline-size: clamp(6.75rem, 11vw, 9.5rem) !important;
}
${selector}[data-jc-theme-cast-shape="circle"] #castCollapsible :where(.cardImageContainer, .cardContent, .blurhash-canvas) {
  border-radius: 50%;
}
${selector}[data-jc-theme-cast-shape="rounded"] #castCollapsible :where(.cardImageContainer, .cardContent, .blurhash-canvas) {
  border-radius: var(--jc-shape-card-radius);
}
${selector}[data-jc-theme-cast-shape="square"] #castCollapsible :where(.cardImageContainer, .cardContent, .blurhash-canvas) {
  border-radius: 0;
}
`;
}

function seasons(selector: string): string {
    return `
/* Adapter seasons-v12: one source/focus order rendered as list or grid. */
${selector}[data-jc-theme-route="details"][data-jc-theme-seasons="grid"] :where(#childrenCollapsible, #listChildrenCollapsible) .itemsContainer {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(12rem, 100%), 1fr));
  gap: var(--jc-card-gap);
}
${selector}[data-jc-theme-route="details"][data-jc-theme-seasons="grid"] :where(#childrenCollapsible, #listChildrenCollapsible) .itemsContainer > .card {
  inline-size: auto !important;
  min-inline-size: 0;
}
${selector}[data-jc-theme-route="details"][data-jc-theme-seasons="list"] :where(#childrenCollapsible, #listChildrenCollapsible) .itemsContainer {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--jc-card-gap);
}
${selector}[data-jc-theme-route="details"][data-jc-theme-seasons="list"] :where(#childrenCollapsible, #listChildrenCollapsible) .itemsContainer > .card {
  inline-size: 100% !important;
  min-inline-size: 0;
}
${selector}[data-jc-theme-route="details"][data-jc-theme-seasons="list"] :where(#childrenCollapsible, #listChildrenCollapsible) .cardBox {
  display: grid;
  grid-template-columns: clamp(7.5rem, 24vw, 13rem) minmax(0, 1fr);
  align-items: center;
  gap: var(--jc-control-gap);
  min-inline-size: 0;
  margin-block: 0 !important;
}
${selector}[data-jc-theme-route="details"][data-jc-theme-seasons="list"] :where(#childrenCollapsible, #listChildrenCollapsible) .cardScalable {
  grid-column: 1;
  min-inline-size: 0;
}
${selector}[data-jc-theme-route="details"][data-jc-theme-seasons="list"] :where(#childrenCollapsible, #listChildrenCollapsible) .cardScalable > [class*="cardPadder-"] {
  padding-block-end: 56.25% !important;
}
${selector}[data-jc-theme-route="details"][data-jc-theme-seasons="list"] :where(#childrenCollapsible, #listChildrenCollapsible) .cardFooter {
  grid-column: 2;
  min-inline-size: 0;
  min-block-size: 0;
}
`;
}

function progressIndicators(selector: string): string {
    return `
/* Adapter progress-indicators-v12: bounded progress and non-color state cues. */
${selector} .itemProgressBar {
  block-size: var(--jc-progress-thickness);
  overflow: hidden;
  border-radius: 999px;
}
${selector}[data-jc-theme-progress-position="overlay"] .card .itemProgressBar {
  position: absolute;
  inset-inline: 0;
  inset-block-end: 0;
  z-index: 2;
}
${selector}[data-jc-theme-progress-position="floating"] .card .itemProgressBar {
  position: absolute;
  inset-inline: 0.5rem;
  inset-block-end: 0.5rem;
  z-index: 2;
  box-shadow: 0 0.15rem 0.45rem rgb(0 0 0 / 0.45);
}
${selector}[data-jc-theme-watched-indicator="none"] .playedIndicator,
${selector}[data-jc-theme-unwatched-indicator="none"] .countIndicator {
  display: none;
}
${selector}[data-jc-theme-watched-indicator="corner"] .playedIndicator,
${selector}[data-jc-theme-unwatched-indicator="corner"] .countIndicator {
  border-radius: var(--jc-shape-control-radius);
}
${selector}[data-jc-theme-watched-indicator="floating"] .playedIndicator,
${selector}[data-jc-theme-unwatched-indicator="floating"] .countIndicator {
  border: var(--jc-shape-border-width) solid var(--jc-color-on-primary);
  box-shadow: var(--jc-elevation-card-shadow);
  transform: translateY(0.35rem);
}
${selector}[data-jc-theme-watched-indicator="check"] .playedIndicator {
  border-radius: 50%;
}
${selector} :where(.playedIndicator, .countIndicator, .mediaSourceIndicator) {
  min-inline-size: 2em;
  min-block-size: 2em;
  border: var(--jc-shape-border-width) solid transparent;
}
`;
}

function dialogsForms(selector: string): string {
    return `
/* Adapter dialogs-forms-v12: bounded dialogs, controls and state presentation. */
${selector} :where(.dialog, .formDialog, .MuiDialog-paper, [role="dialog"]) {
  box-sizing: border-box;
  max-inline-size: min(42rem, calc(100vw - var(--jc-page-gutter) - var(--jc-page-gutter)));
  max-block-size: calc(100dvh - var(--jc-safe-area-top) - var(--jc-safe-area-bottom) - var(--jc-page-gutter) - var(--jc-page-gutter));
  border: var(--jc-shape-border-width) solid var(--jc-color-divider);
  border-radius: var(--jc-shape-dialog-radius) !important;
  background-color: var(--jc-color-surface);
  box-shadow: var(--jc-elevation-dialog-shadow);
  color: var(--jc-color-text);
}
${selector} :where(.formDialogHeader, .formDialogFooter, .MuiDialogTitle-root, .MuiDialogActions-root) {
  box-sizing: border-box;
  padding: var(--jc-control-gap);
  background-color: var(--jc-color-surface);
}
${selector} .formDialogFooter {
  padding-block-end: max(var(--jc-control-gap), var(--jc-safe-area-bottom));
}
${selector} :where(.emby-input, .emby-select, .emby-textarea, .MuiInputBase-root, .MuiButton-root, .raised, .fab) {
  border-radius: var(--jc-shape-control-radius) !important;
}
${selector} :where(.emby-input, .emby-select, .MuiInputBase-root, .MuiButton-root, .raised, .fab) {
  min-block-size: max(2.75rem, 44px);
}
${selector} :where(.inputContainer, .selectContainer, .textareaContainer, .MuiFormControl-root) {
  margin-block-end: var(--jc-control-gap);
}
${selector} :where(.fieldDescription, .MuiFormHelperText-root) {
  color: var(--jc-color-text-muted);
  overflow-wrap: anywhere;
}
${selector} :where(.fieldDescription.error, .validationError, .errorMessage, .MuiFormHelperText-root.Mui-error) {
  color: var(--jc-color-negative);
}
${selector} :where(.empty, .noItemsMessage, .emptyMessage) {
  box-sizing: border-box;
  min-block-size: 6rem;
  padding: var(--jc-section-gap) var(--jc-page-gutter);
  color: var(--jc-color-text-muted);
  text-align: center;
}
${selector}[data-jc-theme-breakpoint="phone"] :where(.dialog, .formDialog, .MuiDialog-paper, [role="dialog"]) {
  inline-size: calc(100vw - var(--jc-page-gutter) - var(--jc-page-gutter));
  max-inline-size: none;
}
`;
}

/** Serialize all option branches once; root enum attributes select the active branch. */
export function serializePresentationAdapters(rootSelector: string): string {
    const selector = `${rootSelector}[data-jc-theme-route]:not([data-jc-theme-route="dashboard"])`;
    return [
        shellNavigation(selector),
        homeHero(selector),
        mediaCards(selector),
        detailsCast(selector),
        seasons(selector),
        progressIndicators(selector),
        dialogsForms(selector),
        `
@media (forced-colors: active) {
  ${selector} :where(.cardBox, .dialog, .formDialog, .MuiDialog-paper, .MuiDrawer-paper) {
    border: 1px solid CanvasText;
    box-shadow: none;
  }
}`,
    ].join('\n');
}
