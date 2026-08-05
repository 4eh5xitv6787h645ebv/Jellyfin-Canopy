# Theme Studio ecosystem inventory

Project: [Jellyfin Canopy — themes](https://github.com/users/4eh5xitv6787h645ebv/projects/8)

Tracking: [#382](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/382), [#383](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/383)

Snapshot date: **2026-07-19**

## Scope and method

There is no central registry of every Jellyfin theme, and personal stylesheets can
exist without a public repository. “Every theme” is therefore defined here as a
reproducible discovery snapshot, not a claim about the entire Internet. The sweep
covered:

- the [GitHub `jellyfin-theme` topic](https://github.com/topics/jellyfin-theme);
- the pinned [awesome-jellyfin theme list](https://github.com/awesome-jellyfin/awesome-jellyfin/blob/3938da69c0577e6e0bd933fc52291e13e9964857/THEMES.md);
- broad GitHub repository searches for Jellyfin theme, skin, CSS, mobile, TV,
  glass, Material, Apple TV, Netflix, icon, seasonal, and theme-manager terms;
- repositories linked by the discovered projects; and
- official Jellyfin Web theme sources at commit
  [`3d7adb5`](https://github.com/jellyfin/jellyfin-web/tree/3d7adb53480f02164041fdd983b3f7abc28d0fd9/src/themes).

Fifty-one representative repositories were cloned shallowly without checkout or
execution and inspected as text. Third-party installers, scripts, build systems,
webhooks, and network calls were not run. GitHub repository metadata supplied the
archived state, last push, and detected license. `Unresolved` below means GitHub
did not resolve an SPDX license; it does **not** grant reuse permission. Any later
code or asset reuse requires an explicit compatibility and attribution review.

This inventory extracts product ideas. It does not copy third-party CSS. That
boundary is important for provenance, maintainability, Jellyfin 12 compatibility,
and the differing licenses in the ecosystem.

## Source inventory

### Full themes and theme families

| Project | Status at snapshot | GitHub license metadata | Distinctive contribution | Responsive evidence / main limitation |
|---|---|---|---|---|
| [Abyss](https://github.com/AumGupta/abyss-jellyfin) | Active | MIT | Cohesive dark glass system, floating navigation, spring-like motion, broad player/admin/form coverage | Desktop, ultrawide, and breakpoints documented; dark-only and motion/blur need accessibility tiers |
| [ElegantFin](https://github.com/lscambo13/ElegantFin) | Active | GPL-2.0 | Exceptional surface breadth: login, home, libraries, details, seasons, player, cast, music, books, Live TV, settings, and dashboard | Desktop, mobile, and TV examples; broad selector surface needs a supported-token translation |
| [Flow](https://github.com/LitCastVlog/Flow) | Active | GPL-3.0 | Plex-inspired composition, optional drawer/logo/episode/cast modules, backdrop-aware detail presentation | Mobile fixes exist; inherits selector and version sensitivity from its theme lineage |
| [Finity](https://github.com/prism2001/finity) | Active | GPL-3.0 | Large semantic variable set for color, alpha, blur, type, spacing, card sizes, visibility, and complete/minimal presets | Mobile and music are documented gaps; some features rely on an external script |
| [infinitv](https://github.com/buesche87/infinitv) | Active | GPL-3.0 | TV-first focus, compact OSD, centered composition, remote/keyboard navigation, configurable HSL color and card glow | TV, desktop, and mobile screenshots; TV affordances must not become the phone layout |
| [Jamfin](https://github.com/JamsRepos/Jamfin) | Active | MIT | Modular base/complete packages, glass surfaces, configurable color/roundness/blur | Useful module precedent; visual effects need a no-blur performance mode |
| [Jellyfish](https://github.com/n00bcodr/Jellyfish) | Active | NOASSERTION | Palette files, ratings/indicator/icon/logo modules, existing Canopy compatibility and current selector presets | Broad client use; current Canopy integration reloads and stores CSS imports locally |
| [JellyFlix](https://github.com/prayag17/JellyFlix) | Infrequent | Unresolved | Familiar Netflix-style hierarchy, hero/detail emphasis, streaming-library density | Older/fixed-layout assumptions make it inspiration only |
| [JellySkin](https://github.com/prayag17/JellySkin) | Infrequent | GPL-3.0 | Gradient accents, horizontal media row, custom icon system, optional performance stylesheet | External fonts/assets and CSP sensitivity; performance add-on is a good tier precedent |
| [NetFin](https://github.com/ya0903/NetFin) | Active | MIT | Cinematic dark preset, poster-first browsing, metadata clarity, mobile touch-size option | Phone, desktop, and TV examples; brand mimicry must become a neutral Canopy preset |
| [NeutralFin](https://github.com/KartoffelChipss/NeutralFin) | Active | GPL-2.0 | Neutral black/gray adaptation with media-bar compatibility and per-user installation path | Broad ElegantFin lineage; compatibility must use tokens rather than a copied selector set |
| [Ultrachromic](https://github.com/CTalvio/Ultrachromic) | Active | MIT | Strongest modular reference: layout, login, title, input, progress, indicator, hover, palette, rounding, and TV-performance modules | Explicit mobile/TV adaptations; many independently composable imports can conflict without a schema |
| [Monochromic](https://github.com/CTalvio/Monochromic) | Historical | Unresolved | Muted/minimal axis and compact options that informed Ultrachromic | Superseded; retain ideas, not an extra compatibility target |
| [Kaleidochromic](https://github.com/CTalvio/Kaleidochromic) | Historical | Unresolved | Colorful axis that informed Ultrachromic | Superseded |
| [Novachromic](https://github.com/CTalvio/Novachromic) | Historical | Unresolved | Light/alternate chromic axis and modular lineage | Superseded |
| [scyfin](https://github.com/loof2736/scyfin) | Active | GPL-3.0 | Base/options split, static drawer, backdrop navigation, identify-list option, Seafoam/Coral/Snow/OLED palettes | Useful responsive modules; selectors remain web-version coupled |
| [ZestyTheme](https://github.com/stpnwf/ZestyTheme) | Active | MIT | Minimal structure, many simple accent palettes, two login modes | Mobile/tablet support; documented Live TV and music gaps become required Canopy coverage |
| [Zombie](https://github.com/MakD/zombie-release) | Active | Unresolved | Explicit synthesis of public themes, streaming-service color presets, mobile alternative layout, featured bar | API-key/file-mutation patterns are rejected; use only the preset and layout ideas |
| [GlassFin](https://github.com/KBH-Reeper/GlassFin) | Active | Unresolved | Transparent glass hierarchy, responsive states, themeable badges, Media Bar and Enhanced styling | Desktop/mobile claims; unresolved license means no CSS or asset reuse |
| [JellyfinGlassTheme](https://github.com/MadhavKrishanGoswami/JellyfinGlassTheme) | Active | MIT | Apple-inspired glass, responsive typography and plugin-card treatment | Desktop/tablet/mobile examples; locally bundle any allowed type assets |
| [JellyThemes](https://github.com/kingchenc/JellyThemes) | Active | GPL-3.0 | Six dark palette personalities—Obsidian, Solaris, Nebula, Ember, Void, Phantom—with shared glass and easing | Responsive claims; palettes should be data, not duplicated stylesheets |
| [JellyMoon](https://github.com/trple-sss/JellyMoon) | Active | GPL-3.0 | Personal synthesis of Zesty/StrawJelly ideas and colorful detail styling | Treat as visual evidence, not a new architecture |
| [jellygray](https://github.com/pratimes/jellygray) | Infrequent | MIT | Quiet neutral gray treatment extending through plugins, people, player, and dashboard | Older client baseline; good neutral preset reference |
| [DarkFlix](https://github.com/DevilsDesigns/Jellyfin-DarkFlix-Theme) | Infrequent | GPL-3.0 | Dense dark streaming-service composition and red accent hierarchy | Fixed/older assumptions; reject brand assets and brittle dimensions |
| [FossFlix](https://github.com/PaleCache/FossFlix) | Active | GPL-3.0 | Contemporary streaming-style layout with its own visual identity | Validate all breakpoints rather than accepting a desktop screenshot |
| [Dark Field](https://github.com/pointless-existence/jellyfin-dark-field-theme) | Infrequent | GPL-3.0 | Dark transparent green palette | Narrow style reference |
| [Friday Fin](https://github.com/az4if/friday_fin) | Archived | Unresolved | Ultrachromic/Zombie-derived personal combination | Archived and derivative; no direct reuse |
| [Medusa](https://github.com/Arrow420/Medusa) | Active | Unresolved | Modern coverage of home, library, detail, dashboard, player, and subtitles | Unresolved license; use as coverage evidence only |
| [JellyTheme](https://github.com/DanielHalevi/JellyTheme) | Archived | Unresolved | RTL work, revamped player, compact seasons, settings cleanup, Apple TV-like library | Webroot/bundle modification is rejected; RTL and compact-season outcomes are adopted |
| [GNAT / SethStyle](https://github.com/JSethCreates/jellyfin-theme-sethstyle) | Active | MIT | Material Design 3 semantics, nine-token palette, clear action hierarchy, FABs, forms, sliders, placeholders | Existing small-screen fallback removes much of the theme; Canopy must adapt instead |
| [SpookyFin](https://github.com/endoflineservice/SpookyFin---Material-Theme-for-JellyFin) | Active | MIT | Material You, pills/FABs, palette controls, explicit Enhanced tabs/calendar/watchlist/remote/music coverage | Strong Canopy-surface reference; seasonal art remains optional and local |
| [ijelly](https://github.com/safiyu/ijelly) | Active | Unresolved | Apple TV composition, spring motion, cinematic heroes, TV sizing, pill navigation, text-layer isolation from blur | Desktop/Samsung TV focus; phone layout needs separate verification |
| [Apple TV+ theme](https://github.com/mfaizanatiq/jellyfin-appletvplus-theme) | Active | MIT | Modular Apple TV+-style presentation and redistribution-oriented packaging | Convert brand-specific expression into a generic cinematic preset |
| [better-jellyfin-ui](https://github.com/tromoSM/better-jellyfin-ui) | Active | Apache-2.0 | Optional floating header, contrast, hover, border, navigation/logo, and Trickplay modules with user variables | Desktop/mobile; custom CSS is not applied by native TV clients |
| [Jellyfin Better Styles](https://github.com/Tetrax-10/jellyfin-better-styles) | Infrequent | MIT | Stock-preserving polish, better layout, animation, and card hover | Ideal low-disruption preset; still requires current-client verification |
| [finimalism](https://github.com/tedhinklater/finimalism) | Active | GPL-3.0 | Jellyfin 11/12 variants, classic/modded layout, accent/blur/rounding, aspect-ratio test discipline | Good compatibility matrix; avoid maintaining two full CSS forks |
| [alexyle/jellyfin-theme](https://github.com/alexyle/jellyfin-theme) | Active | GPL-3.0 | Current personal theme with a broad aggregate stylesheet | Secondary evidence; evaluate each adopted idea against primary modules |
| [SethStyle-adjacent personal themes](https://github.com/JSethCreates/jellyfin-theme-sethstyle/network/dependents) | Mixed | Mixed | Shows demand for editable Material palettes and compact surfaces | Not a bounded source set; no individual completeness claim |

### Palette systems

| Project | License | Adoptable outcome |
|---|---|---|
| [Catppuccin](https://github.com/catppuccin/jellyfin) | MIT | Four named flavors plus independently selectable accents, represented as semantic palette data |
| [Evergarden](https://github.com/everviolet/jellyfin) | EUPL-1.2 | Seasonal summer/spring/fall/winter palette families without forcing seasonal animation |
| [Dracula](https://github.com/dracula/jellyfin) | MIT | Recognizable, accessible dark palette offered with attribution |
| [theme.park](https://github.com/themepark-dev/theme.park) | MIT | Shared cross-app palette naming and a clean custom-option distribution model |
| [Jellyfish colors](https://github.com/n00bcodr/Jellyfish/tree/main/colors) | NOASSERTION | Backward-compatible migration for Canopy's Aurora, Banana, Coal, Coral, Forest, Grass, Jellyblue, Jellyflix, Jellypurple, Lavender, Midnight, Mint, Ocean, Peach, and Watermelon choices |
| [OLED theme collections](https://github.com/artur0sky/jellyfin-oled-themes) | Verify before reuse | True-black surface tier separated from accent selection |

### Companion systems and targeted adaptations

| Project | Kind | Contribution / decision |
|---|---|---|
| [Jellyfin Seasonals](https://github.com/CodeDevMLH/Jellyfin-Seasonals) | Plugin | Scheduled or manual seasonal themes, per-user toggle, holiday precedence, configurable particles, and TV-safe defaults. Adopt scheduling and bounded effects as optional modules. |
| [Skin Manager](https://github.com/Jellyfin-PG/Skin-Manager) | Archived plugin | Gallery/manager interaction model for Jellyfin 10.11+. Adopt safe curated discovery; do not depend on the archived implementation. |
| [jellyfin-plugin-skin-manager](https://github.com/danieladov/jellyfin-plugin-skin-manager) | Plugin | Install/download workflow. Remote arbitrary CSS remains outside the default safe path. |
| [KefinTweaks](https://github.com/ranaldsgift/KefinTweaks) | UI extension | Existing skin-manager/tweak UX and many Canopy-adjacent surfaces. Theme Studio replaces only appearance configuration, not unrelated feature policy. |
| [Jellyfin Media Bar](https://github.com/MakD/Jellyfin-Media-Bar) | UI extension | Featured-content hero behavior and cross-theme compatibility requirements. |
| [Jellyfin Lucide](https://github.com/KartoffelChipss/Jellyfin-Lucide) | Icon theme | Optional icon family with inherited/current-color semantics and accessible labels. |
| [icon-metadata](https://github.com/Druidblack/jellyfin-icon-metadata) | Icon theme | Provider icon treatment already integrated by Canopy; requires monochrome/multicolor theme contracts. |
| [JellyfinMobileTweaks](https://github.com/Oniicode/JellyfinMobileTweaks) | Mobile patch set | Mobile-specific density, tap-target, wrapping, and navigation failures that a theme-agnostic responsive layer must cover. |
| [Void for Jellyfin](https://github.com/hritwikjohri/Void-for-jellyfin) | Native Android client | Material 3 dynamic color, ambient backgrounds, and truly mobile-native composition. It is inspiration, not a web CSS theme or compatibility target. |
| [NovaUI](https://github.com/Sakaii-Project/NovaUI-theme) | Archived theme/extension | Glass, hover glow, Smart TV clock/greeting, and plugin compatibility. Discord webhook/global-script patterns are rejected. |

### Additional publicly discoverable repositories

The topic/search sweep also found the following smaller, personal, partial, or
special-purpose projects. They remain in the provenance log even when they did
not add a distinct architecture requirement:

- [amirehsan/Jellyfin-CSS](https://github.com/amirehsan/Jellyfin-CSS)
- [JoeSaf/jellyfin-customui](https://github.com/JoeSaf/jellyfin-customui)
- [huttflix](https://github.com/topics/jellyfin-theme)
- [gelee-de-mure](https://github.com/topics/jellyfin-theme)
- [Jellyfin play-button fixes](https://github.com/topics/jellyfin-theme)
- [Jellyfin custom themes and collections](https://github.com/search?q=jellyfin+themes&type=repositories)
- [Automationsxperts/jellyflix](https://github.com/Automationsxperts/jellyflix)
- [krlsantcard/jellyfin-themes](https://github.com/krlsantcard/jellyfin-themes)
- [mbcooper83/jellyfin-css-darkandgreen](https://github.com/mbcooper83/jellyfin-css-darkandgreen)
- [Red-M/jellyfin_seymour](https://github.com/Red-M/jellyfin_seymour)

Search-result pages are intentionally recorded for repeatability where a small
repository can be renamed or removed. A future inventory refresh must repeat the
same queries and append additions rather than silently rewriting the snapshot.

## Synthesis matrix

| Theme dimension | Strong evidence | Canopy outcome |
|---|---|---|
| Semantic palette | Jellyfin 12, Finity, GNAT, Catppuccin, Ultrachromic | Versioned role-based tokens mapped to `--jf-*`; palette and accent can change independently |
| Light/dark/OLED | Jellyfin built-ins, chromic family, scyfin, Catppuccin | All presets declare supported color schemes; OLED is a surface tier, not a separate implementation |
| Typography | Abyss, Glass themes, Apple-style themes | Local/system font stacks, scale, weight, line height, and reading-width tokens; never blur a text layer |
| Surface/glass | Abyss, Jamfin, GlassFin, JellySkin | Solid, translucent, and glass material tiers; blur automatically reduces for capability/performance preferences |
| Shape/elevation | ElegantFin, GNAT, SpookyFin, Ultrachromic | Independent radius, border, shadow, and focus-ring scales |
| Cards/density | infinitv, Finity, finimalism, NetFin | Poster/backdrop/square ratios, compact/cozy/spacious density, bounded hover/focus actions |
| Navigation | Abyss, Ultrachromic, ijelly, infinitv | Header/sidebar/pill presentations chosen per breakpoint and input mode, with stable destinations |
| Home/hero | Media Bar, Zombie, NetFin, ijelly | Optional accessible hero module with predictable layout reservation and a reduced-data mode |
| Details/seasons | ElegantFin, Flow, JellyTheme, NetFin | Hero/compact detail modes, episode list/grid choice, readable metadata, no fixed 1080p assumptions |
| Player/OSD | infinitv, ElegantFin, Medusa, JellyTheme | Compact/cinematic OSD options that preserve controls, focus order, captions, Trickplay, and Canopy overlays |
| Music/Live TV/books | ElegantFin and documented gaps elsewhere | Explicit required surfaces, never an untested “best effort” |
| Motion | Abyss, JellyThemes, ijelly, JellySkin | Calm/expressive/off profiles with reduced-motion override and bounded transition properties |
| Seasonal/dynamic | Evergarden, Seasonals, dynamic Material clients | Optional palette scheduling and local media-derived accent; no remote assets or unbounded particles |
| Icons | Lucide, metadata icons, GNAT | Optional local icon packs using current color, stable labels, and no semantic meaning conveyed by icon alone |
| Mobile/touch | MobileTweaks, NetFin, ElegantFin | Mobile is a first-class layout profile with safe areas, keyboard, wrapping, tap targets, and orientation checks |
| TV/remote | infinitv, ijelly, ElegantFin | Focus-visible scale/outline, remote-safe navigation, overscan spacing, and low-effects defaults |
| Accessibility/i18n | JellyTheme RTL, Material semantics, official Jellyfin | Contrast and forced-color checks, zoom/reflow, RTL/logical properties, long labels, reduced motion/transparency |
| Performance | JellySkin performance add-on, Ultrachromic TV mode, Seasonals | Automatic effects budget plus user-selectable full/balanced/minimal modes |

## Adopt, adapt, and reject

### Adopt as outcomes

- Semantic palette roles and separately selectable accent, brightness, OLED,
  density, shape, effects, and motion dimensions.
- Curated cohesive presets plus expert-level composable controls.
- Live preview with staged changes, undo, reset, and per-control defaults.
- Multiple card, navigation, details, season, progress, indicator, and login
  presentations without changing their behavior or accessible order.
- Optional seasonal scheduling, local dynamic color, local icon families, and
  performance tiers.
- Explicit coverage of Canopy surfaces and historically neglected music, Live
  TV, books, dashboard, mobile, and TV states.

### Adapt behind stable contracts

- Brand-inspired looks become generic presets such as **Cinematic**, **Studio**,
  **Material**, **Glass**, **Minimal**, and **TV Focus**. Canopy does not ship
  third-party service marks or claim pixel identity.
- Selector-heavy techniques become semantic tokens or small versioned adapters.
- Remote fonts, images, and icon CSS become permitted local/system assets with
  a provenance manifest.
- Daily/seasonal changes operate on a saved palette/preset schedule, not an
  injected `@import` string.

### Reject

- Editing Jellyfin webroot files or generated JavaScript bundles.
- Arbitrary remote scripts, webhooks, API keys in client CSS/JavaScript, or
  executable theme packages.
- Runtime reliance on third-party CDNs for the default experience.
- Copying unresolved-license CSS or assets.
- Fixed-resolution layouts, desktop-only completion, or mobile rules that simply
  turn the theme off.
- Global unversioned selector overrides without ownership, cleanup, tests, or a
  compatibility boundary.
- Theme controls that weaken authentication, elevation, feature policy, privacy,
  player accessibility, or dashboard recovery behavior.

## Refresh procedure

1. Record the date and current commits for Jellyfin Web and awesome-jellyfin.
2. Export the GitHub `jellyfin-theme` topic and repeat the search terms in this
   document.
3. Compare repository URLs, archived states, last pushes, and license metadata.
4. Read new projects without executing third-party code.
5. Append sources and map genuinely new behavior into the synthesis matrix.
6. Open or update a Theme Studio issue for every newly discovered requirement.
