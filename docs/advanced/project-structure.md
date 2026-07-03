## Project Structure

The plugin architecture uses a single entry point (`plugin.js`) that boots the shared `JE` namespace, loads config, and then loads all component code as **one esbuild bundle** (`dist/je.bundle.js`, built at compile time and embedded in the plugin DLL — minified in production, served fresh with a sourcemap in dev mode).

The client code is mid-migration to TypeScript ES modules: the shared core layer already lives in `src/` (real imports define its execution order), while feature modules remain classic scripts under `js/` until their conversion wave.

### TypeScript modules (`Jellyfin.Plugin.JellyfinEnhanced/src/`)

Strict TypeScript (own program: `tsconfig.src.json`, `npm run typecheck:src`), unit-tested with vitest (`npm run test:client`). Modules import each other directly AND still assign their frozen public surface onto `window.JellyfinEnhanced` (`JE.core.*`, `JE.escapeHtml`, `JE.toast`) for the unconverted scripts and user scripts.

```text
Jellyfin.Plugin.JellyfinEnhanced/
└── src/
    ├── main.ts              # Bundle entry: imports the core modules in dependency order
    ├── globals.ts           # The one place src/ obtains window.JellyfinEnhanced
    ├── core/                # Shared infrastructure — executes before every feature module
    │   ├── navigation.ts    # One place for SPA navigation events (pushState patch, hashchange/viewshow dedup)
    │   ├── lifecycle.ts     # Per-feature teardown registry (observers, intervals, listeners, AbortControllers)
    │   ├── dom-observer.ts  # Multiplexed body MutationObserver, waitForElement, createObserver
    │   ├── api-client.ts    # One fetch wrapper: auth headers, retry/dedup/concurrency, JE.core.api.{fetch,jf,plugin}
    │   ├── ui-kit.ts        # escapeHtml, toast, injectCss — the single copies
    │   ├── tag-renderer-base.ts  # Factory owning the shared tag-module plumbing (cache, mark, reinit)
    │   └── *.test.ts        # Vitest unit tests, colocated
    ├── types/               # JEGlobal (the typed window.JellyfinEnhanced contract), PluginConfig placeholder, host globals
    └── test/setup.ts        # Vitest bootstrap stub (what plugin.js provides in the real client)
```

### Legacy client scripts (`Jellyfin.Plugin.JellyfinEnhanced/js/`)

Every module here is still a classic script (an IIFE over the shared `window.JellyfinEnhanced` global, aliased `JE`). The `allComponentScripts` array in `plugin.js` is the load-order source of truth for these files — consumed at build time by `scripts/build-bundle.js`, which appends them after `src/main.ts` in the bundle. Converting a file means removing its array entry and importing it from `src/` instead. Large features are split into flat, prefixed module files (for example `hidden-content-*.js`) that share private state through `JE.internals.<feature>` — folder names must not contain dashes (embedded-resource naming), file names may.

