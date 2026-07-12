# Spoiler Guard identity without IP — research log

**Problem.** Spoiler Guard protects images per user. Item image endpoints are
anonymous in Jellyfin 12, so the plugin must attribute each image request to a
user itself. Today's resolution ladder (`SpoilerUserResolver`):

1. `ClaimsPrincipal` — authoritative, present only when the request carries a
   token Jellyfin authenticates.
2. `jc-spoiler-uid` cookie — web browsers only; trusted only when that user
   also has a session on the request IP.
3. Session-by-IP — every user with a session from the request IP is a
   candidate; ambiguous ⇒ fail closed (blur if ANY candidate guards the item).

Behind a reverse proxy that doesn't forward the client IP (no
X-Forwarded-For, or proxy not in Jellyfin's Known Proxies), every remote
client shares the proxy's IP, so native clients (Android TV, mobile) collapse
into one candidate set and everyone sees everyone's blur. Goal: an identity
signal for native-client image requests that does not depend on the IP.

**Status legend:** ✅ adopted · 🟡 partial/possible fallback · ❌ rejected (with reason) · 🔬 under test

---

## Approach inventory

### A1 — Token sniffing: read the client's own credentials off the image request 🔬
Native clients may send their access token with image requests (an
`Authorization: MediaBrowser Token=…` header, `X-Emby-Token`, or a legacy
`?api_key=` / `?ApiKey=` query param) even though the endpoint is anonymous.
If they do, either (a) Jellyfin's auth handler already populates
`ClaimsPrincipal` on anonymous endpoints when credentials are present — in
which case step 1 of the ladder already works and nothing extra is needed —
or (b) the raw token is present but ignored by core, and the plugin can
resolve token → device → user itself.
- **Verify:** what each client actually sends (source dive + live capture
  behind a deliberately misconfigured proxy), and what JF12's auth handler
  does with credentials on anonymous routes.

### A2 — Tagged image URLs: embed a per-user marker in ImageTags 🔬
Clients never invent image URLs from nothing — they build them from the
`ImageTags` / `*ImageTag(s)` values in authenticated item DTO responses, and
echo the value back as `?tag=` on the image request. The DTO response IS
per-user-authenticated, so a response filter can rewrite each tag to
`<originalTag>-<userMarker>` (marker = short HMAC of userId under a persisted
server secret). The image filter then decodes `?tag=` → user. Works for every
client that echoes tags, with zero client cooperation and zero proxy config.
- **Verify:** JF12 serves image bytes regardless of tag mismatch (tag is
  cache-busting only); which response paths carry tags and whether the
  existing strip filter covers them; whether any client validates/transforms
  the tag; cache-header interactions.
- **Fail-safe:** absent/unrecognized marker ⇒ current IP ladder. Strictly
  additive.

### A3 — Plugin-level X-Forwarded-For reading 🔬
Even when Jellyfin isn't configured with Known Proxies, the XFF header the
proxy sends (most proxies send it by default) is still ON the request —
Jellyfin just doesn't rewrite RemoteIpAddress from it. The plugin can read it
directly and use the real client IP for its session matching. Trust model
matters: XFF is forgeable by the client. Mitigation: use XFF only to
*disambiguate* (narrow the candidate set), never to *authenticate*; and/or
only trust XFF when the transport RemoteIp equals a plugin-configured (or
auto-learned) proxy address. Complication: sessions record the proxy IP too
(Jellyfin core saw the proxy IP), so XFF can't be matched against
SessionInfo.RemoteEndPoint — the plugin must build its own map of
real-IP → user from authenticated API requests' XFF values.
- **Verify:** whether default Caddy/nginx/Traefik configs send XFF even when
  unconfigured (they do — the failure mode is usually Jellyfin's Known
  Proxies being empty, not the header missing); spoofability analysis.

