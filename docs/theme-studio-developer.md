# Theme Studio developer guide

Theme Studio is a typed, identity-scoped presentation subsystem with explicit ownership boundaries. This page is an implementation and evidence map; the broader [Developer Guide](developers.md#theme-studio-profile-api) remains the source for endpoint and runtime detail.

The dated research and release contract is versioned in
`research/theme-studio-ecosystem.md`, `research/theme-studio-design-contract.md`,
`research/theme-studio-roadmap.md`, and
`research/theme-studio-verification-matrix.md`. The quality contract requires
all four files, while the documentation gate validates their internal links and
reviewed external-source inventory. TV, tablet-only, and legacy findings in the
ecosystem inventory are research context only; they do not authorize a Theme
Studio activation path.

## Schema and tokens

Schema 2 defines profiles, schedules, accessibility settings, presentation options, player options, and responsive overrides. Server and browser validators reject unknown fields, unsupported enum values, future schemas, oversized documents, credentials, URLs, and executable content. Sparse overrides inherit from a preset; serialization is deterministic and migrations are explicit.

Semantic `--jc-*` variables form the internal token layer. The official Jellyfin bridge maps a bounded subset to Jellyfin Web variables and exact component hooks under one modern-layout root gate. It never takes ownership of Jellyfin's root `data-theme`, navigation, media queries, content order, or feature behavior.

![Canopy preset token bridge rendered on the modern desktop home page](images/theme-studio-home-desktop.png)

![Canopy preset token bridge rendered on the modern phone home page](images/theme-studio-home-phone.png)

## Adapter and component contracts

Adapter and component contracts enumerate supported Jellyfin and Canopy surfaces, selectors, variables, properties, routes, and privacy limits. Fixed adapters cover shell, cards, details, dialogs, player controls, Canopy feature surfaces, operational surfaces, and capability-gated integration surfaces. Generated selectors, DOM reordering, remote assets, behavior overrides, and unbounded per-component style nodes are prohibited.

![Theme Studio adapters applied to the real Jellyfin details page](images/theme-studio-details-desktop.png)

![Theme Studio player adapter applied to the native phone landscape OSD](images/theme-studio-player-phone-landscape.png)

![Canopy component contract fixture on modern desktop](images/theme-studio-canopy-surfaces-desktop.png)

![Canopy component contract fixture on a modern phone](images/theme-studio-canopy-surfaces-phone.png)

## Lifecycle ownership

One authenticated identity generation owns one profile read, the committed and preview layers, capability listeners, dynamic-color work, calendar timeout, and optional advanced layer. Logout, identity transition, configuration replacement, unsupported layout, Dashboard/sign-in recovery, policy disablement, or disposal retires that generation and removes its styles and observers. Stale or lower-revision responses cannot reactivate it.

Preview updates presentation only. It must not query or replace media, navigate, alter playback, move focus, create interval ownership, or modify feature data. The player acceptance test proves the original media element, source, current time, paused state, focus, and native controls survive repeated preview changes.

## Persistence and identity

Typed profiles, advanced declarations, and migration records have separate files and contracts. Profile writes are revisioned and isolated by normalized Jellyfin user identity. Import remains staged until an explicit apply. Advanced declarations never enter profile import/export. Migration cleanup is exact, acknowledgement-gated, identity-scoped, and reversible only from a bounded canonical record.

No server/user identity, provider secret, media identifier, dynamic sample, or revision evidence appears in a portable export. Runtime generations abort in-flight reads and analysis during identity changes.

## Provenance

Every bundled preset and gallery entry records its source influences and licenses. Gallery records are checksummed and contain typed local identifiers only. Documentation images use a GPL-3.0-only repository-generated fixture; [the capture manifest](theme-studio-captures.json) binds every PNG to its source test, exact commit, fixture license, viewport/layout, input mode, locale, color scheme, capability set, preset, state, dimensions, bytes, and SHA-256.

![Theme Studio operational surface contract fixture on desktop](images/theme-studio-operational-surfaces-desktop.png)

![Theme Studio operational surface contract fixture on a phone](images/theme-studio-operational-surfaces-phone.png)

![Theme Studio integration surface contract fixture on desktop](images/theme-studio-integration-surfaces-desktop.png)

![Theme Studio integration surface contract fixture on a phone](images/theme-studio-integration-surfaces-phone.png)

## Extend Theme Studio

### Add a preset

Add its typed catalog record, palette references, provenance and licenses; keep overrides sparse and within the declared cost lattice. Update translation keys, catalog tests, both desktop and phone visual baselines, the quality contract, the two preset contact sheets, and documentation. Do not add a legacy, tablet, or TV activation path. A historical identifier such as Focus's internal `tv-focus` is compatibility data, not layout support.

![Nine-preset desktop baseline contact sheet](images/theme-studio-presets-desktop.png)

![Nine-preset phone baseline contact sheet](images/theme-studio-presets-phone.png)

### Add a token

Define the token in the shared schema, defaults, resolver, serializer, validators, server/browser parity tests, contrast composition, and import/export contract. Map it through the official bridge only when an owned Jellyfin variable or component property needs it. Unknown tokens must continue to fail closed.

### Add a surface

First name its behavior owner and privacy boundary in the relevant surface contract. Use semantic roles and existing DOM; inventory exact selectors and allowed properties, route and capability gates, accessibility states, RTL/reflow behavior, reduced-effects behavior, and unsupported-layout no-op evidence. Add modern desktop and phone portrait/landscape tests as applicable. Theme Studio must not acquire network, permission, mutation, playback, or private-data ownership.

## Test matrix

The blocking test matrix combines server unit/coverage tests, client and script suites, schema and serialization parity, import/security cases, adapter contract guards, bundle/performance budgets, accessibility scans, and live Playwright runs against disposable Jellyfin 12 servers.

Supported release viewports are modern phone portrait (320 × 568 and 390 × 844), modern phone landscape (844 × 390), desktop (1366 × 768), and wide desktop (1920 × 1080). Tablet-only (600 × 960 and 820 × 1180), Jellyfin legacy, and TV markers are tested solely for an exact stock/no-op result and do not produce release screenshots.

![High Contrast desktop accessibility and RTL test evidence](images/theme-studio-accessibility-desktop.png)

![High Contrast phone accessibility and reflow test evidence](images/theme-studio-accessibility-phone.png)

The committed Theme Studio quality contract inventories all nine presets, supported/unsupported layouts, evidence owners, test-only deterministic font installation, screenshot baselines, accessibility coverage, safe CI artifacts, and required workflow jobs. Run `npm run check:theme-studio-quality` whenever those ownership boundaries change.

## Refresh captures

Documentation captures must come from the verified disposable synthetic fixture—never a personal library or an edited mockup.

1. Commit the capture-producing code and documentation so the evidence has an immutable source commit.
2. From a clean branch, run `JC_CAPTURE_THEME_DOCS=1 npm run e2e:local -- --shards 6 --cpus-per-server 2`.
3. Run `npm run generate:theme-studio-docs` to build the deterministic contact sheets and regenerate `docs/theme-studio-captures.json` from the current commit.
4. Review every PNG at full size. Confirm modern desktop/wide and phone portrait/landscape only, synthetic fixtures, stable fonts, useful content, no secrets, and no clipping or overflow.
5. Stage the PNGs and manifest, update the documentation asset budget when the reviewed inventory intentionally changes, then run `npm run check:docs`, `npm run check:theme-studio-docs`, `npm run test:scripts`, and the full required validation matrix.

The manifest checker fails if a Theme Studio PNG is undeclared, its checksum/dimensions differ, its source is missing, its commit is not an ancestor, a required state is absent, its alt text is weak, or its layout is anything other than supported modern desktop/wide or modern phone portrait/landscape.

![Full-effects desktop documentation capture from the verified fixture](images/theme-studio-effects-desktop.png)

![Full-effects phone documentation capture from the verified fixture](images/theme-studio-effects-phone.png)
