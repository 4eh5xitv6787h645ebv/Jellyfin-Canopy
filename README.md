<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/readme-header-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/images/readme-header-light.png">
    <img src="docs/images/readme-header-dark.png" alt="Jellyfin Canopy" width="640">
  </picture>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Jellyfin%20Version-12-AA5CC3?logo=jellyfin&logoColor=00A4DC&labelColor=black" alt="Jellyfin Version">
  <img src="https://img.shields.io/badge/License-GPL--3.0-00A4DC?labelColor=black" alt="License">
  <img src="https://img.shields.io/badge/Development-100%25%20AI-AA5CC3?labelColor=black" alt="100% AI Development">
  <br><br>
  <a href='https://ko-fi.com/G2G51TIZF0' target='_blank'><img height='36' style='border:0px;height:36px;' src='https://storage.ko-fi.com/cdn/kofi1.png?v=6' border='0' alt='Buy Me a Coffee at ko-fi.com' /></a>
  <a href='https://www.buymeacoffee.com/n00bcodr' target='_blank'><img height='36' style='border:0px;height:36px;' src='https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png' border='0' alt='Buy Me a Coffee' /></a>
</p>

**Jellyfin Canopy is an independent fork and extensive modernization of [Jellyfin Enhanced](https://github.com/n00bcodr/Jellyfin-Enhanced), providing an integrated suite of playback, discovery, customization and media-management features for Jellyfin 12.**

<br>

## 🙏 Origins & Credit

This project **would not exist** without [n00bcodr](https://github.com/n00bcodr) and his outstanding work on [Jellyfin Enhanced](https://github.com/n00bcodr/Jellyfin-Enhanced). Every feature here stands on that foundation — years of ideas, design, community building, and polish that made Jellyfin Enhanced the essential enhancement suite for Jellyfin.

Jellyfin Canopy exists because the two projects chose different paths, not because of any shortcoming in the original. (Until version 2.0 this project was published as **Jellyfin Elevate** — same plugin, same plugin ID; existing installs upgrade in place.)

- **Jellyfin Enhanced** continues to serve Jellyfin 10.11 — stable, proven, and actively maintained by its original author.
- **Jellyfin Canopy** is a ground-up modernization targeting **Jellyfin 12 only**: a strict-TypeScript ES-module client, policy-based server auth, push-driven live updates, a committed Playwright e2e suite, and enforced performance rules.

If you appreciate this project, please support the original author — **all donation links in this repository intentionally point to n00bcodr**:

- ☕ [Ko-Fi](https://ko-fi.com/n00bcodr) ⦁ ☕ [Buy Me a Coffee](https://www.buymeacoffee.com/n00bcodr) ⦁ ⭐ [Star Jellyfin Enhanced](https://github.com/n00bcodr/Jellyfin-Enhanced)

## 🤖 100% AI Development

Jellyfin Canopy is developed **entirely with AI** (agentic coding tools driving design, implementation, testing, and review), directed and curated by a human maintainer. Every change still has to pass the project's full gate suite — strict TypeScript type-checking, lint, unit tests with coverage ratchets, golden snapshot tests, a real end-to-end Playwright suite against a live Jellyfin 12 server, and multi-pass adversarial code review — before it lands.

<br>

## 🚀 Quick Start

### Installation

1. In Jellyfin, go to **Dashboard** → **Plugins** → **Catalog**
2. Click the gear icon (⚙️ **Manage Repositories**), click **➕**, and add the repository:
   ```
   https://raw.githubusercontent.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/main/manifest.json
   ```
3. Back in the **Catalog**, find **Jellyfin Canopy** and click **Install**
4. **Restart** your Jellyfin server

> [!IMPORTANT]
> **Jellyfin 12 Required** — Jellyfin Canopy only supports Jellyfin 12. Jellyfin 10.11 users should use the original [Jellyfin Enhanced](https://github.com/n00bcodr/Jellyfin-Enhanced) plugin.

> [!TIP]
> **Highly Recommended:** Install the [File Transformation plugin](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) to avoid permission issues on all installation types (Docker, Windows, Linux, etc.).

<br>

## ✨ Feature Highlights

### 🎬 Playback
- **Advanced Keyboard Shortcuts** - Comprehensive hotkeys for navigation and playback
- **Smart Bookmarks** - Save and jump to timestamps with visual markers
- **Custom Pause Screen** - Beautiful overlay with media info
- **Auto-Skip Intros/Outros** - Seamless binge-watching (requires media segments — e.g. the Intro Skipper plugin or any other segment provider)
- **Custom Subtitle Colors** - Full color customization with alpha support

### 🙈 Content Management
- **Hidden Content System** - Per-user content hiding with server-side storage
- **Granular Filtering** - Control visibility across library, discovery, search, and more
- **Management Panel** - Search, unhide, and bulk operations
- **Spoiler Guard** - Per-user opt-in blur and metadata stripping for unwatched content, enforced server-side on every client

### 🪼 Seerr Integration
- **Search & Request** - Request media directly from Jellyfin search
- **Item Details** - Recommendations and similar items on detail pages
- **Discovery Pages** - Browse by genre, network, person, or tag
- **Auto Requests** - Auto-request the next season or the next movie in a collection
- **Issue Reporting** - Report problems directly to Seerr
- **Watchlist Sync** - Auto-sync with Jellyfin watchlist

### 🧭 Discovery Feed
- **Rows of Cards** - Customizable Trending, Popular, Upcoming, Top Rated, and genre rows inside your Movies & TV Shows libraries, opened from a **Discovery** button in the library toolbar
- **Inline Requests** - Every card carries an availability badge and a one-tap Seerr request (Seerr-backed)
- **Per-User Customization** - Choose which rows appear and reorder them, on top of the admin defaults

### 🔗 *arr Integration
- **Quick Links** - Jump to Sonarr, Radarr, Bazarr pages (admin only)
- **Search & Interactive Search** - Trigger an *arr search or pick a release by hand from the item menu; Monitor/Add (admin only)
- **Tag Links** - Display and filter *arr tags
- **Calendar View** - Upcoming releases from Sonarr/Radarr
- **Requests Page** - Monitor download queue and status

### 🏷️ Visual Enhancements
- **Quality Tags** - 4K, HDR, Atmos, and more on posters
- **Genre Tags** - Themed icons for instant genre identification
- **Language Tags** - Country flags for available audio languages
- **Rating Tags** - TMDB and Rotten Tomatoes ratings at a glance
- **People Tags** - Age and birthplace info for cast members

### 🔍 Discovery
- **Elsewhere Integration** - See where media is available to stream
- **TMDB Reviews** - Display user reviews from TMDB
- **User Reviews** - Users write and rate 1–5★ reviews, with admin moderation
- **Random Button** - Discover content in your library

### 🎨 Customization
- **Custom Branding** - Upload your own logos, banners, and favicon
- **Theme Selector** - Choose from multiple color variants
- **Extensive CSS Options** - Customize every visual element
- **Active Streams Widget** - Live session monitor with admin Stop, Message, and Broadcast controls
- **Maintenance Mode** - Temporarily lock users out with a login banner and in-session notice (admin)
- **Multi-language Support** - Available in 26 languages

<br>

## 📚 Documentation

Full documentation lives in [`docs/`](docs/) and is published at [https://4eh5xitv6787h645ebv.github.io/Jellyfin-Canopy/](https://4eh5xitv6787h645ebv.github.io/Jellyfin-Canopy/) (available once the repository is public).

<br>

## 🏗️ Project Structure

One C# project (server) plus one TypeScript module tree (client), shipped as a single client bundle:

- **`Jellyfin.Plugin.JellyfinCanopy/src/`** — the client: strict TypeScript ES modules organized by area (`core/`, `enhanced/`, `jellyseerr/`, `arr/`, `tags/`, `elsewhere/`, `extras/`, `others/`), bundled by esbuild into `dist/jc.bundle.js` on every build. `src/facade.ts` types the frozen public `window.JellyfinCanopy` surface.
- **`Jellyfin.Plugin.JellyfinCanopy/js/`** — the loader (`plugin.js`), the translation files (`locales/`), and ambient type declarations (`core/globals.d.ts`); all feature code lives in `src/`.
- **`Jellyfin.Plugin.JellyfinCanopy/`** (C#) — `Controllers/` (one per feature area, policy-based auth), `Configuration/` (settings registry + admin page), `Services/` (integrations, live-update pushes). Targets Jellyfin 12 / net10.0 only.
- **`Jellyfin.Plugin.JellyfinCanopy.Tests/`** — xUnit tests incl. golden snapshots pinning the config payload and on-disk user-data formats.
- **`e2e/`** — committed Playwright suite + dockerized seeded Jellyfin 12.
- **`docs/`** — the documentation site (MkDocs).

How to add a feature: [CONTRIBUTING.md](CONTRIBUTING.md)

<br>

## 🧪 Compatibility

| Platform | Support | Notes |
|----------|---------|-------|
| Jellyfin Web UI | ✅ Full | All features available |
| Android App | ✅ Full | Official app with embedded web UI |
| iOS App | ✅ Full | Official app with embedded web UI |
| Desktop Apps | ✅ Full | Jellyfin Desktop v3.0.0+ (currently unreleased) |
| Android TV | ❌ Not Supported, but auto-season, movie requests work | Native app, no web UI |
| Third-party Apps | ❌ Not Supported, but auto-season, movie requests work | Depends on embedded web UI |

<br>

## 📸 Screenshots

<table>
  <tr>
    <th>Shortcuts</th>
    <th>Settings</th>
  </tr>
  <tr>
    <td><img src="docs/images/enhanced-panel-shortcuts.png" width="400" /></td>
    <td><img src="docs/images/enhanced-panel-settings.png" width="400" /></td>
  </tr>
  <tr>
    <th>Pause Screen</th>
    <th>Elsewhere</th>
  </tr>
  <tr>
    <td><img src="docs/images/pausescreen.png" width="400" /></td>
    <td><img src="docs/images/elsewhere.png" width="400" /></td>
  </tr>
  <tr>
    <th>Seerr</th>
    <th>Ratings</th>
  </tr>
  <tr>
    <td><img src="docs/images/jellyseerr.png" width="400" /></td>
    <td><img src="docs/images/ratings.png" width="400" /></td>
  </tr>
</table>

<br>

## 🌍 Contributing

- 🐛 [Report Issues](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues)
- 💡 [Feature Requests](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/discussions)
- 🌍 Translations: locale JSON files live in `Jellyfin.Plugin.JellyfinCanopy/js/locales/` — PRs welcome (all 26 locales must stay in sync; `npm run validate-translations` must pass)

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow, gates, and the paved road for new features.

<br>

## 🎯 Related Projects

By [n00bcodr](https://github.com/n00bcodr), the original author of Jellyfin Enhanced:

- [Jellyfin-Enhanced](https://github.com/n00bcodr/Jellyfin-Enhanced) - The original project this fork is built on (Jellyfin 10.11)
- [Jellyfin-Tweaks](https://github.com/n00bcodr/JellyfinTweaks) - Additional tweaks plugin
- [Jellyfin-JavaScript-Injector](https://github.com/n00bcodr/Jellyfin-JavaScript-Injector) - Custom script injection
- [Jellyfish](https://github.com/n00bcodr/Jellyfish/) - Custom Jellyfin theme

Recommended plugins:

- [File Transformation](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) - Safe file modifications
- [Custom Tabs](https://github.com/IAmParadox27/jellyfin-plugin-custom-tabs) - Custom navigation tabs
- [Plugin Pages](https://github.com/IAmParadox27/jellyfin-plugin-pages) - Helps Plugins create custom pages for settings and info
- [Kefin Tweaks](https://github.com/ranaldsgift/KefinTweaks) - Watchlist and more

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
