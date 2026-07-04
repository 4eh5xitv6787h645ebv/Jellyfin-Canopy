## Project Structure

The plugin is one C# project (the server side) plus one TypeScript module tree (the client), compiled into a single client artifact. The only entry point the browser loads directly is `js/plugin.js` — a small loader that boots the shared `JE` namespace (`window.JellyfinEnhanced`), fetches config/translations, and then loads the whole feature tree as **one esbuild bundle** (`dist/je.bundle.js`, built on every `dotnet build` and embedded in the plugin DLL — minified in production, served fresh with a sourcemap in dev mode).

### The client (`Jellyfin.Plugin.JellyfinEnhanced/src/`)

Every component lives in `src/` as a strict TypeScript ES module (own program: `tsconfig.src.json`, `npm run typecheck:src`), unit-tested with vitest (`npm run test:client`, colocated `*.test.ts`). Execution order is defined by the real `import` edges — `src/main.ts` imports each area's `index.ts` barrel, and `scripts/build-bundle.js` (esbuild) follows the graph to produce `dist/je.bundle.js`. There is no hand-maintained script list anywhere.

```text
Jellyfin.Plugin.JellyfinEnhanced/
└── src/
    ├── main.ts              # Bundle entry: imports the core modules + area barrels in dependency order
    ├── globals.ts           # The one place src/ obtains window.JellyfinEnhanced
    ├── facade.ts            # The FROZEN public surface of window.JellyfinEnhanced, as types
    │                        # (JEGlobal extends it — the compiler proves the contract holds)
    ├── core/                # Shared platform layer — executes before every feature module
    │   ├── navigation.ts    # One place for SPA navigation (pushState patch, HISTORY_UPDATE,
    │   │                    # hashchange/viewshow dedup — see v12-platform.md §2)
    │   ├── lifecycle.ts     # Per-feature teardown registry (observers, intervals, listeners)
    │   ├── dom-observer.ts  # Multiplexed body MutationObserver, waitForElement, ensureInjected
    │   │                    # (keyed, idempotent, re-render-proof injection)
    │   ├── api-client.ts    # One fetch wrapper: auth headers, retry/dedup/concurrency
    │   ├── ui-kit.ts        # escapeHtml, toast, injectCss + the theme-token MUI component kit
    │   ├── live.ts          # Live-update hub over the v12 SDK socket (JE.core.live)
    │   ├── live-config.ts   # Config hot-reload (admin saves apply to open sessions)
    │   ├── live-rows.ts     # Library/user-data pushes → coalesced tag rescans
    │   ├── live-update.ts   # Plugin self-update detection → one-time refresh toast
    │   ├── tag-renderer-base.ts  # Factory owning the shared tag-module plumbing
    │   └── *.test.ts        # Vitest unit tests, colocated (coverage ratchet in vitest.config.ts)
    ├── bootstrap/           # Out-of-band loaders compiled to their OWN dist/<name>.js files
    │   │                    # (fetched by plugin.js separately — before login / before the bundle)
    │   ├── splashscreen.ts / login-image.ts / translations.ts
    ├── enhanced/            # Core features: config, events, playback, subtitles, pausescreen,
    │   │                    # themer, icons, native-tabs, osd-rating, tag-pipeline
    │   ├── features-*.ts    # Split feature modules (random button, details page, release dates,
    │   │                    # remove-from-home, multi-select)
    │   ├── ui-*.ts          # Split settings-panel modules (entry points, styles, panel, sections)
    │   ├── bookmarks.ts + bookmarks-library-*.ts       # Bookmarks + the bookmarks library page
    │   └── hidden-content-*.ts + hidden-content-page-*.ts  # Hidden-content engine, panel, admin page
    ├── jellyseerr/          # Seerr integration: api, request-manager, seerr-status, modal,
    │   │                    # item-details, issue-reporter, seamless-scroll
    │   ├── discovery-base.ts + {genre,tag,network,person,collection}-discovery.ts
    │   ├── more-info-modal-*.ts         # Split media-details modal
    │   └── ui-*.ts                      # Split card/request UI
    ├── arr/                 # Sonarr/Radarr integration: arr-links, arr-tag-links,
    │   ├── calendar-page-*.ts + calendar-custom-tab.ts
    │   └── requests-page-*.ts + requests-custom-tab.ts
    ├── tags/                # Tag renderer specs over core/tag-renderer-base + enhanced/tag-pipeline
    ├── elsewhere/           # Streaming-availability + reviews
    ├── extras/              # Active streams, colored ratings/icons, theme selector, plugin icons
    ├── others/              # Letterboxd links
    ├── types/               # je.ts (JEGlobal — the typed window.JellyfinEnhanced), host globals
    └── test/setup.ts        # Vitest bootstrap stub (what plugin.js provides in the real client)
```

