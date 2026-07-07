# Enhanced Settings — User configuration

## Enhanced Panel

![Enhanced panel — Settings tab overview](../images/enhanced-panel-settings.png)

Access user-configured settings via the Enhanced panel:

| Shortcuts | Settings |
|-----------|----------|
| ![Shortcuts](../images/enhanced-panel-shortcuts.png) | ![Settings](../images/enhanced-panel-settings.png) |

**Open Panel:**

- Click **Jellyfin Enhanced** in sidebar
- Press `?` keyboard shortcut


**Toggleable User Features:**

- Quality Tags
- Genre Tags
- Language Tags
- Rating Tags
- People Tags
- Pause Screen
- Auto-skip Intros
- Auto Picture-in-Picture
- Reviews
- Show Watch Progress
- Show File Sizes
- Show Audio Languages
- And more...


**Tabs:**

- **Shortcuts** - Customize keyboard shortcuts
- **Settings** - Enable/disable features, adjust positions

**Settings Persistence:**

- Settings saved server-side, per Jellyfin user (stored in the plugin's per-user settings.json via the `/JellyfinEnhanced/user-settings/{userId}/settings.json` endpoint)
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

### Tags Cache Duration

**Tags Cache Duration** (`TagsCacheTtlDays`, default 30 days) controls how long
the client keeps cached tag data before re-fetching. It applies to every tag
family, **including People tags** — changing it now adjusts the people-tag cache
lifetime too (previously that was fixed at 30 days regardless of this setting).

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

## Show File Sizes

Enable **Show File Sizes** (per-user, in the Enhanced panel's **Settings** tab)
to display each item's file size on its item detail and collection pages.

## Show Audio Languages

Enable **Show Audio Languages** (per-user, in the Enhanced panel's **Settings**
tab) to list the available audio languages on a title's item detail page. This
is distinct from the poster **Language Tags** overlay (see [Tags](#tags-quality-genre-language-rating-people)),
which draws audio-language flags on poster cards in library and home views.

## Home Row Filtering

**Filter Continue Watching** and **Filter Next Up** (in the Hidden Content
settings) take effect on the Home screen on their own — independently of **Filter
Library**. Enabling either one hides the matching cards from those Home rows
without requiring library filtering to be on. See [Hidden Content
System](enhanced-features.md#hidden-content-system).

## Language Discovery

The plugin's language selector lists the available translations by querying the
plugin's **own server endpoint** (`/JellyfinEnhanced/locales`) — the browser no
longer calls GitHub to discover locales, so language discovery works on isolated
networks and doesn't depend on GitHub's rate limits.
