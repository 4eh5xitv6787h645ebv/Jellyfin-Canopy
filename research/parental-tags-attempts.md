# Tag-based parental controls for Seerr surfaces — research log

**Problem.** Jellyfin user policies support tag-based parental controls
(`BlockedTags` — free-text strings matched against library items' Tags) in
addition to the max parental rating. JC's Seerr parental filtering enforces
only the rating limit, so a user blocked from e.g. "horror" in Jellyfin can
still browse, view, and request horror titles through the Requests page.
Goal: enforce Jellyfin tag blocks on Seerr (and other applicable JC)
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
Ask TMDB/Seerr to exclude upstream. JC proxies Seerr's API — Seerr builds its
own TMDB queries, so JC cannot inject TMDB params unless Seerr's discover
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

### 2026-07-08 12:58 — architecture mapped; design locked
Existing filter (`SeerrParentalFilter`, singleton): per-pass PolicySnapshot
from `TryGetPolicy` (already reads `GetUserDto(...).Policy` — BlockedTags/
AllowedTags ride the same object, zero new lookups); per-title cert
resolution with user-neutral cache (`{mediaType}:{tmdbId}:{region}`, 24h,
in-flight coalescing, 20-concurrent/12s budget) feeding rating decisions on
list rows, detail 403s, request POSTs, and the TMDB passthrough. Tag branch
of core's IsParentalAllowed was EXPLICITLY unimplemented (documented as
unenforceable) — that documentation gets retired by this work.

**Decision — composite adopted design:**
- T2+T1 (keywords ∪ genres, cleaned) = the match surface. Keywords are the
  native-parity signal (Jellyfin imports TMDB keywords as Tags); genres are
  a deliberate, documented intent extension (blocking "horror" should block
  the genre; over-blocking is the safe direction).
- T3 reframed: per-title fetches for lists are NOT new cost — the cert
  pipeline already fetches per title. When tag rules are active, switch the
  per-title fetch from the light TMDB cert endpoints to the Seerr FULL
  detail (one body carries certs + keywords + genres), extract both, cache
  both (new user-neutral tag-set cache alongside CertScoreCache). Fallback
  TMDB detail with append_to_response=keywords for Seerr-less setups.
- T6 via core's own `String.GetCleanValue()` (Jellyfin.Extensions, already
  referenced transitively) — normalization parity by construction.
- AllowedTags: fully enforceable everywhere (the per-title fetch supplies
  keywords for list rows too); missing signature with tag rules active →
  fail closed, consistent with the cert path. Blocked-wins precedence.
- T4 (library-presence lookup) rejected: marginal precision for items
  already in the library, per-row lookup cost, and inherited-tags semantics
  can't be replicated for external content anyway.
- T5 (discover excludeKeywords injection — live-verified working on
  seerr-dev: keywords=12377 ∩ excludeKeywords=12377 = 0 rows) rejected as
  the primary (discover-only; search/similar/trending uncovered; needs
  name→id resolution) — filed as a follow-up optimization to keep discover
  pages full-length instead of post-filter shrunk.
- New server-side toggle `SeerrRespectBlockedTags` (default on),
  subordinate to the existing parental master flag.

### 2026-07-08 13:20 — implemented, tested, live-verified
- `ParentalTagDecision` (pure port of core's IsVisibleViaTags, GetCleanValue
  normalization via Jellyfin.Extensions) + `SeerrTagSignatureExtractor`
  (Seerr flat + raw-TMDB wrapped keyword/genre shapes) + filter integration:
  PolicySnapshot gains cleaned BlockedTags/AllowedTags, per-title resolution
  returns TitleSignature (cert score + tag set), tag-rule passes fetch the
  Seerr full detail, cache entries carry tags (tag-bearing and cert-only
  fetches coalesce separately; light results never erase cached tags).
  New sub-toggle `SeerrRespectBlockedTags` (default on).
- 624 unit tests green (28 new: decision precedence/normalization vectors,
  extractor shapes, orchestration incl. the cert-only-cache upgrade case);
  client gates green; goldens/save-keys regenerated (expected deltas).
  Shared test doubles extracted (StubPolicyUserManager, FakeLocalization)
  from nested duplicates per the fix-at-source rule.
- **Live on jellyfin-12 + seerr-dev:** BlockedTags ["zombie"] on jc_arruser →
  the 1968 Night of the Living Dead (zombie keyword) vanishes from search,
  detail 403, request POST 403; sparse-keyword remakes correctly survive
  (keyword precision — the earlier "not working" scare was a remake whose
  only TMDB keyword is "remake"). BlockedTags ["horror"] (genre) → 10 rows →
  2. Admin unaffected. e2e spec added (search/detail/request + genre
  narrowing + admin bypass, policy restored in finally).
- Docs: seerr-features.md rewritten (limitation retired, new honest
  limitation: TMDB keyword coverage is community-sourced — genre blocks give
  broader coverage; fail-closed on unfetchable signatures).

### 2026-07-08 14:10 — review loop clean; allow-list parity split
- Codex GPT-5.5 xhigh: 2 findings, both fixed — a light cert-only refresh
  could resurrect EXPIRED tags under a fresh timestamp (stale tags extend a
  TTL → upstream keyword changes bypassed), and the tag-preservation merge
  raced concurrent fetches; both closed with one freshness-bounded atomic
  AddOrUpdate + a regression test pinning the resurrect scenario.
- 5-dimension adversarial-verified workflow (Opus xhigh): 4 confirmed, all
  fixed — the big one: genres satisfying the ALLOW-list under-blocked vs
  native (genres never become item Tags; a genre match let a restricted user
  see titles the library would hide). Keywords and genres now flow separately
  end-to-end; blocked matches keywords ∪ genres, allowed matches keywords
  ONLY (native parity), docs state the asymmetry and why. Also: the flagship
  cache-upgrade test was non-discriminating (passed even with the guard
  deleted) — now blocks an absent tag and asserts re-resolution; season +
  sub-detail surfaces gained tag coverage. 4 findings refuted with verified
  reasons. (A mid-fix scare — the "werewolf" test still blocking — was a
  silent no-op in my own edit script, not a code bug; assert-guarded edits
  from now on.)
- Final: 628 unit + client gates green, full e2e 39/39 on the deployed
  build, mkdocs strict green.
