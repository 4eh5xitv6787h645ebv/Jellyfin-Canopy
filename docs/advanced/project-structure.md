## Project Structure

The plugin is one C# project (the server side) plus one TypeScript module tree (the client), compiled into a single client artifact. The only entry point the browser loads directly is `js/plugin.js` — a small loader that boots the shared `JE` namespace (`window.JellyfinEnhanced`), fetches config/translations, and then loads the whole feature tree as **one esbuild bundle** (`dist/je.bundle.js`, built on every `dotnet build` and embedded in the plugin DLL — minified in production, unminified and served fresh (no-store) in dev mode — an external sourcemap ships in both).

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
    │   │                    # hashchange/viewshow dedup — see ../v12-platform.md §2)
    │   ├── lifecycle.ts     # Per-feature teardown registry (observers, intervals, listeners)
    │   ├── dom-observer.ts  # Multiplexed body MutationObserver, waitForElement, ensureInjected
    │   │                    # (keyed, idempotent, re-render-proof injection)
    │   ├── api-client.ts    # One fetch wrapper: auth headers, retry/dedup/concurrency
    │   ├── asset-urls.ts    # CDN-URL ↔ local-asset map: same-origin when the asset cache
    │   │                    # is on (AssetCacheEnabled, default ON), original CDN URL when off (R6)
    │   ├── ui-kit.ts        # escapeHtml, toast, injectCss + the theme-token MUI component kit
    │   ├── live.ts          # Live-update hub over the v12 SDK socket (JE.core.live)
    │   ├── live-config.ts   # Config hot-reload (admin saves apply to open sessions)
    │   ├── live-rows.ts     # Library/user-data pushes → coalesced tag rescans
    │   ├── live-update.ts   # Plugin self-update detection → one-time refresh toast
    │   ├── tag-renderer-base.ts  # Factory owning the shared tag-module plumbing
    │   ├── bounded-cache.ts # Size-capped, lazily-TTL-swept LRU — the one item-cache primitive
    │   ├── config-resolve.ts # PascalCase admin-config → camelCase view (admin-default resolution)
    │   ├── delivery-flags.ts # Zeroes stale Custom-Tabs/Plugin-Pages flags when those plugins are gone
    │   ├── fetch-error.ts   # Classifies a failed fetch so callers show an error state, not empty
    │   ├── css-safe.ts      # isCssColor / cssColorOr — the CSS-context escape sink (see client-security.md)
    │   ├── modal-a11y.ts    # Shared modal focus-trap + global-shortcut suppression for JE overlays
    │   ├── locale.ts        # One display locale for every date/number format in a session
    │   └── *.test.ts        # Vitest unit tests, colocated (coverage ratchet in vitest.config.ts)
    ├── bootstrap/           # Out-of-band loaders compiled to their OWN dist/<name>.js files
    │   │                    # (fetched by plugin.js separately — before login / before the bundle)
    │   ├── splashscreen.ts / login-image.ts / translations.ts
    ├── enhanced/            # Core features. Flat singles: config, events, playback, subtitles,
    │   │                    # pausescreen, themer, icons, native-tabs, osd-rating, tag-pipeline
    │   ├── features/        # Split feature modules (random button, details page, release dates,
    │   │                    # remove-from-home, multi-select)
    │   ├── settings-panel/  # Split settings-panel modules (entry points, styles, panel, sections)
    │   ├── bookmarks/       # Bookmarks + the bookmarks library page (library-*.ts)
    │   ├── hidden-content/  # Hidden-content engine (data, save, filter, dialogs, panel, buttons)
    │   ├── hidden-content-page/  # Hidden-content admin page (state, render, cards, nav, custom tab)
    │   └── spoiler-guard/   # Spoiler Guard client: detail/movie/collection toggle button, Seerr
    │                        # discovery toggle, per-user state + overrides, settings-panel tab,
    │                        # disable-confirm dialog/snooze, soft image-refresh on toggle, and the
    │                        # live-update-driven watched-refresh (UserDataChanged). Blur/strip is server-side
    ├── jellyseerr/          # Seerr integration. Flat singles: api, request-manager, jellyseerr,
    │   │                    # seerr-status, modal, item-details, issue-reporter, seamless-scroll,
    │   │                    # hss-discovery-handler
    │   ├── discovery/       # Discovery rows: base + filter-utils + {genre,tag,network,person,collection}.ts
    │   ├── more-info-modal/ # Split media-details modal (styles, data, seasons, badges, render,
    │   │                    # actions, actions-tv, init + internal.ts shared state)
    │   └── ui/              # Split card/request UI (icons, styles, popover, badges, cards, buttons,
    │                        # quota, results, request/season modals + internal.ts shared state)
    ├── arr/                 # Sonarr/Radarr integration. Flat singles: arr-links, arr-tag-links,
    │   │                    # arr-globals
    │   ├── calendar/        # Calendar page (styles, data, render-*, actions, init, event-date) + custom-tab.ts
    │   └── requests/        # Requests page (styles, data, render-*, actions, init) + custom-tab.ts
    ├── tags/                # Tag renderer specs over core/tag-renderer-base + enhanced/tag-pipeline
    ├── elsewhere/           # Streaming-availability + reviews
    ├── extras/              # Active streams, colored ratings/icons, theme selector, plugin icons
    ├── others/              # Letterboxd links
    ├── types/               # je.ts (JEGlobal — the typed window.JellyfinEnhanced), host globals
    └── test/setup.ts        # Vitest bootstrap stub (what plugin.js provides in the real client)