### A4 — Connection correlation: ConnectionId → user ❌?🔬
Map ASP.NET `HttpContext.Connection.Id` → user when an authenticated request
arrives; anonymous image requests reusing the same kept-alive TCP connection
inherit the identity. Almost certainly unsafe behind proxies: nginx/Caddy
pool upstream connections ACROSS downstream clients, and HTTP/2 multiplexes
everyone onto few connections — exactly the deployment we're trying to fix.
- **Verify:** measure on a real proxy; expected outcome is "reject, document
  why".

### A5 — Header fingerprinting: User-Agent/device headers → session 🟡?
Match request headers (User-Agent etc.) against SessionInfo Client/Device
data to narrow the candidate set (e.g. the only Android TV session among web
sessions). Never a full identity — two Shield TVs look identical — but can
shrink the fail-closed blast radius.
- **Verify:** what UA each client sends on image fetches vs what SessionInfo
  records.

### A6 — deviceId on image requests 🔬
Some clients append `deviceId` or send `X-Emby-Device-Id`-style headers on
media requests. DeviceId → session → user is unique and unforgeable-enough
(same trust tier as the cookie). Subsumed by A1 verification (same capture).

### A7 — Client-cooperation header (Plethorafin etc.) ❌ as general fix
The user's own Android TV fork could send an identifying header on image
requests, but stock clients can't be updated from the server side. Not a
general solution; may still be a bonus hardening for Plethorafin later.

### A8 — Session NowPlaying/browsing correlation ❌ expected
Attribute image requests by which session is actively browsing (session
activity timestamps around the image burst). Timing correlation across a
shared proxy IP with multiple concurrent users is guesswork — wrong
attributions would *unblur* guarded art. Fail-closed posture forbids it.

---

## Tracking

GitHub milestone **“Spoiler Guard: identity beyond IP”** (milestone 2) collects
one research issue per approach, with `outcome: worked / not-worked / partial`
labels; rejected approaches are closed as not-planned. Issues: 5 (A2, adopted),
6 (A1/A6, rejected), 7 (A3, partial/complement), 8 (A4, rejected), 9 (A5,
rejected), 10 (A7/A8, rejected).

## Findings log

### 2026-07-08 01:25 — native-client image requests (source-verified, all 5 clients)
| Client | Auth header | Token in query | deviceId | UA | Cookies |
|---|---|---|---|---|---|
| Android TV (+ Plethorafin/Moonfin) | no | no | no | `okhttp/x.y.z` | no |
| Android mobile (WebView UI) | no | no | no | WebView UA | JC cookie ✅ (it IS jellyfin-web) |
| Android mobile (native ImageProvider, launcher tiles only) | **yes** (full `MediaBrowser …Token=`) | no | in header | okhttp | no |
| Swiftfin (iOS/tvOS) | no | no | no | `Swiftfin/… CFNetwork/…` | no |
| Roku | no (impossible on Poster nodes) | no | no | Roku firmware UA | no |
| Web | no | no | no | browser UA | JC cookie ✅ |

