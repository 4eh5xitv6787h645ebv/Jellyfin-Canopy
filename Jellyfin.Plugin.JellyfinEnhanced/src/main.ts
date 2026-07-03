// src/main.ts
//
// Bundle entry point for the TypeScript module tree.
//
// js/plugin.js (the loader, served at /JellyfinEnhanced/script) creates the
// window.JellyfinEnhanced namespace, fetches config/user settings, then loads
// the single client bundle built from this file. Execution order inside the
// bundle is defined by the imports below — real dependency edges, not a
// hand-maintained array.
//
// Import order mirrors the former js/core section of allComponentScripts:
// navigation owns SPA nav detection, lifecycle/api-client build on it,
// tag-renderer-base builds on ui-kit. Where a module genuinely depends on
// another it also imports it directly, so this list is belt-and-braces
// ordering, not the only thing keeping the graph correct.
//
// The NOT-yet-converted legacy modules (js/**, classic IIFEs over the global)
// are appended after this entry by scripts/build-bundle.js, which parses the
// remaining allComponentScripts array out of js/plugin.js — so the bundle
// still ships every component in exactly the load order the loader used to
// enforce with per-file <script> tags. As files convert to src/, they move
// from that array into imports here.

import './core/navigation';
import './core/lifecycle';
import './core/dom-observer';
import './core/ui-kit';
import './core/api-client';
import './core/tag-renderer-base';
