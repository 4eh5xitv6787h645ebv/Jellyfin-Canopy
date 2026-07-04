// Vitest configuration for the client-side TypeScript modules
// (Jellyfin.Plugin.JellyfinEnhanced/src/). Run via `npm run test:client`.
//
// jsdom provides just enough DOM for the core modules' module-level wiring
// (history patching, document listeners, MutationObserver). The setup file
// creates the window.JellyfinEnhanced bootstrap stub that js/plugin.js
// provides in the real client.
//
// Coverage gate (`npm run test:client:coverage`, enforced in CI): line
// coverage over src/core/ only — the typed platform layer every feature
// builds on. Measured 48.77% lines when the gate was introduced; the
// threshold is a RATCHET set just below that. When you raise coverage,
// raise the threshold to just below the new number — never lower it.
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'jsdom',
        setupFiles: ['./Jellyfin.Plugin.JellyfinEnhanced/src/test/setup.ts'],
        include: ['Jellyfin.Plugin.JellyfinEnhanced/src/**/*.test.ts'],
        coverage: {
            provider: 'v8',
            include: ['Jellyfin.Plugin.JellyfinEnhanced/src/core/**'],
            reporter: ['text', 'text-summary'],
            thresholds: {
                lines: 47,
            },
        },
    },
});
