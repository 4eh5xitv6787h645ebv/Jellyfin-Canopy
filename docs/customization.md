# Customization

Jellyfin Canopy lets you shape both how your server looks and how it behaves. You can put your own logo and banners in front of every user, layer in cosmetic touches like colored ratings and custom themes, watch (and steer) live playback from the header, and — as an admin — enforce a client layout, lock the server for maintenance, and manage caches for everyone at once. This guide covers all of it.

These settings span several tabs of the plugin configuration page at **Dashboard → Plugins → Jellyfin Canopy**, not just one — so each section below names the tab that holds its settings (**Overview**, **Display**, **Playback**, **Extras**, or **Admin**), and you always know where to look. For styling the plugin's own UI with CSS, see the [Reference](reference.md) guide.

## Custom branding

Custom branding replaces Jellyfin's stock logo, login banners, favicon, and iOS home-screen icon with your own, so the whole instance carries your identity from the first page load. It works out of the box: uploaded images are served by the plugin's own built-in request-time middleware, so **no File Transformation plugin (or any other plugin) is required**, and changes apply on the next page load.

Everything lives on the **Extras** tab, in the **Custom Image Assets** section:

1. Go to **Dashboard → Plugins → Jellyfin Canopy**.
2. Open the **Extras** tab and find **Custom Image Assets**.
3. Upload the images you want to override (all are optional):

| Asset | What it replaces |
|---|---|
| **Icon Transparent** | The header logo shown in the Jellyfin top bar (PNG or SVG, transparent background recommended) |
| **Banner Light** | The splash image on the **dark**-theme login screen |
| **Banner Dark** | The splash image on the **light**-theme login screen |
| **Favicon** | The browser tab icon |
| **Apple Touch Icon** | The icon shown when the site is added to the iOS Home Screen (180×180 PNG) |

4. Click **Save**, then force-refresh the browser with ++ctrl+f5++.

!!! note "The banner mapping is easy to read backwards"
    **Banner Light** is served on the **dark** login theme and **Banner Dark** on the **light** login theme. Double-check this pairing when you upload, so each banner lands on the theme you intended.

**Image guidance:** PNG or SVG are recommended, logos look best with a transparent background, and each image should use dimensions appropriate to its asset type — keep file sizes reasonable for performance.

Uploaded files are stored beneath the directory that contains Canopy's plugin configuration, so they use Jellyfin's existing configuration owner and survive server and web updates without making the web tree writable. For the official container the resolved path is:

```text
/config/plugins/configurations/Jellyfin.Plugin.JellyfinCanopy/custom_branding/
```

Native installations can place the Jellyfin configuration directory elsewhere; Canopy derives the location from its own configuration file rather than assuming an installation path.

!!! info "Turning the branding middleware off"
    The branding middleware is on by default. If it ever conflicts with another plugin, or you want to fall back to Jellyfin's stock assets, an admin can set the advanced [`DisableBrandingMiddleware`](#advanced-kill-switches) kill-switch (default off). When it is on, the plugin stops serving your uploaded images and Jellyfin's built-in assets are used instead.

## Theme Studio

Theme Studio is Canopy's per-user visual system for Jellyfin's **modern phone and modern desktop/wide layouts**. It combines curated presets with typed controls for color, typography, density, navigation, cards, details pages, player surfaces, glass and translucent materials, shadows, motion, local artwork-derived accents, and calendar profiles. It intentionally does not theme the legacy layout, tablet-only breakpoint, or TV mode; those surfaces retain Jellyfin's stock presentation.

For a task-focused walkthrough, start with the [Theme Studio user guide](theme-studio.md). Server policy and recovery are covered in the [administrator guide](theme-studio-admin.md), and implementation/evidence ownership is covered in the [developer guide](theme-studio-developer.md).

![Theme Studio full effects on a modern desktop](images/theme-studio-effects-desktop.png)

The desktop capture above and phone capture below come from the committed Jellyfin 12 browser test fixture, with a full effects profile, a local artwork-derived accent, and a holiday schedule active.

![Theme Studio full effects on a modern phone](images/theme-studio-effects-phone.png)

### Enable it as an administrator

Open **Dashboard → Plugins → Jellyfin Canopy → Extras → Theme Studio**, enable **Theme Studio**, choose the defaults and policy you want, then save:

