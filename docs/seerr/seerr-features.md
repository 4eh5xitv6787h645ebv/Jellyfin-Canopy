# Seerr Integration

Search, request, and discover media directly from Jellyfin using your Seerr instance.

![Seerr search results](../images/jellyseerr.png)

!!! note

    **This plugin is NOT affiliated with Seerr.** Seerr is an independent project. This plugin simply integrates with it to enhance the Jellyfin experience.

    **Please report any issues with this plugin to the Jellyfin Elevate repository, not to the Seerr team.**

## Features

- **Search + Request** - Search + request from Seerr, directly from Jellyfin search results
    - **Advanced requests** *(requires configuration)*
    - **4K Requests**
    - **4K TV Requests**
    - **Season selection**

- **Requests Page**
    - **View request status** - pending, approved, available
- **Recommendations + Discovery** - Recommendations and similar items on detail pages
- **Issue Reporting** - Report problems directly to Seerr
- **Watchlist Sync** - Auto-add requested media to Jellyfin watchlist (*[requires the KefinTweaks plugin](https://github.com/ranaldsgift/KefinTweaks)*)


!!! tip "How it works"

    To ensure security and prevent CORS errors, the plugin uses the Jellyfin server as a proxy. This keeps your Seerr API key safe and avoids browser security issues.


### Search Integration

#### Requesting:

1. Type search query in Jellyfin search bar
2. Results from both Jellyfin and Seerr appear
3. Seerr results show request status
4. Click to request or view details

#### 4K Requesting:

1. Enable **4K Requests** / **4K TV Requests** in plugin settings (master switch).
2. For movie/TV results, use the request split-button dropdown and choose **Request in 4K**.
3. For TV, the season selection modal opens in 4K mode — the header shows **Request Series - 4K** and the primary button shows **Request in 4K**.

!!! note "When the 4K option appears"

    Beyond the admin master switch, the 4K option is only offered when the Seerr
    server actually has 4K enabled for that media type (a default 4K Radarr /
    Sonarr — Seerr's `movie4kEnabled` / `series4kEnabled`) **and** the signed-in
    user holds the Seerr **REQUEST_4K** (or the media-specific
    **REQUEST_4K_MOVIE** / **REQUEST_4K_TV**) permission. Otherwise the 4K
    affordance is hidden. The server enforces the same rule on the request
    itself, so a 4K request can never be made without permission.

!!! tip

    In More Info modal, TV actions use **Request More** as the primary action, with **Request in 4K** in the dropdown when 4K is requestable.

#### Request Status Indicators:

- **Available** - Already in your library
- **Pending Approval** - Request submitted, awaiting admin approval
- **Requested** - Request approved, waiting to be downloaded
- **Processing** - Actively downloading
- **Declined** - Request was declined by an admin
- **Not Requested** - Click to request

#### Seerr-Only Results Filter

By default the search page shows both Jellyfin and Seerr results. To focus on
Seerr alone, **double-click** the Seerr search icon (**double-tap** on touch
devices, or focus it and press ++enter++ / ++space++). This toggles a "show only
Seerr results" mode that hides the Jellyfin result sections and moves the Seerr
section to the top; a *Showing results only from Seerr* toast confirms the
change. Toggle it again to restore all sections (a *Showing all search results*
toast confirms).

!!! note

    The filter is only available while the Seerr icon is **Active** — that is,
    Seerr is connected and your Jellyfin user is linked (see [Icon States](#icon-states)).
    The icon's tooltip reflects the current mode ("Double-click to show only Seerr
    results" / "Double-click to show all results").

### Parental-Rating Filtering

Hide Seerr search and discovery results a user could not watch once requested,
based on that user's own Jellyfin content-rating restriction. This keeps a
child account on a PG limit from ever seeing (or requesting) an R-rated title.

Filtering happens **server-side**: restricted titles are removed from the
response before it reaches the browser, so they can't be recovered by
inspecting network traffic — a client-side hide would only conceal the cards.

#### Behavior

- Uses each user's own **Maximum Parental Rating** and **Block unrated items**
  settings from their Jellyfin account (Dashboard → Users → *user* → Access).
  Nothing is duplicated in the plugin — Jellyfin remains the single source of
  truth for what each user may watch.
- Applies to search results, discovery rows (genre/network/keyword/studio),
  similar/recommended sections, collections, watchlists, person filmographies
  (including the films listed under a person), and the **Requests page** — as
  well as the requested-items feed the **Calendar** draws from. Each list is
  filtered against the caller's own limit before it reaches the browser, so no
  user ever sees an above-limit title in their requests or upcoming releases.
- A restricted user also cannot **open** a blocked title's detail/season or
  **request** it by id — both are rejected server-side, not just hidden.
- The raw TMDB passthrough is **denied by default** for a rating-limited user.
  Only rating-free lookups pass through untouched (genre lists, and keyword
  or company *search*); a movie/TV detail or one of its own parts is
  served only when the parent title is within the user's limit; and everything
  else — discover, trending, title search, similar and recommendations, person
  and collection browsing — is blocked. Any new or unknown passthrough shape is
  blocked until it is explicitly reviewed as safe, so a future endpoint cannot
  leak restricted results by accident.
- A title's certification is read the same way the More Info modal shows it
  (region → US → first available), using your **Default Region** (Elsewhere
  setting) to choose the certification system.
- **Administrators are never filtered**, and **users with no rating limit set
  see everything** — matching how Jellyfin treats parental controls for the
  library. `adult` titles are always hidden from restricted users.

Tag-based parental controls are enforced too: a user whose Jellyfin policy
**blocks items with tags** (for example `zombie` or `horror`) won't be sent
matching titles in Seerr search/discovery, gets a 403 on their detail pages,
and can't request them; **Allow only items with tags** works as the same
strict allow-list it is in the library. The two directions deliberately match
different metadata: **blocked** tags match a title's TMDB **keywords and
genre names** (keywords are the very strings Jellyfin's TMDB provider imports
as library Tags, and genre names are included so blocking "horror" also
covers the genre — over-hiding is the safe direction), while **allowed** tags
match **keywords only**, exactly mirroring the library (genres never become
item Tags, so a genre match must not satisfy an allow-list the library itself
would enforce more strictly). Matching uses Jellyfin's own normalization
("Sci-Fi" = "sci fi"), and a blocked tag always wins over an allowed one,
exactly like the native rules.

#### Configure

1. Enable **"Respect parental ratings"** in Seerr search settings (on by
   default); **"Respect blocked / allowed tags"** (also on by default) controls
   the tag rules specifically.
2. Set each restricted user's **Maximum Parental Rating**, **Block items with
   tags** / **Allow only items with tags**, and optionally **Block unrated
   items** in their Jellyfin account. Users with no limit and no tag rules are
   unaffected.

!!! note "Limitations"

    - **Tag matching relies on TMDB metadata.** Keywords are community-sourced
      and uneven — an obscure title may simply lack the keyword you blocked
      (blocking the *genre* name gives broader coverage). Titles whose
      keywords/genres can't be fetched are hidden for tag-restricted users
      (fail closed), like unverifiable certifications.
    - **Unrated titles** (no certification on TMDB) follow the user's
      **Block unrated items** setting, exactly as in the library.
    - Certifications and tag signatures are fetched per title and cached (see
      [Advanced Configuration](#advanced-configuration)); the first search that
      surfaces a new title for a restricted user is slightly slower.

### Item Details

View Seerr recommendations and similar items on detail pages.

- Recommended items section
- Similar items section
- Request directly from recommendations
- Exclude items already in library
- Real-time request status

#### Configure
1. Check **"Show similar items"** and/or **"Show recommended items"**
2. Optional: Enable **"Exclude items already in library"**
3. Optional: Enable **"Exclude blocklisted items"**

### Discovery Pages

Browse and discover content by various criteria.

#### Available Discovery Types

- **Genre Discovery** - Browse by genre (Action, Comedy, etc.)
- **Network Discovery** - Browse by network (Netflix, HBO, etc.)
- **Person Discovery** - Browse by actor, director, crew
- **Tag Discovery** - Browse by custom tags
- **Collection Discovery** - On a collection/BoxSet page, surface the collection's movies not yet in your library, each with a request button (on by default)

#### Features

- Filter by TV/Movies/All
- Infinite scroll with pagination
- Request directly from discovery
- Library awareness (hide owned items)

#### Configure

1. Check respective discovery options in settings
2. Access via custom navigation or direct URLs

### Issue Reporting

Report problems with media directly to Seerr.

#### Issue Types

- Video (quality, corruption, wrong file)
- Audio (sync, missing tracks, quality)
- Subtitles (sync, missing, incorrect)
- Other (metadata, artwork, etc.)

#### How to Report

1. Open movie or TV show detail page
2. Click report icon in action buttons
3. Select issue type
4. For TV: Select season and episode (optional)
5. Enter description
6. Submit report

!!! note

    Issue reporting button will be hidden, if these are true:

    * Seerr is not reachable
    * User is not linked

## Requests Page

![Seerr requests page showing pending, approved, and available requests](../images/seerr-requests-page.png)

Monitor active downloads from Sonarr/Radarr and manage Seerr requests and issues in one dedicated page.

### Setup

1. Go to **Dashboard** → **Plugins** → **Jellyfin Elevate**
2. Navigate to the **Pages** tab
3. Check **"Enable Requests Page"**
4. Optionally check **"Show Downloads in Requests Page"** to display active *arr downloads (enabled by default)
5. Optionally check **"Show Seerr Issues Section"** to display Seerr issues
6. Optionally check **"Enable In-App Request Approvals"** to show Approve / Decline buttons on pending requests (enabled by default) — see [In-App Request Approvals](#in-app-request-approvals)
7. Choose integration method:
   - **Use Plugin Pages for Requests** - Adds sidebar link (requires [Plugin Pages](https://github.com/IAmParadox27/jellyfin-plugin-pages) plugin)
   - **Use Custom Tabs for Requests** - Adds custom tab (requires [Custom Tabs](https://github.com/IAmParadox27/jellyfin-plugin-custom-tabs) plugin)
   - **Add Requests as a native Home tab** - Shows Requests as a native tab on the Home screen (experimental layout)
8. Configure polling settings (see below)
9. Click **Save**
10. Restart Jellyfin if using Plugin Pages

!!! note "You only need one data source"
    The Requests Page draws from two **independent** sources and is useful with either one:

    - **Downloads** come from your ***arr** services — a single **Sonarr *or* Radarr** instance is enough. A movie-only setup with just Radarr (or a TV-only setup with just Sonarr) works fine; the other service is not required.
    - **Requests and issues** come from **Seerr**.

    Configure whichever you use. You do **not** need to set up Sonarr, Radarr and Seerr all at once — any one of them enables the page.

### Polling Settings

#### Enable Auto-Refresh

- Auto-refresh download status
- Recommended: Enabled

#### Poll Interval:

- Default: 30 seconds
- Range: 30-300 seconds
- Lower = more frequent updates, higher server load

### Usage

#### Access Requests Page

- Click "Requests" in sidebar (Plugin Pages)
- Navigate to custom tab (Custom Tabs)
- Direct URL: `/web/index.html#/downloads`

#### Features

- View active downloads (if enabled)
- View Seerr requests with status chips (Pending Approval, Requested, Processing, Declined)
- View reported issues (if enabled)
- Progress bars and ETA for downloads
- Quality and size information
- Filter by status
- Search functionality
- **Approve / Decline buttons** — admins and users with Manage Requests permission see green approve and red decline icon buttons on pending requests (see [In-App Request Approvals](#in-app-request-approvals))

!!! note "Complete lists and per-user filtering"

    - The request list is filtered by **each caller's own Jellyfin parental-rating
      limit** (see [Parental-Rating Filtering](#parental-rating-filtering)), and a
      user who can only see their own requests never receives another user's rows.
    - The **Coming Soon** view aggregates *all* pages of pending and approved
      requests before paging locally, so it no longer stops at the first page and
      its totals reflect the full future-dated set.

### In-App Request Approvals

Approve or decline pending Seerr requests without leaving Jellyfin. Pending
request cards on the Requests page show a green **Approve** and a red **Decline**
button; clicking one proxies the action to Seerr and refreshes the row so its
status chip updates immediately.

- **Who sees the buttons** — only callers Seerr would let approve: **Jellyfin
  admins**, and Seerr users who hold the **Manage Requests** (or **Admin**)
  permission. Everyone else sees the request list without approval controls. The
  server enforces this on every action, so the buttons are a convenience, not the
  security boundary.
- **How it works** — the action is proxied server-side to Seerr's
  `POST /api/v1/request/{id}/approve` (or `/decline`) using the plugin's
  configured Seerr API key; the acting user is passed through so Seerr records the
  correct approver and applies that user's permissions. The Seerr API key is
  never exposed to the browser.
- **Feedback** — a toast confirms the approval or decline, and the card's status
  chip moves from *Pending Approval* to *Requested* (or *Declined*).
- **Enable / disable** — the **Enable In-App Request Approvals** toggle (plugin
  settings → **Pages** tab) turns the whole affordance on or off. It is on by
  default. When off, the buttons never render and the approve/decline endpoint
  refuses the action.

!!! note "Pending detection"
    The buttons appear whenever the **request** itself is pending, even when the
    media is already partially available — for example a pending request for a new
    season of a show you already have. This is why the control keys off the
    request status, not the media's availability.

### Issues on the Requests Page

View and manage Seerr issues directly from the Requests page.

#### Features

- View all reported issues
- Filter issues by status
- Pagination support
- TMDB detail lookup with caching
- Issue card rendering with styling
- Open issue reporter modal from issues list

#### Configuration

1. Go to plugin settings → **Pages** tab
2. Check **"Enable Requests Page"**
3. Check **"Show Seerr Issues Section"**
4. Click **Save**

#### How to use

- Navigate to Requests page
- Issues appear in dedicated section
- Click issue to view details
- Use Seerr reporter modal for management

### Watchlist Sync

Automatically sync watchlist items between Seerr and Jellyfin in both directions.

#### Seerr → Jellyfin

!!! note

    [Requires the KefinTweaks plugin](https://github.com/ranaldsgift/KefinTweaks) to provide watchlist functionality

- Add requested items to Jellyfin watchlist when they become available in the library
- Sync Seerr watchlist items to Jellyfin
- Prevent re-addition of previously removed items
- Runs via the **Sync Watchlist from Seerr to Jellyfin** scheduled task

#### Jellyfin → Seerr

- Sync each user's Jellyfin watchlist to their linked Seerr watchlist
- Only syncs items that have a TMDB ID and a linked Seerr account
- Skips items already present in the Seerr watchlist
- Runs via the **Sync Watchlist from Jellyfin to Seerr** scheduled task (default: daily at 03:30)

#### Configuration:

- **Add requested media to Watchlist** - Auto-add when available
- **Sync Seerr Watchlist → Jellyfin** - Sync Seerr watchlist to Jellyfin
- **Sync Jellyfin Watchlist → Seerr** - Sync Jellyfin watchlist to Seerr
- **Prevent re-adding removed items** - Remember removed items
- **Memory retention (days)** - How long to remember (default: 365)


### Icon States

When on the search page, a Seerr icon indicates connection status.

| **Icon** | **State** | **Description** |
| :---: | :--- | :--- |
|<img alt="active" src="https://cdn.jsdelivr.net/gh/selfhst/icons/svg/seerr.svg" style="width:30px;height:50px;filter:drop-shadow(2px 2px 6px #000);" /> | **Active** | Seerr is successfully connected, and the current Jellyfin user is correctly linked to a Seerr user. <br> Results from Seerr will load along with Jellyfin and requests can be made. |
| <img alt="noaccess" src="https://cdn.jsdelivr.net/gh/selfhst/icons/svg/seerr.svg" style="width:30px;height:50px;filter:hue-rotate(125deg) brightness(100%);" /> | **User Not Found** | Seerr is successfully connected, but the current Jellyfin user is not linked to a Seerr account. <br>If plugin auto import is enabled, linking will be attempted automatically. If disabled, import users manually in Seerr. Results will not load until linked. |
| <img alt="offline" src="https://cdn.jsdelivr.net/gh/selfhst/icons/svg/seerr.svg" style="width:30px;height:50px;filter:grayscale(1);opacity:.8;" /> | **Offline** | The plugin could not connect to any of the configured Seerr URLs. <br> Check your plugin settings and ensure Seerr is running and accessible. Results will not load. |


## Troubleshooting

### Connection Issues

**Icon Shows Offline:**

1. Verify Seerr URL is correct and accessible
2. Check Seerr is running
3. Test connection in plugin settings
4. Check server logs for errors

**Icon Shows User Not Found:**

1. Verify "Enable Jellyfin Sign-In" is enabled in Seerr
2. If plugin auto import is enabled, run **Import Users Now** from Jellyfin plugin settings
3. If plugin auto import is disabled, import Jellyfin user manually in Seerr
4. Ensure the user is not selected in the **Blocked users** list
5. Ensure same username in both systems

### Search Not Working

**No Results Appearing:**

1. Check icon status (must be green/active)
2. Verify API key is correct
3. Check browser console for errors
4. Test API endpoints manually

**Results Slow to Load:**

1. Use internal Seerr URL
2. Check network latency
3. Verify Seerr performance
4. Check server resources

### Request Issues

**Cannot Make Requests:**

1. Verify user has request permissions in Seerr
2. Check request limits not exceeded
3. Ensure item not already requested
4. Check Seerr logs

**Requests Not Appearing:**

1. Refresh Seerr page
2. Check request was successful (no errors)
3. Verify user permissions
4. Check Seerr request queue

### TMDB API Issues

If reviews, elsewhere, or Seerr icons not working:

- TMDB API may be blocked in your region
- Check [Seerr troubleshooting](https://docs.seerr.dev/troubleshooting#tmdb-failed-to-retrievefetch-xxx)
- Use VPN or proxy if needed
- Contact ISP about API access

## Advanced Configuration

### URL Mappings

Jellyfin and Seerr URLs can be mapped. This changes the Seerr URLs displayed to users, depending on which URL is used to access Jellyfin.

Useful for mapping Seerr URLs to Jellyfin URLs, for **local access** (LAN) and **remote access**

```text title="Formatting"
jellyfin_url|seerr_url
```

!!! example "Examples"

    === "Remote access"

        ```text
        https://jellyfin.mydomain.com|https://seerr.mydomain.com
        ```

    === "Local access"

        ```text
        http://192.168.1.10:8096|http://192.168.1.10:5055
        ```

    === "Remote access + Local access"

        ```text
        https://jellyfin.mydomain.com|https://seerr.mydomain.com
        http://192.168.1.10:8096|http://192.168.1.10:5055
        ```

    === "Using base URLs + paths"

        ```text
        https://example.com/jellyfin|https://example.com/seerr
        ```

### Auto-Request Settings

Automatically request media based on viewing behavior. These settings are
configured on the **Seerr** config tab and require the **Enable Seerr
integration** master toggle.

#### Auto Season Request:

- Trigger when X episodes remaining in season
- Require all episodes watched (optional)
- Configurable threshold (default: **2** episodes remaining)

- **Next in collection** — when a movie belongs to a TMDB collection, the next
  title is chosen by **release order**, not by the collection's raw list order,
  so a prequel or spin-off is never requested ahead of the actual next film
  (titles with no release date sort last).

#### Auto Movie Request:

- Trigger on playback start
- Trigger after X minutes watched (default: **20** minutes)
- Check release date (only request if released)
- **Quality Profile Mode** — how the auto request picks its Radarr target:
  *Default* (Seerr uses its default Radarr server and quality profile),
  *Original* (uses the same quality profile as the movie being watched, falling
  back to default if not found), or *Custom* (always uses the specific Radarr
  server, quality profile, and root folder selected below).
- **Use default instead of 4K fallback** (default on) — only applies when
  Quality Profile Mode is set to *Original*. If the watched movie was requested
  with a 4K profile, the auto-request uses Seerr's default profile instead,
  preventing requests from failing or requiring manual approval for users who
  lack 4K request permission in Seerr. Disable it to preserve the original 4K
  profile when all your users have 4K request access.

!!! note "One request per title across multiple Seerr backends"

    When more than one Seerr instance is configured, an automatic request only
    fans out to the next backend on a **pure transport failure** (a backend that
    could not be reached at all). A backend that answered — even with an error —
    may already have committed the request, so it is not re-sent elsewhere, and
    an "already requested" response is treated as success. This prevents the same
    title being duplicated across two Seerr instances.

### Caching

- **Response Cache TTL** — how long Seerr search/discovery responses are cached
  (default 10 minutes).
- **Parental Rating Cache TTL** — how long a title's resolved content rating is
  cached for the [parental-rating filter](#parental-rating-filtering). Ratings
  rarely change, so this is long by default (1440 minutes = 24 hours) and shared
  across all users, keeping the filter cheap after the first lookup of a title.
- **User ID Cache TTL** — how long the resolved Jellyfin-user → Seerr-user id
  mapping is cached before it is looked up again (default 30 minutes).
- **Disable server-side response cache** (Debug section, default off) — when on,
  every Seerr proxy request bypasses the response cache and is fetched fresh from
  Seerr. Useful for testing; increases load on Seerr and is not recommended for
  normal use.
- All Seerr caches are flushed automatically whenever plugin settings are saved.
