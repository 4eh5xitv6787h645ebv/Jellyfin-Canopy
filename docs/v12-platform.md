# Jellyfin 12 Platform Facts (Phase 0 spikes)

Evidence-first reference for building this plugin against Jellyfin 12 only. Verified 2026-07-03/04 against a live Jellyfin **12.0.0** server (web bundle `12.0-rc2`) and the server/web source trees. `SRC` = jellyfin-server source; `WEB` = jellyfin-web source (master `4797498`, slightly newer than the shipped bundle — see naming-skew warning below).

> **Plan correction from these spikes:** Jellyfin 12 retains a user-selectable **legacy layout** (`localStorage.layout = 'desktop'` on the shipped build). The classic anchors (`.headerRight`, `.mainDrawer-scrollContainer`, tab slider) are therefore *v12 features*, not 10.11 leftovers — dual-layout DOM support **stays**. The v12-only purge removes 10.11 *server/protocol* surfaces, not the legacy-layout UI paths.

---

## 1. Layouts (S1)

- The React/MUI layout is the **default** on non-TV browsers: `appHost.getDefaultLayout()` → `Modern` (`WEB src/components/apphost.js:185-187`); selection stored in the **unprefixed `localStorage` key `layout`** (`WEB src/components/layoutManager.js:18`, `appSettings.js:263-274`).
- **Naming skew:** shipped 12.0.0 uses `experimental`/`desktop` values (`LayoutMode {auto, desktop, experimental, mobile, tv}`); master renamed to `modern`/`legacy` + `desktop-legacy`/`mobile-legacy`. `layout='desktop-legacy'` is INVALID on the shipped build and silently falls back to the React layout. **Never hardcode layout values; detect by DOM** (visible `.MuiAppBar-root .MuiToolbar-root` vs visible `.headerRight`).
- Route tree is chosen **once at module init** (`WEB src/RootAppRouter.tsx:26`); layout change requires reload.
- **Enforcing a layout (`LayoutEnforcement` setting):** the only server-controlled steering point is the boot loader. jellyfin-web's bundles are `<script defer>` in `<head>` and read `localStorage['layout']` at module init; the plugin loader is `<script defer>` at end of `<body>` (`ScriptInjectionStartupFilter` injects before `</body>`), so **the app has already chosen its layout before any plugin code runs** — an override cannot be applied in place and must set `localStorage['layout']` then do ONE reload. This lives in `js/plugin.js` (`resolveLayoutEnforcement` / `applyLayoutEnforcement`, run from the pre-auth early public-config fetch so the login screen is covered too). Guarded so it never loops: it reloads only when the stored value actually changes and at most once per session (`sessionStorage['je_layout_enforced']`). Values written are `experimental` (modern) / `desktop` (legacy) — the shipped-build values validated by `getSavedLayout()`.
- `html` classes cannot discriminate layouts (both produce `layout-desktop`).
- **Present ≠ visible:** on the modern layout the whole legacy header block remains in the DOM inside a `display:none` wrapper (`WEB src/components/AppHeader.tsx:20-27`). Existence checks silently produce invisible UI. `.skinHeader`/`.MuiAppBar-root` are `position:fixed` → `offsetParent === null` even when visible; check children instead.

### Stable anchors — modern layout

| Surface | Selector (live-verified) | Source |
|---|---|---|
| AppBar action tray | no stable class: locate `[aria-controls="app-user-menu"]` → `.closest('.MuiToolbar-root')` → user-menu Box `previousElementSibling` | `WEB src/components/toolbar/AppToolbar.tsx:92-96`, `AppUserMenu.tsx:27` |
| Toolbar nav links | links inside `.MuiAppBar-root` (UserViewNav). **`config.json` `menuLinks` render here** — declarative nav injection (`UserViewNav.tsx:82-85`) | `WEB src/apps/modern/components/AppToolbar/index.tsx:60-62` |
| Library toolbar (2nd row) | second `.MuiAppBar-root .MuiToolbar-root` (only on library routes) | `WEB src/apps/modern/AppLayout.tsx:51` |
| Drawer | `.MuiDrawer-paper` — **mobile only**; modern desktop has **no drawer** | `AppLayout.tsx:26-28,55-62` |
| Item-detail action row | `.page:not(.hide) .mainDetailButtons` — details are still legacy viewManager views on the modern layout | `WEB src/apps/modern/routes/legacyRoutes/user.ts:5-8`; `apps/legacy/controllers/itemDetails/index.html:18` |
| Home sections | `#indexPage .homeSectionsContainer` — React wrapper hosting the legacy hometab controller | `WEB src/apps/modern/routes/home.tsx:168-186` |
| Player OSD | `.videoOsdBottom .buttons.focuscontainer-x` — valid on BOTH layouts | `WEB src/apps/modern/routes/video/index.tsx`; `apps/legacy/controllers/playback/video/index.html:9,30` |