| Setting | Default | What it controls |
|---|---|---|
| **Enable Theme Studio** | Off | Loads the per-user Theme Studio editor and modern-layout runtime. |
| **Default preset for new users** | Canopy | Seeds the first profile; changing it later does not overwrite existing users. |
| **Default palette for new users** | Canopy Night | Seeds the first profile's palette. |
| **Apply curated Theme Studio tokens to the administrator dashboard** | Off | Opts the dashboard into safe typed colors. Presentation modules and raw CSS remain excluded, preserving a recovery surface. |
| **Allow users to validate and import typed theme profiles** | On | Shows JSON import. Imports are validated, diagnosed, and reviewed as a bounded diff; profile-name collisions require explicit confirmation. |
| **Allow local media-derived dynamic color** | On | Lets profiles derive an accent from one same-server poster or backdrop. |
| **Allow per-user seasonal schedules** | On | Lets users create season and holiday date ranges. |
| **Maximum Theme Studio effects tier** | Full | Caps every user's material, blur, shadow/glow, image treatment, and motion cost at Full, Balanced, or Minimal. |
| **Allow the separately gated advanced CSS module** | Off | Enables a separate, local-only declaration editor for advanced users. Typed profiles and gallery entries never contain CSS. |

When Theme Studio is enabled, it owns the theme experience and the older **Theme Selector (Jellyfish)** picker stays inactive. Existing Jellyfish selections can be staged through Theme Studio's migration path without importing third-party CSS or a remote URL.

### Migrate an existing Jellyfish selection

Open the Enhanced panel's **Theme Studio** page on a modern phone or desktop browser. If this browser has one exact recognized Jellyfish colour import, a migration notice names the matching palette and offers **Preview migration**. All 15 choices from the existing selector are supported: Aurora, Banana, Coal, Coral, Forest, Grass, Jellyblue, Jellyflix, Jellypurple, Lavender, Midnight, Mint, Ocean, Peach, and Watermelon.

![Recognized Jellyfish migration in Theme Studio on a modern desktop](images/theme-studio-jellyfish-migration-desktop.png)

The desktop image is captured from the authenticated Jellyfin 12 browser test at 1366 × 768. The same test proves the notice and editor do not overflow, then exercises server staging, live preview, exact acknowledgement, scoped cleanup, import suppression, and rollback.

![Recognized Jellyfish migration in Theme Studio on a modern phone](images/theme-studio-jellyfish-migration-phone.png)

The phone image comes from the equivalent 390 × 844 modern portrait run with coarse-pointer behavior. Separate live-browser evidence covers 844 × 390 phone landscape and 1920 × 1080 wide desktop; tablet-only, legacy, and TV runs assert an exact no-op.

Preview is deliberately staged. The browser sends the authenticated server only the canonical choice name, such as `Ocean`; it never sends or executes the stored CSS, filename, or URL. The server returns the bundled `jellyfish-ocean` palette, the editor applies it to the current active profile without discarding other profiles or schedules, and the live preview appears without reloading the page. **Cancel** leaves the old selection and its keys untouched. **Apply** must receive the normal revisioned server acknowledgement before cleanup starts.

After that acknowledgement, Canopy removes only still-unchanged keys belonging to the current server/user identity and suppresses only an exact recognized Jellyfish import already rendered by Jellyfin Web. It first stores a small identity-scoped rollback record containing the canonical palette name, recognized random-theme state, and a 30-day expiry—never arbitrary CSS. **Restore compatibility selection** regenerates those known local values for rollback without executing the import or disabling Theme Studio. A changed, conflicting, unknown, mixed, remote, or malformed custom-CSS value is shown as unsupported and is never sent, loaded, changed, or deleted.

Daily random selection migrates the currently applied recognized colour. Its old scheduler keys are cleaned only with the acknowledged migration and can be regenerated during the rollback window. Account/server handoff, feature disablement, panel close, stale responses, storage failure, or a revision conflict retires pending work without cleaning keys or publishing another user's preview.

| Jellyfin surface | Theme Studio and migration behavior |
|---|---|
| Modern desktop and wide desktop | Full profile, migration preview, acknowledged cleanup, and rollback controls |
| Modern phone portrait and phone landscape | Same lifecycle in the compact editor with 44 CSS-pixel controls and single-column reflow |
| Administrator Dashboard | Stock recovery surface by default; optional typed colours only when the administrator enables the Dashboard policy; no presentation modules, migration preview, or advanced declarations |
| Tablet-only breakpoint | Stock Jellyfin; no Theme Studio style, migration preview, key cleanup, or import suppression |
| Legacy layout | Stock Jellyfin; no Theme Studio work |
| TV layout | Stock Jellyfin; no Theme Studio work |
| Sign-in and logged-out state | Stock Jellyfin; no per-user theme or migration state |

Jellyfin Web remains the owner of its built-in Apple TV, Blue Radiance, Dark, Light, Purple Haze, and WMC themes, the root `data-theme` attribute, and Dashboard/user theme switching. A Theme Studio profile in **System** mode follows those official modes—Apple TV and Light are light; the other current built-ins are dark—while Canopy supplies its bounded semantic values only under the modern activation gate.

