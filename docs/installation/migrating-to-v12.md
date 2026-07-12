# Migrating to v12

Jellyfin Elevate supports **Jellyfin 12 only**. This page covers who should upgrade, what happens to your data, and what (little) changes for you.

## Who should upgrade

| Your Jellyfin server | What to do |
|---|---|
| **Jellyfin 12** | Install Jellyfin Elevate — the Jellyfin 12 (1.x) release. This is the only combination Jellyfin Elevate supports. |
| **Jellyfin 10.11** | Jellyfin Elevate does **not** support Jellyfin 10.11. Install the original **[Jellyfin Enhanced](https://github.com/n00bcodr/Jellyfin-Enhanced)** plugin instead — it stays actively maintained for Jellyfin 10.11. Jellyfin Elevate's manifest only publishes a Jellyfin 12 build (target ABI `12.0.0.0`), so a 10.11 server's catalog will never list it. |

Jellyfin Elevate and Jellyfin Enhanced ship from **separate repositories** with separate manifests — use the repository URL for the plugin that matches your server. There is no single manifest that serves both.

## What carries over automatically

**Everything.** Upgrading the plugin (or upgrading your server to Jellyfin 12 and then the plugin) preserves all data with no migration step:

- **Per-user settings** — every Enhanced panel setting
- **Keyboard shortcuts** — including custom bindings
- **Hidden content** — all hidden items and hidden-content settings, for every user
- **Bookmarks** — timestamps, labels, sync data
- **Reviews** — user reviews and ratings
- **Admin plugin configuration** — the whole Dashboard → Plugins → Jellyfin Elevate configuration

The on-disk formats of these files are **unchanged and frozen**: the plugin's test suite round-trips real Jellyfin Enhanced-era user files and pins the exact serialized output, so a format drift fails the build before it ever ships. Reverting to Jellyfin Enhanced on Jellyfin 10.11 would also find its data intact.

## What changed for user-script authors

If you inject your own snippets that build on Jellyfin Elevate, three things matter:

1. **`window.JellyfinElevate` is the stable public surface — and it is now typed.**
   The frozen contract lives in [`src/facade.ts`](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Elevate/blob/main/Jellyfin.Plugin.JellyfinElevate/src/facade.ts) (`JellyfinElevatePublicApi`). Its members will not be removed or renamed:

    - `JE.core.*` — the platform layer: `navigation`, `lifecycle`, `dom`, `ui`, `api`, `tagRenderer`, `live`
    - `JE.pluginConfig` / `JE.currentSettings` — admin config and resolved per-user settings
    - `JE.translations` / `JE.t()` — the active translation table and lookup
    - `JE.pluginVersion` — the loaded plugin version
    - `JE.initialized` — boot-complete marker (automation should wait on this)
    - `JE.escapeHtml()` / `JE.toast()` — HTML escaping and toast notifications
    - `JE.customPlugins.refresh()` — custom sidebar plugin links

2. **`JE.internals` is gone.** The legacy `JE.internals.<feature>` bags were private cross-file state for the old classic-script tree; the TypeScript modules share state through real imports now. Anything you were reaching into via `JE.internals` was never public — if you depended on something there, [open a discussion](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Elevate/discussions) about promoting an equivalent to the facade.

3. **Per-file script serving is gone.** Feature code is no longer served as individual `/JellyfinElevate/js/<area>/<file>.js` files — the whole client ships as one bundle (`/JellyfinElevate/dist/je.bundle.js`) loaded by the one remaining loader script. Don't fetch or patch individual plugin files; build on the `window.JellyfinElevate` facade instead.

Also note for anything calling the plugin's HTTP API directly: Jellyfin 12 ignores the legacy auth tokens (`?api_key=`, `X-Emby-Token`), and authorization failures now return bare `401`/`403` responses with empty bodies. See [API — Authentication](../advanced/api.md#authentication).

## Admin notes

- **The configuration page is unchanged.** Same place (Dashboard → Plugins → Jellyfin Elevate), same tabs, same settings.
- **Config saves now apply live.** Saving plugin configuration pushes the change to every open browser session — users pick up the new settings without reloading. See [Live Updates](../advanced/live-updates.md).
- **After a plugin update**, open sessions show a one-time toast asking for a refresh — that single reload is the only manual step left.
- **File Transformation is no longer needed for Enhanced's own script injection.** On Jellyfin 12 the client script is injected at request time by built-in middleware (on by default), so nothing is written to `index.html` on disk. The legacy on-disk `index.html` rewrite — which writes the script tag directly to the web folder (and needs a writable web folder) — is used solely as a fallback when an admin disables the injection middleware. File Transformation is unrelated to Enhanced's own injection and remains relevant only for other web-modifying plugins such as Custom Tabs / Plugin Pages.
- The other [installation prerequisites](installation.md) are unchanged: the repository URL and the restart-after-install step still apply.