### Legacy layout (`layout='desktop'`)
All classic anchors present and visible: `.headerRight`, `.headerLeft`, `.mainDrawer-scrollContainer`, `.emby-tabs-slider`/`.headerTabs`, `.homeSectionsContainer`, `.mainDetailButtons`.

### Current helper validity
- `getHeaderRightContainer()`: `.headerRight` legacy-layout-only; the MUI tray fallback works — but the tray is **destroyed on entering `/video` and NOT restored on exit** (AppToolbar returns `null` there and remounts fresh). Header injection must be idempotent and re-run after leaving the player.
- `getSidebarContainer()`: `.MuiDrawer-paper` correct but mobile-only; modern desktop genuinely has no sidebar.
- `native-tabs.ts` anchors (`.emby-tabs-slider`): hidden on modern; modern equivalents are UserViewNav links or `config.json` `menuLinks`.

---

## 2. Script injection & events (S2)

- **Injection path works on 12**: `/web/index.html` served by Kestrel with `Cache-Control: no-cache` (`SRC Jellyfin.Server/Startup.cs:200-227`); JE's request-time middleware injection is present in the served HTML. The service worker has **no fetch handler** (`WEB src/serviceworker.js`) — nothing caches/rewrites index.html. Jellyfin 12 has no native injection hook, so the middleware **stays**.
- Globals exposed at boot: `window.Events`, `window.TaskButton` (`WEB src/index.jsx:58-59`), `window.Emby.Page = appRouter` (`appRouter.js:552-553`), `window.ApiClient`, `window.ServerNotifications`. Also sanctioned: `config.json` `"plugins"` list via `pluginManager.loadPlugin` (`index.jsx:137-160`).

### Navigation events
- `viewshow` fires on **mount** for both legacy viewManager views (rich `detail` incl. `params`) and React `components/Page` pages (minimal `detail`, no `params`/`type`) — `WEB viewManager.js:60`, `Page.tsx:44-64`.
- **`viewshow` is NOT universal**: param-only navigation (home tab switches, `/movies?topParentId=A→B`) fires **no** `viewshow`. `/details?id=A→B` does fire (effect deps include `location.search`).
- **Router-level hook**: every router state change triggers `Events.trigger(document, 'HISTORY_UPDATE', [state])` (`WEB src/components/router/routerHistory.ts:7,16-19`) — fires on EVERY navigation including param-only; may fire **2× per logical nav** (REPLACE normalization) — dedup by `pathname+search`. Other document events: `THEME_CHANGE`, `REFRESH_NEEDED`, `HEADER_RENDERED`, `SET_TABS`.
- `je:navigate` (our pushState patch) verified: exactly 1× per route change; `history.back()` = one popstate + one hashchange (dedup assumption holds).
- **DEADLOCK TRAP (reproduced twice):** `Emby.Page.show(path)` returns a promise resolved only by the next `viewshow`; a param-only nav never resolves it and **every subsequent `Emby.Page.show()` hangs forever** (`appRouter.js:92-101,170-177`). Never `await Emby.Page.show()` for param-only navs.

### WebSocket / server messages
- **The legacy apiclient socket is dead on v12**: `ApiClient.isWebSocketOpen() === false`; `Events.on(ApiClient,'message')` receives nothing. The socket belongs to the `@jellyfin/sdk` `Api` bridged as `ApiClient._sdk`; **plugins subscribe via `ApiClient.subscribe(['UserDataChanged', ...], cb)`** (returns unsubscribe fn; empirically verified delivering `{MessageType, Data}`).
- Central client handling only re-emits `SyncPlayGroupUpdate`; data messages (`UserDataChanged`, `LibraryChanged`, timers) are consumed decentrally, largely via tanstack `invalidateQueries` (`WEB src/elements/emby-itemscontainer/ItemsContainer.tsx:277-282`).

---

## 3. React re-render survival matrix (S4)

Empirical (modern layout, rc2, marker elements + resize / websocket-driven refetch / navigation):

