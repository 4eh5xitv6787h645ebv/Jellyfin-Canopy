// src/globals.ts
//
// The one place src/ modules obtain the shared window.JellyfinCanopy
// namespace. js/plugin.js creates the object (with its bootstrap placeholders)
// BEFORE loading the bundle, so by the time any module in this tree executes
// the global must exist — a missing namespace means the bundle was loaded
// out of order, which we fail on loudly instead of half-initializing.

import type { JEGlobal } from './types/jc';

if (!window.JellyfinCanopy) {
    throw new Error(
        '🪼 Jellyfin Canopy: window.JellyfinCanopy is missing — the client bundle was ' +
        'loaded before js/plugin.js created the namespace. Load order is plugin.js first.'
    );
}

/** The shared plugin namespace (window.JellyfinCanopy). */
export const JC: JEGlobal = window.JellyfinCanopy;
