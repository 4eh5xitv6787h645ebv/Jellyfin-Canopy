# TTL cache capacity audit

Issue #105 replaces threshold-triggered expiry sweeps with
`BoundedTtlCache<TKey, TValue>`. The shared primitive is thread-safe, uses a
deterministic LRU, enforces both entry and weight ceilings, expires on access or
bounded maintenance, and supports versioned publication tokens so stale work
cannot remove a refresh.

## Shared primitive callers

| Scope | Entry ceiling | Weight ceiling |
| --- | ---: | ---: |
| Seerr avatars | 64 | 32 MiB |
| Seerr user IDs/users/import throttle | 2,048 each | 4 MiB / 4 MiB / 2,048 units |
| Seerr responses | 256 | 32 MiB |
| Seerr public 4K settings | 64 | 64 units |
| TMDB enrichment | 512 | 4 MiB |
| certification/keyword signals | 4,096 | 16 MiB |
| auto-season details | 256 | 16 MiB |
| auto movie/season and playback reservations | 16,384 each | 16,384 units each |
| watchlist request snapshots | 64 | 100,000 item/key units |
| request IP scans / cookie misses | 1,024 / 2,048 | 1 MiB each |
| privacy user state / collection scope / watched-season state | 2,048 / 1,024 / 512 | 100,000 scope units / 8 MiB / 512 units |
| hidden-content state | 2,048 | 100,000 scope units |
| tag-cache user-access projections | 2,048 | 2,000,000 ID/key units |
| warning and polling deduplication | 256–4,096 | 256 KiB–4 MiB |

The Seerr, auto-season, watchlist, parental-signal, and tag-access expensive
lookups retain per-key singleflight. Negative Seerr users remain restricted to
authoritative absence and retain their shorter read-side TTL.

## Reviewed equivalent or non-cache state

- `LiveSessionRegistry` is an equivalent bounded implementation: 500 entries,
  24-hour expiry, deterministic stalest-first eviction, and pair-conditional
  removal so a refresh survives cleanup.
- `ImageBlurService` is an equivalent bounded implementation: 256 entries and
  64 MiB, with access timestamps and locked eviction. Its entry and byte caps
  have direct tests.
- `SeerrStatusCache` is one source-neutral singleton value, not a key-cardinality
  cache.
- `TagCacheService._cache` and the asset derived registry are durable
  projections of the finite library/manifest and are persisted source state,
  not TTL memoization.
- Route/action dictionaries are immutable finite tables.
- In-flight, pending-change, and invalidation dictionaries represent currently
  executing work. Their owners remove exact key/value pairs on completion or
  clear them at the documented lifecycle boundary; they are not retained TTL
  caches.
- Spoiler identity marker maps are projections of the current Jellyfin user
  topology and are explicitly invalidated on user creation/deletion.

No insertion path is allowed to start an unbounded full-cache expiry scan. A
future TTL memoization dictionary should use the shared primitive unless it has
both a hard capacity proof and documented lifecycle/eviction semantics here.