```

Feature-internal state is shared through real module imports (typed `surface.d.ts` files /
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

Everything the browser runs comes from five served artifacts: the loader (`/JellyfinEnhanced/script`), the bundle (`/JellyfinEnhanced/dist/je.bundle.js`), and the out-of-band bootstrap files (`dist/splashscreen.js`, `dist/login-image.js`, `dist/translations.js`). Per-file serving of feature scripts no longer exists.

### Server side (`Jellyfin.Plugin.JellyfinEnhanced/`)

```text
Jellyfin.Plugin.JellyfinEnhanced/
├── JellyfinEnhanced.cs        # Plugin class: script-tag injection, plugin pages registration
├── PluginServiceRegistrator.cs # DI: services, named HttpClients, startup filters, file logger
├── Controllers/               # One controller per feature area over JellyfinEnhancedControllerBase.
│   │                          # Admin-only endpoints use [Authorize(Policy = Policies.RequiresElevation)]
│   │                          # — authorization failures are bare 401/403 (empty body, see api.md)
│   ├── ConfigController.cs    # public/private config (driven by SettingDescriptors), loader/bundle/locale serving
│   ├── AssetsController.cs    # Serves locally cached third-party assets (/JellyfinEnhanced/assets/{key}) so browsers never hit a CDN
│   ├── JellyseerrProxyController.cs / JellyseerrUserController.cs
│   ├── ArrLinksController.cs / ArrCalendarController.cs / ArrRequestsController.cs
│   ├── UserSettingsController.cs / HiddenContentController.cs / ReviewsController.cs
│   ├── TagCacheController.cs / ItemInfoController.cs / BrandingController.cs
│   ├── SpoilerGuardController.cs # Spoiler Guard opt-in list (series/movies/collections), Seerr
│   │                          # pending pre-arm, and the corruption-recovery health endpoints
│   └── ActiveStreamsController.cs / MaintenanceModeController.cs / ViewsController.cs
├── Configuration/
│   ├── PluginConfiguration.cs # Flat XML-serialized settings bag (shape is frozen for upgrades)
│   ├── SettingDescriptors.cs  # Settings-as-data registry: exposure + per-user pairing per setting
│   ├── AtomicFile.cs          # Crash-safe write helper (temp-file + atomic rename) all config writes go through
│   ├── UserConfiguration.cs / UserConfigurationManager.cs (+ store/migration/reviews classes)
│   ├── PersistedJson.cs       # System.Text.Json options replicating the legacy on-disk tolerances
│   └── configPage.html + config-page.js  # Admin page; simple fields bind via data-config-key
├── Services/                  # Seerr cache/scan/watchlist, Seerr parental-rating result filter,
│   │                          # auto-request watchers (AutoRequest/AutoRequestRetryPolicy —
│   │                          # transport-only retry / already-requested handling), arr tag sync,
│   │                          # maintenance mode, startup filters (script injection, branding)
│   ├── LiveNotifierService.cs # Pushes live updates (config-changed etc.) to the sessions
│   │                          # registered as running the JE client (via ILiveSessionRegistry;
│   │                          # see docs/advanced/live-updates.md)
│   ├── LiveSessionRegistry.cs # Registry of sessions running the JE client — scopes live pushes
│   └── SpoilerGuard/          # Spoiler Guard server core: ImageBlurService (SkiaSharp Gaussian blur +
│                              # stock-card render + pre-encoded fail-closed JPEG, cached),
│                              # SpoilerBlurImageFilter (per-user image-byte replacement over the Image/
│                              # Trickplay routes), SpoilerFieldStripFilter (metadata strip/rewrite honoring
│                              # per-user overrides), SpoilerUserResolver (per-user identity incl. cookie/IP
│                              # hint), SpoilerSeerrPendingPromoter (pending pre-arm → real protection)
├── EventHandlers/             # Server-side Jellyfin event subscribers (playback events;
│                              # SpoilerAutoEnableEvents = auto-enable Spoiler Guard on a fresh S1E1 play)
├── Data/ItemLookupService.cs  # Provider-id lookups via the supported ILibraryManager query surface
├── Helpers/                  # Pure helpers: ArrIdHelper (zero-id normalize + per-instance id namespacing),
│                              # ArrUrlGuard (SSRF guard: metadata/rebind blocked, LAN allowed),
│                              # Arr/ArrReleaseDate (date-only vs instant calendar release contract),
│                              # Jellyseerr/TmdbProxyPathClassifier (deny-by-default raw-TMDB gate)
├── ScheduledTasks/ · Model/ · Logging/ · PluginPages/
└── dist/                      # esbuild output (generated at build time, never committed)
```

The project targets **Jellyfin 12 / net10.0 only** and builds with `TreatWarningsAsErrors` — the build is warning-free by contract.

### Development tooling

- `npm run typecheck:src` / `npm run lint` / `npm run test:client` — strict type check, ESLint, and vitest unit tests for the `src/` tree (`test:client:coverage` adds the `src/core` line-coverage ratchet)
- `npm run build:bundle` — the client bundle (also run automatically by the C# build); `npm run watch` rebuilds it (unminified) on every source change
- `npm run syntax` / `npm run typecheck` — `node --check` + opt-in `@ts-check` for the one remaining classic script (the loader)
- `Jellyfin.Plugin.JellyfinEnhanced.Tests/` — xUnit tests, including golden snapshots for the config payloads and on-disk user-file formats, plus a line-coverage ratchet (`scripts/check-dotnet-coverage.js`). Its `Configuration/` tests bridge the `SettingDescriptors` registry to both ends of the admin config page over one shared source parser (`ConfigPageSource.cs`, read by both directions so they can never drift): `ConfigControlCoverageTests` fails if any admin-settable descriptor backed by a real `PluginConfiguration` property has no config-page control (an admin default stuck at its hardcoded value), and `ClientConfigKeyLivenessTests` scans the shipped client source and fails if any `JE.pluginConfig.X` read is not a projected (`Public`/`Private`) descriptor key (a client knob that is always `undefined`)
- `src/test/` — cross-cutting **guard tests** that parse the shipped source and fail on a whole *class* of regression, not just one instance: `escape-guard` (HTML-injection, incl. an escape-first check of pre-escaping producers), `css-injection-guard` (CSS-context values), `leak-guard` (object URLs, observers, TTL maps, unbounded retry loops), `perf-rules-guard` (the R-rules), `error-as-empty-guard` (fetch errors surfaced, not swallowed), `locale-guard`, `ratings-css`, `injected-css-balance`, `legacy-auth-header`, `plugin-loader`, `build-scripts`. Server-side, `LibraryScanEventGuardTests` scans every reviewed scan-thread subscriber's synchronous body (see [S1](performance-rules.md#s1-never-block-jellyfins-synchronous-threads))
- `e2e/` — the committed Playwright suite (`npm run e2e`) + `e2e/docker/` (dockerized, seeded Jellyfin 12 for CI and local runs). Every spec closes on the shared `assertNoRuntimeErrors` net in `e2e/fixtures/auth.ts`: it fails on any un-whitelisted console error / pageerror and, because Chromium's generic 40x console line carries no url, on any 4xx response whose url is not on the known-legacy `ALLOWED_4XX_URL` allowlist (a real broken plugin endpoint) — `e2e/console-net.spec.ts` is the unit-of-behavior spec that pins that net. Alongside the boot / navigation / panel / live-update / tag specs, the security- and persistence-sensitive flows have their own: `arr-requests-parental.spec.ts` (the Requests page applies the caller's own parental limit server-side; an admin bypasses it), `search-tags.spec.ts` (`DisableTagsOnSearchPage` hides *every* tag family on the search page, not just genre), `settings-persist.spec.ts` (a per-user setting round-trips through the server across a reload) and `non-admin.spec.ts` (core surfaces from a non-admin session, where per-user gating bugs live). `e2e/docker/seed.sh` accepts optional `TMDB_API_KEY` / `JELLYSEERR_*` env so the Seerr/TMDB specs run when configured and skip cleanly when not — the readiness probes and per-user parental-limit helpers live in `e2e/fixtures/seerr.ts` (`tmdbReady` / `seerrReady` read the projected public-config)
- `node scripts/new-feature.js <name>` — the paved-road scaffolder: generates a typed client module, a controller, an e2e spec stub and a docs stub, wired into the area barrel (see CONTRIBUTING.md)
- `scripts/release/` — release packaging + manifest generation/validation (see RELEASING.md)
