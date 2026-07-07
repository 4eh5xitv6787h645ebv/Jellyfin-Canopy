# .arr Links Integration

Quick access to Sonarr, Radarr, and Bazarr (admin only).

## Setup

1. Open plugin settings → **`*arr`** tab
2. Add one or more Sonarr and/or Radarr instances
3. Enable `Enable *arr Links on Detail Pages`
4. Optional: Enable "Show synced tags as links"
5. Configure tag filters (show/hide specific tags)

### CSS Customization
See [ARR Tag Links CSS](../advanced/css-customization.md#arr-tag-links) for styling options.

---

## Multi-Instance Configuration

### Instance Fields

Each Sonarr or Radarr instance has the following fields:

| Field | Required | Description |
|---|---|---|
| **Name** | Yes | Display name shown in dropdowns (e.g., `TV Shows`, `Anime`, `4K Movies`) |
| **URL** | Yes | Base URL of the instance (e.g., `http://192.168.1.100:8989`) |
| **API Key** | Yes | API key from the instance's Settings → General page |
| **URL Mappings** | No | Per-instance URL remapping for reverse-proxy setups |
| **Enabled** | — | Toggle to disable without deleting; defaults to on |

### Adding an Instance

1. Open plugin settings → ***arr** tab
2. Click **"+ Add Sonarr instance"** or **"+ Add Radarr instance"**
3. Fill in Name, URL, and API Key
4. Optionally add URL Mappings
5. Click **Save**

### Disabling an Instance

Toggle the **Enabled** switch off to skip an instance in all fan-out paths (arr links, calendar, queue monitoring, tag sync) without removing its configuration. Re-enable it at any time.

!!! tip
    Use the Enabled toggle during maintenance windows or when temporarily replacing an instance. Your URL and API key are preserved.

### URL Mappings (per-instance)

Per-instance URL mappings override the global mapping for that instance. Format is the same as the global field:

```text
internal_url|external_url
```

**Example:**
```text
http://sonarr-anime:8989|https://anime.example.com
```

---

## Link Behaviour

### Single Instance

When only one instance matches an item, the link renders as a plain icon (no badge). To always show the status colour border and episode/file count on single-instance links, enable:

> **"Show status badge for single-instance"**

### Multiple Instances (Dropdown)

When more than one instance contains the item, the link becomes a dropdown. Each entry shows:

- A colour-coded status dot
- Instance name
- Episode count (Sonarr) or download status (Radarr)
- File size on disk

**Status colours:**

| Colour | Meaning |
|---|---|
| Green | Complete — all episodes/file present |
| Amber | Partial — some episodes missing |
| Grey | Missing — not in this instance |

---

## Legacy Single-Instance Fields

The original `SonarrUrl`, `SonarrApiKey`, `RadarrUrl`, and `RadarrApiKey` fields are preserved for downgrade safety. If the multi-instance list is empty, the plugin falls back to these fields automatically.

!!! note
    Once you add instances via the new UI, the legacy fields are no longer used for arr links. They are not deleted, so downgrading to an older plugin version restores single-instance behaviour.

---

## Calendar Page Settings

Found in the **Pages** tab under "Calendar Page".

| Setting | Description |
|---|---|
| **Enable Calendar Page** | Enables the calendar view for upcoming Sonarr/Radarr releases |
| **Add Calendar as a native Home tab** | Adds Calendar as its own tab on the Home page, no external plugin needed (recommended on Jellyfin 12's experimental layout) |
| **Use Plugin Pages** | Adds a sidebar link (requires [Plugin Pages](https://github.com/IAmParadox27/jellyfin-plugin-pages)) |
| **Use Custom Tabs** | Adds a custom tab (requires [Custom Tabs](https://github.com/IAmParadox27/jellyfin-plugin-custom-tabs)) |
| **First Day of Week** | Monday or Sunday |
| **Time Format** | 12-hour (`5pm/5:30pm`) or 24-hour (`17:00/17:30`) |
| **Highlight Favorites/Watchlist** | Highlights favorite shows/movies based on Jellyfin favorites |
| **Highlight Watched Series** | Highlights series you are currently watching |
| **Filter by Library Access** | Only shows calendar items from libraries the user can access; upcoming items are matched by their Sonarr/Radarr root folder. Default on. |
| **Show Requested Only (Default)** | Calendar loads showing only requested items by default, but users can still change filters. |
| **Force Only Requested Items** | Calendar always shows only the user's requested items and hides the Requests filter. |

After enabling with Plugin Pages, restart Jellyfin for the sidebar link to appear.

Direct URL: `/web/index.html#/calendar`

---

## Requests Page Settings

Found in the **Pages** tab under "Requests Page".

| Setting | Description |
|---|---|
| **Enable Requests Page** | Enables a dedicated page showing active downloads from Sonarr/Radarr |
| **Add Requests as a native Home tab** | Adds Requests as its own tab on the Home page, no external plugin needed (recommended on Jellyfin 12's experimental layout) |
| **Use Plugin Pages for Requests** | Adds a sidebar link (requires [Plugin Pages](https://github.com/IAmParadox27/jellyfin-plugin-pages)) |
| **Use Custom Tabs for Requests** | Adds a custom tab (requires [Custom Tabs](https://github.com/IAmParadox27/jellyfin-plugin-custom-tabs)) |
| **Enable Auto-Refresh** | Automatically refreshes download status |
| **Poll Interval (seconds)** | How often to refresh, in seconds (30–300, default: 30) |
| **Filter Downloads by User Requests** | When on (default), non-admin users only see downloads for content they requested; when off, all authenticated users see the entire download queue, including items requested by others. |

!!! note
    The Requests page is a single page (Pages tab): it shows *arr downloads and, when Seerr is configured, Seerr media requests and issues. Toggle each source with "Show Downloads in Requests Page" and "Show Seerr Issues Section".

Direct URL: `/web/index.html#/downloads`
