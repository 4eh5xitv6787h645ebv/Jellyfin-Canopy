<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/readme-header-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/images/readme-header-light.png">
    <img src="docs/images/readme-header-dark.png" alt="Jellyfin Canopy" width="640">
  </picture>
</p>

<h3 align="center"><em>Grow your Jellyfin.</em></h3>

<p align="center">
  <img src="https://img.shields.io/badge/Jellyfin%20Version-12-AA5CC3?logo=jellyfin&logoColor=00A4DC&labelColor=black" alt="Jellyfin Version">
  <img src="https://img.shields.io/badge/License-GPL--3.0-00A4DC?labelColor=black" alt="License">
  <img src="https://img.shields.io/badge/Languages-26-2F80FF?labelColor=black" alt="26 Languages">
  <img src="https://img.shields.io/badge/Development-100%25%20AI-AA5CC3?labelColor=black" alt="100% AI Development">
  <br><br>
  <a href='https://ko-fi.com/G2G51TIZF0' target='_blank'><img height='36' style='border:0px;height:36px;' src='https://storage.ko-fi.com/cdn/kofi1.png?v=6' border='0' alt='Buy Me a Coffee at ko-fi.com' /></a>
  <a href='https://www.buymeacoffee.com/n00bcodr' target='_blank'><img height='36' style='border:0px;height:36px;' src='https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png' border='0' alt='Buy Me a Coffee' /></a>
</p>

**Jellyfin Canopy is one plugin that turns a Jellyfin 12 server into a complete home-theater experience** — smarter playback, a built-in discovery and request flow, family-safe viewing, beautiful posters, and real admin superpowers. Install it once on the server and it works everywhere the Jellyfin web interface runs: browsers, the official mobile apps, and desktop apps — nothing to install on your users' devices. The core experience lights up immediately; the bigger feature areas are opt-in, and a few connect to services you may already run (Seerr, Sonarr/Radarr, TMDB) — you enable what you want from one settings page, and almost everything can then be personalized per user.

<br>

## 🌟 Why Canopy?

- **It feels native.** Every button, panel, and page is built to look and behave like Jellyfin itself — no janky overlays, no popped-in widgets, both light and dark themes.
- **Your whole household benefits.** Features work per user: everyone gets their own settings, their own discovery feed, their own hidden titles, their own spoiler protection.
- **Admins stay in control.** Nearly every per-user toggle has an admin-set default, and the redesigned settings app makes hundreds of options easy to find with built-in search.
- **It replaces half a dozen browser tabs.** Requesting new media, approving requests, kicking a stream, grabbing a stubborn release from Sonarr — all without leaving Jellyfin.

<br>

## ✨ What it does

### 🎬 A better way to watch

- **Auto-Skip intros & outros** — precise, segment-based skipping for true binge mode (works with Intro Skipper or any media-segment provider).
- **Custom pause screen** — pause and get a beautiful overlay with artwork and media info instead of a frozen frame.
- **Keyboard shortcuts** — a full hotkey suite for navigation and playback, fully remappable per user.
- **Bookmarks** — save moments with visual markers on the timeline and jump back to them any time, from their own Bookmarks page.
- **Subtitle styling** — pick your own subtitle colors, size, and background.
- **Random button** — one tap to rediscover something you forgot your library had.

