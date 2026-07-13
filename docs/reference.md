# Reference

This is the power-user reference for Jellyfin Canopy: a map of where every admin setting lives, and the full catalogue of CSS hooks the plugin exposes so you can restyle or hide almost anything it draws. If you know what you want and need the exact tab, selector, class, or data attribute, this is the page to keep open.

## Where Settings Live

Every admin option lives on one of the tabs in the plugin config page: **Dashboard** → **Plugins** → **Jellyfin Canopy**. The config page is split into twelve tabs, each owning a distinct slice of the plugin. Use this table to find the tab you need and the guide that explains it in depth.

| Config-page tab | Configures | Documented in |
|---|---|---|
| **Overview** | Read-only health snapshot (service-connection status, optional companion plugins, feature states) plus quick actions. Clicking a card jumps to the owning tab. | [Customization](customization.md) |
| **Display** | Enhanced display settings: UI preferences, media tags, icons & theme, random button, default language. | [The Enhanced Experience](enhanced.md) |
| **Playback** | Enhanced playback settings: playback & tab-switch, auto-skip intros/outros, subtitles, panel & toast timing. | [The Enhanced Experience](enhanced.md) |
| **Pages** | Bookmarks, Hidden Content, Spoiler Guard, Requests Page, Calendar Page. | [The Enhanced Experience](enhanced.md), [Spoiler Guard](spoiler-guard.md), [Sonarr & Radarr](sonarr-radarr.md) |
| **Seerr** | Seerr connection and Seerr integration features. | [Discover & Request](discover.md) |
| **\*arr** | Sonarr / Radarr instances and *arr features. | [Sonarr & Radarr](sonarr-radarr.md) |
| **Elsewhere** | Elsewhere panel, TMDB API key, TMDB Reviews, Release Dates. | [Discover & Request](discover.md) |
| **Discovery** | Discovery / Trending feed (requires a Seerr connection). | [Discover & Request](discover.md) |
| **Extras** | Custom branding, extras/UI-tweak toggles, Active Streams widget, Letterboxd links, splash screen. | [Customization](customization.md) |
| **Keyboard** | Keyboard shortcuts. | [The Enhanced Experience](enhanced.md) |
| **Admin** | Maintenance Mode, Third-Party Assets, Developer Mode. | [Customization](customization.md) |
| **Docs** | Links to this documentation site. | — |

!!! tip "Most features start off"

    Many features are off by default and several need a one-time setup — a TMDB API key, a Seerr connection, or a Sonarr/Radarr instance — before they do anything. See [Getting Started](getting-started.md) for the first-run checklist.

## Custom CSS

Jellyfin Canopy draws a lot of on-screen furniture — pause-screen panels, media tags, an in-player rating overlay, tag links, the Enhanced Panel itself — and every piece carries a stable id, class, or data attribute you can target. That means you can recolor, resize, or hide almost anything with a few lines of CSS, without waiting for a setting to exist.

!!! note "Admin-supplied colours are validated"

    Where an admin setting supplies a **colour** that the plugin injects into a style rule (for example theme or subtitle colours), the value is validated as a real CSS colour before use and falls back to a safe default if it is not — so a colour field can't be used to inject arbitrary CSS. This does not affect the free-form **Custom CSS Code** box below, which is admin-authored and applied verbatim by Jellyfin. For the details of that validation, see the [Developer Guide](developers.md).

### Applying custom CSS

Custom CSS goes in Jellyfin's own branding box, so it applies to every client that loads the web UI:

1. In Jellyfin, go to **Dashboard** → **Branding**
2. Paste your CSS into **Custom CSS Code**
3. Click **Save**
4. Refresh the browser with ++ctrl+f5++

Everything below is a selector you can drop into that box.

### Pause screen

When you pause playback, Jellyfin Canopy replaces the default screen with an information panel. Each element is individually targetable, so you can trim it down to only the parts you want. (For what the pause screen does and its toggles, see [The Enhanced Experience](enhanced.md).)

| Element | CSS Selector | Example CSS to hide |
| --- | --- | --- |
| **Logo** | `#pause-screen-logo` | `#pause-screen-logo { display: none; }` |
| **Details** | `#pause-screen-details` | `#pause-screen-details { display: none; }` |
| **Plot** | `#pause-screen-plot` | `#pause-screen-plot { display: none; }` |
| **Progress Bar** | `#pause-screen-progress-wrap` | `#pause-screen-progress-wrap { display: none; }` |
| **Spinning Disc** | `#pause-screen-disc` | `#pause-screen-disc { display: none; }` |
| **Backdrop** | `#pause-screen-backdrop` | `#pause-screen-backdrop { display: none; }` |

