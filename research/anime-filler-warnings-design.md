# Anime Filler Warnings delivery contract

Project: [Jellyfin Canopy — Anime Filler Warnings](https://github.com/users/4eh5xitv6787h645ebv/projects/7)

Tracking issue: [#371](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/371)

## User outcome

When an administrator opts in, Jellyfin Canopy warns an opted-in user that an
episode is classified as filler before the user selects it. The warning appears
as an overlay badge on episode cards and as a stronger, persistent marker on an
episode detail view. It never changes an episode name, tag, provider ID, NFO, or
other persisted library metadata.

The feature is advisory. Filler classification is community-maintained and can
be incomplete or disputed. Unknown, ambiguous, inaccessible, non-anime, and
provider-error results produce no warning.

## Data source and attribution

The default source is the no-key Jikan REST v4 API, which publishes the
MyAnimeList episode `filler` classification. Canopy uses the documented API; it
does not scrape Anime Filler List or MyAnimeList pages. Documentation attributes
Jikan and MyAnimeList and links to the provider documentation.

Only fixed HTTPS origins are contacted:

- `https://api.jikan.moe/v4/` for anime search and paginated episode data.
- `https://graphql.anilist.co/` only to translate an existing Jellyfin AniList
  provider ID to the associated MyAnimeList ID.

Neither origin is configurable by a browser caller. The feature needs no API
key and sends no Jellyfin username, user ID, media path, server URL, or playback
history to either service. Jikan searches send only a series title; the
production year is used locally when disambiguating returned candidates.

## Mapping contract

Mapping precedence is deterministic:

1. An explicit administrator mapping.
2. A numeric `MyAnimeList`, `MyAnimeListId`, or `MAL` provider ID on the series.
3. A numeric `AniList` provider ID translated to `idMal` by AniList.
4. A strict Jikan title match.

Automatic title matching normalizes Unicode, punctuation, whitespace, and case,
then compares the Jellyfin series name with every returned Jikan title and
synonym. It accepts only one exact normalized-title candidate.
A candidate with a known conflicting production year is rejected. When more
than one remaining exact candidate exists, a matching production year may
select one; otherwise the result is ambiguous and no warning is shown.
Substring or edit-distance guessing is forbidden.

Manual mappings use one entry per line:

```text
<series-guid>=<mal-id>
<series-guid>:S<season-number>=<mal-id>
```

The series mapping means the MAL entry numbers regular episodes continuously
across the Jellyfin series. The season mapping means the MAL entry starts at
episode 1 for that Jellyfin season and overrides a series mapping for the season.
Malformed, duplicate, non-positive, or conflicting entries are rejected by the
parser and surfaced in admin diagnostics; they never widen a match.

## Episode numbering

Specials (`ParentIndexNumber` zero or missing) are unsupported unless a future
provider contract explicitly covers them. A season mapping uses the episode's
positive `IndexNumber`. A series mapping uses an absolute number calculated as
the episode index plus the maximum regular episode index of every lower-numbered
season. Virtual episodes participate in those maxima so missing local files do
not shift later episodes.

Before publishing a classification, Canopy compares the resolved episode number
with the provider entry's episode range. An out-of-range or unprovable shape is
`Unknown`, never `Canon` and never `Filler`.

## Server contract

`POST /JellyfinCanopy/anime-filler/classifications` accepts at most 100 unique
Jellyfin item IDs. It is authenticated and resolves every item through
Jellyfin's caller-scoped library lookup. An inaccessible, removed, or unknown ID
returns the same `Unknown` shape and exposes no title, provider ID, or existence
signal. Non-episode and conservatively non-anime items return a non-warning
result.

Anime targeting accepts a series when it has a recognized anime provider ID,
the configured genre (default `Anime`), or the configured tag (default `Anime`).
The default mode requires a provider ID or the genre/tag signal; it never treats
all television as anime.

The response is deterministic and contains only the requested item ID, a
classification (`Filler`, `Canon`, or `Unknown`), and a public reason code. MAL
IDs and source links are returned only for visible matched episodes. Business
failures use bounded JSON. Authentication and elevation failures keep Canopy's
standard bare status behavior.

Administrator-only diagnostic endpoints report sanitized configuration,
validated mapping counts/errors, and a bounded strict-title candidate preview.
They never return upstream payloads, credentials, user data, or media paths.

## Cache and provider failure contract

The singleton provider owner has:

- a hard capacity of 256 anime entries and 256 mapping/search entries;
- a global bound of 128 distinct active provider operations and one shared
  operation per cache key;
- final-waiter cancellation and a two-minute whole-operation deadline;
- per-origin rate gates below Jikan's 60-request-per-minute ceiling and
  AniList's 30-request-per-minute degraded-state ceiling, including provider
  backoff headers;
- a 10-second per-request HTTP timeout plus caller cancellation;
- a 24-hour success TTL, 30-minute negative-match TTL, and 30-second transient
  error backoff;
- last-good episode data usable for at most seven days during an outage;
- bounded pagination and response size.

Transient errors are not authoritative empty data. A stale last-good answer may
still warn for at most seven days. Without last-good data, the classification
is `Unknown`. Cache keys contain no user identity because the provider answer
is public, while authorization occurs before a lookup.

## Configuration and user settings

Admin configuration:

- `AnimeFillerWarningsEnabled` — opt-in master switch, default `false`.
- `AnimeFillerWarningsDefaultEnabled` — new-user default, default `true`.
- `AnimeFillerDetectionMode` — conservative provider/genre/tag policy.
- `AnimeFillerGenre` and `AnimeFillerTag` — default `Anime`.
- `AnimeFillerMappings` — validated manual mapping lines.
- `AnimeFillerCacheHours` — clamped to 1–168, default 24.

Per-user `animeFillerWarningsEnabled` inherits the admin default when the user's
settings file is created. It cannot enable the feature while the admin master
switch is off. Saving either admin or user configuration restarts only the lazy
feature generation and removes existing markers synchronously.

## Client behavior

The import-pure `anime-filler-warnings` entry activates only for an authenticated
identity, with the master switch and per-user setting on, on item detail routes.
It owns all DOM, shared mutation subscriptions, navigation subscriptions,
requests, timers, and abort controllers through its loader scope.

The client collects unique IDs only from the current visible details view,
sends sequential batches of up to 100 IDs, and coalesces mutation bursts. It
never sends one request per card and never starves cards after the first batch.
It decorates only results still owned by the same identity,
configuration generation, navigation generation, DOM element, and item ID.

Card badges are absolutely positioned overlays with no remote assets. The detail
marker uses reserved/overlay space so late data does not move host content.
Both use native theme tokens, sufficient contrast, localized visible text, and
an accessible label. Unknown/canon/error results remove stale markers and do not
emit a user-facing error toast or a noisy console error.

The supported UI boundary is Jellyfin web and clients embedding that web UI.
Native TV clients that do not run Canopy's client bundle do not receive the badge
in this version. The authenticated server API is deliberately reusable by a
future native adapter.

## Evidence and completion

- Pure matching, mapping, numbering, direct/AniList/title precedence,
  ambiguity, cache, coalescing, rate/error backoff, and response-bound tests.
- Controller contract and behavioral tests for authentication/elevation,
  caller-scoped episode and series lookup, invalid and oversized batches,
  absolute numbering, sanitized diagnostics, and provider-search failures.
- Config descriptor/control/snapshot/default/live-update tests.
- Client import-purity, batching, lifecycle, recycled-card, late-result,
  rendering, accessibility, and negative-result tests.
- Jellyfin 12 Playwright proof for batched list-row filler rendering,
  accessibility, and zero real console errors alongside the full required
  browser regression inventory.
- Every registered locale synchronized; strict offline documentation checks.
- Full client/server coverage, bundle, type, syntax, script, security, release
  build, and diff checks.
- Independent adversarial review with every material finding resolved.
- Green linked PR, verified writable remote, merge reachable from `origin/main`,
  issues #371–#378 closed, and every Project 7 item at `Done`.

## Non-goals

- Automatically skipping filler.
- Persisting or renaming Jellyfin metadata.
- Scraping Anime Filler List or MyAnimeList HTML.
- Fuzzy guessing across ambiguous series.
- Claiming that a community classification is objectively canonical.
- Shipping a native-TV client adapter in this project.
