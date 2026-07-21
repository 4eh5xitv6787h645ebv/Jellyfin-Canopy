# Theme Studio user guide

Theme Studio is Canopy's per-user theme system for Jellyfin's **modern desktop/wide and modern phone layouts**. It supplies nine curated presets, typed visual controls, profile scheduling, safe sharing, accessibility choices, and responsive overrides without replacing Jellyfin's navigation or media behavior.

## Compatibility boundary

Theme Studio supports modern desktop/wide, modern phone portrait, and modern phone landscape. Legacy layouts, tablet-only breakpoints, TV layouts, the sign-in page, and logged-out pages stay exactly on Jellyfin's stock theme. They are outside the release image set and receive no Theme Studio activation attribute or style layer. The administrator Dashboard is also a stock recovery surface unless an administrator explicitly enables its limited typed-color policy.

![Contact sheet comparing all nine Theme Studio presets on modern desktop](images/theme-studio-presets-desktop.png)

![Contact sheet comparing all nine Theme Studio presets on a modern phone](images/theme-studio-presets-phone.png)

## Choose and edit a theme

Open the **Enhanced panel**, select **Theme Studio**, and choose a preset. **Beginner mode** exposes the common preset, palette, accent, light/dark mode, presentation, and effects choices. Preview changes first, then choose **Apply** to save the complete profile to the signed-in Jellyfin account. Cancel or reset the draft if you do not want to keep it.

![Theme Studio desktop editor with preset and profile controls](images/theme-studio-editor-desktop.png)

![Theme Studio single-column phone editor with touch controls](images/theme-studio-editor-phone.png)

The same account receives its server-backed profile after signing in on another supported browser. The live result is constrained to presentation: it does not reorder content, change navigation destinations, reveal protected metadata, or take ownership of playback.

![Canopy preset applied to the modern desktop Jellyfin home page](images/theme-studio-home-desktop.png)

![Canopy preset applied to the modern phone Jellyfin home page](images/theme-studio-home-phone.png)

### Presets and effects

The maintained presets are Canopy, Minimal, Cinematic, Glass, Material, Studio, Focus, OLED, and High Contrast. Focus reduces visual competition around media; OLED uses solid near-black surfaces and minimal effects. Their phone versions preserve the same identity while using phone spacing and touch targets.

![Focus preset reducing visual competition on modern desktop](images/theme-studio-focus-desktop.png)

![Focus preset with compact navigation on a modern phone](images/theme-studio-focus-phone.png)

![OLED preset using solid near-black modern desktop surfaces](images/theme-studio-oled-desktop.png)

![OLED preset using solid near-black modern phone surfaces](images/theme-studio-oled-phone.png)

The administrator's maximum effects tier is an upper bound. Full may use bounded glass, backdrop treatment, shadow, motion, and local dynamic color. Balanced caps those costs. Minimal forces solid surfaces and disables blur, glow, shadow, motion, and dynamic color. Browser capabilities and accessibility preferences may reduce the tier further; they never increase it.

![Full effects profile and local dynamic accent on modern desktop](images/theme-studio-effects-desktop.png)

![Full effects profile reflowed for a modern phone](images/theme-studio-effects-phone.png)

### Responsive overrides

Use **responsive overrides** only when a profile needs different density, navigation, card, details, or player presentation on a phone. Inherited values remain linked to the preset. Phone portrait and landscape are both supported, including safe areas, coarse-pointer controls, the software keyboard, short player viewports, and 44 CSS-pixel touch targets. A coarse-pointer desktop remains a desktop; tablet-only sizes remain stock.

![Modern phone portrait media surfaces with responsive profile values](images/theme-studio-phone-portrait.png)

![Modern phone landscape media surfaces with responsive profile values](images/theme-studio-phone-landscape.png)

Details and native playback keep Jellyfin's original content, source, focus, playback position, and controls while Theme Studio changes only their bounded presentation.

![Jellyfin movie details page themed on modern desktop](images/theme-studio-details-desktop.png)

![Paused native Jellyfin player fitting a modern phone landscape viewport](images/theme-studio-player-phone-landscape.png)

## Accessibility and effects

Theme Studio evaluates the composed theme after all overrides. It corrects normal text contrast to at least 4.5:1 and non-text controls to at least 3:1, strengthens the High Contrast preset, honors reduced motion and reduced transparency, supports forced colors, preserves visible keyboard focus, and provides an always-underline-links option. Logical layout and bidirectional fields support RTL and mixed-direction content.

