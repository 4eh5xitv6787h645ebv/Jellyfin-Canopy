# Features Guide

Jellyfin Elevate bundles dozens of features into one convenient plugin. This guide covers all available features and how to use them.

---

## Content Management

### Hidden Content System

![Hidden content management panel](../images/hidden-content-panel.png)

Per-user content hiding with server-side storage and granular filtering controls.

**Features:**

- Hide specific movies/series from all browsing surfaces
- Hidden state stored server-side per-user
- Survives browser/device changes
- Management panel with search and bulk operations
- Granular filter toggles for different surfaces
- Undo functionality with toast notifications

**Surfaces with Filtering:**

- Library views
- Discovery pages
- Search results
- Calendar view
- Next Up section
- Continue Watching section
- Recommendations
- Requests page

**How to Hide Content:**

1. Navigate to any item detail page
2. Click the hide button (visibility_off icon)
3. Choose what to hide from the **"What would you like to hide?"** dialog:
   - **Hide this episode everywhere**
   - **Hide entire show everywhere**
   - **Hide from Next Up & Continue Watching only**
   - **Remove from Continue Watching**
   - **Hide from Next Up only**
4. Confirm the action

**Management Panel:**

Access via:
- Enhanced panel → Settings → Hidden Content
- Sidebar navigation (if enabled)
- Custom tab (if configured)

**Management Features:**

- View all hidden items
- Search hidden content
- Unhide individual items
- Unhide all items at once
- Group by series/movies
- Filter by scope

**Configuration:**

1. Open Enhanced panel (press `?`)
2. Go to Settings tab
3. Find Hidden Content section
4. Enable/disable the feature
5. Configure filter toggles:
   - Show hide buttons on Seerr items
   - Show hide buttons in library views
   - Show hide buttons on detail pages
   - Filter library views
   - Filter discovery pages
   - Filter search results
   - Filter calendar
   - Filter Next Up
   - Filter Continue Watching
   - Filter recommendations
   - Filter requests page
   - Hide Collections & Libraries (experimental) — extends hiding beyond individual movies/series to whole My Media libraries, collections, and playlists. Off by default and strongly discouraged for typical users (can break browsing); exposed as a per-user toggle with a matching admin default ('Allow hiding collections, libraries, and playlists (experimental)') on the config page.
6. Choose integration method:
   - Plugin Pages (requires Plugin Pages plugin)
   - Custom Tabs (requires Custom Tabs plugin)

!!! note "Home rows filter independently of Filter Library"

    **Filter Next Up** and **Filter Continue Watching** apply on the Home screen
    on their own — you do **not** need **Filter library views** enabled for them
    to work. With Filter Library off but Filter Continue Watching on, a card you
    hid from Continue Watching stays hidden on Home, while ordinary library
    browsing is left unfiltered.

### Remove from Continue Watching / Next Up

A lightweight, **non-destructive** way to tidy the home screen. It adds a **Remove** option to an item's "⋯" action-sheet menu for items in the **Continue Watching** and **Next Up** rows, hiding the item from that row without touching your playback position or watched state.

