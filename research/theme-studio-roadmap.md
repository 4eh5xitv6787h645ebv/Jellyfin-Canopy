# Theme Studio implementation roadmap

Project: [themes — Project 8](https://github.com/users/4eh5xitv6787h645ebv/projects/8)

Milestone: [Theme & Skin Studio](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/milestone/76)

Umbrella: [#382](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/382)

All rows are linked sub-issues of #382, assigned to the milestone, present in
Project 8, and labelled `no-stale`. Project status is the authoritative live
state; the waves below describe dependencies, not a promise that independent
work must be serialized.

## Wave 0 — contract

| Issue | Outcome | Exit dependency |
|---|---|---|
| [#383](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/383) | Ecosystem research, official compatibility contract, schema/tokens, surface and responsive matrices, roadmap | Research documents reviewed and docs checks pass |

## Wave 1 — foundation

| Issue | Outcome | Main dependencies |
|---|---|---|
| [#384](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/384) | Versioned per-user `theme.json`, admin policy, validation, migrations, import/export model | #383 |
| [#385](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/385) | Identity-owned runtime, official `--jf-*` bridge, semantic `--jc-*` roles, bounded adapters | #383, then #384 for persistence wiring |
| [#398](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/398) | Shared contract, lifecycle, responsive, visual, accessibility, and performance gates | Starts with the foundation and expands with every slice |

## Wave 2 — product shell

| Issue | Outcome | Main dependencies |
|---|---|---|
| [#386](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/386) | Responsive gallery/editor, staged live preview, undo/reset, profile/import flows | #384, #385 |
| [#387](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/387) | Curated presets, palettes, icons, thumbnails, provenance | #385 |
| [#388](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/388) | Jellyfin shell/navigation/cards/home/details/seasons/dialog/form modules | #385, #387 |
| [#397](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/397) | Jellyfish migration, modern token/version compatibility, and stock/no-op legacy/tablet/TV boundaries | #384, #385, #387 |

## Wave 3 — responsive and experience depth

| Issue | Outcome | Main dependencies |
|---|---|---|
| [#389](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/389) | Modern phone portrait/landscape, touch, safe-area adaptations, and low-end mobile evidence | #385, #388 |
| [#390](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/390) | Player, music, Live TV, and reader surfaces on supported modern phone and desktop/wide browsers; TV layouts stay stock | #385, #388 |
| [#391](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/391) | Bounded effects/motion, dynamic color, seasonal schedules, performance tiers | #384, #385, #387 |
| [#392](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/392) | Accessibility, localization, RTL, zoom, forced colors, high contrast | Cross-cuts #384–#391 and blocks their final acceptance |

Mobile is not isolated to #389. That issue owns reusable modern-phone mechanics
and the complete supported device sweep; every UI issue still has its own phone
portrait/landscape and desktop/wide acceptance. Legacy, tablet-only, and TV
markers require stock/no-op evidence, not themed implementations.

## Wave 4 — every Canopy surface

| Issue | Outcome | Main dependencies |
|---|---|---|
| [#393](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/393) | Enhanced panels/tabs, protection/hidden content, tags, warnings, ratings, and overlays | #385 and component-role contract |
| [#394](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/394) | Active streams, calendar, requests/downloads, bookmarks | #385 and component-role contract |
| [#395](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/395) | Discovery, Seerr, ARR, reviews, Elsewhere, and external links | #385 and component-role contract |
| [#396](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/396) | Safe profile sharing, curated gallery foundation, separately gated raw snippets | #384, #386, #387 |

The grouping is about review size and fixture reuse. If implementation reveals a
surface that cannot be reviewed safely within one row, create a narrower linked
sub-issue immediately and add it to Project 8 rather than silently widening the
pull request.

## Wave 5 — proof and handoff

| Issue | Outcome | Main dependencies |
|---|---|---|
| [#399](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/399) | User/admin/developer docs and verified mobile/desktop image set | Verified implementations plus capture infrastructure |
| [#400](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/400) | Real-browser matrix and final security/privacy/performance/accessibility/provenance audit | All implementation and docs issues |

## Program completion rule

#382 remains open until all child outcomes are complete, the release audit has no
untracked material finding, and the verified changes are reachable from the
writable repository's default branch. Closing an issue requires evidence in its
completion template; a passing desktop screenshot cannot substitute for mobile,
behavioral, accessibility, or lifecycle proof.

Merge, deployment, and release remain separately authorized actions even after
the technical evidence is green.