### Media tag styling

The tags and overlays that Jellyfin Canopy stamps onto posters and detail pages all expose classes and data attributes, so you can restyle a whole tag family at once or single out one value. These are the client-side overlays configured on the **Display** tab; see [The Enhanced Experience](enhanced.md) for what each tag family means.

#### Quality tags

Change every quality tag at once:

```css
.quality-overlay-label {
    font-size: 0.8rem !important;
    padding: 3px 10px !important;
}
```

Target a specific quality by its `data-quality` value:

```css
.quality-overlay-label[data-quality="4K"] {
    background-color: purple !important;
}
```

Hide an unwanted quality tag:

```css
.quality-overlay-label[data-quality="H264"] {
    display: none !important;
}
```

The media stub tags — **BluRay, HD DVD, DVD, VHS, HDTV, Physical** — are matched the same way through `data-quality`:

```css
/* Change BluRay tag color */
.quality-overlay-label[data-quality="BluRay"] {
    background-color: rgba(0, 150, 255, 0.95) !important;
    color: #ffffff !important;
}

/* Change HD DVD tag color */
.quality-overlay-label[data-quality="HD DVD"] {
    background-color: rgba(200, 0, 50, 0.95) !important;
    color: #ffffff !important;
}

/* Change DVD tag color */
.quality-overlay-label[data-quality="DVD"] {
    background-color: rgba(200, 100, 0, 0.95) !important;
    color: #ffffff !important;
}

/* Change VHS tag color */
.quality-overlay-label[data-quality="VHS"] {
    background-color: rgba(160, 82, 45, 0.95) !important;
    color: #ffffff !important;
}

/* Change HDTV tag color */
.quality-overlay-label[data-quality="HDTV"] {
    background-color: rgba(100, 100, 100, 0.95) !important;
    color: #ffffff !important;
}

/* Hide generic Physical media tag */
.quality-overlay-label[data-quality="Physical"] {
    display: none !important;
}
```

#### Genre tags

Genre tags collapse to an icon until you hover over them. To keep the text always visible:

```css
.genre-tag {
    width: auto !important;
    border-radius: 14px !important;
}
.genre-tag .genre-text {
    display: inline !important;
}
```

#### Language tags

Language tags render as a flag carrying a `data-lang` attribute. Resize the flag:

```css
.language-flag {
    width: 30px !important;
    height: auto !important;
}
```

Hide a specific language by its `data-lang` code:

```css
.language-flag[data-lang="jp"] {
    display: none !important;
}
```

#### Rating tags

Rating tags are split by source, each with its own class. Restyle the TMDB rating:

```css
.rating-tag-tmdb {
    background: rgba(0, 0, 0, 0.9) !important;
}
```

Hide the critic rating:

```css
.rating-tag-critic {
    display: none !important;
}
```

#### In-player rating OSD

When **Show Rating in Video Player** is enabled, the plugin injects the item's TMDB and Rotten Tomatoes ratings into the video player OSD, next to the "Ends at" time. Its default styles live in an injected `<style id="jc-osd-rating-style">` element, so override them with `!important` (or higher specificity).

Available hooks:

- `#jc-osd-rating-container` – the rating container span; carries a `data-item-id` attribute set to the current item's id (e.g. `#jc-osd-rating-container[data-item-id]`)
- `.jc-chip.tmdb` / `.jc-chip.critic` – the TMDB (community) and Rotten Tomatoes (critic) chips
- `.jc-star` – the star glyph in the TMDB chip
- `.jc-text` – the numeric label (rating value or critic percent)
- `.jc-tomato` with `.fresh` / `.rotten` – the Rotten Tomatoes glyph (**fresh** when the critic score is 60 or above, **rotten** below 60)

Restyle the rating chips:

```css
#jc-osd-rating-container .jc-chip {
    padding: 3px 8px !important;
    border-radius: 6px !important;
}

/* Recolor the TMDB score */
#jc-osd-rating-container .jc-chip.tmdb .jc-text {
    color: #00a4dc !important;
}

/* Hide the Rotten Tomatoes critic chip */
#jc-osd-rating-container .jc-chip.critic {
    display: none !important;
}
```

