# Discovery & Trending

Discovery adds a customizable **rows-of-cards feed** — Trending, Popular, Upcoming, Top Rated, by genre, and more — right inside your Movies and TV Shows libraries. It turns Jellyfin into a place to *find* something to watch, not just play what you already have.

Each card behaves exactly like the rest of Jellyfin Elevate's Seerr surfaces: real poster art, an availability badge, a one-tap **Request** button for anything you don't have yet, streaming-service icons, and a direct link to the item in your library when you already own it.

## Where it shows up

- **Movies & TV Shows library pages** — a **Discovery** button appears in the library toolbar. Tapping it swaps the library grid for your Discovery feed; tapping it again returns to the grid. Movie pages show movie rows, TV pages show TV rows.
- **Home screen** (admin opt-in) — a **Discovery** tab on the Home page with a Movies/TV toggle, so you can browse without leaving Home. Enable it on the [Discovery settings page](discovery-settings.md).

!!! tip "More placements are on the way"
    A dedicated Discovery page and trending suggestions on the search screen are planned follow-ups.

## The rows

| Row | What it shows |
| --- | --- |
| **Trending This Week** | What's trending globally right now |
| **Popular** | The most popular movies / shows |
| **Upcoming** | Releasing soon |
| **Top Rated** | Highest rated |
| **My Watchlist** | Your Seerr watchlist (optional) |
| **Genre rows** | A few rows for real genres (Action, Comedy, …) |

## Where the data comes from

Discovery is **Seerr-backed** and requires a Seerr connection: rows come from Seerr, so every card knows whether the title is already **available**, **requested**, or **requestable** — and requests happen inline. "Already in your library" is resolved via the plugin's own provider lookup.

Discovery respects each user's **parental rating limit** — the same server-side filter used across the Seerr features — so restricted users never see blocked titles in a feed.

## Make it yours

Every user can tap **Customize** on their Discovery feed to choose which rows appear and in what order — include or exclude any row (including genre rows), reorder them, or reset to the defaults your admin set. Your choices are saved per user and don't affect anyone else.

Admins set the out-of-the-box defaults on the [Discovery settings page](discovery-settings.md).
