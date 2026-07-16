// src/enhanced/index.ts
// their required execution order. Owned by the enhanced conversion wave; main.ts
// imports this barrel once, so conversions never edit main.ts itself.
//
// Order mirrors the former enhanced/ section of allComponentScripts in
// js/plugin.js — modules must keep their relative execution order as they
// convert, because later legacy files still assume everything above them ran.
import './config';
import './helpers';
import './icons';
// Detail-page and home-action families are loader-owned ESM entries.
import './events';
// Playback, subtitles, hidden-content filtering and management are loader-owned ESM entries.
import './themer';
// The lightweight settings launcher is loader owned; the large panel graph is
// a user-gesture dynamic import and remains absent from normal navigation.
// Bookmark playback and management are separate route-owned ESM entries.