Server branding CSS and unrelated device-local custom CSS are not converted or removed. They still participate in the browser cascade and can conflict through more-specific selectors or `!important`. For a predictable result, remove conflicting broad rules yourself or translate declaration-only values into Canopy's separately gated advanced editor. Theme Studio never treats general third-party CSS as a shareable profile.

### Make a personal profile

1. Open the **Enhanced panel** and select **Theme Studio**.
2. Pick a curated preset, palette, accent, and light/dark/system mode.
3. Adjust presentation and effects. Controls marked as overrides stay sparse; choosing the inherited option returns that value to the preset.
4. Use **Preview only** to inspect the page without the editor covering it. Undo, redo, reset, and cancel remain local until you choose **Apply**.
5. Choose **Apply** to save the complete profile to your Jellyfin account. The same account receives the profile on another supported browser after it signs in.

Profiles can select solid, translucent, or glass surfaces; none, dim, gradient, or blurred backdrop treatment; bounded elevation and glow; calm, expressive, or off motion; and a poster/backdrop dynamic accent. The three cost tiers behave monotonically:

| Tier | Behavior |
|---|---|
| **Full** | Allows the requested bounded material, backdrop treatment, shadow/glow, motion, and dynamic accent. |
| **Balanced** | Caps blur/saturation/glow and shadows, converts blurred backdrops to gradients, and converts expressive motion to calm. |
| **Minimal** | Uses solid surfaces, no blur/glow/shadow or backdrop treatment, motion off, and dynamic color off. |

Your selection can never exceed the administrator's maximum. A browser can reduce it further: a low-end modern phone uses Minimal; unsupported backdrop filtering removes glass blur; reduced transparency forces solid surfaces; reduced motion disables motion; and high contrast or forced colors use the minimal visual-cost path. Coarse/no-hover input also keeps card actions visible instead of hiding them behind hover.

### Share profiles and use the curated gallery

**Export JSON** creates a portable typed Theme Studio document. It contains profiles, supported typed overrides, accessibility choices, and optional schedules. It does **not** contain the Jellyfin user or server identity, revision evidence, migration state, provider configuration, API keys, media identifiers, dynamic-color samples, or advanced declarations. Schema 2 is the current format; Canopy can stage its explicitly supported older schema migrations, while a future or unknown schema is rejected.

**Import JSON** never saves immediately. Canopy validates the entire file on the authenticated server, rejects unknown fields, credentials, HTML, scripts, remote URLs, unsupported schemas, and unsupported token values, then shows a bounded change report. A profile name that collides with another identifier needs a separate confirmation. Choose **Keep current draft** or **Cancel preview** for an instant rollback; choose **Apply** only after reviewing the staged result. A concurrent server edit causes a revision conflict instead of silently replacing either copy.

The curated gallery is bundled into the plugin and works without internet access. Every entry uses allowlisted preset, palette, accent, and mode identifiers, includes a local SHA-256 checksum, and names the source projects and licences behind its visual direction. Canopy verifies that checksum before changing the draft. Gallery entries contain no executable code, remote asset, or third-party stylesheet.

![Theme Studio sharing and curated gallery on a modern desktop](images/theme-studio-sharing-desktop.png)

The desktop capture is produced by the authenticated Jellyfin 12 acceptance test after a bundled gallery entry passes its integrity check. The same test verifies the declaration recovery gate, separate persistence, 1920 × 1080 wide reflow, and stock/no-op behavior outside the supported layouts.

![Theme Studio sharing and curated gallery on a modern phone](images/theme-studio-sharing-phone.png)

The phone capture uses the same editor at 390 × 844. The test also covers 844 × 390 phone landscape, a single-column gallery, 44 CSS-pixel controls, bounded diagnostics, collision confirmation, and zero horizontal overflow.

### Advanced local declarations

Administrators can optionally enable **Advanced CSS** for users who understand the recovery risk. This is not a general stylesheet box: each snippet has an owned target such as theme variables, cards, details, dialogs, or player controls, and accepts a bounded declaration list only. Selectors, braces, `@import`, scripts, HTML, URLs, data/blob/file resources, font imports, and remote assets are rejected. Canopy owns the selector and applies it only to modern phone and modern desktop/wide content while standard contrast is active. Sign-in, the administrator Dashboard, tablet-only, legacy, TV, forced-colors, and High Contrast surfaces remain untouched.

Advanced declarations live in the separate per-user `theme-css.json` file and are never mixed into a preset, gallery entry, normal profile import, or profile export. They remain local to this Jellyfin server. Disabling the administrator policy removes their style layer without modifying the typed profile. If a declaration makes a content page hard to use, open the Dashboard recovery surface, disable the policy, or use **Reset local declarations**; Jellyfin's selected stock theme remains available on excluded layouts.

Third-party CSS cannot be imported as a Theme Studio profile. Review its licence and privacy behavior yourself, then translate only the specific local declarations you need into the advanced editor. A remote stylesheet, tracking URL, script, selector, or credential is never a supported Theme Studio sharing format.

