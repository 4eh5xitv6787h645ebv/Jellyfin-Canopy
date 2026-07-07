# Other Settings

Settings for custom branding, icon styles, extras, timeouts, and more. These are spread across several tabs of the plugin configuration page (**Dashboard** → **Plugins** → **Jellyfin Enhanced**) rather than a single tab — each section below notes which tab (**Display**, **Playback**, **Extras**, or **Admin**) holds the setting.

---

## Custom Branding

*Extras tab → Custom Image Assets*

Upload your own logos, banners, and favicon to personalize your Jellyfin instance.

!!! info "Requirements"
    The [File Transformation plugin](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) must be installed.

| Setting | Description |
|---|---|
| **Icon Transparent** | Header logo shown in the Jellyfin top bar (PNG or SVG, transparent background recommended) |
| **Banner Light** | Splash image shown on the dark-theme login screen |
| **Banner Dark** | Splash image shown on the light-theme login screen |
| **Favicon** | Browser tab icon |
| **Apple Touch Icon** | Icon shown when adding the site to the iOS Home Screen |

Files are stored in:
```text
/plugins/configurations/Jellyfin.Plugin.JellyfinEnhanced/custom_branding/
```

After saving, do a hard refresh (++ctrl+f5++) to see changes.

---

## Icon Settings

*Display tab*

### Use Icons in UI

Enable or disable icons in toasts, settings panel, and other UI elements.

### Icon Style

Choose the icon set used throughout the plugin UI.

| Style | Description |
|---|---|
| **Emoji** | Unicode emoji characters — universal, no loading required |
| **Lucide Icons** | Modern, clean icon set |
| **Material UI Icons** | Google Material Design icons |

---

## Active Streams Widget

*Extras tab*

Adds a live stream counter icon to the Jellyfin header.

| Setting | Default | Description |
|---|---|---|
| **Active Streams Header Widget** | Off | Enables the stream counter in the header |
| **Show widget to non-admins** | Off | When on, non-admin users see a read-only view (no broadcast, no IP addresses) |

See [Other Features — Active Streams Widget](other-features.md#active-streams-widget) for full details.

---

## Timeout Settings

*Playback tab*

Controls how long certain UI elements stay visible before auto-closing.

| Setting | Default | Description |
|---|---|---|
| **Shortcuts Panel Autoclose Delay (ms)** | 15000 ms | How long the shortcuts panel stays open before closing automatically. Values are advisory — the input does not enforce a range. |
| **Toast Notification Duration (ms)** | 1500 ms | How long toast notifications are displayed. Values are advisory — the input does not enforce a range. |

---

## Letterboxd Integration

*Extras tab*

Adds a Letterboxd external link to movie and person (cast/crew) detail pages.

| Setting | Description |
|---|---|
| **Enable Letterboxd Links** | Shows a Letterboxd icon/link on movie and person detail pages |
| **Show link as text** | Displays the link as text instead of an icon |

---

## Splash Screen

*Extras tab*

Shows a custom image while Jellyfin is loading.

| Setting | Description |
|---|---|
| **Enable Splash Screen Override** | Enables the custom splash screen |
| **Splash Screen Image URL** | Full URL or relative path to the image. Defaults to `/web/assets/img/banner-light.png` |

---

## Default UI Language

*Display tab*

Override the language used by the plugin for all users.

- Select a language from the dropdown to apply it to the plugin UI.
- Choose **System Default** to use each user's own Jellyfin profile language.

---

## Cache Management

*Display tab*

| Button | Effect |
|---|---|
| **Clear All Client Caches** | Forces all connected clients to clear their localStorage on next page load. Use to reset client-side settings or fix corrupted state. |

Translations are refreshed automatically by the **Refresh Translation Cache** scheduled task, which runs on server startup to signal connected clients to pick up fresh translations after a plugin update — there is no separate translation-cache button. By default the task has no periodic schedule; add an interval trigger in Jellyfin's *Scheduled Tasks* dashboard if you want it to run on a cadence.

---

## Maintenance Mode

*Admin tab → Maintenance Mode*

Temporarily lock users out of the server while you perform maintenance. When enabled, the selected action is applied to the affected users immediately on save, and a banner is shown on the Jellyfin login page. Administrators are **never** affected. Disabling Maintenance Mode restores all affected users automatically.

| Setting | Default | Description |
|---|---|---|
| **Enable Maintenance Mode** | Off | Turns Maintenance Mode on. The selected action is applied to affected users as soon as you save. |
| **Login Page Banner Message** | `This server is currently undergoing maintenance. Please try again.` | Plain-text message shown as a red banner at the top of every page (login and home). |
| **Active Session Notification** | `Server undergoing maintenance.` | Sent as a native Jellyfin popup to anyone currently watching, reaching all clients (web, mobile, TV apps). |
| **Action** | Disable user accounts | What happens to affected users. *Disable user accounts* prevents them from logging in at all; *Disable remote connections* blocks connections from outside the local network while LAN access still works. |
| **Affected Users** | All non-admin users | Scopes the lockout. Choose *All non-admin users*, or *Select specific users* to pick individual accounts. An empty targeted-user list is treated as all users. |

---

## Third-Party Assets

*Admin tab → Third-Party Assets*

**Serve third-party assets locally (recommended)** — mirrors every remote asset the plugin's client scripts use (Material Symbols fonts, arr/Seerr/Letterboxd icons, country flags, metadata-icon and ratings CSS, Jellyfish theme styles, Elsewhere region/provider lists) onto your server and serves them from `/JellyfinEnhanced/assets/…`, so browsers never contact third-party CDNs (jsDelivr, Google Fonts, cdnjs, flagcdn).

- **Default: ON.** Assets are downloaded server-side on first use and refreshed daily by the **Refresh Cached Assets** scheduled task (cadence adjustable in Jellyfin's *Scheduled Tasks* dashboard). Cached copies live next to the plugin configuration under `asset_cache/`; the last good copy is kept if an upstream is temporarily unreachable.
- When **disabled**, clients load these assets directly from the original CDN URLs, as older plugin versions did.
