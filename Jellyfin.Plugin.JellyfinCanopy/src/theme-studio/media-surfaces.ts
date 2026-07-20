/**
 * Media-specialized presentation adapters for supported modern browsers.
 *
 * Every selector is breakpoint- and route-gated by the Theme Studio runtime.
 * The adapters style stable Jellyfin 12 or Canopy-owned roles only; playback
 * state, media elements, DOM order, focus order, and navigation stay host-owned.
 */

export interface ThemeMediaSurfaceModule {
    readonly id: string;
    readonly outcome: string;
    readonly tokens: readonly string[];
    readonly modernRoles: readonly string[];
}

/** Machine-readable media surface matrix kept beside its bounded adapters. */
export const THEME_MEDIA_SURFACE_MODULES: readonly ThemeMediaSurfaceModule[] = Object.freeze([
    {
        id: 'player-media-v12',
        outcome: 'Video OSD, captions, Trickplay and Canopy playback enhancements',
        tokens: [
            'player.osd-density',
            'player.control-material',
            'player.pause-screen-material',
            'player.subtitle-backdrop',
            'player.trickplay-shape',
            'color.*',
            'shape.*',
        ],
        modernRoles: [
            '.videoOsdBottom',
            '.videoSubtitlesInner',
            '.sliderBubble',
            '.chapterThumbContainer',
            '#jc-osd-rating-container',
            '[data-jc-frame-overlay="true"]',
            '.jc-bookmark-marker[data-jc-identity-owned="true"]',
            '#pause-screen-content',
        ],
    },
    {
        id: 'music-now-playing-v12',
        outcome: 'Music now-playing art, metadata, queue, progress and controls',
        tokens: ['color.*', 'space.*', 'shape.*', 'elevation.*', 'type.*'],
        modernRoles: [
            '.nowPlayingPage',
            '.nowPlayingInfoContainer',
            '.nowPlayingPageImage',
            '.nowPlayingPlaylist',
            '.nowPlayingInfoButtons',
            '.nowPlayingPositionSlider',
            '.nowPlayingVolumeSlider',
            '.nowPlayingPage [role="status"]',
        ],
    },
    {
        id: 'live-guide-v12',
        outcome: 'Live guide channels, timeslots, programs and semantic states',
        tokens: ['color.*', 'space.*', 'shape.*', 'elevation.focus-ring'],
        modernRoles: [
            '.tvguide',
            '.channelsContainer',
            '.guide-channelHeaderCell',
            '.programGrid',
            '.programCell',
            '.guideRequiresUnlock',
            '.tvguide .noItemsMessage',
        ],
    },
    {
        id: 'book-reader-v12',
        outcome: 'Book covers, reader chrome, table of contents and reader states',
        tokens: ['color.*', 'space.*', 'shape.*', 'elevation.*', 'type.*'],
        modernRoles: [
            '.booksPage .cardImageContainer',
            '#bookPlayerContainer',
            '#bookPlayer',
            '.bookOsdRow',
            '#dialogToc',
            '#dialogToc a',
            '.bookplayerErrorMsg',
        ],
    },
]);

