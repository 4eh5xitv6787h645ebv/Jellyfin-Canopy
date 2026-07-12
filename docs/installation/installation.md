# Installation Guide

<!-- use a custom title -->
!!! info "Prerequisites"

    **Prerequisites:**

    - Jellyfin server version 12.x
    - Admin access to your Jellyfin server
    - Modern web browser (Chrome, Firefox, Edge, Safari)

    On Jellyfin 10.11? Jellyfin Elevate does not support it — install the original [Jellyfin Enhanced](https://github.com/n00bcodr/Jellyfin-Enhanced) plugin instead. See [Migrating to v12](migrating-to-v12.md).


## Standard Installation

### Step 1: Add Plugin Repository

1. In Jellyfin, navigate to **Dashboard** → **Plugins** → **Catalog**
2. Click the gear icon (⚙️ **Manage Repositories**), then click **➕** (Add button) to add a new repository
3. Give the repository a name (e.g., "Jellyfin Elevate")
4. Set the **Repository URL** to the manifest:
   ```
   https://raw.githubusercontent.com/4eh5xitv6787h645ebv/Jellyfin-Elevate/main/manifest.json
   ```

5. Click **Save**

### Step 2: Install Plugin

1. Go to the **Catalog** tab
2. Find **Jellyfin Elevate** in the plugin list
3. Click **Install**
4. Wait for the installation to complete

### Step 3: Install File Transformation Plugin (Optional)

<!-- use a custom title -->
!!! info "When you need this"

    In Jellyfin 12, Jellyfin Elevate injects its client `<script>` at request time through ASP.NET middleware, so a default install **never modifies `index.html` on disk** and cannot produce `index.html` permission errors from JE's script injection. You do **not** need the File Transformation plugin for JE to work.

    Install the [File Transformation plugin](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) only if you want to use the optional **Custom Tabs / Plugin Pages** integrations, which rely on it to register their pages.

To add it:

1. In the **Catalog** tab, search for "file-transformation"
2. Install the **File Transformation** plugin
3. Restart your Jellyfin server

### Step 4: Restart Server

1. **Restart** your Jellyfin server to complete the installation *(This is required for the plugin to take effect)*

### Step 5: Verify Installation

After restart:

1. Refresh your browser *(++ctrl+f5++ or ++command+shift+r++)*
2. Access the Jellyfin Elevate settings panel. Options:
    - In the sidebar, under the **Jellyfin Elevate** heading: click **Enhanced Panel**
    - Press `?`
3. If you see the panel, installation was successful!

## Next Steps

Most features are **off by default** and several need a one-time setup before they do anything. Open **Dashboard** → **Plugins** → **Jellyfin Elevate** and configure what you want:

- **TMDB API Key** — unlocks **Elsewhere**, **TMDB Reviews**, **Release Dates**, and **People-tag enrichment**. Enter it on the [Elsewhere Settings](../elsewhere/elsewhere-settings.md) page (the *Elsewhere* tab). Elsewhere itself is **on by default**, but it stays inert until a valid TMDB key is set.
- **Seerr connection** — required for the [Seerr features](../seerr/seerr-settings.md) *and* for [Discovery](../discovery/discovery-settings.md). Seerr is **off** until you enable it and enter your Seerr URL + API key on the *Seerr* tab. Discovery's own toggle is on by default, but it shows nothing until a Seerr connection is configured.
- **Sonarr / Radarr instances** — required for the [\*arr features](../arr/arr-settings.md). Add one or more instances on the *\*arr* tab.
- **Spoiler Guard** — **off** until you enable it on the *Pages* tab. See [Spoiler Guard Settings](../spoiler-guard/spoiler-guard-settings.md).

Everything else (keyboard shortcuts, media tags, pause screen, bookmarks, and more) lives in the [Enhanced Settings](../enhanced/enhanced-settings.md) and the config-page tabs described below.

## Where Settings Live

Every admin option lives on one of the tabs in the plugin config page (**Dashboard** → **Plugins** → **Jellyfin Elevate**). This table maps each tab to what it configures and where it's documented:

| Config-page tab | Configures | Documentation |
|---|---|---|
| **Overview** | Read-only health snapshot (service-connection status, optional companion plugins, feature states) plus quick actions. Clicking a card jumps to the owning tab. | [Overview Quick Actions](../other/other-settings.md#overview-tab-quick-actions) |
| **Display** | Enhanced display settings: UI preferences, media tags, icons & theme, random button, default language. | [Enhanced Settings](../enhanced/enhanced-settings.md) |
| **Playback** | Enhanced playback settings: playback & tab-switch, auto-skip intros/outros, subtitles, panel & toast timing. | [Enhanced Settings](../enhanced/enhanced-settings.md) |
| **Pages** | [Bookmarks](../enhanced/enhanced-features.md#smart-bookmarks), [Hidden Content](../other/other-features.md#hidden-content), [Spoiler Guard](../spoiler-guard/spoiler-guard-settings.md), [Requests Page](../arr/arr-features.md#requests-page), [Calendar Page](../arr/arr-features.md#calendar-page). | (per-feature links) |
| **Seerr** | Seerr connection and Seerr integration features. | [Seerr Settings](../seerr/seerr-settings.md) |
| **\*arr** | Sonarr / Radarr instances and *arr features. | [\*arr Settings](../arr/arr-settings.md) |
| **Elsewhere** | Elsewhere panel, TMDB API key, TMDB Reviews, Release Dates. | [Elsewhere Settings](../elsewhere/elsewhere-settings.md) |
| **Discovery** | Discovery / Trending feed (requires a Seerr connection). | [Discovery Settings](../discovery/discovery-settings.md) |
| **Extras** | Custom branding, extras/UI-tweak toggles, Active Streams widget, Letterboxd links, splash screen. | [Other Settings](../other/other-settings.md) |
| **Keyboard** | Keyboard shortcuts. | [Enhanced Settings](../enhanced/enhanced-settings.md) |
| **Admin** | Maintenance Mode, Third-Party Assets, Developer Mode. | [Other Settings](../other/other-settings.md#maintenance-mode) |
| **Docs** | Links to this documentation site. | — |