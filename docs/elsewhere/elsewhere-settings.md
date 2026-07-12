# Elsewhere Settings

!!! info "Prerequisites"

    **Prerequisites:**

    - **TMDB API Key**
        - [Free from TMDB](https://www.themoviedb.org/settings/api)
    - **Jellyfin Elevate** plugin installed


## Prerequisites

### Getting a TMDB API Key

1. Create a free account at [TMDB](https://www.themoviedb.org/)
2. Go to [Settings → API](https://www.themoviedb.org/settings/api)
3. Request an API key (choose "Developer" option)
4. Copy the API Key (v3 auth)
5. Paste into plugin settings

A single TMDB API key powers every TMDB-backed feature in the plugin. The same
key is used whether you enter it on the **Elsewhere** tab or the **Seerr** tab —
setting it in one place is enough. It unlocks:

- **Elsewhere streaming availability** — the where-to-watch panel on item detail pages
- **TMDB Reviews** — TMDB and user-written reviews on detail pages
- **Release / Air Dates** — TMDB release-date and air-date lookups
- **Seerr streaming-provider posters** — streaming-service icons on Seerr result cards, plus person ("More from Actor") and keyword/tag discovery
- **People Tags** — birthplace and age enrichment for cast members on detail pages

## Setup

1. Go to **Dashboard** → **Plugins** → **Jellyfin Elevate**
2. Navigate to **Elsewhere** tab
3. Confirm **"Enable Elsewhere"** is checked (it is **on by default**)
4. Enter your **TMDB API Key**
5. Select your **Default Region** (e.g., US, GB, DE)
6. Optional: Configure default and ignored providers
7. Click **Save**

!!! note "On by default, but needs a TMDB API key"
    **Enable Elsewhere** ships **on** (`ElsewhereEnabled = true`), so the only required
    step is entering a valid **TMDB API Key** — the Elsewhere panel does not appear on item
    detail pages until a key is set. Untick **Enable Elsewhere** if you want to turn the
    detail-page panel off.



## Configuration Options

### Default Region

Select the primary region for streaming availability checks. Empty defaults to US.

!!! note "Shared across features"
    Default Region, Default Providers and Ignore Providers are also used by **TMDB Release Dates** (region) and the **Seerr streaming icons** (all three), which don't depend on the Elsewhere panel. These fields therefore stay editable even when **Enable Elsewhere** is off — only the Elsewhere detail-page panel and its custom-branding fields are gated behind that toggle.

**View full list:** [Available Regions](https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfin-Elsewhere/resources/regions.txt)

**Examples:**

- `US` - United States
- `GB` - United Kingdom
- `DE` - Germany
- `FR` - France
- `ES` - Spain
- `IT` - Italy

### Default Providers

Comma-separated list of streaming provider names to show by default. Leave blank to show all.

**View full list:** [Available Providers](https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfin-Elsewhere/resources/providers.txt)

**Example:**
```text
Netflix,Hulu,Disney Plus
```

**Common Provider Names:**

- Netflix
- Amazon Prime Video
- Disney Plus
- HBO Max
- Hulu
- Crunchyroll

### Ignore Providers

Comma-separated list of provider names to hide from results. **Supports regex patterns** for advanced filtering.

**View full list:** [Available Providers](https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfin-Elsewhere/resources/providers.txt)

**Examples:**

Basic (exact names):
```text
Apple TV,Google Play Movies
```

With regex (hide all "with Ads" providers):
```text
.*with Ads
```

Multiple patterns:
```text
.*with Ads,.*Free,Vudu
```

**Use Cases:**

- Hide providers you don't have access to / or have access to
- Filter out ad-supported tiers
- Remove free streaming options
- Exclude rental/purchase-only services

### Custom Branding

**Custom Branding Message** (labeled "Custom Branding Message" in the config page):

- The text shown in the Elsewhere panel when the title is **not** available on any streaming provider in the region — e.g. "Only available on My Server"
- Replaces the default "Not available on any streaming services in [region]" message
- Leave blank to fall back to the default message

**Custom Branding Icon URL** (labeled "Custom Branding Icon URL" in the config page):

- Optional icon shown next to the Custom Branding Message
- Only appears when a message is set **and** the title has no available providers
- Provide a URL or path to the image file (e.g. a full `https://` URL or a local path like `/web/assets/img/icon.png`)
- Leave empty to show the message text with no icon

## Per-User Panel Settings

The settings above are the server-wide **admin defaults**. Each user can also override the
region and provider filters just for themselves, directly from the Elsewhere panel on any
item detail page. Click the **gear (settings) icon** in the panel header to open the
per-user settings dialog:

| Control | Description |
|---|---|
| **Region** | A primary region select that overrides the admin **Default Region** for this user. |
| **Add other countries** | An autocomplete for adding extra regions. When set, the panel's **Search** button looks the title up across every selected region at once. |
| **Providers** | A provider-filter autocomplete that overrides the admin **Default Providers** for this user — leave it empty to show every provider. |
| **Search** | Runs the multi-region lookup for the chosen region(s) and shows availability for each. |

Each user's choices are saved server-side to their own `elsewhere.json`, so they persist
across devices and never change the admin defaults or other users' views. A user who never
opens this dialog simply keeps the admin Default Region and Default Providers.

## Usage

### On Item Detail Pages

1. Open any movie or TV show detail page
2. Scroll to the streaming-availability panel (its title reads "Also available in _\<region\>_ on:" or, when nothing is found, "Not available on any streaming services in _\<region\>_")
3. View available streaming options

### Information Displayed

- **Provider icons** - Visual logos of streaming services where content is available
- **Provider names** - Name of each streaming service
- **Multi-region support** - Shows availability across your selected regions

## Troubleshooting

### Elsewhere Not Showing

**Check Configuration:**

1. Verify TMDB API key is correct
2. Ensure "Enable Elsewhere" is checked
3. Confirm item has TMDB metadata
4. Check browser console for errors

**TMDB API Access:**

- TMDB API may be blocked in some regions
- Use VPN if needed
- Check [Seerr troubleshooting](https://docs.seerr.dev/troubleshooting#tmdb-failed-to-retrievefetch-xxx) for TMDB access issues

### No Providers Showing

**Possible Causes:**

- Item not available in selected region
- All providers in ignore list
- TMDB data not available for item
- API rate limit reached

**Solutions:**

- Try different region
- Check ignore providers list
- Verify item has TMDB ID
- Wait and try again later

## Integration with Seerr

Elsewhere can be displayed on Seerr discovery pages.

**Enable:**

1. Go to **Dashboard** → **Plugins** → **Jellyfin Elevate**
2. Navigate to **Seerr** tab
3. Check "Show Streaming Providers on Posters"
4. Click **Save**

**Features:**

- Shows streaming availability on Seerr cards
- Same provider information as item pages
- Helps decide what to request

## Privacy & Data

**What Data is Sent:**

- TMDB ID of the item
- Selected region code
- API key (securely transmitted)

**What Data is NOT Sent:**

- Your Jellyfin library contents
- Personal information
- Viewing history

**Data Source:**

- All provider data comes from TMDB
- Updated regularly by TMDB community
- Accuracy depends on TMDB data quality

## Limitations

- Availability data depends on TMDB accuracy
- Some regions have limited provider data
- Provider availability changes frequently
- Requires internet connection

## Support

If you encounter issues:

1. Check [FAQ](../faq-support/faq.md) for common solutions
2. Verify TMDB API key is valid
3. Check browser console for errors
4. Report issues on [GitHub](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Elevate/issues)

---