// Vitest configuration for the client-side TypeScript modules
// (Jellyfin.Plugin.JellyfinEnhanced/src/). Run via `npm run test:client`.
//
// jsdom provides just enough DOM for the core modules' module-level wiring
// (history patching, document listeners, MutationObserver). The setup file
// creates the window.JellyfinEnhanced bootstrap stub that js/plugin.js
// provides in the real client.
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'jsdom',
        setupFiles: ['./Jellyfin.Plugin.JellyfinEnhanced/src/test/setup.ts'],
        include: ['Jellyfin.Plugin.JellyfinEnhanced/src/**/*.test.ts'],
    },
});
