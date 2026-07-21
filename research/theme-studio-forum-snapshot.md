# Theme Studio forum and code-index discovery snapshot

Project: [Jellyfin Canopy — themes](https://github.com/users/4eh5xitv6787h645ebv/projects/8)

Tracking: [#382](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/382), [#383](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/383), [#449](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/449)

Snapshot date: **2026-07-21**

## Method and safety boundary

This independent completion audit adds the official [Jellyfin CSS customization contract](https://jellyfin.org/docs/general/clients/css-customization/), all eight pages of the public [Jellyfin Forum Themes & Styles category](https://forum.jellyfin.org/f-themes-styles), its [RSS feed](https://forum.jellyfin.org/syndication.php?fid=24&limit=100), the forum's curated [37 Themes index](https://forum.jellyfin.org/t-37-themes), GitLab-linked themes, and bounded GitHub code-index queries for Jellyfin-specific modern-Web selectors.

The audit read repository metadata, README/tree text, CSS text, and forum descriptions only. It did not execute or install third-party code, scripts, userscripts, plugins, build systems, webroot mutations, webhooks, remote imports, API-key workflows, fonts, images, or binaries. Unresolved or absent licensing never grants reuse. The implementation is independently authored from generalized outcomes.

## Complete forum thread snapshot

Every one of the 157 threads visible across the category's eight pages was enumerated. Classification means:

- **theme** — a named reusable theme, release, mirror, catalog, or theme showcase;
- **component/help** — CSS technique, asset, authoring question, compatibility report, or visual request;
- **extension** — functional UI extension or data/content behavior adjacent to presentation; and
- **unsupported** — TV/client-specific evidence retained for research only. Theme Studio does not style TV, tablet-only, or legacy layout markers.

| # | Class | Thread |
| ---: | --- | --- |
| 1 | component/help | [Jellyfin Home Redesign](https://forum.jellyfin.org/t-jellyfin-home-redesign) |
| 2 | extension | [Custom Recommendations, IMDb Cards and Trailer Search](https://forum.jellyfin.org/t-custom-recommendations-imdb-cards-and-trailer-search) |
| 3 | extension | [Improved Search / RSS](https://forum.jellyfin.org/t-improved-search-rss) |
| 4 | component/help | [More than 99 unwatched](https://forum.jellyfin.org/t-more-than-99-unwatched) |
| 5 | theme | [Finimalism [Updated for 10.11.X]](https://forum.jellyfin.org/t-finimalism-updated-for-10-11-x) |
| 6 | component/help | [Positioning of Primary Image](https://forum.jellyfin.org/t-positioning-of-primary-image) |
| 7 | unsupported | [CSS - tizen issue](https://forum.jellyfin.org/t-css-tizen-issue) |
| 8 | component/help | [Getting random background in My Media row](https://forum.jellyfin.org/t-getting-random-background-in-my-media-row) |
| 9 | theme | [Theme STARLIGHT](https://forum.jellyfin.org/t-theme-starlight) |
| 10 | extension | [Different images on Details page and Recently Added](https://forum.jellyfin.org/t-different-images-on-details-page-and-recently-added) |
| 11 | theme | [Scyfin CSS Theme (10.9.x Support)](https://forum.jellyfin.org/t-scyfin-css-theme-10-9-x-support) |
| 12 | component/help | [Music playlist art](https://forum.jellyfin.org/t-music-playlist-art) |
| 13 | component/help | [CSS Code Problem](https://forum.jellyfin.org/t-css-code-problem) |
| 14 | extension | [How to get IMDb to replace the star?](https://forum.jellyfin.org/t-how-to-get-imdb-to-replace-the-star) |
| 15 | component/help | [Boxart instead Poster on detail page](https://forum.jellyfin.org/t-boxart-instead-poster-on-detail-page) |
| 16 | theme | [Solar](https://forum.jellyfin.org/t-solar) |
| 17 | extension | [SPOTLIGHT - Trailers on the homepage](https://forum.jellyfin.org/t-spotlight-trailers-on-the-homepage) |
| 18 | component/help | [Library Listing Image Dimensions Vary - CSS Fix?](https://forum.jellyfin.org/t-library-listing-image-dimensions-vary-css-fix) |
| 19 | component/help | [Seeking Help: Customizing an Existing Jellyfin Theme (CSS Novice!)](https://forum.jellyfin.org/t-seeking-help-customizing-an-existing-jellyfin-theme-css-novice) |
| 20 | theme | [New update LIQUID GLASS jellyfin theme glassmorphism [10.11.x]](https://forum.jellyfin.org/t-new-update-liquid-glass-jellyfin-theme-glassmorphism-10-11-x) |
| 21 | theme | [StrawberryJam](https://forum.jellyfin.org/t-%F0%9F%8D%93strawberryjam%F0%9F%8D%93) |
| 22 | theme | [Finality [Updated for 10.10.X]](https://forum.jellyfin.org/t-finality-updated-for-10-10-x) |
| 23 | theme | [Jellypane [Updated for 10.10.X]](https://forum.jellyfin.org/t-jellypane-updated-for-10-10-x) |
| 24 | component/help | [Need help for CSS-Modification](https://forum.jellyfin.org/t-need-help-for-css-modification) |
| 25 | theme | [iJelly theme](https://forum.jellyfin.org/t-ijelly-theme) |
| 26 | component/help | [In need of a collection library thumbnail](https://forum.jellyfin.org/t-in-need-of-a-collection-library-thumbnail) |
| 27 | theme | [ZestyTheme](https://forum.jellyfin.org/t-%F0%9F%8D%8B%EF%B8%8F-zestytheme) |
| 28 | theme | [Experimental Mode Theme](https://forum.jellyfin.org/t-experimental-mode-theme) |
| 29 | component/help | [Crunchyroll Subtitle Style](https://forum.jellyfin.org/t-crunchyroll-subtitle-style) |
| 30 | component/help | [(CSS Help) Editing Elegantfin?](https://forum.jellyfin.org/t-css-help-editing-elegantfin) |
| 31 | unsupported | [Big TV Screen](https://forum.jellyfin.org/t-big-tv-screen) |
| 32 | component/help | [Jellyfin Scroll Bar Width](https://forum.jellyfin.org/t-jellyfin-scroll-bar-width) |
| 33 | component/help | [Adding poster, logo, background to title page](https://forum.jellyfin.org/t-adding-poster-logo-background-to-title-page) |
| 34 | theme | [Jellyfin Netflix skin](https://forum.jellyfin.org/t-jellyfin-netflix-skin) |
| 35 | extension | [Jellyfin ratings](https://forum.jellyfin.org/t-jellyfin-ratings) |
| 36 | component/help | [Removing More Like This](https://forum.jellyfin.org/t-removing-more-like-this) |
| 37 | component/help | [Thumbnail Request](https://forum.jellyfin.org/t-thumbnail-request) |
| 38 | component/help | [Home Style -- css code](https://forum.jellyfin.org/t-home-style-css-code) |
| 39 | component/help | [Blue Radiance - default theme. How?](https://forum.jellyfin.org/t-blue-radiance-default-theme-how) |
| 40 | component/help | [How make Backdrops more transparent](https://forum.jellyfin.org/t-how-make-backdrops-more-transparent) |
| 41 | component/help | [Hide the PG/age rating on the home screen?](https://forum.jellyfin.org/t-hide-the-pg-age-rating-on-the-home-screen) |
| 42 | extension | [Links to other detail pages in overview](https://forum.jellyfin.org/t-links-to-other-detail-pages-in-overview) |
| 43 | component/help | [Add New Themes to Drop-Down Menu](https://forum.jellyfin.org/t-add-new-themse-to-drop-down-menu) |
| 44 | theme | [Finity](https://forum.jellyfin.org/t-%E2%99%BE%EF%B8%8F-finity) |
| 45 | component/help | [My Custom Library Thumbnails](https://forum.jellyfin.org/t-my-custom-library-thumbnails) |
| 46 | theme | [GNAT - God not another theme](https://forum.jellyfin.org/t-gnat-god-not-another-theme%E2%80%BD) |
| 47 | component/help | [Disable/Hide Trailers and Upcoming](https://forum.jellyfin.org/t-disable-hide-trailers-and-upcoming) |
| 48 | component/help | [Cleaner way to show more columns on the home screen?](https://forum.jellyfin.org/t-cleaner-way-to-show-more-columns-on-the-home-screen) |
| 49 | component/help | [Logo on OSD instead of text](https://forum.jellyfin.org/t-logo-on-osd-instead-of-text) |
| 50 | component/help | [How to add a sub menu like Disney?](https://forum.jellyfin.org/t-how-to-add-a-sub-menu-like-disney) |
| 51 | unsupported | [Control OSD - An Accessible Cross-Platform TV Mode](https://forum.jellyfin.org/t-control-osd-an-accessible-cross-platform-tv-mode) |
| 52 | component/help | [Collections items list modification](https://forum.jellyfin.org/t-collections-items-list-modification) |
| 53 | component/help | [Custom Font on the Desktop Media Player App](https://forum.jellyfin.org/t-custom-font-on-the-desktop-media-player-app) |
| 54 | extension | [Shortcut to collection](https://forum.jellyfin.org/t-shortcut-to-collection) |
| 55 | component/help | [Hide the download button with CSS?](https://forum.jellyfin.org/t-hide-the-download-button-with-css) |
| 56 | component/help | [CSS Solution for Cast order after Special features](https://forum.jellyfin.org/t-css-solution-for-cast-order-after-special-features) |
| 57 | theme | [Flow for Jellyfin](https://forum.jellyfin.org/t-flow-for-jellyfin) |
| 58 | component/help | [Dynamic library background image](https://forum.jellyfin.org/t-dynamic-library-background-image) |
| 59 | unsupported | [Grid Style Libraries on TV](https://forum.jellyfin.org/t-grid-style-libraries-on-tv) |
| 60 | theme | [Zombie CSS - 10.9.x compatible](https://forum.jellyfin.org/t-zombie-css-10-9-x-compatible) |
| 61 | extension | [Change the label Studio on the main movie page](https://forum.jellyfin.org/t-change-the-label-studio-to-a-different-word-on-main-movie-page) |
| 62 | component/help | [List of custom thumbnail packs for Jellyfin](https://forum.jellyfin.org/t-list-of-custom-thumbnail-packs-for-jellyfin) |
| 63 | component/help | [Startseitenanpassung](https://forum.jellyfin.org/t-startseitenanpassung) |
| 64 | unsupported | [Android TV app Slidebar](https://forum.jellyfin.org/t-android-tv-app-slidebar) |
| 65 | component/help | [Jellyfin Library Cart Art](https://forum.jellyfin.org/t-jellyfin-library-cart-art) |
| 66 | component/help | [CSS Help — remove the background slideshow](https://forum.jellyfin.org/t-css-help-%E2%80%94-any-way-to-remove-the-background-slideshow) |
| 67 | theme | [Jellypane offline theme](https://forum.jellyfin.org/t-jellypane-offline-theme) |
| 68 | theme | [Show your theme/style](https://forum.jellyfin.org/t-show-your-theme-style) |
| 69 | extension | [CSS Color Picker Visible in Jellyfin Skin Manager Plugin](https://forum.jellyfin.org/t-css-color-picker-visible-in-jellyfin-skin-manager-plugin) |
| 70 | component/help | [Is there Select View modifiable?](https://forum.jellyfin.org/t-is-there-select-view-modifiable) |
| 71 | component/help | [Small problem with flex-wrap](https://forum.jellyfin.org/t-small-problem-with-flex-wrap) |
| 72 | component/help | [New season view?](https://forum.jellyfin.org/t-new-season-view) |
| 73 | component/help | [Wider logo](https://forum.jellyfin.org/t-wider-logo) |
| 74 | component/help | [Remove Poster from movie Details](https://forum.jellyfin.org/t-remove-poster-from-movie-details) |
| 75 | theme | [New Theme](https://forum.jellyfin.org/t-new-theme) |
| 76 | component/help | [Log in customization](https://forum.jellyfin.org/t-log-in-customization) |
| 77 | component/help | [CSS to hide title in TV show](https://forum.jellyfin.org/t-css-to-hide-title-in-tv-show) |
| 78 | component/help | [Custom CSS help](https://forum.jellyfin.org/t-custom-css-help) |
| 79 | component/help | [Played indicator missing episodes](https://forum.jellyfin.org/t-played-indicator-missing-episodes) |
| 80 | component/help | [CSS / Plugin to minimize library tiles on homescreen](https://forum.jellyfin.org/t-css-plugin-to-minimize-library-tiles-on-homescreen) |
| 81 | component/help | [Help adding video as background and rounded cards](https://forum.jellyfin.org/t-help-adding-video-as-background-rounded-edges-to-all-cards) |
| 82 | extension | [All people in one overview](https://forum.jellyfin.org/t-all-people-in-one-overview) |
| 83 | theme | [Finimalism Theme (Offline)](https://forum.jellyfin.org/t-finimalism-theme-offline) |
| 84 | component/help | [Adding/Customizing Fonts](https://forum.jellyfin.org/t-adding-customizing-fonts) |
| 85 | component/help | [How can I remove time background](https://forum.jellyfin.org/t-how-can-i-remove-time-background) |
| 86 | component/help | [Icons for metadata providers](https://forum.jellyfin.org/t-icons-for-metadata-providers) |
| 87 | component/help | [Some help with CSS](https://forum.jellyfin.org/t-some-help-with-css) |
| 88 | component/help | [Change view of films and series](https://forum.jellyfin.org/t-change-view-of-films-and-series-css) |
| 89 | component/help | [Custom CSS button color](https://forum.jellyfin.org/t-custom-css-button-color) |
| 90 | theme | [Zoomy my second theme](https://forum.jellyfin.org/t-zoomy-my-second-theme) |
| 91 | component/help | [CSS for TV series guest stars in grid view](https://forum.jellyfin.org/t-css-for-tv-series-guest-stars-in-grid-view) |
| 92 | theme | [My first theme CSS](https://forum.jellyfin.org/t-my-first-theme-css) |
| 93 | theme | [Any working theme for Experimental mode?](https://forum.jellyfin.org/t-any-working-theme-for-the-experimental-mode) |
| 94 | component/help | [Custom background from local files](https://forum.jellyfin.org/t-custom-background-from-local-files) |
| 95 | component/help | [Jellyfin background CSS and show header images](https://forum.jellyfin.org/t-help-needed-jellyfin-background-css-and-show-header-images) |
| 96 | extension | [YouTube/Twitch downloads behave like TV shows](https://forum.jellyfin.org/t-youtube-twitch-downloads-behave-like-tv-shows) |
| 97 | component/help | [Hide Movies on actor detail page](https://forum.jellyfin.org/t-hide-%E2%80%9Emovies%E2%80%9C-on-actor-detail-page) |
| 98 | component/help | [Change default blue accent for hover buttons](https://forum.jellyfin.org/t-how-do-i-change-the-default-blue-accent-colour-for-hover-buttons) |
| 99 | component/help | [Movie extras scroller snippet](https://forum.jellyfin.org/t-snippet-got-annoyed-with-the-movie-extras-scroller) |
| 100 | extension | [Add a Letterboxd link like IMDb](https://forum.jellyfin.org/t-is-it-possible-to-mod-jellyfin-movie-pages-to-include-a-letterboxd-link-like-imdb) |
| 101 | component/help | [Banner Logo](https://forum.jellyfin.org/t-banner-logo) |
| 102 | theme | [Prettified The Details Page](https://forum.jellyfin.org/t-prettified-the-details-page) |
| 103 | component/help | [Top library buttons](https://forum.jellyfin.org/t-top-library-buttons) |
| 104 | component/help | [No backdrops in mixed library overview](https://forum.jellyfin.org/t-no-backdrops-in-mixed-library-overview) |
| 105 | component/help | [Libraries with different languages](https://forum.jellyfin.org/t-libraries-with-different-languages) |
| 106 | component/help | [Movie library cast/crew thumbnails in grid view](https://forum.jellyfin.org/t-css-for-movie-library-cast-crew-thumbs-in-grid-view) |
| 107 | component/help | [Replace metadata text with icons](https://forum.jellyfin.org/t-replace-metadata-text-with-icons) |
| 108 | component/help | [CSS for Playerbar hide time](https://forum.jellyfin.org/t-css-for-playerbar-hide-time) |
| 109 | extension | [Image gallery within a movie profile](https://forum.jellyfin.org/t-image-gallery-within-a-movie-profile) |
| 110 | component/help | [Mixed movies and shows artist artwork](https://forum.jellyfin.org/t-mixed-movies-and-shows-artist-artwork) |
| 111 | theme | [Ultrachromatic Main Page Backdrop](https://forum.jellyfin.org/t-ultrachromatic-main-page-backdrop) |
| 112 | unsupported | [Android TV Theme](https://forum.jellyfin.org/t-android-tv-theme) |
| 113 | component/help | [Collection card image occupying too much space](https://forum.jellyfin.org/t-collection-card-image-occupying-too-much-space) |
| 114 | theme | [Jamfin - A Glassmorphism Theme](https://forum.jellyfin.org/t-10-9-jamfin-a-glassmorphism-theme) |
| 115 | component/help | [Light and sleek grid view](https://forum.jellyfin.org/t-light-and-sleek-grid-view) |
| 116 | theme | [Jellyhub Theme](https://forum.jellyfin.org/t-jellyhub-theme) |
| 117 | theme | [37 Themes](https://forum.jellyfin.org/t-37-themes) |
| 118 | component/help | [Custom CSS](https://forum.jellyfin.org/t-custom-css) |
| 119 | component/help | [All I want is a logo on the login page](https://forum.jellyfin.org/t-all-i-want-is-a-logo-on-the-login-page) |
| 120 | unsupported | [Android TV themes](https://forum.jellyfin.org/t-android-tv-themes) |
| 121 | component/help | [Replace the standard font](https://forum.jellyfin.org/t-most-simple-way-to-replace-the-standard-font) |
| 122 | component/help | [Issue receiving server custom CSS](https://forum.jellyfin.org/t-issue-with-receiving-custom-css-code-from-the-server) |
| 123 | component/help | [Progress bar when controls hidden](https://forum.jellyfin.org/t-progress-bar-when-controls-hidden) |
| 124 | unsupported | [Create a CSS theme for LG webOS](https://forum.jellyfin.org/t-how-to-create-a-css-theme-for-the-lg-webos-app) |
| 125 | component/help | [Live TV custom background image](https://forum.jellyfin.org/t-live-tv-custom-background-image) |
| 126 | component/help | [Distinguish collections from movies](https://forum.jellyfin.org/t-distinguish-collections-from-movies) |
| 127 | extension | [Enhancing Jellyfin's TV Network section](https://forum.jellyfin.org/t-enhancing-jellyfin-s-tv-network-section) |
| 128 | component/help | [Primary View with long file names](https://forum.jellyfin.org/t-primary-view-with-long-files-names-possible) |
| 129 | theme | [Revamped Darkflix v4](https://forum.jellyfin.org/t-revamped-darkflix-v4-2024) |
| 130 | component/help | [Actors display on detail page](https://forum.jellyfin.org/t-actors-display-on-detail-page) |
| 131 | component/help | [Help](https://forum.jellyfin.org/t-help--6459) |
| 132 | extension | [Customize Jellyfin 10.9.x with mods](https://forum.jellyfin.org/t-how-to-customize-jellyfin-10-9-x-with-mods) |
| 133 | theme | [JellySkin: Jellyfin v10.9 support](https://forum.jellyfin.org/t-jellyskin-jellyfin-v10-9-support) |
| 134 | theme | [DarkFlix](https://forum.jellyfin.org/t-darkflix) |
| 135 | component/help | [Make background transparent](https://forum.jellyfin.org/t-help-to-make-background-transparent) |
| 136 | component/help | [Custom CSS recovered](https://forum.jellyfin.org/t-custom-css-recovered) |
| 137 | component/help | [Reset CSS to default](https://forum.jellyfin.org/t-how-to-reset-css-to-default) |
| 138 | component/help | [Jellyfin-Icons got archived](https://forum.jellyfin.org/t-prayag17-jellyfin-icons-got-archived) |
| 139 | component/help | [Cursor Theme](https://forum.jellyfin.org/t-cursor-theme) |
| 140 | theme | [Powderblue](https://forum.jellyfin.org/t-powderblue) |
| 141 | component/help | [Users password](https://forum.jellyfin.org/t-users-password) |
| 142 | extension | [Infinite scroll?](https://forum.jellyfin.org/t-infinite-scroll) |
| 143 | component/help | [Toast notification position and duration](https://forum.jellyfin.org/t-customizing-toast-notifications-position-and-duration-in-docker-container) |
| 144 | extension | [Album and artist on genre pages](https://forum.jellyfin.org/t-album-artist-on-genre-pages) |
| 145 | component/help | [Change title page structure with CSS](https://forum.jellyfin.org/t-change-the-structure-of-the-title-page-by-using-css) |
| 146 | component/help | [Login background](https://forum.jellyfin.org/t-login-background) |
| 147 | component/help | [Re-arranging section order](https://forum.jellyfin.org/t-re-arranging-the-order-of-sections-is-easy) |
| 148 | component/help | [Modification](https://forum.jellyfin.org/t-modification) |
| 149 | component/help | [Custom Library Icon Pack](https://forum.jellyfin.org/t-custom-library-icon-pack) |
| 150 | component/help | [Remove/unset inline styles in a theme](https://forum.jellyfin.org/t-remove-unset-inline-styles-in-a-theme) |
| 151 | component/help | [Using VS Code for custom CSS](https://forum.jellyfin.org/t-using-vs-code-for-custom-css) |
| 152 | component/help | [Font outline on home screen](https://forum.jellyfin.org/t-font-outline-in-home-screen) |
| 153 | theme | [Scyfin CSS theme](https://forum.jellyfin.org/t-scyfin-css-theme) |
| 154 | extension | [Themes or plugins for music playback](https://forum.jellyfin.org/t-themes-or-plugins-to-enhance-music-playback-experience) |
| 155 | unsupported | [Roku interface](https://forum.jellyfin.org/t-roku-interface) |
| 156 | component/help | [Favicon not updating](https://forum.jellyfin.org/t-favicon-not-updating) |
| 157 | component/help | [Library card images](https://forum.jellyfin.org/t-library-card-images) |

## Forum result

The forum source adds long-tail personal CSS, deleted/unavailable repositories, GitLab-only work, asset collections, extensions, and current compatibility reports that name-based GitHub repository search cannot prove. The strongest new product requirement is the **responsive home-library grid** described by the current Home Redesign thread and reinforced by grid/column requests throughout the category. Theme Studio now owns that as the typed `layout.home-libraries` choice (`scroll` or `grid`) on modern desktop/wide and modern phone layouts. It preserves Jellyfin's source order and content, uses two bounded phone columns, and never activates on legacy, tablet-only, or TV markers.

Named-theme evidence from Solar, Finality, STARLIGHT, Jellyhub, 37 Themes, and the personal/derivative themes below otherwise maps to the existing independent controls for semantic palettes, typography, material, blur, navigation, density, artwork ratio, details, seasons, cards, indicators, progress, player/subtitle presentation, accessibility, and bounded motion. Brand imitation, hidden information, fixed-resolution geometry, remote runtime assets, direct webroot modification, injected executables, and TV-layout styling remain rejected.

## Forum-linked repository classification

| Repository | Classification and disposition |
| --- | --- |
| [github.com/ASKaraferias/jellyfin-cat](https://github.com/ASKaraferias/jellyfin-cat) | Tiny Catppuccin stylesheet; palette evidence already generalized. |
| [github.com/BobHasNoSoul/jellyfin-mods](https://github.com/BobHasNoSoul/jellyfin-mods) | Jellyfin mod/CSS catalog: login, backdrop, drawer, logo, home, pause, featured and seasonal ideas; direct webroot mutation is rejected. |
| [github.com/cecilia-sanare/jellyfin-theme](https://github.com/cecilia-sanare/jellyfin-theme) | Unavailable at snapshot; provenance retained. |
| [github.com/cedev-1/Jellyfin-modern-theme-custom](https://github.com/cedev-1/Jellyfin-modern-theme-custom) | Unavailable at snapshot; provenance retained. |
| [github.com/celticslment/Jellyfin-Theme](https://github.com/celticslment/Jellyfin-Theme) | Unavailable at snapshot; provenance retained. |
| [github.com/DevilsDesigns/Devils-Designs-Custom-Jellyfin-Thumbnails](https://github.com/DevilsDesigns/Devils-Designs-Custom-Jellyfin-Thumbnails) | CC0 library-thumbnail pack; reinforces local asset provenance and selectable library art. |
| [github.com/Deyusha69/jellyfin-theme](https://github.com/Deyusha69/jellyfin-theme) | Redirects to the already reviewed deyusha2 theme; no additional root or requirement. |
| [github.com/Druidblack/jellyfin_ratings](https://github.com/Druidblack/jellyfin_ratings) | Ratings userscript/plugin; multi-provider badge density is relevant, but API keys, proxies and injected scripts remain outside Theme Studio. |
| [github.com/Entree3k/Jellyfin](https://github.com/Entree3k/Jellyfin) | TV-network image archive/plugin source; local art handling applies, not a web theme. |
| [github.com/HEMAKING11/jellyfin-my-theme](https://github.com/HEMAKING11/jellyfin-my-theme) | Personal gradient/glass theme with desktop and mobile detail branches; covered by existing material, palette, card, details and responsive controls. |
| [github.com/jellyfin/jellyfin-vue](https://github.com/jellyfin/jellyfin-vue) | Official alternative client, not a Jellyfin Web custom theme or supported runtime target. |
| [github.com/JSethCreates/jellyfin-script-controlOSD](https://github.com/JSethCreates/jellyfin-script-controlOSD) | Adaptive-controller/TV OSD script; keyboard accessibility lessons retained, while TV layout styling and webroot injection remain out of scope. |
| [github.com/JSethCreates/jellyfin-script-spotlight](https://github.com/JSethCreates/jellyfin-script-spotlight) | Trailer spotlight extension; existing accessible hero/media integration covers presentation, while remote embeds and webroot mutation are rejected. |
| [github.com/JSethCreates/python-tool-trailhound](https://github.com/JSethCreates/python-tool-trailhound) | Trailer acquisition tool, not a visual theme. |
| [github.com/krlsantcard/Jellyfin-10.9](https://github.com/krlsantcard/Jellyfin-10.9) | Work-in-progress landscape/details CSS with phone branches; ideas covered, legacy selectors not reused. |
| [github.com/measaura/JF_Masterclass](https://github.com/measaura/JF_Masterclass) | Historical full theme with player, indicators, details, login, subtitles and phone landscape rules; all outcomes map to tested controls. |
| [github.com/nandyalu/trailarr](https://github.com/nandyalu/trailarr) | Trailer manager, not a visual theme. |
| [github.com/Nipppi/jellygray-light](https://github.com/Nipppi/jellygray-light) | Unavailable at snapshot; provenance retained. |
| [github.com/Phantomwise/jellyfin-custom-thumbnails-collection](https://github.com/Phantomwise/jellyfin-custom-thumbnails-collection) | Curated thumbnail directory; reinforces asset provenance and disclosure. |
| [github.com/prayag17/Jellyfin-Icons](https://github.com/prayag17/Jellyfin-Icons) | Archived icon-family CSS; existing Material/Lucide/system controls generalize the outcome. |
| [github.com/Pulgarcit0/Jellyfin-themes](https://github.com/Pulgarcit0/Jellyfin-themes) | Unavailable at snapshot; provenance retained. |
| [github.com/Ryah/jellyfin-theme](https://github.com/Ryah/jellyfin-theme) | Personal re-upload with semantic palette, Apple-style chrome, details and status treatments; no new architecture requirement. |
| [github.com/seanmcbroom/jellyfin-styles](https://github.com/seanmcbroom/jellyfin-styles) | Unavailable at snapshot; provenance retained. |
| [github.com/ShiniGandhi/JellyTheme](https://github.com/ShiniGandhi/JellyTheme) | Redirects to the already reviewed DanielHalevi/JellyTheme root. |
| [github.com/tedhinklater/finality](https://github.com/tedhinklater/finality) | Unavailable repository at snapshot; forum/CDN evidence retained without code reuse. |
| [github.com/tedhinklater/Jellyfin-Featured-Content-Bar](https://github.com/tedhinklater/Jellyfin-Featured-Content-Bar) | Featured hero extension with explicit desktop/phone breakpoints; accessible local hero ideas are already covered. |
| [github.com/ccrsxx/themes](https://github.com/ccrsxx/themes) | Maintained Violetfin successor; animated backdrops and multi-app build packaging add no new runtime role. |
| [gitlab.com/Krafting/jellyhub-theme](https://gitlab.com/Krafting/jellyhub-theme) | GitLab-only Ultrachromic derivative with accent, logo and pre-roll; generic color/branding outcomes covered, brand imitation rejected. |
| [gitlab.com/Krafting/jellyhub-theme1](https://gitlab.com/Krafting/jellyhub-theme1) | Unavailable GitLab project at snapshot; provenance retained. |

## GitHub code-index long tail

Four bounded code queries using the Jellyfin Web roles `layout-desktop`, `detailPageWrapperContainer`, `homeSectionsContainer`, `itemDetailPage`, and `cardOverlayContainer` exposed public CSS that repository-name search misses. The following groups preserve every Jellyfin-specific or plausible visual root from that window. Each was inspected through metadata, README/tree paths, and CSS text only.

### Named themes, forks and theme collections

These sources reinforce already typed palette, material, typography, shape, navigation, hero, details, card, player, status, motion and responsive outcomes. Service marks, copied selector bulk, unresolved-license assets, legacy-only CSS, fixed dimensions and remote imports are not adopted.

- [a-silly-goose/spicy-jelly](https://github.com/a-silly-goose/spicy-jelly)
- [aditya-damerla128/jellytv](https://github.com/aditya-damerla128/jellytv)
- [Aetherinox/jellyfin-theme-glass](https://github.com/Aetherinox/jellyfin-theme-glass)
- [B3Crazy/Jellyfin-Skins](https://github.com/B3Crazy/Jellyfin-Skins)
- [Bobisawesome07/jellyfish](https://github.com/Bobisawesome07/jellyfish)
- [cfm-miku-en/my-finality-remix-](https://github.com/cfm-miku-en/my-finality-remix-)
- [ChrisScott9456/jellyskin-legacy-css](https://github.com/ChrisScott9456/jellyskin-legacy-css)
- [cj-vana/liquidfin](https://github.com/cj-vana/liquidfin)
- [classicalDonkey/Jamfin](https://github.com/classicalDonkey/Jamfin)
- [CruiserMKII/themes](https://github.com/CruiserMKII/themes)
- [Deadshot2027/zombie-remake](https://github.com/Deadshot2027/zombie-remake)
- [deyusha2/Darkflix](https://github.com/deyusha2/Darkflix)
- [fallenbagel/Hint-of-Colors](https://github.com/fallenbagel/Hint-of-Colors)
- [felixschmittdev/neoglasses](https://github.com/felixschmittdev/neoglasses)
- [FSA1/Custom-Jellyfin-Skins](https://github.com/FSA1/Custom-Jellyfin-Skins)
- [Geounix/novastream](https://github.com/Geounix/novastream)
- [Geounix/Ultrachromic](https://github.com/Geounix/Ultrachromic)
- [hamada387/Hamflix](https://github.com/hamada387/Hamflix)
- [itzenzy2/Jellyfin-Netflix-Theme](https://github.com/itzenzy2/Jellyfin-Netflix-Theme)
- [James2802/Jellyflix](https://github.com/James2802/Jellyflix)
- [JetMick/jetmick.github.io](https://github.com/JetMick/jetmick.github.io)
- [kmageorge/jellyfin-kgtv](https://github.com/kmageorge/jellyfin-kgtv)
- [KugaNagisa/jelly-sakura-themes](https://github.com/KugaNagisa/jelly-sakura-themes)
- [kushiemoon-dev/jellyfin-cyberpunk-neon](https://github.com/kushiemoon-dev/jellyfin-cyberpunk-neon)
- [L10Messi10/jelly-minimal](https://github.com/L10Messi10/jelly-minimal)
- [LucieFairePy/JellyFlix](https://github.com/LucieFairePy/JellyFlix)
- [morganzero/moviotheme](https://github.com/morganzero/moviotheme)
- [MRunkehl/cineplex](https://github.com/MRunkehl/cineplex)
- [MRunkehl/cineplex-theme](https://github.com/MRunkehl/cineplex-theme)
- [Neto-EM/JellyfinTheme](https://github.com/Neto-EM/JellyfinTheme)
- [NickR240/PangolinGlass](https://github.com/NickR240/PangolinGlass)
- [Nintendosss/Starry-Night-Theme](https://github.com/Nintendosss/Starry-Night-Theme)
- [Niskeletor/Nisflix](https://github.com/Niskeletor/Nisflix)
- [Niskeletor/nisflix-v2](https://github.com/Niskeletor/nisflix-v2)
- [PalmarHealer/cleanfin](https://github.com/PalmarHealer/cleanfin)
- [Piglit09/piggietv-jellyfin-theme](https://github.com/Piglit09/piggietv-jellyfin-theme)
- [PowerPCFan/CSS-Themes](https://github.com/PowerPCFan/CSS-Themes)
- [r9titi/jellyplex](https://github.com/r9titi/jellyplex)
- [RikoxCode/NeonBlur](https://github.com/RikoxCode/NeonBlur)
- [RoaycL/jellyfin-emby-theme](https://github.com/RoaycL/jellyfin-emby-theme)
- [SauravKhare/jellyflix-theme](https://github.com/SauravKhare/jellyflix-theme)
- [schutterwaelder/BaerFin](https://github.com/schutterwaelder/BaerFin)
- [Skirmantas-SK/jellyfin-apple-tv](https://github.com/Skirmantas-SK/jellyfin-apple-tv)
- [taylorsegell/jelly-theme-teags](https://github.com/taylorsegell/jelly-theme-teags)
- [TheVodouch/jellyfin-css](https://github.com/TheVodouch/jellyfin-css)
- [Topiksit0/Jellyto](https://github.com/Topiksit0/Jellyto)
- [UdayPrakashMinz/Cyan](https://github.com/UdayPrakashMinz/Cyan)
- [vnt87/phimhubtheme](https://github.com/vnt87/phimhubtheme)
- [wiliferamirez/Jellyfin-Theme](https://github.com/wiliferamirez/Jellyfin-Theme)
- [xenoncolt/JellyFlixCustomCSS](https://github.com/xenoncolt/JellyFlixCustomCSS)
- [Yannick-student/SambucaflixCSS](https://github.com/Yannick-student/SambucaflixCSS)
- [zeroWELL2/JF-theme](https://github.com/zeroWELL2/JF-theme)
- [zoravar08/MBCtheme](https://github.com/zoravar08/MBCtheme)
- [Arlind-dev/jellyfin-custom-css](https://github.com/Arlind-dev/jellyfin-custom-css)
- [DeBendeBurcht/SpectraFin](https://github.com/DeBendeBurcht/SpectraFin)
- [djmohsen/dmThemes](https://github.com/djmohsen/dmThemes)
- [hunternick87/Jellyfish](https://github.com/hunternick87/Jellyfish)
- [Komeiji-Shiki/GrayWill-ST](https://github.com/Komeiji-Shiki/GrayWill-ST)
- [r3draid3r04/jellyfin-theme](https://github.com/r3draid3r04/jellyfin-theme)
- [ValerioLyndon/Rockfin](https://github.com/ValerioLyndon/Rockfin)

### Personal styles, derivative bundles and configuration repositories

These roots contain Jellyfin CSS or mirrored theme modules but do not establish a distinct architecture. They are retained for provenance and long-tail compatibility evidence; no code or asset was copied.

- [11ason/home](https://github.com/11ason/home)
- [alqix0/dotfiles](https://github.com/alqix0/dotfiles)
- [asarayja/redfox](https://github.com/asarayja/redfox)
- [dillacorn/omv-remote-dots](https://github.com/dillacorn/omv-remote-dots)
- [ExtraToast/personal-stack](https://github.com/ExtraToast/personal-stack)
- [Fortfite/miscfiles](https://github.com/Fortfite/miscfiles)
- [gaara144hz/gaara144hz](https://github.com/gaara144hz/gaara144hz)
- [gFabri/Channels-RPI4](https://github.com/gFabri/Channels-RPI4)
- [llaera/asemes](https://github.com/llaera/asemes)
- [Lolotte521/WebCode](https://github.com/Lolotte521/WebCode)
- [mastyu/css](https://github.com/mastyu/css)
- [mellnDE/mellnde.github.io](https://github.com/mellnDE/mellnde.github.io)
- [MOODMNKY-LLC/mood-mnky-command](https://github.com/MOODMNKY-LLC/mood-mnky-command)
- [MueslySnipes/MueslySnipes](https://github.com/MueslySnipes/MueslySnipes)
- [namith1003/Delicious](https://github.com/namith1003/Delicious)
- [nos30/jellyfin](https://github.com/nos30/jellyfin)
- [NotReeceHarris/NotReeceHarris](https://github.com/NotReeceHarris/NotReeceHarris)
- [ohheavenlytrevor/theme](https://github.com/ohheavenlytrevor/theme)
- [philosophiedeluxe/my_homepage](https://github.com/philosophiedeluxe/my_homepage)
- [Pukimaa/jellyfin-mods](https://github.com/Pukimaa/jellyfin-mods)
- [razor2611/jellyfin](https://github.com/razor2611/jellyfin)
- [Rhys-Woolcott/bonk](https://github.com/Rhys-Woolcott/bonk)
- [seamonkey420/MyJellyFinCSS](https://github.com/seamonkey420/MyJellyFinCSS)
- [sean-sang/abyss-css-modification](https://github.com/sean-sang/abyss-css-modification)
- [Ser4ph4/ser4ph4.github.io](https://github.com/Ser4ph4/ser4ph4.github.io)
- [Ser4ph4/themes](https://github.com/Ser4ph4/themes)
- [ServTECTelecom/ServJelly](https://github.com/ServTECTelecom/ServJelly)
- [Skulldorom/jellyfin-css](https://github.com/Skulldorom/jellyfin-css)
- [Starwarsfan2099/starwarsfan2099.github.io](https://github.com/Starwarsfan2099/starwarsfan2099.github.io)
- [telebytes/Telebytes-Mod](https://github.com/telebytes/Telebytes-Mod)
- [thatvistuagain/jf-styles](https://github.com/thatvistuagain/jf-styles)
- [tywentghxst/goatsplusconfigs](https://github.com/tywentghxst/goatsplusconfigs)
- [vc0sta/mediaserver-config](https://github.com/vc0sta/mediaserver-config)
- [victornavorskie/homelab](https://github.com/victornavorskie/homelab)
- [voidwave/voidwave.github.io](https://github.com/voidwave/voidwave.github.io)
- [vriksterr/jellyfin-custom-css](https://github.com/vriksterr/jellyfin-custom-css)
- [WauLau/Harpy-HSP](https://github.com/WauLau/Harpy-HSP)
- [youraerials/rainbow](https://github.com/youraerials/rainbow)
- [karimbouri/ConfigFiles](https://github.com/karimbouri/ConfigFiles)
- [nyakuoff/jellyfin-setup](https://github.com/nyakuoff/jellyfin-setup)
- [tecosaur/golgi](https://github.com/tecosaur/golgi)
- [upidapi/NixOs](https://github.com/upidapi/NixOs)
- [visualblind/jellyfin-css](https://github.com/visualblind/jellyfin-css)
- [visualblind/jellyfin-stuff](https://github.com/visualblind/jellyfin-stuff)
- [foclabroc/toolbox](https://github.com/foclabroc/toolbox)
- [C4uTi0N/Jellyprovements](https://github.com/C4uTi0N/Jellyprovements)
- [Evolve5164/deltanet](https://github.com/Evolve5164/deltanet)
- [getuliomedeiros/template-feflix](https://github.com/getuliomedeiros/template-feflix)
- [djones0/dancetube-theme](https://github.com/djones0/dancetube-theme)

### Visual and functional extensions

These repositories alter or augment presentation-adjacent behavior. Their useful visual states map to Canopy's existing hero, search, home, media, permission, loading, error and responsive contracts. Theme Studio does not inherit their data acquisition, executable injection, webroot mutation or policy behavior.

- [annie-things/annie-mlb-video-helper](https://github.com/annie-things/annie-mlb-video-helper)
- [bobbibg/jellyfin-plugin-cypherflix-hub](https://github.com/bobbibg/jellyfin-plugin-cypherflix-hub)
- [cleiton-tavares/jellyfin-plugin-full-custom-media-bar](https://github.com/cleiton-tavares/jellyfin-plugin-full-custom-media-bar)
- [FabianBartl/jellyfin-scripts](https://github.com/FabianBartl/jellyfin-scripts)
- [Geo-ten/jellyfin-core-slider](https://github.com/Geo-ten/jellyfin-core-slider)
- [IAmParadox27/jellyfin-plugin-home-sections](https://github.com/IAmParadox27/jellyfin-plugin-home-sections)
- [jollywitch/better-jellyfin-search](https://github.com/jollywitch/better-jellyfin-search)
- [RadicalMuffinMan/moonfin-server](https://github.com/RadicalMuffinMan/moonfin-server)
- [tengicungduocnhe/Jellyfin.SkinManager.C500](https://github.com/tengicungduocnhe/Jellyfin.SkinManager.C500)
- [developed-by-will/jellydash](https://github.com/developed-by-will/jellydash)
- [dhanushkt/dragon-db](https://github.com/dhanushkt/dragon-db)
- [sandunwira/Lumina](https://github.com/sandunwira/Lumina)
- [sandunwira/LuminaWeb](https://github.com/sandunwira/LuminaWeb)

### Cross-Emby and false-positive roots

The selector queries also returned generic sample applications and Emby-only projects. They are classified here so search noise cannot be mistaken for missing Jellyfin theme coverage; they contribute no modern Jellyfin Web requirement.

- [ajongsma/OSX_MediaCenter_MountainLion](https://github.com/ajongsma/OSX_MediaCenter_MountainLion)
- [chefbennyj1/emby_custom_css](https://github.com/chefbennyj1/emby_custom_css)
- [coudy/typescript](https://github.com/coudy/typescript)
- [dbaines/shiznoid](https://github.com/dbaines/shiznoid)
- [decentraland/builder](https://github.com/decentraland/builder)
- [jackloves111/EMBY.JS.CSS](https://github.com/jackloves111/EMBY.JS.CSS)
- [jeffsim/bluesky](https://github.com/jeffsim/bluesky)
- [justcivah/artandbargains](https://github.com/justcivah/artandbargains)
- [labdiynez/system](https://github.com/labdiynez/system)
- [Luisa-HT/Item-trade-frontend](https://github.com/Luisa-HT/Item-trade-frontend)
- [mathcals/emby-android](https://github.com/mathcals/emby-android)
- [Md7113/Porter-LLC](https://github.com/Md7113/Porter-LLC)
- [novotnyllc/MetroLog](https://github.com/novotnyllc/MetroLog)
- [quocthinhthan/Rental-P2P-MVP](https://github.com/quocthinhthan/Rental-P2P-MVP)
- [Shurelol/ScriptsForEmby](https://github.com/Shurelol/ScriptsForEmby)
- [thebeebs/hhg2oop](https://github.com/thebeebs/hhg2oop)
- [ux-mark/moving-fairy](https://github.com/ux-mark/moving-fairy)
- [v1rusnl/Embymalism](https://github.com/v1rusnl/Embymalism)
- [villagra/playerframework](https://github.com/villagra/playerframework)

## Reconciled product delta

The only uncovered modern-layout product outcome was the forum's repeated request for a responsive, non-scrolling home library grid. It is implemented as a typed, server-validated, previewable `layout.home-libraries` token with `scroll` and `grid` values, a dedicated `home-libraries-v12` adapter, editor localization, unit coverage, and real-browser attribute/layout assertions. The adapter changes CSS layout only; it does not add, remove, move, reorder, query, or reveal content.

All other reviewed outcomes already have stronger tested ownership in Theme Studio or another Canopy feature. Unsupported TV, legacy, and tablet-only layout markers remain exact stock/no-op boundaries.
