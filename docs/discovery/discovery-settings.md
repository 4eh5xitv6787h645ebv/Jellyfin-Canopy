# Discovery Settings

Admin settings live on the **Discovery** tab of the Jellyfin Elevate config page (Dashboard → Plugins → Jellyfin Elevate). They set the **defaults**; each user can further customize their own feed from the Discovery **Customize** button.

!!! info "Requires a Seerr connection"
    Discovery is Seerr-backed — configure a Seerr connection on the **Seerr** tab first. Rows come from Seerr, so cards carry availability, request state and inline Request buttons, and every feed is parental-rating filtered server-side.

## Discovery & Trending

| Setting | Default | Description |
| --- | --- | --- |
| **Enable Discovery & Trending** | On | Master switch for the whole feature. |
| **Show in the Movies & TV library menu** | On | Adds the Discovery button to the Movies and TV Shows library pages. |

## Default rows

Which shelves appear by default. Users can add, remove and reorder rows for themselves — these are just the starting point.

| Row | Default |
| --- | --- |
| **Trending This Week** | On |
| **Popular** | On |
| **Upcoming** | On |
| **Top Rated** | On |
| **My Watchlist** | Off |
| **Add a few genre rows automatically** | On |

## How defaults and per-user choices interact

Discovery resolves a user's feed as **their customization → your admin defaults → built-in defaults**. A user who never opens *Customize* always sees your defaults; once they customize, their choice wins for them only. **Reset to defaults** in the Customize modal clears their override and returns them to your admin defaults.

Parental filtering is always enforced server-side and is not something a user can turn off.