Every client passes the DTO tag verbatim into `?tag=` (Kotlin SDK
`getItemImageUrl`, Swift SDK `url(with:)` with `queryAPIKey=false`, Roku
`ImageURL()`, JS apiclient `getScaledImageUrl`). The Kotlin SDK's image URL
builder has NO credential support at all — no client generation ever
authenticated image fetches. ⇒ A1/A6 dead (nothing on the wire), A5 dead
(`okhttp/x.y.z` UA can't distinguish two ATV devices), **A2 confirmed as the
one reliable channel**.

### 2026-07-08 01:15 — JF12 auth pipeline on image endpoints (source-verified)
The three item-image GET actions are anonymous (no [Authorize], no fallback
policy), but the default-scheme auth middleware still runs on every request:
a `MediaBrowser Token="…"` header or `?ApiKey=` query param populates
`HttpContext.User` (claims incl. `Jellyfin-UserId`, `Jellyfin-DeviceId`) even
there. Legacy carriers (`?api_key=`, `X-Emby-Token`, `X-MediaBrowser-Token`,
`Emby` header) are OFF by default in JF12 (`DisableLegacyAuthorization`
migration). Server-side `tag` is cache-cosmetic only: non-empty ⇒ 365-day
immutable caching, ETag echoes the supplied tag verbatim, never validated,
never 404s. Token→user resolution for a plugin: `IAuthorizationContext.
GetAuthorizationInfo(HttpContext)` or `IDeviceManager.GetDevices(new
DeviceQuery { AccessToken = … })` — both plugin-referenceable.
⇒ A1 needs no plugin work for clients that send credentials (they already hit
the ClaimsPrincipal tier); it's dead only because the problem clients send
nothing.

### 2026-07-08 01:15 — repo feasibility for A2 (source-verified)
- The strip filter already mutates tags (`sb-{8hex}-{origTag}` cache-bust
  prefix in `MutateImageTagsForCacheBust`) and the image filter already reads
  `?tag=` (cache-keying only) — the identity decode is the only missing piece,
  and the marker must COMPOSE with the `sb-` prefix scheme.
- But identity stamping can't just piggyback the strip filter: (a) its route
  allowlist misses Sessions/Channels/LiveTv/Genres/Persons/Studios/Artists/
  InstantMix/UserViews/Trailers; (b) it mutates tags only for spoiler-scoped
  items — identity needs ALL items; (c) it touches only ImageTags +
  BackdropImageTags of the ~12 tag-bearing BaseItemDto fields (ImageTags,
  BackdropImageTags, ScreenshotImageTags, ParentBackdropImageTags,
  AlbumPrimaryImageTag, SeriesPrimaryImageTag, ParentLogoImageTag,
  ParentArtImageTag, SeriesThumbImageTag, ParentThumbImageTag,
  ParentPrimaryImageTag, ChannelPrimaryImageTag).
- `ImageBlurHashes` is keyed BY tag string (ImageType → tag → blurhash): any
  tag rewrite must re-key it in lockstep or client blurhash placeholders break.
- No HMAC utility / persisted secret exists in the repo — consistent with the
  unkeyed-short-hash decision above (forgery is harmless; only collision
  resistance + staleness matter). Resolver will validate marker → real user
  via an IUserManager-derived map (deleted/unknown ⇒ fall back to IP ladder).
- Docs to revise once shipped: docs/spoiler-guard/spoiler-guard-features.md
  line ~229 (the reverse-proxy caveat this work retires).

### 2026-07-08 01:05 — A2 premise verified empirically on jellyfin-12
`GET /Items/{id}/Images/Primary?tag=<anything>` returns identical 200 bytes
for the real tag, a bogus tag, and a suffixed real tag; the tag's only effect
is `Cache-Control: … immutable` (present with any non-empty tag). So an
appended per-user marker cannot break image serving. Verified with curl
against the live server.

### 2026-07-08 01:05 — threat model reframed (lowers the trust bar)
Spoiler Guard protects each user from **their own** spoilers. A *forged*
identity signal only lets someone deliberately see clean art — i.e. spoil
themselves (or see art that was never confidential to begin with). The
fail-closed ladder exists to prevent **accidental** misattribution, not to
resist adversaries. Consequence: an identity marker needs collision
resistance and staleness handling, not cryptographic unforgeability. (The
existing cookie's session-on-IP validation is best understood the same way:
it guards against stale/wrong cookies, not attackers.)

### 2026-07-08 01:02 — A1 pre-finding from prior verified work
Recent source verification (jellyfin-androidtv `ImageHelper` + Kotlin SDK
`getItemImageUrl`) found ATV image requests carry **no api_key and no auth
header** — the app fetches images fully anonymously. A1/A6 likely dead for
the flagship problem client; awaiting fresh source confirmation.

### 2026-07-08 01:00 — capture harness up
nginx header-capture proxy on :8102 → jellyfin-12 (:8099), deliberately NOT
forwarding X-Forwarded-For — reproduces the misconfigured-proxy scenario and
logs every identity-bearing header clients send (Authorization, X-Emby-Token,
cookies, UA). Log: JSON lines in the container's /var/log/nginx/capture.log.

### 2026-07-08 00:55 — baseline mapped
`SpoilerUserResolver.ResolveCandidateUserIds` is the single choke point; both
filters (image + field-strip) share it. Any new signal slots in between the
ClaimsPrincipal check and the IP-session fallback. The image filter is an MVC
action filter over Image/Trickplay controller actions with full HttpContext,
so headers/query/cookies are all reachable. Research fan-out launched:
JF12 auth+tag semantics, native client request contents, DTO tag-rewrite
feasibility.

### 2026-07-08 01:40 — A2 implemented and verified end-to-end ✅
Implementation: `SpoilerIdentityService` (12-hex unkeyed marker per user,
TTL-cached marker→user map, collision detection), `SpoilerIdentityTagFilter`
(global action filter stamping all 12 tag fields + chapters + search hints on
authenticated DTO responses, re-keying `ImageBlurHashes` in lockstep — also
fixing the pre-existing sb- prefix blurhash breakage), resolver tier 2
(marker from `?tag=` → single candidate, ahead of session-by-IP). New
server-side toggle `SpoilerIdentityTags` (default on). 592 dotnet + 390
client tests green.

**Live curl proof (jellyfin-12, all anonymous, one shared IP):** guarded
episode Primary with guarding user's marker → blurred bytes (39783); with
non-guarding user's marker → clean bytes byte-identical to authenticated
ground truth (27400); with plain unmarked tag → fail-closed blur (legacy
ladder preserved).

**Android TV emulator proof (Plethorafin_TV AVD, jellyfin-androidtv fork,
via the deliberately misconfigured nginx proxy on :8102):** wire capture
shows the app's image requests are fully anonymous (`auth:""`, no cookie,
`okhttp/5.3.2`, no XFF) and echo the stamped tag (`…-jeu56c6f557be45`)
verbatim. jc_arradmin (guarding): episode stills substituted, "Spoiler Guard
activated" placeholder. jc_arruser (same proxy IP): real overview + clean
episode stills — the over-blur this project set out to fix is gone.
Screenshots: research/evidence/atv-emulator-*.png

