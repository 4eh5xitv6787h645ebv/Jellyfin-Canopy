// Vitest configuration for the client-side TypeScript modules
// (Jellyfin.Plugin.JellyfinCanopy/src/). Run via `npm run test:client`.
//
// jsdom provides just enough DOM for the core modules' module-level wiring
// (history patching, document listeners, MutationObserver). The setup file
// creates the window.JellyfinCanopy bootstrap stub that js/plugin.js
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
        setupFiles: ['./Jellyfin.Plugin.JellyfinCanopy/src/test/setup.ts'],
        include: ['Jellyfin.Plugin.JellyfinCanopy/src/**/*.test.ts'],
        // Tests complete in well under a second in isolation; the default 5s
        // cap only ever fires as a false positive when the host (or a shared
        // CI runner) is under heavy load and 80+ jsdom workers contend for
        // CPU. 15s still fails genuine hangs, without failing on contention.
        testTimeout: 15_000,
        coverage: {
            provider: 'v8',
            include: ['Jellyfin.Plugin.JellyfinCanopy/src/core/**'],
            reporter: ['text', 'text-summary'],
            thresholds: {
                lines: 47,
            },
        },
    },
});
