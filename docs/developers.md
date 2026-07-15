# Developer Guide

This is the technical reference for anyone building against Jellyfin Canopy, integrating with it from the outside, or working on the plugin itself. It collects the platform facts the plugin is built on, the external REST surface you can call, the live-update channels, the performance and security rules the code must obey, the source layout, and the trace-capture harness. It is written for developers and power users, so it favors precision over hand-holding — but every section still opens with what the thing is and why it exists before descending into detail.

If you are looking for the user- and admin-facing settings behind any of this — where a toggle lives in the config page, how branding, caching, maintenance mode, dev mode, or layout enforcement behave for an operator — start with [Customization](customization.md) and [Reference](reference.md). This guide is the layer underneath.

---

## The Jellyfin 12 platform

Jellyfin Canopy targets **Jellyfin 12 / net10.0 only**. That single constraint shapes the whole plugin: it drops every 10.11 server and protocol workaround, authenticates the modern way, and builds its client against a host web app that is now a React/MUI rewrite. What follows is the evidence-first platform reference — verified against a live Jellyfin **12.0.0** server (web bundle `12.0-rc2`) and the server/web source trees. Understand these facts before you touch injection, navigation, or the socket, because most of them contradict what a 10.11-era plugin would assume.

The plugin hooks the host in four places: it injects its loader script into the served `index.html`, it drives its UI from the host's navigation events and a shared DOM observer, it subscribes to the host's websocket for live pushes, and it exposes its own authenticated REST controllers. Everything below is why each of those works the way it does.

### Layout modes and enforcement

Jellyfin 12 ships **two** layouts, and both are live targets for the plugin — the v12-only purge removed 10.11 server/protocol surfaces, not the legacy-layout UI paths.

- The **React/MUI "modern" layout** is the default on non-TV browsers (`appHost.getDefaultLayout()` → `Modern`, `WEB src/components/apphost.js`). Selection is stored in the **unprefixed `localStorage` key `layout`** (`WEB src/components/layoutManager.js`, `appSettings.js`).
- Jellyfin 12 **retains a user-selectable legacy layout** (`localStorage.layout = 'desktop'` on the shipped build). The classic anchors (`.headerRight`, `.mainDrawer-scrollContainer`, the tab slider) are therefore *v12 features*, not 10.11 leftovers — dual-layout DOM support **stays**.

!!! warning "Detect layout by DOM, never by value"
    Shipped 12.0.0 uses `experimental`/`desktop` layout values (`LayoutMode {auto, desktop, experimental, mobile, tv}`); the newer master branch renamed them to `modern`/`legacy` plus `desktop-legacy`/`mobile-legacy`. `layout='desktop-legacy'` is **invalid** on the shipped build and silently falls back to the React layout. Never hardcode layout values — detect by DOM (visible `.MuiAppBar-root .MuiToolbar-root` vs visible `.headerRight`). The `html` classes cannot discriminate layouts either: both produce `layout-desktop`.

The route tree is chosen **once at module init** (`WEB src/RootAppRouter.tsx`), so a layout change requires a full reload.

**Present ≠ visible.** On the modern layout the entire legacy header block stays in the DOM inside a `display:none` wrapper (`WEB src/components/AppHeader.tsx`). Existence checks silently produce invisible UI. `.skinHeader`/`.MuiAppBar-root` are `position:fixed`, so `offsetParent === null` even when they are visible — check children instead.

#### Stable anchors — modern layout

| Surface | Selector (live-verified) |
|---|---|
| AppBar action tray | no stable class: locate `[aria-controls="app-user-menu"]` → `.closest('.MuiToolbar-root')` → user-menu Box `previousElementSibling` |
| Toolbar nav links | links inside `.MuiAppBar-root` (UserViewNav). `config.json` `menuLinks` render here — declarative nav injection |
| Library toolbar (2nd row) | second `.MuiAppBar-root .MuiToolbar-root` (only on library routes) |
| Drawer | `.MuiDrawer-paper` — **mobile only**; modern desktop has **no drawer** |
| Item-detail action row | `.page:not(.hide) .mainDetailButtons` — details are still legacy viewManager views on the modern layout |
| Home sections | `#indexPage .homeSectionsContainer` — React wrapper hosting the legacy hometab controller |
| Player OSD | `.videoOsdBottom .buttons.focuscontainer-x` — valid on **both** layouts |

On the **legacy layout** (`layout='desktop'`) all classic anchors are present and visible: `.headerRight`, `.headerLeft`, `.mainDrawer-scrollContainer`, `.emby-tabs-slider`/`.headerTabs`, `.homeSectionsContainer`, `.mainDetailButtons`.

Helper validity to keep in mind: `getHeaderRightContainer()` resolves `.headerRight` on the legacy layout only, with the MUI tray as the modern fallback — but that tray is **destroyed on entering `/video` and not restored on exit** (AppToolbar returns `null` there and remounts fresh), so header injection must be idempotent and re-run after leaving the player. `getSidebarContainer()`'s `.MuiDrawer-paper` is mobile-only. `native-tabs.ts`'s `.emby-tabs-slider` anchor is hidden on modern — the modern equivalents are UserViewNav links or `config.json` `menuLinks`.

#### Enforcing a layout

The user-facing **LayoutEnforcement** setting (documented for operators in [Customization](customization.md)) has exactly one server-controlled steering point: the boot loader. jellyfin-web's bundles are `<script defer>` in `<head>` and read `localStorage['layout']` at module init; the plugin loader is `<script defer>` at the end of `<body>` (`ScriptInjectionStartupFilter` injects before `</body>`). The app has therefore **already chosen its layout before any plugin code runs**, so an override cannot be applied in place — it must set `localStorage['layout']` and then do **one** reload.

This lives in `js/plugin.js` (`resolveLayoutEnforcement` / `applyLayoutEnforcement`), run from the pre-auth early public-config fetch so the login screen is covered too. It reloads **only when the device is actually painting the other layout**: a device already on (or defaulting to) the target is at most persisted explicitly, never reloaded, so `Force*` adds no reload to a fresh client, and a stored `tv` layout is exempt from Force steering entirely. Two loop guards protect it:

- A `localStorage` **read-back after the write** bails without reloading when storage silently fails to persist (ephemeral/in-memory storage — `sessionStorage` would fail in the same domain, so it cannot be the only guard).
- `sessionStorage['jc_layout_enforced']` records the target of the last enforcement reload and is cleared once the layout converges, so a later manual switch still gets one steer-back reload while a write that reverts is suppressed after the first attempt.

Detection tolerates both layout dialects (`experimental`/`modern`, `*-legacy`); the values it writes (`experimental`/`desktop`) target the shipped 12.0.0 build validated by `getSavedLayout()`. On a renamed-dialect build, `ForceLegacy` degrades to the modern default with no diagnostic.

### Script injection and navigation events

**Injection works on 12.** `/web/index.html` is served by Kestrel with `Cache-Control: no-cache` (`SRC Jellyfin.Server/Startup.cs`), and JC's request-time middleware injection is present in the served HTML. The service worker has **no fetch handler** (`WEB src/serviceworker.js`), so nothing caches or rewrites `index.html`. Jellyfin 12 has no native injection hook, so the middleware **stays**.

Globals exposed at boot: `window.Events`, `window.TaskButton`, `window.Emby.Page = appRouter`, `window.ApiClient`, `window.ServerNotifications`. Also sanctioned: the `config.json` `"plugins"` list via `pluginManager.loadPlugin`.

Navigation on v12 is not a single event — you have to key features off several signals, because none of them alone is universal:

