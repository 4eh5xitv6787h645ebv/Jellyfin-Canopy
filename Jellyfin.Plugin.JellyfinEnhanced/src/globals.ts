// src/globals.ts
//
// The one place src/ modules obtain the shared window.JellyfinEnhanced
// namespace. js/plugin.js creates the object (with its bootstrap placeholders)
// BEFORE loading the bundle, so by the time any module in this tree executes
// the global must exist — a missing namespace means the bundle was loaded
// out of order, which we fail on loudly instead of half-initializing.

import type { JEGlobal } from './types/je';

if (!window.JellyfinEnhanced) {
    throw new Error(
        '🪼 Jellyfin Enhanced: window.JellyfinEnhanced is missing — the client bundle was ' +
        'loaded before js/plugin.js created the namespace. Load order is plugin.js first.'
    );
}

/** The shared plugin namespace (window.JellyfinEnhanced). */
export const JE: JEGlobal = window.JellyfinEnhanced;