#### People tags

The people-tag enrichment adds age chips and a birthplace banner. Customize the age chips:

```css
.jc-people-age-chip {
    padding: 6px 12px !important;
    font-size: 13px !important;
}
```

Hide the birthplace banner:

```css
.jc-people-place-banner {
    display: none !important;
}
```

### *arr Tag Links

When **Show synced tags as links** is enabled in the plugin config, the plugin injects tags into the item page under the external links section. Each tag becomes a link you can restyle per service, rename, or hide. (For how tags get synced in the first place, see [Sonarr & Radarr](sonarr-radarr.md).)

Structure of each link:

```html
<a class="button-link emby-button arr-tag-link"
   href="#..."
   title="View all items with tag: JC Arr Tag: in-netflix"
   data-id="in-netflix"
   data-tag="JC Arr Tag: in-netflix"
   data-tag-name="in-netflix"
   data-tag-prefix="JC Arr Tag: ">
  <span class="arr-tag-link-icon" aria-hidden="true"><!-- inline tag SVG --></span>
  <span class="arr-tag-link-text"
        data-id="in-netflix"
        data-tag="JC Arr Tag: in-netflix"
        data-tag-name="in-netflix"
        data-tag-prefix="JC Arr Tag: ">
    JC Arr Tag: in-netflix
  </span>
 </a>
```

Available hooks:

- `.arr-tag-link` – the anchor element for a single tag
- `.arr-tag-link-icon` – the icon span inside the link
- `.arr-tag-link-text` – the label span inside the link

Data attributes on both the link and text spans:

- `data-id` – a CSS-friendly slug of the raw tag (e.g. `in-netflix`)
- `data-tag` – full tag text including the prefix
- `data-tag-name` – tag without the prefix
- `data-tag-prefix` – the configured prefix (default: `JC Arr Tag: `)

**Common recipes:**

1) Rename a specific tag label

```css
/* Hide the original label so it doesn't reserve width */
.itemExternalLinks a.arr-tag-link[data-tag-name="1 - n00bcodr"] .arr-tag-link-text {
  display: none !important;
}

/* Draw your custom label using a pseudo-element on the link */
.itemExternalLinks a.arr-tag-link[data-tag-name="1 - n00bcodr"]::after {
  content: " N00bCodr"; /* leading space keeps a gap after the icon */
}
```

2) Hide a specific tag entirely (though the Hide Filter in config is usually the better tool)

```css
.itemExternalLinks a.arr-tag-link[data-id="in-netflix"] { display: none !important; }
/* or */
.itemExternalLinks a.arr-tag-link[data-tag-name="in-netflix"] { display: none !important; }
```

3) Change the icon or remove it

```css
/* Replace the icon */
.itemExternalLinks a.arr-tag-link .arr-tag-link-icon { display: none !important; }
.itemExternalLinks a.arr-tag-link::before {
  content: "🔖"; /* your icon */
  margin-right: .25rem;
}
```

4) Pill/badge styling for all tag links

```css
.itemExternalLinks a.arr-tag-link {
  padding: 8px 8px;
  border-radius: 999px;
  background: rgb(255,255,255,.5);
  border: 2px solid rgb(255,255,255,.8);
}
```

5) Service-specific colors using the data-id

```css
/* Note: data-id is a slugified form of the raw tag (lowercased, spaces → dashes),
   so a tag named "1 - n00bcodr" is matched as "1-n00bcodr". */
.itemExternalLinks a.arr-tag-link[data-id="1-n00bcodr"]  { background: #d81f26; color: #fff; }
.itemExternalLinks a.arr-tag-link[data-id="2-jellyfish"] { background: #00a8e1; color: #fff; }
.itemExternalLinks a.arr-tag-link[data-id="3-admin"] { background: #0c1a38; color: #8dd0ff; }
```

### Enhanced Panel and toasts

The [Enhanced Panel](enhanced.md) is the settings and shortcuts overlay the plugin opens with `?`. It styles itself to your theme automatically, so in most cases you don't need any CSS at all — but every part of it is targetable if you want to go further.