function playerMedia(selector: string): string {
    return `
/* Adapter player-media-v12: host OSD, captions, Trickplay and Canopy overlays. */
${selector} .videoOsdBottom {
  box-sizing: border-box;
  color: var(--jc-color-text);
  background: linear-gradient(
    0deg,
    color-mix(in srgb, var(--jc-color-canvas) 96%, transparent),
    color-mix(in srgb, var(--jc-color-canvas) 58%, transparent) 58%,
    transparent
  );
}
${selector} .videoOsdBottom :where(.buttons.focuscontainer-x, .osdControls) {
  box-sizing: border-box;
  max-inline-size: min(100%, 90rem);
  margin-inline: auto;
  gap: calc(var(--jc-control-gap) / 2);
}
${selector} .videoOsdBottom :where(button, .emby-button, .paper-icon-button-light) {
  min-inline-size: max(2.75rem, 44px);
  min-block-size: max(2.75rem, 44px);
  border-radius: var(--jc-shape-control-radius);
  color: var(--jc-color-text);
  touch-action: manipulation;
}
${selector} .videoOsdBottom :where(button, .emby-button, .paper-icon-button-light):focus-visible,
${selector} #pause-screen-close-btn:focus-visible,
${selector} .jc-bookmark-marker[data-jc-identity-owned="true"]:focus-visible {
  outline: var(--jc-elevation-focus-ring) solid var(--jc-color-focus);
  outline-offset: 2px;
}
${selector}[data-jc-theme-player-osd-density="compact"] .videoOsdBottom {
  padding-block-start: clamp(3rem, 12vh, 5rem);
  padding-block-end: max(calc(var(--jc-control-gap) / 2), var(--jc-safe-area-bottom));
}
${selector}[data-jc-theme-player-osd-density="compact"] .videoOsdBottom :where(.buttons.focuscontainer-x, .osdControls) {
  gap: 0;
  font-size: 0.9em;
}
${selector}[data-jc-theme-player-osd-density="standard"] .videoOsdBottom {
  padding-block-start: clamp(5rem, 18vh, 8rem);
  padding-block-end: max(var(--jc-control-gap), var(--jc-safe-area-bottom));
}
${selector}[data-jc-theme-player-osd-density="cinematic"] .videoOsdBottom {
  padding-block-start: clamp(7rem, 24vh, 12rem);
  padding-block-end: max(var(--jc-section-gap), var(--jc-safe-area-bottom));
}
${selector}[data-jc-theme-player-osd-density="cinematic"] .videoOsdBottom :where(.buttons.focuscontainer-x, .osdControls) {
  gap: var(--jc-control-gap);
}
${selector}[data-jc-theme-player-control-material="solid"] :where(.videoOsdBottom, .sliderBubble, .chapterThumbContainer) {
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  background-image: none;
  background-color: var(--jc-color-surface);
}
${selector}[data-jc-theme-player-control-material="translucent"] :where(.sliderBubble, .chapterThumbContainer) {
  background-color: color-mix(in srgb, var(--jc-color-surface) 88%, transparent);
}
${selector}[data-jc-theme-player-control-material="glass"] :where(.videoOsdBottom, .sliderBubble, .chapterThumbContainer) {
  background-color: color-mix(in srgb, var(--jc-color-surface) 68%, transparent);
  -webkit-backdrop-filter: blur(var(--jc-effects-blur));
  backdrop-filter: blur(var(--jc-effects-blur));
}
${selector} :where(.sliderBubble, .chapterThumbContainer) {
  overflow: hidden;
  border: var(--jc-shape-border-width) solid var(--jc-color-divider);
  box-shadow: var(--jc-elevation-card-shadow);
  color: var(--jc-color-text);
}
${selector}[data-jc-theme-player-trickplay-shape="square"] :where(.sliderBubble, .chapterThumbContainer, .chapterThumb) {
  border-radius: 0;
}
${selector}[data-jc-theme-player-trickplay-shape="rounded"] :where(.sliderBubble, .chapterThumbContainer, .chapterThumb) {
  border-radius: var(--jc-shape-card-radius);
}
${selector}[data-jc-theme-player-trickplay-shape="pill"] :where(.sliderBubble, .chapterThumbContainer, .chapterThumb) {
  border-radius: 999px;
}
${selector} .videoSubtitlesInner {
  color: var(--jc-color-text);
  border-radius: var(--jc-shape-control-radius);
  overflow-wrap: anywhere;
  text-wrap: balance;
}
${selector}[data-jc-theme-player-subtitle-backdrop="none"] .videoSubtitlesInner {
  background: transparent;
  box-shadow: none;
  text-shadow: none;
}
${selector}[data-jc-theme-player-subtitle-backdrop="shadow"] .videoSubtitlesInner {
  background: transparent;
  text-shadow: 0 0.1em 0.2em var(--jc-color-canvas), 0 0 0.45em var(--jc-color-canvas);
}
${selector}[data-jc-theme-player-subtitle-backdrop="solid"] .videoSubtitlesInner {
  padding: 0.08em 0.3em;
  background: var(--jc-color-canvas);
  text-shadow: none;
}
${selector}[data-jc-theme-player-subtitle-backdrop="box"] .videoSubtitlesInner {
  padding: 0.08em 0.3em;
  border: var(--jc-shape-border-width) solid var(--jc-color-divider);
  background: color-mix(in srgb, var(--jc-color-canvas) 84%, transparent);
  box-shadow: var(--jc-elevation-surface-shadow);
  text-shadow: none;
}
${selector} #jc-osd-rating-container {
  flex-wrap: wrap;
  max-inline-size: 100%;
  color: var(--jc-color-text);
}
${selector} #jc-osd-rating-container .jc-chip {
  border: var(--jc-shape-border-width) solid currentColor;
  border-radius: var(--jc-shape-control-radius);
  background-color: var(--jc-color-scrim);
  color: var(--jc-color-on-scrim) !important;
}
${selector} #jc-osd-rating-container :where(.jc-chip.tmdb, .jc-chip.critic, .jc-star, .jc-text) {
  color: var(--jc-color-on-scrim) !important;
}
${selector} [data-jc-frame-overlay="true"] {
  max-inline-size: calc(100vw - var(--jc-page-gutter) - var(--jc-page-gutter));
  padding: calc(var(--jc-control-gap) / 2) var(--jc-control-gap) !important;
  border: var(--jc-shape-border-width) solid var(--jc-color-divider);
  border-radius: var(--jc-shape-control-radius) !important;
  background: color-mix(in srgb, var(--jc-color-surface) 92%, transparent) !important;
  box-shadow: var(--jc-elevation-surface-shadow);
  color: var(--jc-color-text) !important;
  font-family: var(--jc-type-family-ui) !important;
  overflow: hidden;
  text-overflow: ellipsis;
}
${selector} .jc-bookmark-marker[data-jc-identity-owned="true"] {
  min-inline-size: max(2.75rem, 44px);
  min-block-size: max(2.75rem, 44px);
  border-radius: 50%;
  touch-action: manipulation;
}
${selector} #pause-screen-content {
  color: var(--jc-color-text);
}
${selector}[data-jc-theme-player-pause-screen-material="solid"] #pause-screen-content {
  background-color: var(--jc-color-surface);
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
}
${selector}[data-jc-theme-player-pause-screen-material="translucent"] #pause-screen-content {
  background-color: color-mix(in srgb, var(--jc-color-canvas) 82%, transparent);
  -webkit-backdrop-filter: brightness(0.58);
  backdrop-filter: brightness(0.58);
}
${selector}[data-jc-theme-player-pause-screen-material="glass"] #pause-screen-content {
  background-color: color-mix(in srgb, var(--jc-color-canvas) 58%, transparent);
  -webkit-backdrop-filter: blur(var(--jc-effects-blur)) brightness(0.58);
  backdrop-filter: blur(var(--jc-effects-blur)) brightness(0.58);
}
${selector} :where(#pause-screen-details, #pause-screen-plot, #pause-screen-progress-meta) {
  color: var(--jc-color-text);
  overflow-wrap: anywhere;
  text-wrap: pretty;
}
${selector} #pause-screen-progress-bar {
  background: color-mix(in srgb, var(--jc-color-text) 18%, transparent);
}
${selector} #pause-screen-progress-bar > span {
  background: var(--jc-color-primary);
}
${selector} #pause-screen-close-btn {
  min-inline-size: max(2.75rem, 44px);
  min-block-size: max(2.75rem, 44px);
  border-color: var(--jc-color-divider);
  background: color-mix(in srgb, var(--jc-color-surface) 82%, transparent);
  color: var(--jc-color-text);
  touch-action: manipulation;
}
`;
}