### Accessibility, high contrast, and RTL

Theme Studio checks the final composed theme—not just the original preset—after the palette, accent, light/dark mode, and personal token overrides have been combined. Normal and muted text, links, semantic status text, and text over buttons or image scrims are corrected to at least 4.5:1 contrast. Focus rings, icons, control boundaries, and disabled-state cues are corrected to at least 3:1; High Contrast raises the focus and control-boundary target to 4.5:1. If one foreground cannot remain readable over a hostile mix of translucent surfaces, Canopy fails closed to the canvas surface instead of publishing a knowingly unreadable theme.

The High Contrast preset is a maintained profile, not a color filter. It uses solid materials, strong dividers and focus, underlined links, single-color metadata icons, doubled selected/error boundaries, dashed disabled controls, and text labels alongside every state. The same non-color cues remain in other presets: no selected, invalid, disabled, live, new, or premiere state depends on hue, hover, an icon, animation, or position alone. Windows forced-colors mode switches to system colors such as `Canvas`, `CanvasText`, `Highlight`, `LinkText`, and `GrayText` instead of trying to preserve authored colors.

Theme Studio also honors reduced motion and reduced transparency, supports an always-underline-links preference, and preserves 44 CSS-pixel phone controls. Logical inline/block properties, intentional mirroring of directional icons, `dir="auto"` text fields, and wrapping labels support Arabic, Hebrew, and mixed-direction content. The verified browser suite covers 200% text, a 320 CSS-pixel viewport equivalent to 400% zoom on a 1280-pixel desktop, phone portrait and landscape, desktop and wide desktop, keyboard and coarse-pointer focus, and exact no-op behavior on tablet-only, legacy, and TV layouts.

![Theme Studio accessibility fixture on a modern desktop](images/theme-studio-accessibility-desktop.png)

The desktop capture uses a maintained High Contrast profile with 200% text, Arabic RTL layout, Hebrew mixed-direction content, semantic status chips, an image scrim, and a form error connected through `aria-errormessage`.

![Theme Studio accessibility fixture on a modern phone](images/theme-studio-accessibility-phone.png)

The phone capture comes from the same real Jellyfin 12 browser test at 390 × 844 with coarse-pointer behavior. The focus ring, long labels, touch targets, content order, and single-column reflow are asserted separately from the screenshot.

### Canopy feature surfaces

Theme Studio also gives Canopy's own modern interfaces the same semantic surfaces as Jellyfin. The Enhanced settings panel, native tabs, random actions, protected-content controls, hidden-content management, tags, ratings, filler warnings, confirmations, notifications, loading states, and errors inherit the active profile without changing what those features do. The desktop fixture below deliberately places three tags in one card corner alongside a rating and filler warning to verify that the overlays stack instead of colliding.

![Theme Studio Canopy feature surfaces on a modern desktop](images/theme-studio-canopy-surfaces-desktop.png)

Tags use one logical lane per configured corner. Long values wrap inside the card, touch and keyboard actions remain reachable, RTL flips logical placement, and coarse-pointer controls stay at least 44 CSS pixels. Hidden and spoiler-protected values remain hidden until their owning feature authorizes a reveal; a theme cannot bypass confirmation, administrator, or feature-enabled policy.

![Theme Studio Canopy feature surfaces on a modern phone](images/theme-studio-canopy-surfaces-phone.png)

The phone capture is the same authenticated Jellyfin 12 fixture at 390 × 844. The suite also verifies phone landscape, desktop wide, High Contrast, reduced transparency, keyboard focus, RTL, and exact stock/no-op behavior on tablet-only, legacy, and TV layouts.

### Operational surfaces

Active streams, the Sonarr/Radarr calendar, downloads and requests, issues, and bookmarks also inherit the active profile on supported modern layouts. Theme Studio changes their surface, type, spacing, focus, progress, and semantic status presentation; each feature still owns its requests, live updates, permissions, session identity, and hidden values.

![Theme Studio operational surfaces on a modern desktop](images/theme-studio-operational-surfaces-desktop.png)

The desktop evidence combines live and paused stream states, transcode and download progress, calendar availability, request approval, orphaned-bookmark recovery, and a conflict dialog. Text labels and boundaries accompany color, and the fixture verifies that repeated live patches retain the same nodes without creating another polling or observer owner.

![Theme Studio operational surfaces on a modern phone](images/theme-studio-operational-surfaces-phone.png)

The phone capture is the same authenticated Jellyfin 12 fixture at 390 × 844. Separate assertions cover 844 × 390 phone landscape, 1920 × 1080 wide desktop, 44 CSS-pixel controls, keyboard focus, RTL, long labels, no nested vertical scrollers, and unchanged private policy hooks. Tablet-only, legacy, and TV layouts retain stock operational styling.

