# Anonymous-Request → User Attribution: Synthesized Findings

Consolidated and de-duplicated across all evaluation lenses. Deployment-critical constraint throughout: the consumer (Spoiler Guard blur) is **fail-closed**, so any mechanism that *narrows* a candidate set can drop the guarding user and leak clean bytes — narrowing is only ever safe as a *widen*, never a *pick*.

## Existing shipped ladder (context — retained as-is)

| Tier | Mechanism | Trust | Role |
|---|---|---|---|
| L1 | ClaimsPrincipal from `MediaBrowser` header / `?ApiKey=` (JF12 auth middleware runs on anonymous routes) | authoritative | Top tier. Only fires for the rare client that sends creds (Android native ImageProvider); flagship clients send nothing. |
| L2 | Per-user `-jeu{12hex}` marker stamped into every DTO image tag, echoed verbatim in `?tag=` | strong disambiguation | **The decisive tier.** Proxy-proof, per-user, no client cooperation. Solved native-behind-proxy. Unknown/collision/forged markers fall through safely. |
| L3 | `jc-spoiler-uid` browser cookie, validated against session-on-IP | strong (web) | Web/WebView only. Session-on-IP gate rejects stale/forged cookies. |
| L4 | Session-by-IP candidate set, fail-closed | weak narrowing | Safety floor. Over-blurs (safe), never under-blurs; collapses to everyone behind an IP-hiding proxy. |

---

## Group 1 — Adopt-candidates (open new GitHub issues)

**1. Single-user / effectively-single-user shortcut** — *value 3, feasibility 5, zero risk*
If the server has exactly one enabled non-admin user, every anonymous request is unambiguously that user (live `IUserManager` count check). Closes a **real current leak**: when the lone user guards an item but has no active session, L4 returns None and the filter serves clean bytes. No misattribution vector (no second user to confuse). Precondition must be evaluated live (a second login instantly drops the shortcut). Trivial, authoritative fast-path above L4 — highest value-to-cost of anything new.

**2. Plugin-level X-Forwarded-For learned realIP→user map (A3)** — *value 3, feasibility 4, needs strict gating*
Jellyfin ignores XFF without `KnownProxies`, but Caddy/Traefik/nginx send it by default; a filter reads the raw header directly. Build a TTL map of realIP→userId from **authenticated** requests, then match anonymous image requests' XFF against it (sessions record only the proxy IP, so a plugin-owned map is required). The single largest net-new coverage win — de-ambiguates the ladder's one genuine weak spot (L4 behind a proxy) for the residual cold-cache / non-`?tag=` native surfaces. **Safe only if:** (a) trusted only when the transport peer is a configured/auto-learned proxy (XFF is client-forgeable, and an authenticated request with a spoofed victim-IP would poison the map = forbidden cross-user misattribution); (b) used **additively / fail-closed** — never to prune below the transport-IP session set, since a reassigned/CGNAT/stale realIP can name the wrong user. NAT households still collapse to a set (acceptable). Note: configuring Jellyfin's own `KnownProxies` is the supported alternative and largely supersedes this — the issue should weigh plugin-map vs. simply advising `KnownProxies`.

---

## Group 2 — Complements (harden alongside the ladder; lower priority)

