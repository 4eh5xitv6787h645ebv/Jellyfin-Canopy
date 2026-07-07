# Migrating to v12

From version 12, Jellyfin Enhanced supports **Jellyfin 12 only**. This page covers who should upgrade, what happens to your data, and what (little) changes for you.

## Who should upgrade

| Your Jellyfin server | What to do |
|---|---|
| **Jellyfin 12.x** | Upgrade to Jellyfin Enhanced 12.x — this is the only supported combination going forward. |
| **Jellyfin 10.11** | Stay on the final **11.x** release line. **No action needed**: the plugin repository manifest keeps serving the last 11.x release to Jellyfin 10.11 servers, and your server's catalog will never offer you an incompatible 12.x build (Jellyfin filters plugin versions by their target ABI). |

There is no need to change your repository URL — the same manifest serves both release lines.

## What carries over automatically

**Everything.** Upgrading the plugin (or upgrading your server to Jellyfin 12 and then the plugin) preserves all data with no migration step:

- **Per-user settings** — every Enhanced panel setting
- **Keyboard shortcuts** — including custom bindings
- **Hidden content** — all hidden items and hidden-content settings, for every user
- **Bookmarks** — timestamps, labels, sync data
- **Reviews** — user reviews and ratings
- **Admin plugin configuration** — the whole Dashboard → Plugins → Jellyfin Enhanced configuration

The on-disk formats of these files are **unchanged and frozen**: the plugin's test suite round-trips real 11.x-era user files and pins the exact serialized output, so a format drift fails the build before it ever ships. Downgrading back to 11.x (together with your server) would also find its data intact.

## What changed for user-script authors

If you inject your own snippets that build on Jellyfin Enhanced, three things matter:

1. **`window.JellyfinEnhanced` is the stable public surface — and it is now typed.**
   The frozen contract lives in [`src/facade.ts`](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Enhanced/blob/v12/main/Jellyfin.Plugin.JellyfinEnhanced/src/facade.ts) (`JellyfinEnhancedPublicApi`). Its members will not be removed or renamed:

    - `JE.core.*` — the platform layer: `navigation`, `lifecycle`, `dom`, `ui`, `api`, `tagRenderer`, `live`
    - `JE.pluginConfig` / `JE.currentSettings` — admin config and resolved per-user settings
    - `JE.translations` / `JE.t()` — the active translation table and lookup
    - `JE.pluginVersion` — the loaded plugin version
    - `JE.initialized` — boot-complete marker (automation should wait on this)
    - `JE.escapeHtml()` / `JE.toast()` — HTML escaping and toast notifications
    - `JE.customPlugins.refresh()` — custom sidebar plugin links

2. **`JE.internals` is gone.** The legacy `JE.internals.<feature>` bags were private cross-file state for the old classic-script tree; the TypeScript modules share state through real imports now. Anything you were reaching into via `JE.internals` was never public — if you depended on something there, [open a discussion](https://github.com/n00bcodr/Jellyfin-Enhanced/discussions) about promoting an equivalent to the facade.

3. **Per-file script serving is gone.** Feature code is no longer served as individual `/JellyfinEnhanced/js/<area>/<file>.js` files — the whole client ships as one bundle (`/JellyfinEnhanced/dist/je.bundle.js`) loaded by the one remaining loader script. Don't fetch or patch individual plugin files; build on the `window.JellyfinEnhanced` facade instead.

Also note for anything calling the plugin's HTTP API directly: Jellyfin 12 ignores the legacy auth tokens (`?api_key=`, `X-Emby-Token`), and authorization failures now return bare `401`/`403` responses with empty bodies. See [API — Authentication](../advanced/api.md#authentication).

## Admin notes

- **The configuration page is unchanged.** Same place (Dashboard → Plugins → Jellyfin Enhanced), same tabs, same settings.
- **Config saves now apply live.** Saving plugin configuration pushes the change to every open browser session — users pick up the new settings without reloading. See [Live Updates](../advanced/live-updates.md).
- **After a plugin update**, open sessions show a one-time toast asking for a refresh — that single reload is the only manual step left.
- **File Transformation is no longer needed for Enhanced's own script injection.** On Jellyfin 12 the client script is injected at request time by built-in middleware (on by default), so nothing is written to `index.html` on disk. The legacy on-disk `index.html` rewrite — which writes the script tag directly to the web folder (and needs a writable web folder) — is used solely as a fallback when an admin disables the injection middleware. File Transformation is unrelated to Enhanced's own injection and remains relevant only for other web-modifying plugins such as Custom Tabs / Plugin Pages.
- The other [installation prerequisites](installation.md) are unchanged: the repository URL and the restart-after-install step still apply.
