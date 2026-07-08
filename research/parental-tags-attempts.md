# Tag-based parental controls for Seerr surfaces — research log

**Problem.** Jellyfin user policies support tag-based parental controls
(`BlockedTags` — free-text strings matched against library items' Tags) in
addition to the max parental rating. JE's Seerr parental filtering enforces
only the rating limit, so a user blocked from e.g. "horror" in Jellyfin can
still browse, view, and request horror titles through the Requests page.
Goal: enforce Jellyfin tag blocks on Seerr (and other applicable JE)
surfaces, mapping free-text Jellyfin tags onto TMDB-sourced Seerr content.

**Status legend:** ✅ adopted · 🟡 partial · ❌ rejected · 🔬 under test

---

## Ground truth (live seerr-dev probe, 2026-07-08 12:47)

- **Discover/search LIST items** carry only `genreIds` (numeric TMDB ids) —
  no keywords, no genre names, no certifications.
- **DETAIL responses** (`/movie/{id}`, `/tv/{id}`) carry `keywords[]` (names,
  e.g. "possession", "self-harm"), `genres[]` (names, e.g. "Horror"),
  `releases`/`contentRatings`.
- ⇒ Any keyword-level gate is free on detail/request surfaces but requires
  extra data for list surfaces; genre-level gating is possible everywhere
  (lists need a cached TMDB genreId→name map).

## Approach inventory (candidate mapping strategies)

### T1 — Genre-name matching 🔬
Blocked tag string vs TMDB genre names (case/whitespace-normalized). Works on
EVERY surface: lists via `genreIds` + a cached id→name map, details via
`genres[]`. Covers the common "horror"-style blocks. Misses fine-grained tags
("gore", "self-harm").

### T2 — Keyword matching on detail/request surfaces 🔬
Blocked tag vs `keywords[]` names on detail + request-creation. Fine-grained,
zero extra fetches where keywords are present. Lists not covered by itself.

### T3 — Per-item keyword fetches for lists ❌?🔬
Fetch keywords per list item (TMDB or Seerr detail) to keyword-gate lists.
Cost: N extra requests per list page (20 items) — rate limits, latency,
cache pressure. Only viable with aggressive caching; likely reject for lists,
acceptable as an on-demand fallback nowhere.

### T4 — Library-presence lookup 🔬
If the TMDB item already exists in the Jellyfin library (tmdbId provider-id
lookup), use its REAL Jellyfin Tags — exact parity with native behavior.
High precision, but only covers already-imported items (a minority of Seerr
browse content). Complement, not a solution.

### T5 — TMDB discover-side exclusion (`without_keywords`/`without_genres`) 🔬
Ask TMDB/Seerr to exclude upstream. JE proxies Seerr's API — Seerr builds its
own TMDB queries, so JE cannot inject TMDB params unless Seerr's discover
endpoints forward them. Verify; likely limited to discover (not search/
similar/trending) even if possible.

### T6 — Normalization/synonym layer over T1+T2 🔬
Jellyfin tags are free text ("Sci-Fi", "sci fi", "science fiction"). A
normalization (casefold, strip punctuation/whitespace) + small synonym map
(sci-fi→science fiction, etc.) increases hit rate without false positives.
Scope carefully — no fuzzy matching (accidental blocking is better than
accidental exposure here, but silent over-blocking of unrelated titles would
read as a bug; fail-closed posture applies to EXPOSURE not to blocking).

---

## Findings log

### 2026-07-08 12:44 — run started
Fresh clone at merged main (PR 15 head). Research fan-out: existing parental
filter architecture, Jellyfin BlockedTags/AllowedTags semantics in JF12 core,
Seerr/TMDB metadata surfaces. Milestone 4 created for approach tracking.

### 2026-07-08 12:52 — JF12 tag-block semantics (source-verified)
- Policy: `UserPolicy.BlockedTags`/`AllowedTags` (string[]); stored as user
  Preferences (`user.GetPreference(PreferenceKind.BlockedTags/AllowedTags)`);
  rating limit is separate first-class `user.MaxParentalRatingScore` (int
  score in JF12, compared via `ILocalizationManager.GetRatingScore`).
- Enforcement (`BaseItem.IsVisibleViaTags` + the SQL twin): matches the
  item's **Tags only — genres are NOT matched** — including INHERITED tags
  (item + series + parents + library folder). Both sides normalized with
  `GetCleanValue()` (lowercase, strip diacritics, punctuation→spaces,
  collapse whitespace) then whole-token HashSet overlap — so "Sci-Fi" ==
  "sci fi". BlockedTags always wins; AllowedTags (when non-empty) is a
  strict allow-list requiring ≥1 match; both empty → no gating.
- Native scope: applied to library queries, search, suggestions, latest,
  channels — i.e. everywhere a user-scoped query runs. A Seerr-side gate
  mirroring "Tags only + inherited + GetCleanValue + blocked-wins" is the
  parity target.
- **Key mapping insight:** Jellyfin's TMDB metadata provider imports TMDB
  *keywords* as item Tags — so for TMDB-sourced libraries, the strings the
  native gate matches ARE TMDB keyword names. T2 (keyword matching) is
  therefore the high-parity mapping; T1 (genre matching) is an extension
  beyond native semantics (worth having for intent — an admin blocking
  "horror" means the genre too — but should be a deliberate, documented
  choice, likely an admin toggle).
- AllowedTags on LIST surfaces is the hard case: lists carry no keywords, so
  strict parity can't verify an allowed tag → fail-closed would hide all of
  discover for allow-list users. Decision deferred until the filter
  architecture is mapped.
