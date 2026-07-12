# Other Settings

Settings for custom branding, icon styles, extras, timeouts, and more. These are spread across several tabs of the plugin configuration page (**Dashboard** → **Plugins** → **Jellyfin Elevate**) rather than a single tab — each section below notes which tab (**Display**, **Playback**, **Extras**, or **Admin**) holds the setting.

---

## Custom Branding

*Extras tab → Custom Image Assets*

Upload your own logos, banners, and favicon to personalize your Jellyfin instance.

!!! info "Works out of the box"
    Custom branding needs no extra plugins. Uploaded images are served by the plugin's own
    built-in request-time middleware and apply on the next page load. It can be turned off
    with the advanced [`DisableBrandingMiddleware`](#advanced-troubleshooting-toggles)
    kill-switch (default off).

| Setting | Description |
|---|---|
| **Icon Transparent** | Header logo shown in the Jellyfin top bar (PNG or SVG, transparent background recommended) |
| **Banner Light** | Splash image shown on the dark-theme login screen |
| **Banner Dark** | Splash image shown on the light-theme login screen |
| **Favicon** | Browser tab icon |
| **Apple Touch Icon** | Icon shown when adding the site to the iOS Home Screen |

Files are stored in:
```text
/plugins/configurations/Jellyfin.Plugin.JellyfinElevate/custom_branding/
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

Adds a live stream counter icon to the Jellyfin header. For admins the panel is
a full session-control surface: it live-updates while open and offers per-session
**Stop** and **Message** (with quick presets) actions on each stream.

| Setting | Default | Description |
|---|---|---|
| **Active Streams Header Widget** | Off | Enables the stream counter in the header |
| **Show widget to non-admins** | Off | When on, non-admin users see a read-only view (no session controls, no broadcast, no IP addresses) |

See [Other Features — Active Streams Widget](other-features.md#active-streams-widget) for full details.

---

## Extras

*Extras tab*

A set of optional UI tweaks and dashboard cosmetics. All default **off**. See
[Other Features — Extras](other-features.md#extras) for screenshots and full details.

| Setting | Default | Description |
|---|---|---|
| **Colored Ratings Backgrounds** | Off | Color-codes rating chips on detail pages (TMDB, IMDb, Rotten Tomatoes) by value/type |
| **Theme Selector (Jellyfish)** | Off | Adds a theme selector to the Enhanced panel for switching between Jellyfish color themes |
| **Colored Dashboard Icons** | Off | Replaces the Dashboard activity icons with colored Material Design icons |
| **Profile Picture on Login** | Off | Shows each user's avatar on the manual login screen instead of their name |
| **Custom Plugin Menu Icons** | Off | Replaces default plugin folder icons on the Dashboard sidebar with Material icons; enables the **Sidebar Custom Links** field |
| **Enable Metadata Icons (Druidblack)** | Off | Swaps text metadata labels (and the plugin's Letterboxd/*arr links) for icons |

!!! note "Other Extras-tab settings have their own sections"
    The **Active Streams Widget** (above), **Letterboxd Integration**, **Splash Screen**,
    and **Custom Branding** also live on the Extras tab and are documented separately on
    this page.

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

## Client Layout Enforcement

*Display tab → UI Preferences*

Steer the Jellyfin 12 client layout for every device from one server-side setting.

Jellyfin 12 ships two layouts — the **modern** React/MUI layout and the classic **legacy** layout — and the choice is stored *per device* in each browser (Jellyfin's own **Display** settings). A device that once selected the legacy layout stays on it, even after the modern layout becomes the default, until someone changes it on that device. Because the choice lives in the browser, an admin has no native way to move everyone (for example, every phone) onto the modern layout. This setting is that lever.

| Option | Behavior |
|---|---|
| **None** (default) | No change. Each user's device choice (or Jellyfin's own default) stands. |
| **Default to modern layout** | Applies the modern layout only on devices that have **never** made an explicit choice. Never overrides a user's stored pick, and needs no reload. |
| **Force modern layout** | Steers devices stored on a desktop or mobile legacy layout onto the modern one, costing a single automatic reload per device on the first switch. Devices already painting the modern layout (including brand-new devices, which default to modern) are never reloaded. Devices in **TV mode are exempt** (see below). |
| **Force legacy layout** | Steers devices painting the modern layout onto the **desktop** legacy layout (one reload). Not form-factor aware: phones also land on the desktop legacy layout, not a mobile-specific one. Devices already on a legacy layout keep their chosen legacy sub-layout; TV mode is exempt. |

!!! warning "TV mode is never steered"
    A device whose stored layout is **TV** is excluded from both Force modes. A 10-foot interface chosen deliberately for a television must not be pulled onto the mouse/touch UI — Jellyfin itself scopes the modern default to non-TV browsers.

!!! note "Shipped-build (12.0.0) values"
    Enforcement writes the layout values used by the shipped Jellyfin 12.0.0 web client (`experimental` / `desktop`). On future builds that rename the layout values, a written value the client does not recognize is silently discarded and the client falls back to its modern default — so **Force modern** still lands on modern, but **Force legacy** degrades to the modern layout with no diagnostic.

!!! info "How Force interacts with a manual switch"
    Force is applied at boot, so **Force wins**: a user can still flip the layout in Jellyfin's own Display settings, but on the next load the plugin steers it back (one reload). The override never loops — it reloads only when the device is actually painting the other layout, and a write that fails to stick (broken or ephemeral browser storage) is detected by a read-back check and never reloads at all.

!!! note "Why this is admin-only (no per-user default)"
    The layout is a property of the *device/browser*, not of the Jellyfin user account, so a per-user override would have no device to attach to (the same account on a phone and a TV can want different layouts). It is therefore a single server-wide admin setting.

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

**Serve third-party assets locally (recommended)** — mirrors every remote asset the plugin's client scripts use (Material Symbols fonts, arr/Seerr/Letterboxd icons, country flags, metadata-icon and ratings CSS, Jellyfish theme styles, Elsewhere region/provider lists) onto your server and serves them from `/JellyfinElevate/assets/…`, so browsers never contact third-party CDNs (jsDelivr, Google Fonts, cdnjs, flagcdn).

- **Default: ON.** Assets are downloaded server-side on first use and refreshed daily by the **Refresh Cached Assets** scheduled task (cadence adjustable in Jellyfin's *Scheduled Tasks* dashboard). Cached copies live next to the plugin configuration under `asset_cache/`; the last good copy is kept if an upstream is temporarily unreachable.
- When **disabled**, clients load these assets directly from the original CDN URLs, as older plugin versions did.

---

## Developer Mode

*Admin tab → Developer Settings*

| Setting | Default | Description |
|---|---|---|
| **Dev Mode** | Off | Diagnostic/development toggle. When on, JavaScript caching is disabled so the plugin's client scripts are always re-fetched from the server. Leave off for normal use. |

---

## Advanced troubleshooting toggles

These two kill-switches have **no config-page UI** — they are set directly in the plugin
configuration file (or via the configuration API). Both default **off** (the middleware is
enabled), and both exist only as an escape hatch if a plugin conflict or edge case makes the
request-time middleware misbehave.

| Setting | Default | Description |
|---|---|---|
| **`DisableScriptInjectionMiddleware`** | Off | When on, the request-time `<script>` injection middleware no-ops and the plugin falls back to the legacy on-disk `index.html` rewrite. |
| **`DisableBrandingMiddleware`** | Off | When on, the built-in [Custom Branding](#custom-branding) middleware stops serving your uploaded logo/banner/favicon images and Jellyfin's stock assets are used instead. |
