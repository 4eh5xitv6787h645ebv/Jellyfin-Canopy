# Jellyfin Elevate

<p align="center">
  <img src="https://img.shields.io/badge/Jellyfin%20Version-12-AA5CC3?logo=jellyfin&logoColor=00A4DC&labelColor=black" alt="Jellyfin Version">
</p>


<p align="center">
An integrated suite of playback, discovery, customization and media-management features for Jellyfin 12.<br><br>
  <img src="images/icon.png" alt="Jellyfin Elevate Logo" width="50%" />
</p>

## Compatibility

| Platform | Support | Notes |
|----------|---------|-------|
| Jellyfin Web UI | ✅ Full | All features available |
| Android App | ✅ Full | Official app with embedded web UI |
| iOS App | ✅ Full | Official app with embedded web UI |
| Desktop Apps | ✅ Full | Jellyfin Desktop v3.0.0+ (currently unreleased)|
| Android TV | ❌ Not Supported, but auto-season, movie requests work| Native app, no web UI |
| Third-party Apps | ❌ Not Supported, but auto-season, movie requests work | Depends on embedded web UI |

## Features Overview

### 🎬 Enhanced Features
- **⌨️ Keyboard Shortcuts** - Comprehensive hotkeys for navigation and playback
- **📝 Smart Bookmarks** - Save and jump to timestamps with visual markers
- **🎬 Custom Pause Screen** - Beautiful overlay with media info
- **⏯️ Smart Playback** - Auto-pause, auto-resume, auto-PiP
- **🏷️ Visual Tags** - Quality, genre, language, rating, and people tags
- **🎲 Random Button** - Discover content in your library

### 🔍 Elsewhere
- **Streaming Provider Lookup** - See where media is available
- **Multi-region Support** - Check availability across regions

### 🪼 Seerr
- **Search Integration** - Request media from Jellyfin search
- **Item Details** - Recommendations and similar items
- **Discovery Pages** - Browse by genre, network, person, or tag
- **Issue Reporting** - Report problems directly to Seerr
- **Watchlist Sync** - Auto-sync with Jellyfin watchlist
- **Auto Requests** - Auto next season and next movie (in collection) requests
- **Requests Page** - Monitor downloads and Seerr requests

### 🧭 [Discovery](discovery/discovery-features.md)
- **Discovery Feed** - A customizable rows-of-cards feed (Trending, Popular, Upcoming, Top Rated, and genre rows) inside your Movies & TV Shows libraries, opened from a **Discovery** button in the library toolbar
- **Inline Requests** - Every card carries an availability badge and a one-tap Seerr request (Seerr-backed)
- **Per-User Customization** - Choose which rows appear and reorder them, on top of the admin defaults

### 🔗 *arr Integration
- **Quick Links** - Jump to Sonarr, Radarr, Bazarr pages
- **Tag Links** - Display and filter *arr tags
- **Calendar View** - Upcoming releases from Sonarr/Radarr

### 🫣 [Spoiler Guard](spoiler-guard/spoiler-guard-features.md)
- **Per-User Opt-In** - Protect individual shows, movies, and collections
- **Image Protection** - Blur or stock-replace unwatched thumbnails, server-side
- **Metadata Stripping** - Hide titles, synopses, ratings, chapters, and cast until watched

### 🎨 Other Features
- **Custom Branding** - Upload your own logos and banners
- **Theme Selector** - Choose from multiple color variants
- **Colored Icons** - Activity and plugin icons
- **Login Images** - User avatars on login page
- **Multi-language** - Available in 26 languages