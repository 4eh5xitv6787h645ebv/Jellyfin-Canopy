# Theme Studio design contract

Project: [Jellyfin Canopy — themes](https://github.com/users/4eh5xitv6787h645ebv/projects/8)

Parent: [#382](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/382)

Research issue: [#383](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/383)

Baseline: Jellyfin Canopy [`b66ea64`](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/tree/b66ea646bd1cd6d371248ce737e7f61439b9b44f)

## User outcome

An administrator can enable Theme Studio and choose safe server defaults. Each
authenticated user can select a curated preset or build a personal theme through
a responsive editor. Changes preview immediately, can be undone or reset, and
are saved to that user's server-backed configuration only after confirmation.

The same theme expresses itself coherently across supported modern Jellyfin Web
phone portrait/landscape and desktop/wide views, including every enabled Canopy
feature. It adapts to touch and keyboard/mouse input without changing application
behavior or accessible reading/focus order. Legacy, tablet-only, and TV layout
markers are explicit stock/no-op boundaries for this project; their findings are
retained only as research for possible future work.

## Official Jellyfin compatibility boundary

Jellyfin Web 12 is the primary contract. At inspected commit
[`3d7adb5`](https://github.com/jellyfin/jellyfin-web/tree/3d7adb53480f02164041fdd983b3f7abc28d0fd9/src/themes):

- [`theme.ts`](https://github.com/jellyfin/jellyfin-web/blob/3d7adb53480f02164041fdd983b3f7abc28d0fd9/src/themes/_base/theme.ts)
  creates a Material UI theme with CSS variables, the `jf` prefix, and the
  `[data-theme="%s"]` color-scheme selector.
- [`_palette.scss`](https://github.com/jellyfin/jellyfin-web/blob/3d7adb53480f02164041fdd983b3f7abc28d0fd9/src/themes/_base/_palette.scss)
  and [`_theme.scss`](https://github.com/jellyfin/jellyfin-web/blob/3d7adb53480f02164041fdd983b3f7abc28d0fd9/src/themes/_base/_theme.scss)
  bridge `--jf-*` roles into both modern MUI and legacy Jellyfin surfaces.
- [`themeStorageManager.ts`](https://github.com/jellyfin/jellyfin-web/blob/3d7adb53480f02164041fdd983b3f7abc28d0fd9/src/themes/themeStorageManager.ts)
  owns the root `data-theme` value and theme-change notification.
- [`index.ts`](https://github.com/jellyfin/jellyfin-web/blob/3d7adb53480f02164041fdd983b3f7abc28d0fd9/src/themes/index.ts)
  exposes the dark, light, Apple TV, Blue Radiance, Purple Haze, and WMC built-ins.
- [`DisplayPreferences.tsx`](https://github.com/jellyfin/jellyfin-web/blob/3d7adb53480f02164041fdd983b3f7abc28d0fd9/src/apps/modern/features/preferences/components/DisplayPreferences.tsx)
  keeps user theme, custom CSS, animations, and layout preferences in Jellyfin's
  display model.

Canopy must therefore:

1. select a compatible Jellyfin base scheme and map Canopy semantic roles onto
   supported `--jf-*` variables;
2. observe `data-theme`, Jellyfin's theme-change event, identity changes,
   navigation, and Canopy config generations through one lifecycle owner;
3. use small, named, versioned adapters only for a surface that cannot be
   expressed through official roles; and
4. fail back to the selected Jellyfin theme by removing all Canopy-owned style,
   attributes, classes, listeners, observers, requests, and cached identity data.

The core bridge includes, at minimum, background/default/paper, text
primary/secondary/disabled, primary/main/light/dark/contrast, error, divider,
action active/hover/selected/disabled/focus, AppBar, card radius, and background
image roles. Exact emitted names are guarded against the pinned official source
and updated deliberately when Jellyfin changes them.

### Dashboard safe space

Jellyfin 10.11 intentionally stopped applying user custom CSS to the dashboard so
an administrator retains a recovery UI and private dashboard content is not
accidentally exposed through externally loaded CSS. The official discussion is
[jellyfin-web #7220](https://github.com/jellyfin/jellyfin-web/issues/7220).

Theme Studio preserves that boundary:

- user raw snippets never apply to the dashboard;
- curated Canopy dashboard tokens are bounded and separately enabled by an
  administrator;
- an independent dashboard base-theme setting remains available; and
- safe mode can disable every Canopy dashboard adapter without reading a user's
  custom theme.

## Current Canopy baseline

At the baseline commit:

- `theme-selector.ts` offers Default plus fifteen Jellyfish palette files,
  stores an `@import` in browser local storage, mirrors a Jellyfish compatibility
  key, and reloads the page after selection;
- `theme-selector.feature.ts` correctly uses an identity-owned feature scope and
  bounded lifecycle, but the UI is injected into a legacy preference selector;
- `themer.ts` detects Jellyfish, ElegantFin, or Zesty variables and derives a
  small panel palette; and
- `AssetCacheManifest` mirrors Jellyfish theme CSS locally, with a kill switch
  that can fall back to the upstream CDN.

This is a migration input, not the Theme Studio architecture. Existing Jellyfish
choices must resolve to equivalent versioned presets on first use. Theme Studio
must not persist CSS imports, require a reload, depend on Jellyfish's boot code,
or detect its own active theme by probing third-party variables.

## Architecture

```text
admin policy + built-in presets + per-user theme.json
                         │
                         ▼
             validated ThemeDocument v1
                         │
                  resolve + normalize
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
 official --jf bridge  Canopy tokens  bounded adapters
        │                │                │
        └────────────────┼────────────────┘
                         ▼
          one identity-owned style layer
                         │
             data-jc-theme-* attributes
                         │
   modern MUI phone/desktop + Canopy surfaces
```

Before any Theme Studio layer or root attribute is installed, the runtime proves
that the host is a supported modern phone or desktop/wide layout. A legacy,
tablet-only, or TV marker makes activation a no-op and synchronously removes any
previously owned presentation.

The runtime is an import-pure client feature. Importing its entry performs no
DOM reads/writes, storage reads, subscriptions, or network activity. Activation
requires an authenticated identity and the administrator master switch. One
feature scope owns:

- the preview and committed style layers;
- root `data-jc-theme-*` attributes;
- theme/identity/navigation/config subscriptions;
- media-query listeners for color scheme, contrast, motion, transparency,
  pointer, hover, and viewport changes;
- per-user configuration requests and abort controllers; and
- bounded caches derived only from the current identity and schema revision.

Preview is a second, higher-priority Canopy-owned style layer. Cancel removes it
synchronously. Apply validates and persists the complete document using the
existing optimistic-revision protocol, then promotes the acknowledged document.
Identity change, logout, feature disable, or read failure removes preview and
committed user layers before another identity can render.

## Persistence and schema

Theme state belongs in a dedicated per-user `theme.json`, not extension data in
the already crowded `settings.json`. The file uses Canopy's complete-payload,
optimistic-concurrency model, evidence endpoint, atomic write, last-known-good,
quarantine, authorization, and identity ownership rules.

Initial bounds:

- serialized size: 128 KiB, below the general 1 MiB user-file ceiling;
- named profiles: 24;
- profile name: 80 Unicode scalar values after trimming;
- token overrides: only schema-enumerated keys, one value per key;
- schedules: 32 ordered entries;
- no URLs, HTML, JavaScript, CSS `@import`, `url()`, or free-form selectors in
  the typed document; and
- unknown fields retained only through a separately bounded extension envelope
  and ignored by the resolver until their schema version is supported.

Conceptual wire shape:

```json
{
  "Revision": 4,
  "SchemaVersion": 1,
  "ActiveProfileId": "my-cinema",
  "Profiles": [
    {
      "Id": "my-cinema",
      "Name": "My cinema",
      "BasePreset": "cinematic",
      "Palette": "canopy-night",
      "Accent": "violet",
      "Mode": "system",
      "Tokens": {
        "shape.radiusScale": "rounded",
        "layout.density": "cozy",
        "effects.material": "glass"
      },
      "Responsive": {
        "phone": { "layout.navigation": "bottom" },
        "desktop": { "layout.navigation": "header" }
      },
      "Accessibility": {
        "motion": "system",
        "contrast": "system",
        "transparency": "system"
      }
    }
  ],
  "Schedule": [],
  "LegacyMigration": {
    "JellyfishTheme": "Ocean",
    "Completed": true
  }
}
```

The actual server and TypeScript models use explicit properties and validated
enums. Dictionary-shaped token overrides are accepted only after checking each
key against the schema and parsing its value into the declared type. No token
value is interpolated into CSS without a type-specific serializer.

### Migration rules

1. Missing `theme.json` creates a default inheriting the administrator's preset.
2. A known Canopy/Jellyfish selection maps to a bundled palette/preset ID and is
   recorded once in `LegacyMigration`.
3. Unknown or malformed legacy imports are not executed; Canopy stays on the
   Jellyfin base theme and reports a local, non-sensitive migration notice.
4. Schema migrations are pure, ordered, idempotent, and tested from every
   released version. The original file remains recoverable through the existing
   atomic backup/quarantine mechanism.
5. Export omits server identity, user identity, revision evidence, secrets, and
   migration diagnostics. Import creates a staged preview and never overwrites
   a profile without explicit confirmation.

## Token taxonomy

Token names are stable product roles, not DOM selectors or colors disguised as
component names. Each token descriptor declares type, default, allowed range or
enum, inheritance, affected surfaces, responsive capability, and whether it is
safe on the dashboard.

| Namespace | Representative roles |
|---|---|
| `color.*` | canvas, surface, elevated, overlay, text, textMuted, primary, onPrimary, secondary, positive, caution, negative, info, divider, focus |
| `type.*` | familyUi, familyDisplay, familyReading, scale, weight, lineHeight, tracking, maxReadingWidth |
| `shape.*` | radiusScale, cardRadius, controlRadius, dialogRadius, avatarShape, borderWidth |
| `elevation.*` | surfaceShadow, cardShadow, dialogShadow, focusRing, glowIntensity |
| `space.*` | scale, pageGutter, sectionGap, cardGap, controlGap, safeAreaMode |
| `layout.*` | density, maxContentWidth, navigation, homeHero, details, seasons, cardActions, posterRatio, castShape |
| `effects.*` | level, material, blur, saturation, backdropOpacity, imageTreatment, noise, glow |
| `motion.*` | profile, durationScale, easing, hoverLift, pageTransition, stagger |
| `progress.*` | position, thickness, watchedIndicator, unwatchedIndicator, playedTreatment |
| `player.*` | osdDensity, controlMaterial, subtitleBackdrop, pauseScreenMaterial, trickplayShape |
| `icon.*` | family, weight, sizeScale, multicolorMetadata |
| `accessibility.*` | contrast, motion, transparency, focusEmphasis, underlineLinks, textScale |

Supported breakpoints are named capabilities—`phone`, `desktop`, and `wide`—
rather than user-entered pixel values. The runtime resolves input mode and
available space together, so a touch-enabled laptop is not forced into the
phone layout. Legacy, tablet-only, and TV layout markers do not resolve a Theme
Studio profile and retain stock Jellyfin presentation.

## Preset model

Presets are immutable, versioned data shipped with Canopy. A saved profile
references a preset and stores only differences, so bug fixes and new surface
coverage can flow forward while a user can freeze a preset version when exact
appearance matters.

Initial cohesive presets:

| Preset | Intended character | Main research lineage |
|---|---|---|
| Canopy | Balanced default, clear hierarchy, restrained depth | Official Jellyfin, Better Styles, ElegantFin |
| Minimal | Stock-respecting, dense, low motion/effects | Better Styles, finimalism, Monochromic |
| Cinematic | Backdrop/hero emphasis and immersive detail pages | NetFin, Flow, Media Bar, ijelly |
| Glass | Layered translucent material with automatic capability fallback | Abyss, Jamfin, GlassFin, JellySkin |
| Material | Semantic Material 3 surfaces, pills, FAB/action hierarchy | GNAT, SpookyFin, dynamic-color clients |
| Studio | Polished neutral dark/light production UI | ElegantFin, NeutralFin, jellygray |
| Focus (internal ID `tv-focus`) | Strong visible focus, calm geometry, and compact controls for supported modern keyboard/touch layouts | infinitv and ijelly focus ideas, adapted without TV-layout styling |
| OLED | True-black low-effects surface profile | scyfin and OLED collections |
| High Contrast | Explicit borders/focus/text separation | Official roles and accessibility requirements |

Palette families—Canopy, Catppuccin-inspired/attributed where licensing permits,
Dracula-attributed, seasonal, neutral, vivid, and migrated Jellyfish choices—are
orthogonal to layout presets. A palette must pass light/dark contrast tests
before it is exposed as supported.

## Studio interaction contract

The editor uses a desktop split view when space permits and a mobile staged flow
on small screens. Both operate on the same form model and offer:

- preset gallery with text descriptions and local preview thumbnails;
- search by token/purpose and beginner/expert modes;
- visible dirty state, undo/redo, reset section/profile/all, and before/after;
- palette, typography, shape, density, navigation, cards, details, player,
  effects, motion, icons, accessibility, and responsive overrides;
- keyboard navigation, correctly associated labels/descriptions/errors, and no
  color-only state;
- debounced, frame-coalesced preview updates with no network write per control;
- explicit Apply and Cancel; and
- import/export with validation results and a diff before acceptance.

Phone requirements include a non-obscuring preview toggle, bottom-sheet controls
that avoid the virtual keyboard, sticky Apply/Cancel above safe-area insets,
44-by-44 CSS-pixel targets, and no horizontal page scroll at 320 CSS pixels.

## Canopy compatibility contract

Theme Studio exposes `--jc-*` semantic variables and stable
`data-jc-theme-surface`/`data-jc-theme-component` hooks. Existing Canopy features
must consume these roles rather than hard-coded colors or trying to identify a
third-party theme. Feature enablement, authorization, and business state remain
their existing owners' responsibility.

| Canopy surface group | Required themed states |
|---|---|
| Enhanced launcher, native tabs, settings panel | rest/hover/focus/selected/dirty/error/loading; desktop dialog and mobile full-height sheet |
| Spoiler Guard and hidden content | blurred/protected/reveal, hide actions, confirmation, admin editor, fail-closed state |
| Card tags and filler warnings | all positions, long values, overlaps, focus/hover visibility, spoiler interaction |
| Active streams | header badge, panel, posters, progress, transcode/direct badges, forms, destructive confirmation, empty/error |
| Calendar, requests/downloads, bookmarks | list/grid/agenda/month, filters, navigation, progress, empty/error/loading, phone reflow |
| Seerr discovery/search/details | available/requested/pending/declined/error, hero/row/modal, permission-specific actions |
| Sonarr/Radarr/Bazarr | links, search action sheet, release list, rejection reasons, progress and controls |
| Details, reviews, elsewhere, Letterboxd, ratings | metadata, chips, external links, expansion, empty/error and RTL ordering |
| Player enhancements | playback controls, subtitle editor/output, OSD rating, bookmarks, pause screen, long-press/frame overlays |
| Admin/customization | configuration tabs/forms, branding, activity/plugin/metadata icons, diagnostics, safe dashboard mode |

A generated guard inventories stable `jc-*` hooks and requires every owned
surface group to reference only declared semantic roles. Visual E2E covers
representative combinatorial interactions rather than every mathematical token
combination.

## Accessibility and localization

- WCAG contrast is checked for text, icons, focus, controls, status chips, and
  content over images in every supported light/dark palette.
- `prefers-reduced-motion` disables non-essential animation regardless of the
  selected profile; a user may choose an even calmer mode but cannot force
  essential safety feedback to disappear.
- `forced-colors` uses system colors and preserves control/focus boundaries.
- reduced-transparency/high-contrast capability removes blur and supplies solid
  surfaces without collapsing hierarchy.
- Layout uses logical properties, mirrors intentionally in RTL, and is tested
  with Arabic/Hebrew direction plus long German/Finnish-style labels.
- 200% text zoom and 400% browser zoom must reflow without losing actions.
- Images, swatches, and presets have localized text alternatives; decorative
  docs images use empty alt text, informative ones use concise alt text.

## Performance contract

- One generated style layer for committed state and one for preview; no style
  tag or rule per card.
- No per-node computed-style loop. Resolve tokens once per generation, write in
  one batch, and let inheritance carry values.
- Media/palette analysis is optional, local, bounded, cancellable, cached by
  non-user media identity, and never delays first usable paint.
- DOM adapters are route-scoped, mutation-coalesced, bounded, and idempotent.
- Effects expose `full`, `balanced`, and `minimal`; capability preferences can
  only reduce cost.
- Blur, large shadows, filters, background images, and motion are measured on
  representative low-end modern phones plus desktop/wide layouts.
- Runtime and bundle budgets, long-task checks, layout-shift checks, and bounded
  subscription/observer counts are release gates.

## Security and privacy contract

- Every user-file route authenticates, authorizes caller-or-admin access, and
  returns identical missing/inaccessible behavior where disclosure matters.
- Theme values are typed and serialized by allowlist. Visible text uses
  `textContent`/safe component rendering; no theme value reaches `innerHTML`.
- No credentials, user IDs, server URLs, paths, history, or private media data
  appear in exports, logs, analytics, screenshots, or external requests.
- Built-in assets are embedded or served through Canopy's allowlisted local asset
  path. A cache kill switch must not silently turn a bundled Theme Studio asset
  into a remote dependency.
- Raw custom CSS, if delivered as a separate advanced feature, is local-only,
  excluded from the dashboard, prominently risk-labelled, size bounded, and
  never eligible for the curated gallery. It is not part of the typed theme
  document.

## Testing and release evidence

Each implementation slice adds the closest unit/behavioral tests plus the
following cross-cutting evidence before the umbrella closes:

- schema parser, serializer, migration, invalid-value, size/capacity, optimistic
  revision, identity handoff, quarantine, import/export, and defaults tests;
- import-purity, lifecycle, media-query, official-variable bridge, preview/apply/
  cancel/rollback, legacy migration, and feature-disable tests;
- token/selector/provenance/local-asset guards and Canopy surface inventory;
- Playwright across modern phone portrait/landscape and desktop/wide layouts
  with touch, keyboard/mouse, reduced motion, forced colors, RTL, zoom, and long
  labels, plus explicit stock/no-op assertions for legacy, tablet-only, and TV
  markers;
- accessibility scans plus keyboard and screen-reader-oriented assertions;
- screenshot comparisons at stable seeded fixtures, with intentional baseline
  review rather than automatic acceptance;
- performance measurements on balanced/minimal and full-effects profiles; and
- offline documentation build/link validation.

## Documentation image contract

Documentation images are generated only after the corresponding view passes its
behavioral and visual checks. Capture scripts use deterministic demo media or
clearly licensed fixtures, fixed locale/time/seed, hidden personal/server data,
and named viewport/device configuration.

Required final set, generated only from supported modern layouts:

- preset overview contact sheet at desktop and phone widths;
- Theme Studio preset gallery and editor on desktop;
- Theme Studio staged editor and preview on phone portrait;
- phone portrait and phone-landscape responsive examples;
- Canopy home/details/player/feature-surface examples;
- high-contrast, Focus, reduced-effects, and OLED examples; and
- before/after migration from the current Jellyfish selector.

Legacy, tablet-only, and TV screenshots are intentionally excluded: their
release evidence is behavioral proof that Theme Studio installs no layer or
root attributes and leaves stock Jellyfin untouched.

Each docs reference includes meaningful alt text. A machine-readable capture
manifest records source commit, preset/profile, viewport, device scale, locale,
color scheme, motion/contrast settings, fixture, and output path.

## Non-goals

- Reimplementing Jellyfin navigation, media data, player behavior, permissions,
  or Canopy feature policy inside the theme engine.
- Pixel-identical clones of commercial streaming services.
- Native theming of clients that do not embed Jellyfin Web or Canopy's bundle.
- Theme styling for legacy, tablet-only, or TV layout markers; they are guarded
  stock/no-op boundaries and may be proposed as future projects.
- An unmoderated marketplace or automatic execution of downloaded themes.
- Guaranteeing compatibility with arbitrary third-party custom CSS.
- Shipping broad implementation before the tracked research and schema contract
  are reviewed and the issue decomposition is present in Project 8.
