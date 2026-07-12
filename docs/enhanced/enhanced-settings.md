# Enhanced Settings — User configuration

## Enhanced Panel

![Enhanced panel — Settings tab overview](../images/enhanced-panel-settings.png)

Access user-configured settings via the Enhanced panel:

| Shortcuts | Settings |
|-----------|----------|
| ![Shortcuts](../images/enhanced-panel-shortcuts.png) | ![Settings](../images/enhanced-panel-settings.png) |

**Open Panel:**

- Click **Jellyfin Elevate** in sidebar
- Press `?` keyboard shortcut


**Toggleable User Features:**

- Quality Tags
- Genre Tags
- Language Tags
- Rating Tags
- People Tags
- Pause Screen
- Auto-skip Intros
- Auto-skip Outros
- Auto Picture-in-Picture
- Show Watch Progress
- Show File Sizes
- Show Audio Languages
- And more...


**Tabs:**

- **Shortcuts** - Customize keyboard shortcuts
- **Settings** - Enable/disable features, adjust positions

**Settings Persistence:**

- Settings saved server-side, per Jellyfin user (stored in the plugin's per-user settings.json via the `/JellyfinElevate/user-settings/{userId}/settings.json` endpoint)
- Per-user configuration
- Syncs across every device and browser where the same Jellyfin user logs in (settings live on the server, keyed to the user account)


# Enhanced Settings — Admin configuration

## Feature Toggles

Most features can be enabled/disabled individually:

1. Open Enhanced panel
2. Go to the **Settings** tab
3. Toggle features on/off
4. Changes apply immediately *(no restart needed)*


## Tags: Quality, Genre, Language, Rating, People

### Configuration
1. Open Enhanced panel → `Enhanced Settings`
2. Enable and configure tags you want *(Eg: `Quality Tags`)*
3. Adjust position (top-left, top-right, etc.)

### Quality Tag categories

Quality Tags break down into six independently toggleable categories —
**Resolution** (4K/1080p…), **Source** (BluRay/DVD/HDTV…), **HDR**
(HDR10+/Dolby Vision), **Special format** (IMAX/3D), **Video format**
(HEVC/H264/AV1…), and **Sound** (Atmos/DTS/5.1/7.1…). Each category can be
enabled/disabled and reordered independently. The config-page values are admin
defaults; each user can override which categories show and their order in the
Enhanced panel.

### Hide Tags on Hover
Enable **Hide Tags on Hover** to fade the poster tag overlays (Quality, Genre,
Language, Rating) out while you hover a card, so the artwork and Jellyfin's own
hover buttons stay unobstructed. This applies everywhere those overlays are
drawn — library grids, home rows, similar-items and season rows, the **primary
poster on a detail page**, and **episodes in list view**.

!!! tip

    [Custom CSS available](../advanced/css-customization.md#tags)

### Disable Tags on Search Page

Enable **Disable Tags on Search Page** to stop poster tag overlays rendering on
the search results page. This hides **all** four families — Quality, Genre,
Language and Rating — not only Genre tags.

### Tags Cache Duration (days)

**Tags Cache Duration (days)** (`TagsCacheTtlDays`, default 30 days) controls how long
the client keeps cached tag data before re-fetching. It applies to every tag
family, **including People tags** — changing it now adjusts the people-tag cache
lifetime too (previously that was fixed at 30 days regardless of this setting).

### Show Rating in Video Player

**Show Rating in Video Player** (`ShowRatingInPlayer`, admin default **on**)
displays the item's TMDB and Rotten Tomatoes ratings in the video player OSD,
shown before the "Ends at" time. It is an admin-only toggle in the **Media
Tags** section of the plugin config page (**Display** tab).

### Server-Side Tag Cache

**Server-Side Tag Cache** (`TagCacheServerMode`, admin default **on**)
pre-computes tag data on the server and serves it in a single request, so poster
tags load instantly without per-page API calls. Disable it to fall back to the
legacy per-page batch mode, where tags are computed client-side (not
recommended). Set it in the **Media Tags** section of the plugin config page.

### Persist Tag Fallback Cache in Browser Storage

**Persist Tag Fallback Cache in Browser Storage**
(`EnableTagsLocalStorageFallback`, admin default **off**) is available only when
**Server-Side Tag Cache** is disabled. When on, it stores fallback tag-cache
entries in the browser's `localStorage` for faster repeat loads.

## Pause Screen Delay

Sets how many seconds a video is paused before the [Custom Pause
Screen](enhanced-features.md#custom-pause-screen) overlay appears.

- **Admin default** — set **Pause Screen Delay (seconds)** on the plugin config
  page (Enhanced Settings). Default 5, range 1–60. This is the value users start
  with.
- **Per-user override** — each user can set their own delay in the Enhanced
  panel; their choice persists across reloads and overrides the admin default.

## Watch Progress

**Show Watch Progress** displays how far you are through each title on its item
detail page.

- **Per-user toggle** — turn **Show Watch Progress** on or off in the Enhanced
  panel's **Settings** tab.
- **Display mode** — choose how progress is shown: **Percentage**, **Time
  Watched**, or **Time Remaining**. The admin default is set with **Watch
  Progress Default** on the plugin config page (`WatchProgressDefaultMode`,
  default *Percentage*).
- **Time format** — when a time-based mode is used, choose **h:m** or
  **y:mo:d:h:m**. The admin default is set with **Watch Progress Time Format**
  (`WatchProgressTimeFormat`, default *h:m*).

## Subtitle Defaults

The admin sets the default subtitle **Style** (e.g. Clean White, Classic Black
Box, Netflix Style), **Size**, and **Font** on the plugin config page (Playback
→ Subtitles).

- **Per-user override** — each user can override all three in the Enhanced
  panel's **Settings** tab; their choice persists per user and wins over the
  admin default.
- **Disable Custom Subtitle Styles by default** — globally disables Jellyfin's
  custom subtitle style overrides so the source subtitle styling is shown
  unmodified. It is an admin default (config page) that each user can override
  in the Enhanced panel.

## Auto-skip Intros & Outros

Intro and outro skipping are **two independent toggles**, each a per-user setting
in the Enhanced panel's **Settings** tab with a matching admin default on the
plugin config page (**Playback**).

- **Auto-skip Intros** (`AutoSkipIntro`, admin default **off**) — automatically
  skips detected intro segments.
- **Auto-skip Outros** (`AutoSkipOutro`, admin default **off**) — automatically
  skips detected outro / end-credit segments.

Both rely on media segments for the item (from the [Intro Skipper
plugin](https://github.com/intro-skipper/intro-skipper) or another segment
provider). See [Smart Playback](enhanced-features.md#smart-playback).

## Show File Sizes

Enable **Show File Sizes** (per-user, in the Enhanced panel's **Settings** tab)
to display each item's file size on its item detail and collection pages.

## Show Audio Languages

Enable **Show Audio Languages** (per-user, in the Enhanced panel's **Settings**
tab) to list the available audio languages on a title's item detail page. This
is distinct from the poster **Language Tags** overlay (see [Tags](#tags-quality-genre-language-rating-people)),
which draws audio-language flags on poster cards in library and home views.

## Show Release/Air Date

**Show Release/Air Date** (`ShowReleaseDates`, admin-only) adds a chip on Movie,
Series, Season and Episode detail pages showing the cinema/digital/physical
release date (movies) or the next/last episode air date (series, seasons,
episodes), sourced from TMDB.

- **Admin config toggle** — enable it in the **Release Dates** section of the
  plugin config page. There is no per-user override.
- **Requires a TMDB API Key** — the chip only takes effect once a TMDB API Key
  is set (see [Elsewhere Settings](../elsewhere/elsewhere-settings.md#getting-a-tmdb-api-key)).
- **Region preference** — it uses the **Default Region** configured under
  [Elsewhere](../elsewhere/elsewhere-settings.md#default-region) to choose which
  country's release dates to prefer, falling back to US and then any region TMDB
  has for that release type.

## User Reviews Moderation

When **User Written Reviews** are enabled (see [User
Reviews](enhanced-features.md#user-reviews)), two admin defaults in the **User
Reviews** section of the plugin config page (**Elsewhere** tab) control whose
reviews non-admins can see. Both are **on** by default, and admins always see
every review regardless.

- **Hide reviews from hidden users** (`HideReviewsFromHiddenUsers`, default
  **on**) — hides reviews written by Jellyfin users marked *"Hide this user from
  login screens"* from non-admin viewers.
- **Hide reviews from disabled users** (`HideReviewsFromDisabledUsers`, default
  **on**) — hides reviews written by Jellyfin users marked *"Disable this user"*
  from non-admin viewers.

## Custom Tabs Auto-Entry (Bookmarks & Hidden Content)

When you route the **Bookmarks** or **Hidden Content** page through the [Custom
Tabs](https://github.com/IAmParadox27/jellyfin-plugin-custom-tabs) plugin, an
**Add the Custom Tabs entry for me** toggle lets Jellyfin Elevate create the
matching Custom Tabs entry for you on save (turning the corresponding *Use Custom
Tabs* option off removes it again; leave unchecked to manage the entry yourself).

- **Bookmarks** — `BookmarksAutoCreateCustomTab` (default **off**), on the
  **Bookmarks** config section.
- **Hidden Content** — `HiddenContentAutoCreateCustomTab` (default **off**), on
  the **Hidden Content** config section.

These toggles only appear once the corresponding *Use Custom Tabs* option is
enabled, which requires the Custom Tabs plugin to be installed.

## Home Row Filtering

**Filter Continue Watching** and **Filter Next Up** (in the Hidden Content
settings) take effect on the Home screen on their own — independently of **Filter
Library**. Enabling either one hides the matching cards from those Home rows
without requiring library filtering to be on. See [Hidden Content
System](enhanced-features.md#hidden-content-system).

## Language Discovery

The plugin's language selector lists the available translations by querying the
plugin's **own server endpoint** (`/JellyfinElevate/locales`) — the browser no
longer calls GitHub to discover locales, so language discovery works on isolated
networks and doesn't depend on GitHub's rate limits.
