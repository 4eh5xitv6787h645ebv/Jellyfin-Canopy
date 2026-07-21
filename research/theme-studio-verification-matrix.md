# Theme Studio responsive and visual verification matrix

Tracking: [#382](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/382), [#383](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/383)

Snapshot: **2026-07-21 modern-layout scope reconciliation**

This is the minimum evidence matrix for Project 8. Theme Studio presentation is
supported only on modern Jellyfin Web phone portrait/landscape and desktop/wide
browser layouts. Legacy, tablet-only, and TV markers are explicit stock/no-op
boundaries: research about those layouts may inform future work, but this project
must not install a Theme Studio layer or root attributes on them.

## Supported viewport and input classes

| ID | CSS viewport | Primary input | Required capability | Purpose |
|---|---:|---|---|---|
| P-S | 320 × 568 | touch | portrait, coarse pointer, no hover | Minimum phone width, wrapping, targets, and overflow |
| P | 390 × 844 | touch | portrait, safe-area emulation | Main phone editor and content baseline |
| P-L | 844 × 390 | touch | landscape, short viewport, safe areas | OSD, heroes, dialogs, keyboard avoidance, and horizontal navigation |
| D-T | 1366 × 768 | touch + keyboard | modern desktop, hybrid input | Proves a coarse pointer alone does not select the phone layout |
| D | 1440 × 900 | mouse + keyboard | modern desktop, fine pointer, hover | Main desktop and documentation baseline |
| W | 1920 × 1080 | mouse + keyboard | modern wide browser | Dense content, max width, hero crop, and bounded line length |

Phone checks include a virtual-keyboard-sized visual viewport and an iOS-like
bottom safe-area inset. Desktop checks include keyboard-only navigation and
touch-enabled desktop. Zoom/reflow checks alter the effective CSS viewport but
do not reclassify unsupported tablet-only layouts as supported.

## Required stock/no-op classes

| ID | Representative evidence | Required result |
|---|---|---|
| T-S | 600 × 960 tablet-only marker | No Theme Studio style layer, root attribute, preview, migration cleanup, or surface adapter |
| T | 820 × 1180 tablet-only marker | Same stock/no-op result across portrait and landscape |
| LEGACY | Jellyfin legacy layout marker | Existing Jellyfin presentation remains untouched |
| TV | Jellyfin TV layout marker | Stock Jellyfin TV presentation remains untouched; no TV/remote theming in Project 8 |

Changing viewport width alone is not enough to prove a class. Tests set the
relevant Jellyfin layout marker/capability and assert both absence of Theme
Studio ownership and preservation of stock geometry/state.

## Browser and client classes

| Class | Required evidence |
|---|---|
| Chromium current | Full required E2E inventory, behavior assertions, and reviewed pixel baselines |
| Firefox current | All 28 cross-browser Theme Studio tests with structural and behavioral assertions |
| WebKit current | All 28 cross-browser Theme Studio tests, including safe-area, filter fallback, dynamic color, and forms |
| Jellyfin 12 modern MUI | Official variables, preferences, dashboard safe space, dialogs/forms, Canopy routes, phone and desktop/wide |
| Jellyfin 12 unsupported markers | Explicit stock/no-op checks for legacy, tablet-only, and TV |
| Jellyfin 12 / .NET 10 server | API, persistence, configuration, local assets, and dockerized E2E baseline |

Native clients that do not embed the supported modern Jellyfin Web/Canopy bundle
are documented as unsupported by the client theme runtime. They cannot be
counted as visually verified in this milestone.

## Core state matrix

Every Theme Studio control is tested where applicable in normal, hover, focus,
active, disabled, dirty, saving, saved, validation-error, save-error, conflict,
offline/cancelled, and read/quarantine states. These flows receive supported
phone and desktop/wide evidence:

1. open Studio, choose a preset, preview, and cancel;
2. edit tokens, undo/redo, reset section, apply, and reload;
3. change a responsive override and cross the supported phone/desktop boundary;
4. import a valid profile, inspect its diff, resolve a collision, and apply;
5. reject malformed, oversized, or unknown-version input without changing output;
6. migrate a current Jellyfish palette and preserve a usable rollback;
7. switch identity or log out while preview/save/read is pending;
8. disable Theme Studio live and remove every owned style/hook; and
9. change Jellyfin's base theme while Canopy is active.

The corresponding unsupported-marker flow proves that preview, migration,
effects, and surface adapters do not activate.

## Jellyfin surface matrix

| Surface | Required fixture/states | P-S/P | P-L | D/D-T | W | Unsupported no-op |
|---|---|:---:|:---:|:---:|:---:|:---:|
| Login/manual login | logo, user fallback, error, keyboard | ✓ | ✓ | ✓ | — | ✓ |
| Home | hero on/off, rows, long titles, progress, no backdrop | ✓ | ✓ | ✓ | ✓ | ✓ |
| Movie/series details | backdrop/no backdrop, long metadata, actions, cast | ✓ | ✓ | ✓ | ✓ | ✓ |
| Seasons/episodes | list/grid, specials, translated title, progress | ✓ | ✓ | ✓ | ✓ | ✓ |
| Library/search | poster/backdrop/square, filters, empty/loading/error | ✓ | ✓ | ✓ | ✓ | ✓ |
| Dialogs/forms/preferences | select, slider, switch, textarea, validation, virtual keyboard | ✓ | ✓ | ✓ | — | ✓ |
| Video player/OSD | playing, paused, Trickplay, subtitles, short height | ✓ | ✓ | ✓ | ✓ | ✓ |
| Music | album/artist/playlist/now playing, long track text | ✓ | ✓ | ✓ | ✓ | ✓ |
| Live TV/guide content | guide grid, channel list, program state, focus | ✓ | ✓ | ✓ | ✓ | ✓ |
| Books/readers | cover/detail/list/reader controls | ✓ | ✓ | ✓ | — | ✓ |
| Dashboard | separate admin theme, safe mode, no raw user CSS | ✓ | ✓ | ✓ | ✓ | ✓ |
| Notifications/action sheets | success/warning/error, stacked, long text | ✓ | ✓ | ✓ | — | ✓ |

A dash means no distinct release screenshot is required for that exact
combination; it never permits overflow, runtime errors, or behavior changes.

## Canopy surface matrix

| Group | Representative interaction | Required supported views |
|---|---|---|
| Enhanced panel/settings/native tabs | tab changes, dirty control, save conflict, mobile sheet | P-S, P, P-L, D, W |
| Theme Studio | gallery, search, editor, preview, undo, import diff, apply/error | P-S, P, P-L, D, W |
| Spoiler Guard/hidden content | protected card/detail, reveal, hide dialog, admin edit, fail closed | P, P-L, D, W |
| Tags/filler/rating overlays | all corners, multiple tags, hover-hide, long values | P-S, P, P-L, D |
| Active streams | badge, panel, cards, progress, message, stop confirm, empty/error | P-S, P-L, D, W |
| Calendar | agenda/list/grid/month, filters/sidebar, touch navigation | P-S, P-L, D, W |
| Requests/downloads | tabs, search, poster/list, progress, empty/error | P-S, P-L, D, W |
| Bookmarks | timeline/player dialog/library grid, orphaned item, controls | P-S, P-L, D, W |
| Seerr/discovery | search result, hero, feed row, request states/modal | P-S, P-L, D, W |
| Sonarr/Radarr/Bazarr | action sheet, instance switch, releases/rejections, progress | P-S, P-L, D, W |
| Details/reviews/elsewhere/links | expansion, external chips, RTL order, empty/error | P-S, P-L, D, W |
| Player enhancements | subtitle output, rating, pause screen, bookmarks, overlays | P, P-L, D, W |
| Admin customization/icons | config form, activity/plugin/metadata icons, safe mode | P-S, P-L, D, W |

Each group also has an applicable legacy/tablet-only/TV stock/no-op assertion.
Unsupported layouts are not listed as themed viewports.

## Accessibility, localization, and capability permutations

The full Cartesian product would obscure gaps behind an impractical test count.
Every baseline runs its primary flow, and this pairwise set spans cross-cutting
risks:

| Profile | Viewport | Scheme/preset | Capability / locale |
|---|---|---|---|
| A11Y-1 | P | Canopy light | 200% text, long labels, reduced motion |
| A11Y-2 | D | High Contrast dark | forced colors, keyboard only |
| A11Y-3 | D-T | Material light | RTL Arabic/Hebrew, coarse pointer, reduced transparency |
| A11Y-4 | P-L | Cinematic dark | semantics, virtual keyboard, safe areas |
| A11Y-5 | W | Minimal system | 400%-equivalent zoom/reflow |
| A11Y-6 | P | Focus dark | visible focus, touch alternatives, non-color cues |
| PERF-1 | P-S | Glass dark | low-end CPU/GPU emulation and automatic effects fallback |
| PERF-2 | W | OLED | minimal effects, no unnecessary blur or animation |

No preset can suppress reduced-motion, forced-colors, or focus requirements.
Contrast uses final composited colors, including media scrims and translucent
surfaces.

## Visual-regression policy

- Screenshots use deterministic fixtures, locale, time, seed, viewport, font,
  animation clock, and image responses.
- Dynamic content reserves dimensions; masks cover only inherently variable data,
  never layout regressions.
- Chromium owns reviewed pixel baselines. Firefox and WebKit retain the same
  structural/behavioral assertions without pretending engine rasterization is
  pixel-identical.
- Phone and desktop baselines are mandatory for all nine primary presets.
- Behavior assertions remain authoritative for focus, labels, visibility,
  clipping, overflow, hit targets, policy, and cleanup.

## Documentation capture manifest

The final capture process emits supported-layout images under `docs/images/`
and records them in `docs/theme-studio-captures.json`. Each entry records the
source, viewport and layout marker, input, locale, scheme, capabilities, preset,
state, exact capture commit, byte size, SHA-256 digest, and image dimensions. The
manifest also identifies the deterministic synthetic Jellyfin 12 fixture and its
license/privacy boundary.

Required documentation outputs:

| Image | Desktop | Modern phone | Notes |
|---|:---:|:---:|---|
| Nine-preset contact sheet | ✓ | ✓ | Same preset order and deterministic fixture |
| Theme Studio editor | ✓ | ✓ | Desktop split view; phone single-column staged flow |
| Home/details | ✓ | ✓ | Responsive composition and media hierarchy |
| Player/OSD | optional | landscape | Native player plus Canopy overlay coexistence |
| Canopy core/operational/integration surfaces | ✓ | ✓ | Representative enabled feature groups |
| Accessibility, Focus, OLED, effects | ✓ | ✓ | Text alternatives accompany visual differences |
| Jellyfish migration | ✓ | ✓ | Old selection to typed Theme Studio profile |
| Phone portrait/landscape comparison | — | ✓ | Safe areas, short height, and touch reachability |

Legacy, tablet-only, and TV screenshots are not release outputs. Their evidence
is the absence of Theme Studio ownership, checked behaviorally.

Every informative image has useful alt text and adjacent prose. The committed
manifest must match every generated file byte-for-byte and must identify the
verified capture-producing commit.

## Completion evidence template

Every implementation issue records:

```text
Unit/behavioral tests:
Server/API tests:
Modern phone portrait:
Modern phone landscape:
Modern desktop:
Modern wide:
Touch and keyboard/mouse:
Legacy stock/no-op:
Tablet-only stock/no-op:
TV stock/no-op:
Accessibility/i18n:
Performance/security/privacy:
Visual baselines:
Documentation images:
Known unsupported boundary:
Exact commit and CI run:
```
