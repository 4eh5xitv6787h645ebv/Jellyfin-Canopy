# Theme Studio administrator guide

This guide covers server policy, safe recovery, privacy, and rollback for Theme Studio. End-user editing instructions are in the [Theme Studio user guide](theme-studio.md); detailed setting descriptions remain in [Customization](customization.md#enable-it-as-an-administrator).

## Enablement and defaults

Open **Dashboard → Plugins → Jellyfin Canopy → Extras → Theme Studio**. Theme Studio is disabled by default. Enabling it makes the per-user editor and runtime available only on modern desktop/wide and modern phone layouts.

Choose the default preset and palette before onboarding users. They seed a new user's first profile; later default changes do not overwrite existing profiles. Select the maximum effects tier as an upper bound for materials, backdrop treatment, shadows, motion, and dynamic color. Clients can lower that cost based on accessibility or capability, never raise it.

![Theme Studio administrator and profile controls in the desktop editor](images/theme-studio-editor-desktop.png)

## Dashboard safe mode

The administrator Dashboard is the primary recovery surface. It remains stock by default, with no presentation modules, migration preview, or advanced declarations. **Apply curated Theme Studio tokens to the administrator dashboard** optionally enables bounded typed colors and focus treatment there, but still excludes presentation modules and raw declarations. Sign-in, logged-out, legacy, tablet-only, and TV surfaces always stay stock.

If a user reports an unreadable content page, sign in as an administrator, open the Dashboard, disable the advanced declaration policy or Theme Studio, save, and have the user reload. Disabling presentation removes its style layers; it does not delete profiles.

## Allowed capabilities

Review these policies before enabling the feature:

| Policy | Safe default and effect |
|---|---|
| Typed profile import | On; validates the whole document, stages a diff, and rejects unknown or executable content. |
| Local media-derived color | On; analyzes a bounded same-origin image in memory and never stores the media identifier, pixels, or derived cache. |
| Seasonal schedules | On; lets users activate server-backed profiles by local or UTC calendar date. |
| Effects maximum | Full; cap at Balanced or Minimal for lower-power environments. |
| Advanced local declarations | Off; separately enables bounded declarations for owned targets. |
| Dashboard typed colors | Off; opt in only after retaining an alternate administrator session or recovery route. |

Provider enablement is separate. Theme Studio receives only public capability booleans indicating whether Seerr, Sonarr, Radarr, or Bazarr presentation is relevant; it never receives provider credentials or endpoints.

![Public integration states using typed theme capabilities on desktop](images/theme-studio-integration-surfaces-desktop.png)

![Public integration states using typed theme capabilities on a phone](images/theme-studio-integration-surfaces-phone.png)

## Local assets and gallery

The curated gallery ships inside the plugin and remains available offline. Each entry is allowlisted, names its provenance and licenses, and has a bundled SHA-256 checksum verified before it changes a draft. It cannot load a remote asset, stylesheet, font, script, or URL.

Dynamic color accepts only a same-origin Jellyfin primary or backdrop image, streams at most 2 MiB, decodes to a bounded sample, and keeps a small in-memory cache. It does not persist or log item IDs, candidate paths, pixels, or derived colors. Server branding and unrelated Jellyfin custom CSS are not imported, rewritten, or removed.

![Checksum-verified local Theme Studio gallery on desktop](images/theme-studio-sharing-desktop.png)

![Checksum-verified local Theme Studio gallery on a phone](images/theme-studio-sharing-phone.png)

## Raw CSS risk boundary

Advanced declarations are deliberately separate from typed profiles and disabled by default. Canopy owns the selector and accepts only bounded declarations for theme variables, cards, details, dialogs, or player controls. It rejects selectors, braces, `@import`, generated content, scripts, HTML, URLs, data/blob/file resources, and font imports. It applies declarations only to signed-in modern phone and modern desktop/wide content under standard contrast.

High Contrast, forced colors, Dashboard recovery, sign-in, tablet-only, legacy, and TV remain outside this module. Disable the policy to remove the advanced style layer without modifying the typed profile, or direct the user to **Reset local declarations**.

## Privacy boundary

Profiles are isolated per authenticated Jellyfin user and protected by the caller-or-administrator ownership rule. Exports exclude user/server identity, revision evidence, migration state, provider configuration, secrets, media identifiers, dynamic samples, and local advanced declarations. Imports reject credentials, remote URLs, executable content, and unsupported fields.

Screenshots in these guides use the repository-generated Jellyfin 12 synthetic fixture. They contain generated color bars, gradients, synthetic metadata, and same-origin test assets—no personal library data or third-party artwork. The machine-readable [capture manifest](theme-studio-captures.json) records the fixture license, source test, commit, viewport, input, locale, scheme, capabilities, preset, state, dimensions, byte size, and checksum for every image.

## Troubleshooting

| Symptom | Check |
|---|---|
| Editor is absent | Confirm Theme Studio is enabled and the user is signed in on a supported modern desktop/wide or phone layout. |
| Theme does not activate | Check the profile is applied, the page is not Dashboard/sign-in, and the browser is not using legacy, tablet-only, or TV layout. |
| Effects look simpler | Check the administrator cap, reduced-motion/transparency preferences, forced colors, backdrop-filter support, and low-power phone classification. |
| Import is rejected | Read the bounded diagnostics; remove unknown fields, secrets, CSS, URLs, executable content, or a future schema. |
| Apply reports a conflict | Reload the current server revision, recreate the intended draft, and apply again. |
| Other custom CSS conflicts | Remove or narrow the unrelated broad rule; Theme Studio does not take ownership of it. |
| Page is difficult to operate | Use Dashboard safe mode, disable the advanced policy or Theme Studio, and reload. |

![High Contrast desktop fixture used to verify recovery-safe semantics](images/theme-studio-accessibility-desktop.png)

![High Contrast phone fixture used to verify touch and reflow behavior](images/theme-studio-accessibility-phone.png)

## Rollback

Disabling Theme Studio is the fastest presentation rollback: the runtime removes committed and preview layers while preserving server-backed profiles. Lowering the effects maximum is a reversible performance rollback. Disabling advanced declarations removes only their separate style layer. Resetting local declarations deletes that user's declaration document, so confirm the intended account first.

For recognized Jellyfish migrations, **Restore compatibility selection** is available for 30 days and reconstructs only the acknowledged canonical palette/random-selection values. Unknown or changed custom CSS was never cleaned and is not part of this rollback. Retain normal backups of the Jellyfin configuration directory before bulk account or plugin maintenance.

![Recognized Jellyfish rollback controls on modern desktop](images/theme-studio-jellyfish-migration-desktop.png)

![Recognized Jellyfish rollback controls on a modern phone](images/theme-studio-jellyfish-migration-phone.png)