function musicNowPlaying(selector: string): string {
    return `
/* Adapter music-now-playing-v12: artwork, long metadata, queue and controls. */
${selector} .nowPlayingPage {
  box-sizing: border-box;
  inline-size: min(100%, var(--jc-content-max-inline-size));
  margin-inline: auto;
  color: var(--jc-color-text);
}
${selector} :where(.nowPlayingInfoContainer, .nowPlayingPlaylist) {
  box-sizing: border-box;
  min-inline-size: 0;
  border: var(--jc-shape-border-width) solid var(--jc-color-divider);
  border-radius: var(--jc-shape-card-radius);
  background-color: color-mix(in srgb, var(--jc-color-surface) 92%, transparent);
  box-shadow: var(--jc-elevation-surface-shadow);
}
${selector} .nowPlayingPageImage {
  border-radius: var(--jc-shape-card-radius);
  box-shadow: var(--jc-elevation-card-shadow);
}
${selector} :where(.nowPlayingPageTitle, .nowPlayingAlbum, .nowPlayingArtist, .nowPlayingBarText) {
  max-inline-size: 100%;
  overflow: hidden;
  overflow-wrap: anywhere;
  text-overflow: ellipsis;
}
${selector} :where(.nowPlayingAlbum, .nowPlayingArtist, .nowPlayingTime) {
  color: var(--jc-color-text-muted);
}
${selector} :where(
  .nowPlayingPositionSliderContainer,
  .nowPlayingVolumeSliderContainer,
  .nowPlayingBarPositionContainer,
  .nowPlayingBarVolumeSliderContainer
) {
  min-inline-size: 0;
  color: var(--jc-color-text);
}
${selector} :where(
  .nowPlayingPositionSlider,
  .nowPlayingVolumeSlider,
  .nowPlayingBarPositionSlider,
  .nowPlayingBarVolumeSlider
) {
  max-inline-size: 100%;
  min-block-size: max(2.75rem, 44px);
  accent-color: var(--jc-color-primary);
  touch-action: manipulation;
}
${selector} :where(.nowPlayingInfoButtons, .nowPlayingSecondaryButtons, .nowPlayingBar) button {
  min-inline-size: max(2.75rem, 44px);
  min-block-size: max(2.75rem, 44px);
  border-radius: var(--jc-shape-control-radius);
  touch-action: manipulation;
}
${selector} :where(.nowPlayingInfoButtons, .nowPlayingSecondaryButtons, .nowPlayingBar) button:focus-visible {
  outline: var(--jc-elevation-focus-ring) solid var(--jc-color-focus);
  outline-offset: 2px;
}
${selector} .nowPlayingPlaylist :where(.listItem, .listItem-border) {
  border-color: var(--jc-color-divider);
}
${selector} .nowPlayingPlaylist :where(.listItem[aria-current="true"], .listItem.selected) {
  background-color: color-mix(in srgb, var(--jc-color-primary) 20%, var(--jc-color-surface));
}
${selector} :where(.nowPlayingPage, .tvguide, #bookPlayerContainer) :where(
  [role="status"],
  .noItemsMessage,
  .emptyMessage,
  .errorMessage,
  [role="alert"]
) {
  box-sizing: border-box;
  max-inline-size: min(42rem, calc(100% - var(--jc-page-gutter) - var(--jc-page-gutter)));
  min-block-size: max(2.75rem, 44px);
  padding: var(--jc-control-gap);
  border: var(--jc-shape-border-width) solid var(--jc-color-divider);
  border-radius: var(--jc-shape-control-radius);
  background-color: color-mix(in srgb, var(--jc-color-elevated) 82%, transparent);
  color: var(--jc-color-text-muted);
  overflow-wrap: anywhere;
}
${selector} :where(.nowPlayingPage, .tvguide, #bookPlayerContainer) :where(.errorMessage, [role="alert"]) {
  border-color: var(--jc-color-negative);
  background-color: color-mix(in srgb, var(--jc-color-negative) 14%, var(--jc-color-surface));
  color: var(--jc-color-text);
}
${selector}[data-jc-theme-breakpoint="phone"] :where(.nowPlayingInfoContainer, .nowPlayingPlaylist) {
  inline-size: calc(100% - var(--jc-page-gutter) - var(--jc-page-gutter));
  margin-inline: var(--jc-page-gutter);
}
${selector}[data-jc-theme-breakpoint="phone"] .nowPlayingPageImageContainer {
  max-inline-size: min(78vw, 22rem);
}
${selector}[data-jc-theme-breakpoint="wide"] .nowPlayingPage > .remoteControlContent {
  display: grid;
  grid-template-columns: minmax(22rem, 0.8fr) minmax(32rem, 1.2fr);
  align-items: start;
  gap: var(--jc-section-gap);
  padding-inline: var(--jc-page-gutter) !important;
}
${selector}[data-jc-theme-breakpoint="wide"] .nowPlayingPage > .remoteControlContent > :where(
  .nowPlayingInfoContainer,
  .remoteControlSection
) {
  grid-column: 1;
  min-inline-size: 0;
}
${selector}[data-jc-theme-breakpoint="wide"] .nowPlayingPage > .remoteControlContent > .playlistSection {
  grid-column: 2;
  grid-row: 1 / span 2;
  min-inline-size: 0;
}
`;
}