![High Contrast accessibility fixture with RTL and 200 percent text on desktop](images/theme-studio-accessibility-desktop.png)

![High Contrast accessibility fixture reflowed on a modern phone](images/theme-studio-accessibility-phone.png)

Canopy's own settings, tags, ratings, filler notices, hidden-content controls, dialogs, notifications, loading states, and errors consume the same semantic values. Theme styling cannot bypass the permissions or reveal rules owned by those features.

![Canopy feature cards and controls themed on modern desktop](images/theme-studio-canopy-surfaces-desktop.png)

![Canopy feature cards and controls themed on a modern phone](images/theme-studio-canopy-surfaces-phone.png)

## Profiles and schedules

A profile stores a preset plus sparse typed overrides. Create separate profiles for different contexts, then choose one manually or add season and holiday schedules. Schedule priority is holiday before season, then configured priority, then stable identifier. Local and UTC calendar modes are supported, including wrapped year ranges. The runtime reevaluates at civil date changes, browser focus, and visibility changes.

Operational Canopy surfaces continue to own their data, actions, and updates while inheriting the active profile.

![Streams calendar downloads requests and bookmarks themed on desktop](images/theme-studio-operational-surfaces-desktop.png)

![Operational Canopy surfaces reflowed on a modern phone](images/theme-studio-operational-surfaces-phone.png)

## Import and export

**Export JSON** produces a portable typed document containing profiles, supported overrides, accessibility preferences, and optional schedules. It excludes server and user identity, revisions, provider secrets, media identifiers, migration state, dynamic-color samples, and advanced declarations.

**Import JSON** validates the complete document on the authenticated server and stages a bounded change report. Unknown fields, unsupported values or schemas, credentials, HTML, scripts, remote URLs, and CSS are rejected. Name collisions need explicit confirmation, and the import is not saved until you choose **Apply**.

The curated gallery is bundled, checksum-verified, licensed, and usable offline. It contains typed identifiers only—no executable code, remote assets, or third-party stylesheets.

![Typed profile sharing and curated gallery on modern desktop](images/theme-studio-sharing-desktop.png)

![Typed profile sharing and curated gallery on a modern phone](images/theme-studio-sharing-phone.png)

### Expert JSON and local declarations

**Expert JSON** is the validated import/export representation, not a route around the typed schema. If the administrator separately enables advanced local declarations, the editor accepts bounded declaration lists for owned targets only. Selectors, braces, scripts, HTML, `@import`, URLs, remote assets, and fonts are rejected. These declarations stay in a separate per-user server file and never enter a preset, gallery entry, import, or export.

Discovery and external-service surfaces use only public capability booleans. Theme Studio never receives provider URLs, API keys, tokens, or instance records.

![Discovery requests reviews and integration status themed on desktop](images/theme-studio-integration-surfaces-desktop.png)

![Discovery and integration surfaces reflowed on a modern phone](images/theme-studio-integration-surfaces-phone.png)

## Jellyfish migration

When the browser contains one exact recognized Jellyfish color import, Theme Studio identifies its palette and offers a staged preview. It sends only the canonical palette name to Canopy; it never sends or executes stored CSS or a remote URL. Apply must receive the normal revisioned acknowledgement before exact, identity-scoped cleanup occurs.

![Recognized Jellyfish palette migration staged on modern desktop](images/theme-studio-jellyfish-migration-desktop.png)

![Recognized Jellyfish palette migration staged on a modern phone](images/theme-studio-jellyfish-migration-phone.png)

Unknown, mixed, changed, remote, or malformed CSS is unsupported and remains untouched. A successful migration keeps a 30-day canonical rollback record. **Restore compatibility selection** regenerates only those known local values.

## Reset and recovery

- Cancel preview to return to the last applied profile without a server write.
- Reset the current draft to its inherited preset values before applying.
- Use **Reset local declarations** to remove advanced declarations independently of typed profiles.
- If a content page becomes hard to use, open the stock Dashboard recovery surface and disable Theme Studio or advanced declarations.
- Restore a recognized Jellyfish compatibility selection during its rollback window when needed.
- If the profile changed elsewhere, reload the current server revision and reapply your intended change; Canopy does not silently overwrite a conflict.

For policy and deployment controls, continue with the [Theme Studio administrator guide](theme-studio-admin.md). For the full customization reference, see [Customization](customization.md#theme-studio).
