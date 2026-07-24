# Theme Studio responsive and visual verification matrix

Tracking: [#382](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/382), [#383](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/383)

This is the minimum evidence matrix. A row may add devices or browsers, but an
implementation issue cannot remove a required class without recording why the
behavior is impossible or outside Jellyfin Web/Canopy's supported boundary.

## Viewport and input classes

| ID | CSS viewport | Primary input | Required orientation / capability | Purpose |
|---|---:|---|---|---|
| P-S | 320 × 568 | touch | portrait, coarse pointer, no hover | Minimum supported phone width, wrapping and overflow |
| P | 390 × 844 | touch | portrait, safe-area emulation | Main phone editor and content baseline |
| P-L | 844 × 390 | touch | landscape, short viewport, safe areas | OSD, hero, dialogs, keyboard avoidance, horizontal navigation |
| T-S | 600 × 960 | touch | portrait | Small tablet and two-column transition |
| T | 820 × 1180 | touch + keyboard | portrait and landscape | Tablet editor/detail composition and hybrid input |
| D | 1440 × 900 | mouse + keyboard | fine pointer, hover | Main desktop baseline |
| D-L | 1920 × 1080 | mouse + keyboard | fine pointer, hover | Dense library, player, dashboard, documentation captures |
| W | 2560 × 1080 | mouse + keyboard | ultrawide | Content max-width, hero cropping, line length, empty side space |
| TV | 1920 × 1080 | remote + keyboard | 10-foot focus, overscan inset, reduced effects | Remote navigation, focus visibility, OSD and grid density |

Phone checks must include a virtual-keyboard-sized visual viewport and an iOS-like
bottom safe-area inset. Tablet/desktop checks include 125% and 200% OS/browser text
scaling where automation can represent it. Real-browser evidence is required for
engine-specific failures that emulation cannot prove.

## Browser/client classes

| Class | Required evidence |
|---|---|
| Chromium current | Full automated matrix and screenshots |
| Firefox current | Core editor/apply/rollback, grid/layout, focus, filters, forced colors where supported |
| WebKit current | Phone/tablet safe areas, sticky actions, backdrop/filter fallback, form controls |
| Jellyfin modern MUI | Theme variables, preferences, dashboard safe space, dialogs/forms, Canopy routes |
| Jellyfin legacy desktop/mobile | Existing class bridge and bounded adapters |
| Jellyfin TV web layout | Focus/remote flow, effects budget, overscan, player OSD |
| Jellyfin 12 / .NET 10 server | API, persistence, configuration, asset, and E2E baseline |

Native clients that do not embed Jellyfin Web are documented as unsupported by
the client theme runtime. They may use server theme-profile APIs in a later native
adapter, but cannot be counted as visually verified in this milestone.

## Core state matrix

Every Theme Studio control is tested in normal, hover (where available), focus,
active, disabled, dirty, saving, saved, validation-error, save-error, conflict,
offline/cancelled, and read/quarantine states. The following flows receive full
viewport coverage:

1. open studio, choose preset, preview, cancel;
2. edit tokens, undo/redo, reset section, apply and reload;
3. change responsive override and cross the relevant viewport boundary;
4. import valid profile, inspect diff, rename, apply;
5. reject malformed/oversized/unknown-version import without changing output;
6. migrate a current Jellyfish palette and preserve a usable fallback;
7. switch user/logout while preview/save/read is pending;
8. disable Theme Studio live and remove every owned style/hook; and
9. change Jellyfin's base theme while Canopy is active.

## Jellyfin surface matrix

| Surface | Required fixture/states | P-S/P | P-L | T | D/D-L | W | TV |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Login/manual login | logo, user image/text fallback, error, keyboard | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| Home | hero on/off, horizontal rows, long titles, progress, no backdrop | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Movie/series details | backdrop/no backdrop, long metadata, actions, cast | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Seasons/episodes | list/grid, specials, long translated title, progress | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Library/search | poster/backdrop/square, filters, empty/loading/error | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Dialogs/forms/preferences | select, slider, switch, textarea, validation, virtual keyboard | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| Video player/OSD | playing, paused, Trickplay, subtitles, short height | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Music | album/artist/playlist/now playing, long track text | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Live TV/guide | guide grid, channel list, current program, focus | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Books/readers | cover/detail/list/reader controls | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| Dashboard | separate admin theme, safe mode, no raw user CSS | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Notifications/action sheets | success/warning/error, stacked, long text | ✓ | ✓ | ✓ | ✓ | — | ✓ |

`—` means no distinct visual claim is needed for that exact combination; it does
not permit an overflow or runtime error when the view is opened there.

## Canopy surface matrix

| Group | Representative interaction | Required viewports |
|---|---|---|
| Enhanced panel/settings/native tabs | open, change tab, dirty control, save conflict, mobile sheet | P-S, P, P-L, T, D, TV |
| Theme Studio | gallery, search, editor, preview, undo, import diff, apply/error | all |
| Spoiler Guard/hidden content | protected card/detail, reveal, hide dialog, admin edit, fail closed | P, P-L, T, D, TV |
| Tags/filler/rating overlays | all corners, multiple tags, hover-hide, long value, stacked overlays | P-S, P, T, D, TV |
| Active streams | badge, panel, cards, progress, message, stop confirm, empty/error | P-S, P-L, T, D |
| Calendar | agenda/list/grid/month, filters/sidebar, touch navigation | P-S, P-L, T, D, W |
| Requests/downloads | tabs, search, poster/list, progress, empty/error | P-S, P-L, T, D |
| Bookmarks | timeline/player dialog/library grid, orphaned item, controls | P-S, P-L, T, D, TV |
| Seerr/discovery | search result, hero, feed row, request states/modal | P-S, P-L, T, D, W, TV |
| Sonarr/Radarr/Bazarr | action sheet, instance switch, releases/rejections, progress | P-S, P-L, T, D |
| Details/reviews/elsewhere/links | expanded/collapsed, external chips, RTL order, empty/error | P-S, P-L, T, D, TV |
| Player enhancements | subtitle editor/output, rating, pause screen, bookmarks, overlays | P, P-L, T, D, W, TV |
| Admin customization/icons | config form, activity/plugin/metadata icons, branding and safe mode | P-S, P-L, T, D |

## Accessibility, localization, and capability permutations

The full Cartesian product would hide gaps behind an impractical test count.
Instead, every baseline viewport runs its primary flow, and the following
pairwise set spans the cross-cutting risks:

| Profile | Viewport | Scheme/preset | Capability / locale |
|---|---|---|---|
| A11Y-1 | P | Canopy light | 200% text, long German labels, reduced motion |
| A11Y-2 | D | High Contrast dark | forced colors, keyboard only |
| A11Y-3 | T | Material light | RTL Arabic, coarse pointer, reduced transparency |
| A11Y-4 | P-L | Cinematic dark | screen-reader semantics, virtual keyboard, safe areas |
| A11Y-5 | W | Minimal system | 400% zoom/reflow test at equivalent narrow CSS viewport |
| A11Y-6 | TV | TV Focus dark | remote only, strong focus, minimal effects |
| PERF-1 | P-S | Glass dark | balanced auto-fallback, low-end CPU/GPU emulation |
| PERF-2 | TV | OLED | minimal effects, no blur/animation |

No preset can suppress the platform's reduced-motion, forced-colors, or focus
requirements. Contrast tests use the final composited colors, including media
scrims and translucent surfaces.

## Visual-regression policy

- Screenshots use deterministic fixtures, locale, time, seed, viewport, device
  scale, font availability, animation clock, and image responses.
- Dynamic content has reserved dimensions and stable substitutes; masks are used
  only for inherently variable text/time, never to hide a layout regression.
- Baselines are reviewed and committed intentionally. A changed screenshot is
  not auto-approved because the pixel count is small.
- Behavior assertions remain authoritative for focus, labels, visibility,
  clipping, overflow, hit targets, and cleanup; image diffs supplement them.
- Phone and desktop baselines are mandatory for every primary preset. Secondary
  palette variants can use token/contrast tests plus a representative contact
  sheet rather than duplicating every surface screenshot.

## Documentation capture manifest

The final capture command emits image files under `docs/images/theme-studio/` and
a manifest with this shape:

```json
{
  "schemaVersion": 1,
  "sourceCommit": "<verified commit>",
  "captures": [
    {
      "path": "docs/images/theme-studio/studio-editor-phone.webp",
      "page": "theme-studio",
      "state": "editing-cinematic",
      "preset": "cinematic",
      "viewport": { "width": 390, "height": 844 },
      "deviceScaleFactor": 1,
      "input": "touch",
      "locale": "en-AU",
      "colorScheme": "dark",
      "reducedMotion": true,
      "forcedColors": false,
      "fixture": "theme-studio-demo-v1"
    }
  ]
}
```

Required documentation outputs:

| Image | Desktop | Mobile | Notes |
|---|:---:|:---:|---|
| Preset overview/contact sheet | ✓ | ✓ | Same preset order and fixture for comparison |
| Gallery/select preset | ✓ | ✓ | Show text descriptions, not color alone |
| Expert editor | ✓ | ✓ | Desktop split view; mobile staged sheet |
| Before/after preview | ✓ | ✓ | Same media fixture and crop |
| Home and details | ✓ | ✓ | Demonstrate responsive composition |
| Player/OSD | ✓ | landscape | Include subtitles/Canopy overlay coexistence |
| Canopy feature surfaces | ✓ | ✓ | At least panel, tags, calendar, request state, and active streams |
| Accessibility/effects | ✓ | ✓ | High contrast and low-effects/OLED examples |
| TV focus | ✓ | not applicable | Visible focus and overscan-safe layout |
| Jellyfish migration | ✓ | ✓ | Old selection to equivalent Theme Studio preset |

All informative images receive concise alt text in documentation. Contact sheets
must remain legible when opened at their native dimensions and have adjacent text
summarizing the differences so the image is not the only source of information.

## Completion evidence template

Every implementation issue records:

```text
Unit/behavioral tests:
Server/API tests:
Modern MUI E2E:
Legacy E2E:
Mobile portrait:
Mobile landscape:
Tablet:
Desktop/ultrawide:
TV/remote:
Accessibility/i18n:
Performance:
Visual baselines:
Documentation images:
Known unsupported boundary:
```