- **`viewshow`** fires on **mount** for both legacy viewManager views (rich `detail`, includes `params`) and React `components/Page` pages (minimal `detail`, no `params`/`type`). It is **not universal**: param-only navigation (home tab switches, `/movies?topParentId=A→B`) fires **no** `viewshow`. `/details?id=A→B` does fire.
- **`HISTORY_UPDATE`** — every router state change triggers `Events.trigger(document, 'HISTORY_UPDATE', [state])` (`WEB src/components/router/routerHistory.ts`). It fires on **every** navigation including param-only, but may fire **2× per logical nav** (REPLACE normalization) — dedup by `pathname+search`. Other document events available: `THEME_CHANGE`, `REFRESH_NEEDED`, `HEADER_RENDERED`, `SET_TABS`.
- **`jc:navigate`** (the plugin's own pushState patch) fires exactly 1× per route change; `history.back()` produces one popstate + one hashchange.

!!! danger "Router deadlock — never `await Emby.Page.show()` for param-only navs"
    `Emby.Page.show(path)` returns a promise resolved only by the **next** `viewshow`. A param-only nav never resolves it, and **every subsequent `Emby.Page.show()` then hangs forever** (`appRouter.js`). This was reproduced twice.

**WebSocket and server messages.** The legacy apiclient socket is **dead** on v12: `ApiClient.isWebSocketOpen() === false`, and `Events.on(ApiClient,'message')` receives nothing. The live socket belongs to the `@jellyfin/sdk` `Api`, bridged as `ApiClient._sdk`. Plugins subscribe via:

```js
const unsubscribe = ApiClient.subscribe(['UserDataChanged', /* ... */], cb);
// cb receives { MessageType, Data } — empirically verified
```

Central client handling only re-emits `SyncPlayGroupUpdate`; data messages (`UserDataChanged`, `LibraryChanged`, timers) are consumed decentrally, largely via tanstack `invalidateQueries`. This socket is what [Live updates](#live-updates) rides on.

### Server API surface

The v12-only target lets the plugin delete a stack of 10.11 shims and use the supported endgame APIs:

- **`IUserManager.GetUsers()`** is the only stable member on 12 (no `Users` property). The reflection shim is unnecessary.
- **Provider lookups** go through `InternalItemsQuery.HasAnyProviderIds` (`Dictionary<string,string[]>`) plus the singular `HasAnyProviderId`. `ILibraryManager` + `HasAnyProviderIds` **is** the supported endgame; the raw-EF 10.11 batch path is gone.
- **Media Segments**: contribute via `IMediaSegmentProvider` (Name / GetMediaSegments / Supports / CleanupExtractedData), consume via the injectable `IMediaSegmentManager`; REST is read-only `GET /MediaSegments/{itemId}` (`[Authorize]`). `MediaSegmentType {Unknown, Commercial, Preview, Recap, Outro, Intro}`.
- **Plugin pages**: `IHasWebPages`/`PluginPageInfo` are unchanged; `GET /web/ConfigurationPages` is `RequiresElevation`, `GET /web/ConfigurationPage?name=` has **no auth attribute**. v12 web honors `PluginPageInfo.MenuIcon`. There is no first-class API for main-nav pages — Canopy's pages are routed guests of the web client's 404 fallback view (`src/enhanced/pages/`), and the former `CheckPluginPages` third-party mechanism is **removed** (Plugin Pages does not support Jellyfin 12).
- **Session messaging** (`ISessionManager`): `SendGeneralCommand`, `SendMessageCommand` (toast), `SendMessageToAdminSessions<T>`, `SendMessageToUserSessions<T>(userIds, SessionMessageType, data)`, `SendMessageToUserDeviceSessions<T>`. `SessionMessageType` is a **closed enum** — plugins cannot add types, but they **can** push `LibraryChanged`/`UserDataChanged`-shaped payloads the client already consumes natively. Wire envelope: `{"MessageId","Data","MessageType"}`.
    - `LibraryChanged` is emitted per-user, batched over `LibraryUpdateDuration`; payload `LibraryUpdateInfo {FoldersAddedTo, FoldersRemovedFrom, ItemsAdded, ItemsRemoved, ItemsUpdated, CollectionFolders}`.
    - `UserDataChanged` is batched at 500 ms; payload `{UserId, UserDataList: UserItemDataDto[]}` (includes parent aggregates).
    - Inbound: plugins may implement `IWebSocketListener`.
- **Config-save observation without static bridges**: `BasePlugin<T>.ConfigurationChanged` is raised by `UpdateConfiguration()` (the dashboard/API save path). Plugins aren't DI-registered, but a DI `IHostedService` can reach the instance via `IPluginManager.GetPlugin(Guid)` → `LocalPlugin.Instance` cast → subscribe. **Caveat:** bare `SaveConfiguration()` does **not** raise it.

!!! warning "WebSocket auth gotcha"
    v12 disables legacy authorization by migration (`20260531160000_DisableLegacyAuthorization.cs`). `?api_key=`, `X-Emby-Token`, and `X-MediaBrowser-Token` are **ignored** (a ws handshake with `?api_key=` returns 403). Only `Authorization: MediaBrowser Token=...` or the capitalized `?ApiKey=` query parameter work.

#### What the v12-only target removed or kept

| Workaround | Verdict on v12 |
|---|---|
| `UserManagerExtensions` reflection shim | **DELETE** |
| Raw-EF 10.11 batch lookup (`#if !NET10_0_OR_GREATER`) | **DELETE** |
| `SeerrCache.Instance` static + `UpdateConfiguration` flush bridge | **DELETE** → IHostedService + `IPluginManager` + `ConfigurationChanged` |
| Hand-rolled `IsAdminUser()` + JSON 403 envelopes | **CONVERT** → `[Authorize(Policy = ...)]` |
| `X-Emby-Token` / `X-MediaBrowser-Token` client header | **DELETED** — the avatar-fetch helper now sends only `Authorization: MediaBrowser Token=…` |
| Request-time `index.html` injection middleware | **STAYS** (no native hook) |
| Legacy on-disk `index.html` rewrite | keep `CleanupOldScript` only |
| `BrandingAssetStartupFilter` | **STAYS** (no server API) |
| `CheckPluginPages` (PluginPages plugin config) | **STAYS (conditional)** |
| Legacy-layout DOM fallbacks (`.headerRight` etc.) | **STAY** — they serve v12's legacy layout |

### React re-render survival

Injected UI has to survive the host's React re-renders and its legacy view cache. This matrix is empirical (modern layout, rc2, marker elements exercised against resize / websocket-driven refetch / navigation):

| Page | Anchor | In-place re-render | Navigate away → back | Strategy |
|---|---|---|---|---|
| Home | `#indexPage .homeSectionsContainer` | survives | **destroyed** (unmount, no cache) | re-inject per mount |
| Library (React, tanstack) | page body / 2nd toolbar | **survives** query refetch | destroyed | re-inject per mount + `HISTORY_UPDATE` for same-route switches (no viewshow!) |
| Item detail (legacy view) | `.page:not(.hide) .mainDetailButtons` | survives | back (POP): **survives** (3-view LRU cache); re-push: rebuilt, old marker left alive-hidden in a cached view | re-inject per `viewshow`; always scope selectors to `.page:not(.hide)` |
| Search (React) | `#searchPage` | survives live typing | destroyed | re-inject per mount |
| Video OSD (legacy) | `.videoOsdBottom .buttons` | survives OSD hide/show | — | inject once per playback session |
| Header tray (modern) | user-menu-sibling Box | survives | survives all routes **except `/video`** (destroyed on entry, not restored on exit) | idempotent, re-run after player exits |

The universal strategy is **idempotent keyed injectors** re-driven by (1) `HISTORY_UPDATE`/`jc:navigate` for every URL change, (2) `viewshow` for legacy views, and (3) the multiplexed body `MutationObserver` as a catch-all. React pages tolerate foreign appended children through any in-place re-render; only unmount kills them, and no React errors were produced by injected markers.

The item-detail view cache has three specific traps (the "loads only on revisit" bug class):

- **Up to three `#itemDetailPage` elements coexist** (`pageContainerCount = 3`, fixed round-robin slots). `document.getElementById('itemDetailPage')` returns whichever occupies the **lowest** slot — visible or not — so a visibility gate built on it goes permanently dead once two details views exist. Resolve the page through `core/details-view` (`isDetailsPageVisible()` / `getVisibleDetailsPage()`), never `getElementById`.
- On a **details→details push**, navigation callbacks (`HISTORY_UPDATE`) fire while the **outgoing** page is still visible, so `#itemDetailPage:not(.hide)`-style lookups at nav time resolve the old view. `getVisibleDetailsPage()` only returns the page once its `viewshow` recorded it for the item the URL names.
- When item data arrives, the host's `renderMiscInfo` → `fillPrimaryMediaInfo` does `elem.innerHTML = html` on `.itemMiscInfo-primary`, **destroying injected chips**. On slow servers this lands after a feature's first fill, so misc-info injectors must be re-driven by the body-observer catch-all. `.mainDetailButtons` is only class-toggled, never rebuilt, which is why button injections survive while chips vanish.

### Authorization policies

Authorization on 12 is policy-based, and the constants live in `MediaBrowser.Common.Api.Policies`. The default (bare `[Authorize]`) means authenticated + remote-access + parental schedule, with admins bypassing; `RequiresElevation` means `ClaimTypes.Role == Administrator`. Other policies include `Download`, `CollectionManagement`, `SyncPlay*`, `Subtitle`/`LyricManagement`, `IgnoreParentalControl`, `LocalAccessOrRequiresElevation`, `AnonymousLanAccessPolicy`, and `FirstTimeSetup*`.

The **empirical error contract** (the client contract JC relies on) is:

- Policy failure with a valid **non-admin** token → **403, empty body, no content-type**.
- Missing/garbage token → **401, empty body**.
- Admin API keys carry the Administrator role (they pass `RequiresElevation`).
- Client JS must branch on **status code alone** for authorization failures; app-level JSON envelopes (Seerr permission codes, etc.) remain for **business errors only**.
- Note: on 12, `GET /System/Configuration` is plain `[Authorize]` (not admin-gated) — only POST requires elevation.

### Breaking-assumption checklist

Carry these into any v12 plugin work:

1. The legacy apiclient websocket surface is dead — use `ApiClient.subscribe`.
2. `viewshow` misses param-only navigations — key features on `HISTORY_UPDATE`/`jc:navigate` too.
3. Never `await Emby.Page.show()` (router deadlock after param-only navs).
4. Present ≠ visible (hidden legacy header block on the modern layout).
5. Header-tray injections die on the `/video` round trip — idempotent re-attach required.
6. Layout value names differ between shipped 12.0.0 and master — detect by DOM, never by value.
7. `HISTORY_UPDATE` can double-fire — dedup by `pathname+search`.
8. Cached legacy views can hold stale plugin DOM alive-hidden — scope to `.page:not(.hide)`.
9. v12 ignores all legacy auth tokens (`?api_key=`, `X-Emby-Token`).

---

## REST API

Jellyfin Canopy exposes its own REST controllers under `/JellyfinCanopy/*` for external applications and scripts — checking availability, reading and writing bookmarks, proxying Seerr, and managing hidden content as an admin.

!!! note "Scope of this section"
    This documents the **external-integration surface** of the `/JellyfinCanopy/*` API — the endpoints meant to be called by external applications and scripts. Many additional admin- and UI-internal endpoints exist and are intentionally omitted here.

[Reference](reference.md) maps where each backing setting lives in the admin config page.

### Authentication

The plugin targets **Jellyfin 12 only**, and Jellyfin 12 ignores the legacy authentication tokens (`?api_key=` query parameters, `X-Emby-Token` and `X-MediaBrowser-Token` headers). Authenticate every request with the standard header:

```
Authorization: MediaBrowser Token="{your-api-key}"
```

**Error contract.** Endpoints are gated with ASP.NET authorization policies — bare `[Authorize]` for any authenticated user, `RequiresElevation` for admin-only. Authorization failures return a **bare status code with an empty body**: `401` for a missing/invalid token, `403` for a valid token without the required role. There is no JSON error envelope for authorization failures, so branch on the status code. JSON error bodies (for example, Seerr permission codes) are used for **business errors only**, on requests that already passed authorization.

### Get plugin version

Returns the plugin's installed version, no authentication required:

```bash
curl -X GET \
  "<JELLYFIN_ADDRESS>/JellyfinCanopy/version"
```

### Public configuration

The plugin serves a **public config** payload at `/JellyfinCanopy/public-config` that the client bootstraps from before login. Only settings whitelisted for public exposure are included — secrets (API keys, tokens) never appear.

Fields that would leak internal topology are additionally **redacted for anonymous / pre-login callers** and only returned once the request is authenticated:

- Seerr URLs.
- The **maintenance-mode target-user list** (the affected-user GUIDs) — returned empty pre-login.

The maintenance-mode **message** and **action** stay public, because the login page's maintenance banner legitimately needs them before a user signs in.

### Private configuration

The plugin also serves a **private config** payload at `/JellyfinCanopy/private-config` for the client's authenticated boot phase. Unlike `public-config`, this endpoint requires authentication (`[Authorize]` — any signed-in user):

```bash
curl -X GET \
  -H "Authorization: MediaBrowser Token=\"<API_KEY>\"" \
  "<JELLYFIN_URL>/JellyfinCanopy/private-config"
```

- **Administrators** receive the full private-config projection.
- **Non-admin** authenticated callers receive an empty object (`{}`) rather than a `403`, so the client still initialises but never sees admin-only fields.
- If the plugin configuration is unavailable, the endpoint returns `503`.

### User configuration payload budgets

Complete replacements for `settings.json`, `shortcuts.json`, `elsewhere.json`, and `hidden-content.json` share one server-side payload policy. The request body is bounded **before JSON model binding** for both `Content-Length` and chunked uploads; an oversized body returns HTTP `413` with `{"success":false,"code":"payload_too_large",...}` and is never deserialized, logged, cached, or written. Field/count/range failures return HTTP `400` with a stable non-value-bearing reason code. A rejection leaves the existing file and Hidden Content cache untouched.

| Payload | HTTP body | Persisted JSON | Collection limits |
| --- | ---: | ---: | --- |
| `settings.json` | 1 MiB | 1 MiB | Up to 1,000 extension properties |
| `shortcuts.json` | 1 MiB | 1 MiB | Up to 1,000 shortcuts and 1,000 extension properties |
| `elsewhere.json` | 1 MiB | 1 MiB | Up to 500 regions, 500 services, and 1,000 extension properties |
| `hidden-content.json` | 8 MiB | 7 MiB | Up to **10,000 hidden items** (intentionally sized and tested with realistic populated records for large supported libraries) |

Known settings/shortcut/Elsewhere free-text fields are capped at 512 characters. Hidden Content keys are capped at 256 characters; display fields at 512; identifiers and type/timestamp fields use narrower 32–128 character limits. Season and episode numbers accept `0` through `100000`. Legacy `series` hide scope remains accepted alongside `global`, `continuewatching`, `nextup`, and `homesections`.

Forward-compatible `[JsonExtensionData]` remains supported, but unknown JSON is recursively bounded across the complete extension map: property names 256 characters, string values 4,096 characters, depth 16, and 20,000 JSON nodes. Finally, the shared user-configuration store refuses every serialized file over 8 MiB as a caller-independent backstop. Successful logs contain metadata such as file, revision, hash, item count, and byte count—not old/new values or supplied secrets.

### Bookmark API

Bookmarks are stored **per user** under the plugin's configurations directory. The user id is normalized (dashes stripped, lowercased) to form the folder name, and the file is named `bookmark.json` (singular):

```
<plugins>/configurations/Jellyfin.Plugin.JellyfinCanopy/{userId-no-dashes-lowercase}/bookmark.json
```

The data structure is (property names are persisted as-is, in PascalCase):

```json
{
  "Revision": 7,
  "Bookmarks": {
    "unique-bookmark-id": {
      "ItemId": "jellyfin-item-id",
      "TmdbId": "12345",
      "TvdbId": "67890",
      "MediaType": "movie" | "tv",
      "Name": "Item Name",
      "Timestamp": 123.45,
      "Label": "Epic scene",
      "CreatedAt": "2026-01-03T12:00:00.000Z",
      "UpdatedAt": "2026-01-03T12:00:00.000Z",
      "SyncedFrom": "original-item-id"
    }
  }
}
```

External applications read and write bookmarks through the endpoints below. `{userId}` is the 32-character hex (`"N"` format) Jellyfin user id. Bookmark state is server-authoritative and revisioned: retain the `Revision` returned by every GET/mutation, submit it with the next operation, and rebase on the authoritative state returned with HTTP `409 Conflict`. Missing preconditions return `428 Precondition Required`. A successful mutation increments the revision once and returns the complete committed state.

!!! warning "Concurrency-contract upgrade"
    Clients written for the older unversioned bookmark API must be updated before upgrading: unversioned full replacements and operation requests now return `428 Precondition Required` instead of writing. This intentional compatibility break prevents an older/stale client from silently erasing writes acknowledged to another tab or device.

**Get bookmarks:**

```http
GET /JellyfinCanopy/user-settings/{userId}/bookmark.json
Authorization: MediaBrowser Token="{your-api-key}"
```

The response body is the complete `{ "Revision": n, "Bookmarks": { ... } }` state and the same revision is returned as a strong `ETag` (for example, `ETag: "7"`). A persistence read fault returns `503`; it is never converted to an empty state.

**Atomic batch (recommended).** Adds, updates, and deletes in one request commit as one transaction or not at all. `BookmarkId` is caller-generated and must be stable across retries so a lost acknowledgement cannot duplicate an add:

```http
POST /JellyfinCanopy/user-settings/{userId}/bookmark.json/batch
Authorization: MediaBrowser Token="{your-api-key}"
Content-Type: application/json

{
  "Revision": 7,
  "Operations": [
    { "Type": "add", "BookmarkId": "client-stable-id", "Bookmark": { "ItemId": "item-a", "Timestamp": 12.5 } },
    { "Type": "update", "BookmarkId": "existing-id", "Bookmark": { "ItemId": "item-b", "Timestamp": 30, "Label": "New label" } },
    { "Type": "delete", "BookmarkId": "old-id" }
  ]
}
```

The operation list is validated before saving and is capped at 1,000 operations. Bookmark ids are capped at 256 characters and individual bookmark string fields at 4,096 characters. A stale `Revision` returns `409` with `Revision` and `Bookmarks` containing the current server state; rebuild the intended operations against that state and retry.

Dedicated operation endpoints expose the same revision contract:

```http
POST   /JellyfinCanopy/user-settings/{userId}/bookmark.json/add
PUT    /JellyfinCanopy/user-settings/{userId}/bookmark.json/{bookmarkId}
DELETE /JellyfinCanopy/user-settings/{userId}/bookmark.json/{bookmarkId}?revision=7
```

The add body includes `Revision`, optional stable `BookmarkId`, and the bookmark fields. The update body is `{ "Revision": 7, "Bookmark": { ... } }`. All return the complete committed revision/map; add also returns `Id`, and delete returns `Removed`.

**Full replacement (specialized callers only).** The request body remains the `UserBookmark` object itself, but replacement now requires a strong `If-Match` precondition. The body `Revision` must equal the header revision. Stale replacement returns `409` without changing the file:

```http
POST /JellyfinCanopy/user-settings/{userId}/bookmark.json
Authorization: MediaBrowser Token="{your-api-key}"
Content-Type: application/json
If-Match: "7"

{
  "Revision": 7,
  "Bookmarks": { ... }
}
```

Only one quoted numeric strong ETag is accepted. Wildcard (`If-Match: *`), weak (`W/"7"`), unquoted, and comma-separated ETag-list forms intentionally return `428`: accepting a wildcard would bypass the stale-snapshot protection that this endpoint exists to enforce.

### Seerr integration

The plugin exposes proxy endpoints for [Seerr](discover.md).

!!! note "About the `X-Jellyfin-User-Id` header"
    The `X-Jellyfin-User-Id` header shown in the examples below is a client-side convention only — the server never reads it. The acting user is resolved solely from the auth token's `Jellyfin-UserId` claim, so each endpoint always acts as the token's own user. You cannot use this header to act as another user id, and it can be omitted entirely.

**Check connection status.** Reports whether the plugin can connect to any of the configured Seerr URLs using the provided API key:

```bash
curl -X GET \
  -H "Authorization: MediaBrowser Token=\"<API_KEY>\"" \
  "<JELLYFIN_URL>/JellyfinCanopy/seerr/status"
```

**Check user status.** Verifies that the currently logged-in Jellyfin user is successfully linked to a Seerr user account:

```bash
curl -X GET \
  -H "Authorization: MediaBrowser Token=\"<JELLYFIN_API_KEY>\"" \
  -H "X-Jellyfin-User-Id: <JELLYFIN_USER_ID>" \
  "<JELLYFIN_ADDRESS>/JellyfinCanopy/seerr/user-status"
```

**Perform a Seerr search.** Executes a search query through the Seerr instance for the specified user:

```bash
curl -X GET \
  -H "Authorization: MediaBrowser Token=\"<API_KEY>\"" \
  -H "X-Jellyfin-User-Id: <USER_ID>" \
  "<JELLYFIN_URL>/JellyfinCanopy/seerr/search?query=Inception"
```

**Make a request on Seerr.** Submits a media request to Seerr on behalf of the specified user. `mediaType` can be `tv` or `movie`; `mediaId` is the **TMDB ID** of the item:

```bash
curl -X POST \
  -H "Authorization: MediaBrowser Token=\"<API_KEY>\"" \
  -H "X-Jellyfin-User-Id: <USER_ID>" \
  -H "Content-Type: application/json" \
  -d '{"mediaType": "movie", "mediaId": 27205}' \
  "<JELLYFIN_URL>/JellyfinCanopy/seerr/request"
```

### Admin hidden-content API

These admin-only endpoints let an administrator view and manage what **other** users have hidden. Every endpoint requires a Jellyfin **administrator** token (enforced server-side via the `RequiresElevation` policy) **and** the **Let admins view and manage other users' hidden content** toggle (**Pages → Hidden Content → Admin Controls**) to be enabled; otherwise it returns a bare `403` (empty body). `<USER_ID>` is the 32-character hex (`"N"` format) Jellyfin user id.

**List users with hidden content.** Returns each user (except the caller) who has hidden at least one item, with their hidden-item count — used to populate the admin user-filter dropdown:

```bash
curl -X GET \
  -H "Authorization: MediaBrowser Token=\"<ADMIN_API_KEY>\"" \
  "<JELLYFIN_URL>/JellyfinCanopy/admin/hidden-content-users"
```

**Get a user's hidden content** (read-only):

```bash
curl -X GET \
  -H "Authorization: MediaBrowser Token=\"<ADMIN_API_KEY>\"" \
  "<JELLYFIN_URL>/JellyfinCanopy/admin/hidden-content/<USER_ID>"
```

**Unhide items for a user.** Removes one or more items from a user's hidden list. The body is a JSON array of item keys (an `itemId`, or `tmdb-<id>` for items not in the library):

```bash
curl -X POST \
  -H "Authorization: MediaBrowser Token=\"<ADMIN_API_KEY>\"" \
  -H "Content-Type: application/json" \
  -d '["a1b2c3d4e5f6...", "tmdb-27205"]' \
  "<JELLYFIN_URL>/JellyfinCanopy/admin/hidden-content/<USER_ID>/unhide"
```

**Hide items for a user.** Adds one or more items to a user's hidden list (**max 200 per call**; an item the user hid themselves is never overwritten). The body is a JSON array of hidden-content items:

```bash
curl -X POST \
  -H "Authorization: MediaBrowser Token=\"<ADMIN_API_KEY>\"" \
  -H "Content-Type: application/json" \
  -d '[{"TmdbId": "27205", "Name": "Inception", "Type": "Movie", "PosterPath": "/edv5CZvWj09upOsy2Y6IwDhK8bt.jpg"}]' \
  "<JELLYFIN_URL>/JellyfinCanopy/admin/hidden-content/<USER_ID>/hide"
```

---

## Live updates

Jellyfin Canopy keeps open browser sessions in step with the server without manual refreshes. The client subscribes once to Jellyfin 12's websocket (the SDK socket — see [WebSocket and server messages](#script-injection-and-navigation-events)) and fans the server's pushes out to the plugin's features.

### What updates without a refresh

| Change on the server | What happens in open sessions |
|---|---|
| **Admin saves plugin configuration** | Every open session refetches the plugin config and applies it live — toggles that drive cheap, idempotent surfaces (e.g. tag overlays) re-render in place; everything else picks up the fresh values on its next page mount. No reload needed. |
| **Watch state changes** (played/favorite/progress — from any device) | Watch-state-dependent overlays (rating/user-review tags) are rescanned so they match the new state. |
| **Library changes** (items added/updated/removed) | Newly mounted cards are tagged as usual; a coalesced rescan picks up data changes behind already-visible cards. The [Sonarr &amp; Radarr](sonarr-radarr.md) Requests page refreshes its list when a monitored download lands in the library. |
| **The plugin itself is updated** (new DLL while sessions are open) | Sessions still running the old client bundle detect the newer server version and show a **one-time toast** prompting a refresh. The toast only fires when the server version is strictly newer than the one the session loaded — never for a same-version session. |

### Honest limits

- **One reload after a plugin update.** A running page cannot hot-swap its own code; after updating the plugin, each open session needs one refresh (exactly what the update toast asks for). Everything after that reload is current.
- **Not every feature re-initializes from a config change alone.** The config values update live everywhere, but a few heavy per-page injectors only rebuild their DOM on the next navigation or page mount.
- **Native surfaces refresh on their own schedule.** Jellyfin's own UI (home rows, item details) updates via its own mechanisms; the plugin only guarantees liveness for the surfaces it draws. Where the native layout provides no refresh path, the plugin does not force one — deliberately, to avoid flicker and layout shift.
- **Fails soft.** If the live socket is unavailable, features fall back to polling and manual refresh — nothing breaks, updates are just not instant.

### Subscribing from a client feature

Client features subscribe through the live hub instead of polling:

```ts
import { LIVE, on } from '../core/live';

on(LIVE.CONFIG_CHANGED, () => { /* re-read JC.pluginConfig, re-render */ });
on(LIVE.LIBRARY_CHANGED, (data) => { /* items added/updated/removed */ });
on(LIVE.USER_DATA_CHANGED, (data) => { /* watch-state changes */ });
```

### The server push and its scoping

The server pushes through `ISessionManager` (`Services/LiveNotifierService.cs`), reusing message types the Jellyfin 12 client already consumes (`UserDataChanged`, `LibraryChanged`) plus a marked `GeneralCommand` as the plugin's own channel. That carrier command is deliberately one the native web client's `GeneralCommand` handler **ignores**, so a config-changed push never triggers real UI on non-plugin clients — a `LiveNotifierServiceTests` denylist asserts the carrier is never a command web clients act on. The websocket behavior, auth caveats, and message shapes are documented under [Server API surface](#server-api-surface).

**The push is scoped to sessions that actually run JC.** The carrier is a playback-shaped `GeneralCommand`, and while jellyfin-web provably ignores it, how a *native* client (Android, Android TV, Kodi, third-party apps) handles an unsolicited playback command is outside the plugin's control — the original broadcast to every session of every user delivered it to all of them on every config save. `Services/LiveSessionRegistry.cs` fixes the targeting:

- Every JC client boot and every hot-reload refetch calls `/JellyfinCanopy/public-config` authenticated, and the 15-minute self-update recheck calls `/JellyfinCanopy/version`. Both record the calling session's **device id** (the `Jellyfin-DeviceId` claim) into a bounded, TTL'd registry.
- `LiveNotifierService` sends the config-changed command **per registered device** via `SendMessageToUserDeviceSessions`. Native clients never call JC endpoints, so they can never be registered and never receive the carrier.
- Because the device id claim is ultimately caller-supplied (Jellyfin trusts the auth header's `DeviceId`), the registry also stores the registering **user**, and the notifier only delivers to a device when that user has a **live session on it** — a user can register pushes for their own devices, never someone else's (`SelectDeliverableDeviceIds`, unit-pinned).
- The registry is **self-healing**: a server restart empties it, open web sessions re-register within one 15-minute recheck (the recheck fetch is deliberately authenticated and keeps running after the one-shot update toast — it doubles as this heartbeat), and a session that misses a push simply picks the new config up on its next load (fail-soft).

---

## Performance rules

Jellyfin Canopy injects UI into pages the user is already looking at. Done carelessly, that means layout shift, observer storms, and CDN stalls — *jank*. Every rule below was earned by finding and fixing a real regression in this codebase; together they are the plugin's jank doctrine, and they are **enforceable in review**: a PR that violates one needs a written justification in the PR description, not a shrug.

The implementation sites are marked in the source with `// PERF(Rn):` comments — grep for a rule id to see every place it is applied:

```bash
grep -rn "PERF(R3" Jellyfin.Plugin.JellyfinCanopy/src/
```

| # | Rule | One line |
|---|------|----------|
| R1 | Pre-paint or reserved space | Injected UI is part of its anchor's first painted frame, or occupies reserved dimensions. Never insert-then-move. |
| R2 | Overlays over in-flow | Decorations on existing content are `position:absolute` — they cannot shift layout. |
| R3 | Observer budget | No feature owns a body-wide MutationObserver; use the multiplexed `JC.core.dom.onBodyMutation`. Never observe attributes body-wide. |
| R4 | One layout read per navigation | Cache layout-dependent lookups per nav; no layout reads inside observer ticks. |
| R5 | No polling | No `setInterval` for DOM detection; data polls are page-scoped, visibility-gated and push-nudged. |
| R6 | No remote assets, ever | Third-party assets go through the local asset cache (`/JellyfinCanopy/assets/`). A CDN URL in a PR fails review. |
| R7 | Single insert | Build off-DOM, insert once with content ready; late async data fades in (compositor-only), never swaps layout. |
| R8 | Sync work budget | Pre-paint hooks stay under ~2 ms per mutation batch (`performance.now()` guard); overflow goes async. |
| R9 | Fail open — late beats never | The jank rules bound *when and how* content appears, never *whether*. A readiness wait or fetch that misses its window degrades to a late, shift-free entrance — it never silently skips the content, and a transient error is never cached as an answer. |

Those nine are client-side (jank + resilience). There is also one **server-side** rule — [S1](#s1-never-block-jellyfins-synchronous-threads) — for plugin code that runs on Jellyfin's own threads (library-scan event handlers).

Several rules are backed by **source-scan guard tests** that fail `npm run test:client` on a new violation, not only on review: `src/test/perf-rules-guard.test.ts` (the R-rules), `src/test/leak-guard.test.ts` (object URLs, un-torn-down observers, unbounded TTL maps, and self-rescheduling retry loops for R3/R5), plus the non-perf `css-injection-guard` and `error-as-empty-guard` companions described under [Client security](#client-security).

### R1 — Pre-paint or reserved space

**Rule.** UI injected next to or into already-visible content must do one of two things:

- **Pre-paint:** attach in the *same mutation batch* that mounted its anchor, via `ensureInjected(key, anchorFn, buildFn, { prePaint: true })`. The shared body observer runs `prePaint` injectors synchronously inside its mutation callback — a microtask after the DOM change, before render steps — so a remounted anchor never paints a frame without its injected node.
- **Reserved space:** if the node must land after the anchor painted, it occupies its final dimensions from the first frame — a `min-width` chip sized to its typical content, or the `JC.core.ui.expandIn` one-time eased entrance (which measures the natural width, collapses to 0, expands once, then removes every inline style).

Never insert-then-move. Never insert a placeholder and later swap its width.

**Why.** A node added into flow after its siblings painted shifts every one of them — the single most visible form of jank, and exactly what the `layout-shift` performance entry counts. Pre-paint injection is *invisible*: the anchor's first painted frame already contains the node. Reserved space turns a late arrival into a paint-only change.

**The pattern to copy:**

```ts
import { ensureInjected } from '../core/dom-observer';

ensureInjected(
    'jc-my-button',
    () => findAnchor(),
    (anchor, ctx) => {
        const el = buildButton();
        anchor.appendChild(el);
        // Pre-paint mounts are in the anchor's first frame — animating them
        // would only draw attention. Post-paint mounts get the one-time
        // shift-free entrance instead of snap-shifting siblings.
        JC.core.ui!.expandIn(el, { instant: ctx?.prePaint });
        return el;
    },
    { headerTray: true, prePaint: true }
);
```

**In the tree:** `src/core/dom-observer.ts` (`runPrePaintInjectors`), `src/core/ui-kit.ts` (`expandIn`), `src/enhanced/features/random-button.ts` (header-tray button), `src/enhanced/features/details-media-info.ts` (chips reserve their typical final width — progress ring, file size, flags with explicit width *and* height), `src/seerr/issue-reporter.ts` (reserved-space entrance), `src/enhanced/native-tabs.ts` (one-time boot entrance).

### R2 — Overlays over in-flow

**Rule.** Anything that *decorates* existing content — tags on posters, badges, indicators, buttons layered on cards — is `position:absolute` inside a `position:relative` host. It is never an in-flow sibling of the content it decorates.

**Why.** An in-flow child changes its siblings' geometry every time it appears, disappears, or resizes. An absolutely positioned overlay is removed from flow: by construction it *cannot* shift layout, no matter how late its data arrives or how often it re-renders. This is what makes the tag pipeline's late fade-ins (R7) safe.

**The pattern to copy:** the overlay container is positioned absolute against the card; the host is promoted to `position:relative` only if it is `static`.

**In the tree:** `src/core/tag-renderer-base.ts` + `src/tags/*` (all four overlay families), `src/seerr/issue-reporter.ts` (issue badge over the poster).

### R3 — Observer budget

**Rule.** No feature creates its own body-wide `MutationObserver`. Watching the whole document goes through **`JC.core.dom.onBodyMutation(id, cb)`** — one multiplexed observer with a structural fast-path (attribute/text-only batches are dropped before any subscriber runs) — or, better, through navigation events (`onNavigate`, `viewshow`) when the trigger is really "the page changed". Element-scoped observers attach on the page that needs them and are torn down via lifecycle handles when it unmounts. **Never observe `attributes` or `characterData` body-wide** — not even with an `attributeFilter`.

**Why.** N separate body observers mean the browser clones every `MutationRecord` list N times and schedules N microtasks per DOM change — pure overhead that scales with feature count. Attribute observation body-wide fires on every hover, focus ring, and progress-bar tick; it turns idle pages into busy ones. The refactor collapsed four sidebar-nav observers into one shared subscriber (`onSidebarRebuild`) and deleted an always-on details-page attribute observer outright.

**The pattern to copy:**

```ts
import { onBodyMutation } from '../core/dom-observer';

const handle = onBodyMutation('jc-my-feature', (mutations) => {
    // structural changes only — the fast-path already filtered the rest
});
// page-scoped teardown:
lifecycle.track(handle);
```

`createObserver(id, cb, document.body, { childList: true, subtree: true })` routes to the same shared observer automatically; passing `attributes`/`attributeFilter`/`characterData` opts out of the multiplexer and creates a dedicated instance — which is exactly why it is banned body-wide.

**In the tree:** `src/core/dom-observer.ts` (`onBodyMutation`, `createObserver`, `onSidebarRebuild`), `src/enhanced/osd-rating.ts` (observer exists only while the player is mounted), `src/enhanced/features/details-page.ts` (replaced a dedicated attribute observer), `src/extras/colored-ratings.ts` (rides the shared structural observer).

### R4 — One layout read per navigation

**Rule.** Layout-dependent lookups (`offsetParent`, `offsetWidth`, `getBoundingClientRect`, `getComputedStyle`) are cached per navigation and invalidated by `onNavigate` — the `getHeaderRightContainer` pattern. No layout reads inside observer ticks. In loops, reads and writes never interleave: batch all reads, then all writes.

**Why.** Each of those properties can force a synchronous layout pass. Observer callbacks run many times per second while content streams into a page; a layout read inside one multiplies into continuous forced reflow. Interleaved read/write loops cause layout thrashing — every write invalidates the layout the next read has to recompute.

**The pattern to copy:**

```ts
let cached: HTMLElement | null = null;
onNavigate(() => { cached = null; });
function getContainer(): HTMLElement | null {
    if (cached && cached.isConnected) return cached;
    cached = resolveWithLayoutRead(); // the ONE read this navigation pays for
    return cached;
}
```

**In the tree:** `src/enhanced/helpers.ts` (`getHeaderRightContainer` per-nav cache), `src/seerr/seamless-scroll.ts` (IntersectionObserver only — it exists precisely to avoid layout reads on scroll).

### R5 — No polling

**Rule.** No `setInterval` to detect DOM state — mutation batches and navigation events already tell you. Polling for *data* is allowed only when all three hold:

1. **page-scoped** — starts when the page that shows the data mounts, stops on leave (lifecycle-tracked);
2. **visibility-gated** — skips ticks while `document.visibilityState === 'hidden'`;
3. **push-nudged** — a `JC.core.live` channel (`LIVE.CONFIG_CHANGED`, `LIVE.LIBRARY_CHANGED`, `LIVE.USER_DATA_CHANGED`) triggers the refresh immediately, so the poll is a fallback cadence, not the mechanism.

**Why.** An idle Jellyfin tab should cost nothing. Permanent intervals burn CPU and battery in every open session forever, and DOM polling additionally races the thing it polls for. The old colored-ratings module ran a permanent 1 Hz full-document scan; it is now mutation- and navigation-driven with zero standing timers.

**In the tree:** `src/extras/colored-ratings.ts` (poll removed), `src/core/live.ts` (the push hub — see [Live updates](#live-updates)), `src/arr/requests/data.ts` (page-scoped downloads poll).

### R6 — No remote assets, ever

**Rule.** The client never loads a static asset (font, CSS, icon, flag, theme, placeholder image) from a third-party host. Every such asset is mirrored server-side by the `AssetCacheManifest` / `AssetCacheService` pair (refreshed on a ~24 h schedule) and served from `/JellyfinCanopy/assets/<key>`; client code resolves URLs exclusively through `assetUrl()` / `flagSvgUrl()` / `flagPngUrl()` / `themeCssUrl()` in `src/core/asset-urls.ts`. **A PR that adds a CDN URL anywhere else fails review.** Adding an asset means adding it to both the server manifest and the client table — the two are kept in sync deliberately. (The operator-facing `AssetCacheEnabled` toggle, default **on**, is documented in [Customization](customization.md).)

*Exempt:* content images (TMDB posters/backdrops, YouTube thumbnails) — they are data, not assets — and hyperlinks the user explicitly clicks.

**Why.** A third-party asset adds DNS + TLS + RTT to the first paint of whatever uses it, staggers UI as pieces arrive at CDN speed, leaks every user's browsing to that CDN, and breaks the feature when the CDN changes or is blocked. Same-origin assets arrive with the page.

**The pattern to copy:**

```ts
import { assetUrl } from '../core/asset-urls';

icon.src = assetUrl('icons/sonarr.svg');   // local mirror (default) or the
                                           // registered CDN twin if an admin
                                           // disabled the cache — never a
                                           // hardcoded remote URL
```

**In the tree:** `src/core/asset-urls.ts` (the single client table), `Services/AssetCacheManifest.cs` + `Services/AssetCacheService.cs` (the mirror), and every `// PERF(R6): no remote assets` site that consumes them.

### R7 — Single insert

**Rule.** Feature DOM is built **off-DOM** — element tree or fragment fully assembled, content included — and inserted **once**. If part of the content depends on an async fetch, start the fetch *before or in parallel with* building (so the insert usually has everything), and when data genuinely lands after insert, apply it with a **compositor-only entrance** (opacity fade — the `jc-tag-fadein` pattern) into space that already exists (R1/R2). Never insert empty containers that later grow, and never swap a placeholder's size.

**Why.** Every in-flow insert is a reflow; inserting a skeleton and filling it in is two or more reflows plus a visible size change. One insert with content ready is one reflow and zero visible churn. Opacity changes composite on the GPU without layout or paint of surrounding content — a late tag fading into an absolutely positioned overlay costs nothing.

**The pattern to copy:**

```ts
const dataPromise = fetchData();          // start NOW, in parallel with build
const fragment = document.createDocumentFragment();
for (const item of items) fragment.appendChild(buildRow(item));
container.appendChild(fragment);          // ONE insert, one reflow
const data = await dataPromise;
overlay.classList.add('jc-tag-fadein');   // late data: opacity-only entrance
```

**In the tree:** `src/elsewhere/elsewhere.ts` (single insert with content — the old flow inserted empty and filled in), `src/arr/arr-links.ts` (all link buttons collect into a fragment; the whole row lands in one reflow), `src/seerr/item-details.ts` (sections built fully off-DOM, cards included), `src/enhanced/tag-pipeline.ts` (async passes fade tags in).

### R8 — Sync work budget

**Rule.** Synchronous work inside a mutation batch — pre-paint injectors (R1), priority body-subscribers, the tag pipeline's sync card pass — runs under a **~2 ms per-batch budget**, enforced with a `performance.now()` guard at the top of the loop. Work that would exceed the budget overflows to the async/idle path (where R7's fade-in makes the late arrival invisible).

**Why.** Pre-paint work executes between the DOM change and the next paint. That position is what makes it shift-free — and what makes it dangerous: every millisecond spent there delays the very frame it is trying to be part of. A budget keeps the fast path fast under worst-case pages (hundreds of cards in one batch) instead of only on the happy path.

**The pattern to copy** (from the tag pipeline):

```ts
const SYNC_SCAN_BUDGET_MS = 2;
const start = performance.now();
for (const card of addedCards) {
    if (performance.now() - start > SYNC_SCAN_BUDGET_MS) {
        queueForAsyncScan(remaining);     // overflow — never blow the frame
        break;
    }
    renderFromCacheIfResident(card);      // cache hits render pre-paint
}
```

**In the tree:** `src/enhanced/tag-pipeline.ts` (`SYNC_SCAN_BUDGET_MS`, the budgeted sync pass and its queued overflow), `src/enhanced/hidden-content/filter.ts` (synchronous hide inside the batch so forbidden cards never paint), `src/enhanced/playback.ts` (one presence probe per batch, not per record).

### R9 — Fail open: late beats never

**Rule.** R1–R8 constrain *when and how* injected content appears — they must never decide *whether* it appears. On a slow server, a slow connection, or a transient error (things JC cannot fix), the feature degrades to **arriving late**, shift-free per R1/R2/R7 — it does not silently skip the page view. Concretely:

- **Readiness waits don't give up.** A wait for a host anchor/container stays subscribed to the multiplexed body observer (R3 — no polling, no new observer) until the anchor mounts **or navigation aborts it**. A fixed "resolve null after N seconds" is a violation: on a slow host it converts *late* into *never*, and nothing re-triggers until the user navigates away and back. A generous absolute deadline is acceptable only as a leak backstop for signal-less callers, never as a UX budget.
- **Transient errors are not answers.** A failed fetch may be *remembered* only briefly (≤ 30 s), never with the TTL of a genuine "server said there is no data" response. Distinguish the two at the call site — a transport error that gets cached like an empty answer hides the feature for the cache lifetime, across re-navigations.
- **Failed prerequisites retry.** A one-shot handler whose async prerequisite fails (item lookup, status probe, module load) schedules a **bounded, backoff** retry scoped to the page view (abandoned on navigation, gated on `document.visibilityState`, capped by attempts or a deadline — the leak-guard enforces the cap). "Log and return" with nothing re-triggering is a violation. An init that runs once per session must never let a transient failure disable the feature until reload.
- **Dropped work is un-marked.** If a processed-set/dedup mark was placed before the work completed and the work is then dropped (navigation, batch failure), remove the mark so a later pass over surviving elements can retry — bounded, so an unreachable server isn't hammered.

**Why.** The zero-jank doctrine originally optimized for the fast path; on slow or flaky infrastructure its timeouts and negative caches turned into *content that never loads in until you re-navigate* — an inconsistent, trust-eroding experience worse than a late fade-in. Late content entering reserved space, an absolute overlay, or a below-the-fold single insert costs zero shift (exactly what R1/R2/R7 guarantee), so there is no jank reason to drop it. The only acceptable "never" is a genuine answer: the server said there is nothing to show, or the user navigated away.

**The pattern to copy** (readiness wait; the retry/backoff and error-TTL patterns are at the sites below):

```ts
// Wait until the anchor mounts or the page view ends — never a give-up timer.
function waitForAnchor(signal: AbortSignal): Promise<HTMLElement | null> {
    return new Promise((resolve) => {
        const found = findAnchor();
        if (found) return resolve(found);
        const handle = onBodyMutation(`my-feature-anchor-${++seq}`, () => {   // unique id per waiter
            const el = findAnchor();
            if (el) { handle.unsubscribe(); resolve(el); }
        });
        signal.addEventListener('abort', () => { handle.unsubscribe(); resolve(null); }, { once: true });
    });
}
```

**Boundaries.** R9 does not license unbounded retries or standing timers: retries carry an attempt cap or `Date.now()` budget (leak-guard-enforced), waits are torn down on navigation, and polling — where a mutation signal genuinely doesn't exist — still obeys R5 (page-scoped, visibility-gated, decaying interval). R9 changes what happens at the *end* of a bounded effort: degrade gracefully and stay recoverable, never poison state.

**In the tree:** `src/seerr/discovery/filter-utils.ts` + `src/seerr/item-details.ts` (`waitForPageReady`/`waitForDetailPageReady` — until-nav waits, unique waiter ids), `src/enhanced/features/details-page.ts` (item-type fetch retry), `src/enhanced/features/details-media-info.ts` + `src/enhanced/features/release-dates.ts` (`ERROR_CACHE_TTL` vs answer TTL, in-place bounded retries), `src/seerr/api.ts` (transport-error status TTL ≪ genuine-negative TTL), `src/seerr/issue-reporter.ts` (lazy status re-verification; per-view bounded retries), `src/elsewhere/reviews.ts` (nav-guarded decaying visibility poll — the page unhide is a class flip the structural body observer deliberately drops, so no mutation signal exists to wait on), `src/arr/arr-links.ts` (boot init retained across a slow login), `src/others/letterboxd-links.ts` + `src/enhanced/tag-pipeline.ts` (processed-set un-poisoning). Grep `PERF(R9)`.

### Server-side rules

R1–R9 are about the client. One rule governs the **server** — plugin code that runs on threads Jellyfin owns, where the cost lands on the host, not the browser.

#### S1 — Never block Jellyfin's synchronous threads

**Rule.** A handler for a Jellyfin event that fires on a hot host thread — above all `ILibraryManager.ItemAdded` / `ItemUpdated` / `ItemRemoved`, which are raised **synchronously, one item at a time, on the library-scan thread** — must do only **O(1) record-and-defer** work: cheap in-memory checks, then record an id (or bump a counter) and return. No DB query (`GetItemList`, `GetItemById`), no media probe (`GetMediaSources`), no file or network I/O. The real work runs on a debounced, off-thread worker that **coalesces** by id.

**Why.** Jellyfin invokes these handlers inline in the scan loop and waits for each to return before moving to the next item (`LibraryManager` raises them in a `foreach` on the calling thread). Whatever the handler does is added to the scan. The tag cache learned this the hard way: its handler rebuilt the changed item *and* re-resolved and rebuilt the parent Series and Season on every episode event — each a sorted "first episode" DB query — i.e. **~1.5 s of work per episode**, on the scan thread, for a library with 100k+ episodes. Measured before/after on the same items: **~1660 ms → ~113 ms per event** once the work moved off-thread.

**The pattern to copy** (`TagCacheMonitor` → `TagCachePendingChanges` → `TagCacheService`):

```csharp
// Handler runs ON the scan thread — only record ids, never resolve them here.   // PERF(S1)
private void OnItemChanged(object? sender, ItemChangeEventArgs e)
{
    var item = e.Item;
    if (item is null || !TaggableTypes.Contains(item.GetBaseItemKind())) return;
    _service.EnqueueUpdate(item.Id);            // O(1): record id + arm a debounced timer
    if (item is Episode ep)                      // SeriesId/SeasonId are in-memory props, no DB
    {
        _service.EnqueueUpdate(ep.SeriesId);
        _service.EnqueueUpdate(ep.SeasonId);
    }
}

// A debounced Timer drains the coalesced batch OFF the scan thread, resolves each id
// (GetItemById), rebuilds the entry and persists once — so a burst for one series collapses
// to a single rebuild instead of one per episode.
```

Use a short debounce with a hard max-wait cap so a continuous scan still flushes periodically, and drain any queued work on `Dispose` so a shutdown mid-window doesn't lose it.

**Enforced.** `LibraryScanEventGuardTests` fails the build when a new file subscribes to these events without being reviewed onto its allowlist. It also checks the **synchronous body of *every* reviewed subscriber** — not just `TagCacheMonitor` — against a broadened denylist of DB queries and I/O sinks (`GetItem(s)` / `GetPeople` / `QueryItems` / `GetMediaSources` / `GetImageInfo` / `GetChildren`, plus `File.*`, `SaveChanges`, `ToListAsync`, and LINQ materialization like `.First(...)`). Legitimately deferred work — the code inside a `Task.Run(...)` lambda or a named off-thread worker — is stripped before matching, so only work that would actually run on the scan thread trips the guard. A subscriber that regains inline heavy work in its synchronous prefix fails with the file and offending call named. Grep the record-and-defer sites:

```bash
grep -rn "PERF(S1)" Jellyfin.Plugin.JellyfinCanopy/
```

**In the tree:** `Services/TagCacheMonitor.cs` (record-and-defer handler), `Services/TagCachePendingChanges.cs` (coalescing set), `Services/TagCacheService.cs` (debounced off-thread flush + `Dispose` drain), `Services/SeerrScanTriggerService.cs` (counter + debounce timer), `EventHandlers/ContinueWatchingPlaybackEvents.cs` (a bulk library removal coalesces to one hidden-content prune per user for the whole batch, not one per removed item).

### Measured impact

The jank doctrine is measured, not asserted. The numbers below come from `e2e/perf/jank-benchmark.js` — a manual measurement harness (not wired into CI; methodology in its header comment). It drives a real Chromium through a fixed flow (boot → home → library → detail → search → warm library revisit → 30 s library scroll) with `MutationObserver`, `setInterval`, `layout-shift`, and `longtask` instrumentation installed **before** any page script runs. Three runs per column, medians reported.

!!! warning "Read the caveat first"
    *Before* is the pre-refactor plugin on a Jellyfin **10.11** server; *after* is this tree on Jellyfin **12**. The host client differs, so whole-page metrics (total CLS, host long tasks, boot time) are **not** apples-to-apples. The JC-owned metrics **are**: JC-attributed shifts, JC request count/bytes, JC observer/interval counts, and decoration pop-in delays measure only what the plugin does.

**JC-owned metrics (comparable across versions):**

| Metric | Before (10.11 + old main) | After (12 + fixes) |
|---|---|---|
| JC-attributed layout-shift score (whole flow) | 0.0054 | **0.0002** |
| JC-attributed shift entries (whole flow) | 16 | **3** |
| Live `MutationObserver`s created by JC (idle on home) | 27 | **3** |
| … of which body-wide | 26 | 3 |
| … of which body-wide **and attribute-observing** | 24 | **0** |
| Active `setInterval` timers owned by JC (idle on home) | 2 — a permanent 1 Hz colored-ratings poll + a 30 s requests poll running even on home | **1** — a 15-min, visibility-gated plugin-update recheck |
| JC requests at boot | 78 | **33** |
| JC bytes at boot | 3 372 662 B (3.2 MiB) | **1 624 785 B (1.5 MiB)** |
| Third-party **asset-CDN** requests, whole flow (R6) | 15 across 4 hosts (jsdelivr, cdnjs, googleapis, gstatic) | **0** (only `image.tmdb.org` content) |
| Header-button pop-in after tray paint | 3 996 ms | **1 234 ms** |
| Detail-page decoration pop-in after `.mainDetailButtons` paint | 410 ms (n=9) | 569 ms (n=12) — but into reserved space / overlays, so shift-free |
| Tag pop-in, library page (cold) | n=0 — the legacy client re-shows the cached page DOM, so the harness saw no fresh tag inserts | 138 ms (n=177), 28 rendered pre-paint |
| Tag sync-path hit rate, warm library revisit | n/a (no fresh inserts observed) | **28/177 (16 %) in the same frame as their cards**; the rest fade in at ~220 ms median — intentional per R7 |

**Host-dominated metrics (context only — NOT apples-to-apples):**

| Metric | Before (10.11 host) | After (12 host) |
|---|---|---|
| Whole-flow cumulative layout shift | 0.0872 | 0.3142 — the v12 React host shifts on its own; the JC-attributed row above isolates the plugin's share |
| Long tasks during boot | 3 / 262 ms | 8 / 840 ms — the v12 host boot pipeline is heavier |
| Long tasks during 30 s library scroll | 0 / 0 ms | **0 / 0 ms** — scrolling is clean on both |
| Boot to JC-ready | 1 543 ms | 1 926 ms — different host and different readiness gates |

**Known remainders the benchmark exposes** (each visible in a fresh run's census output):

- **R3 stragglers (resolved):** `src/arr/arr-tag-links.ts`, `src/elsewhere/elsewhere.ts`, and `src/others/letterboxd-links.ts` — once body-wide observers with `attributeFilter: ['class']` — now ride the shared `JC.core.dom.onBodyMutation` multiplexer (childList-only). No feature owns a body-wide attribute-observing observer any more, so the *after* count is **0**. The only `attributeFilter` observers left are player-scoped (`src/enhanced/playback.ts`) and element-scoped (`src/bootstrap/login-image.ts`), neither body-wide.
- **R5 note:** the one standing JC interval is `src/core/live-update.ts`'s 15-minute version recheck — visibility-gated and push-nudged (config pushes carry the version), but app-scoped rather than page-scoped.
- **Home-page first-tag latency after a cold boot** is higher on the fixed build (median ≈ 2.7 s after card mount vs ≈ 0.7 s before): home cards paint long before the bundle finishes booting, and first tags wait for the server tag-cache fetch. They fade into absolute overlays, so this costs zero shift — but it is the number to beat next.
- **Residual JC-attributed shifts** (the 0.0002 above) are micrometric, ≤ 0.0001 each: the Material Symbols icon-font swap reflowing already-injected icons at boot, the `#jc-active-streams` header button's one-time entrance, and the audio-language chip whose reserved width is close-but-not-exact to its final content.

**Re-running:**

```bash
NODE_PATH=/path/with/playwright node e2e/perf/jank-benchmark.js \
  --base http://localhost:8099 --label after --runs 3 --out results.json
# pre-refactor builds (no JC.initialized flag): add --legacy
```

---

## Client security

Jellyfin Canopy builds a lot of UI as HTML strings — cards, modals, panels, toasts — and much of what those strings interpolate comes from places an attacker can influence: Jellyfin item fields, Seerr/TMDB payloads, \*arr metadata, user names, search queries, error messages. Every one of those interpolations is a potential XSS sink. The two rules below are the escaping and CSS-sanitization doctrine that closed that class of bug across the tree; like the [performance rules](#performance-rules), they are **enforceable in review** — and, unlike them, each is also **enforced by a test** that fails the build on any unrecognized interpolation.

Non-obvious escape sites are marked in the source with `// SEC(X1):` comments:

```bash
grep -rn "SEC(X1" Jellyfin.Plugin.JellyfinCanopy/src/
```

| # | Rule | One line |
|---|------|----------|
| X1 | Escape at the interpolation | Every `${...}` that lands in HTML is a compile-time constant / trusted producer, a coerced number, or wrapped in `escapeHtml(...)` — in attribute **and** text positions. Enforced by `escape-guard.test.ts`. |
| X2 | Sanitize CSS-context values | Every config/user-derived value entering a `style="..."` attribute, a stylesheet rule, `insertRule`, `color-mix()`, or a CSS `var()` is validated — colours through `cssColorOr(...)` / `isCssColor(...)`. `escapeHtml` does **not** neutralize a CSS payload. Enforced by `css-injection-guard.test.ts`. |

### X1 — Escape at the interpolation

**Rule.** Classify every template-literal interpolation that becomes HTML (`innerHTML`, `innerHTML +=`, `insertAdjacentHTML`, `toast(...)`, or a string returned into any of those) into exactly one of three classes:

- **(a) Compile-time constant / trusted producer** — string literals, `UPPER_CASE` SVG/icon constants, the `icons` tables, `JC.icon(...)`, `assetUrl()`/`flagSvgUrl()`/`flagPngUrl()`/`themeCssUrl()`, `encodeURIComponent()`/`encodeURI()`, `JC.themer.getThemeVariables()` values, and local builder functions whose own returns pass this rule. Raw interpolation is OK — escaping plugin-owned SVG would break it.
- **(b) Numeric** — coerce at the interpolation: `${Number(x) || 0}` (style/attribute contexts especially), or provably-numeric expressions (`Math.*`, `.toFixed(...)`, `.length`, arithmetic).
- **(c) Item/API/user-derived** — **everything else**: wrap in `escapeHtml(...)` (`JC.escapeHtml` / `core/ui-kit`). In **both** attribute and text positions — `title="${escapeHtml(x)}"` *and* `<span>${escapeHtml(x)}</span>`. When in doubt, a value is class (c).

**Why.** `escapeHtml` rewrites `& < > " '`, so an escaped value cannot open a tag or break out of a double-quoted attribute — `'"><img src=x onerror=...>'` renders as inert text. Escaping *at the interpolation* (not at some upstream boundary) keeps the proof local: a reviewer — and the guard test — can look at one line and know it is safe. Numeric coercion is the same idea for style/attribute contexts where `escapeHtml` would still let hostile non-numeric strings through (`width:${x}px`).

**The pattern to copy:**

```ts
import { escapeHtml } from '../core/ui-kit'; // or JC.escapeHtml

el.innerHTML = `
    <div class="card" data-id="${escapeHtml(item.Id)}" title="${escapeHtml(item.Name)}">
        <img src="${escapeHtml(item.PosterUrl)}" style="width:${Number(item.Width) || 0}px">
        <span>${escapeHtml(item.Overview)}</span>
        ${ICON_SVG}${icons.request}${JC.icon!(JC.IconName!.STAR)}
        <ul>${items.map((i) => `<li>${escapeHtml(i.name)}</li>`).join('')}</ul>
    </div>`;
```

#### The `toast()` / `JC.t()` trap

`toast()` renders its argument via `innerHTML`, and **`JC.t()` does NOT escape its params** — it substitutes them into the translation verbatim. A dynamic value passed through `t()` into `toast()` is an XSS sink that *looks* localized and harmless:

```ts
// WRONG — subtitleName is media metadata; t() passes it through raw,
// toast() assigns it to innerHTML:
toast(JC.t!('toast_subtitle', { subtitle: subtitleName }));

// RIGHT — escape at the call site:
toast(JC.t!('toast_subtitle', { subtitle: JC.escapeHtml(subtitleName) }));
```

The same applies to every `tWithFallback(...)` helper and to error toasts — server/API error text (`error.responseJSON?.message`, `e?.statusText`) is class (c) like anything else.

#### Pre-escaping producers — do NOT double-escape

Two producers escape their **whole input first** and then add markup; their output is trusted HTML, and wrapping it in `escapeHtml` again would render entity garbage:

- `parseMarkdown(...)` — `src/elsewhere/reviews.ts` (TMDB review bodies)
- `markdownToHtml(...)` — `src/enhanced/settings-panel/release-notes.ts` (GitHub release notes)

Pass them raw text, interpolate their result raw. If you add a producer like these, it must escape its input up front the same way (and be added to the guard's `PRE_ESCAPING_PRODUCERS` list). Their bodies are **no longer trusted by name alone**: the guard verifies each pre-escaping producer escapes its whole first parameter before building any markup and never re-touches the raw parameter afterwards, so a reordered escape or a raw `${param}` slipped into the produced HTML fails the build.

#### URL fields

URL-ish values from item/API data (`posterUrl`, `href` targets, image `src`) use `escapeHtml(...)` like any other class-(c) value — that is the convention today, and it neutralizes attribute breakout. What it does **not** do is validate the URL itself (`javascript:` schemes in an `href` survive escaping). Scheme/shape validation is tracked as future work; the model to copy already exists in the tree:

- **`isSafePosterPath`** (`src/seerr/ui/cards.ts`) — validates a TMDB poster path against the exact shape TMDB returns (`/name.jpg`) before it enters a CSS `url('...')` context, with a local-asset fallback otherwise. The guard recognizes `isSafe*(x) ? ...x... : fallback` and treats the validated value as safe in the true branch.
- **`isCssColor` / `cssColorOr`** (`src/core/css-safe.ts`) — the same idea for CSS color values entering a style attribute or stylesheet rule; see [X2](#x2-sanitize-css-context-values).

New user-influenced URLs in `href`/`src` positions should prefer a validator of this shape over bare `escapeHtml`.

#### The splash-screen exception

`src/bootstrap/splashscreen.ts` is compiled to its own out-of-band IIFE that runs **before** the main bundle, so it cannot import `core/ui-kit`. It carries a local copy of `escapeHtml` as an inline `.replace(...)` chain for the admin-configured splash image URL. That is the **only** sanctioned copy — everything inside the bundle imports the one `escapeHtml` from `core/ui-kit`. (The guard recognizes the inline chain by its shape, so the exception is verified, not just tolerated.)

**Enforced.** `src/test/escape-guard.test.ts` parses every shipped `src/**/*.ts` file with the TypeScript compiler API on each `npm run test:client` and classifies **every interpolation in every HTML-bearing template literal**, plus the arguments of `toast(...)`, `insertAdjacentHTML(...)`, `innerHTML`/`outerHTML` assignments, and HTML string concatenation. An interpolation that is not recognizably one of the three classes fails the build with its `file:line` and expression text. It resolves local `const`/`let` values, tracks builder functions across files (a builder that interpolates a bare parameter raw obligates *every call site* to pass a safe value), understands `.map(...).join(...)` over constant tables, validator guards, and the producers above. Genuinely-safe-but-unprovable expressions live in a small justified allowlist **inside the test file**; a stale entry fails a companion test, so the list cannot rot. If the guard fails on your code, fix it in this order: `escapeHtml(...)` → `Number(x) || 0` → route through a recognized producer → (last resort, with justification) allowlist. The allowlist is **line-pinned** — each entry names the exact `file:line` it covers and must match exactly one finding there, so an entry can never silently blanket a *new* interpolation added elsewhere in the same file.

**In the tree:** `src/core/ui-kit.ts` (`escapeHtml`, `toast`), `src/arr/requests/render-cards.ts` + `src/seerr/more-info-modal/render.ts` (escaped card/modal builders with hostile-payload unit tests alongside), `src/seerr/ui/cards.ts` (`isSafePosterPath`), `src/bootstrap/splashscreen.ts` (the sanctioned local escaper), `src/test/escape-guard.test.ts` (the guard).

### X2 — Sanitize CSS-context values

**Rule.** A config- or user-derived value that flows into a **CSS context** — a `style="..."` attribute, a stylesheet rule, `CSSStyleSheet.insertRule`, `color-mix()`, or a CSS custom property (`var()`/`--x:`) — must be validated, not merely HTML-escaped. Colours go through **`cssColorOr(value, fallback)`** / **`isCssColor(value)`** from `src/core/css-safe.ts`.

**Why.** `escapeHtml` rewrites HTML metacharacters, but none of `& < > " '` are needed to weaponize a CSS value: `red;background-image:url(https://attacker/beacon)` contains none of them and would sail through `escapeHtml` unchanged, exfiltrating every viewer's IP to the attacker's host and breaking out of the intended declaration. `isCssColor` asks the browser (`CSS.supports`) whether the string is a valid `<color>` and rejects anything else; `cssColorOr` substitutes a safe fallback so a hostile or malformed admin value degrades to a default instead of injecting.

**The pattern to copy:**

```ts
import { cssColorOr } from '../core/css-safe';

// admin-configured accent colour entering a stylesheet rule
sheet.insertRule(`.jc-chip { background: ${cssColorOr(cfg.accent, 'var(--jc-accent)')} }`);
```

**Enforced.** `src/test/css-injection-guard.test.ts` scans the source for config/user-derived values reaching CSS sinks and fails the build on an unvalidated one. Related hardening lands in the same pass: the subtitle-style pipeline now dirty-checks its inputs so a config change can't re-inject a stale style string.

**In the tree:** `src/core/css-safe.ts` (`isCssColor`, `cssColorOr`), `src/enhanced/subtitles.ts`, `src/enhanced/settings-panel/template.ts`, `src/enhanced/hidden-content-page/admin.ts` + `render.ts`, `src/test/css-injection-guard.test.ts` (the guard).

### Surfacing errors, not swallowing them

A security-adjacent correctness rule: a data fetch that fails must **show the failure**, never silently render an empty state that looks like "no results". `src/core/fetch-error.ts` classifies a rejected fetch (`describeFetchError` for a short sanitized message, `isStructuredServerError` to tell a real backend error from a genuinely-empty result), and `src/test/error-as-empty-guard.test.ts` fails the build when a `catch` renders an empty state instead of an error state. Server/API error text is treated as untrusted (class (c)) and escaped like any other value before it reaches a toast or panel.

### Modals and global shortcuts

JC's custom overlays go through `src/core/modal-a11y.ts` (`installModalA11y`), which gives an overlay proper dialog semantics, a Tab focus-trap, Escape handling, and focus capture/restore — and, via a shared open-modal counter and the `jc-modal-open` body class, **suppresses the global keyboard-shortcut listener while any modal is open**, so typing in a modal can't fire a plugin shortcut behind it.

---

## Project structure

The plugin is one C# project (the server side) plus one TypeScript module tree (the client), compiled into a single client artifact. The only entry point the browser loads directly is `js/plugin.js` — a small loader that boots the shared `JC` namespace (`window.JellyfinCanopy`), fetches config/translations, and then loads the whole feature tree as **one esbuild bundle**, `dist/jc.bundle.js` — built on every `dotnet build` and embedded in the plugin DLL, minified in production, unminified and served fresh (no-store) in dev mode, with an external sourcemap shipping in both.

### The client (`Jellyfin.Plugin.JellyfinCanopy/src/`)

Every component lives in `src/` as a strict TypeScript ES module (own program: `tsconfig.src.json`, `npm run typecheck:src`), unit-tested with vitest (`npm run test:client`, colocated `*.test.ts`). Execution order is defined by the real `import` edges — `src/main.ts` imports each area's `index.ts` barrel, and `scripts/build-bundle.js` (esbuild) follows the graph to produce `dist/jc.bundle.js`. There is no hand-maintained script list anywhere.

```text
Jellyfin.Plugin.JellyfinCanopy/
└── src/
    ├── main.ts              # Bundle entry: imports the core modules + area barrels in dependency order
    ├── globals.ts           # The one place src/ obtains window.JellyfinCanopy
    ├── facade.ts            # The FROZEN public surface of window.JellyfinCanopy, as types
    │                        # (JEGlobal extends it — the compiler proves the contract holds)
    ├── core/                # Shared platform layer — executes before every feature module
    │   ├── navigation.ts    # One place for SPA navigation (pushState patch, HISTORY_UPDATE,
    │   │                    # hashchange/viewshow dedup — see the platform section)
    │   ├── details-view.ts  # Resolves the details page for the URL's item across Jellyfin's
    │   │                    # up-to-3 cached view slots (viewshow-tracked; fixes injections
    │   │                    # targeting a hidden/outgoing view — see PR #128)
    │   ├── lifecycle.ts     # Per-feature teardown registry (observers, intervals, listeners)
    │   ├── dom-observer.ts  # Multiplexed body MutationObserver, waitForElement, ensureInjected
    │   │                    # (keyed, idempotent, re-render-proof injection)
    │   ├── api-client.ts    # One fetch wrapper: auth headers, retry/dedup/concurrency
    │   ├── asset-urls.ts    # CDN-URL ↔ local-asset map: same-origin when the asset cache
    │   │                    # is on (AssetCacheEnabled, default ON), original CDN URL when off (R6)
    │   ├── ui-kit.ts        # escapeHtml, toast, injectCss + the theme-token MUI component kit
    │   ├── live.ts          # Live-update hub over the v12 SDK socket (JC.core.live)
    │   ├── live-config.ts   # Config hot-reload (admin saves apply to open sessions)
    │   ├── live-rows.ts     # Library/user-data pushes → coalesced tag rescans
    │   ├── live-update.ts   # Plugin self-update detection → one-time refresh toast
    │   ├── tag-renderer-base.ts  # Factory owning the shared tag-module plumbing
    │   ├── bounded-cache.ts # Size-capped, lazily-TTL-swept LRU — the one item-cache primitive
    │   ├── config-resolve.ts # PascalCase admin-config → camelCase view (admin-default resolution)
    │   ├── fetch-error.ts   # Classifies a failed fetch so callers show an error state, not empty
    │   ├── css-safe.ts      # isCssColor / cssColorOr — the CSS-context escape sink (see Client security)
    │   ├── modal-a11y.ts    # Shared modal focus-trap + global-shortcut suppression for JC overlays
    │   ├── locale.ts        # One display locale for every date/number format in a session
    │   └── *.test.ts        # Vitest unit tests, colocated (coverage ratchet in vitest.config.ts)
    ├── bootstrap/           # Out-of-band loaders compiled to their OWN dist/<name>.js files
    │   │                    # (fetched by plugin.js separately — before login / before the bundle)
    │   ├── splashscreen.ts / login-image.ts / translations.ts
    ├── enhanced/            # Core features. Flat singles: config, events, playback, subtitles,
    │   │                    # pausescreen, themer, icons, native-tabs, osd-rating, tag-pipeline
    │   ├── features/        # Split feature modules (random button, details page, release dates,
    │   │                    # remove-home, remove-multiselect)
    │   ├── settings-panel/  # Split settings-panel modules (entry points, styles, panel, sections)
    │   ├── bookmarks/       # Bookmarks + the bookmarks library page (library-*.ts)
    │   ├── hidden-content/  # Hidden-content engine (data, save, filter, dialogs, panel, buttons)
    │   ├── hidden-content-page/  # Hidden-content management page (state, render, cards, admin)
    │   └── spoiler-guard/   # Spoiler Guard client: detail/movie/collection toggle button, Seerr
    │                        # discovery toggle, per-user state + overrides, settings-panel tab,
    │                        # disable-confirm dialog/snooze, soft image-refresh on toggle, and the
    │                        # live-update-driven watched-refresh (UserDataChanged). Blur/strip is server-side
    ├── seerr/          # Seerr integration. Flat singles: api, request-manager, seerr,
    │   │                    # seerr-status, modal, item-details, issue-reporter, seamless-scroll,
    │   │                    # hss-discovery-handler
    │   ├── discovery/       # Discovery rows: base + filter-utils + {genre,tag,network,person,collection}.ts
    │   ├── more-info-modal/ # Split media-details modal (styles, data, seasons, badges, render,
    │   │                    # actions, actions-tv, init + internal.ts shared state)
    │   └── ui/              # Split card/request UI (icons, styles, popover, badges, cards, buttons,
    │                        # quota, results, request/season modals + internal.ts shared state)
    ├── arr/                 # Sonarr/Radarr integration. Flat singles: arr-links, arr-tag-links,
    │   │                    # arr-globals
    │   ├── calendar/        # Calendar page (styles, data, render-*, actions, init, event-date)
    │   └── requests/        # Requests page (styles, data, render-*, actions, init)
    ├── tags/                # Tag renderer specs over core/tag-renderer-base + enhanced/tag-pipeline
    ├── elsewhere/           # Streaming-availability + reviews
    ├── extras/              # Active streams, colored ratings/icons, theme selector, plugin icons
    ├── others/              # Letterboxd links
    ├── types/               # jc.ts (JEGlobal — the typed window.JellyfinCanopy), host globals
    └── test/setup.ts        # Vitest bootstrap stub (what plugin.js provides in the real client)
```

Feature-internal state is shared through real module imports (typed `surface.d.ts` files / interface augmentations where a surface crosses files). The legacy `JC.internals` bag is gone; the only global surface is the typed `window.JellyfinCanopy` facade (`src/facade.ts`).

### The loader and locales (`Jellyfin.Plugin.JellyfinCanopy/js/`)

The `js/` tree is no longer where features live — it holds exactly three things:

```text
Jellyfin.Plugin.JellyfinCanopy/
└── js/
    ├── plugin.js            # THE entry point: boots JC, loads config + translations,
    │                        # then loads dist/jc.bundle.js (no per-file fallback)
    ├── core/globals.d.ts    # Ambient host-global types for the // @ts-check'd loader
    └── locales/             # 26 locale JSON files, en.json is the base; validated by
                             # scripts/validate-translations.js (npm run validate-translations) in CI
```

Everything the browser runs comes from five served artifacts: the loader (`/JellyfinCanopy/script`), the bundle (`/JellyfinCanopy/dist/jc.bundle.js`), and the out-of-band bootstrap files (`dist/splashscreen.js`, `dist/login-image.js`, `dist/translations.js`). Per-file serving of feature scripts no longer exists.

!!! note "Translations are a local-JSON validate flow"
    Locales are plain JSON files in `js/locales/`, with `en.json` as the base. `scripts/validate-translations.js` (`npm run validate-translations`) validates every locale against the base in CI — that is the whole workflow; there is no external translation-platform round trip.

### Server side (`Jellyfin.Plugin.JellyfinCanopy/`)

```text
Jellyfin.Plugin.JellyfinCanopy/
├── JellyfinCanopy.cs        # Plugin class: script-tag injection, plugin pages registration
├── PluginServiceRegistrator.cs # DI: services, named HttpClients, startup filters, file logger
├── Controllers/               # One controller per feature area over JellyfinCanopyControllerBase.
│   │                          # Admin-only endpoints use [Authorize(Policy = Policies.RequiresElevation)]
│   │                          # — authorization failures are bare 401/403 (empty body, see REST API)
│   ├── ConfigController.cs    # public/private config (driven by SettingDescriptors), loader/bundle/locale serving
│   ├── AssetsController.cs    # Serves locally cached third-party assets (/JellyfinCanopy/assets/{key}) so browsers never hit a CDN
│   ├── SeerrProxyController.cs / SeerrUserController.cs
│   ├── ArrLinksController.cs / ArrCalendarController.cs / ArrRequestsController.cs
│   ├── ArrSearchController.cs # Admin-only interactive Sonarr/Radarr search / manage surface (arr/search/*)
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
│   │                          # UserConfigurationStore owns three read tiers: LENIENT (GetUserConfiguration,
│   │                          # any fault → new T(), for ordinary display settings), STRICT (RMW writes,
│   │                          # corrupt → backup + throw), and the TYPED policy read (ReadUserConfiguration →
│   │                          # UserConfigReadResult classifying Missing/Valid/Corrupt/Unavailable). Security
│   │                          # enforcement (Hidden Content, Spoiler Guard) uses the typed read so a corrupt or
│   │                          # unavailable file retains last-known-good or fails CLOSED instead of failing open
│   ├── PersistedJson.cs       # System.Text.Json options replicating the legacy on-disk tolerances
│   └── configPage.html + config-page.js  # Admin page; simple fields bind via data-config-key
├── Services/                  # Seerr cache/scan/watchlist, Seerr parental-rating result filter,
│   │                          # auto-request watchers (AutoRequest/AutoRequestRetryPolicy —
│   │                          # transport-only retry / already-requested handling), arr tag sync,
│   │                          # maintenance mode, startup filters (script injection, branding)
│   ├── LiveNotifierService.cs # Pushes live updates (config-changed etc.) to the sessions
│   │                          # registered as running the JC client (via ILiveSessionRegistry;
│   │                          # see the Live updates section)
│   ├── LiveSessionRegistry.cs # Registry of sessions running the JC client — scopes live pushes
│   ├── Identity/              # RequestIdentityService — the plugin-wide "who is making this request?"
│   │                          # ladder (authenticated token → per-user ?tag= identity marker →
│   │                          # jc-spoiler-uid cookie → session-by-IP candidates), returned with a
│   │                          # confidence tier so consumers pick single-user vs fail-closed posture
│   └── SpoilerGuard/          # Spoiler Guard server core: ImageBlurService (SkiaSharp Gaussian blur +
│                              # stock-card render + pre-encoded fail-closed JPEG, cached),
│                              # SpoilerBlurImageFilter (per-user image-byte replacement over the Image/
│                              # Trickplay routes), SpoilerFieldStripFilter (metadata strip/rewrite honoring
│                              # per-user overrides), SpoilerIdentityService + SpoilerIdentityTagFilter
│                              # (per-user "-jeu" markers stamped into DTO image tags — the reverse-proxy-
│                              # safe identity channel), SpoilerUserResolver (spoiler-state load + identity
│                              # delegation), SpoilerSeerrPendingPromoter (pending pre-arm → real protection)
├── EventHandlers/             # Server-side Jellyfin event subscribers (playback events;
│                              # SpoilerAutoEnableEvents = auto-enable Spoiler Guard on a fresh S1E1 play)
├── Data/ItemLookupService.cs  # Provider-id lookups via the supported ILibraryManager query surface
├── Helpers/                  # Pure helpers: ArrIdHelper (zero-id normalize + per-instance id namespacing),
│                              # ArrUrlGuard (SSRF guard: metadata/rebind blocked, LAN allowed),
│                              # Arr/ArrReleaseDate (date-only vs instant calendar release contract),
│                              # Seerr/TmdbProxyPathClassifier (deny-by-default raw-TMDB gate)
├── ScheduledTasks/ · Model/ · Logging/ · PluginPages/
└── dist/                      # esbuild output (generated at build time, never committed)
```

The project targets **Jellyfin 12 / net10.0 only** and builds with `TreatWarningsAsErrors` — the build is warning-free by contract.

### Development tooling

These are the commands and suites you will touch day to day. Run
`./verify.sh lint` on its own line: it reports lint findings and warning-cap
breaches as advisory while preserving tooling failures; every other command
below remains blocking.

Node and npm are build inputs, including for an ordinary `dotnet build` because
MSBuild generates and embeds `dist/**`. Run `nvm install && nvm use` from the
repository root, then `npm run check:toolchain`; `.nvmrc`, `packageManager`, and
`engines` are one exact, tested contract shared by local builds, CI, E2E, and
release. MSBuild rejects a missing or different runtime before `npm ci`.

- `npm run typecheck:src` / `./verify.sh lint` / `npm run test:client` — strict type check, advisory ESLint reporting, and vitest unit tests for the `src/` tree. `npm run test:client:coverage` runs that complete suite once with the `src/core` ratchet; `npm run test:server:coverage` does the same for xUnit and Cobertura. Do not precede either coverage command with its plain test command: the coverage run is the test evidence. Client and server coverage use the exact repeated-clean measurements in `scripts/coverage-baselines.json`; a one-line instrumentation tolerance permits negligible tool variance, while coverage loss, scope drift, and an unrecorded coverage gain fail with measured-versus-required diagnostics. A legitimate scope change updates that artifact explicitly in the reviewed change. Use raw `npm run lint` only when you specifically need ESLint's unmodified exit code.
- `npm run build:bundle` — the client bundle (also run automatically by the C# build); `npm run watch` rebuilds it (unminified) on every source change. CI compares SHA-256 manifests from independent plugin/client jobs, and xUnit compares every generated `dist/**` file with the exact resource bytes embedded in the DLL.
- `npm run syntax` / `npm run typecheck` — the blocking syntax inventory parses every raw `js/**` resource, the separately served admin script, and every executable inline bootstrap in `Configuration/configPage.html`, with class counts that fail closed on inventory shrink; opt-in `@ts-check` covers the classic loader. Generated `dist/**` remains owned by the blocking esbuild bundle instead of being redundantly parsed as source.
- `Jellyfin.Plugin.JellyfinCanopy.Tests/` — xUnit tests, including golden snapshots for the config payloads and on-disk user-file formats, plus a line-coverage ratchet (`scripts/check-dotnet-coverage.js`). Its `Configuration/` tests bridge the `SettingDescriptors` registry to both ends of the admin config page over one shared source parser (`ConfigPageSource.cs`, read by both directions so they can never drift): `ConfigControlCoverageTests` fails if any admin-settable descriptor backed by a real `PluginConfiguration` property has no config-page control (an admin default stuck at its hardcoded value), and `ClientConfigKeyLivenessTests` scans the shipped client source and fails if any `JC.pluginConfig.X` read is not a projected (`Public`/`Private`) descriptor key (a client knob that is always `undefined`).
- `src/test/` — cross-cutting **guard tests** that parse the shipped source and fail on a whole *class* of regression, not just one instance: `escape-guard` (HTML-injection, incl. an escape-first check of pre-escaping producers), `css-injection-guard` (CSS-context values), `leak-guard` (object URLs, observers, TTL maps, unbounded retry loops), `perf-rules-guard` (the R-rules), `error-as-empty-guard` (fetch errors surfaced, not swallowed), `locale-guard`, `ratings-css`, `injected-css-balance`, `legacy-auth-header`, `plugin-loader`, and `build-scripts`. The retired PluginPages HTML no longer ships on Jellyfin 12; admin-page inline JavaScript is owned by the blocking `scripts/check-syntax.js` inventory. Server-side, `LibraryScanEventGuardTests` scans every reviewed scan-thread subscriber's synchronous body (see [S1](#s1-never-block-jellyfins-synchronous-threads)).
- `e2e/` — the committed Playwright suite (`npm run e2e`) + `e2e/docker/` (dockerized, seeded Jellyfin unstable/nightly for CI and local runs). The required lane pins one nightly by immutable multi-platform digest; the separate advisory lane follows the mutable `unstable` tag. Required CI uses six isolated native file shards, each with one serial browser worker and an explicitly verified two-CPU Jellyfin quota. Jellyfin, the Node integration fixture, Playwright, and Chromium are pinned by image digest or package lock. A test-only Node service supplies deterministic Seerr, Radarr, and TLS TMDB responses on the private Compose network; each seed generates a short-lived CA in disposable state, so required integration coverage needs no personal secret or third-party network. The committed `e2e/required-test-inventory.json` is exact: the reporter and aggregate fail every runtime skip, flaky/failed test, missing or unexpected test, duplicate shard, stale SHA/run artifact, and inventory drift. The stable aggregate blocks pull requests and main pushes; `release.yml` calls the same workflow and cannot publish the tag SHA until it passes. The separate scheduled/manual latest-nightly compatibility workflow is advisory and cannot weaken the digest-pinned gate.

  Browser-driven specs send collected primary-page failures through the shared `assertNoRuntimeErrors` net in `e2e/fixtures/auth.ts`, or through a narrowly documented adapter around it: the net fails on any un-whitelisted console error / pageerror, every HTTP 5xx response, and, because Chromium's generic 40x console line carries no url, any 4xx response whose url is not on the known-legacy `ALLOWED_4XX_URL` allowlist (a real broken plugin endpoint). Five-hundred responses are sticky across collector resets, and fixture teardown blocks any unacknowledged 5xx even after a runtime skip or early failure, so login, reload, and multi-user phase boundaries cannot erase them. Specs with a custom console gate apply the same 5xx rule; intentional routed 5xx probes must first prove their exact evidence and then acknowledge those same collected objects. The one routed Seerr 502 exception is scoped to that exact probe. Auxiliary and Node/API-only request paths either use a collector or explicitly check/throw on non-success status. `e2e/console-net.spec.ts` pins the URL/method-aware HTTP detector, sticky reset/teardown behavior, and structured console-source evidence. Alongside the boot / navigation / panel / live-update / tag specs, the security- and persistence-sensitive flows have their own: `arr-requests-parental.spec.ts` (the Requests page applies the caller's own parental limit server-side; an admin bypasses it), `search-tags.spec.ts` (`DisableTagsOnSearchPage` hides *every* tag family on the search page, not just genre), `settings-persist.spec.ts` (a per-user setting round-trips through the server across a reload), and `non-admin.spec.ts` (core surfaces from a non-admin session, where per-user gating bugs live). Readiness probes remain useful for exploratory runs against arbitrary servers, but a missing required integration fails the inventory gate instead of becoming accepted coverage.

`account-switch.spec.ts` calls the real `Dashboard.logout()` and preserves its
two concurrent, exact same-origin `POST /Sessions/Logout` requests. The
digest-pinned nightly includes idempotent session deletion, so both real host
calls run without harness serialization. The first returns an empty `204`; the
duplicate returns an empty `204` if it authenticates before revocation or `401`
if it reaches authentication afterward. Any 5xx remains blocking while Canopy's
no-reload identity lifecycle is tested. Failed E2E jobs pass server logs through the tested
`scripts/e2e/sanitize-jellyfin-log.js` credential sanitizer, using the
Playwright start time when available and a bounded 200-line tail fallback when
seeding fails or the marker is unavailable.
- `e2e/perf/` — hand-run (not CI) measurement tools that drive a real Chromium against a live server: `jank-benchmark.js` (aggregate jank/CLS/long-task/pop-in numbers behind [Measured impact](#measured-impact)) and `capture-traces.js` (`npm run perf:trace`) — the trace-capture harness described under [Performance trace capture](#performance-trace-capture).
- `node scripts/new-feature.js <name>` — the paved-road scaffolder: generates a typed client module, a controller, an e2e spec stub, and a docs stub, wired into the area barrel (see `CONTRIBUTING.md`).
- `scripts/release/` — release packaging + manifest generation/validation (see `RELEASING.md`).

### Local sharded E2E

`npm run e2e:local` is the opt-in fast path for running the complete dockerized
Jellyfin unstable/nightly inventory on a Linux workstation. It builds the Release plugin once
and fans the suite out through Playwright's native file sharding. The default is
four independent servers with one serial browser worker and a 2-CPU Docker quota
per server:

```bash
npm run e2e:local
npm run e2e:local -- --shards 6
npm run e2e:local -- --shards 4 --cpus-per-server 4  # exploratory, not parity
```

Keep 2 CPUs per server for evidence comparable with the official E2E profile.
That quota is a ceiling, not a reservation: the four-shard default permits up to
eight Jellyfin CPU threads, while the build, Chromium processes, and host Docker
work consume resources outside those server quotas. The runner warns when its
CPU plan exceeds detected logical CPUs, when current `MemAvailable` is below its
per-shard guideline, or when the host is already using swap. Counts above four
are deliberately explicit; reduce the count if memory pressure causes swapping.

The default hermetic mode enforces the same exact pass/zero-skip inventory as
CI and aggregates every shard before reporting success. Supplying
`--allow-external-integrations` deliberately switches to exploratory mode:
real services may differ or rate-limit, so that run is not parity evidence.

Every shard receives a random Compose project, loopback-only dynamic port,
marker-owned state tree, and Playwright output directory. Cleanup targets those
exact projects and reports teardown failure as a run failure; it never prunes or
name-matches unrelated containers. The runner is Linux-only and depends on a
host `ffmpeg` plus GNU `setsid` and `timeout` for bounded process-group shutdown.
Each encoder is limited to two threads so media generation cannot silently use
every host CPU outside the Jellyfin container quotas. Seed evidence records both
the requested CPU count and Docker's applied `HostConfig.NanoCpus` value; a
mismatch fails before browser tests begin.

For the single-server seed, non-loopback publication is intentionally noisy
and exceptional. It requires `JF_BIND_ADDRESS=<numeric-ip>`,
`JF_ALLOW_NON_LOOPBACK=true`, and nondefault values for both seeded usernames
and passwords. Do not publish the documented test credentials outside the
host.

TMDB and Seerr variables are scrubbed for the default hermetic run. The
`--allow-external-integrations` flag forwards them deliberately, but parallel
shards can then rate-limit or mutate the same external service and the result is
not parity evidence. Per-run output is retained beneath
`e2e/test-results/local-<run-id>/`. The runner disables Playwright tracing (a
trace can contain login arguments and tokens) and removes any retained file
that contains one of its random passwords. Random usernames are redacted in
text diagnostics; matching binary artifacts are removed. Other diagnostic data
may still be sensitive, so keep artifacts local and do not upload or share them
without inspection and redaction.

---

## Performance trace capture

`e2e/perf/capture-traces.js` is a hand-run developer tool that drives a **real Chromium** (Playwright) through realistic navigation scenarios and captures a full **Chrome DevTools performance trace** per scenario — a `.json.gz` you drop straight into the DevTools **Performance** panel ("Load profile") to see the timeline, flame chart, network waterfall, and screenshots for a real user flow.

It is **not** wired into CI. Like [`jank-benchmark.js`](#measured-impact) it is a measurement tool you run by hand against a live server. Where the jank benchmark reduces a run to aggregate jank numbers, this harness keeps the whole trace so you can inspect exactly *when* each `/JellyfinCanopy/*` request fired and how injections raced late server responses.

The highest-value scenario is **`details-to-details`**: hopping from one item detail straight into another reproduces a real bug class — header/detail injections that race a late server response. That class only shows up when responses land late, which is why the [slow-server flags](#slow-server-emulation) exist.

### Prerequisites

- A live Jellyfin 12 server with the plugin installed. The disposable seeded server from `e2e/docker/` is ideal:

    ```bash
    dotnet build Jellyfin.Plugin.JellyfinCanopy/JellyfinCanopy.csproj -c Release
    bash e2e/docker/seed.sh            # → http://127.0.0.1:8100 (admin jc_arradmin)
    # …run captures…
    docker compose -f e2e/docker/compose.yml down -v
    ```

- A resolvable `playwright`. The harness follows the e2e suite's `NODE_PATH` convention — point `NODE_PATH` at an install that has `playwright` (with its Chromium downloaded):

    ```bash
    export NODE_PATH=/path/with/node_modules
    ```

### Running

```bash
# All scenarios, defaults (JF_BASE_URL or http://127.0.0.1:8100):
npm run perf:trace

# A subset (positional scenario names):
npm run perf:trace -- details-to-details back-forward

# List scenarios:
npm run perf:trace -- --list

# A slow-server run (see below):
npm run perf:trace -- details-to-details --latency 300 --cpu 4
```

Each output is written to `e2e/perf/traces/<scenario>-<timestamp>-<seq>.json.gz` (git-ignored), where `<seq>` is the per-run invocation index. That suffix means repeating a scenario name (`npm run perf:trace -- details-to-details details-to-details`) writes **two distinct** files instead of the second overwriting the first. The trace is written **before** analysis, so an analysis error never costs you the capture.

Value-taking flags (`--out`, `--latency`, `--cpu`, `--download`, `--base`, `--user`, `--pass`, `--scenarios`) fail fast with a one-line error and a non-zero exit when their value is missing (end of args, or the next token is another flag) — rather than crashing or silently falling through to a default run.

#### Flags

| Flag | Default | Meaning |
|------|---------|---------|
| `--base <url>` | `JF_BASE_URL` or `http://127.0.0.1:8100` | server under test |
| `--user` / `--pass` | see [Environment](#environment) | login credentials |
| `--out <dir>` | `e2e/perf/traces` | output directory |
| `--cpu <N>` | `1` | CPU throttle rate (`Emulation.setCPUThrottlingRate`) |
| `--latency <ms>` | `0` | added network latency (`Network.emulateNetworkConditions`) |
| `--download <kbps>` | `0` (unlimited) | download throughput cap |
| `--headed` | headless | show the browser |
| `--list` | — | print the scenario list and exit |

Positional arguments are scenario names; with none, every scenario runs in order.

#### Environment

Matches `e2e/fixtures/auth.ts` and `e2e/docker/seed.sh`:

| Var | Default | Meaning |
|-----|---------|---------|
| `JF_BASE_URL` | `http://127.0.0.1:8100` | server under test |
| `JC_TRACE_USER` → `JF_ADMIN_USER` → `jc_arradmin` | | login user (first set wins) |
| `JC_TRACE_PASS` → `JF_ADMIN_PASS` → `Test669Pw!x` | | login password |

### Scenarios

Each scenario logs in through the web client's own `ApiClient` (with the same session-clobber retry the e2e suite uses), waits for `window.JellyfinCanopy.initialized === true`, then drives a real flow. Real card/button clicks are used where feasible, falling back to router navigation only when a click target genuinely can't be resolved (e.g. a bare seed with no TMDB has empty "More Like This" rows). Missing content **skips** the scenario with a logged reason instead of failing the run.

| Scenario | Flow |
|----------|------|
| `cold-load` | fresh page load straight onto home (the boot is inside the trace) |
| `home-to-details` | home → click a library card → item details |
| `details-to-details` | details → click a More-Like-This card → details, **twice** (the high-value bug repro) |
| `back-forward` | build a details→details history, then browser Back (POP) twice, Forward once |
| `library-browse` | home → library → scroll → open an item → back |
| `search-flow` | open search, type a query, open a result |
| `series-drilldown` | series details → season/episode → back up |
| `revisit` | visit details A, navigate home, revisit A (warm-cache re-injection) |
| `playback-roundtrip` | start playback, wait ~5 s, exit the player back to details (the `/video` round trip destroys the header tray — re-injection must recover) |

Each scenario is a fresh browser + login (trace capture is browser-global in Playwright, so isolating per scenario keeps the traces clean).

`cold-load` is special: its boot reload happens **inside** the trace window, so it can't lean on the login helper's reload-retry. Instead, after the traced reload it checks for the same clobbered-session bounce (session gone / no `getCurrentUserId()`); on a bounce it **discards that trace and re-runs the whole scenario** — new browser, re-login, re-trace — up to 3 attempts, matching the login helper's attempt count. A trace is only kept once the boot lands authenticated.

### Slow-server emulation

`--cpu` and `--latency`/`--download` are applied **only for the scenario window** — login and setup run at full speed, then throttling is enabled via a CDP session right before tracing starts. This is deliberate: the late-response bug class only appears while the *user is navigating* under slow conditions. In a real run `--latency 300 --cpu 4` pushes `/JellyfinCanopy/*` request durations from ~70 ms to ~300–430 ms and inflates long-task time several-fold, surfacing races that a fast local server hides.

### Reading a trace

**In DevTools:** open Chrome → DevTools → **Performance** → the **Load profile** button (up-arrow icon) → pick the `.json.gz` (DevTools loads gzipped traces directly). You get the full timeline: main-thread flame chart, the **Network** track (find `/JellyfinCanopy/*` requests and see what they were waiting behind), **layout shifts**, **long tasks**, and the **screenshots** filmstrip captured during the flow.

**The printed summary** (per scenario, from parsing the same trace in-process):

```
--- details-to-details summary ---
  trace: e2e/perf/traces/details-to-details-….json.gz (830.0 KiB gz, 21132 events, ~6385ms window)
  requests: 24 total, 2 to /JellyfinCanopy/*
     +1128ms     79ms  200       /JellyfinCanopy/tag-cache/…?since=…
     +3793ms     68ms  200       /JellyfinCanopy/tag-cache/…?since=…
  long tasks >50ms: 2 (1130.5ms total); top 1065ms@+40, 65ms@+1322
  console errors: 0 (none)
```

- **request lines** — every `/JellyfinCanopy/*` request, sorted by start offset: `+<offset from trace start>  <duration>  <HTTP status>  <path>`. Reconstructed from the trace's `ResourceSendRequest` / `ResourceReceiveResponse` / `ResourceFinish` events keyed by `requestId`. A `FAIL` marker flags a network failure or a `>= 400` status.
- **counts** — total requests in the window vs. how many hit the plugin, plus a failed count.
- **long tasks >50 ms** — count, total, and the top few by duration with their offsets (from `RunTask` events). These are your main-thread stalls.
- **console errors** — collected via `page.on('console')` / `pageerror` for the traced window only.

### Limitations

- **Chromium only** — Playwright's `browser.startTracing` (and the CDP throttling) are Chromium-only; the harness always launches Chromium.
- **Content-dependent** — scenarios use whatever the server actually has. On a bare seed (no TMDB) the "More Like This" rows are empty, so `details-to-details` falls back to router navigation between the seeded movies (still a real detail→detail hop, just not click-driven). A single-item library skips the multi-hop scenarios.
- **Not a regression gate** — there are no assertions; this is a measurement and investigation tool, not a pass/fail check. Use the e2e suite and the `perf-rules-guard` tests for gating.
- **Trace size** — a multi-navigation scenario with CPU profiling and screenshots is ~0.8–1.3 MiB gzipped (~20k–35k events). Output is git-ignored.
