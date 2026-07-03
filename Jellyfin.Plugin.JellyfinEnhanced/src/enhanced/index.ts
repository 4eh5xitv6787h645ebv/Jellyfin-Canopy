// src/enhanced/index.ts — area barrel: imports this area's converted modules in
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
import './features-random-button';
import './features-details-media-info';
import './features-release-dates';
import './features-details-page';
import './features-remove-home';
import './features-remove-multiselect';
import './events';
import './playback';
// hidden-content modules — order matters: -data owns the store + lookup sets the
// later files import; -init exposes the frozen JE.initializeHiddenContent /
// JE.hiddenContent surface last.
import './hidden-content-data';
import './hidden-content-save';
import './hidden-content-styles';
import './hidden-content-dialogs';
import './hidden-content-panel';
import './hidden-content-filter';
import './hidden-content-buttons';
import './hidden-content-init';
import './subtitles';
import './themer';