function liveGuide(selector: string): string {
    return `
/* Adapter live-guide-v12: channels, programs and keyboard/touch state. */
${selector} :where(.tvguide, .tvGuideHeader) {
  box-sizing: border-box;
  inline-size: min(100%, var(--jc-content-max-inline-size));
  margin-inline: auto;
  color: var(--jc-color-text);
}
${selector} :where(.guide-headerTimeslots, .channelsContainer, .programGrid) {
  min-inline-size: 0;
}
${selector} :where(.guide-channelHeaderCell, .guide-channelTimeslotHeader, .programCell, .channelPrograms) {
  border-color: var(--jc-color-divider);
}
${selector} :where(.guide-channelHeaderCell, .guide-channelTimeslotHeader) {
  background-color: var(--jc-color-surface) !important;
  color: var(--jc-color-text);
}
${selector} .programCell {
  background-color: var(--jc-color-canvas);
  color: var(--jc-color-text);
}
${selector} .programCell-active,
${selector} .programCell[aria-current="true"] {
  background-color: color-mix(in srgb, var(--jc-color-primary) 22%, var(--jc-color-surface));
}
${selector} :where(.guide-channelHeaderCell, .programCell):focus-visible,
${selector} :where(.guide-channelHeaderCell, .programCell).show-focus:focus {
  z-index: 2;
  outline: var(--jc-elevation-focus-ring) solid var(--jc-color-focus) !important;
  outline-offset: calc(0px - var(--jc-elevation-focus-ring));
}
${selector} :where(.guideChannelName, .guideChannelNumber, .guideProgramNameText, .guideProgramSecondaryInfo) {
  min-inline-size: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
${selector} .guideProgramIndicator {
  border: var(--jc-shape-border-width) solid var(--jc-color-divider);
  border-radius: var(--jc-shape-control-radius);
  background-color: var(--jc-color-elevated);
  color: var(--jc-color-text);
}
${selector} .newTvProgram {
  background: var(--jc-color-info);
  color: var(--jc-color-on-info);
}
${selector} .liveTvProgram {
  background: var(--jc-color-negative);
  color: var(--jc-color-on-negative);
}
${selector} .premiereTvProgram {
  background: var(--jc-color-caution);
  color: var(--jc-color-on-caution);
}
${selector} .guideRequiresUnlock {
  box-sizing: border-box;
  max-inline-size: min(42rem, calc(100% - var(--jc-page-gutter) - var(--jc-page-gutter)));
  border: var(--jc-shape-border-width) solid var(--jc-color-caution);
  border-radius: var(--jc-shape-card-radius);
  background-color: color-mix(in srgb, var(--jc-color-caution) 14%, var(--jc-color-surface));
  color: var(--jc-color-text);
  overflow-wrap: anywhere;
}
${selector}[data-jc-theme-pointer="coarse"] :where(.guide-channelHeaderCell, .programCell, .guide-date-tab-button) {
  min-block-size: max(2.75rem, 44px);
  touch-action: manipulation;
}
${selector}[data-jc-theme-breakpoint="phone"] :where(.channelsContainer, .guide-channelTimeslotHeader) {
  inline-size: clamp(7rem, 30vw, 10rem);
}
${selector}[data-jc-theme-breakpoint="wide"] :where(.channelsContainer, .guide-channelTimeslotHeader) {
  inline-size: clamp(12rem, 12vw, 18rem);
}
`;
}

