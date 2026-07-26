# Maintainerr

Canopy can present a bounded, read-only view of Maintainerr inside Jellyfin:
connection health, safe cleanup totals, collection summaries and paged content,
rule/queue state, and an optional status marker on an item's details page. The
native `#/maintainerr` page and all operational data are administrator-only.

The integration targets the Maintainerr **3.18.x** compatibility line and was
validated against **3.18.0**. Maintainerr's application APIs are internal APIs
rather than a guaranteed compatibility surface, so versions outside that
reviewed line are reported as unsupported. Within 3.18.x, Canopy
capability-checks optional data and lets one unavailable panel degrade without
turning the rest of the page into a false empty result.

!!! danger "Maintainerr 3.18 has no API authentication"

    Maintainerr 3.18 does not authenticate API requests. The “API key” visible
    in Maintainerr's general settings is reserved for future use; it is not an
    API credential. Keep Maintainerr on a trusted private network or behind a
    properly protected reverse proxy. Canopy deliberately has no Maintainerr
    API-key field and sends no credential.

Canopy is an independent project and is not affiliated with, endorsed by, or
supported by the Maintainerr project. Report Canopy integration problems to
Canopy, not to Maintainerr.

## What Canopy provides

- a connection test and an Overview **Service Status** card;
- participation in **Re-test all service connections**;
- an administrator-only Maintainerr page with status, version, capability and
  Jellyfin-identity information;
- bounded collection summaries and one server-paged collection-content view at
  a time;
- allowlisted storage/cleanup aggregates, rule count, queue state, and optional
  overlay status;
- safe administrator links back to Maintainerr;
- a navigation-scoped item-details marker;
- an explicit opt-in that lets regular users see only two generic booleans:
  whether an accessible item is protected from cleanup and whether it is
  manually managed.

Canopy never exposes Maintainerr settings, logs, databases, notification
configuration, raw rules, raw payloads, mount paths, library names, configured
server names, or internal topology. It has no Run, Handle, Delete, Postpone,
Activate, Deactivate, overlay-process, or other destructive control. Use a
link to Maintainerr when you need to perform an action in Maintainerr's own UI.

## Set up the connection

Open **Dashboard → Plugins → Jellyfin Canopy → Maintainerr**.

1. Enable **Maintainerr integration**.
2. Enter the **Internal URL** that the Jellyfin server can reach.
3. Optionally enter an **External URL** that an administrator's browser can
   reach.
4. If you use different Jellyfin access URLs, optionally add URL mappings using
   the same mapping format as Canopy's other service links.
5. Select which surfaces to enable: the native page, item status, and—only if
   deliberately wanted—the minimal regular-user item status.
6. Select **Test**, review the readiness/version/Jellyfin-mode/identity result,
   then save.

There is no API-key step.

### Internal and external URLs

The internal URL is exclusively for Jellyfin-server-to-Maintainerr requests.
It may use HTTP or HTTPS because same-host and private-LAN HTTP deployments are
supported. HTTP is plaintext, so do not route it over an untrusted network.

The external URL is exclusively for links an authenticated administrator
clicks in a browser. It can differ from the internal URL—for example, when the
containers use an internal DNS name but browsers use a protected reverse
proxy. If it is omitted, an administrator link may fall back to the internal
URL and may therefore be unreachable from that browser. Canopy never gives
that fallback to a regular user or an anonymous client.

For a normal install, enter the complete base in the field:

```text
<MAINTAINERR_INTERNAL_URL>
```

If Maintainerr is hosted below a `BASE_PATH`, include that path in both bases.
Canopy preserves it when appending API paths and safe deep links. Do not add an
API path, query, fragment, username, or password to either base URL.

Canopy rejects non-HTTP(S) schemes, user information, protocol-relative URLs,
queries, fragments, control characters, invalid ports, and path-normalization
tricks. The server also validates the destination again when connecting. Local
and private-network addresses are valid for this integration, but metadata,
link-local, unspecified, multicast, DNS-failure, redirect, and DNS-rebinding
targets fail closed.

## Visibility and privacy

All connection, dashboard, storage, rule, collection, and deep-link endpoints
require Jellyfin's elevated administrator policy. An anonymous call receives an
empty `401`; an authenticated non-administrator receives an empty `403`.
Hiding a navigation item is only presentation—the server policy is the
security boundary.

Item status is the only possible regular-user surface:

- it is off for regular users by default;
- the caller must be authenticated and able to access that exact Jellyfin
  item;
- Maintainerr must be connected to the same Jellyfin system before Canopy sends
  the item ID upstream;
- an administrator can receive bounded collection labels and validated links;
- an opted-in regular user receives exactly
  `protectedFromCleanup` and `manuallyManaged`;
- every upstream/configuration/mismatch failure is the same generic
  `unavailable` result for a regular user, while a genuine empty status remains
  a successful pair of `false` values.

The browser never calls Maintainerr directly. Runtime strings are treated as
untrusted data and links are built only from a sanitized browser base plus
reviewed relative Maintainerr routes.

## Data read from Maintainerr

Production Maintainerr traffic is GET-only and limited to this reviewed
allowlist:

| Endpoint | Purpose |
|---|---|
| `/api/health/ready` | Database-backed readiness |
| `/api/app/status` | Application identity and version |
| `/api/media-server/type` | Confirm Jellyfin mode |
| `/api/media-server` | Server-side identity comparison only |
| `/api/storage-metrics` | Selected aggregate collection/cleanup scalars |
| `/api/overlays/status` | Optional sanitized overlay state |
| `/api/rules/count` | Aggregate rule count |
| `/api/rules/execute/status` | Sanitized running/queued counts |
| `/api/collections` | At most 500 sanitized collection summaries |
| `/api/collections/media/{id}/content/{page}` | One page of 1–50 members |
| `/api/media-server/meta/{jellyfinItemId}/maintainerr-status` | Minimal item status |

See Maintainerr's official [API and security guidance](https://docs.maintainerr.info/api/),
[collections guide](https://docs.maintainerr.info/collections/), and
[rules guide](https://docs.maintainerr.info/rules/) for the upstream concepts.

The unpaged overlay-data route is never used. The raw rules list is also
excluded: in 3.18 it can join [notification configuration](https://docs.maintainerr.info/notifications/),
serialized rule values, and ARR disk paths. Canopy reads only the aggregate
count and sanitized execution state.

Responses have endpoint-specific byte limits. Small status/item responses are
limited to 64 KiB; collection, storage, and one content page are limited to
2 MiB. Collection summaries stop at 500, content size is clamped to 1–50, and
strings, identifiers, arrays, pagination, concurrency, and caches are bounded.
An oversized or malformed result is an explicit error, never a truncated
success and never “no collections.”

## Refresh, cache, and failure behavior

Opening or manually refreshing the page asks Canopy's server for one normalized
dashboard. An ordinary open can reuse the 30-second successful dashboard
projection; the explicit Refresh action bypasses that cache. Identical
in-flight reads still coalesce. The cache holds exactly one normalized
dashboard with at most 500 collection summaries—never raw response bodies or
collection pages—and is discarded when Maintainerr configuration changes or
the plugin process restarts.

Transient dashboard failures have a two-second backoff so repeated opens
cannot create a retry stampede. They remain explicit errors and are never
converted to an empty dashboard. Forced refreshes also have a two-second
minimum attempt interval.

Collection membership is not prefetched or retained: opening a collection
loads one fixed-size page and changing page, route, identity, or configuration
cancels obsolete work. Canopy requests only Maintainerr 3.18's
`deleteSoonest` ordering because that shape is paged in SQL; metadata sorts
that hydrate the full collection before slicing are intentionally excluded.

The item marker performs at most one request for the current details
navigation. It does not poll. A route or identity change cancels the request and
prevents a late response from publishing into the new item.

Optional endpoint `404` responses—including an unavailable paged collection
content route—appear as unsupported/partial capability states. Timeouts,
redirects, wrong-service bodies, identity mismatch, malformed JSON, and
oversized bodies remain distinguishable from a genuine empty result for
administrators.

## Troubleshooting

### The test reports blocked or invalid URL

Check that the internal value is a complete HTTP(S) base without credentials,
query, or fragment. Use the address visible to the Jellyfin server/container,
not necessarily the address used by your browser. A metadata or link-local
destination is intentionally blocked.

### The test returns HTML or reports a redirect

A reverse proxy or authentication portal may be redirecting Canopy to a login
page. Canopy does not follow redirects and does not accept an HTML login body as
Maintainerr JSON. Permit the exact server-to-server read paths at the proxy, or
use a trusted private internal route while keeping the browser-only protected
URL in **External URL**.

### Jellyfin identity does not match

Maintainerr is configured for a different Jellyfin server. Point Maintainerr
at this Jellyfin system and retest. Canopy fails item-ID-specific status closed
until the stable identities match; this prevents an ID from one server being
looked up on another.

### A panel says unsupported

The core connection can remain healthy when an optional 3.18 capability is not
present. Check the installed Maintainerr version and proxy route policy. Canopy
does not substitute a newer, unreviewed endpoint.

### Timeout, malformed, or oversized

Confirm Maintainerr and its database are healthy, then inspect proxy response
rewrites and limits. A slow response is cancelled at Canopy's deadline. A
malformed or oversized body is rejected explicitly and is not cached as empty.

## Local-service impact

Maintainerr traffic is directed at the operator's own service, not shared
public infrastructure, so randomized fleet jitter is not useful. Work is still
bounded:

- one connection test makes exactly four GETs, each capped at 64 KiB (256 KiB
  combined);
- one cold or forced dashboard makes at most nine GETs: seven 64 KiB responses
  plus two 2 MiB responses (4,653,056 bytes combined);
- at most four upstream requests run concurrently, with no more than 12
  admitted waiters (16 active-plus-waiting requests total); overflow is rejected
  immediately with a bounded `429`/`Retry-After` response, and identical
  dashboard loads share one flight;
- one collection action makes one GET capped at 2 MiB and 50 entries;
- one details navigation makes one same-origin Canopy request backed by at most
  two 64 KiB upstream GETs (identity plus item status).

The only dashboard cache entry contains at most 500 sanitized summaries and
aggregate scalars; exact CLR heap bytes vary by runtime, but raw bodies and
membership pages are never retained. There is no background membership sync,
library scan, inactive-route polling, scheduled Maintainerr job, or unbounded
retry.