→ Full tour: [The Enhanced Experience](https://4eh5xitv6787h645ebv.github.io/Jellyfin-Canopy/enhanced/)

### 🧭 Find your next favorite

- **Discovery feed** — a Discover button inside your Movies and TV libraries opens shelves of Trending, Popular, Upcoming, Top Rated, and by-genre picks. Every card shows whether you already have it, and can request it if you don't. Each user customizes their own rows.
- **Elsewhere** — see which streaming services carry a title, right on its detail page.
- **Reviews** — read TMDB community reviews, and let your own users write and rate their reviews (1–5★, with admin moderation).

→ Full tour: [Discover & Request](https://4eh5xitv6787h645ebv.github.io/Jellyfin-Canopy/discover/)

### 🤝 Request without leaving Jellyfin

Connect [Seerr](https://github.com/seerr-team/seerr) once, and Jellyfin's own search becomes a request machine:

- **Search & request** anything — including titles you don't have yet — straight from Jellyfin search, with 4K and collection requests where your setup supports them.
- **Approve in-app** — admins (or trusted users) approve or decline pending requests with one tap.
- **Auto-requests** — automatically request the next season as you finish one, or the next movie in a collection.
- **Report issues** — users flag playback problems directly to Seerr from the item page.
- **Watchlist sync** — keep your Seerr and Jellyfin watchlists in step (Jellyfin → Seerr out of the box; the reverse direction needs the [KefinTweaks plugin](https://github.com/ranaldsgift/KefinTweaks) for Jellyfin watchlist support).

→ Setup & details: [Discover & Request](https://4eh5xitv6787h645ebv.github.io/Jellyfin-Canopy/discover/)

### 👨‍👩‍👧 Family-safe by design

- **Parental controls that follow the user everywhere** — Jellyfin's age ratings *and* tag-based block/allow rules are enforced on every discovery and request surface too, server-side, so restricted accounts never even see what they shouldn't request.
- **Spoiler Guard** — opt-in, per-user protection that blurs images and hides episode titles and descriptions for anything you haven't watched yet — enforced by the server on every device, including TV apps.
- **Anime Filler Warnings** — optional, per-user Filler badges on confidently matched anime episodes, with strict matching and no library metadata changes.
- **Hidden content** — any user can hide titles from their own library views, search, and discovery; a management panel handles search, unhide, and bulk actions, and admins can review any user's hidden list.

→ Details: [Spoiler Guard](https://4eh5xitv6787h645ebv.github.io/Jellyfin-Canopy/spoiler-guard/) · [The Enhanced Experience](https://4eh5xitv6787h645ebv.github.io/Jellyfin-Canopy/enhanced/)

### 🏷️ Posters that tell you more

At-a-glance badges on your library cards — each family individually toggleable:

- **Quality** (4K, HDR, Atmos…), **genre icons**, **audio-language flags**, **TMDB / Rotten Tomatoes ratings**, and **cast info** (age, birthplace) on people cards.

→ Details: [The Enhanced Experience](https://4eh5xitv6787h645ebv.github.io/Jellyfin-Canopy/enhanced/)

### 📄 Pages that feel built-in

Four new pages living right in Jellyfin's navigation, reorderable, native on desktop and mobile:

- **Calendar** — upcoming episodes and releases from Sonarr/Radarr.
- **Requests** — request status and the live download queue.
- **Bookmarks** — every saved moment across your library.
- **Hidden Content** — manage everything you've hidden.

→ Details: [Sonarr & Radarr](https://4eh5xitv6787h645ebv.github.io/Jellyfin-Canopy/sonarr-radarr/)

### 🛠️ Admin superpowers

- **A real settings app** — plugin settings organized into seven task-oriented areas with live search across every option, on desktop and phone.
- **Session control** — see active streams from the header, and stop or message any remote-control-capable session without opening the dashboard.
- **Sonarr/Radarr in the item menu** — trigger an automatic search on movies, series, seasons, or episodes; hand-pick a release (quality, size, seeders, rejection reasons — with one-tap Grab) for movies, seasons, and episodes; monitor/unmonitor and add missing movies or series with live download progress.
- **Layout enforcement** — default or force the modern Jellyfin layout on your users' desktop and mobile web devices (TV-mode devices are deliberately exempt).
- **Maintenance mode** — temporarily lock users out with a friendly banner while you work on the server.
- **Custom branding** — your own logos, banners, login image, and favicon; plus a theme selector and deep CSS customization.

→ Details: [Customization](https://4eh5xitv6787h645ebv.github.io/Jellyfin-Canopy/customization/) · [Reference](https://4eh5xitv6787h645ebv.github.io/Jellyfin-Canopy/reference/)

<br>

## 📸 Screenshots

<table>
  <tr>
    <th>Settings panel</th>
    <th>Shortcuts</th>
  </tr>
  <tr>
    <td><img src="docs/images/enhanced-panel-settings.png" width="400" /></td>
    <td><img src="docs/images/enhanced-panel-shortcuts.png" width="400" /></td>
  </tr>
  <tr>
    <th>Pause screen</th>
    <th>Elsewhere</th>
  </tr>
  <tr>
    <td><img src="docs/images/pausescreen.png" width="400" /></td>
    <td><img src="docs/images/elsewhere.png" width="400" /></td>
  </tr>
  <tr>
    <th>Search & request (Seerr)</th>
    <th>Ratings on posters</th>
  </tr>
  <tr>
    <td><img src="docs/images/seerr.png" width="400" /></td>
    <td><img src="docs/images/ratings.png" width="400" /></td>
  </tr>
  <tr>
    <th>Calendar page</th>
    <th>Active streams</th>
  </tr>
  <tr>
    <td><img src="docs/images/calendar-page.png" width="400" /></td>
    <td><img src="docs/images/active-stream.png" width="400" /></td>
  </tr>
</table>

<br>

## 🚀 Get started

1. In Jellyfin, go to **Dashboard** → **Plugins** → **Catalog**
2. Click the gear icon (⚙️ **Manage Repositories**), click **➕**, and add the repository:
   ```
   https://raw.githubusercontent.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/main/manifest.json
   ```
3. Back in the **Catalog**, find **Jellyfin Canopy** and click **Install**
4. **Restart** your Jellyfin server, then open **Dashboard → Plugins → Jellyfin Canopy** to switch on the feature areas you want — the [Getting Started guide](https://4eh5xitv6787h645ebv.github.io/Jellyfin-Canopy/getting-started/) walks the first-run setup step by step.

> [!IMPORTANT]
> **Jellyfin 12 required.** On Jellyfin 10.11, use the original [Jellyfin Enhanced](https://github.com/n00bcodr/Jellyfin-Enhanced) instead.

> [!TIP]
> Canopy's default request-time script and branding middleware do not need write access to Jellyfin's web or installation tree. [File Transformation](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation), [Plugin Pages](https://github.com/IAmParadox27/jellyfin-plugin-pages), and [Custom Tabs](https://github.com/IAmParadox27/jellyfin-plugin-custom-tabs) are separate optional plugins; Canopy does not use them on Jellyfin 12. See the [least-privilege guidance](https://4eh5xitv6787h645ebv.github.io/Jellyfin-Canopy/getting-started/#permission-issues) before enabling any legacy web-file modification.

Optional integrations — connect what you use, skip what you don't: **Seerr** (requests & discovery), **Sonarr / Radarr / Bazarr** (calendar, queue, item-menu search), a **media-segment provider** like Intro Skipper (auto-skip), and a free **TMDB API key** (Elsewhere, TMDB reviews, release dates, richer cast info).

→ Step-by-step: [Getting Started](https://4eh5xitv6787h645ebv.github.io/Jellyfin-Canopy/getting-started/)

<br>

## 📚 Documentation

Everything above, in depth — every setting explained, with screenshots:

| | |
|---|---|
| [Getting Started](https://4eh5xitv6787h645ebv.github.io/Jellyfin-Canopy/getting-started/) | Installation, first-run setup, integrations |
| [The Enhanced Experience](https://4eh5xitv6787h645ebv.github.io/Jellyfin-Canopy/enhanced/) | Playback, shortcuts, tags, pages, hidden content |
| [Discover & Request](https://4eh5xitv6787h645ebv.github.io/Jellyfin-Canopy/discover/) | Seerr setup, discovery feed, requests, reviews |
| [Sonarr & Radarr](https://4eh5xitv6787h645ebv.github.io/Jellyfin-Canopy/sonarr-radarr/) | Calendar, requests page, item-menu search |
| [Spoiler Guard](https://4eh5xitv6787h645ebv.github.io/Jellyfin-Canopy/spoiler-guard/) | Per-user unwatched-content protection |
| [Anime Filler Warnings](https://4eh5xitv6787h645ebv.github.io/Jellyfin-Canopy/anime-filler-warnings/) | Conservative anime episode filler badges |
| [Customization](https://4eh5xitv6787h645ebv.github.io/Jellyfin-Canopy/customization/) | Branding, themes, CSS, login image |
| [Reference](https://4eh5xitv6787h645ebv.github.io/Jellyfin-Canopy/reference/) | Every admin & user setting, catalogued |
| [Help & Community](https://4eh5xitv6787h645ebv.github.io/Jellyfin-Canopy/help/) | Troubleshooting and FAQs |

*(The documentation site goes live with the repository; the same pages are always browsable in [`docs/`](docs/).)*

<br>

## 🧪 Compatibility

| Platform | Support | Notes |
|----------|---------|-------|
| Jellyfin Web UI | ✅ Full | All features available |
| Android App | ✅ Full | Official app with embedded web UI |
| iOS App | ✅ Full | Official app with embedded web UI |
| Desktop Apps | ✅ Full | Jellyfin Desktop v3.0.0+ (currently unreleased) |
| Android TV | ⚠️ Partial | Native app (no web UI) — server-side features like Spoiler Guard and auto-requests still apply |
| Third-party Apps | ⚠️ Partial | Depends on embedded web UI — server-side features still apply |

<br>

## 🙏 Origins & credit

This project **would not exist** without [n00bcodr](https://github.com/n00bcodr) and his outstanding work on [Jellyfin Enhanced](https://github.com/n00bcodr/Jellyfin-Enhanced). Every feature here stands on that foundation — years of ideas, design, community building, and polish that made Jellyfin Enhanced the essential enhancement suite for Jellyfin.

Jellyfin Canopy is an independent fork that exists because the two projects chose different paths, not because of any shortcoming in the original:

- **Jellyfin Enhanced** continues to serve Jellyfin 10.11 — stable, proven, and actively maintained by its original author.
- **Jellyfin Canopy** is a ground-up modernization targeting **Jellyfin 12 only**. *(Until version 2.0 it was published as **Jellyfin Elevate** — same plugin, same plugin ID; existing installs upgrade in place.)*

If you appreciate this project, please support the original author — **all donation links in this repository intentionally point to n00bcodr**:

- ☕ [Ko-Fi](https://ko-fi.com/n00bcodr) ⦁ ☕ [Buy Me a Coffee](https://www.buymeacoffee.com/n00bcodr) ⦁ ⭐ [Star Jellyfin Enhanced](https://github.com/n00bcodr/Jellyfin-Enhanced)

## 🤖 100% AI development

Jellyfin Canopy is developed **entirely with AI** (agentic coding tools driving design, implementation, testing, and review), directed and curated by a human maintainer. Every change must pass a full quality gate — type checks, unit tests with coverage floors, a real end-to-end browser suite against a live Jellyfin 12 server, and multi-pass adversarial code review — before it lands. Curious how? See the [Developer Guide](https://4eh5xitv6787h645ebv.github.io/Jellyfin-Canopy/developers/).

<br>

## 🌍 Contributing

- 🐛 [Report issues](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues)
- 💡 [Suggest features](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues)
- 🌍 Help translate — Canopy ships [26 synchronized language catalogs](Jellyfin.Plugin.JellyfinCanopy/locale-manifest.json), and better translations are always welcome

Developers: [CONTRIBUTING.md](CONTRIBUTING.md) has the workflow, quality gates, and the paved road for new features.

<br>

## 🎯 Related projects

By [n00bcodr](https://github.com/n00bcodr), the original author of Jellyfin Enhanced:

- [Jellyfin-Enhanced](https://github.com/n00bcodr/Jellyfin-Enhanced) — the original project this fork is built on (Jellyfin 10.11)
- [Jellyfin-Tweaks](https://github.com/n00bcodr/JellyfinTweaks) — additional tweaks plugin
- [Jellyfin-JavaScript-Injector](https://github.com/n00bcodr/Jellyfin-JavaScript-Injector) — custom script injection
- [Jellyfish](https://github.com/n00bcodr/Jellyfish/) — custom Jellyfin theme

Other optional plugins:

- [File Transformation](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) — supports third-party plugins that deliberately modify web files; Canopy does not require it
- [Custom Tabs](https://github.com/IAmParadox27/jellyfin-plugin-custom-tabs) — custom navigation tabs; Canopy does not use it on Jellyfin 12
- [Plugin Pages](https://github.com/IAmParadox27/jellyfin-plugin-pages) — helps plugins create custom pages but does not support Jellyfin 12; Canopy does not use it
- [Kefin Tweaks](https://github.com/ranaldsgift/KefinTweaks) — watchlist and more

<br>

## 📄 License

This project is licensed under the [GNU General Public License v3.0](LICENSE), the same license as Jellyfin Enhanced.

<br>

---

<div align="center">

### Enjoying Jellyfin Canopy?

⭐ Star the repository ⦁ 🐛 Report bugs or suggest features ⦁ 🌍 Contribute translations
<br>
☕ And above all, support <a href="https://ko-fi.com/n00bcodr">n00bcodr</a>, the original author of Jellyfin Enhanced, without whom none of this would exist.

Made with 💜 for Jellyfin and the community

</div>