function bookReader(selector: string): string {
    return `
/* Adapter book-reader-v12: cover treatment, reader chrome, TOC and states. */
${selector} .booksPage .cardImageContainer {
  border-radius: var(--jc-shape-card-radius);
  box-shadow: var(--jc-elevation-card-shadow);
}
${selector} #bookPlayerContainer {
  box-sizing: border-box;
  max-inline-size: 100%;
  color: var(--jc-color-text);
}
${selector} #bookPlayer {
  background-color: var(--jc-color-canvas);
  color: var(--jc-color-text);
}
${selector} .bookOsdRow {
  box-sizing: border-box;
  min-block-size: max(2.75rem, 44px);
  padding-inline-start: max(var(--jc-control-gap), var(--jc-safe-area-left));
  padding-inline-end: max(var(--jc-control-gap), var(--jc-safe-area-right));
  border-block-color: var(--jc-color-divider);
  background-color: color-mix(in srgb, var(--jc-color-surface) 94%, transparent);
  color: var(--jc-color-text);
}
${selector} .bookOsdTitle {
  min-inline-size: 0;
  overflow: hidden;
  overflow-wrap: anywhere;
  text-overflow: ellipsis;
}
${selector} :where(.bookplayerButton, #dialogToc button, #dialogToc a) {
  display: inline-flex;
  align-items: center;
  min-inline-size: max(2.75rem, 44px);
  min-block-size: max(2.75rem, 44px);
  border-radius: var(--jc-shape-control-radius);
  touch-action: manipulation;
}
${selector} :where(.bookplayerButton, #dialogToc button):focus-visible,
${selector} #dialogToc a:focus-visible {
  outline: var(--jc-elevation-focus-ring) solid var(--jc-color-focus);
  outline-offset: 2px;
}
${selector} #dialogToc {
  box-sizing: border-box;
  max-inline-size: min(44rem, calc(100vw - var(--jc-page-gutter) - var(--jc-page-gutter)));
  max-block-size: calc(100dvh - var(--jc-safe-area-top) - var(--jc-safe-area-bottom) - var(--jc-page-gutter));
  border: var(--jc-shape-border-width) solid var(--jc-color-divider);
  border-radius: var(--jc-shape-dialog-radius);
  background-color: var(--jc-color-surface);
  box-shadow: var(--jc-elevation-dialog-shadow);
  color: var(--jc-color-text);
  overflow: auto;
}
${selector} #dialogToc a {
  max-inline-size: 100%;
  color: var(--jc-color-primary);
  overflow-wrap: anywhere;
}
${selector} #dialogToc .bookplayerButtonIcon {
  color: var(--jc-color-text);
}
${selector} .bookplayerErrorMsg {
  box-sizing: border-box;
  max-inline-size: min(42rem, calc(100% - var(--jc-page-gutter) - var(--jc-page-gutter)));
  margin-inline: auto;
  padding: var(--jc-section-gap) var(--jc-page-gutter);
  border: var(--jc-shape-border-width) solid var(--jc-color-negative);
  border-radius: var(--jc-shape-card-radius);
  background-color: color-mix(in srgb, var(--jc-color-negative) 14%, var(--jc-color-surface));
  color: var(--jc-color-text);
  overflow-wrap: anywhere;
}
${selector}[data-jc-theme-breakpoint="phone"] #dialogToc {
  inline-size: calc(100vw - var(--jc-page-gutter) - var(--jc-page-gutter));
  max-inline-size: none;
}
`;
}