- **Signed/HMAC `jc-spoiler-uid` cookie** — *value 2, feasibility 4.* Replace the raw GUID with an HMAC(userId, secret) cookie so it self-authenticates without the session-on-IP dependency. **Must keep the session-on-IP check** — dropping it reintroduces the logout/account-switch stale-cookie leak. Mostly redundant with L2 on web (marker already resolves tagged fetches); real gain is untagged web fetches (CSS backgrounds). Needs a persisted plugin secret (none in repo today).
- **PlaySessionId → user registry** — *value 2.* PlaybackInfo mints a server-bound PlaySessionId echoed on stream/subtitle URLs; register it→user. Authoritative but coverage is a strict subset of L2 (playback window only), and absent during idle poster browsing (the spoiler-critical surface).
- **Streaming echo-field markers** (PlaySessionId / MediaSourceId / LiveStreamId / TranscodingUrl / subtitle DeliveryUrl) — *value 2.* Opaque server-authored fields minted in an authenticated PlaybackInfo call; absence fails closed. Orthogonal to images — this is the correct mechanism **if Spoiler Guard ever extends to video/subtitle bytes.**
- **Marker on non-image DTO surfaces** (subtitle `Stream`, trickplay tiles, lyrics) — *value 2, conditional.* Extend L2 to tagless anonymous surfaces. Pursue only the **cosmetic, per-surface-verified** subset — do NOT stamp the functional `mediaSourceId` (a server lookup key; stamping risks breaking playback). The `{tag}` path-segment variant is redundant with `?tag=`.
- **Websocket-connect XFF capture** — *value 2.* Seeds the A3 realIP→user map from the authenticated ws token with clean disconnect eviction. Largely subsumed by populating that same map from all authenticated HTTP requests; fold into A3.
- **Client-cooperation header from own fork (Plethorafin)** — *value 1–2.* Signed `X-JC-Uid` on the fork's image requests; strictly additive, zero misattribution (others fall through). Bonus hardening only — L2 already resolves the fork via the echoed tag; not a general fix (can't touch stock clients).
- **Per-user endpoint at onboarding (per-user Host/subdomain/base-URL)** — *value 3 but heavy infra.* The only mechanism that identifies a **cold-cache** native client behind an IP-hiding proxy with no prior stamped DTO. But it's mostly out-of-band DNS/reverse-proxy/wildcard-cert/onboarding work, not a plugin capability, and misattributes when a device configured for one user is used by another logged-in profile. Power-user / admin-opt-in only.
- **Read marker from the tag-in-PATH route** — *trivial.* `Items/{id}/Images/{type}/{index}/{tag}/…` bakes the tag into a path segment; parse it as a second marker source for clients that omit `?tag=`. Same trust as L2, few lines.
- **Audit that ALL tag-bearing DTO fields are stamped** — *value 1, mostly already done.* `SpoilerIdentityTagFilter` is already a global filter stamping ~12 image-tag fields + chapters + blurhash re-keying; residual is only auditing for unhandled DTO wrapper shapes. Cannot misattribute (unstamped field → fail-closed IP tier).
- **`If-None-Match` marker fallback** — *value 1, trivial.* Read the same marker off the echoed ETag on 304 revalidation. Zero new risk, near-zero real coverage (no known client drops `?tag=` while keeping the validator). Cheap belt-and-suspenders.
- **sec-fetch same-origin anti-forgery guard** — *value 1, plumbing.* Use `Sec-Fetch-Site: same-origin` to gate the **web cookie tier** against cross-site forged image requests. Names no user; must never apply to the marker tier (native clients send no sec-fetch headers).

---

## Group 3 — Narrowing-only (safe **only** to widen the fail-closed set, never to select)

- **UA / device-header fingerprint vs SessionInfo (A5)** — *value 0–1.* Two identical Shield TVs are byte-identical (`okhttp/x.y.z`); can shrink but never resolve. Using it to prune a fail-closed set can drop the guarding user → leak. Only ever a display-ordering / candidate-widening hint; dominated by the marker wherever present.
- **QuickConnect "This TV is me" user-consented IP pin** — *value 1.* Its only safe form (trust the pin only while a live session from that IP already names the user) degenerates to session-by-IP; the uncorroborated form misattributes on DHCP reassignment and pins a shared proxy IP to one user.
- **Referer/Origin + sec-fetch surface classification** — *value 1.* Routes a request to the right tier (web vs native); identifies no user. Marginal since the cookie tier already covers web; Referrer-Policy can strip Referer and mis-bucket a web user as native (unsafe if used to narrow).

---

## Group 4 — Rejected (complete record, one-line reason each)

**Correlation / inference guesswork (violates fail-closed no-misattribution):**
- Timing / NowPlaying activity correlation (A8) — wrong guess unblurs guarded art.
- WebSocket side-channel pre-announce of upcoming fetches — A8 timing in disguise; no field to bind the announcement.
- Time-sliced identity windows — temporal guessing; excluding the guarder leaks.
- Behavioral / collaborative item-fetch inference — overlapping libraries drop the guarder.
- DTO-ordered image-sequence matching — lazy-load/prefetch scrambles order; A8 class.
- Accept-Language narrowing — locale ≠ Jellyfin pref; pruning leaks.
- High-entropy Client Hints fingerprinting — coarse, identical devices collide, web-only.
- Device-signature correlation (UA+sec-ch+Accept+Range) — problem clients too coarse; pruning leaks.
- Header-set fingerprint narrowing within a shared IP — same defect as A5 as a picker.
- Passive request-shape fingerprint (dimensions / JA4) — weaker than UA, more false-precision temptation.

**Connection / TLS / transport layer (absent or unsafe behind the target proxy):**
- Kestrel Connection.Id / TCP-connection correlation (A4) — proxies pool & HTTP/2-multiplex upstream connections across users → cross-user leak.
- Direct-connection-only ConnectionId variant — its own safety gate disables it behind the very proxies it targets; direct case already covered by unshared-IP session + marker.
- TLS JA3 / session-resumption correlation — signal absent behind TLS-terminating proxy; raw ClientHello unreachable from a plugin; JA3 collisions unblur.
- mTLS client certificate — stock clients present none; plugin can't make Kestrel negotiate; proxy hides it.
- PROXY protocol v1/v2 — hand-rolled connection parser + all-or-nothing proxy reconfig; plugin can't attach to Jellyfin's own listeners.
- DHCP / MAC / L2 device fingerprint — L7 plugin never sees L2; stripped at the first hop.