| Page | Anchor | In-place re-render | Navigate away → back | Strategy |
|---|---|---|---|---|
| Home | `#indexPage .homeSectionsContainer` | survives | **destroyed** (unmount, no cache) | re-inject per mount |
| Library (React, tanstack) | page body / 2nd toolbar | **survives** query refetch | destroyed | re-inject per mount + `HISTORY_UPDATE` for same-route switches (no viewshow!) |
| Item detail (legacy view) | `.page:not(.hide) .mainDetailButtons` | survives | back(POP): **survives** (3-view LRU cache); re-push: rebuilt, old marker left **alive-hidden in a cached view** | re-inject per `viewshow`; ALWAYS scope selectors to `.page:not(.hide)` |
| Search (React) | `#searchPage` | survives live typing | destroyed | re-inject per mount |
| Video OSD (legacy) | `.videoOsdBottom .buttons` | survives OSD hide/show | — | inject once per playback session |
| Header tray (modern) | user-menu-sibling Box | survives | survives all routes **except `/video`** (destroyed on entry, NOT restored on exit) | idempotent, re-run after player exits |

Universal strategy: idempotent keyed injectors re-driven by (1) `HISTORY_UPDATE`/`je:navigate` for every URL change, (2) `viewshow` for legacy views, (3) the multiplexed body MutationObserver as catch-all. React pages tolerate foreign appended children through any in-place re-render; only unmount kills them. No React errors were produced by injected markers.

Item-detail view-cache traps (live-verified, the "loads only on revisit" bug class):

- Up to **three `#itemDetailPage` elements coexist** (`WEB src/components/viewContainer.js`, `pageContainerCount = 3`, fixed round-robin slots). `document.getElementById('itemDetailPage')` returns whichever occupies the LOWEST slot — visible or not — so a visibility gate built on it goes permanently dead once two details views exist. Resolve the page through `core/details-view` (`isDetailsPageVisible()` / `getVisibleDetailsPage()`), never getElementById.
- On a **details→details push**, navigation callbacks (`HISTORY_UPDATE`) fire while the OUTGOING page is still the visible one — `#itemDetailPage:not(.hide)`-style lookups at nav time resolve the old view and injections land in a page about to be hidden. `getVisibleDetailsPage()` only returns the page once its `viewshow` recorded it for the item the URL names.
- When item data arrives, the host's `renderMiscInfo` → `fillPrimaryMediaInfo` does `elem.innerHTML = html` on `.itemMiscInfo-primary` (`WEB src/components/mediainfo/mediainfo.js`), destroying injected chips. On slow servers this lands AFTER a feature's first fill, so misc-info injectors MUST be re-driven by the body-observer catch-all (which the getElementById gate above silently disabled). `.mainDetailButtons` is only class-toggled, never rebuilt — which is why button injections survived while chips vanished.

---

## 4. Server API surface (S3)

- **`IUserManager.GetUsers()`** is the only, stable member on 12 (`SRC MediaBrowser.Controller/Library/IUserManager.cs:28`; no `Users` property). The reflection shim is unnecessary → delete; 10 call sites move to `GetUsers()`.
- **Provider lookups**: `InternalItemsQuery.HasAnyProviderIds` (`Dictionary<string,string[]>`, `InternalItemsQuery.cs:459`) + singular `HasAnyProviderId` (:457). No newer dedicated API; `ILibraryManager` + `HasAnyProviderIds` **is** the supported endgame. The raw-EF 10.11 batch path → delete.
- **Media Segments**: contribute via `IMediaSegmentProvider` (Name/GetMediaSegments/Supports/CleanupExtractedData), consume via injectable `IMediaSegmentManager`; REST is read-only `GET /MediaSegments/{itemId}` `[Authorize]`. `MediaSegmentType {Unknown, Commercial, Preview, Recap, Outro, Intro}`.
- **Plugin pages**: `IHasWebPages`/`PluginPageInfo` unchanged; `GET /web/ConfigurationPages` is `RequiresElevation`, `GET /web/ConfigurationPage?name=` has **no auth attribute**. v12 web honors `PluginPageInfo.MenuIcon` (`WEB apps/dashboard/.../PluginDrawerSection.tsx:53`). No first-class API for main-nav pages exists → the `CheckPluginPages` third-party mechanism **stays (conditional)**.
- **Session messaging** (`ISessionManager`): `SendGeneralCommand`, `SendMessageCommand` (toast), `SendMessageToAdminSessions<T>`, `SendMessageToUserSessions<T>(userIds, SessionMessageType, data)`, `SendMessageToUserDeviceSessions<T>`. `SessionMessageType` is a **closed enum** — plugins cannot add types but CAN push `LibraryChanged`/`UserDataChanged`-shaped payloads the client already consumes natively. Wire envelope: `{"MessageId","Data","MessageType"}`.
  - `LibraryChanged` emitted per-user, batched over `LibraryUpdateDuration` (`SRC Emby.Server.Implementations/EntryPoints/LibraryChangedNotifier.cs:282-284`); payload `LibraryUpdateInfo {FoldersAddedTo, FoldersRemovedFrom, ItemsAdded, ItemsRemoved, ItemsUpdated, CollectionFolders}`.
  - `UserDataChanged` batched 500ms (`UserDataChangeNotifier.cs:126-128`); payload `{UserId, UserDataList: UserItemDataDto[]}` (includes parent aggregates).
  - Inbound: plugins may implement `IWebSocketListener`.