### Discovery, requests, reviews, and external services

Discovery results, Seerr requests, Sonarr/Radarr/Bazarr actions, reviews, external links, and release information receive coordinated Theme Studio presentation when their owning Canopy features are both enabled and configured. Availability, request, approval, rejection, failure, release, and progress states pair color with text, icons, shapes, or progress semantics. Theme Studio does not send provider requests, expose service URLs or API keys, change permissions, or load remote visual assets.

![Theme Studio discovery and integration surfaces on a modern desktop](images/theme-studio-integration-surfaces-desktop.png)

The desktop fixture combines a discovery hero and media row, Seerr request states and season controls, ARR release and rejection details, review summaries and editing controls, external links, release dates, and loading, empty, error, and permission states. The documentation capture uses a 1366 × 1200 desktop viewport so every production-aligned surface remains in frame; runtime assertions also cover 1366 × 768 and 1920 × 1080. Sheets and dialogs stay bounded on wide displays, while long translated and mixed-direction content wraps without obscuring actions.

![Theme Studio discovery and integration surfaces on a modern phone](images/theme-studio-integration-surfaces-phone.png)

The phone capture comes from the same authenticated Jellyfin 12 fixture at 390 × 844. Separate assertions cover 844 × 390 phone landscape, 1920 × 1080 wide desktop, 44 CSS-pixel controls, keyboard and screen-reader semantics, RTL, long content, and exact stock/no-op behavior on tablet-only, legacy, and TV layouts. Disabling or leaving Seerr or an ARR service unconfigured prevents its specialized presentation asset from loading; the shared typed Theme Studio tokens remain available to ordinary modern Jellyfin surfaces.

### Dynamic color and privacy

Dynamic color is optional and runs only after the usable theme has painted. Canopy reads one same-origin Jellyfin **Primary** or **Backdrop** image, reduces it to a small local color sample, and blends the result with the profile accent. Analysis is cancellable and bounded; it never contacts an artwork CDN, and a media URL, item identifier, image tag, or sampled pixels are never written to `theme.json`, profile exports, CSS logs, or documentation captures. When analysis is unavailable or fails, the curated palette remains active.

### Seasonal and holiday profiles

The schedule editor supports up to 32 entries. Choose **Local time** when the theme should follow the browser's civil date, or **UTC** for the same boundary everywhere. Each entry selects a profile, start/end month-day, priority, type, and enabled state. Ranges can wrap across New Year.

Resolution is deterministic: a matching **Holiday** entry wins over every matching **Season**, even when the season has a higher priority; priority then breaks ties within the same type, followed by the stable entry identifier. The runtime rechecks calendar boundaries and also rechecks after focus/visibility changes, so daylight-saving and timezone changes do not require a reload.

## Extras

The **Extras** tab collects a set of optional cosmetic tweaks — small touches that make the dashboard and detail pages nicer to look at. Every one of them is **off by default**, so you opt in only to the ones you want. Enable each with its checkbox on the Extras tab and click **Save** (some need a browser refresh to take effect).

| Setting (config label) | Default | What it does |
|---|---|---|
| **Colored Dashboard Icons** | Off | Replaces the Dashboard activity icons with colored Material Design icons |
| **Colored Ratings Backgrounds** | Off | Color-codes rating chips on detail pages (TMDB, IMDb, Rotten Tomatoes) by value and type |
| **Theme Selector (Jellyfish)** | Off | Adds a theme selector to the Enhanced panel for switching between Jellyfish color themes |
| **Profile Picture on Login** | Off | Shows each user's avatar on the manual login screen instead of their name |
| **Custom Plugin Menu Icons** | Off | Replaces default plugin folder icons in the Dashboard sidebar with Material icons; enables the **Sidebar Custom Links** field |
| **Enable Metadata Icons (Druidblack)** | Off | Swaps text metadata labels — and the plugin's own Letterboxd and \*arr links — for icons |

### Colored Dashboard Icons

Gives each activity type on the Dashboard a distinct Material Design icon in its own color, so the activity feed is easier to scan at a glance.

![Colored Dashboard Icons](images/colored-activity-icons.png)

### Colored Ratings Backgrounds

Adds value-based colored backgrounds to the rating chips on detail pages, with different colors per rating type. It supports TMDB, IMDb, and Rotten Tomatoes scores, so a strong rating reads differently from a weak one at a glance.

![Colored Ratings](images/ratings.png)

### Theme Selector (Jellyfish)

Turns on a theme picker in the Enhanced panel, letting each user switch between Jellyfish color palettes — Aurora, Jellyblue, Ocean, Peach, Forest, and more — with an option to rotate the theme automatically each day.

![Theme Selector](images/theme-selector.png)

