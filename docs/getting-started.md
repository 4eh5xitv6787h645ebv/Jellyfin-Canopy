# Getting Started

Jellyfin Elevate layers a richer, faster front-end and a set of opt-in power features on top of your Jellyfin server. This guide takes you from a fresh Jellyfin 12 install to a working Enhanced Panel, then points you at the one-time setup that turns on the features you care about. Budget about ten minutes.

!!! info "Prerequisites"

    - Jellyfin server version **12.x**
    - **Admin access** to your Jellyfin server
    - A modern web browser (Chrome, Firefox, Edge, or Safari)

## Jellyfin 12 only

Jellyfin Elevate targets **Jellyfin 12 and nothing else**. Its manifest publishes only a Jellyfin 12 build (target ABI `12.0.0.0`), so a Jellyfin 10.11 server's catalog will never list it — there is no 10.11-compatible release to install.

If you're still on Jellyfin 10.11, install the original [Jellyfin Enhanced](https://github.com/n00bcodr/Jellyfin-Enhanced) plugin instead. It stays actively maintained for 10.11, and your settings carry across cleanly if you later move to Jellyfin 12. See [Upgrading from Jellyfin 10.11](#upgrading-from-jellyfin-1011) below for the full picture.

## Install the plugin

Installation is the standard Jellyfin plugin flow: add the repository, install from the catalog, restart, and confirm the panel loads.

### Step 1 — Add the plugin repository

1. In Jellyfin, go to **Dashboard** → **Plugins** → **Catalog**.
2. Click the gear icon (⚙️ **Manage Repositories**), then click **➕** (Add) to add a new repository.
3. Give the repository a name, for example "Jellyfin Elevate".
4. Set the **Repository URL** to the manifest:

    ```
    https://raw.githubusercontent.com/4eh5xitv6787h645ebv/Jellyfin-Elevate/main/manifest.json
    ```

5. Click **Save**.

### Step 2 — Install from the catalog

1. Open the **Catalog** tab.
2. Find **Jellyfin Elevate** in the plugin list.
3. Click **Install**.
4. Wait for the installation to complete.

### Step 3 — Install File Transformation (optional)

!!! info "You almost certainly don't need this"

    On Jellyfin 12, Jellyfin Elevate injects its client `<script>` at request time through built-in ASP.NET middleware, so a default install **never modifies `index.html` on disk** and cannot produce `index.html` permission errors from JE's script injection. You do **not** need the File Transformation plugin for Jellyfin Elevate to work.

Install the [File Transformation plugin](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) only if you want the optional **Custom Tabs / Plugin Pages** integrations, which rely on it to register their pages. To add it:

1. In the **Catalog** tab, search for "file-transformation".
2. Install the **File Transformation** plugin.
3. Restart your Jellyfin server.

### Step 4 — Restart your server

Restart your Jellyfin server to complete the installation. This step is required for the plugin to take effect.

### Step 5 — Verify the panel appears

After the restart:

1. Refresh your browser with a hard reload (++ctrl+f5++ or ++command+shift+r++).
2. Open the Jellyfin Elevate settings panel, either way:
    - In the sidebar, under the **Jellyfin Elevate** heading, click **Enhanced Panel**.
    - Or press `?`.
3. If the **Enhanced Panel** opens, the install worked.