```text
Jellyfin.Plugin.JellyfinEnhanced/
└── js/
    ├── plugin.js            # Entry point: boots JE, loads config, then dist/je.bundle.js
    ├── core/globals.d.ts    # Ambient types for the remaining // @ts-check scripts (implementation moved to src/core/)
    ├── enhanced/            # Core features
    │   ├── config.js / helpers.js / events.js / icons.js / translations.js / themer.js
    │   ├── playback.js / subtitles.js / pausescreen.js / osd-rating.js / native-tabs.js
    │   ├── tag-pipeline.js  # Scan/batch-fetch pipeline the tags/ renderers register with
    │   ├── features-*.js    # Split feature modules (random button, details page, release dates, remove-from-home, multi-select)
    │   ├── ui-*.js          # Split settings-panel modules (entry points, styles, panel template/settings/sections)
    │   ├── bookmarks.js + bookmarks-library-*.js   # Bookmarks + the bookmarks library page
    │   └── hidden-content-*.js + hidden-content-page-*.js  # Hidden-content engine, panel, and admin page
    ├── jellyseerr/          # Seerr integration
    │   ├── api.js / request-manager.js / jellyseerr.js / seerr-status.js / modal.js / item-details.js / issue-reporter.js
    │   ├── discovery-base.js            # Shared pagination/filter/infinite-scroll state machine
    │   ├── discovery-filter-utils.js / seamless-scroll.js / hss-discovery-handler.js
    │   ├── {genre,tag,network,person,collection}-discovery.js  # Thin specs over discovery-base
    │   ├── more-info-modal-*.js         # Split media-details modal (styles/data/seasons/badges/render/actions/init)
    │   └── ui-*.js                      # Split card/request UI (icons/styles/popover/badges/cards/buttons/quota/results/modals)
    ├── arr/                 # Sonarr/Radarr integration
    │   ├── arr-links.js / arr-tag-links.js
    │   ├── calendar-page-*.js + calendar-custom-tab.js     # Calendar page (styles/data/render/actions/init)
    │   └── requests-page-*.js + requests-custom-tab.js     # Downloads/requests page (styles/data/render/actions/init)
    ├── tags/                # Tag renderer specs over src/core/tag-renderer-base.ts + tag-pipeline.js
    │   └── genretags.js / languagetags.js / qualitytags.js / ratingtags.js / peopletags.js / userreviewtags.js
    ├── elsewhere/           # Streaming-availability + reviews
    ├── extras/              # Active streams, colored ratings/icons, theme selector, plugin icons, login image
    ├── others/              # Splash screen, Letterboxd links
    └── locales/             # 26 translation files, en.json is the base
```

Modules loaded outside the bundle/array: `others/splashscreen.js` and `extras/login-image.js` (pre-boot), `enhanced/translations.js` (pre-login).

### Server side (`Jellyfin.Plugin.JellyfinEnhanced/`)

```text
Jellyfin.Plugin.JellyfinEnhanced/
├── JellyfinEnhanced.cs        # Plugin class: script-tag injection, plugin pages registration
├── PluginServiceRegistrator.cs # DI: services, named HttpClients, startup filters, file logger
├── Controllers/               # One controller per feature area over JellyfinEnhancedControllerBase
│   ├── ConfigController.cs    # public/private config (driven by SettingDescriptors), script/bundle/locale serving
│   ├── JellyseerrProxyController.cs / JellyseerrUserController.cs
│   ├── ArrLinksController.cs / ArrCalendarController.cs / ArrRequestsController.cs
│   ├── UserSettingsController.cs / HiddenContentController.cs / ReviewsController.cs
│   ├── TagCacheController.cs / ItemInfoController.cs / BrandingController.cs
│   └── ActiveStreamsController.cs / MaintenanceModeController.cs / ViewsController.cs
├── Configuration/
│   ├── PluginConfiguration.cs # Flat XML-serialized settings bag (shape is frozen for upgrades)
│   ├── SettingDescriptors.cs  # Settings-as-data registry: exposure + per-user pairing per setting
│   ├── UserConfiguration.cs / UserConfigurationManager.cs (+ store/migration/reviews classes)
│   ├── PersistedJson.cs       # System.Text.Json options replicating the legacy on-disk tolerances
│   └── configPage.html + config-page.js  # Admin page; simple fields bind via data-config-key
├── Services/                  # Seerr cache/scan/watchlist, auto-request watchers, arr tag sync,
│                              # maintenance mode, startup filters (script injection, branding)
├── Data/ItemLookupService.cs  # Provider-id lookups via the supported ILibraryManager query surface
├── ScheduledTasks/ · Helpers/ · Model/ · Logging/ · PluginPages/
└── dist/                      # esbuild output (generated at build time, never committed)
```

### Development tooling

- `npm run syntax` / `npm run lint` / `npm run typecheck` — gates for every legacy `js/` script (see CONTRIBUTING.md)
- `npm run typecheck:src` / `npm run test:client` — strict type check + vitest unit tests for the `src/` TypeScript tree
- `npm run build:bundle` — the client bundle (also run automatically by the C# build); `npm run watch` rebuilds it (unminified) on every source change
- `Jellyfin.Plugin.JellyfinEnhanced.Tests/` — xUnit tests, including golden snapshots for the config payloads and on-disk user-file formats
- `scripts/release/` — release packaging + manifest generation/validation (see RELEASING.md)
