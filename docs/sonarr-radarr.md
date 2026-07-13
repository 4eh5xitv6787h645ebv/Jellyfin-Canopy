# Sonarr & Radarr

If you run Sonarr, Radarr, or Bazarr behind Jellyfin, this integration brings them to where you already are. As an administrator you get quick links, search, and library management on every movie, series, season, and episode page, without opening a separate arr tab. Everyone on the server gets a shared **Calendar** of what's coming and a **Requests** page that tracks the download queue in real time. And synced \*arr tags become clickable filters right on the item you're looking at.

The integration is deliberately split by audience. The parts that reach into your arr apps — links, Search, Interactive Search, and Manage — are **admin-only** and policy-gated on the server, not merely hidden in the UI. The parts that are safe for everyone — the Calendar page, the Requests page, and synced tag links — are available to all users.

!!! warning "Before you connect anything"

    - **API keys** are stored on the server, never exposed to browsers.
    - **Network access** — treat your arr instances as sensitive; keep them off the open internet unless you mean to expose them.
    - **HTTPS** — use HTTPS for any remote access.

    Every request the plugin makes to a configured arr URL also passes through a built-in [SSRF host guard](#security-the-ssrf-host-guard) that fails closed.

New to the plugin? Start with [Getting Started](getting-started.md) to install it, then come back here. The Requests page is shared with Seerr, so if you also run Seerr, see [Discover & Request](discover.md).

## What you get

One connection puts links to your Sonarr, Radarr, and Bazarr instances directly on Jellyfin item pages, and can surface arr tags, upcoming releases, and the live download queue alongside them.

- **Quick links** — jump to Sonarr, Radarr, or Bazarr for any item.
- **Search & Interactive Search** — trigger an automatic search, or pick a release by hand, straight from the item menu.
- **Manage (Monitor & Add)** — toggle monitoring, or add a movie or series to Sonarr/Radarr, from Jellyfin.
- **Tag links** — display synced arr tags as clickable, filterable links.
- **Calendar page** — upcoming releases from Sonarr and Radarr.
- **Requests page** — the active download queue with progress and status.

!!! note "Who sees what"

    \*arr links, Search, Interactive Search, and Manage are visible to **admin users only**. The Calendar page, the Requests page, and synced tag links are available to **all users**.

## Connecting your instances

Everything starts on the **\*arr** tab: **Dashboard → Plugins → Jellyfin Canopy → \*arr**. You can connect several Sonarr and several Radarr instances at once — handy when you split libraries by type or quality (TV vs. Anime, HD vs. 4K). Neither service is mandatory; set up whichever you run.

To enable the on-page links:

1. Go to **Dashboard → Plugins → Jellyfin Canopy** and open the **\*arr** tab.
2. Check **"Enable \*arr Links on Detail Pages"**.
3. Add one or more Sonarr and/or Radarr instances (below).
4. Optionally add a **Bazarr URL** for subtitle-management links (see [Bazarr](#bazarr)).
5. Optional: check **"Show links as text"** for text links instead of icons.
6. Click **Save**.

### Adding a Sonarr or Radarr instance

1. On the **\*arr** tab, click **"+ Add Sonarr instance"** or **"+ Add Radarr instance"**.
2. Fill in **Name**, **URL (internal)**, and **API Key**.
3. Optionally add an **External URL** and/or **URL Mappings**.
4. Click **Save**.

### Instance fields

| Field | Required | What it does |
|---|---|---|
| **Name** | Yes | Display name shown in dropdowns (e.g. `TV Shows`, `Anime`, `4K Movies`). |
| **URL (internal)** | Yes | Internal base URL the Jellyfin *server* uses to reach the instance (e.g. `http://192.168.1.100:8989`). Can be a LAN or docker address browsers can't reach. |
| **External URL** | No | Public base URL a user's *browser* opens for links to this instance (e.g. `https://sonarr.example.com`). Leave empty to reuse the internal URL. |
| **API Key** | Yes | API key from the instance's **Settings → General** page. |
| **URL Mappings** | No | Per-instance URL remapping for reverse-proxy setups. Takes priority over External URL. |
| **Enabled** | — | Toggle to disable an instance without deleting it. Defaults to on. |

### Internal vs. external URLs

Each instance is reached from two different places, and they may need different addresses:

- The **Jellyfin server** fetches from Sonarr, Radarr, and Bazarr for link status, calendar data, the queue, and tag sync. It always uses the **URL (internal)**.
- A **user's browser** opens the service when someone clicks an "Open in Sonarr/Radarr/Bazarr" link. It uses the **External URL** when set, otherwise it falls back to the internal URL.

The browser link base is resolved with a clear precedence: **matching URL Mapping → External URL → internal URL**. Leaving External URL blank reproduces the previous single-address behaviour exactly.

!!! info "Malformed external URLs are rejected"

    An external URL that is missing `http://` or `https://`, embeds credentials, or carries a query string or fragment is rejected with a clear warning on save — and any unsafe value that slips through is additionally skipped at link-building time.

### URL Mappings

Use URL Mappings when the same Jellyfin server is reached at different addresses — local network versus remote — and each context should open a different arr address. Each line maps a Jellyfin access URL to the arr URL a browser should open from it:

```text
jellyfin_access_url|arr_url
```

The **left** side is matched against the Jellyfin server URL the browser is currently using; the **right** side is the arr link base returned for that context. Mappings can be set globally (the legacy fields) or per instance, and a per-instance mapping overrides the global one for that instance.

```text
https://jellyfin.example.com|https://sonarr.example.com
http://192.168.1.50:8096|http://192.168.1.100:8989
```

The net effect: users who reach Jellyfin over remote HTTPS get your public arr address, while users on the LAN get the local one.

### Disabling an instance

Toggle the **Enabled** switch off to skip an instance in every fan-out path — arr links, calendar, queue monitoring, and tag sync — without removing its configuration. Its URL and API key are preserved, so you can re-enable it at any time without re-entering credentials.

!!! tip

    Use the Enabled toggle during maintenance windows or when temporarily swapping out an instance.

### Legacy single-instance fields

The original `SonarrUrl`, `SonarrApiKey`, `RadarrUrl`, and `RadarrApiKey` fields are preserved for downgrade safety. If the multi-instance list is empty, the plugin automatically falls back to these fields, so existing setups keep working with no migration step.

!!! note

    Once you add instances via the new UI, the legacy fields are no longer used for arr links. They are not deleted, so downgrading to an older plugin version restores the previous single-instance behaviour.

### Bazarr

Bazarr is a single instance and needs no API key — add its address in the **Bazarr URL** field in the Setup section to get "Open in Bazarr" subtitle-management links. Like the arr instances, it has its own **Bazarr External URL** field so the browser can open a different address than the server fetches from.

## \*arr links on item pages

Once links are enabled, open any movie or TV show and look for the arr icons in the external-links section. The plugin detects the item type automatically and shows only the relevant service — **Radarr for movies, Sonarr for TV** — and the links are visible to administrators only.

Click an icon to open the item in the matching arr application, or click the dropdown to choose a specific instance.

**How links look depends on how many instances match the item:**

- **A single matching instance** renders as a plain icon link, with no badge clutter. To always show the status border and the episode/file count on single-instance links, enable **"Show status badge for single-instance"**.
- **Multiple matching instances** turn the link into a dropdown button. Each entry shows a colour-coded status dot, the instance name, the episode count (Sonarr) or download status (Radarr), and the file size on disk.

**Status colours:**

| Colour | Meaning |
|---|---|
| Green | Complete — all episodes present, or the file is present |
| Amber | Partial — some episodes missing |
| Grey | Missing — not in this instance |

The Calendar and Requests pages fan out across all enabled instances automatically.

## Search, Interactive Search, and Manage

These actions let you drive your configured Sonarr and Radarr instances straight from Jellyfin's own item menu — the three-dot menu on a card, the more button on a detail page, and long-press on touch — so you rarely need to open the arr web UI after setup. **Admin only**, and the endpoints are policy-gated on the server, not just hidden in the UI.

The menu items appear on **movies, series, seasons, and episodes** whenever the matching service (Radarr for movies, Sonarr for the TV kinds) has at least one enabled instance configured and the item carries a TVDB or TMDB id.

### Search (automatic)

Search fires the correct arr search command for the item and hands off to the arr's own grab logic:

| Item | Command |
|------|---------|
| Movie | Movie search |
| Series | Whole-series search |
| Season | Season search |
| Episode | Episode search |

If more than one configured instance tracks the item, the search runs on all of them. A toast reports how many instances started and, when the Requests page is enabled, points you there to watch progress.

### Interactive Search (manual release picker)

Interactive Search opens a themed release picker listing the candidate releases the arr found — title, quality, size, age, indexer, seeders/health, custom-format score, and any rejection reasons — with a **Grab** button per row. You can filter by text, sort (best match, size, age, seeders, or format score), hide rejected releases, and switch between instances that track the item. Grabbing sends the release to the arr's download client exactly as the arr UI would.

Interactive Search is offered for **movies, seasons, and episodes**. Sonarr has no whole-series manual search, so open a season or episode for TV.

### Manage (Monitor & Add)

The **Manage in Sonarr/Radarr…** item opens a compact panel that:

- toggles **Monitor / Unmonitor** per tracking instance;
- shows **live download progress** for the item, reusing the same queue as the [Requests page](#the-requests-page) — with a jump link there, so there's no second downloads view;
- and, for a movie or series **not yet tracked** by an instance, offers **Add to Sonarr/Radarr** with a quality-profile and root-folder picker, a monitor toggle, and an optional search-on-add.

Manage is gated by its own setting, so you can keep the menu search-only if you don't want changes made to the arr library from Jellyfin.

### Enabling and using

1. Configure at least one Sonarr and/or Radarr instance under the **\*arr** tab (URL + API key) — the same instances the arr links use. No extra connection details are needed.
2. On the same tab, under **Search & Interactive Search**, confirm **"Enable Search in the item menu"** is on (the default), and optionally turn on **"Enable management actions (Monitor / Add)"**.
3. Open any movie, series, season, or episode menu as an administrator — the **Search**, **Interactive Search**, and **Manage** items appear.

| Setting | Default | What it does |
|---|---|---|
| **Enable Search in the item menu** | On | Adds **Search** (automatic) and **Interactive Search** (manual release picker) to the item menu for movies, series, seasons, and episodes, driving the instances configured above. |
| **Enable management actions (Monitor / Add)** | On | Also adds **Monitor / Unmonitor** and **Add to Sonarr/Radarr**. Turn off to keep the menu search-only and prevent changes to the arr library from Jellyfin. |

!!! note

    Search finds the item in the arr by its TVDB (Sonarr) or TMDB (Radarr) id, so the item must already be tracked there. Use **Manage → Add to Sonarr/Radarr** to start tracking a movie or series that isn't yet in the arr.

## Tag sync

Tag sync copies the tags you keep in Sonarr and Radarr onto the matching Jellyfin items, then shows them as clickable, filterable links on item pages — so a tag like `in-netflix` or `4k-upgrade` becomes something viewers can act on. It's available to all users once the tags are synced.

**Prerequisites:** at least one Sonarr **and/or** Radarr instance configured (URL + API key). Neither service is mandatory — the sync task processes each independently and simply skips the one you haven't set up. A movie-only Radarr server or a TV-only Sonarr server works fine.

### How matching works

Sonarr series tags are matched to your Jellyfin library by **TVDB id** — Sonarr's canonical, always-present id — falling back to **IMDb id**. That means TVDB-scraped libraries, whose series may have no IMDb id, sync their tags reliably. Radarr movies are matched by **TMDB id**.

### Enabling tag sync

1. On the **\*arr** tab, check **"Enable Tags Sync"**.
2. Make sure the Sonarr/Radarr instances you configured above have valid API keys — tag sync uses those instance keys. There is no separate key field in the Tags Sync section.
3. Configure the tag settings and filters (below).
4. Click **Save**.

!!! warning "Tags only populate when the sync task runs"

    Tag syncing is performed by the scheduled task **"Sync Tags from \*arr to Jellyfin"** (**Dashboard → Scheduled Tasks**, category Jellyfin Canopy). Tags appear on items only after this task runs. Trigger it manually the first time, then add a schedule trigger so it runs periodically and picks up new items automatically.

### Tag settings

| Setting | Default | What it does |
|---|---|---|
| **Tag Prefix** | `JC Arr Tag: ` | Prefix added to synced tags so plugin-managed tags are easy to identify. Leaving the field blank falls back to the same `JC Arr Tag: ` default on both the write and read sides, so a cleared prefix no longer leaves orphaned tags. |
| **Clear old tags before sync** | Recommended on | Removes old plugin-managed tags before syncing, keeping tags clean and up to date. |
| **Show synced tags as links** | Recommended on | Displays tags as clickable links on item pages; clicking one shows all items with that tag. |

### Filtering which tags appear

Each filter is a newline-separated list — one tag name per line.

| Filter | What it does |
|---|---|
| **Show as Links Filter** | Only matching tags are displayed as links. Leave empty to show all tags. |
| **Hide Specific Links Filter** | Matching tags are not displayed as links. Overrides the show filter. |
| **Sync to Jellyfin Filter** | Only matching tags are synced from the arr. Leave empty to sync all tags. |

```text
in-netflix
in-disney
4k-upgrade
```

### Styling tag links (CSS)

Synced tag links render with `arr-tag-link` CSS hooks, so you can rename, hide, or recolour individual tags. Each link carries a `data-id` (the tag id) and a `data-tag-name` attribute, and its label sits in `.arr-tag-link-text`.

```css
/* Rename a tag: hide the original label, add a custom one */
.itemExternalLinks a.arr-tag-link[data-tag-name="1 - n00bcodr"] .arr-tag-link-text {
  display: none !important;
}
.itemExternalLinks a.arr-tag-link[data-tag-name="1 - n00bcodr"]::after {
  content: " N00bCodr";
}

/* Hide a specific tag */
.itemExternalLinks a.arr-tag-link[data-id="in-netflix"] {
  display: none !important;
}

/* Give a tag service colours */
.itemExternalLinks a.arr-tag-link[data-id="in-netflix"] {
  background: #d81f26;
  color: #fff;
}
```

See [Reference](reference.md) for more CSS hooks and examples.

## The Calendar page

![Calendar page showing upcoming Sonarr and Radarr releases](images/calendar-page.png)

The Calendar page collects upcoming releases from all your enabled Sonarr and Radarr instances into a single view, so everyone on the server can see what's arriving and when. It offers day, week, month, and agenda views, colour-codes events by series or movie, and lets you filter by Sonarr/Radarr or search by text. Click an event to view its details.

### Enabling

1. Go to **Dashboard → Plugins → Jellyfin Canopy** and open the **Pages** tab.
2. Check **"Enable Calendar Page"**.
3. Configure the settings below and click **Save**.

**Where it appears.** Calendar is a real page with its own route, so there's no delivery method to choose — Jellyfin Canopy adds its entry points automatically on every layout. The legacy layout gets a **Calendar** link in the **Jellyfin Canopy** section of the sidebar drawer (and in the mobile drawer); the modern layout gets an icon button in the header tray and a link in the user-preferences menu. Because it's a genuine router destination, you can open it directly at `/web/index.html#/calendar`, and browser back/forward, page refresh, and deep links all work.

The order of the page entries in every menu follows the admin **Pages order** setting on the **Pages** tab. Reorder the four pages there — the default order is **Calendar, Requests, Bookmarks, Hidden Content** — using the up/down controls in its **Page order** area.

!!! note "Upgrading from an earlier version"

    Older releases let you pick a delivery method for each page — Plugin Pages, Custom Tabs, or a native Home tab. Those options have been removed: the pages are now ordinary routed destinations with automatic entry points, so no delivery method is needed. Any delivery-mode selections you had are retired automatically on upgrade, and any entries Jellyfin Canopy created in the Custom Tabs plugin are cleaned up from its configuration on first startup.

### Calendar settings

Found on the **Pages** tab under "Calendar Page".

| Setting | Default | What it does |
|---|---|---|
| **First Day of Week** | Monday | The weekday the calendar starts on — any weekday, Sunday through Saturday. |
| **Time Format** | — | 12-hour (`5pm/5:30pm`) or 24-hour (`17:00/17:30`). |
| **Highlight Favorites/Watchlist** | — | Highlights favorite shows and movies, based on your Jellyfin favorites. |
| **Highlight Watched Series** | — | Highlights series you are currently watching, based on watch history. |
| **Filter by Library Access** | On | Restricts calendar items to libraries the user can access. Upcoming items not yet in Jellyfin are matched by their Sonarr/Radarr root folder. |
| **Show Requested Only (Default)** | — | The calendar loads showing only requested items; users can still toggle other items back on. |
| **Force Only Requested Items** | — | Locks the calendar to requested items only and removes the ability to show non-requested items, enforcing the filter. |

!!! note "Accuracy with multiple instances and date-only releases"

    - **Multiple instances** — when the same show or movie exists in more than one Sonarr/Radarr instance, its events are disambiguated **per instance**, so each keeps the correct instance icon and click-through even when two instances number their items identically.
    - **Date-only releases** — a release with no exact air time (Radarr cinema/digital/physical dates, and the Sonarr air-date fallback) is placed on its intended **local calendar day** with no spurious clock time, instead of drifting a day earlier for viewers west of UTC. Genuine air-time releases (Sonarr `airDateUtc`) are still shown in your local time.
    - **Duplicate collapsing** is deterministic — the same release always collapses to the same single event regardless of which instance or date order it was fetched in.

## The Requests page

![Requests page showing the active Sonarr/Radarr download queue](images/downloads-page.png)

The Requests page shows the active download queue from Sonarr and Radarr in one place — progress bars and ETA, quality and file size, with filtering and search — so users can watch what they're waiting on without an arr login. It auto-refreshes on a configurable interval. Its route is `#/downloads`.

### Enabling

1. Go to **Dashboard → Plugins → Jellyfin Canopy** and open the **Pages** tab.
2. Check **"Enable Requests Page"** (under the "Requests Page" section).
3. Click **Save**.

**Where it appears.** Like the Calendar page, Requests is a routed destination with automatic entry points — there's no delivery method to configure. Its link and header-tray button appear on every layout (in the **Jellyfin Canopy** drawer section, the modern-layout header tray, and the user-preferences menu), positioned by the admin **Pages order** setting. Open it directly at `/web/index.html#/downloads`; browser back/forward, refresh, and deep links all work.

!!! note "One page, two sources"

    This is the same unified Requests page that also surfaces Seerr media requests and issues when a Seerr server is connected (see [Discover & Request](discover.md)). Toggle the arr download queue with **"Show Downloads in Requests Page"** and the Seerr issues with **"Show Seerr Issues Section"**, both under the **Requests Page** section of the **Pages** tab.

### Requests page settings

Found on the **Pages** tab under "Requests Page".

| Setting | Default | What it does |
|---|---|---|
| **Enable Requests Page** | — | Enables the dedicated page showing active downloads from Sonarr/Radarr. |
| **Enable Auto-Refresh** | — | Automatically refreshes download status. |
| **Poll Interval (seconds)** | 30 | How often to refresh, in seconds. Range 30–300. |
| **Filter Downloads by User Requests** | On | When on, non-admin users only see downloads for content they requested; when off, all authenticated users see the entire download queue, including items requested by others. |

## Security: the SSRF host guard

Because the plugin makes server-side requests to whatever arr URLs you configure, it guards every one of them against server-side request forgery (SSRF). The guard fails closed.

- **Cloud-metadata and link-local addresses are blocked** (for example `169.254.169.254` and the whole `169.254.0.0/16` range), so a malicious or misconfigured URL can't be used to reach a cloud provider's metadata service.
- **Loopback (`127.0.0.1`, `::1`) and private LAN ranges (`10.0.0.0/8`, `192.168.0.0/16`, `172.16.0.0/12`) stay allowed** by design, because Sonarr and Radarr commonly run on the same host or LAN as Jellyfin.
- A hostname that **cannot be resolved** fails closed — the request is blocked rather than allowed through — and the actually-resolved IP is re-checked at connect time to defeat DNS rebinding.

If a legitimate arr instance is being blocked, confirm its address is a normal loopback, LAN, or public address and that its hostname resolves from the Jellyfin server.

## Troubleshooting

### Links not appearing

1. Verify the arr URLs are correct.
2. Ensure **"Enable \*arr Links on Detail Pages"** is checked.
3. Confirm you're logged in as an administrator — the links are admin-only.
4. Check the item has arr metadata.

If they still don't show, open the arr URLs in a browser to confirm they're reachable from the Jellyfin server, and check for HTTP/HTTPS mismatches.

### Tags not syncing

First, **run the sync task** — tags are populated by the scheduled task **"Sync Tags from \*arr to Jellyfin"** and only appear after it runs:

1. Go to **Dashboard → Scheduled Tasks**.
2. Find **"Sync Tags from \*arr to Jellyfin"** (category: Jellyfin Canopy) and run it manually.
3. Add a schedule trigger so it runs periodically and picks up new items.

If tags still don't appear, check that the API keys are correct and test API access manually (and check the arr logs for errors). Then check your tag settings: the prefix should match, the sync filter shouldn't be too restrictive, and the tags must exist in the arr.

**Sonarr series tags specifically:** series are matched by **TVDB id** first, then by **IMDb id**. A series with neither id in Sonarr can't be matched — check the series' provider ids in Sonarr.

### Calendar icons or links wrong across instances

If a show or movie exists in **multiple** Sonarr/Radarr instances and its calendar event shows the wrong instance icon or opens the wrong instance, that shouldn't happen — events are disambiguated per instance. Make sure each instance has a distinct **Name** in the plugin settings.

### An \*arr URL is blocked

This is the [SSRF host guard](#security-the-ssrf-host-guard) doing its job. Confirm the instance's address is a normal loopback, LAN, or public address, and that its hostname resolves from the Jellyfin server. Cloud-metadata and link-local addresses are blocked deliberately.

### Calendar not loading

Check the prerequisites: Sonarr/Radarr URLs configured, API keys entered, the arr instances accessible, and the Calendar page enabled.

**Blank screen or "Cannot find module" error (Cloudflare Rocket Loader):** if the Calendar or Requests page shows a blank screen and the browser console shows `Cannot find module './'`, the cause is usually **Cloudflare Rocket Loader** interfering with Jellyfin's JavaScript module system — it rewrites and defers script loading in a way that can break dynamic module imports.

To fix it, disable Rocket Loader for your Jellyfin domain in Cloudflare:

1. Log in to the [Cloudflare dashboard](https://dash.cloudflare.com).
2. Select your domain.
3. Go to **Speed → Optimization → Content Optimization**.
4. Toggle **Rocket Loader** off.

Alternatively, disable it for specific pages with a Page Rule or Configuration Rule targeting your Jellyfin URL. For more context, see [Jellyfin Enhanced issue #570](https://github.com/n00bcodr/Jellyfin-Enhanced/issues/570), a historical reference from the upstream project this integration is based on.

If the page still won't load, check the browser console for client errors, the server logs for API errors, and the arr logs for connection issues.

### Requests page issues

**Downloads not showing:** verify polling is enabled, check the poll interval, ensure downloads actually exist in the arr, and confirm API connectivity.

**Status not updating:** verify polling is enabled, check the poll interval, refresh the page manually, and check the browser console for errors.

## Getting help

If you're stuck:

1. Check the [FAQ](help.md) for common solutions.
2. Verify your arr URLs and API keys.
3. Check the browser console and server logs.
4. Report issues on [GitHub](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues).
