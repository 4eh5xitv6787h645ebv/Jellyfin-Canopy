# Getting Started

Jellyfin Canopy layers a richer, faster front-end and a set of opt-in power features on top of your Jellyfin server. This guide takes you from a fresh Jellyfin 12 install to a working Enhanced Panel, then points you at the one-time setup that turns on the features you care about. Budget about ten minutes.

!!! info "Prerequisites"

    - Jellyfin server version **12.x**
    - **Admin access** to your Jellyfin server
    - A modern web browser (Chrome, Firefox, Edge, or Safari)

## Jellyfin 12 only

Jellyfin Canopy targets **Jellyfin 12 and nothing else**. Its manifest publishes only a Jellyfin 12 build (target ABI `12.0.0.0`), so a Jellyfin 10.11 server's catalog will never list it — there is no 10.11-compatible release to install.

If you're still on Jellyfin 10.11, install the original [Jellyfin Enhanced](https://github.com/n00bcodr/Jellyfin-Enhanced) plugin instead. When you later move to Jellyfin 12, Canopy can import that installation as described in [Upgrading from Jellyfin Enhanced](#upgrading-from-jellyfin-enhanced-1011).

## Install the plugin

Installation is the standard Jellyfin plugin flow: add the repository, install from the catalog, restart, and confirm the panel loads.

### Step 1 — Add the plugin repository

1. In Jellyfin, go to **Dashboard** → **Plugins** → **Catalog**.
2. Click the gear icon (⚙️ **Manage Repositories**), then click **➕** (Add) to add a new repository.
3. Give the repository a name, for example "Jellyfin Canopy".
4. Set the **Repository URL** to the manifest:

    ```
    https://raw.githubusercontent.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/main/manifest.json
    ```

5. Click **Save**.

### Step 2 — Install from the catalog

1. Open the **Catalog** tab.
2. Find **Jellyfin Canopy** in the plugin list.
3. Click **Install**.
4. Wait for the installation to complete.

### Step 3 — Restart your server

Restart your Jellyfin server to finish the install — the plugin doesn't take effect until you do.

### Step 4 — Verify the panel appears

After the restart:

1. Refresh your browser with a hard reload (++ctrl+f5++ or ++command+shift+r++).
2. Open the Jellyfin Canopy settings panel — either route works:
    - In the sidebar, under the **Jellyfin Canopy** heading, click **Enhanced Panel**.
    - Or press `?`.
3. If the **Enhanced Panel** opens, the install worked.