**Per-user endpoint / socket infra (dominated + proxy-collapse hazard):**
- Per-user URL path prefix `/u/<marker>/` — binds to device/server-connection not user (wrong-candidate leak on shared device); server-Id dedupe blocks two URLs to one host coexisting.
- Per-user listening ports — a terminating proxy collapses all clients to one LocalPort → silently buckets everyone to that port's owner; one socket per user.
- Per-user server IPv6 address — IPv6-only reach, same proxy-collapse, per-address TLS/RA infra.
- mDNS / SSDP / AutoDiscovery per-user response — pre-auth LAN broadcast, no user context; only hands over a URL (collapses to the subdomain idea).
- Per-user item-id aliasing + de-aliasing middleware — must de-alias every REST route AND websocket item refs (uninterceptable from a plugin) AND client-cached ids; any miss breaks playback/resume/deep-links app-wide.

**Covert response-side channels (request precedes response; nothing echoed back):**
- Steganographic markers in image bytes — no re-upload path on stock clients.
- Per-user BlurHash covert channel — blurhash is never echoed to the server.
- ETag seeding (per-user token in emitted ETag) — breaks 365-day immutable image caching; shared/CDN caches poison one user's validator onto another.
- `If-None-Match` echo marker as a *primary* signal — wrong timing (absent on first paint); dominated by `?tag=`.
- Stamp identity into requested image dimensions / quality param — client picks these; no plugin hook, identical devices emit identical values.
- Trickplay tile parameters as covert marker — semantically load-bearing integers; no spare entropy without breaking scrubbing.
- Signed/expiring HMAC marker upgrade — forgery already harmless (self-spoil) so signing buys nothing; an expiry breaks the deterministic-marker guarantee that keeps native image caches valid; `?ApiKey=` web promotion needs a nonexistent image-scoped token and risks leaking a full token via `<img>` Referer/logs.

**Web-client injection (dominated by the server marker; jank/perf/operational risk):**
- Blob-URL authenticated image loading — reimplements image loading, kills native caching/lazy-load, flicker, body observer → violates perf rules R1–R8.
- Service Worker fetch interception — conflicts with Jellyfin's own PWA service worker; large operational risk; no correctness gain over the signed cookie.
- `fetch()`/XHR monkey-patching — `<img>`/CSS-background bypass fetch/XHR entirely (the wrong requests).
- Client-side `<img>` src marker rewrite — double-fetch flicker / body observer; dominated by the server-side `?tag=` marker.

**Credential / deviceId reads (nothing on the wire; else already tier 1):**
- Token / deviceId sniffing off the image request (A1/A6) — verified: ATV/Swiftfin/Roku/web send nothing; where creds exist, L1 already resolves.
- IDeviceManager deviceId→user — no deviceId on anonymous image GETs; surfaces that carry it are already `[Authorize]`/L1.
- Active TranscodingJob correlation — transcode segments are `[Authorize]`/L1; never touches anonymous image endpoints.
- Server-set signed cookie via `Set-Cookie` — cookie-jar clients it reaches are already resolved by the marker; can't reach native TV/Swiftfin/Roku.
- Signed capability token in `?tag=` promoting to `?ApiKey=` web auth — needs an image-scoped ephemeral token Jellyfin doesn't provide; risks `<img>` Referer/log leak.

**WebSocket / session hardening mistaken for identity:**
- WebSocket identity bridge — an open authed ws IS already a session in `ISessionManager`; deviceId unmatchable to credential-free image GETs; still IP-keyed.
- Authenticated WebSocket presence narrowing — subset of session-by-IP; dropping a lapsed-ws guarder leaks.
- WebSocket message-bus probe — stock clients emit no induced identifiable request; degenerates to timing.
- ForceKeepAlive ws ping — not an identity signal; the resolver ignores activity windows anyway, and kept-alive idle sessions only enlarge the over-blur set.

**Plugin-owned image routes / forced auth (stock clients won't route to them):**
- Plugin-owned signed image route — stock clients build image URLs from Id+ImageType+tag against the fixed core path and never echo a server-supplied image URL; where a token could ride (the tag) it's just a cache-hostile version of the existing marker.
- Force-auth proxy route demanding a token — clients won't attach fresh creds; degenerates to a baked-in token = the marker, at far worse cost, and can't intercept stale pre-update cached URLs.

**Admin/manual pinning & Referer:**
- Admin device→user pinning — real match key is IP (invisible behind the proxy it should help); DHCP churn or a shared multi-profile TV drops the true guarder → leak.
- Referer/Origin correlation for browser fetches — dominated by the cookie tier; native clients send no Referer.
- Referer/Origin as an identity source — names a page/origin, never a user.

---

### Bottom line
The shipped `?tag=` marker (L2) already carries the load and dominates most proposals. The only genuinely new, safe additions worth issues are the **single-user shortcut** (trivial, closes a real leak) and the **fail-closed, trusted-proxy-gated XFF realIP map** (A3, biggest residual-coverage win but must never narrow). The highest-value *complement* is the **signed cookie keeping its session-on-IP check**. Everything in Group 4 is either physically absent from the wire, unsafe in exactly the reverse-proxy deployment being fixed, or strictly dominated by the marker.