### 2026-07-08 02:30 — exhaustive mechanism sweep (110 ideas, 7 lenses, 22 agents)
Per the user's directive, a multi-agent workflow enumerated every conceivable
identification mechanism (lenses: HTTP/TLS surface, Jellyfin internals, DTO
echo channels, network-level, ecosystem prior art, web-client channels,
creative wildcards), then adversarially evaluated each (strict,
reject-by-default). Full record: `identity-mechanism-sweep-inventory.md`
(every idea with mechanism/coverage/trust/risk/cost/verdict) and
`identity-mechanism-sweep-synthesis.md` in this directory.

Outcomes folded back into the code the same hour:
- **Tag-in-path carrier** — Jellyfin's alternate image route embeds `{tag}`
  as a PATH segment; the resolver now reads it (query → route value).
- **If-None-Match carrier** — the image endpoint echoes the supplied tag as
  the ETag verbatim, so caching clients return the marker in revalidations;
  now parsed as a third carrier. Same token, zero new trust surface.
- **Single-user-server shortcut** — with exactly one account, ambiguity is
  structurally impossible; resolve immediately (also fixes the
  no-session-on-IP gap) and skip session scans.
- New milestone-3 issues: streaming/subtitle/trickplay echo-channel markers
  (12), HMAC-signed cookie upgrade (13), user-consented device pinning (14);
  issue 7 (XFF learned map) updated with the sweep's safe design + reduced
  priority.
Notable rejects (recorded in the inventory): ETag seeding (breaks immutable
caching, shared-cache poisoning), per-user path-prefix/ports/subdomains
(re-login churn on every client, cert/config burden), item-id aliasing
(breaks playback reporting and cross-device resume), steganographic bytes
(nothing ever echoes them back), mTLS (client support nonexistent on TVs),
service-worker/fetch-patch web channels (dominated by cookie+marker; jank
risk), TLS fingerprinting (proxy-terminated).