Once the setting is on, users pick a theme from the Enhanced panel:

1. Open the Enhanced panel.
2. Go to the **Settings** tab.
3. Find the **Theme Selector** section.
4. Choose a theme from the dropdown.
5. Optionally enable **Randomize Daily** for a fresh palette each day.

### Profile Picture on Login

Shows each user's avatar on the manual login screen in place of their name, for a cleaner, more personal sign-in. It falls back to text automatically when a user has no avatar.

![Login Image](images/login-image.png)

### Custom Plugin Menu Icons

Replaces the default plugin folder icons in the Dashboard sidebar with Material Design icons, and unlocks the **Sidebar Custom Links** field so you can add your own links to plugin configuration pages.

![Plugin Icons](images/plugin-icons.png)

Enter each link in the **Sidebar Custom Links** field as a page name and a Material icon name, separated by a pipe:

```text
Configuration Page Name | Material Icon Name
```

For example:

```text
Jellyfin Tweaks | tune
```

The second value is a [Material icon](https://fonts.google.com/icons) name, **not** a URL. The sidebar link is generated as `#/configurationpage?name=<name>` from the first field, so it always points at a plugin configuration page — arbitrary external URLs are not supported.

### Metadata Icons (Druidblack)

Swaps the text metadata labels on item-detail pages for icons, and switches the plugin's own Letterboxd and \*arr links to icons too. It uses the icon set from [Druidblack/jellyfin-icon-metadata](https://github.com/Druidblack/jellyfin-icon-metadata). Enable it with **Enable Metadata Icons (Druidblack)** on the Extras tab (default off).

## Active Streams widget

The Active Streams widget puts a live stream counter in the Jellyfin header and, for admins, turns that panel into a full session-control surface — you can see who is watching what, stop a stream, message one viewer, or broadcast to everyone, without leaving the page you're on. It lives on the **Extras** tab.

To enable it:

1. Go to **Dashboard → Plugins → Jellyfin Canopy** and open the **Extras** tab.
2. Enable **Active Streams Header Widget**.
3. Optionally enable **Show widget to non-admins**.
4. Click **Save**.

![Active Streams](images/active-stream.png)

| Setting | Default | What it does |
|---|---|---|
| **Active Streams Header Widget** | Off | Adds the stream counter icon to the Jellyfin header |
| **Show widget to non-admins** | Off | Lets non-admin users see the widget too, as a read-only view — no session controls, no broadcast, and no IP addresses |

### Live updates

While the panel is open it updates itself, with no manual refresh needed. It listens to the server's `Sessions` websocket push — the same feed the native dashboard uses — and falls back to a short, page-scoped refresh interval that only ticks while the tab is visible. Progress bars and play/pause state update in place; a card is only rebuilt when a stream actually starts or stops. A manual refresh button remains for an on-demand poll.

### Session controls (admins)

Each session card gives admins one-click control over that specific stream. These controls appear only for clients that support remote control, and every action is enforced server-side as admin-only.

| Action | What it does |
|---|---|
| **Stop** | Stops playback on that session (the "kill a stream" action). A two-click confirm guards against accidental stops — no blocking dialog. |
| **Message** | Sends a message to that one session. Opens an inline compose box with quick-preset buttons and free text. |

Quick presets (for example, "The server will restart shortly…") are one-click fillers for the message box, available on both the per-session message form and the broadcast form.

### Broadcast to all sessions

Admins can message every active session at once from the panel header (the megaphone icon):

| Field | Required | What it does |
|---|---|---|
| **Title** | No | Optional heading; may not display on web UI clients |
| **Message** | Yes | The message body; always visible on all clients |
| **Timeout (s)** | Yes | Seconds before the notification auto-dismisses (default: 10) |

!!! warning
    The **Title** field may not render on the Jellyfin web client. Always put the important information in the **Message** field.

## Letterboxd links

A Letterboxd link on movie and person (cast/crew) detail pages lets viewers jump straight from a film or an actor to its Letterboxd page. Configure it on the **Extras** tab:

| Setting | What it does |
|---|---|
| **Enable Letterboxd Links** | Shows a Letterboxd link on movie and person detail pages |
| **Show link as text** | Displays the link as text instead of an icon |

On a movie page the link opens the film on Letterboxd; on a cast or crew member's page it opens that person's Letterboxd page. Movie links use automatic IMDb ID to Letterboxd mapping, and person links are derived from the person's name slug.

## Splash screen

The splash screen override replaces the image Jellyfin shows while it loads, so even the wait carries your look. Turn it on from the **Extras** tab:

| Setting | What it does |
|---|---|
| **Enable Splash Screen Override** | Enables the custom splash screen |
| **Splash Screen Image URL** | Full URL or relative path to the image. Defaults to `/web/assets/img/banner-light.png` |

To use your own image, provide a same-origin relative path, an existing plugin-served URL, or a URL served by your reverse proxy or another trusted static host, then save and refresh. LAN-only HTTP is supported when Jellyfin itself is intentionally served over HTTP on that trusted LAN; use HTTPS for an externally hosted production image. Do not copy the image into Jellyfin's package-owned web directory. Use a PNG, JPG, or SVG sized for full-screen display, and pick something that holds up responsively across screen sizes.

## Icons

Icons appear throughout the plugin — in toasts, the settings panel, and other UI elements. You control both whether they show and which icon set they use, from the **Display** tab.

| Setting | What it does |
|---|---|
| **Use Icons in UI** | Enables or disables icons in toasts, the settings panel, and other UI elements |
| **Icon Style** | Chooses the icon set used throughout the plugin UI (see below) |

Three icon styles are available:

| Style | Notes |
|---|---|
| **Emoji** | Unicode emoji characters — universal, no loading required (default) |
| **Lucide Icons** | A modern, clean icon set |
| **Material UI Icons** | Google's Material Design icons — familiar and consistent |

After changing the style, refresh the browser to see it applied.

## Timeouts

Two settings on the **Playback** tab set how long the shortcuts panel and toast notifications stay on screen before dismissing themselves.

| Setting | Default | What it does |
|---|---|---|
| **Shortcuts Panel Autoclose Delay (ms)** | 15000 ms (15 seconds) | How long the shortcuts (help) panel stays open before closing automatically |
| **Toast Notification Duration (ms)** | 1500 ms (1.5 seconds) | How long toast notifications stay on screen |

Both values are **advisory only** — the input enforces no minimum or maximum, and a value of `0` (or a blank field) reverts to the default. A longer shortcuts delay suits first-time users; a shorter one suits people who already know the keys. The toast duration affects bookmark-saved notifications, success and error messages, and state-change confirmations.

## Internationalization

Jellyfin Canopy speaks 26 bundled languages and picks the right one automatically, so most users never touch a language setting. It detects each user's Jellyfin profile language, loads the matching translation from the plugin's bundled locale files on first load, and caches it for 24 hours. Only when the [third-party asset cache](#third-party-assets) is disabled does it fall back to fetching translations from GitHub. Outdated caches are cleared automatically when the plugin updates.

**Default UI Language** (on the **Display** tab) overrides the automatic detection for everyone:

- Select a language from the dropdown to apply it to the plugin UI for all users.
- Choose **System Default** (or leave it empty) to keep each user on their own Jellyfin profile language.

There is no config-page button for clearing translation caches. They are refreshed for every client by the **Refresh Translation Cache** scheduled task (see [Cache management](#cache-management)). An individual user can also clear their own browser's translation cache from the language section of the Enhanced settings panel — that only affects their local browser.

!!! tip "Adding or improving a translation"
    Translations are maintained as locale JSON files in the repository and bundled with the plugin as embedded resources. To contribute a new language or fix an existing one, see the [Help & Community](help.md) guide.

## Server controls (admin)

The remaining controls are administrator-only and act on the whole server at once: lock everyone out for maintenance, steer which client layout every device uses, refresh caches across all clients, keep third-party assets local, and reach the advanced escape hatches. Unless noted, these settings live on the **Admin** tab.

### Maintenance Mode

*Admin tab → Maintenance Mode*

Maintenance Mode temporarily locks users out while you work on the server, and shows them a banner explaining why. When you enable it, the selected action is applied to the affected users immediately on save, and a banner appears on the Jellyfin login page. Administrators are **never** affected. Disabling Maintenance Mode restores all affected users automatically.

| Setting | Default | What it does |
|---|---|---|
| **Enable Maintenance Mode** | Off | Turns Maintenance Mode on. The selected action is applied to affected users as soon as you save. |
| **Login Page Banner Message** | `This server is currently undergoing maintenance. Please try again.` | Plain-text message shown as a red banner at the top of every page (login and home). |
| **Active Session Notification** | `Server undergoing maintenance.` | Sent as a native Jellyfin popup to anyone currently watching, reaching all clients (web, mobile, TV apps). |
| **Action** | Disable user accounts | What happens to affected users. *Disable user accounts* prevents them from logging in at all; *Disable remote connections* blocks connections from outside the local network while LAN access still works. |
| **Affected Users** | All non-admin users | Scopes the lockout. Choose *All non-admin users*, or *Select specific users* to pick individual accounts. An empty targeted-user list is treated as all users. |

### Client Layout Enforcement

*Display tab → UI Preferences*

Jellyfin 12 ships two layouts — the **modern** React/MUI layout and the classic **legacy** layout — and the choice is stored *per device* in each browser (in Jellyfin's own **Display** settings). A device that once picked the legacy layout stays on it, even after modern becomes the default, until someone changes it on that device. Because the choice lives in the browser, an admin has no native way to move everyone (say, every phone) onto the modern layout. Client Layout Enforcement is that lever — one server-side setting that steers every device.

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
    Force is applied at boot, so **Force wins**: a user can still flip the layout in Jellyfin's own Display settings, but on the next load the plugin steers it back (one reload). The override never loops — it reloads only when the device is actually painting the other layout, and a write that fails to stick (broken or ephemeral browser storage) is caught by a read-back check and never reloads at all.

!!! note "Why this is admin-only (no per-user default)"
    The layout is a property of the *device/browser*, not of the Jellyfin user account, so a per-user override would have no device to attach to (the same account on a phone and a TV can want different layouts). It is therefore a single server-wide admin setting.

### Cache management

*Display tab, with quick actions on the Overview tab*

When client-side settings get stale or corrupted, you can force every connected client to start fresh on its next page load.

| Control | Where | Effect |
|---|---|---|
| **Clear All Client Caches** | Display tab | Sets a timestamp so every client clears its localStorage **and** tag caches on next load. Use it to reset client-side settings, refresh quality/genre/language/rating tags, fix corrupted or stale data, or force a fresh start across all clients. |

Expect some slowness on the first load after clearing, while each client re-fetches its data.

Translation caches are not cleared by a button. They are refreshed for all clients by the **Refresh Translation Cache** scheduled task (**Dashboard → Scheduled Tasks**), which runs on server startup to signal connected clients to pick up fresh translations after a plugin update. By default that task has no periodic schedule — add an interval trigger in the Scheduled Tasks dashboard if you want it to run on a cadence.

#### Overview quick actions

*Overview tab → Quick Actions*

The **Overview** tab is otherwise a read-only dashboard, but its **Quick Actions** panel holds three one-click admin operations:

| Action | Effect |
|---|---|
| **Re-test all service connections** | Re-runs the TMDB / Seerr / Sonarr / Radarr connection tests and refreshes the Service Status cards. Read-only — changes no settings. |
| **Apply defaults to all users** | Saves the current configuration, then **overwrites every user's saved per-user settings** with the current admin defaults. |
| **Clear all client tag caches** | Forces every connected client to rebuild only its localStorage tag cache on the next page load — the rest of localStorage is left untouched. Equivalent to **Clear All Client Caches** above, scoped to tag caches. |

!!! warning "Apply defaults to all users overwrites per-user settings"
    **Apply defaults to all users** replaces the saved per-user preferences of **every** user on the server with the current admin defaults. There is no per-user undo — a user's customized settings are gone once you confirm. The button also saves the configuration currently on the page before applying it, so it commits any unsaved edits in the form too. It asks for confirmation first, and the new settings take effect after each user refreshes their browser.

### Third-Party Assets

*Admin tab → Third-Party Assets*

**Serve third-party assets locally (recommended)** mirrors every remote asset the plugin's client scripts use — Material Symbols fonts, \*arr/Seerr/Letterboxd icons, country flags, metadata-icon and ratings CSS, Jellyfish theme styles, and Elsewhere region/provider lists — onto your server and serves them from `/JellyfinCanopy/assets/…`, so browsers never contact third-party CDNs (jsDelivr, Google Fonts, cdnjs, flagcdn).

- **Default: On.** Assets are downloaded server-side on first use and refreshed daily by the **Refresh Cached Assets** scheduled task (cadence adjustable in Jellyfin's *Scheduled Tasks* dashboard). Cached copies live next to the plugin configuration under `asset_cache/`, and the last good copy is kept if an upstream is temporarily unreachable.
- **When disabled,** clients load these assets directly from the original CDN URLs, as older plugin versions did. This is also the only mode in which [Internationalization](#internationalization) falls back to fetching translations from GitHub.

### Developer Mode

*Admin tab → Developer Settings*

| Setting | Default | What it does |
|---|---|---|
| **Dev Mode** | Off | A diagnostic/development toggle. When on, JavaScript caching is disabled so the plugin's client scripts are always re-fetched from the server. Leave it off for normal use. |

### Advanced kill-switches

Two additional toggles have **no config-page UI** — they are set directly in the plugin configuration file (or via the configuration API). Both default **off** (the middleware enabled), and both exist only as an escape hatch if a plugin conflict or edge case makes the request-time middleware misbehave.

| Setting | Default | What it does |
|---|---|---|
| **`DisableScriptInjectionMiddleware`** | Off | When on, the request-time `<script>` injection middleware no-ops and the plugin falls back to the legacy on-disk `index.html` rewrite. |
| **`DisableBrandingMiddleware`** | Off | When on, the built-in [Custom Branding](#custom-branding) middleware stops serving your uploaded logo, banner, and favicon images, and Jellyfin's stock assets are used instead. |
