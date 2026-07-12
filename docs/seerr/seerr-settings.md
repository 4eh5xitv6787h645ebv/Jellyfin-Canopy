# Seerr Settings

!!! info "Prerequisites"

    **Prerequisites:**

    - Seerr instance
      - **API key**
      - Jellyfin Sign-In enabled

!!! warning "Disclaimer"

    **This plugin is NOT affiliated with Seerr.** Seerr is an independent project.

    **Please report plugin issues to the Jellyfin Elevate repository, not to the Seerr team.**

## Setup

### Step 1: Enable Jellyfin Sign-In in Seerr

1. In Seerr, go to **Settings** → **Users**
2. Enable **"Enable Jellyfin Sign-In"**
3. Save settings

![Jellyfin Sign-In setting in Seerr](../images/jellyfin-signin.png)

### Step 2: Import Jellyfin Users

This step is optional if you enable plugin-side auto import.

1. In Seerr, go to **Users** page
2. Click **"Import Jellyfin Users"**
3. Select users to import
4. Save changes

**User Access:**

- Users WITH access:

  ![Users with access](../images/users-with-access.png)

- Users WITHOUT access:

  ![Users without access](../images/users-no-access.png)

### Step 3: Configure Plugin

1. Go to **Dashboard** → **Plugins** → **Jellyfin Elevate**
2. Navigate to the **Seerr** tab
3. Check **"Enable Seerr integration"** (master toggle — nothing Seerr-related works until this is enabled)
4. Check **"Show Seerr Results in Search"**
5. Enter your **Seerr URL(s)** (one per line) — the **internal** address the Jellyfin *server* uses
   - Use the internal/LAN URL for best performance
   - Can provide multiple URLs (first successful connection used)
6. Optionally enter a **Seerr External URL** — the **public** address a user's *browser* opens for "Open in Seerr" links (see [Internal vs External URL](#internal-vs-external-url) below). Leave blank to reuse the internal URL.
7. Enter your **Seerr API Key**

   - Found in Seerr: **Settings** → **General** → **API Key**
8. Click the **"Test"** button next to the API Key field to verify the connection
9. Enable optional features (see below)
10. Click **Save**

