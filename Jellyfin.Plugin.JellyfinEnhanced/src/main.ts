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
// Import order: navigation owns SPA nav detection, lifecycle/api-client build
// on it, tag-renderer-base builds on ui-kit. Where a module genuinely depends
// on another it also imports it directly, so this list is belt-and-braces
// ordering, not the only thing keeping the graph correct.
//
// Every component now lives under src/ — there is no legacy component array
// and nothing is appended to this entry at build time. The whole feature tree
// is reached through the area barrels imported below.

// Frozen public-contract anchor: JEGlobal extends JellyfinEnhancedPublicApi
// (src/facade.ts) — the single typed home for the stable window.JellyfinEnhanced
// surface that user scripts and Configuration/config-page.js depend on.
// Referenced here from the bundle entry so the contract is proven at compile
// time: if a public member is ever removed or renamed, _FrozenPublicApi
// collapses to `never` and this line fails to compile.
import type { JEGlobal } from './types/je';
import type { JellyfinEnhancedPublicApi } from './facade';
type _FrozenPublicApi = JEGlobal extends JellyfinEnhancedPublicApi ? true : never;
const _jePublicApiIsFrozen: _FrozenPublicApi = true;
void _jePublicApiIsFrozen;

import './core/navigation';
import './core/lifecycle';
import './core/dom-observer';
import './core/ui-kit';
import './core/api-client';
import './core/tag-renderer-base';
// live builds on navigation + lifecycle (nav-surviving SDK subscription) and,
// for config hot-reload, on api-client — so it imports after them. live-config
// registers the config-changed reaction on the hub.
import './core/live';
import './core/live-config';
import './core/live-rows';
import './core/live-update';

// Area barrels — each imports that area's converted modules in execution
// order. Areas own their own ordering without touching this file: main.ts
// imports each barrel once.
import './enhanced/index';
import './jellyseerr/index';
import './arr/index';
import './tags/index';
import './elsewhere/index';
import './extras/index';
import './others/index';