Feature-internal state is shared through real module imports (typed `*-surface.d.ts` /
interface augmentations where a surface crosses files). The legacy `JE.internals` bag is gone;
the only global surface is the typed `window.JellyfinEnhanced` facade (`src/facade.ts`).

### The loader and locales (`Jellyfin.Plugin.JellyfinEnhanced/js/`)

The `js/` tree is no longer where features live — it holds exactly three things:

```text
Jellyfin.Plugin.JellyfinEnhanced/
└── js/
    ├── plugin.js            # THE entry point: boots JE, loads config + translations,
    │                        # then loads dist/je.bundle.js (no per-file fallback)
    ├── core/globals.d.ts    # Ambient host-global types for the // @ts-check'd loader
    └── locales/             # 26 translation files, en.json is the base (Weblate-managed)
```

Everything the browser runs comes from four served artifacts: the loader (`/JellyfinEnhanced/script`), the bundle (`/JellyfinEnhanced/dist/je.bundle.js`), and the out-of-band bootstrap files (`dist/splashscreen.js`, `dist/login-image.js`, `dist/translations.js`). Per-file serving of feature scripts no longer exists.

### Server side (`Jellyfin.Plugin.JellyfinEnhanced/`)

```text
Jellyfin.Plugin.JellyfinEnhanced/
├── JellyfinEnhanced.cs        # Plugin class: script-tag injection, plugin pages registration
├── PluginServiceRegistrator.cs # DI: services, named HttpClients, startup filters, file logger
├── Controllers/               # One controller per feature area over JellyfinEnhancedControllerBase.
│   │                          # Admin-only endpoints use [Authorize(Policy = Policies.RequiresElevation)]
│   │                          # — authorization failures are bare 401/403 (empty body, see api.md)
│   ├── ConfigController.cs    # public/private config (driven by SettingDescriptors), loader/bundle/locale serving
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
├── Services/                  # Seerr cache/scan/watchlist, Seerr parental-rating result filter,
│   │                          # auto-request watchers, arr tag sync,
│   │                          # maintenance mode, startup filters (script injection, branding)
│   └── LiveNotifierService.cs # Pushes live updates (config-changed etc.) to open sessions
│                              # via ISessionManager (see docs/advanced/live-updates.md)
├── EventHandlers/             # Server-side Jellyfin event subscribers (playback events)
├── Data/ItemLookupService.cs  # Provider-id lookups via the supported ILibraryManager query surface
├── ScheduledTasks/ · Helpers/ · Model/ · Logging/ · PluginPages/
└── dist/                      # esbuild output (generated at build time, never committed)
```

The project targets **Jellyfin 12 / net10.0 only** and builds with `TreatWarningsAsErrors` — the build is warning-free by contract.

### Development tooling

- `npm run typecheck:src` / `npm run lint` / `npm run test:client` — strict type check, ESLint, and vitest unit tests for the `src/` tree (`test:client:coverage` adds the `src/core` line-coverage ratchet)
- `npm run build:bundle` — the client bundle (also run automatically by the C# build); `npm run watch` rebuilds it (unminified) on every source change
- `npm run syntax` / `npm run typecheck` — `node --check` + opt-in `@ts-check` for the one remaining classic script (the loader)
- `Jellyfin.Plugin.JellyfinEnhanced.Tests/` — xUnit tests, including golden snapshots for the config payloads and on-disk user-file formats, plus a line-coverage ratchet (`scripts/check-dotnet-coverage.js`)
- `e2e/` — the committed Playwright suite (`npm run e2e`) + `e2e/docker/` (dockerized, seeded Jellyfin 12 for CI and local runs)
- `node scripts/new-feature.js <name>` — the paved-road scaffolder: generates a typed client module, a controller, an e2e spec stub and a docs stub, wired into the area barrel (see CONTRIBUTING.md)
- `scripts/release/` — release packaging + manifest generation/validation (see RELEASING.md)