!!! note "TMDB API Key (optional)"
    The Seerr tab also has a **TMDB API Key** field. This shared TMDB key enables
    person/keyword discovery (**"More from Actor"** and tag discovery) and the
    streaming-provider posters shown on Seerr results. It is the **same** key used by
    Elsewhere — enter it in either place and both features use it. See
    [Elsewhere Settings](../elsewhere/elsewhere-settings.md#getting-a-tmdb-api-key)
    for how to obtain one; that page is where the TMDB key is primarily documented.

### Internal vs External URL

Seerr is reached from two very different places:

- The **Jellyfin server** talks to Seerr for search, requests, issues and user import. It should use the **internal** URL (LAN or docker-network address) — configured in **Seerr URL(s)**. This URL may be unreachable from a user's browser.
- A **user's browser** opens Seerr when they click an "Open in Seerr" link. It needs a **public** URL — configured in **Seerr External URL**.

| Field | Used by | Example |
|---|---|---|
| **Seerr URL(s)** | Jellyfin server (all API calls) | `http://seerr:5055` |
| **Seerr External URL** | User browsers (deep links only) | `https://requests.example.com` |

!!! tip
    Leave **Seerr External URL** blank if the internal URL is already reachable from browsers — links then reuse the internal URL exactly as before (no behaviour change). Set it when Seerr sits behind a reverse proxy / auth gateway that the server bypasses on the LAN but users reach over the internet. When set, the internal Seerr URL itself is no longer sent to non-admin clients as the link base.

For advanced setups where users reach Jellyfin through several different URLs, **URL Mappings** (under *Advanced URL Mappings*) can map each Jellyfin access URL to a specific Seerr URL; a matching mapping takes priority over the External URL. The External URL is the simpler option and covers most deployments.

!!! note
    URL Mappings are delivered to every signed-in client so their browser can pick the right link — both sides of each mapping are user-visible by design. Only put URLs in mappings that users are meant to see and open.

A malformed value (missing `http://`/`https://`, embedded credentials, or a query string/fragment) is rejected with a clear warning on save and never used.

### Step 4: Configure User Import (Optional)

Enable automatic import in the plugin if you do not want to manually import users in Seerr.

When enabled, new Jellyfin users are automatically imported into Seerr the first time they use Seerr Search.

1. Go to **Dashboard** → **Plugins** → **Jellyfin Elevate**
2. Navigate to the **Seerr** tab
3. In the **Users** section, check **"Auto import Jellyfin users to Seerr"**
4. Optional: expand **Blocked Users** and select users to exclude
5. Optional: click **Import Users Now** to run immediate bulk import
6. Click **Save**

!!! tip
    The scheduled task **Import Jellyfin Users to Seerr** runs every 6 hours by default when auto import is enabled.
    You can change the trigger in Jellyfin Dashboard -> Scheduled Tasks.

## Optional Features

### Add Requested Media to Watchlist
!!! note "Requirements"

    **Requirements:**

      - The **[KefinTweaks plugin](https://github.com/ranaldsgift/KefinTweaks)**
      - Automatically add items to Jellyfin watchlist when they become available

### Sync Seerr Watchlist to Jellyfin
- Sync your Seerr watchlist items to Jellyfin watchlist
- Items added when they become available in library

### Sync Jellyfin Watchlist to Seerr
- Sync each user's Jellyfin watchlist to their linked Seerr watchlist
- Runs via the **Sync Watchlist from Jellyfin to Seerr** scheduled task (default: daily at 03:30)
- Requires users to have a linked Seerr account

### Show 'Report Issue' Button
- Display issue reporting button on item detail pages
- Report video, audio, subtitle, or other problems

### Show Open Issue Indicator

*Default: off.* When enabled, the **Report Issue** button turns orange and shows a
count badge whenever the item already has open issues in Seerr, so users can tell at
a glance that a problem has already been reported. Requires **Show 'Report Issue'
Button**.

### Enable 4K Requests
!!! note "Requirements"

    **Requirements:**

    - Seerr instance with **4K configuration**
    - Permissions for users to request 4K quality

This is a **master switch**. Even with it on, the 4K movie option is only shown
when **both** of the following hold, and is hidden otherwise:

- Seerr actually reports 4K movies as enabled (a default 4K Radarr is configured
  — Seerr's `movie4kEnabled`), and
- the signed-in user holds the Seerr **REQUEST_4K** (or **REQUEST_4K_MOVIE**)
  permission.

So a user without 4K permission, or a Seerr server with no 4K Radarr, simply
never sees the 4K affordance. The server enforces the same rule on the request
itself, so the option can never be used without permission.

### Enable 4K TV Requests

!!! note "Requirements"
    **Requirements:**

    - Seerr instance with **4K Sonarr configured**
    - Permissions for users to request **4K Sonarr** quality

Also a **master switch**, gated the same way: the 4K TV option is shown only when
Seerr reports 4K series enabled (`series4kEnabled`, a default 4K Sonarr) **and**
the user holds **REQUEST_4K** (or **REQUEST_4K_TV**).

  When enabled and available:

  - TV request buttons include a 4K dropdown action.
  - Choosing **Request in 4K** opens the season modal in 4K mode.
  - The season modal title shows **Request Series - 4K**.
  - The primary season modal button label becomes **Request in 4K**.

### Show Advanced Request Options
- Display advanced options in request modal
- Season selection, quality options, etc.

### Show Request Quota Info

*Default: on.* Request modals display a chip showing the user's current request usage
and when their next request slot frees up, read from Seerr's per-user quota. When a
request is blocked by quota, a detailed quota-error dialog is shown instead of a
vanishing toast.

### Show Collections in Seerr Results
- Display TMDB collections (e.g., Harry Potter, Marvel Cinematic Universe) in Seerr search results
- Includes an option to request the entire collection at once
- The collection request modal lists every movie with its current status; movies
  that are already available, already requested or blocklisted are pre-disabled,
  and only the selected, still-requestable movies are submitted (one request per
  movie, matching Seerr's own behaviour)
- When 4K movie requests are available to you (see **Enable 4K Requests**), the
  collection modal shows a **Request in 4K** toggle that submits the selected
  movies in 4K and re-evaluates each movie against its 4K status
- Enabled by default

### Open Results in "More Info" Modal

*Default: off.* Controls what happens when a user clicks a Seerr search result's title
or poster. When **off**, the result opens the item in Seerr. When **on**, an in-app
**More Info** modal opens instead, keeping the user inside Jellyfin.

### Show "Request More" Button on Series

*Default: on.* Adds a **Request More** button beside the Seasons heading on Series
detail pages whenever the show has unrequested seasons in Seerr, letting users request
additional seasons without going through the search bar.

### Auto Import Jellyfin Users to Seerr

- Just-in-time import when a user first accesses Seerr search and is not linked yet
- Scheduled bulk import via **Import Jellyfin Users to Seerr** task
- Manual bulk import via **Import Users Now** button
- Blocklist support to exclude selected Jellyfin users from lookup/import

## Recently Added Sync to Seerr

**Trigger Seerr recently-added scan when new Jellyfin items are added** (default off) — when on, the plugin asks Seerr to run its recently-added scan whenever new items are imported into your Jellyfin library, so Seerr marks matching requests as available sooner.

- **Debounce (seconds)** (default 60, range 5-3600) — coalesces bursts of item-added events into a single Seerr scan, so a large library import triggers one scan after activity settles rather than one per item.

## Requests Page Management

### Enable Requests Page

Display a dedicated page showing active downloads from *arr and requests from Seerr.

!!! note "Only one data source is required"
    The page works with either source on its own — a single Sonarr **or** Radarr instance powers the downloads list (a movie-only Radarr or TV-only Sonarr setup is enough), and Seerr powers the requests/issues list. You do not need to configure Sonarr, Radarr and Seerr all together.

**Configuration:**

1. Go to **Dashboard** → **Plugins** → **Jellyfin Elevate**
2. Navigate to the **Pages** tab (look for the section titled "Requests Page")
3. Check **"Enable Requests Page"**
4. Choose integration method:
   - **Use Plugin Pages for Requests** - Adds sidebar link (requires [Plugin Pages](https://github.com/IAmParadox27/jellyfin-plugin-pages) plugin)
   - **Use Custom Tabs for Requests** - Adds custom tab (requires [Custom Tabs](https://github.com/IAmParadox27/jellyfin-plugin-custom-tabs) plugin)
   - **Add Requests as a native Home tab** - Shows Requests as a native tab on the Home screen (experimental layout; no extra plugin required)
5. Click **Save** and restart Jellyfin if using Plugin Pages

### Show Downloads in Requests Page

Control whether active downloads from Sonarr/Radarr appear on the Requests page.

- **Enabled by default** - Shows active downloads alongside requests and issues
- Requires *arr integration to be configured
- Can be toggled independently

### Show Seerr Issues Section

Display Seerr issues on the Requests page.

- View all reported issues
- Filter by issue status
- Link to Seerr reporter modal

### Enable In-App Request Approvals

Show **Approve** / **Decline** buttons on pending Seerr requests in the Requests
page, so admins can act on requests without opening Seerr.

- **Enabled by default**
- The buttons render only for callers Seerr would let approve — **Jellyfin
  admins** and Seerr users with the **Manage Requests** (or **Admin**) permission.
- Actions are proxied server-side to Seerr with the plugin's configured Seerr API
  key (never exposed to the browser); the acting user is passed through so Seerr
  records the correct approver.
- When disabled, the buttons never render and the approve/decline endpoint refuses
  the action.

See [In-App Request Approvals](seerr-features.md#in-app-request-approvals) for the
full behaviour.

### Auto-Refresh Settings

- **Enable Auto-Refresh** - Automatically refresh download and request status
- **Poll Interval (seconds)** - How often to refresh (30-300 seconds, default: 30)
  - Lower = more frequent updates (higher server load)
  - Higher = less frequent updates (lower server load)