/** Serialize all media option branches once; exact root attributes select them. */
export function serializeMediaSurfaceAdapters(rootSelector: string): string {
    const selector = `${rootSelector}[data-jc-theme-route]`
        + ':not([data-jc-theme-route="dashboard"])'
        + ':is('
        + '[data-jc-theme-breakpoint="phone"],'
        + '[data-jc-theme-breakpoint="desktop"],'
        + '[data-jc-theme-breakpoint="wide"]'
        + ')';
    const solidMaterialSurfaces = `:where(
  .videoOsdBottom,
  .sliderBubble,
  .chapterThumbContainer,
  .videoSubtitlesInner,
  #jc-osd-rating-container .jc-chip,
  [data-jc-frame-overlay="true"],
  #pause-screen-content,
  #pause-screen-close-btn,
  .nowPlayingInfoContainer,
  .nowPlayingPlaylist,
  .nowPlayingPage :where([role="status"], .noItemsMessage, .emptyMessage, .errorMessage, [role="alert"]),
  .tvguide :where([role="status"], .noItemsMessage, .emptyMessage, .errorMessage, [role="alert"]),
  #bookPlayerContainer :where([role="status"], .noItemsMessage, .emptyMessage, .errorMessage, [role="alert"]),
  .bookOsdRow
)`;
    return [
        playerMedia(selector),
        musicNowPlaying(selector),
        liveGuide(selector),
        bookReader(selector),
        `
${selector}[data-jc-theme-transparency="reduced"] ${solidMaterialSurfaces} {
  -webkit-backdrop-filter: none !important;
  backdrop-filter: none !important;
  background-image: none !important;
  background-color: var(--jc-color-surface) !important;
  box-shadow: none !important;
}
${selector}[data-jc-theme-effects-level="minimal"] ${solidMaterialSurfaces} {
  -webkit-backdrop-filter: none !important;
  backdrop-filter: none !important;
  background-image: none !important;
  background-color: var(--jc-color-surface) !important;
  box-shadow: none !important;
}
${selector}[data-jc-theme-transparency="reduced"] #jc-osd-rating-container :where(.jc-chip, .jc-star, .jc-text),
${selector}[data-jc-theme-effects-level="minimal"] #jc-osd-rating-container :where(.jc-chip, .jc-star, .jc-text) {
  color: var(--jc-color-text) !important;
}
@media (orientation: landscape) and (max-height: 599px) {
  ${selector}[data-jc-theme-breakpoint="phone"] .videoOsdBottom {
    padding-block-start: 2.75rem;
    padding-block-end: max(calc(var(--jc-control-gap) / 2), var(--jc-safe-area-bottom));
  }
  ${selector}[data-jc-theme-breakpoint="phone"] :where(.nowPlayingInfoContainer, .nowPlayingPlaylist) {
    max-block-size: calc(var(--jc-visual-viewport-height) - var(--jc-safe-area-top) - var(--jc-safe-area-bottom));
    overflow: auto;
  }
  ${selector}[data-jc-theme-breakpoint="phone"] .bookOsdRow {
    min-block-size: max(2.75rem, 10dvh);
  }
}
@media (forced-colors: active) {
  ${selector} :where(
    .videoOsdBottom,
    .sliderBubble,
    .chapterThumbContainer,
    .nowPlayingInfoContainer,
    .nowPlayingPlaylist,
    .guide-channelHeaderCell,
    .programCell,
    .bookOsdRow,
    #dialogToc
  ) {
    border: 1px solid CanvasText;
    background: Canvas;
    box-shadow: none;
    color: CanvasText;
    forced-color-adjust: auto;
  }
}`,
    ].join('\n');
}