!!! note "Automatic theme detection"

    The Enhanced Panel automatically detects your active theme using unique CSS variables and styles itself to match — no configuration needed. It detects most popular Jellyfin themes:

    - **Jellyfish** — uses the theme's accent colors and blur effects
    - **ElegantFin** — matches the theme's header and accent color
    - **Default** — clean, universal styling for unrecognized themes

To override the automatic theming or customize the panel further, use the selectors below. The panel's root is `#jellyfin-canopy-panel`; toast notifications use `.jellyfin-canopy-toast`. This example is a complete universal override you can adapt:

```css

    /*
    * ===================================================================
    * Universal Style Override for the Jellyfin Canopy Panel
    * ===================================================================
    */

    /* --- Main Panel & Backdrop --- */
    #jellyfin-canopy-panel {
        background: rgba(25, 35, 45, 0.85) !important;
        border: 1px solid rgba(125, 150, 175, 0.3) !important;
        backdrop-filter: blur(20px) !important;
        color: #e6e6e6 !important;
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5) !important;
    }

    /* --- Panel Header --- */
    #jellyfin-canopy-panel > div:first-child {
        background: rgba(0, 0, 0, 0.25) !important;
        border-bottom: 1px solid rgba(125, 150, 175, 0.3) !important;
    }

    /* --- Main Title ("Jellyfin Canopy") --- */
    #jellyfin-canopy-panel div[style*="-webkit-background-clip: text"] {
        background: linear-gradient(135deg, #00a4dc, #aa5cc3) !important;
        -webkit-background-clip: text !important;
        -webkit-text-fill-color: transparent !important;
    }

    /* --- Tab Buttons --- */
    #jellyfin-canopy-panel .tab-button {
        background: rgba(0, 0, 0, 0.2) !important;
        color: rgba(255, 255, 255, 0.6) !important;
        border-bottom: 3px solid transparent !important;
    }

    #jellyfin-canopy-panel .tab-button:hover {
        background: rgba(0, 0, 0, 0.4) !important;
        color: #ffffff !important;
    }

    #jellyfin-canopy-panel .tab-button.active {
        color: #ffffff !important;
        border-bottom-color: #00a4dc !important;
        background: rgba(0, 0, 0, 0.3) !important;
    }

    /* --- Section Headers --- */
    #jellyfin-canopy-panel h3,
    #jellyfin-canopy-panel .jc-pane-title {
        color: #00a4dc !important;
    }

    /* --- Section Nav & Panes --- */
    #jellyfin-canopy-panel .tab-button.active {
        background-color: rgba(0, 164, 220, 0.12) !important;
    }
    #jellyfin-canopy-panel .jc-pane {
        background-color: transparent !important;
    }

    /* --- Keyboard Key Styling (<kbd>) --- */
    #jellyfin-canopy-panel kbd,
    .shortcut-key {
        background: #34495e !important;
        color: #ecf0f1 !important;
        border: 1px solid #2c3e50 !important;
        box-shadow: 0 2px 0 #2c3e50;
    }

    /* --- Toggles & Checkboxes --- */
    #jellyfin-canopy-panel input[type="checkbox"] {
        accent-color: #aa5cc3 !important;
    }

    /* --- Panel Footer --- */
    #jellyfin-canopy-panel .panel-footer {
        background: rgba(0, 0, 0, 0.25) !important;
        border-top: 1px solid rgba(125, 150, 175, 0.3) !important;
    }

    /* --- Buttons in Footer --- */
    #jellyfin-canopy-panel .footer-buttons a,
    #jellyfin-canopy-panel .footer-buttons button {
        background-color: rgba(255, 255, 255, 0.08) !important;
        transition: background-color 0.2s ease;
    }

    #jellyfin-canopy-panel .footer-buttons a:hover,
    #jellyfin-canopy-panel .footer-buttons button:hover {
        background-color: rgba(255, 255, 255, 0.15) !important;
    }

    /* --- Style for Toast Notifications --- */
    .jellyfin-canopy-toast {
        background: linear-gradient(135deg, #00a4dc, #aa5cc3) !important;
        color: white !important;
        border: none !important;
        backdrop-filter: blur(10px) !important;
    }

```

!!! tip "Branding vs. CSS"

    Some of what you might reach for CSS to do — a custom logo, colours, or splash screen — is already a first-class setting on the **Extras** tab. Check [Customization](customization.md) before hand-writing overrides.