- **WS auth gotcha (live-verified):** v12 disables legacy authorization by migration (`20260531160000_DisableLegacyAuthorization.cs`); `?api_key=`/`X-Emby-Token`/`X-MediaBrowser-Token` are **ignored** (ws handshake with `?api_key=` → 403). Only `Authorization: MediaBrowser Token=...` or `?ApiKey=` (capital) work.
- **Config-save observation without static bridges**: `BasePlugin<T>.ConfigurationChanged` (`SRC MediaBrowser.Common/Plugins/BasePluginOfT.cs:90`) is raised by `UpdateConfiguration()` (the dashboard/API save path). Plugins aren't DI-registered, but a DI `IHostedService` can reach the instance via `IPluginManager.GetPlugin(Guid)` → `LocalPlugin.Instance` cast → subscribe. Caveat: bare `SaveConfiguration()` does NOT raise it. → the `SeerrCache.Instance` static bridge and `UpdateConfiguration` override can be deleted.

### Workaround verdicts

| Workaround | Verdict on v12 |
|---|---|
| `UserManagerExtensions` reflection shim | **DELETE** |
| Raw-EF 10.11 batch lookup (`#if !NET10_0_OR_GREATER`) | **DELETE** |
| `SeerrCache.Instance` static + `UpdateConfiguration` flush bridge | **DELETE** → IHostedService + `IPluginManager` + `ConfigurationChanged` |
| Hand-rolled `IsAdminUser()` + JSON 403 envelopes | **CONVERT** → `[Authorize(Policy = ...)]` (contract below) |
| `X-Emby-Token` / `X-MediaBrowser-Token` client header | **DELETED** — the avatar-fetch helper (`src/arr/requests/data.ts`) now sends only `Authorization: MediaBrowser Token=…`; v12 ignores the legacy headers |
| Request-time index.html injection middleware | **STAYS** (no native hook) |
| Legacy on-disk index.html rewrite | keep `CleanupOldScript` only |
| `BrandingAssetStartupFilter` | **STAYS** (no server API) |
| `CheckPluginPages` (PluginPages plugin config) | **STAYS (conditional)** |
| Legacy-layout DOM fallbacks (`.headerRight` etc.) | **STAY** — they serve v12's legacy layout |

---

## 5. Authorization policies (S5)

Constants: `MediaBrowser.Common.Api.Policies` (moved from `Jellyfin.Api.Constants`). Registration: `SRC Jellyfin.Server/Extensions/ApiServiceCollectionExtensions.cs:55-91`.

Key policies: default (bare `[Authorize]`) = authenticated + remote-access + parental schedule, admins bypass; `RequiresElevation` = `ClaimTypes.Role == Administrator`; plus `Download`, `CollectionManagement`, `SyncPlay*`, `Subtitle/LyricManagement`, `IgnoreParentalControl`, `LocalAccessOrRequiresElevation`, `AnonymousLanAccessPolicy`, `FirstTimeSetup*`.

**Empirical error contract** (the Phase 4 client contract):
- Policy failure with valid non-admin token → **403, empty body, no content-type**.
- Missing/garbage token → **401, empty body**.
- Admin API keys carry the Administrator role (pass `RequiresElevation`).
- Client JS must branch on **status code alone** for authz failures; app-level JSON envelopes (Seerr permission codes etc.) remain for business errors only.
- Note: on 12, `GET /System/Configuration` is plain `[Authorize]` (not admin-gated); only POST requires elevation.

---

## 6. Breaking-assumption flags (carry into Phases 1–5)

1. Legacy apiclient websocket surface is dead — use `ApiClient.subscribe`.
2. `viewshow` misses param-only navigations — key features on `HISTORY_UPDATE`/`je:navigate` too.
3. Never `await Emby.Page.show()` (router deadlock after param-only navs).
4. Present ≠ visible (hidden legacy header block on modern layout).
5. Header-tray injections die on the `/video` round trip — idempotent re-attach required.
6. Layout value names differ between shipped 12.0.0 and master — detect by DOM, never by value.
7. `HISTORY_UPDATE` can double-fire — dedup by `pathname+search`.
8. Cached legacy views can hold stale plugin DOM alive-hidden — scope to `.page:not(.hide)`.
9. v12 ignores all legacy auth tokens (`?api_key=`, `X-Emby-Token`).