If nothing appears, jump to [Troubleshooting the install](#troubleshooting-the-install).

## Upgrading from Jellyfin Enhanced (10.11)

Jellyfin Enhanced and Jellyfin Canopy are separate plugins with different IDs and storage roots, so Jellyfin's catalog cannot update one into the other. Canopy has a one-time importer for the final Enhanced 10.11 state.

1. Before upgrading, stop Jellyfin and back up its complete configuration directory. Keep that backup until you have verified the migration.
2. Upgrade Jellyfin to 12, add the Canopy repository, install Canopy, and restart Jellyfin.
3. On its first startup, Canopy looks for Enhanced's administration XML and `configurations/Jellyfin.Plugin.JellyfinEnhanced` directory. It validates and stages a copy before publishing it under the Canopy names.
4. Check the Jellyfin log for both `Imported Jellyfin Enhanced` messages, then verify the admin page and each user's settings, shortcuts, bookmarks, hidden content, Elsewhere preferences, reviews, and custom branding.

The importer never modifies or removes Enhanced's files. They remain the rollback/export copy. Running Canopy again is idempotent: a completed import is not replayed over newer Canopy changes, while an interrupted staged copy is rebuilt on the next restart.

!!! warning "Conflicts are never auto-merged"

    If Canopy already has an independently created configuration or non-empty data directory, the importer imports **nothing** and logs both paths. This prevents a mixed installation and makes the existing Canopy state the winner. The decision is recorded in `Jellyfin.Plugin.JellyfinCanopy.xml.enhanced-import.json`, so later restarts do not repeatedly attempt the import. To retry the automatic Enhanced import, stop Jellyfin, back up and move aside the Canopy XML, that marker, and the `configurations/Jellyfin.Plugin.JellyfinCanopy` directory, then restart. If you need values from both installations, retain both backups and reconcile them manually; do not copy individual live files while Jellyfin is running.

Malformed Enhanced administration XML, or malformed critical Enhanced JSON such as settings, bookmarks, hidden content, or reviews, also blocks publication. Canopy logs the exact source file and refuses to finish loading for that startup, preventing defaults or background writers from contaminating the retry path; Jellyfin itself remains available. Repair or move aside the reported source, then restart. A genuinely missing XML or data half is reported by its absence and the available half is still imported.

The same fail-closed rule applies when the older Canopy `reviews.json` is first
converted to the indexed review database. An oversized file or one invalid review
key is preserved as `reviews.json.corrupt-*`, the original stays untouched, and
review endpoints return unavailable. Stop Jellyfin, repair the reported JSON entry
(or preserve and move the file aside if an empty review store is intentional), then
restart; a repaired file is retried automatically.

For rollback, stop Jellyfin, remove or move aside the Canopy installation/state, restore your pre-upgrade server backup, and start Jellyfin 10.11 with Enhanced. Because the importer copied rather than moved the Enhanced source, the original state is still available. Enhanced and Canopy are not intended to run side by side: Enhanced targets Jellyfin 10.11, while Canopy targets Jellyfin 12.

## Upgrading from Jellyfin Elevate

Versions before 2.0 were published as **Jellyfin Elevate**. It is the same plugin (same plugin ID), so the catalog offers the rebranded version as a normal update:

1. Update the plugin from the catalog and restart the server.
2. Your configuration, per-user settings, custom branding, and caches migrate automatically on first startup.
3. The only thing that does not carry over is custom **scheduled-task triggers** (Dashboard → Scheduled Tasks): the rebrand renames the task keys, so any schedule you changed by hand reverts to the plugin default — set it again once.

## First-run setup

You now have Jellyfin Canopy running, but most features are **off by default**, and several of the biggest ones need a one-time connection before they do anything. Everything below lives under **Dashboard** → **Plugins** → **Jellyfin Canopy**, on the tab named in each item. Turn on what you want and skip the rest.

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

[Spoiler Guard](spoiler-guard.md) hides episode thumbnails, titles, and descriptions that could spoil what you haven't watched yet. It's **off until you enable it** on the **Pages** tab. The full walkthrough is in [Spoiler Guard](spoiler-guard.md).

### Everything else

Keyboard shortcuts, media tags, the pause screen, bookmarks, and the rest of the day-to-day polish live in the Enhanced experience and the customization options. Once the essentials above are in place, explore them at your own pace in [Customization](customization.md) and the other guides.

!!! note "Where every setting lives"

    Each admin option sits on one of the tabs in the plugin config page. For the full tab-by-tab map — which tab configures what, and where each area is documented — see [Reference](reference.md).

## Troubleshooting the install

Most install problems come down to a missed restart, a stale browser cache, or a misunderstanding of how the script is delivered. Work through the checks below in order.

### Plugin not appearing after installation

**Check installation status:**

1. Go to **Dashboard** → **Plugins**.
2. Verify **Jellyfin Canopy** is listed under **Installed**.
3. Check that it's enabled (not disabled).

**Run the startup task:**

1. Go to **Dashboard** → **Scheduled Tasks**.
2. Under **Jellyfin Canopy**, find the task **Jellyfin Canopy Startup**.
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

    By default the client script is injected at request time by the built-in injection middleware, which runs on every `/web/` index request independently of any scheduled task. Re-adding the `On application startup` trigger to the **Jellyfin Canopy Startup** task will **not** fix scripts failing to load in the default configuration — that task only performs background initialisation and cleanup and no longer governs script delivery.

**Check the browser console:**

1. Press ++f12++ to open developer tools.
2. Go to the **Console** tab.
3. Look for errors mentioning "Jellyfin Canopy".
4. Report any errors on GitHub.

**Legacy on-disk fallback:** the **Jellyfin Canopy Startup** task and its `On application startup` trigger only matter when an admin has switched to the legacy on-disk `index.html` rewrite (see [Permission issues](#permission-issues)). In that mode the task performs the on-disk rewrite at startup, so it should carry the `On application startup` trigger. If it's missing under **Dashboard** → **Scheduled Tasks**, add it manually.

### Update not working

If an update didn't take, do a clean reinstall:

1. Go to **Dashboard** → **Plugins** → **My Plugins**.
2. Find Jellyfin Canopy and click **Uninstall**.
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
2. Search the [GitHub issues](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues), and open a new one if needed — please include logs and details.
3. Join the [Discord community](https://discord.gg/EYNFf7y4CG).