If nothing appears, jump to [Troubleshooting the install](#troubleshooting-the-install).

## First-run setup

You now have Jellyfin Elevate running, but most features are **off by default**, and several of the biggest ones need a one-time connection before they do anything. Everything below lives under **Dashboard** → **Plugins** → **Jellyfin Elevate**, on the tab named in each item. Turn on what you want and skip the rest.

!!! tip "The two states to watch for"

    A feature can be *on by default but inert* (it's enabled, but waiting on a key or connection you haven't provided yet), or *off until you enable it*. The checklist calls out which is which, so you know whether you're flipping a switch or filling in a credential.

### Add a TMDB API key

A TMDB API key is the single highest-value thing to set up first. One key unlocks a cluster of features:

- **Elsewhere** — where-to-watch availability
- **TMDB Reviews**
- **Release Dates**
- **People-tag enrichment**

Enter the key on the **Elsewhere** tab. **Elsewhere itself is on by default**, but it stays inert until a valid TMDB key is set — so without the key, none of the features above appear. See [Discover & Request](discover.md).

### Connect Seerr

A [Seerr](discover.md) connection powers two things at once: **media requests** and the **Discovery** feed.

- **Seerr integration is off** until you enable it and enter your Seerr URL and API key on the **Seerr** tab.
- **Discovery's own toggle is on by default**, but the feed shows nothing until a Seerr connection is configured.

So connecting Seerr is what brings both requests and Discovery to life. See [Discover & Request](discover.md).

### Add Sonarr / Radarr instances

To drive Sonarr and Radarr from inside Jellyfin — searching, adding, and managing — add one or more instances on the **\*arr** tab. The *arr features do nothing until at least one instance is configured. See [Sonarr & Radarr](sonarr-radarr.md).

### Enable Spoiler Guard

[Spoiler Guard](spoiler-guard.md) hides episode thumbnails, titles, and descriptions that could spoil what you haven't watched yet. It's **off until you enable it** on the **Pages** tab. See [Spoiler Guard](spoiler-guard.md).

### Everything else

Keyboard shortcuts, media tags, the pause screen, bookmarks, and the rest of the day-to-day polish are covered in the Enhanced experience and the customization options. Explore them in [Customization](customization.md) and the other guides once the essentials above are in place.

!!! note "Where every setting lives"

    Each admin option sits on one of the tabs in the plugin config page. For the full tab-by-tab map — which tab configures what, and where each area is documented — see [Reference](reference.md).

## Upgrading from Jellyfin 10.11

Jellyfin Elevate is the Jellyfin 12 (1.x) line. If you're coming from Jellyfin Enhanced on Jellyfin 10.11, this section covers who should move, what happens to your data, and the little that changes.

### Who should upgrade

| Your Jellyfin server | What to do |
|---|---|
| **Jellyfin 12** | Install Jellyfin Elevate — the Jellyfin 12 (1.x) release. This is the only combination Jellyfin Elevate supports. |
| **Jellyfin 10.11** | Jellyfin Elevate does **not** support Jellyfin 10.11. Install the original **[Jellyfin Enhanced](https://github.com/n00bcodr/Jellyfin-Enhanced)** plugin instead — it stays actively maintained for Jellyfin 10.11. |

Jellyfin Elevate and Jellyfin Enhanced ship from **separate repositories** with **separate manifests**. Use the repository URL for the plugin that matches your server — there is no single manifest that serves both.

### What carries over automatically

**Everything.** Upgrading the plugin — or upgrading your server to Jellyfin 12 and then installing the plugin — preserves all data with no migration step:

- **Per-user settings** — every Enhanced Panel setting
- **Keyboard shortcuts** — including custom bindings
- **Hidden content** — all hidden items and hidden-content settings, for every user
- **Bookmarks** — timestamps, labels, and sync data
- **Reviews** — user reviews and ratings
- **Admin plugin configuration** — the whole Dashboard → Plugins → Jellyfin Elevate configuration

The on-disk formats of these files are **unchanged and frozen**. The plugin's test suite round-trips real Jellyfin Enhanced-era user files and pins the exact serialized output, so any format drift fails the build before it ships. Reverting to Jellyfin Enhanced on Jellyfin 10.11 would also find its data intact.

### What changed for user-script authors

If you inject your own snippets that build on Jellyfin Elevate, three things matter:

1. **`window.JellyfinElevate` is the stable public surface — and it is now typed.** The frozen contract lives in [`src/facade.ts`](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Elevate/blob/main/Jellyfin.Plugin.JellyfinElevate/src/facade.ts) (`JellyfinElevatePublicApi`). Its members will not be removed or renamed:

    - `JE.core.*` — the platform layer: `navigation`, `lifecycle`, `dom`, `ui`, `api`, `tagRenderer`, `live`
    - `JE.pluginConfig` / `JE.currentSettings` — admin config and resolved per-user settings
    - `JE.translations` / `JE.t()` — the active translation table and lookup
    - `JE.pluginVersion` — the loaded plugin version
    - `JE.initialized` — boot-complete marker (automation should wait on this)
    - `JE.escapeHtml()` / `JE.toast()` — HTML escaping and toast notifications
    - `JE.customPlugins.refresh()` — custom sidebar plugin links

2. **`JE.internals` is gone.** The legacy `JE.internals.<feature>` bags were private cross-file state for the old classic-script tree; the TypeScript modules share state through real imports now. Anything you reached into via `JE.internals` was never public — if you depended on something there, [open a discussion](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Elevate/discussions) about promoting an equivalent to the facade.

3. **Per-file script serving is gone.** Feature code is no longer served as individual `/JellyfinElevate/js/<area>/<file>.js` files — the whole client ships as one bundle (`/JellyfinElevate/dist/je.bundle.js`) loaded by the one remaining loader script. Don't fetch or patch individual plugin files; build on the `window.JellyfinElevate` facade instead.

If you call the plugin's HTTP API directly, note that Jellyfin 12 ignores the legacy auth tokens (`?api_key=`, `X-Emby-Token`), and authorization failures now return bare `401`/`403` responses with empty bodies. See the [Developer Guide](developers.md).

### Admin notes

- **The configuration page is unchanged.** Same place (Dashboard → Plugins → Jellyfin Elevate), same tabs, same settings.
- **Config saves now apply live.** Saving plugin configuration pushes the change to every open browser session — users pick up the new settings without reloading. See the [Developer Guide](developers.md).
- **After a plugin update**, open sessions show a one-time toast asking for a refresh. That single reload is the only manual step left.
- **File Transformation is no longer needed for Jellyfin Elevate's own script injection.** On Jellyfin 12 the client script is injected at request time by built-in middleware (on by default), so nothing is written to `index.html` on disk. The legacy on-disk `index.html` rewrite — which writes the script tag directly to the web folder and needs a writable web folder — is used solely as a fallback when an admin disables the injection middleware. File Transformation is unrelated to Jellyfin Elevate's own script injection and remains relevant only for other web-modifying plugins such as Custom Tabs / Plugin Pages.
- The other installation prerequisites are unchanged: the repository URL and the restart-after-install step still apply.

## Troubleshooting the install

Most install problems come down to a missed restart, a stale browser cache, or a misunderstanding of how the script is delivered. Work through the checks below in order.

### Plugin not appearing after installation

**Check installation status:**

1. Go to **Dashboard** → **Plugins**.
2. Verify **Jellyfin Elevate** is listed under **Installed**.
3. Check that it's enabled (not disabled).

**Run the startup task:**

1. Go to **Dashboard** → **Scheduled Tasks**.
2. Under **Jellyfin Elevate**, find the task **Jellyfin Elevate Startup**.
3. Run it manually (click the **▶︎** button).
4. Refresh your browser (++ctrl+f5++).

**Clear your browser cache:**

1. Open the clear-cache dialog — Windows/Linux: ++ctrl+shift+delete++; macOS: ++command+shift+delete++.
2. Select "Cached images and files" (or similar).
3. Clear the cache.
4. Refresh your browser (++ctrl+f5++).

**Restart the server:**

1. In Jellyfin, go to **Dashboard** → **Restart**.
2. Wait for the server to fully restart.
3. Refresh your browser (++ctrl+f5++).

### Scripts not loading

!!! note "How the script is delivered on Jellyfin 12"

    By default the client script is injected at request time by the built-in injection middleware, which runs on every `/web/` index request independently of any scheduled task. Re-adding the `On application startup` trigger to the **Jellyfin Elevate Startup** task will **not** fix scripts failing to load in the default configuration — that task only performs background initialisation and cleanup and no longer governs script delivery.

**Check the browser console:**

1. Press ++f12++ to open developer tools.
2. Go to the **Console** tab.
3. Look for errors mentioning "Jellyfin Elevate".
4. Report any errors on GitHub.

**Legacy on-disk fallback:** the **Jellyfin Elevate Startup** task and its `On application startup` trigger only matter when an admin has switched to the legacy on-disk `index.html` rewrite (see [Permission issues](#permission-issues)). In that mode the task performs the on-disk rewrite at startup, so it should carry the `On application startup` trigger. If it's missing under **Dashboard** → **Scheduled Tasks**, add it manually.

### Update not working

If an update didn't take, do a clean reinstall:

1. Go to **Dashboard** → **Plugins** → **My Plugins**.
2. Find Jellyfin Elevate and click **Uninstall**.
3. Restart the server.
4. Reinstall from the **Catalog**.
5. Restart the server again.
6. Clear the browser cache (++ctrl+f5++).

### Permission issues

!!! note "Applies only to the legacy on-disk rewrite"

    On Jellyfin 12, the plugin injects its client script at request time via built-in middleware and does **not** write to `index.html` on disk, so these permission errors do not occur by default. This section applies only if an admin has disabled the script-injection middleware to fall back to the legacy on-disk `index.html` rewrite, which requires a writable web folder. This is not a toggle in the plugin config page — it can only be enabled by setting `DisableScriptInjectionMiddleware` to `true` in the plugin's configuration XML (default `false`).

If you see an error like this in a log file:

```text
Access to the path '/jellyfin/jellyfin-web/index.html' is denied.
```

The common solution is to install the [File Transformation plugin](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) (recommended), or apply a platform-specific permission fix below.

#### Docker

A common error looks like this:

```text title="Bash"
System.UnauthorizedAccessException: Access to the path '/jellyfin/jellyfin-web/index.html' is denied.
```

If you are **^^not^^ using the [file-transformation](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) plugin**, you'll need to manually map the `index.html` file:

1. Copy the `index.html` file out of your container:

    ```bash title="Bash"
    docker cp jellyfin:/jellyfin/jellyfin-web/index.html /path/to/your/jellyfin/config/index.html
    ```

2. Add a volume mapping:

    ```bash title="Docker Run"
    -v /path/to/your/jellyfin/config/index.html:/jellyfin/jellyfin-web/index.html
    ```

    or in Compose:

    ```yaml title="Docker Compose"
    services:
      jellyfin:
        volumes:
          # volume mapping
          - /path/to/your/jellyfin/config:/config
          - /path/to/your/jellyfin/config/index.html:/jellyfin/jellyfin-web/index.html
    ```

!!! warning

    This method is not recommended and won't survive a `jellyfin-web` upgrade. The recommended method for Docker:

    1. Install the [File Transformation plugin](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation).
    2. Follow the standard installation process.

#### Windows

1. Navigate to your Jellyfin installation folder (usually `C:\Program Files\Jellyfin\Server`).
2. Right-click the folder → **Properties** → **Security**.
3. Grant `NETWORK SERVICE` **Read** and **Write** permissions.
4. Apply to all subfolders and files.
5. Restart the Jellyfin service.

#### Linux

```bash title="Bash"
sudo chown -R jellyfin:jellyfin /usr/lib/jellyfin/
sudo chmod -R 755 /usr/lib/jellyfin/
```

### Admin config page tabs not switching

If clicking tabs in the plugin's admin configuration page (Elsewhere, Seerr, *arr, and so on) does nothing, the cause may be **Cloudflare** interfering with JavaScript execution when you reach Jellyfin through a Cloudflare tunnel or proxy.

Try disabling Cloudflare features that modify JavaScript behaviour for your Jellyfin domain:

1. Log in to the [Cloudflare dashboard](https://dash.cloudflare.com).
2. Select your domain.
3. Go to **Speed** → **Optimization** → **Content Optimization**.
4. Toggle **Rocket Loader** off.

If that doesn't help, access the admin config page directly on your local network (bypassing Cloudflare) to confirm whether Cloudflare is the cause. See upstream [Jellyfin Enhanced issue #175](https://github.com/n00bcodr/Jellyfin-Enhanced/issues/175) for more context.

### Still stuck?

1. Check the [FAQ](help.md) for common solutions.
2. Search the [GitHub issues](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Elevate/issues), and open a new one if needed — please include logs and details.
3. Join the [Discord community](https://discord.gg/EYNFf7y4CG).
