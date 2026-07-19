# Anime Filler Warnings

Anime Filler Warnings puts a clear **Filler** badge on matched episode cards and episode detail pages. It helps you decide whether to watch or skip an episode without renaming titles, changing metadata, or writing anything to your library.

The feature is deliberately conservative. A badge appears only when Canopy can prove the series identity, the episode number, and the provider's classification. An ambiguous title, an unsupported special, a numbering gap, an unavailable provider, or an episode missing from the provider all produce no badge.

!!! info "Web and embedded web clients"

    The badge is available in Jellyfin Web, Jellyfin Media Player, and other clients that embed the web interface. Native television and mobile interfaces do not render the badge in this first version. The authenticated API is reusable by future native clients.

## Turn it on

1. As an administrator, open **Dashboard → Plugins → Jellyfin Canopy → Enhanced**.
2. Turn on **Enable anime filler warnings**.
3. Leave **Warnings enabled by default for new users** on, or choose an opt-in default for new profiles.
4. Save the plugin configuration.
5. Each user can open the Canopy panel, choose **User interface**, and toggle **Anime filler warnings** for their own profile.

The server master switch is off by default. When it is off, automatic classification sends no requests to the anime providers and loads no filler-warning client module. An administrator can still make an explicit candidate-preview request from the diagnostic search endpoint while configuring the feature.

## Matching rules

Canopy resolves a Jellyfin series to a MyAnimeList ID in this order:

1. an administrator's manual series or season mapping;
2. a `MyAnimeList`, `MyAnimeListId`, or `MAL` provider ID already stored on the series;
3. an `AniList` provider ID translated to AniList's `idMal` value;
4. a strict, exact normalized-title match from Jikan, rejecting a known conflicting production year and using a matching year to disambiguate otherwise identical results.

There is no substring, edit-distance, or “closest title” matching. Punctuation, Unicode presentation, whitespace, and letter case are normalized, but the remaining title must be exact. Multiple valid candidates remain unknown unless one production year matches uniquely.

Canopy uses the documented [Jikan REST API](https://docs.api.jikan.moe/) for MyAnimeList episode classifications and the [AniList GraphQL API](https://anilist.gitbook.io/anilist-apiv2-docs/) only to translate an existing AniList media ID. It does **not** scrape AnimeFillerList or MyAnimeList HTML. The upstreams require no API key.

### Which series count as anime?

The default **Matching genre/tag or provider ID** mode accepts a series when it has a recognized AniList/MyAnimeList provider ID, or when its configured genre or tag matches `Anime` case-insensitively. Administrators can instead require only the genre/tag or only a provider ID.

Only the series title and production year may be sent during strict title search. Canopy never sends usernames, paths, server addresses, library contents, playback activity, or episode titles to either provider.

## Episode numbering

Manual season mappings use the episode's season-relative number:

```text
3f32f919-f347-4cb0-b942-7bc91a38fc3d:S2=1735
```

A series mapping and all automatically resolved mappings use an absolute episode number. Canopy adds the episode number to the highest regular episode number in every earlier season. Virtual episodes count, so a missing local file does not shift all later classifications. Season 0 specials are unsupported and remain unknown.

Before returning Filler or Canon, Canopy also verifies that the calculated episode actually exists in Jikan's episode response. Out-of-range or unprovable numbering never becomes an assumed Canon result.

## Manual mappings

Enter one mapping per line in **Manual MyAnimeList mappings**:

```text
# Whole series: absolute episode numbering
3f32f919-f347-4cb0-b942-7bc91a38fc3d=20

# Season override: season-relative numbering
3f32f919-f347-4cb0-b942-7bc91a38fc3d:S2=1735
```

Keys are Jellyfin series GUIDs. Values are positive MyAnimeList anime IDs. Duplicate, conflicting, malformed, season-zero, and non-positive mappings are rejected by diagnostics rather than partially guessed.

An administrator can inspect the safe diagnostic surface:

```text
GET /JellyfinCanopy/anime-filler/diagnostics
GET /JellyfinCanopy/anime-filler/search?title=Fullmetal%20Alchemist
```

Both endpoints require administrator elevation. Diagnostics expose no credentials because neither provider uses one.

## Reliability and privacy

- Classification requests are authenticated and resolved as the calling Jellyfin user. Missing and inaccessible item IDs return the same `Unknown` result, preventing library-existence leaks.
- A batch accepts at most 100 unique IDs. The client coalesces visible episode cards into sequential batches so later cards are not starved.
- Jikan traffic is conservatively spaced below 60 requests per minute; AniList traffic is spaced below its documented 30-per-minute degraded-state ceiling. Both honor provider backoff headers, use 10-second HTTP deadlines and a two-minute whole-operation deadline, and have bounded response size and pagination.
- Distinct active provider operations have a hard global bound, identical work is shared, and the upstream operation is cancelled when its final caller stops waiting.
- Successful results are cached for 24 hours by default (configurable from 1–168 hours). Negative matches last 30 minutes, transient failures back off for 30 seconds, and a last-good episode map can be used for at most seven days during an outage.
- Both caches are hard-limited to 256 entries. Provider errors are never converted into an authoritative empty or Canon classification.
- The browser receives no remote assets and contacts only the same-origin Canopy API.

## Troubleshooting

**No badge appears:** confirm the server and user toggles are on, the item is a regular episode, and the series has an Anime genre/tag or recognized provider ID. Check the administrator diagnostics for malformed manual mappings.

**A multi-season series is shifted:** add a season-specific manual mapping when the provider splits seasons into separate MyAnimeList entries. Do not compensate by renumbering Jellyfin metadata.

**The provider is down or rate-limiting:** Canopy quietly removes uncertain markers and retries after its bounded backoff. Playback and the rest of the details page continue normally.

**A classification is wrong upstream:** add a manual mapping if the series identity is wrong. If the correct MyAnimeList entry itself marks the episode incorrectly, report it to the upstream data source; Canopy intentionally does not maintain a competing episode-classification database.
