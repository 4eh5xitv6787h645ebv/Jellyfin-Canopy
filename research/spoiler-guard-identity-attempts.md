# Spoiler Guard identity without IP — research log

**Problem.** Spoiler Guard protects images per user. Item image endpoints are
anonymous in Jellyfin 12, so the plugin must attribute each image request to a
user itself. Today's resolution ladder (`SpoilerUserResolver`):

1. `ClaimsPrincipal` — authoritative, present only when the request carries a
   token Jellyfin authenticates.
2. `je-spoiler-uid` cookie — web browsers only; trusted only when that user
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

## Findings log

### 2026-07-08 00:55 — baseline mapped
`SpoilerUserResolver.ResolveCandidateUserIds` is the single choke point; both
filters (image + field-strip) share it. Any new signal slots in between the
ClaimsPrincipal check and the IP-session fallback. The image filter is an MVC
action filter over Image/Trickplay controller actions with full HttpContext,
so headers/query/cookies are all reachable. Research fan-out launched:
JF12 auth+tag semantics, native client request contents, DTO tag-rewrite
feasibility.