### 2026-07-08 02:15 — RequestIdentityService extraction (user-approved design)
The identity ladder moved out of SpoilerUserResolver into
`Services/Identity/RequestIdentityService` as a feature-agnostic service
returning `RequestIdentity(Candidates, Confidence)` with tiers Authenticated
→ Marker → SingleUserServer → Cookie → SharedIpCandidates → None, so any
future feature consumes identity through one documented choke point
(milestone 3, issue 11). Spoiler resolver keeps only spoiler-state loading
and delegates. 595 tests green; spoiler e2e 7/7 after redeploy.

### 2026-07-08 03:05 — shipped: PR 15
Branch pushed and PR opened (fork PR 15 → main): per-user image identity
tags + the RequestIdentityService ladder. Final verification: 596 dotnet +
390 client tests, full e2e 37/37 on the deployed build, docs mkdocs-strict
green. Review loop fully clean:
- Codex GPT-5.5 xhigh: 3 findings, all fixed (single-user cache staleness →
  event-driven invalidation on user create/delete; marker-map rebuild
  throttle for just-created users → same events; cookie negative-cache TTL
  tightened to the scan TTL).
- 5-dimension adversarial-verified workflow (Opus xhigh): 3 confirmed, all
  fixed (Nullable<Guid> torn-read on the single-user fast path → immutable
  snapshot behind a volatile reference; global filter allocated an async
  state machine on every MVC response when disabled → sync fast paths;
  vacuous ladder fall-through test → now proves the IP tier is reached);
  5 findings refuted with verified reasons (incl. the "marker
  de-anonymizes users" claim — markers are already only exposed alongside
  content the observer could fetch anonymously, and the evaluator's own
  threat-model check agreed).
Milestone 2 issues resolved (5 closed as shipped; 6, 8, 9, 10 closed as
rejected). Follow-ups on milestone 3: issues 7 (XFF learned map, priority
reduced), 12 (streaming echo channels), 13 (HMAC cookie), 14 (device
pinning), 11 closed (ladder shipped).

### 2026-07-08 03:15 — completeness-critic round: idea space declared saturated
A final critic agent audited the 110-idea inventory for missed angles.
Verdict: **near-saturated on mechanism classes**, with one materially new
find and two documentation corrections:
- **NEW (actionable): forward-auth / SSO / VPN user-identity headers**
  (`Remote-User`, `X-Forwarded-User`, `Cf-Access-Authenticated-User-Email`,
  `Tailscale-User-Login`, …) — the sweep mined proxy headers carrying the
  client IP but never headers carrying the USER. Authoritative tier when
  trusted-proxy-gated; uniquely covers the cold-cache native-behind-proxy
  window; simpler than the XFF learned map. Filed as issue 16 (milestone 3).
- **Correction:** the inventory's premise "no stock client ever replays a
  server-authored image URL" has one exception — DLNA DIDL-Lite, where the
  server writes the full image URLs and renderers replay them verbatim.
  Moot in practice (DLNA binds a renderer to a configured user already, and
  DLNA is plugin-extracted in JF12), but the premise now reads accurately.
- **Correction:** one anonymous image path DOES carry a userId —
  `/Users/{userId}/Images/Primary` (avatars). Only safe as an additive
  candidate signal; dominated by session-by-IP. Recorded, not pursued.
- Coverage-audit notes (not new mechanisms): confirm the tag filter stamps
  LiveTv program/channel DTOs and the image filter fires on the LiveTv
  image routes; spot-check third-party clients (Findroid, Streamyfin,
  Delfin, Feishin) — structurally they land in existing tiers (SDK tag echo
  or credentialed image fetches → ClaimsPrincipal).
Everything else probed (SyncPlay, Chromecast receiver, offline sync, HTTP/3,
Alt-Svc, request smuggling, plugin-to-plugin sharing, server push) is a
variant of an already-evaluated idea or already covered by the shipped
marker. **The loop's research charter is complete: out of ideas.**
