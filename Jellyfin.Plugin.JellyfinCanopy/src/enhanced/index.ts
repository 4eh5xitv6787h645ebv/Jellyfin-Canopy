// src/enhanced/index.ts
// their required execution order. Owned by the enhanced conversion wave; main.ts
// imports this barrel once, so conversions never edit main.ts itself.
//
// Order mirrors the former enhanced/ section of allComponentScripts in
// js/plugin.js — modules must keep their relative execution order as they
// convert, because later legacy files still assume everything above them ran.
import './config';
import './helpers';
import './native-tabs';
import './tag-pipeline';
import './icons';
// features modules — order matters: -details-media-info and -release-dates
// export the chip renderers that -details-page imports, and -remove-home
// exports the action-sheet/remove helpers that -remove-multiselect imports.
import './features/details-media-info';
import './features/release-dates';
import './features/details-page';
import './features/hide-favorites-tab';
import './events';
import './playback';
// Hidden-content filtering and management are loader-owned ESM entries.
import './subtitles';
import './themer';
// spoiler-guard — loads after tag-pipeline (uses invalidateServerCache) and
// before the settings panel (which wires its per-user override section).
import './spoiler-guard/index';
// ui modules — order matters: -release-notes exports GITHUB_REPO + the release-
// notes panel the template/settings wiring import; ui-panel hosts
// JC.showEnhancedPanel and orchestrates the buildPanelHtml/wire* pieces last.
import './settings-panel/styles';
import './settings-panel/entry-points';
import './settings-panel/release-notes';
import './settings-panel/template';
import './settings-panel/shortcut-editor';
import './settings-panel/settings';
import './settings-panel/hidden-content-tab';
import './settings-panel/language';
import './settings-panel/panel';
import './bookmarks/bookmarks';
// Bookmark playback remains eager; bookmark management is a route-only ESM
// entry and therefore absent from the cold-home graph.
import './osd-rating';
import './pausescreen';