![The Remove option in an item's menu](../images/remove-from-row.png)

**How It Works:**

1. Open an item's "⋯" menu in the Continue Watching or Next Up row
2. Click **Remove from Continue Watching** / **Remove from Next Up**
3. The item disappears from that row — your progress is left untouched

**Highlights:**

- Works on both **Continue Watching** and **Next Up** items, each removed from its own row
- Also appears in Jellyfin's **long-press / multi-select menu**, so touch devices with no "⋯" button can remove items. Selecting a mix of rows (and other items) only ever removes the Continue Watching / Next Up ones
- Removing several at once shows a confirmation listing each item and the row it will be removed from
- Hidden state is stored **server-side, per-user**, so it applies across all your devices and survives reloads
- **Undoable:** removed items appear in the **Hidden Content** management page with an "Add back" button, and simply resuming a hidden item unhides it automatically
- Works on its own — it does not require the full Hidden Content feature to be enabled

![Bulk removal confirmation listing each item and its row](../images/remove-confirm.png)

**Enable it:**

- Open the Enhanced panel (press `?`) → **Settings** → **Add Remove from Continue Watching & Next Up Buttons**

---

### Admin: Other Users' Hidden Content

![Admin viewing another user's hidden content](../images/hidden-content-admin.png)

Administrators can review (and optionally manage) what other users have hidden, from the same Hidden Content page. Admin-only and enforced server-side; regular users never see it.

**Features:**

- User-filter dropdown to switch between *My hidden content* and any user who has hidden something
- Another user's list is read-only by default, with a "Viewing: OtherUser" badge
- An **Edit** toggle (when enabled) to unhide items for that user, or add new ones
- Add items by searching the library *and* Seerr, so you can hide titles that aren't in the library yet
- An admin never overwrites an item the user hid themselves

**Configuration:**

In **Dashboard** → **Plugins** → **Jellyfin Elevate** → **Pages** → **Hidden Content** → **Admin Controls**, the **Let admins view and manage other users' hidden content** toggle enables the whole feature (the user-filter dropdown and the Edit toggle). On by default; turn it off to keep hidden lists private.

---

## Playback & Controls

### Advanced Keyboard Shortcuts

Comprehensive hotkeys for navigation, playback control, and more.

![Shortcuts](../images/enhanced-panel-shortcuts.png)

**Default Shortcuts:**

**Global:**

 - `/` - Open Search
 - `Shift+H` - Go to Home
 - `D` - Go to Dashboard
 - `Q` - Quick Connect
 - `R` - Play Random Item

**Player:**

 - `A` - Cycle Aspect Ratio
 - `I` - Show Playback Info
 - `S` - Subtitle Menu
 - `C` - Cycle Subtitle Tracks
 - `V` - Cycle Audio Tracks
 - `+` - Increase Playback Speed
 - `-` - Decrease Playback Speed
 - `R` - Reset Playback Speed
 - `B` - Bookmark Current Time
 - `P` - Open Episode Preview
 - `O` - Skip Intro/Outro
 - `,` - Step Back One Frame
 - `.` - Step Forward One Frame
 - `Z` - Jump to Last Position


**Customization:**

1. Press `?` to open the Enhanced panel
2. Go to **Shortcuts** tab
3. Click on any key to set a custom shortcut
4. Changes save automatically per user

### Random Button

A **Play Random** button in the Jellyfin header that opens a random item from your accessible libraries in a single click. It complements the `R` [Play Random Item](#advanced-keyboard-shortcuts) keyboard shortcut with an always-visible header control.

**Features:**

- Always-visible **Play Random** button in the header
- Opens a random item drawn from the libraries you have access to
- Optionally limits the pool to items you have not watched yet
- Independent toggles to include movies and/or TV shows in the pool

**Configuration:**

1. Go to **Dashboard** → **Plugins** → **Jellyfin Elevate**
2. Navigate to the **Display** tab
3. Find the **Random Button** section
4. Enable **"Enable Random Button"**
5. Optionally adjust the pool:
   - **Show unwatched only** - only choose items you have not watched yet
   - **Include movies** - include movies in the random pool
   - **Include shows** - include TV shows in the random pool
6. Click **Save**

### Smart Bookmarks

![Bookmark markers on the video timeline](../images/bookmarks-timeline.png)

Save timestamps and jump to specific moments with visual timeline markers.

**Features:**

- Create bookmarks during playback with `B` key
- Visual markers on video timeline
- Add custom labels to bookmarks
- Sync bookmarks across duplicate items (same TMDB/TVDB ID)
- Manage all bookmarks from the Bookmarks page (native tab, Plugin Pages, or Custom Tabs)
- Export/import bookmark data

**Usage:**

1. While watching, press `B` at any moment
2. Add an optional label (e.g., "Epic scene")
3. Bookmark appears as marker on timeline
4. Click marker to jump to that timestamp

**Bookmark Management:**

- Access via a native Home tab, the Plugin Pages sidebar link, or the Custom Tabs plugin (configured under the Bookmarks section of the plugin config; the native tab is recommended on Jellyfin 12's experimental layout)
- View all bookmarks across library
- Clean up orphaned bookmarks
- Detect and merge duplicates
- Adjust time offsets for synced bookmarks

### Custom Pause Screen

Beautiful overlay with media info when you pause a video.

![Pause Screen](../images/pausescreen.png)

**Displays:**

- Media title and logo
- Year, rating, runtime
- Plot/description
- Current progress with time remaining
- Spinning disc animation
- Blurred backdrop

**Delay before it appears:**

You can set how many seconds of pause pass before the overlay fades in. Each user
can set their own delay in the Enhanced panel (and it now persists across reloads),
while an administrator sets the **default** for everyone in the plugin config page
(**Playback → Pause Screen Delay**). The default is 5 seconds (range
1–60); a user's own value overrides the admin default.

!!! tip

    [Custom CSS available](../advanced/css-customization.md)

### Smart Playback

Intelligent playback features for better viewing experience.

**Features:**

- **Auto-pause** - Pause when switching browser tabs
- **Auto-resume** - Resume when returning to tab
- **Auto-skip intros/outros** - Seamless binge-watching. Reads Jellyfin 12's native Media Segments and skips to the segment's exact end boundary. Requires media segments for the item (from the [Intro Skipper plugin](https://github.com/intro-skipper/intro-skipper) or any other segment provider). Seeking back into a segment after an auto-skip will not re-skip it, and the plugin defers to the native per-type segment actions where they apply.
- **Playback speed control** - Adjust speed with keyboard shortcuts
- **Auto Picture-in-Picture** - Enter PiP mode when switching tabs
- **Long press/hold for 2x speed** (beta, touch devices only) - long-press anywhere on the player to temporarily play at 2x speed; release to return to normal speed. Per-user toggle in the Enhanced panel with a matching admin default on the config page.

**Configuration:**
Enable/disable in Enhanced panel → Settings tab

### Customizable Subtitles

Fine-tune subtitle appearance with presets and custom colors.

**Presets:**

- Multiple font families
- Size options (small, medium, large, extra large)
- Background opacity
- Text shadow options
- Position adjustments

**Custom Colors:**

- User-configurable text color with alpha support
- User-configurable background color with alpha support
- Live preview in settings
- Computed text shadow for transparent/black backgrounds
- Per-user customization

**Usage:**

1. Open Enhanced panel → Settings
2. Find Subtitle Presets section
3. Select your preferred preset options
4. Or use Custom Colors section:
   - Choose text color
   - Adjust text alpha
   - Choose background color
   - Adjust background alpha
   - Preview changes live
5. Changes apply immediately

---

## Discovery & Integration

### Seerr Search Integration

Search, request, and discover media directly from Jellyfin's search interface.

![Seerr search results](../images/jellyseerr.png)

**Features:**

- Search Seerr from Jellyfin search bar
- Request movies and TV shows
- View request status (pending, approved, available)
- Auto-add requested media to watchlist
- Sync Seerr watchlist to Jellyfin

**Setup:**

1. Open plugin settings → **Seerr** tab
2. Check "Show Seerr Results in Search"
3. Enter Seerr URL(s) (one per line)
4. Enter Seerr API Key (from Seerr Settings → General)
5. Click "Test"
6. Enable optional features:
   - Add Requested Media to Watchlist
   - Sync Seerr Watchlist to Jellyfin
7. Click **Save**

**Requirements:**

- Seerr instance with API access
- "Enable Jellyfin Sign-In" enabled in Seerr
- Jellyfin users imported into Seerr

![Jellyfin Sign-In](../images/jellyfin-signin.png)

**Icon States:**

| **Icon** | **State** | **Description** |
| :---: | :--- | :--- |
|<img alt="active" src="https://cdn.jsdelivr.net/gh/selfhst/icons/svg/seerr.svg" style="width:30px;height:50px;filter:drop-shadow(2px 2px 6px #000);" /> | **Active** | Seerr is successfully connected, and the current Jellyfin user is correctly linked to a Seerr user. <br> Results from Seerr will load along with Jellyfin and requests can be made. |
| <img alt="noaccess" src="https://cdn.jsdelivr.net/gh/selfhst/icons/svg/seerr.svg" style="width:30px;height:50px;filter:hue-rotate(125deg) brightness(100%);" /> | **User Not Found** | Seerr is successfully connected, but the current Jellyfin user is not linked to a Seerr account. <br>Ensure the user has been imported into Seerr from Jellyfin. Results will not load. |
| <img alt="offline" src="https://cdn.jsdelivr.net/gh/selfhst/icons/svg/seerr.svg" style="width:30px;height:50px;filter:grayscale(1);opacity:.8;" /> | **Offline** | The plugin could not connect to any of the configured Seerr URLs. <br> Check your plugin settings and ensure Seerr is running and accessible. Results will not load. |

### Seerr Item Details

![Seerr recommendations and similar items on a detail page](../images/seerr-recommendations.png)

View recommendations and similar items on detail pages.

**Features:**

- Recommended items section
- Similar items section
- Request directly from recommendations
- Exclude items already in library
- Real-time request status indicators
- Support for 4K requests
- TV season selection

**Setup:**

1. Configure Seerr integration (see above)
2. Check **"Show similar items"** and/or **"Show recommended items"**
3. Optional: Enable "Exclude items already in library"
4. Click **Save**

**Discovery Pages:**

- Genre-based discovery
- Network-based discovery
- Person-based discovery (actors, directors)
- Tag-based discovery
- All with TV/Movies/All filtering

### .arr Links Integration

![ARR links on an item detail page](../images/arr-links-item.png)

Quick access to Sonarr, Radarr, and Bazarr (admin only).

**Features:**

- Direct links to item pages in Sonarr/Radarr
- Bazarr subtitle management links
- Display *arr tags as clickable links
- Filter and customize tag display

### Streaming Provider Lookup

See where else your media is available to stream.

![Elsewhere](../images/elsewhere.png)

**Features:**

- Multi-region support
- Buy, rent, and stream options
- Provider logos and links
- Powered by TMDB data

**Usage:**

1. Enable in Enhanced panel → Settings
2. Select your region
3. View providers on item detail pages

### User Reviews

![User reviews section on an item detail page](../images/user-reviews.png)

Jellyfin users can write their own reviews for movies, series, seasons, and episodes. Reviews are stored server-side and visible to all users.

**Features:**

- Write a review with a star rating (1-5) and optional text, or just a rating with no text
- Reviews appear in a dedicated "Reviews" section on item detail pages, listed before TMDB reviews
- Edit or delete your own review at any time
- Average user rating chip displayed next to TMDB/RT ratings in the item media info bar
- Average user rating also shown as a poster tag (`person_heart` icon) on library cards when rating tags are enabled
- Admin moderation — admins can delete any user's review

**How to write a review:**

1. Open any movie, series, season, or episode detail page
2. Scroll to the **Reviews** section
3. Click **Add Review**
4. Select a star rating (optional) and write your review text (optional — a rating alone is valid)
5. Click the save icon

**Setup (admin):**

1. Go to **Dashboard** → **Plugins** → **Jellyfin Elevate**
2. Navigate to the **Elsewhere** tab
3. Enable **"Enable User Written Reviews"**
4. Optionally enable **"Show average user rating on poster cards"** to display the average rating as a poster tag
5. Optionally disable **"Show "—" on posters for unrated items"** to hide the `—` placeholder on posters when no ratings exist yet
6. Click **Save**

!!! note
    The poster tag requires the user to also have **Rating Tags** enabled in the Enhanced panel (Settings tab).

**Admin moderation:**

Admins see a delete button on all reviews, not just their own. A confirmation dialog is shown before deletion. The action is logged and the section refreshes automatically.

---

### TMDB Reviews

Display user reviews from TMDB on item pages.

**Features:**

- Full review text
- Author information
- Rating scores
- Review dates
- Expandable/collapsible reviews

**Setup:**
Enable **"Show TMDB Reviews"** in **Dashboard** → **Plugins** → **Jellyfin Elevate** → **Elsewhere** tab.

See [Elsewhere Features](../elsewhere/elsewhere-features.md#tmdb-reviews) for full details.

---

## Visual Enhancements

### Quality Tags

Display quality information (4K, HDR, Atmos) directly on posters.

**Supported Tags:**

- **Resolution:** 8K, 4K, 1440p, 1080p, 720p, 480p, LOW-RES
- **Video Format:** AV1, HEVC, H265, VP9, H264
- **Video Features:** HDR, Dolby Vision, HDR10+, HDR10, IMAX, 3D
- **Audio:** ATMOS, DTS-X, TRUEHD, DTS, Dolby Digital+, 7.1, 5.1
- **Media Stubs:** BluRay, HD DVD, DVD, VHS, HDTV, Physical (for physical media files)

### Genre Tags

![Genre tags on posters](../images/genre-tags.png)

Identify genres with themed icons on posters.

**Features:**

- Material Design icons for each genre
- Circular badges that expand on hover
- Show up to 3 genres per item
- Customizable position

### Language Tags

![Language tags (country flags) on posters](../images/language-tags.png)

Display available audio languages as country flags on posters.

**Features:**

- Country flag icons served from the plugin's local asset cache (mirrored from the flag-icons / flagcdn sets), so no third-party request is made
- Show up to 3 unique languages
- Positioned bottom-left by default
- Also displays on item detail pages

### Rating Tags

Show TMDB and Rotten Tomatoes ratings on posters and in player.

![Ratings](../images/ratings.png)

**Features:**

- TMDB star ratings
- Rotten Tomatoes critic scores (fresh/rotten icons)
- Stacked vertically on posters
- Optional OSD display during playback
- Color-coded by rating value


### People Tags

![People tags on cast cards](../images/people-tags.png)

Display age and birthplace information for cast members.

**Features:**

- Current age or age at death
- Age at item release
- Birthplace with country flag
- Deceased indicator (grayscale + cross)
- Caching for performance

**Displays:**

- Age chips (top-left of cast cards)
- Birthplace banner (bottom of cast cards)
- Deceased styling (grayscale filter)

!!! note "Caching"

    People-tag data is cached client-side using the same **Tags Cache Duration**
    (`TagsCacheTtlDays`, default 30 days) that every other tag family uses — so
    changing that admin setting now also controls how long people-tag data is
    kept. It previously ignored the setting and was pinned at 30 days.

---

## Personal Scripts

These are optional scripts from the developer's personal collection.

### 📡 Active Streams Widget

A live stream counter in the Jellyfin header that shows who is currently playing and what they're watching.

**Features:**

- Stream counter icon in the header, colour-coded by state
- Click to open a panel listing every active session
- Poster thumbnails and user avatars per session
- Direct Play vs Transcoding badges with codec and bitrate details
- Playback progress bar with current position and total duration
- Playing / Paused state badge per session
- Clickable title links to the item detail page
- Admin session control per card: **Stop** a stream and send a **targeted message** (with quick presets)
- Admin-only broadcast button to message all active sessions
- Live updates while the panel is open (server `Sessions` websocket push, with a page-scoped, visibility-gated fallback refresh); progress/state update in place. The manual refresh button remains for an on-demand poll.

**Header icon states:**

| Icon | State |
|---|---|
| `play_circle` (no badge) | No active streams |
| `person` + badge `1` | One stream playing |
| `group` + badge count | Multiple streams |
| `pause_circle` + badge count | All streams paused |
| Red icon | Failed to fetch sessions |

**Session card details:**

Each card in the panel shows:

- Poster thumbnail (series poster for episodes, movie poster for films)
- Title and episode info (S01E01 · Episode Name)
- Playing / Paused badge
- Progress bar with elapsed / total time
- Playback badges: `Direct Play` or `Transcoding`, video codec, bitrate, resolution, framerate
- Transcode reason (e.g., "Video Codec Not Supported") when applicable
- User avatar, username, client name, and device name
- IP address (admins only)
- **Stop** and **Message** actions (admins only, on clients that support remote control)

**Session control (admin only):**

Each session card offers per-stream actions for clients that support remote control:

- **Stop** — ends playback on that session (two-click confirm; no blocking dialog)
- **Message** — sends a message to that one session, with quick-preset buttons plus free text

**Broadcast (admin only):**

Admins see a megaphone icon (📣) in the panel header. Click it to open the broadcast form:

| Field | Required | Notes |
|---|---|---|
| **Title** | No | May not display on all clients (web UI typically ignores it) |
| **Message** | Yes | Always visible; sent to every active session |
| **Timeout** | Yes | Seconds before the notification auto-dismisses (default: 10) |

**Setup:**

1. Go to **Dashboard** → **Plugins** → **Jellyfin Elevate**
2. Navigate to the **Extras** tab
3. Enable **"Active Streams Header Widget"**
4. Optional: Enable **"Show widget to non-admins"** to make the widget visible to non-admin users

!!! note
    By default the widget is admin-only. Non-admin users see a read-only view (no session controls, no broadcast button, no IP addresses) when "Show widget to non-admins" is enabled.

### 🎨 Colored Activity Icons

Replace default activity icons with Material Design icons.

![Colored Activity Icons](../images/colored-activity-icons.png)

**Features:**

- Custom colors for each activity type
- Material Design icon set
- Better visual distinction

**Configuration:**

Enable in Enhanced panel → Settings → Extras

### 🎪 Colored Ratings

Color-coded backgrounds for ratings on detail pages.

![Colored Ratings](../images/ratings.png)

**Features:**

- Different colors per rating type
- Value-based color gradients
- Supports TMDB, IMDb, Rotten Tomatoes

**Configuration:**
Enable in Enhanced panel → Settings → Extras

### 🖼️ Login Image Display

Show user profile images on manual login page.

![Login Image](../images/login-image.png)

**Features:**

- Display user avatars
- Cleaner login interface
- Automatic fallback to text

**Configuration:**

Enable in Enhanced panel → Settings → Extras

### 🧩 Plugin Icons

Replace default plugin icons with Material Design icons.

![Plugin Icons](../images/plugin-icons.png)

**Features:**

- Custom icons for popular plugins
- Add custom config page links
- Improved dashboard aesthetics

**Configuration:**
Enable in Enhanced panel → Settings → Extras

### 🎭 Theme Selector

Choose from multiple Jellyfin theme color variants.

![Theme Selector](../images/theme-selector.png)

**Features:**

- Multiple color palettes (Aurora, Jellyblue, Ocean, etc.)
- Randomize theme daily option
- Quick theme switching

**Configuration:**

1. Enable in Enhanced panel → Settings → Extras
2. Select theme from dropdown
3. Optional: click the shuffle button ("Random daily theme") to rotate themes daily

---

## Customization

### 🎨 Custom Styling with CSS

Extensive CSS customization options. See [CSS Customization Guide](../advanced/css-customization.md) for more details.

**Available Customizations:**

- Pause Screen CSS
- Quality Tags CSS
- Genre Tags CSS
- Language Tags CSS
- Rating Tags CSS
- Rating Tag OSD CSS
- People Tags CSS
- ARR Tag Links CSS
- Enhanced Panel CSS


### 🖼️ Custom Branding

Upload your own logos, banners, and favicon.

**Features:**

- Custom Jellyfin logo (header)
- Custom splash banners (light/dark themes)
- Custom favicon (browser tab icon)
- Files stored in plugin config folder
- Survives Jellyfin updates

**Setup:**

1. Go to **Dashboard** → **Plugins** → **Jellyfin Elevate**
2. Navigate to the **Extras** tab
3. Find **Custom Image Assets** section
4. Upload your custom images:
   - Icon Transparent (header logo)
   - Banner Light (dark theme splash)
   - Banner Dark (light theme splash)
   - Favicon (browser icon)
5. Click **Save**
6. Force refresh browser ++ctrl+f5++

**Requirements:**

- Requires [file-transformation plugin](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation)
- Recommended image formats: PNG, SVG
- Files stored in: `/plugins/configurations/Jellyfin.Plugin.JellyfinElevate/custom_branding/`

### 🌍 Internationalization

Multi-language support with community translations and automatic caching.

**Supported Languages:**

<p align="left">
  <a href="https://hosted.weblate.org/engage/jellyfinelevate/">
    <img src="https://hosted.weblate.org/widget/jellyfinelevate/multi-auto.svg" alt="Translation status" />
  </a>
</p>

**How It Works:**

- Automatically detects Jellyfin user profile language
- Fetches latest translations from GitHub on first load
- Caches translations for 24 hours in localStorage
- Per-version caching with automatic cleanup
- Falls back to bundled translations if offline
- Language code normalization (including region variants)

**Translation Cache Refresh:**

- Server-side scheduled task runs on plugin startup
- Automatically signals all clients to clear cached translations
- Ensures fresh translations after plugin updates
- No manual intervention required

**Manual Cache Refresh:**

1. Open Enhanced panel (press `?`)
2. Go to Settings tab
3. Find translation settings
4. Click "Refresh Translation Cache" button

**Contributing Translations:**

See the [Contributing Translations](../faq-support/contributing-translations.md) section for details.
