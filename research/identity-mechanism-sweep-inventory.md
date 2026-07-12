# Identity mechanism sweep — full evaluated inventory (110 ideas, 7 lenses, 22 agents)

Generated 2026-07-08 by the identity-mechanism-sweep workflow: 7 parallel ideation lenses (http-protocol, jellyfin-internals, dto-echo-channels, network-level, ecosystem-prior-art, web-client-channels, creative-wildcards), each idea adversarially evaluated (strict, reject-by-default). Verdicts: adopt-candidate / complement / narrowing-only / reject.

## Trusted-proxy XFF/Forwarded/X-Real-IP with a learned realIp→user map
*Lens:* http-protocol · *Verdict:* **complement** (feasibility 3/5, value 2/5)

- **Mechanism:** In an action filter, parse the real client IP from RFC 7239 Forwarded, X-Forwarded-For, or X-Real-IP — trusting ONLY the rightmost hop(s) added by an admin-configured trusted proxy (Caddy/Traefik send XFF by default). Because Jellyfin's SessionInfo.RemoteEndPoint records the *proxy* IP (KnownProxies unset), you can't match a real-IP image request against proxy-IP sessions directly; instead run the SAME filter on authenticated requests (where ClaimsPrincipal gives the user) to observe realIp→user and maintain your own short-TTL map, then attribute anonymous image requests by looking up their extracted real IP in that map. Effectively rebuilds tier-4 session-by-IP on the TRUE client IP.
- **Coverage:** Every client behind a well-behaved reverse proxy (web, Android TV, Swiftfin, Roku) — exactly the shared-IP case that today collapses to ambiguous SharedIpCandidates.
- **Trust tier:** strong disambiguation (approaches authoritative when the proxy is trusted and strips inbound XFF)
- **Misattribution risk:** Medium and controllable. If a client can reach Kestrel directly (not only via the proxy) it can forge XFF to any IP — but that only self-spoils into another IP's blur policy (acceptable). Real danger: a misconfigured proxy that APPENDS rather than replaces XFF, or a second untrusted proxy hop, could yield a wrong real IP and attribute a guarded user's request to an unguarded IP → leak. Mitigate by only trusting the hop added by the configured proxy and requiring an explicit trusted-proxy setting (fail closed to tier-4 when absent).
- **Cost:** Medium — trusted-proxy config surface, careful RFC 7239/XFF list parsing, and a second observation path on authenticated requests to populate the map.
- **Vs current ladder:** complements/beats tier 4 — directly resolves the reverse-proxy ambiguity the current ladder explicitly gives up on; does not touch the proxy-proof marker tier.
- **Evaluator:** Safely it only reconstructs tier-4 (a candidate SET, fail-closed) on the truer client IP, so it helps the shrinking residual that already lacks a marker (unstamped DTO shapes, stale native caches) while the TTL'd learned map risks aging out a quietly-scrolling guarding user (leak) unless bounded against CGNAT IP-reassignment leaks.

## HMAC-signed identity cookie (upgrade of the jc-spoiler-uid cookie)
*Lens:* http-protocol · *Verdict:* **complement** (feasibility 5/5, value 2/5)

- **Mechanism:** Replace the raw-GUID jc-spoiler-uid cookie with a server-secret-HMAC cookie carrying {userId, issuedAt}, set (HttpOnly, SameSite=Lax, Secure) during the authenticated web session. On an anonymous same-origin <img>/CSS-background fetch the browser attaches it; the filter verifies the signature and trusts the named user WITHOUT the session-on-IP cross-check the current cookie needs (the signature proves it was minted inside that user's real session).
- **Coverage:** Web browsers only — native TV/mobile clients keep no shared cookie jar and don't send it on image requests.
- **Trust tier:** authoritative for web (unforgeable, self-authenticating), vs the current cookie's 'strong only when a session is on the IP'.
- **Misattribution risk:** Low. Cannot be forged without the server secret. Residual: two humans sharing one browser profile — the cookie reflects the last login, so the earlier user's cached posters could be scored under the later user. Bounded to genuine profile-sharing (same risk class as any browser-scoped signal).
- **Cost:** Low — HMAC sign/verify + a secret in plugin config; drop-in replacement for the existing cookie path.
- **Vs current ladder:** beats tier 3 for web — removes the IP-session dependency so it still works when no session is currently on the IP (e.g. quietly scrolling long after last activity).
- **Evaluator:** A clean, cheap, unforgeable upgrade of tier-3 that removes the session-on-IP dependency without introducing a guarding-user-clean leak (a stale cookie only over-blurs an anonymous viewer), but its value is capped because tier-2 markers already resolve web on every tagged request — it only helps untagged web fetches like CSS backgrounds.

## If-None-Match marker fallback (read the marker back off the echoed ETag)
*Lens:* http-protocol · *Verdict:* **complement** (feasibility 5/5, value 1/5)

- **Mechanism:** The server echoes the supplied ?tag= as the ETag, so on conditional revalidation clients send If-None-Match: "…-jeu{12hex}". Parse the SAME per-user marker from If-None-Match as a second carrier in addition to ?tag=. Covers revalidation requests where a shared/CDN cache satisfied the body and only the conditional GET reached origin, or any path where the query tag was dropped but the validator survived.
- **Coverage:** Any HTTP-caching client on the 304 revalidation path — web and native alike (all send If-None-Match once an ETag is cached).
- **Trust tier:** strong disambiguation (identical to the marker tier — same token, different header).
- **Misattribution risk:** None beyond the existing marker tier — it is literally the same value the marker tier already trusts, just read from a second header.
- **Cost:** Trivial — a few lines added to the existing marker parse in Resolve().
- **Vs current ladder:** complements tier 2 — pure robustness/coverage add on the revalidation path; strictly dominated by nothing, dominates nothing.
- **Evaluator:** It is the same trusted marker read from a second header so it carries zero new misattribution risk and costs a few lines, but no known client drops ?tag= while keeping the validator, so its marginal real-world coverage is near-zero.

## ETag seeding (stamp a per-user token into the ETag we emit)
*Lens:* http-protocol · *Verdict:* **reject** (feasibility 2/5, value 1/5)

- **Mechanism:** For a request we CAN identify (via any tier) but that arrived without a stamped tag, emit a response ETag containing the per-user marker. The client caches it and, on its next revalidation of that image, returns it in If-None-Match — attributing a future request that would otherwise be anonymous. Extends the marker channel to clients that fetch image URLs not built from a stamped DTO but that still do HTTP caching.
- **Coverage:** Caching clients whose image URLs weren't DTO-stamped (marginal — most native clients rebuild URLs from itemId+tag and already carry the marker there); mainly a resilience net.
- **Trust tier:** strong disambiguation (marker-equivalent once echoed).
- **Misattribution risk:** Low-medium — a shared HTTP cache (CDN/browser profile) could hand one user's seeded ETag to another user's revalidation. Only safe where the cache is per-client (private). Gate to private-cache responses (Cache-Control: private) to avoid cross-user validator bleed.
- **Cost:** Medium — response-side ETag rewriting on the image path plus cache-scope discipline.
- **Vs current ladder:** complements tier 2 in narrow cases; largely redundant with the existing tag marker since native clients already echo the tag — keep only if a real client is found that drops ?tag= but caches.
- **Evaluator:** Dominated by the marker (native clients already echo it), and to make a seeded ETag ever revalidate you must disable the 365-day immutable image caching the tag exists to enable, while shared/CDN caches risk poisoning one user's validator onto another user's revalidation → leak.

## Kestrel Connection.Id → user correlation (direct-connection only)
*Lens:* http-protocol · *Verdict:* **reject** (feasibility 2/5, value 0/5)

- **Mechanism:** Record HttpContext.Connection.Id→userId when an authenticated request rides a connection, then attribute later anonymous image requests on the SAME Kestrel connection id (HTTP/1.1 keep-alive or a coalesced HTTP/2/3 connection from one client). Concrete handle for the otherwise-abstract 'connection correlation'.
- **Coverage:** Clients connecting DIRECTLY to Kestrel (no reverse proxy) with connection reuse — web and native.
- **Trust tier:** authoritative for direct connections; collapses to useless behind a proxy.
- **Misattribution risk:** High and disqualifying behind a proxy: the proxy multiplexes many clients over a few pooled upstream connections (especially HTTP/2), so one connection id maps to several users → a guarded user's connection shared with an unguarded one leaks. Only safe when you can prove no proxy sits in front (which you generally can't from inside the plugin).
- **Cost:** Low to read Connection.Id; high to make safe (needs a reliable 'am I directly exposed?' signal).
- **Vs current ladder:** rejected/dominated — this is the previously-rejected TCP-connection correlation named at the Kestrel primitive; the proxy-pooling failure mode stands. Note only that Connection.Id is the concrete API if a direct-only deployment is ever guaranteed.
- **Evaluator:** This is the already-rejected TCP-correlation idea named at the Kestrel API: proxies pool/multiplex upstream connections across clients (the exact deployment being fixed) so one Connection.Id maps to several users → leak, and the plugin cannot reliably prove no proxy is in front.

## Device-signature correlation against SessionInfo (UA + sec-ch-* + Accept + Accept-Encoding + Range)
*Lens:* http-protocol · *Verdict:* **reject** (feasibility 3/5, value 0/5)

- **Mechanism:** Build a fingerprint from User-Agent, sec-ch-ua/-platform/-mobile, Accept ordering (image/avif,image/webp,…), Accept-Encoding, and Range-request shape, then match it against the Client/DeviceName/ApplicationVersion recorded on the sessions-on-IP to narrow WHICH of several shared-IP candidates issued this image request (e.g. the Android TV session vs the browser session).
- **Coverage:** Shared-IP multi-user case where the candidates use visibly different device classes.
- **Trust tier:** weak narrowing.
- **Misattribution risk:** High for the fail-closed blur use case, in a subtle way: fail-closed blur must blur if ANY candidate guarded the item, so NARROWING the candidate set can REMOVE the guarding user and hand clean bytes → the forbidden accidental misattribution. Two identical devices are also indistinguishable. Safe only to CONFIRM inclusion, never to exclude.
- **Cost:** Medium — fingerprint extraction plus matching against session metadata.
- **Vs current ladder:** dominated for blur — the ladder's rejection of UA fingerprinting holds; set-narrowing is actively unsafe for a fail-closed consumer. Could help only a fail-OPEN consumer that wants a single best guess.
- **Evaluator:** Narrowing a fail-closed candidate set can drop the guarding user and hand clean bytes (the forbidden misattribution), and the actual problem clients (okhttp/CFNetwork/Roku, no sec-ch-*) are too coarse to distinguish two identical devices anyway.

## Accept-Language → user language-preference narrowing
*Lens:* http-protocol · *Verdict:* **reject** (feasibility 3/5, value 0/5)

- **Mechanism:** Compare the request's Accept-Language against each shared-IP candidate's Jellyfin display/audio/subtitle language preference to down-rank candidates whose locale doesn't match.
- **Coverage:** Shared-IP households with users of different languages.
- **Trust tier:** weak narrowing.
- **Misattribution risk:** High — device locale ≠ Jellyfin language pref, many users share a language, and (as above) narrowing a fail-closed set can drop the guarding user → leak. Only a soft ranking signal at best.
- **Cost:** Low.
- **Vs current ladder:** dominated — never authoritative, unsafe to narrow with; not worth the correlation code.
- **Evaluator:** Device locale ≠ Jellyfin language preference and many users share a language, so it is never authoritative and its only use — narrowing — is exactly the unsafe operation that can drop the guarding user from a fail-closed set.

## Signed capability token carried inside the tag value (promote marker toward authoritative)
*Lens:* http-protocol · *Verdict:* **reject** (feasibility 3/5, value 1/5)

- **Mechanism:** Make the per-user marker a compact signed/opaque capability (HMAC over userId+expiry) instead of a lookup handle, still embedded in the ?tag= value so native clients echo it verbatim. Where the plugin controls FULL image-URL construction (web), the same token can instead ride as a real ?ApiKey= ephemeral, image-scoped token so the request authenticates as the user (tier 1) end-to-end.
- **Coverage:** In the tag: all clients (native included). As ?ApiKey= ephemeral token: web only — native clients rebuild URLs from itemId+tag and won't echo arbitrary extra query params, so they stay in the tag/disambiguation channel.
- **Trust tier:** strong disambiguation in the tag; authoritative for web when promoted to an ApiKey ephemeral token.
- **Misattribution risk:** Low — signing prevents forging a valid other-user token. Do NOT use the user's real access token in an <img> src (leaks via Referer/logs/caches, violates secret-handling rules); mint a narrow short-lived image-only token.
- **Cost:** Low-medium — token mint/verify + config secret; reuses the existing stamping path.
- **Vs current ladder:** complements/beats tier 2 marginally — the current hex marker is already effectively an unguessable bearer handle, so the win is mainly the web ApiKey promotion to true tier-1 auth; low priority unless downstream Jellyfin also needs to see the user.
- **Evaluator:** Dominated: the threat model already makes forgery harmless (self-spoil only) so signing buys nothing, while an expiry breaks the deterministic-marker guarantee that keeps native image caches valid; the ?ApiKey= web promotion needs an image-scoped ephemeral token Jellyfin doesn't provide and risks leaking a full token via <img> Referer/logs.

## TLS-layer fingerprint / session-resumption correlation (JA3, session ticket/ID)
*Lens:* http-protocol · *Verdict:* **reject** (feasibility 0/5, value 0/5)

- **Mechanism:** If TLS terminates at Kestrel, correlate an anonymous image request to a prior authenticated request by a JA3-style ClientHello fingerprint or a resumed TLS session ID/ticket (same TLS session ⇒ same client), mapping tlsSession→user.
- **Coverage:** Only deployments where Kestrel terminates TLS directly (no TLS-terminating proxy) — rare for media servers.
- **Trust tier:** strong for resumption (same TLS session is genuinely one client); weak for JA3 alone (per-library, identical apps collide).
- **Misattribution risk:** High in practice because almost all deployments terminate TLS at the proxy, so Kestrel sees plaintext with no ClientHello — the signal simply isn't present; JA3 collisions among identical clients would misattribute.
- **Cost:** High — ASP.NET doesn't surface raw ClientHello/JA3 without custom Kestrel middleware; session-ticket exposure is limited.
- **Vs current ladder:** rejected — dominated by proxy termination; only a wild-card for a bare Kestrel deployment, and even then session-resumption is the only trustworthy part.
- **Evaluator:** Self-defeating: the signal is absent exactly where the problem lives (TLS terminates at the reverse proxy, so Kestrel sees plaintext) and unreachable from a plugin even in a bare-Kestrel deployment (raw ClientHello/JA3 and resumption IDs need a host-time Kestrel TLS callback a plugin cannot install), while JA3 collisions among identical devices would unblur guarded art.

## mTLS client certificate (HttpContext.Connection.ClientCertificate)
*Lens:* http-protocol · *Verdict:* **reject** (feasibility 1/5, value 0/5)

- **Mechanism:** If a deployment provisions per-device client certificates, read the presented cert to identify the device (and map device→user) authoritatively.
- **Coverage:** Essentially none for stock media clients — Android TV/Swiftfin/Roku don't present client certs; only bespoke enterprise setups.
- **Trust tier:** authoritative where present.
- **Misattribution risk:** None where present (cryptographic); N/A otherwise because the signal is absent.
- **Cost:** Low to read; unrealistic to deploy across stock clients.
- **Vs current ladder:** dominated by non-existence — list for completeness only; no path to stock-client coverage.
- **Evaluator:** Authoritative but present nowhere relevant - stock ATV/Swiftfin/Roku present no client cert, a plugin can't make Kestrel negotiate one, and a TLS-terminating proxy hides any cert; where it could exist you'd already have full token auth.

## sec-fetch-*/Referer/Origin surface classification (gating, not attribution)
*Lens:* http-protocol · *Verdict:* **complement** (feasibility 5/5, value 1/5)

- **Mechanism:** Use sec-fetch-dest:image, sec-fetch-site:same-origin, Referer/Origin, and DNT/Save-Data to CLASSIFY a request (web-app image load vs native fetch vs external hotlink) rather than to name a user — e.g. to decide which downstream tier to trust or to suppress the shared-IP warning for obvious web-app loads.
- **Coverage:** Web (rich sec-fetch/Referer), coarse signal only.
- **Trust tier:** weak narrowing (classification support, no user identity).
- **Misattribution risk:** None on its own — it never selects a user; risk only arises if a downstream tier over-trusts its classification.
- **Cost:** Trivial.
- **Vs current ladder:** complements as plumbing — can reduce log noise and route requests to the right existing tier, but carries zero user-attribution power itself.
- **Evaluator:** Trivially readable but names no user and is web-only (native okhttp/CFNetwork/Roku image GETs carry no sec-fetch/Referer), so over a ladder that already fails closed it buys only optional log-noise/routing plumbing and only if no downstream tier over-trusts its classification.

## ClaimsPrincipal / IAuthorizationContext token extraction (ladder tier 1)
*Lens:* jellyfin-internals · *Verdict:* **complement** (feasibility 5/5, value 1/5)

- **Mechanism:** On JF12 the default auth middleware runs even on anonymous endpoints: a `MediaBrowser ... Token=` Authorization header or `?ApiKey=` query param populates HttpContext.User with Jellyfin-UserId/Jellyfin-DeviceId claims. The plugin can also call IAuthorizationContext.GetAuthorizationInfo(HttpContext) directly in the filter to catch credentials on routes where policy binding didn't materialize a principal, and IDeviceManager.GetDevices(new DeviceQuery{AccessToken=...}) to resolve a raw token to a device/user.
- **Coverage:** Any client that DOES send credentials on the image/media request. Verified today only Android mobile's native ImageProvider (launcher tiles) does so; ATV/Swiftfin/Roku/web send nothing on image GETs.
- **Trust tier:** authoritative
- **Misattribution risk:** None (server-validated token). Only failure is absence of credentials, which falls through.
- **Cost:** Trivial — already the tier-1 path; adding an explicit GetAuthorizationInfo belt-and-suspenders call is a few lines.
- **Vs current ladder:** complements — it IS tier 1; the explicit IAuthorizationContext call is a cheap hardening that catches ApiKey-in-query cases a bare ClaimsPrincipal read might miss.
- **Evaluator:** This IS the incumbent authoritative tier and cannot misattribute, but the explicit GetAuthorizationInfo/IDeviceManager call is marginal because JF12's default auth middleware already populates ClaimsPrincipal from the MediaBrowser header/?ApiKey= on anonymous routes - gate any explicit call on token-present so it doesn't add a per-image DB lookup.

## Per-user identity marker in ?tag= (ladder tier 2, shipped)
*Lens:* jellyfin-internals · *Verdict:* **complement** (feasibility 5/5, value 5/5)

- **Mechanism:** SpoilerIdentityTagFilter appends `-jeu{12hex}` (unkeyed SHA-256 prefix of userId) to every image-tag field of authenticated per-user DTO responses, re-keying ImageBlurHashes in lockstep. Every client echoes the tag verbatim into ?tag= on the anonymous image GET (no client invents URLs). Resolver decodes ?tag= -> user with no IP involvement.
- **Coverage:** Every client and surface that renders artwork from a DTO tag: web, Android TV, Android mobile, Swiftfin, Roku. Proxy-proof.
- **Trust tier:** strong disambiguation
- **Misattribution risk:** Very low. A stale marker (deleted user) or collision fails to resolve and falls back to the IP ladder — never mis-resolves. 48-bit collisions are dropped at map-build. Forgery only self-spoils (acceptable).
- **Cost:** Already implemented and live-verified end-to-end.
- **Vs current ladder:** is the ladder's decisive tier — beats every IP-based approach for the native-behind-proxy problem this project set out to fix.
- **Evaluator:** Incumbent load-bearing tier that actually solved native-behind-proxy attribution and survives adversarial review - unknown/collision markers fall through to the IP ladder (never mis-resolve) and forgery only self-spoils, which the threat model permits.

## Marker extension to other DTO-controlled anonymous URLs (subtitle Stream, trickplay tiles, lyrics, {tag} path segment)
*Lens:* jellyfin-internals · *Verdict:* **complement** (feasibility 2/5, value 2/5)

- **Mechanism:** Confirmed anonymous surfaces beyond images carry DTO-controlled free-form fields: `Videos/{itemId}/{mediaSourceId}/Subtitles/{index}/Stream.{format}` (no [Authorize]) and trickplay tile URLs. The mediaSourceId, a query param, or the templated {tag} path segment (route Items/{itemId}/Images/{imageType}/{imageIndex}/{tag}/...) are all values the plugin can stamp with the same `-jeu` marker in the authenticated DTO/PlaybackInfo response, and decode on the anonymous fetch.
- **Coverage:** Subtitle sidecar fetches, trickplay/BIF hover images, lyrics — the tagless anonymous surfaces the current image-tag filter doesn't touch.
- **Trust tier:** strong disambiguation
- **Misattribution risk:** Same fail-safe as tier 2: unrecognized marker -> IP ladder. Risk is only mis-stamping a shared/cacheable URL, mitigated by idempotent AppendMarker.
- **Cost:** Medium — new stamp sites + decode sites per surface; must verify each client echoes the stamped field (subtitle mediaSourceId is echoed; trickplay tag is echoed).
- **Vs current ladder:** complements tier 2 — closes the non-image anonymous surfaces the marker doesn't yet cover.
- **Evaluator:** Conditional at best: its headline vector (stamping the functional mediaSourceId on subtitle URLs) risks breaking playback because that id is a server lookup key, not a cosmetic tag like ?tag=; the {tag} path segment is redundant with the shipped ?tag= marker, and trickplay/lyrics stampability-plus-client-echo is unverified, so pursue only the cosmetic, per-surface-verified subset.

## PlaySessionId -> user registry
*Lens:* jellyfin-internals · *Verdict:* **complement** (feasibility 3/5, value 2/5)

- **Mechanism:** PlaybackInfo (authenticated, per-user) mints a PlaySessionId the client then echoes on stream/subtitle/progress URLs. The plugin subscribes to playback-start (ISessionManager events) or intercepts PlaybackInfo to register PlaySessionId -> userId in its own map, then resolves any anonymous playback-adjacent request carrying that id. Server-minted, so unforgeable-by-guess.
- **Coverage:** Active-playback surfaces (anonymous subtitle Stream, trickplay during scrub) that carry PlaySessionId. Not idle library browsing.
- **Trust tier:** authoritative (server-minted id, bound to the authenticated session that requested it)
- **Misattribution risk:** Low — id is opaque and single-user-bound; expiry on playback-stop prevents stale reuse. Only risk is a client reusing a PlaySessionId across users on shared device (rare).
- **Cost:** Medium — event subscription + TTL map + decode wiring.
- **Vs current ladder:** complements — an authoritative signal for the playback window where the tag marker may be absent; higher trust than tag but narrower coverage.
- **Evaluator:** Server-minted and authoritative for the playback window, but its coverage (anonymous subtitle/trickplay during active playback) is a strict subset of the tag marker's, it needs an event-subscription + TTL map to build, and the spoiler-critical surface (posters during idle browsing) is exactly when PlaySessionId is absent, so it hardens a narrow already-covered slice.

## jc-spoiler-uid browser cookie, session-on-IP validated (ladder tier 3, shipped)
*Lens:* jellyfin-internals · *Verdict:* **complement** (feasibility 5/5, value 2/5)

- **Mechanism:** Web client JS sets a per-browser cookie; browsers attach it to same-origin anonymous <img>/CSS-background fetches. Trusted only to disambiguate among users that actually hold a session on the request IP.
- **Coverage:** Web and Android-mobile WebView UI only (they ARE jellyfin-web). Native TV/Swiftfin/Roku send no cookies.
- **Trust tier:** strong disambiguation (web)
- **Misattribution risk:** Low — a cookie naming a user with no session on the IP is rejected (with fresh-login re-scan + F8 negative cache). Can't select an absent user.
- **Cost:** Shipped.
- **Vs current ladder:** complements — the web-specific tier; dominated by the tag marker where both apply, retained for image requests that somehow lack a marker.
- **Evaluator:** Incumbent web-only tier mostly dominated by the marker and retained for marker-less web images; session-on-IP validation blocks selecting an absent user, but a stale cookie from a prior user on a shared browser is a residual accidental-misattribution edge that must stay bounded by rewriting the cookie before the first image load.

## Server-set signed cookie via Set-Cookie on authenticated responses
*Lens:* jellyfin-internals · *Verdict:* **reject** (feasibility 4/5, value 1/5)

- **Mechanism:** Instead of relying on client JS, emit Set-Cookie (HMAC-signed uid) from a response filter on any authenticated response, so cookie-jar clients carry it without JS. Signature removes the session-on-IP dependency.
- **Coverage:** Web + Android WebView + any client with a cookie jar. Confirmed NOT ATV/Swiftfin/Roku (no cookie jar on image requests).
- **Trust tier:** strong disambiguation (cookie-capable clients)
- **Misattribution risk:** Low if signed; unsigned would let a copied cookie mis-select, so must HMAC.
- **Cost:** Low-medium.
- **Vs current ladder:** dominated — for the clients it reaches, the tag marker already works without cookies; adds resilience only where JS is disabled. Marginal.
- **Evaluator:** Dominated: every cookie-jar client it reaches (web, Android WebView) is already resolved precisely by the ?tag= marker, and it cannot reach the credential-less native TV/Swiftfin/Roku clients that are the actual problem, so it only marginally hardens an already-covered path.

## Session-by-IP candidate set (ladder tier 4, shipped)
*Lens:* jellyfin-internals · *Verdict:* **complement** (feasibility 5/5, value 0/5)

- **Mechanism:** Enumerate ISessionManager.Sessions, match SessionInfo.RemoteEndPoint to the request's transport IP, return all users with a session on that IP as a fail-closed candidate set.
- **Coverage:** All clients — but collapses to everyone behind a reverse proxy that hides the client IP (the core problem).
- **Trust tier:** weak narrowing
- **Misattribution risk:** Fail-closed by design (blur if ANY candidate guards). The danger is over-blur (other users see blur), never under-blur, so it never leaks a guarding user's clean bytes.
- **Cost:** Shipped.
- **Vs current ladder:** complements as the safety floor — dominated by marker/cookie for precision but retained because it never mis-attributes toward clean.
- **Evaluator:** This is the shipped fail-closed safety floor — it can over-blur but never hands a guarding user clean bytes — so it is retained as the baseline, with zero value *over* the ladder because it *is* the ladder's floor.

## Plugin-level X-Forwarded-For / Forwarded / X-Real-IP with learned real-IP -> user map
*Lens:* jellyfin-internals · *Verdict:* **complement** (feasibility 4/5, value 3/5)

- **Mechanism:** Even with Jellyfin's KnownProxies empty, Caddy/Traefik/nginx still put the real client IP in XFF/Forwarded/X-Real-IP. The plugin reads it directly (core ignores it), builds its own map of realClientIP -> userId from AUTHENTICATED requests' forwarded headers, then resolves an anonymous image request by its own forwarded header. Sessions record the proxy IP, so this needs a plugin-owned map, not SessionInfo matching.
- **Coverage:** All native clients behind an XFF-emitting proxy — the exact deployment that breaks tier 4. Fills tagless surfaces the marker doesn't reach.
- **Trust tier:** strong disambiguation (when transport IP is a known/learned proxy) / weak otherwise
- **Misattribution risk:** Client can forge XFF. Safe direction: forging your OWN request's XFF to match another user only self-spoils; it cannot make a DIFFERENT (guarding) user receive clean bytes. Keep it narrowing-only and fall back to the union when XFF disagrees with the session set. Do NOT trust XFF when transport RemoteIp is not a recognized proxy.
- **Cost:** Medium — header parsing, proxy-trust gate, learned map with TTL/eviction.
- **Vs current ladder:** complements — the primary gap-filler for anonymous non-tag surfaces behind proxy; turns tier 4's shared-IP blob into per-real-IP resolution without needing a marker.
- **Evaluator:** The only proposed mechanism that actually resolves the proxy-hidden-IP blob for tagless/stale surfaces, but IP reassignment within its TTL can make map[realIp] name a stale user, so it is only safe as a fail-closed union that never narrows below the transport-IP session set — it must complement, not replace, tier 4.

## Websocket-connect XFF capture feeding the real-IP map
*Lens:* jellyfin-internals · *Verdict:* **complement** (feasibility 4/5, value 2/5)

- **Mechanism:** The websocket upgrade is an AUTHENTICATED request carrying both the token (=> user) and the proxy's XFF (=> real client IP). Capturing (realIp -> user) at ws-connect yields a high-trust map entry that does not depend on trusting any later image-request header for the user side — only the image request's XFF is matched against it.
- **Coverage:** Any client that opens a websocket (web, ATV, Swiftfin all do) behind an XFF proxy.
- **Trust tier:** strong disambiguation
- **Misattribution risk:** Same forge-only-self-spoil property as the XFF map. Stale entries mitigated by ws-disconnect eviction.
- **Cost:** Low-medium — hook ISessionManager connect events or a middleware on the ws path.
- **Vs current ladder:** complements / strengthens the XFF map — the most trustworthy way to populate real-IP -> user.
- **Evaluator:** A cleaner, higher-trust way to seed idea 3's real-IP->user map (the user comes from the authenticated ws token, not a trusted image header, and disconnect gives clean eviction), but it is largely subsumed by populating that same map from all authenticated requests' rightmost XFF entry.

## IDeviceManager deviceId -> user
*Lens:* jellyfin-internals · *Verdict:* **reject** (feasibility 5/5, value 0/5)

- **Mechanism:** Map Jellyfin deviceId to userId via the device registry; resolve any request carrying a deviceId (X-Emby-Device-Id header or ?deviceId=).
- **Coverage:** Only surfaces that carry deviceId. Verified anonymous image GETs carry NO deviceId on any client; some [Authorize] audio-HLS URLs do.
- **Trust tier:** authoritative where present
- **Misattribution risk:** None (registry-backed), but essentially no coverage on the problem requests.
- **Cost:** Low.
- **Vs current ladder:** dominated — the surfaces that carry deviceId are already [Authorize] and resolve at tier 1; adds nothing for anonymous images.
- **Evaluator:** No coverage: verified anonymous image GETs carry no deviceId on any client, and the surfaces that do carry it are already [Authorize] and resolve at tier 1, so it adds nothing to the problem requests.

## Active TranscodingJob correlation (PlaySessionId / deviceId / path -> user)
*Lens:* jellyfin-internals · *Verdict:* **reject** (feasibility 3/5, value 0/5)

- **Mechanism:** During playback the server holds a live TranscodingJob keyed by PlaySessionId, deviceId and output path. The plugin could look up an anonymous request against active jobs to recover the owning session/user.
- **Coverage:** Transcode output segments and sidecars during active playback.
- **Trust tier:** strong (server-owned job state)
- **Misattribution risk:** Low; jobs are single-session. Risk only if a job outlives the session in the map.
- **Cost:** Medium — reach ITranscodeManager job table.
- **Vs current ladder:** dominated — transcode segment endpoints are [Authorize] (resolve at tier 1); overlaps PlaySessionId registry with narrower reach.
- **Evaluator:** Dominated and off-target: transcode segment endpoints are [Authorize] (tier 1) and this job-table correlation never touches the anonymous image endpoints that are the whole problem, while overlapping the PlaySessionId registry with narrower reach.

## User-Agent + Client/Device fingerprint narrowing vs SessionInfo
*Lens:* jellyfin-internals · *Verdict:* **reject** (feasibility 3/5, value 0/5)

- **Mechanism:** Match request UA/Client headers against SessionInfo.Client/DeviceName to shrink the fail-closed candidate set (e.g. the only Swiftfin session among web sessions on a shared IP).
- **Coverage:** All clients, as a candidate-set reducer only.
- **Trust tier:** weak narrowing
- **Misattribution risk:** HIGH if used to pick a single user — two identical devices (two Shield TVs -> okhttp/x.y.z) are indistinguishable, so collapsing to one would mis-attribute. Safe ONLY to remove impossible candidates, never to select.
- **Cost:** Low.
- **Vs current ladder:** complements tier 4 as a blast-radius reducer; must never be promoted to a single-user decision.
- **Evaluator:** For the fail-closed blur consumer any wrong *prune* shrinks the protective candidate set and leaks; UA/client strings don't reliably map to the requester (multi-device users, two identical Shields, UA != session-client), so even 'remove impossible candidates' can drop the actual guarding user — a forbidden misattribution.

## Passive request-shape fingerprint narrowing (requested dimensions/quality, Accept-Language, header order, TLS JA4)
*Lens:* jellyfin-internals · *Verdict:* **n/a** (feasibility ?/5, value ?/5)

- **Mechanism:** A TV requests different maxWidth/fillWidth/quality than a phone; Accept-Language, header ordering, or a proxy-provided TLS JA3/JA4 fingerprint further separate device classes. Use to narrow the shared-IP candidate set.
- **Coverage:** All clients, weakly; TLS fp needs proxy to inject it.
- **Trust tier:** weak narrowing
- **Misattribution risk:** HIGH if used to select. Identical devices/settings collide; only safe to prune impossible candidates.
- **Cost:** Low for dimensions/headers; high for TLS (proxy config).
- **Vs current ladder:** dominated / marginal complement — strictly weaker than UA narrowing with more false-precision temptation; keep narrowing-only if used at all.

## Websocket message-bus probe (push something that makes the client emit an identifiable request)
*Lens:* jellyfin-internals · *Verdict:* **n/a** (feasibility ?/5, value ?/5)

- **Mechanism:** ISessionManager can SendMessage/SendGeneralCommand to a session's websocket. Idea: push a per-session unique instruction and watch for a correlated HTTP request to attribute the connection's IP.
- **Coverage:** Sessions with an open websocket.
- **Trust tier:** weak narrowing (relies on timing correlation)
- **Misattribution risk:** HIGH — stock clients don't emit a uniquely-identifiable request in response to any push, so this degenerates into timing correlation across a shared proxy IP with concurrent users, which can unblur guarded art. Forbidden by the fail-closed rule.
- **Cost:** Medium, and speculative.
- **Vs current ladder:** rejected — no reliable induced signal from stock clients; only custom clients could honor it (see client-cooperation), and timing correlation is disqualified.

## ForceKeepAlive websocket ping to keep session RemoteEndPoint fresh
*Lens:* jellyfin-internals · *Verdict:* **reject** (feasibility 4/5, value 1/5)

- **Mechanism:** Periodically ping sessions so their RemoteEndPoint/LastActivity stays current, keeping tier-4 IP matching valid for quietly-scrolling users.
- **Coverage:** Sessions with a websocket.
- **Trust tier:** n/a (hardening, not identity)
- **Misattribution risk:** None — it only keeps existing IP matches from going stale.
- **Cost:** Low.
- **Vs current ladder:** complements tier 4 hardening; not a new identity signal (and the resolver already deliberately ignores activity windows, so value is small).
- **Evaluator:** Not an identity signal, and the resolver deliberately ignores activity windows (ScanActiveSessionUsers matches on IP regardless of recency), so freshness buys nothing and artificially kept-alive idle sessions only enlarge the shared-IP candidate set, worsening over-blur.

## ConnectionId / kept-alive TCP correlation
*Lens:* jellyfin-internals · *Verdict:* **reject** (feasibility 1/5, value 0/5)

- **Mechanism:** Map HttpContext.Connection.Id -> user on an authenticated request; anonymous requests on the same upstream TCP connection inherit it.
- **Coverage:** Direct connections only.
- **Trust tier:** rejected
- **Misattribution risk:** HIGH — nginx/Caddy pool upstream connections across downstream clients and HTTP/2 multiplexes many users onto few connections, exactly the proxy case; inheriting identity across pooled connections mis-attributes and can unblur.
- **Cost:** Low to try, but unsafe.
- **Vs current ladder:** rejected — unsafe precisely in the deployment we must fix.
- **Evaluator:** nginx/Caddy pool upstream connections across downstream clients and HTTP/2 multiplexes many users onto few connections, so inheriting identity across a connection mis-attributes and unblurs guarded art in exactly the reverse-proxy deployment this project must fix.

## Timing / NowPlaying activity correlation
*Lens:* jellyfin-internals · *Verdict:* **reject** (feasibility 1/5, value 0/5)

- **Mechanism:** Attribute an image burst to whichever session was browsing/playing around that timestamp, or to a session whose NowPlaying item matches the requested item's images.
- **Coverage:** All clients, statistically.
- **Trust tier:** rejected
- **Misattribution risk:** HIGH — concurrent users on a shared proxy IP, or two users viewing the same item, produce wrong attributions that unblur guarded art. Violates the no-accidental-misattribution constraint.
- **Cost:** Low to build, unacceptable to ship.
- **Vs current ladder:** rejected.
- **Evaluator:** Two concurrent users on a shared proxy IP, or two users viewing the same item, produce wrong attributions that hand clean bytes to a user who guarded the item, which the no-accidental-misattribution constraint categorically forbids.

## Client-cooperation identifying header (Plethorafin / own fork)
*Lens:* jellyfin-internals · *Verdict:* **complement** (feasibility 4/5, value 1/5)

- **Mechanism:** The user's own Android TV fork could attach an identifying header (signed uid/deviceId) to image requests; the plugin reads it.
- **Coverage:** Only clients the user controls; stock ATV/Swiftfin/Roku can't be updated server-side.
- **Trust tier:** authoritative (for cooperating clients, if signed)
- **Misattribution risk:** Low if signed; the gap is coverage, not correctness.
- **Cost:** Low on both ends, but requires shipping a client change.
- **Vs current ladder:** dominated as a general fix (marker already covers stock clients without cooperation); worthwhile only as bonus hardening for the user's own fork.
- **Evaluator:** Safe and authoritative for clients the user controls, but dominated by the tag marker, which already gives per-user identity for the only surface a server-shipped header could ever reach (Plethorafin echoes the stamped tag verbatim), so the tier upgrade is redundant given forgery merely self-spoils.

## ClaimsPrincipal from authenticated token (ladder tier 1, SHIPPED)
*Lens:* dto-echo-channels · *Verdict:* **complement** (feasibility 5/5, value 0/5)

- **Mechanism:** JF12's default-scheme auth middleware runs on anonymous endpoints too; a 'MediaBrowser ... Token=' header or ?ApiKey= query param populates HttpContext.User (Jellyfin-UserId claim). UserHelper.GetCurrentUserId reads it.
- **Coverage:** Any surface where the client sends credentials: authenticated API/DTO calls, and the one native path that does (Android mobile native ImageProvider launcher tiles, which send a full auth header). NOT the flagship anonymous image fetches from ATV/Swiftfin/Roku/web <img>.
- **Trust tier:** authoritative
- **Misattribution risk:** none — cryptographically tied to a real token/device.
- **Cost:** already shipped (zero).
- **Vs current ladder:** baseline — this IS tier 1. Everything else exists only because the problem clients send nothing here.
- **Evaluator:** This is the ladder's authoritative baseline (Resolve tier 1) already in production, so it has zero incremental value over a ladder it defines; every weaker tier exists precisely because the flagship anonymous image fetches send nothing here.

## Per-user image-tag marker echoed in ?tag= (A2, ladder tier 2, SHIPPED)
*Lens:* dto-echo-channels · *Verdict:* **adopt-candidate** (feasibility 5/5, value 5/5)

- **Mechanism:** Response filter suffixes every image tag in authenticated DTOs with '-jeu{12hex}' (short hash of userId). Clients copy the tag verbatim into ?tag= on the anonymous image GET; the image filter parses ?tag=, resolves marker->user via an IUserManager-derived map. No IP, no client change.
- **Coverage:** EVERY client that builds image URLs from DTO tags: web, Android TV, Swiftfin, Roku, Android mobile. Verified all 5 echo the tag. This is the only reliable per-user channel for anonymous image bytes.
- **Trust tier:** strong disambiguation (not authentication — resolves to a user for policy choice, never grants access).
- **Misattribution risk:** Very low. Stale marker (deleted user, pre-update cached URL) resolves to nobody and falls through to IP ladder. A forged marker only self-spoils (opts sender into another user's blur policy for content they could already reach anonymously). Collision of the 12-hex short hash across two real users is the only accidental-misattribution vector -> keep width high / verify no collisions at mint time.
- **Cost:** shipped. Ongoing: must keep the marker composed with the strip filter's 'sb-' cache-bust prefix and re-key ImageBlurHashes in lockstep.
- **Vs current ladder:** IS the ladder's decisive tier. Beats every IP-based approach: proxy-proof, per-user-precise, needs no proxy config or client cooperation.
- **Evaluator:** The decisive proxy-proof, per-user, zero-client-cooperation channel — already shipped and verified end-to-end on web and native Android TV through a misconfigured proxy — dominating every IP-based approach, with the only residual misattribution vector (48-bit marker collision) closed by mint-time collision detection and the stale-marker case failing safe to the IP ladder.

## Read the marker from the tag-in-PATH route, not just ?tag= (echo-surface completeness)
*Lens:* dto-echo-channels · *Verdict:* **n/a** (feasibility ?/5, value ?/5)

- **Mechanism:** The GetItemImage2 route bakes the tag into the URL path: Items/{id}/Images/{type}/{index}/{tag}/{format}/{maxWidth}/{maxHeight}/{percentPlayed}/{unplayedCount}. Any client using this positional form carries the '-jeu' marker in a path segment, not the query. Parse that segment as an additional marker source.
- **Coverage:** Older/alternate clients and any surface that emits the positional image route (some Emby-lineage builders, certain Roku/legacy paths).
- **Trust tier:** strong disambiguation (identical trust to the ?tag= marker).
- **Misattribution risk:** none beyond the base marker's; it is the same value in a different position.
- **Cost:** tiny — add a path-segment parse alongside the existing query parse in RequestIdentityService tier 2.
- **Vs current ladder:** complements tier 2 — closes a gap where a client puts the tag in the path and omits ?tag=, which would otherwise drop to the IP ladder.

## Stamp ALL tag-bearing DTO fields + chapter + channel tags (marker coverage completeness)
*Lens:* dto-echo-channels · *Verdict:* **complement** (feasibility 5/5, value 1/5)

- **Mechanism:** BaseItemDto exposes ~12 image-tag fields (ImageTags, BackdropImageTags, ScreenshotImageTags, ParentBackdropImageTags, AlbumPrimaryImageTag, SeriesPrimaryImageTag, ParentLogoImageTag, ParentArtImageTag, SeriesThumbImageTag, ParentThumbImageTag, ParentPrimaryImageTag, ChannelPrimaryImageTag) plus ChapterInfo.ImageTag. Stamp the marker into every one, across ALL DTO routes (incl. Sessions/Channels/LiveTv/Genres/Persons/Studios/Artists/InstantMix/UserViews/Trailers), not just the strip filter's spoiler-scoped allowlist.
- **Coverage:** Parent/series/album/season poster fetches, chapter thumbnails, channel logos, person/studio art — every anonymous image request whose tag came from a currently-unstamped field.
- **Trust tier:** strong disambiguation (extends the same channel).
- **Misattribution risk:** A field left unstamped isn't a misattribution — it silently falls through to the IP ladder (fail-closed). The risk is under-protection (leak), not wrong-user. Re-keying ImageBlurHashes per field is mandatory or blurhash placeholders break (cosmetic, not identity).
- **Cost:** medium — broaden the response filter's field list and route allowlist; audit each field maps to an endpoint that actually reads ?tag=.
- **Vs current ladder:** complements/completes tier 2 — without it, a large fraction of image surfaces never reach the marker tier and rely on ambiguous IP.
- **Evaluator:** Already essentially shipped — SpoilerIdentityTagFilter is a global MVC filter with no route allowlist and StampItem already stamps all ~12 fields + chapters + search hints + recommendations with blurhash re-keying, so the only residual is auditing for unhandled DTO wrapper shapes; it cannot misattribute (an unstamped field just falls to the fail-closed IP tier).

## Trickplay tile parameters as a covert marker (LENS candidate — REJECTED)
*Lens:* dto-echo-channels · *Verdict:* **n/a** (feasibility ?/5, value ?/5)

- **Mechanism:** TrickplayInfoDto carries Width/TileWidth/TileHeight/Interval/ThumbnailCount/Bandwidth, echoed into the tiles.m3u8 and {index}.jpg URLs. In principle these could encode identity.
- **Coverage:** would cover trickplay scrub-strip image requests (anonymous).
- **Trust tier:** n/a.
- **Misattribution risk:** n/a — the values are semantically load-bearing integers: the width must match a real generated resolution, tile geometry/interval must match the actual sprite sheet. Perturbing them to carry bits corrupts scrubbing thumbnails for everyone.
- **Cost:** n/a.
- **Vs current ladder:** rejected — the task flags trickplay tile counts/intervals, but they are not free-form: no spare entropy to carry a marker without breaking the feature. Only the item id and (already-used) tag are safely markable in image-family URLs.

## ETag / If-None-Match echo marker (LENS candidate)
*Lens:* dto-echo-channels · *Verdict:* **n/a** (feasibility ?/5, value ?/5)

- **Mechanism:** MediaSourceInfo.ETag / BaseItemDto.Etag are echoed by clients as If-None-Match on conditional revalidation GETs. Embed a per-user marker in the ETag and read the request's If-None-Match.
- **Coverage:** Only requests that revalidate (second+ load of a cached image), and only clients that send If-None-Match on image fetches.
- **Trust tier:** weak narrowing.
- **Misattribution risk:** Low but the timing is wrong: native clients rarely send If-None-Match on FIRST paint (when blur matters most), and JF12 echoes the supplied tag into ETag verbatim, muddying the channel.
- **Cost:** medium.
- **Vs current ladder:** dominated by the ?tag= marker — same clients already carry the marker in ?tag= on first load; ETag adds nothing and covers strictly fewer moments.

## Upgrade the marker to an HMAC-signed identity token (trust-tier elevation)
*Lens:* dto-echo-channels · *Verdict:* **n/a** (feasibility ?/5, value ?/5)

- **Mechanism:** Replace the unkeyed 12-hex lookup marker with an HMAC(secret, userId|itemId|expiry) blob minted into the tag inside the user's authenticated DTO. A matching marker on an image request is then cryptographically provable to have been minted by the server for that user.
- **Coverage:** same surfaces as the shipped marker (every tag-echoing client).
- **Trust tier:** authoritative (elevates tier 2 from disambiguation to proof-of-identity).
- **Misattribution risk:** eliminates the short-hash collision vector entirely; forgery becomes infeasible rather than merely harmless.
- **Cost:** medium — introduce a persisted server secret + HMAC util (none exist in-repo today) and a longer tag; validate cache-header behavior with longer tags.
- **Vs current ladder:** beats the current marker on trust IF identity is ever reused for access-control features. For Spoiler Guard alone it is not required (threat model says forgery only self-spoils), so it is a strategic upgrade, not a correctness fix.

## jc-spoiler-uid cookie validated against session-on-IP (ladder tier 3, SHIPPED)
*Lens:* dto-echo-channels · *Verdict:* **n/a** (feasibility ?/5, value ?/5)

- **Mechanism:** Web client sets a per-browser cookie on load; browsers attach it to same-origin anonymous <img>/CSS-background fetches. Trusted only to pick among users who actually have a session on the request IP.
- **Coverage:** Web browsers only (and Android mobile WebView UI, which is jellyfin-web). Native TV/mobile send no cookies.
- **Trust tier:** strong disambiguation for web (session-on-IP gated).
- **Misattribution risk:** Low — a stale/forged cookie naming an absent user is rejected by the session-on-IP check and falls through. Negative-cached to avoid scan storms. Residual risk only if two cookie'd users share an IP AND one forges the other's uid, which merely self-spoils.
- **Cost:** shipped.
- **Vs current ladder:** complements — covers web precisely; useless for the native-client problem the marker solves.

## Session-by-IP candidate set, fail-closed (ladder tier 4, SHIPPED)
*Lens:* dto-echo-channels · *Verdict:* **n/a** (feasibility ?/5, value ?/5)

- **Mechanism:** Enumerate ISessionManager.Sessions whose RemoteEndPoint IP equals the request IP; return ALL as candidates. Fail-closed consumers blur if ANY candidate guards the item.
- **Coverage:** Every anonymous request as a last resort; precise only when the IP is unshared.
- **Trust tier:** weak narrowing (ambiguous behind NAT / IP-hiding proxy).
- **Misattribution risk:** Does NOT misattribute in the forbidden direction: over-inclusion causes over-blur (safe), never under-blur. Uses the full IP-session set (not a recent-activity window) precisely so a quietly-scrolling opted-in user can't age out and leak.
- **Cost:** shipped.
- **Vs current ladder:** the safety net beneath the ladder — collapses to one candidate set behind IP-hiding proxies, which is exactly what the marker and XFF ideas exist to fix.

## Plugin-level X-Forwarded-For -> learned realIp->user map (A3, UNDER CONSIDERATION)
*Lens:* dto-echo-channels · *Verdict:* **n/a** (feasibility ?/5, value ?/5)

- **Mechanism:** Read XFF/X-Real-IP/Forwarded directly in the plugin even though JF12 ignores them without Known Proxies. Build a map of realClientIP->user from XFF seen on AUTHENTICATED requests, then match anonymous image requests' XFF to narrow candidates (SessionInfo.RemoteEndPoint holds the proxy IP, so you must maintain your own map).
- **Coverage:** All native clients behind default Caddy/Traefik/nginx (which send XFF by default); upgrades tier 4 from proxy-IP to real-client-IP.
- **Trust tier:** strong disambiguation when transport RemoteIp is a trusted proxy; weak/forgeable otherwise.
- **Misattribution risk:** Two real vectors: (1) XFF is client-forgeable -> only trust it when the immediate peer is a known proxy, and only to NARROW+fail-closed, never to select-and-unblur; (2) multiple devices behind one home-router NAT still share a real IP -> collapses like tier 4, still fail-closed. Never let XFF uniquely grant clean bytes.
- **Cost:** medium — header parsing, a proxy-trust config/auto-learn, and a realIp->user map with TTL.
- **Vs current ladder:** complements — strictly improves tier 4 for the common single-proxy deployment; does not beat the marker (marker is proxy- and NAT-proof, XFF is neither).

## User-Agent / client-device header fingerprint narrowing (A5)
*Lens:* dto-echo-channels · *Verdict:* **narrowing-only** (feasibility 4/5, value 1/5)

- **Mechanism:** Match request UA/client headers against SessionInfo.Client/DeviceName to shrink the IP candidate set (e.g. the lone Swiftfin session among web sessions on that IP).
- **Coverage:** Any anonymous request whose UA class is represented by exactly one session on the IP.
- **Trust tier:** weak narrowing.
- **Misattribution risk:** Zero IF used only to narrow-then-fail-closed (never to uniquely select). Two identical devices (two Shield TVs -> 'okhttp/x.y.z') are indistinguishable, so it can shrink but never resolve; treating a narrowed-to-one result as authoritative would risk misattribution -> forbid that.
- **Cost:** low.
- **Vs current ladder:** complements tier 4 — reduces fail-closed blast radius behind a shared IP; dominated by the marker wherever the marker is present.
- **Evaluator:** Two identical devices (two Shield TVs → okhttp) are indistinguishable so it can only shrink, never resolve, and on the fail-closed image path shrinking is itself the leak direction if a guarding user's same-device-class session is momentarily absent from SessionManager — so it may only ever reduce over-blur blast radius and must be structurally forbidden from flipping blur→clean by itself, keeping it dominated by the marker wherever the marker is present.

## Client-cooperation identity header from own fork (Plethorafin) (A7)
*Lens:* dto-echo-channels · *Verdict:* **complement** (feasibility 4/5, value 1/5)

- **Mechanism:** The user's own Android TV fork (Plethorafin/Moonfin) emits an X-JC-User (or signed) header on image requests.
- **Coverage:** Only that one client build; stock ATV/Swiftfin/Roku cannot be changed server-side.
- **Trust tier:** authoritative for the cooperating client (if signed).
- **Misattribution risk:** none for the cooperating client; irrelevant elsewhere.
- **Cost:** low (in the fork), but out-of-band from the plugin.
- **Vs current ladder:** complements as bonus hardening for one client; rejected as a general fix (can't update stock clients).
- **Evaluator:** Plugin-side trivial and authoritative, but the tag marker already resolves Plethorafin to a single correct candidate (wire-proven, the fork echoes the marker), so a signed header adds only negligible collision-proofing for one non-stock client.

## Per-user item-id aliasing (WILD)
*Lens:* dto-echo-channels · *Verdict:* **reject** (feasibility 0/5, value 1/5)

- **Mechanism:** Serve each user a deterministic per-user alias GUID for every item in DTOs. The image URL then embeds the alias id; the plugin maps alias->(item,user). Unlike the tag, the id is present even when a client omits ?tag= (positional route, query-stripping client).
- **Coverage:** Every image request, including tag-less ones — the id is the one always-echoed field.
- **Trust tier:** strong disambiguation (would be the only per-user signal on a tag-less request).
- **Misattribution risk:** The id field is echoed EVERYWHERE (playback, favorites, next-up, deletion, cross-references, ParentId/SeriesId/SeasonId links). Aliasing it for images means de-aliasing it on every other endpoint; any missed route breaks the client outright. High risk of functional breakage, and cross-item references collide.
- **Cost:** very high — intercept and translate ids on all inbound/outbound routes.
- **Vs current ladder:** dominated/rejected — strictly stronger identity in theory (mandatory always-echoed field) but the de-aliasing surface is prohibitive and fragile versus the tag suffix, which rides the one field with spare entropy and no navigational meaning.
- **Evaluator:** De-aliasing every inbound id across all REST routes and websocket frames without breaking clients is infeasible for a plugin, and its only theoretical edge (present on tag-less requests) is moot because every verified client echoes ?tag=.

## Streaming echo-field markers: PlaySessionId / MediaSourceId / LiveStreamId / TranscodingUrl / subtitle DeliveryUrl
*Lens:* dto-echo-channels · *Verdict:* **complement** (feasibility 4/5, value 2/5)

- **Mechanism:** PlaybackInfoResponse.PlaySessionId, MediaSourceInfo.Id/LiveStreamId/TranscodingUrl and MediaStream.DeliveryUrl are server-authored strings echoed verbatim into HLS segment, transcode, and external-subtitle sub-requests. Any of them can carry a per-user marker (TranscodingUrl/DeliveryUrl are fully opaque -> can carry an entire signed token).
- **Coverage:** Anonymous streaming/subtitle byte requests — a DIFFERENT protection surface than posters (video/subtitle spoiler protection).
- **Trust tier:** strong disambiguation to authoritative (TranscodingUrl/DeliveryUrl can hold a signed token).
- **Misattribution risk:** Low; the PlaybackInfo call that mints them is authenticated, so the marker is bound to a known user. Segment requests without the marker fall through fail-closed.
- **Cost:** medium, per-surface.
- **Vs current ladder:** complements — irrelevant to the image problem (dominated there by the tag marker), but the correct mechanism if Spoiler Guard ever extends to video/subtitle bytes.
- **Evaluator:** Safe and correct (opaque server-authored fields minted in an authenticated PlaybackInfo call; absence fails closed), but orthogonal to the image problem, opening a future video/subtitle protection surface rather than improving image attribution.

## Device-token / api_key sniffing off image requests (A1/A6, REJECTED)
*Lens:* dto-echo-channels · *Verdict:* **reject** (feasibility 1/5, value 0/5)

- **Mechanism:** Read the client's own token from the image request (Authorization header, ?ApiKey=) and resolve token->device->user via IAuthorizationContext / IDeviceManager.
- **Coverage:** would cover any client that sends credentials on image fetches.
- **Trust tier:** authoritative where present.
- **Misattribution risk:** none where present.
- **Cost:** n/a.
- **Vs current ladder:** rejected/dominated — source+capture verified: the problem clients (ATV, Swiftfin, Roku, web <img>) send NO credentials on image fetches (the Kotlin SDK image builder has no credential path at all). Where a client DOES send a token, tier 1 (ClaimsPrincipal) already resolves it, so nothing extra is needed.
- **Evaluator:** Fully dominated by tier 1: where a token exists JF12 already populates ClaimsPrincipal (verified, including the one mobile ImageProvider case), and every problem client (ATV/Swiftfin/Roku/web img) sends nothing on the wire.

## TCP ConnectionId correlation (A4, REJECTED)
*Lens:* dto-echo-channels · *Verdict:* **reject** (feasibility 1/5, value 0/5)

- **Mechanism:** Map HttpContext.Connection.Id->user on an authenticated request; anonymous requests on the same kept-alive connection inherit it.
- **Coverage:** direct connections only.
- **Trust tier:** n/a.
- **Misattribution risk:** Severe under exactly the target deployment: reverse proxies pool upstream connections across downstream clients and HTTP/2 multiplexes many users onto few connections -> would attribute one user's clean bytes to another. Can UNblur guarded art.
- **Cost:** n/a.
- **Vs current ladder:** rejected — unsafe behind proxies, the very scenario being solved.
- **Evaluator:** Buildable but unsafe in exactly the target deployment, since proxies pool upstream connections and HTTP/2 multiplexes users, so one connection carries several users' requests and can hand a guarding user clean bytes.

## Timing / NowPlaying-activity correlation (A8, REJECTED)
*Lens:* dto-echo-channels · *Verdict:* **reject** (feasibility 0/5, value 0/5)

- **Mechanism:** Attribute an image burst to whichever session's activity timestamps are nearest.
- **Coverage:** shared-IP multi-user.
- **Trust tier:** n/a.
- **Misattribution risk:** Guesswork across concurrent users on one proxy IP; a wrong guess UNblurs a guarded item. Fail-closed posture forbids any mechanism that can produce clean bytes for the wrong user.
- **Cost:** n/a.
- **Vs current ladder:** rejected — violates the accidental-misattribution constraint by construction.
- **Evaluator:** Guessing the nearest active session across concurrent users on a shared proxy IP is an accidental-misattribution generator by construction; a wrong guess unblurs a guarded item, which the fail-closed constraint forbids outright.

## Referer/Origin + Sec-Fetch surface classification (web narrowing)
*Lens:* dto-echo-channels · *Verdict:* **narrowing-only** (feasibility 5/5, value 1/5)

- **Mechanism:** Use Referer/Origin (same-origin item page) and Sec-Fetch-Site/Dest to confirm a request is a browser <img> from this server, routing it to the cookie tier and away from IP guesswork.
- **Coverage:** web only; classifies surface, does not identify a user.
- **Trust tier:** weak narrowing (context signal, not identity).
- **Misattribution risk:** none — only decides WHICH tier applies, never selects a user.
- **Cost:** low.
- **Vs current ladder:** complements weakly — the cookie tier already covers web; marginal value in edge routing, no standalone identity.
- **Evaluator:** Trivial and safe (headers only select which tier applies, never a user) but it identifies nobody, and the cookie tier's existing session-on-IP validation already prevents it from misfiring on native clients, so the routing gain is marginal.

## Per-user URL path prefix (/u/<marker>/ base URL) via plugin middleware
*Lens:* network-level · *Verdict:* **reject** (feasibility 2/5, value 1/5)

- **Mechanism:** Give each user a personalized server base URL to type into their client, e.g. http://host:8096/u/{12hex}/ . A plugin IStartupFilter middleware runs OUTSIDE app.Map(BaseUrl), intercepts any path segment matching /u/{marker}/, resolves marker->user via SpoilerIdentityService, stashes the user id in HttpContext.Items, then rewrites Request.Path/PathBase to strip the prefix so all downstream Jellyfin routing/auth is unaffected. Because the marker lives in the URL PATH, it is present on EVERY request the client emits (images, subtitles, HLS segments, API) - not just image tags - and it is echoed by every client that lets a user type a server URL (Android TV, Swiftfin, Roku, web, mobile - i.e. all of them). Feasible: clients store and replay the full base URL verbatim, and the Host/path survive reverse proxies.
- **Coverage:** All clients and ALL request surfaces (superset of the ?tag= image-marker tier, which only covers image URLs).
- **Trust tier:** strong disambiguation (self-asserted, proxy-proof, deterministic - same trust class as the existing ?tag marker but broader).
- **Misattribution risk:** Low. Deterministic lookup, no guessing, no IP involvement -> immune to the reverse-proxy IP-pooling ambiguity that plagues tiers 3-4. Residual risk only from a client that silently normalizes/strips path segments (then no marker is seen -> resolves to None -> fail-closed, protective) or a user who literally types someone else's URL (self-inflicted, = deliberate self-spoiling, allowed). No path exists to accidentally hand a guarded user clean bytes.
- **Cost:** Medium. One IStartupFilter + middleware, a marker<->user registry (already exists), and onboarding UX to hand each user their URL. No proxy/DNS/cert changes.
- **Vs current ladder:** complements (and effectively supersedes tier 2): it is a strict superset of the image-tag marker - covers non-image requests too and removes all IP ambiguity - at the same trust tier. Strongest genuinely-new network-layer idea; recommend as the primary hardening over the tag marker where onboarding friction is acceptable.
- **Evaluator:** Not a superset of the tag marker: the prefix binds to the device/server-connection (persists across user-switches on a shared device), so it returns a single high-confidence WRONG candidate and can leak clean bytes to a current user who guarded the item, a fail-closed violation the per-DTO tag marker avoids; clients also dedupe servers by the identical /System/Info/Public server Id, so two per-user URLs to one host often cannot even coexist, and the 'clients replay the full base URL verbatim' premise is unverified.

## Per-user subdomain / virtual host (usera.host.tld) via Host header
*Lens:* network-level · *Verdict:* **n/a** (feasibility ?/5, value ?/5)

- **Mechanism:** Assign each user a distinct hostname (usera.host.tld) that all resolves to the same server. Plugin middleware reads HttpContext.Request.Host (or the TLS SNI name, which also survives to Kestrel) and maps subdomain->user. Crucially the Host header survives reverse proxies by default (Caddy/Traefik/nginx forward it), unlike the client IP, so this works where tier-4 IP matching fails.
- **Coverage:** All clients (every client sends Host / SNI for the hostname it was configured with).
- **Trust tier:** strong disambiguation (self-asserted, proxy-proof, deterministic).
- **Misattribution risk:** Low, deterministic. Same fail-closed properties as the path-prefix idea; unknown/typo host -> None -> protective. No accidental cross-user attribution.
- **Cost:** High-ish infra: wildcard DNS entry + wildcard TLS cert + proxy vhost fan-in. Middleware itself is trivial.
- **Vs current ladder:** complements, but dominated by the path-prefix variant for most deployments: identical coverage and trust, strictly more infrastructure (DNS + wildcard cert). Prefer subdomains only when the operator already runs per-user vhosts or wants the marker invisible in the path.

## Per-user listening ports (extra Kestrel endpoints bound by the plugin)
*Lens:* network-level · *Verdict:* **reject** (feasibility 1/5, value 0/5)

- **Mechanism:** A plugin CAN add listening sockets: register IConfigureOptions<KestrelServerOptions> from IPluginServiceRegistrator.RegisterServices (which writes into the same IServiceCollection the web host consumes, before Build), and call options.Listen(addr, basePort+N). Give user N the base URL with port basePort+N; middleware maps HttpContext.Connection.LocalPort -> user. Confirms the plugin-can-bind-extra-sockets question: yes, via Kestrel options, subject to registration running before options materialize (plausible in Jellyfin's ordering - plugin RegisterServices at ApplicationHost.cs:470 feeds the host's collection).
- **Coverage:** All clients (each configured with its own port).
- **Trust tier:** strong disambiguation (self-asserted, deterministic on LocalPort).
- **Misattribution risk:** Low per-request (LocalPort is server-observed, unspoofable), but operationally fragile: a proxy that terminates and re-connects on one upstream port collapses all users to one LocalPort -> then it silently mis-buckets everyone to whichever user owns that port. That IS an accidental-misattribution path unless every user port is proxied 1:1. Fail-closed only if unmapped ports resolve to None.
- **Cost:** High: one socket per user (doesn't scale), firewall openings, per-port TLS, and per-port proxy routing. Port exhaustion / ops burden.
- **Vs current ladder:** dominated by path-prefix and subdomain: same self-asserted trust and coverage, far worse scaling, worse ops, and a real proxy-collapse misattribution hazard. Interesting as proof a plugin can bind sockets, but not recommended.
- **Evaluator:** Plugin socket-binding via IConfigureOptions<KestrelServerOptions> is plausible (additive Listen() into the shared collection at ApplicationHost.cs:470), but as an identity signal it self-admits a fatal accidental-misattribution path — any terminating proxy collapses all clients onto one upstream LocalPort and silently buckets everyone to that port's owner — so it breaks in exactly the proxied deployments where help is needed, while being dominated by the marker and scaling one-socket-per-user.

## Plugin-level X-Forwarded-For with learned realIp->user map
*Lens:* network-level · *Verdict:* **complement** (feasibility 5/5, value 3/5)

- **Mechanism:** Jellyfin ignores XFF unless KnownProxies is configured (Startup uses UseForwardedHeaders but ForwardedHeaders.None when KnownProxies empty), BUT a plugin can read the raw X-Forwarded-For header off HttpContext.Request.Headers directly, independent of core config. Caddy/Traefik/nginx send XFF by default. Learn realIp->user(s) from authenticated requests, then attribute anonymous image requests carrying the same realIp. This recovers the true client IP that the proxy otherwise hides, upgrading tier-4 from 'all sessions on the proxy IP' to 'sessions on the real client IP'.
- **Coverage:** Any client reached through a proxy that emits XFF (most reverse-proxy deployments); no help for direct-connect LAN clients (they already have a real IP).
- **Trust tier:** weak narrowing to strong disambiguation depending on whether the real client IP is shared (household NAT still collapses multiple users).
- **Misattribution risk:** HIGH and needs care on two axes. (1) Household NAT: several users behind one real IP remain a candidate SET, never a single attribution -> must stay fail-closed (protect if ANY candidate guarded). (2) Poisoning: XFF is client-forgeable; an attacker sending an AUTHENTICATED request with a spoofed XFF = victim's IP could poison the learned map so the victim's anonymous images get the attacker's (looser) policy -> that is accidental misattribution of ANOTHER user and is forbidden. Mitigation: only learn realIp from XFF when the immediate peer is a trusted proxy, and treat the learned map as candidate-narrowing (fail-closed) not authority.
- **Cost:** Low-medium: header parse + a TTL'd realIp->candidates map (mirrors the existing per-IP session cache).
- **Vs current ladder:** complements/upgrades tier 4 (SharedIpCandidates) behind proxies - it de-anonymizes the proxy-pooled IP. Keep it strictly below the marker tiers and strictly fail-closed with trusted-proxy gating; otherwise the poisoning path violates the no-accidental-misattribution constraint.
- **Evaluator:** Verified feasible (core ignores XFF with empty KnownProxies, but a filter reads the raw header directly) and it is the only lever that de-ambiguates the ladder's genuine weak spot — tier-4 SharedIpCandidates behind a proxy — yet it is safe ONLY if gated on a plugin-side trusted immediate-peer AND kept as fail-closed candidate-narrowing below the marker, because XFF is client-forgeable and an authenticated request with a spoofed victim-IP would otherwise poison the map into another user's policy (forbidden misattribution); it complements rather than beats the marker.

## PROXY protocol v1/v2 (TCP-layer real-client-IP recovery)
*Lens:* network-level · *Verdict:* **reject** (feasibility 1/5, value 1/5)

- **Mechanism:** If the reverse proxy is configured to prepend a PROXY protocol header, the real client IP:port is delivered at the TCP layer ahead of HTTP. .NET has no built-in parser, but a plugin could add a Kestrel connection middleware (via the same IConfigureOptions<KestrelServerOptions> Listen hook, ListenOptions.Use(...)) to consume it and expose the real remote endpoint, then run the existing session-by-IP logic against the true client IP instead of the proxy IP.
- **Coverage:** Clients behind a proxy explicitly configured for PROXY protocol (opt-in operator config).
- **Trust tier:** strong for the IP itself (only the proxy can set it - not client-forgeable, unlike XFF), but IP->user is still ambiguous within a NAT household.
- **Misattribution risk:** Medium: no forgery/poisoning path (proxy-authenticated), so it is safer than XFF, but the same household-NAT ambiguity remains -> candidate set, fail-closed.
- **Cost:** Medium-high: custom connection-layer parser + proxy must be reconfigured to emit PROXY protocol (and then it must emit it on EVERY listener or connections break).
- **Vs current ladder:** complements tier 4, marginally better trust than the XFF idea (no poisoning) but materially heavier (TCP parser + all-or-nothing proxy config). Prefer XFF-with-trusted-proxy for most; reserve PROXY protocol for operators who already run it.
- **Evaluator:** Dominated by the XFF variant: it recovers the same real client IP (still NAT-ambiguous, candidate-set only) but requires a hand-rolled connection-layer parser plus all-or-nothing proxy reconfiguration, and the plugin cannot easily attach ListenOptions.Use to Jellyfin's own listeners — the proxy would have to target a plugin-owned endpoint, reintroducing the per-port infra it was meant to avoid.

## Per-user server IPv6 address (interface-identifier tagging)
*Lens:* network-level · *Verdict:* **reject** (feasibility 1/5, value 0/5)

- **Mechanism:** Bind many server-side IPv6 addresses (a /64 gives effectively unlimited) via Kestrel Listen from the plugin, hand each user a base URL on a distinct address, and map HttpContext.Connection.LocalIpAddress -> user. IPv6-analogue of the per-port idea using address space instead of ports.
- **Coverage:** IPv6-reachable clients only.
- **Trust tier:** strong disambiguation (deterministic on server-observed destination address).
- **Misattribution risk:** Low per-request, but same proxy-collapse hazard as per-port (a v4/v6-terminating proxy hides the per-user destination address) -> must fail-closed on unmapped addresses.
- **Cost:** High: IPv6 routing/RA config, per-address TLS SNI, no help for IPv4-only clients.
- **Vs current ladder:** dominated by path-prefix/subdomain (same self-asserted class, narrower reach, more infra). Listed for completeness of the network-layer lens; not recommended.
- **Evaluator:** Same self-asserted class as per-port/subdomain but strictly worse: IPv6-only reach (no IPv4 clients), even heavier infra (per-address TLS SNI, RA/routing, literal-address URLs per user), and the identical proxy-collapse misattribution hazard when any v4/v6-terminating proxy hides the per-user destination address; fully dominated by the marker.

## mDNS / SSDP / AutoDiscovery per-user response
*Lens:* network-level · *Verdict:* **reject** (feasibility 0/5, value 0/5)

- **Mechanism:** Hypothetical: have the plugin answer Jellyfin's UDP AutoDiscovery/SSDP broadcasts with a per-user server address so the client self-selects a user-tagged URL.
- **Coverage:** None useful. Discovery is a pre-auth LAN broadcast with no user context, so responses cannot be user-specific, and the identity never rides back on the subsequent image request.
- **Trust tier:** n/a (does not attribute a request).
- **Misattribution risk:** n/a - it produces no request-time signal.
- **Cost:** n/a.
- **Vs current ladder:** rejected: discovery carries no user identity and delivers nothing that lands on the anonymous image request; it can only ever hand the client a URL, which is the path-prefix/subdomain idea by another (unreliable, LAN-only) route.
- **Evaluator:** Attributes nothing: discovery is a pre-auth LAN broadcast with no user context, the response can only hand the client a URL (collapsing to the already-rejected subdomain/path-prefix idea via an unreliable LAN-only channel), and no identity ever rides back onto the subsequent anonymous image request.

## DHCP / device network fingerprint
*Lens:* network-level · *Verdict:* **n/a** (feasibility ?/5, value ?/5)

- **Mechanism:** Correlate the client by DHCP lease fingerprint, MAC, or L2 device identity.
- **Coverage:** None. A Jellyfin plugin runs at L7 inside the server process and never sees DHCP, MAC, or L2 - those are stripped by the first router hop and entirely absent behind any proxy.
- **Trust tier:** n/a.
- **Misattribution risk:** n/a - no data on the wire to act on.
- **Cost:** n/a.
- **Vs current ladder:** rejected: out of the plugin's observability (same class as the already-rejected TCP-correlation / UA-fingerprint ideas).

## L1 — ClaimsPrincipal from authenticated token (existing ladder tier 1)
*Lens:* ecosystem-prior-art · *Verdict:* **n/a** (feasibility ?/5, value ?/5)

- **Mechanism:** JF12's default auth middleware runs on anonymous image endpoints too, so a `MediaBrowser ...Token=` header or `?ApiKey=` query populates HttpContext.User (Jellyfin-UserId claim) even there. Resolve via UserHelper.GetCurrentUserId, or IAuthorizationContext.GetAuthorizationInfo / IDeviceManager.GetDevices(AccessToken). This is the Plex/Subsonic/Audiobookshelf model (token on EVERY request incl. images) — it works for Plex precisely because Plex CLIENTS were built to always attach X-Plex-Token; it works here ONLY for the rare Jellyfin client that attaches credentials.
- **Coverage:** Any request carrying a live token/ApiKey. Verified: only the Android native ImageProvider launcher-tile path does this; Android TV, Swiftfin, Roku, and web <img>/CSS-background fetches send nothing.
- **Trust tier:** authoritative
- **Misattribution risk:** none — cryptographically bound to the token's user.
- **Cost:** already implemented; ~zero (core does the work).
- **Vs current ladder:** is the ladder's top tier — keep; the whole problem is that the flagship clients bypass it.

## L2 — Per-user marker embedded in ?tag= (existing ladder tier 2, the adopted fix)
*Lens:* ecosystem-prior-art · *Verdict:* **n/a** (feasibility ?/5, value ?/5)

- **Mechanism:** Clients never invent image URLs — they build them from ImageTags in the per-user-authenticated item DTO and echo the tag verbatim as ?tag=. A global action filter (SpoilerIdentityTagFilter) rewrites every tag field to `<orig>-jeu{12hex}` (12-hex = short unkeyed hash of userId), re-keying ImageBlurHashes in lockstep; the image filter decodes ?tag= -> user. This is the DIRECT transfer of the CloudFront/S3-presigned-URL, Home Assistant SignedPath (?authSig=), and Nextcloud/Subsonic-token insight — put the identity INSIDE the URL the client is handed so it round-trips with zero client cooperation — but inverted: instead of the client signing, the SERVER stamps a token the client unwittingly carries.
- **Coverage:** Every client that echoes DTO tags = ALL of them (web, Android TV/okhttp, Swiftfin, Roku, mobile). Proxy-proof, IP-free. Verified end-to-end on device incl. behind an XFF-stripping proxy.
- **Trust tier:** strong disambiguation (not authentication — forgeable, but threat model makes forgery a harmless self-spoil).
- **Misattribution risk:** essentially none for its purpose: a wrong/stale marker (deleted user, pre-rollout cached URL) fails to resolve and falls through to the IP ladder; it never selects the wrong live user because the hash space is per-user and collision-checked.
- **Cost:** already implemented; the one non-trivial cost is stamping ALL tag-bearing DTO fields + ImageBlurHashes re-keying across all routes.
- **Vs current ladder:** IS the ladder's decisive middle tier and the single reliable channel for native clients — everything below only exists to cover the gap before a client refreshes its cached (unstamped) URLs.

## L3 — jc-spoiler-uid cookie validated against session-on-IP (existing ladder tier 3)
*Lens:* ecosystem-prior-art · *Verdict:* **n/a** (feasibility ?/5, value ?/5)

- **Mechanism:** Web client sets a per-browser cookie; browsers attach it to same-origin anonymous <img>/CSS-background fetches. Trusted only to pick among users who actually have a session on the request IP.
- **Coverage:** Web browsers only (native apps send no cookies). Redundant with L2 on web but survives if a tag is ever stripped.
- **Trust tier:** strong disambiguation (web).
- **Misattribution risk:** low — session-on-IP gate prevents selecting an absent user; fresh-login race closed by an uncached rescan + negative cache.
- **Cost:** already implemented.
- **Vs current ladder:** complements L2 on web as a belt-and-suspenders fallback; dominated by L2 wherever the tag survives.

## L4 — Session-by-IP candidate set (existing ladder tier 4, fail-closed floor)
*Lens:* ecosystem-prior-art · *Verdict:* **n/a** (feasibility ?/5, value ?/5)

- **Mechanism:** Enumerate ISessionManager.Sessions whose RemoteEndPoint IP == request IP; return the whole set. Fail-closed consumers blur if ANY candidate guards the item.
- **Coverage:** Any anonymous request with no marker/cookie. Precise on unshared IPs; collapses to everyone behind an IP-hiding reverse proxy.
- **Trust tier:** weak narrowing (ambiguous behind proxy/NAT).
- **Misattribution risk:** none in the leak direction because it fails closed (union of candidates); its cost is over-blur (a non-guarding user sees another's blur), which is the bug L2 was built to retire.
- **Cost:** already implemented.
- **Vs current ladder:** the safety floor; correctly dominated by L2 but must remain for pre-rollout cached URLs.

## A3 — Plugin-level X-Forwarded-For with a learned realIP->user map (under consideration)
*Lens:* ecosystem-prior-art · *Verdict:* **n/a** (feasibility ?/5, value ?/5)

- **Mechanism:** Even when Jellyfin's KnownProxies is empty (so core doesn't rewrite RemoteIpAddress), Caddy/Traefik/nginx still SEND X-Forwarded-For by default. The plugin reads XFF directly to recover the real client IP. Because SessionInfo.RemoteEndPoint records the PROXY IP, the plugin can't match XFF against sessions — it must build its OWN map from authenticated requests: on every request that has both a ClaimsPrincipal and an XFF, record realIP->userId; anonymous image requests then look up their XFF's realIP in that map.
- **Coverage:** Native clients (Android TV/Swiftfin/Roku) behind a default reverse proxy — exactly the population L2 doesn't yet reach on stale cached URLs. Useless if the proxy strips XFF or the client is direct.
- **Trust tier:** strong disambiguation when XFF originates from a trusted proxy; weak/forgeable if a client injects its own XFF.
- **Misattribution risk:** moderate if used to SELECT and unblur — a forged XFF could impersonate another realIP. Mitigate by using it ONLY to narrow the fail-closed set (never to grant clean bytes to a user not otherwise present), and/or trust XFF only when transport RemoteIp equals a configured/auto-learned proxy address.
- **Cost:** medium — a TTL map keyed on realIP, populated from the same DTO/auth interception already in place; plus proxy-trust config.
- **Vs current ladder:** complements — it is the best net-new signal for the residual native-behind-proxy gap; strictly additive, slots between L2 and L4. Keep pursuing.

## DTO-fetch attribution map (itemId + recency, IP-free cousin of the marker)
*Lens:* ecosystem-prior-art · *Verdict:* **n/a** (feasibility ?/5, value ?/5)

- **Mechanism:** The tag filter already sees every authenticated item DTO. Record (userId, itemId, timestamp) when user X fetches an item's DTO. An anonymous image request for itemId Y whose marker is absent (stripped/pre-rollout) is attributed to whoever recently fetched Y's DTO. Anchored on the SAME itemId, not raw timing — this is what makes it stronger than A8 timing correlation, and it mirrors how Home Assistant's camera signed-path ties a fetch to the auth context that produced it.
- **Coverage:** Any client, marker-independent — a fallback for the exact window L2 misses (client still holding an unstamped cached URL). Works even when IP is shared, since attribution is by itemId, not IP.
- **Trust tier:** strong narrowing (single recent fetcher) down to weak (several users browsed the same popular item).
- **Misattribution risk:** real if used to SELECT: a guarding user viewing via a client-cached DTO (no fresh fetch) would be absent from the map and could be unblurred -> leak. Safe ONLY if used to ADD candidates to the fail-closed set (union), never to prune it.
- **Cost:** low-medium — reuse existing DTO interception; a bounded TTL multimap itemId->recent userIds.
- **Vs current ladder:** complements L4 (widens/sharpens the fail-closed candidate set when marker absent); dominated by L2 whenever the marker survives.

## Signed/expiring marker upgrade (HMAC + TTL) — CloudFront/HA-SignedPath hardening
*Lens:* ecosystem-prior-art · *Verdict:* **n/a** (feasibility ?/5, value ?/5)

- **Mechanism:** Replace the unkeyed 12-hex with an HMAC(userId, serverSecret) plus an issued-at/expiry, exactly like CloudFront/S3 presigned URLs, Home Assistant's HS256 authSig, and Subsonic's md5(password+salt) token. Makes markers unforgeable and lets stale markers self-expire.
- **Coverage:** Same surfaces as L2 (all clients).
- **Trust tier:** would raise L2 from 'strong disambiguation' toward 'authoritative'.
- **Misattribution risk:** none added; expiry could HELP staleness (a marker from a since-deleted/renamed user stops resolving on a timer).
- **Cost:** low — add an HMAC util + persisted secret (none exists in repo today) and an expiry field.
- **Vs current ladder:** complements/hardens L2 but is LOW VALUE under the stated threat model (forgery only self-spoils, images are already anonymously reachable). Worth it mainly for deterministic staleness expiry, not security.

## Single-user / effectively-single-user shortcut
*Lens:* ecosystem-prior-art · *Verdict:* **adopt-candidate** (feasibility 5/5, value 3/5)

- **Mechanism:** If the server has exactly one enabled non-admin user (or only one user account has ever logged in from any device), every anonymous request is unambiguously that user. Check IUserManager at request time.
- **Coverage:** Every surface, every client — a huge fraction of real Jellyfin home installs are effectively single-user.
- **Trust tier:** authoritative in the single-user case.
- **Misattribution risk:** none while the precondition holds; must re-evaluate live (a second user logging in must immediately drop the shortcut).
- **Cost:** trivial — one cached user-count check.
- **Vs current ladder:** complements as a cheap authoritative fast-path ABOVE L4 for the common single-user deployment; independent of L2.
- **Evaluator:** A trivially cheap, authoritative fast-path that closes a genuine leak — when the lone user guards an item but has no active session, L4 returns None and the filter serves clean bytes — with no misattribution risk (there is no other user to confuse them with) provided the total-user-count==1 precondition is evaluated live rather than cached stale.

## Per-user Host/subdomain or base-URL (optional admin config)
*Lens:* ecosystem-prior-art · *Verdict:* **n/a** (feasibility ?/5, value ?/5)

- **Mechanism:** Admin fronts the server with per-user hostnames (alice.jelly.example -> same backend); the Host header then identifies the user proxy-proof, on every request including anonymous images. Analogous to per-tenant subdomains.
- **Coverage:** All clients that honor a per-user published server URL.
- **Trust tier:** authoritative (if the proxy is trusted to set Host).
- **Misattribution risk:** none if hostnames are 1:1 and proxy-controlled.
- **Cost:** high operationally (admin must configure DNS/proxy + hand each user a distinct URL); zero-to-low plugin code.
- **Vs current ladder:** complements for power users who can configure it; not a general fix (most users won't).

## Authenticated WebSocket presence narrowing
*Lens:* ecosystem-prior-art · *Verdict:* **reject** (feasibility 3/5, value 1/5)

- **Mechanism:** Jellyfin clients (Android TV incl.) hold an authenticated /socket connection carrying user+deviceId. The set of live WS connections from the request's (proxy) IP narrows candidates to currently-connected users; capturing XFF at WS-connect time also feeds the A3 realIP map.
- **Coverage:** Clients that keep a WS (Android TV yes; Roku/Swiftfin variable). Narrows, never identifies.
- **Trust tier:** weak narrowing (still proxy-IP-bound); its real value is as an XFF->user data source for A3.
- **Misattribution risk:** low if used only to narrow the fail-closed set.
- **Cost:** medium — hook session/WS lifecycle.
- **Vs current ladder:** largely dominated by L4 (same proxy-IP limitation) except as an A3 feeder; minor complement.
- **Evaluator:** A live WS is just another session on the same proxy IP, so its candidate set is a subset of L4's session-by-IP set — narrowing to it means dropping a silently-scrolling guarding user whose WS lapsed (a leak), while its XFF-at-connect feeder role is strictly worse than the frequent XFF already on every authenticated HTTP DTO fetch.

## Referer/Origin + header-combo narrowing (web-vs-native discriminator)
*Lens:* ecosystem-prior-art · *Verdict:* **reject** (feasibility 4/5, value 1/5)

- **Mechanism:** Web <img> fetches send Referer (the page) and browser Accept/UA; native okhttp/CFNetwork/Roku fetches don't. Use the combination to at least separate the web candidate(s) from the native candidate(s) on a shared IP.
- **Coverage:** All surfaces, but only coarse (web vs native buckets).
- **Trust tier:** weak narrowing.
- **Misattribution risk:** low if used only to narrow union; headers are forgeable but that only self-spoils.
- **Cost:** low.
- **Vs current ladder:** minor complement to L4; dominated by L2/L3 on web and useless to distinguish two identical native devices.
- **Evaluator:** Post-marker the web bucket is already resolved by L2/L3 and two identical native devices stay indistinguishable, so its only residual act is shrinking the fail-closed union — which is unsafe because Referrer-Policy/referrerpolicy/privacy extensions can strip Referer from a web user's image GET and mis-bucket them as native, dropping a guarding candidate.

## A5 — User-Agent / device-header fingerprinting (rejected)
*Lens:* ecosystem-prior-art · *Verdict:* **n/a** (feasibility ?/5, value ?/5)

- **Mechanism:** Match request UA against SessionInfo Client/Device to pick the session. Verified UA on image fetches is generic (`okhttp/x.y.z`, `Swiftfin/CFNetwork`, Roku firmware) — cannot distinguish two identical devices.
- **Coverage:** Would need distinguishable UAs; none exist for the problem clients.
- **Trust tier:** weak narrowing at best.
- **Misattribution risk:** high if used to select — two Shield TVs are byte-identical.
- **Cost:** low.
- **Vs current ladder:** rejected — dominated by L2; provides no reliable disambiguation.

## A1/A6 — Token/deviceId sniffing off the image request (rejected)
*Lens:* ecosystem-prior-art · *Verdict:* **n/a** (feasibility ?/5, value ?/5)

- **Mechanism:** Read Authorization/X-Emby-Token/?api_key=/deviceId off the image request. Source+wire capture across all 5 clients shows NOTHING on the wire for the problem clients (Kotlin SDK's image URL builder has no credential support at all); JF12 also ignores legacy carriers. Where credentials ARE present (Android native ImageProvider), core already populates ClaimsPrincipal (=L1).
- **Coverage:** Empty for the clients that matter.
- **Trust tier:** would be authoritative if anything were present.
- **Misattribution risk:** n/a (no data).
- **Cost:** n/a.
- **Vs current ladder:** rejected — nothing to read; fully subsumed by L1 for the one client that does send credentials.

## A4 — TCP ConnectionId / HTTP-connection correlation (rejected)
*Lens:* ecosystem-prior-art · *Verdict:* **n/a** (feasibility ?/5, value ?/5)

- **Mechanism:** Map HttpContext.Connection.Id->user from an authenticated request, inherit for anonymous requests on the same kept-alive connection.
- **Coverage:** Direct connections only.
- **Trust tier:** authoritative direct; collapses behind proxies.
- **Misattribution risk:** high behind proxies — nginx/Caddy pool upstream connections ACROSS downstream users and HTTP/2 multiplexes many users onto one connection, so an anonymous request would inherit a stranger's identity -> unblur leak.
- **Cost:** low.
- **Vs current ladder:** rejected — unsafe in exactly the proxy deployment being solved.

## A8 — Timing / active-browsing-session correlation (rejected)
*Lens:* ecosystem-prior-art · *Verdict:* **n/a** (feasibility ?/5, value ?/5)

- **Mechanism:** Attribute the image burst to whichever session's activity timestamps fall around it.
- **Coverage:** Any, but pure guesswork with concurrent users on a shared proxy IP.
- **Trust tier:** weak, non-deterministic.
- **Misattribution risk:** high — a wrong guess UNBLURS guarded art; the fail-closed posture forbids it. (Note: the itemId-anchored DTO-fetch map above is the safe, non-timing replacement for the same intent.)
- **Cost:** medium.
- **Vs current ladder:** rejected — violates the no-accidental-misattribution constraint.

## DTO-ordered image-sequence matching (wild, reject-leaning)
*Lens:* ecosystem-prior-art · *Verdict:* **n/a** (feasibility ?/5, value ?/5)

- **Mechanism:** At DTO time, remember the exact ordered (itemId,imageType) list returned to user X; match the incoming anonymous image stream per IP against that per-user sequence.
- **Coverage:** Any client that fires images in DOM/DTO order.
- **Trust tier:** weak — lazy-loading, viewport, and prefetch scramble order.
- **Misattribution risk:** high if used to select; only marginally better than A8 and shares its leak risk.
- **Cost:** high (stateful stream matching).
- **Vs current ladder:** wild/rejected — dominated by the itemId+recency map, which achieves the safe part without fragile sequence matching.

## A7 — First-party client cooperation header (Plethorafin only)
*Lens:* ecosystem-prior-art · *Verdict:* **reject** (feasibility 1/5, value 1/5)

- **Mechanism:** The user's own Android TV fork (Plethorafin/Moonfin) could attach an identifying header/param on image requests. Stock clients can't be changed. This is the Plex model (cooperating client) applied only to a client we control.
- **Coverage:** Only the first-party fork; zero for stock Android TV/Swiftfin/Roku/web.
- **Trust tier:** authoritative for that one client.
- **Misattribution risk:** none for that client.
- **Cost:** low in the fork, but out-of-scope for a server-plugin-only fix.
- **Vs current ladder:** complements L2 as bonus hardening for Plethorafin; NOT a general solution (dominated by L2, which needs no client change).
- **Evaluator:** It requires a stock-client change so it falls outside the server-plugin-only scope and covers only the one controlled fork, which L2 already identifies precisely via the echoed DTO tag — a redundant bonus, not a solution.

## Plugin-served image proxy route with identity in the path (mostly dominated)
*Lens:* ecosystem-prior-art · *Verdict:* **n/a** (feasibility ?/5, value ?/5)

- **Mechanism:** Generalization of L2 / the Overseerr-Jellyseerr image-proxy pattern: serve images through a plugin route like /JellyfinCanopy/Images/{item}?u={signedMarker} and hand clients that full URL. Home Assistant/Nextcloud/CloudFront all do identity-in-the-URL this way.
- **Coverage:** Would cover any client — BUT only if the client actually requests THAT url. Jellyfin item images are client-CONSTRUCTED from itemId+tag, not taken from a URL field in the DTO, so clients won't hit a custom route unless the URL is one they build. That is exactly why L2 rides the ?tag= field instead of a new path.
- **Trust tier:** authoritative in principle.
- **Misattribution risk:** none (server controls the route).
- **Cost:** high, and blocked by the client-constructs-the-URL reality.
- **Vs current ladder:** dominated by L2 — L2 is the only form of this pattern that clients will actually round-trip without cooperation; the ?tag= channel is the plugin's only injection point into a client-built URL.

## Signed/session-bound jc-spoiler-uid cookie (harden tier 3)
*Lens:* web-client-channels · *Verdict:* **complement** (feasibility 4/5, value 2/5)

- **Mechanism:** Server mints a short-lived token over the authenticated channel (HMAC of userId + expiry under a persisted plugin secret, or the userId encrypted). Injected client stores it as the jc-spoiler-uid cookie instead of the raw GUID. Browsers attach it automatically to same-origin <img>/CSS-background fetches (no URL rewrite, no flicker). The image action filter verifies the HMAC/expiry and attributes directly, WITHOUT the current session-on-IP validation.
- **Coverage:** Web + Android-mobile WebView (which IS jellyfin-web). Not native TV/Swiftfin/Roku (they send no cookies).
- **Trust tier:** authoritative (for web) — value is server-minted and tamper-evident, so it can be trusted on its own
- **Misattribution risk:** Near-zero if bound to session lifetime and short expiry. Residual risk: a not-yet-expired token lingering after logout could name the previous user on that browser — mitigate by re-priming on every load (already done) + short TTL + optional server-side session-validity check. Fail-safe: bad/expired signature falls through to the existing IP ladder.
- **Cost:** Medium. One authenticated mint endpoint, a persisted secret (none exists in repo today), HMAC verify in the filter, minor client change. Reuses the existing cookie plumbing.
- **Vs current ladder:** beats the current Cookie tier for web: removes the session-on-IP dependency that collapses behind IP-hiding reverse proxies, so web users stay individually attributed even when every client shares the proxy IP. This is the single highest-value web hardening.
- **Evaluator:** Web image requests already carry the tier-2 ?tag= marker that resolves before the cookie, so the tier it hardens is largely redundant, and the proposed drop of session-on-IP validation reintroduces the forbidden misattribution in the logout/account-switch window (a still-valid stale cookie would be honored where today's raw cookie is rejected) — only a variant that keeps the session check is a safe, minor hardening.

## Service Worker fetch interception (identity header on img + CSS requests)
*Lens:* web-client-channels · *Verdict:* **n/a** (feasibility ?/5, value ?/5)

- **Mechanism:** Injected script registers a first-party service worker at root scope; its fetch handler intercepts EVERY network request in scope — including <img> and CSS background-image loads that fetch/XHR patching cannot see — and clones them with an added header (e.g. X-JC-Uid or the signed cookie value), deriving the live userId from app state via postMessage/IndexedDB keyed on the fetch event's clientId.
- **Coverage:** Web + Android-mobile WebView only. Uniquely (vs fetch-patching) it DOES cover <img>/CSS-background, the actual poster loaders.
- **Trust tier:** strong disambiguation (as trustworthy as the cookie; can carry the signed token to reach authoritative)
- **Misattribution risk:** Manageable but footgun-heavy: (a) SW is one registration shared across all same-origin tabs, so a multi-account browser must map fetch clientId→uid, not cache a single uid, or it will stamp the wrong user; (b) stale identity across an account switch if the SW caches uid instead of re-deriving per fetch.
- **Cost:** High + operational risk. Jellyfin-web already ships its own PWA/offline service worker; only one SW controls a scope, so registering ours would REPLACE/conflict with Jellyfin's (breaking offline/push). Requires Service-Worker-Allowed header on the plugin-served SW script. A buggy SW can break the whole app's networking.
- **Vs current ladder:** complements but mostly dominated: delivers no correctness gain over the signed cookie (both are first-party web hints) while adding large operational risk and conflicting with Jellyfin's own SW. Only worth it if the signed cookie proves unreliable on some WebView.

## fetch()/XMLHttpRequest monkey-patching to attach an identity header
*Lens:* web-client-channels · *Verdict:* **n/a** (feasibility ?/5, value ?/5)

- **Mechanism:** Override window.fetch and XMLHttpRequest.prototype.open/send to inject an X-JC-Uid header (or Authorization) on outgoing requests.
- **Coverage:** Only requests that actually go through fetch/XHR. The problem images are loaded by the browser's native image loader via <img src> and CSS background-image, which do NOT pass through fetch/XHR and cannot be intercepted this way.
- **Trust tier:** strong for the requests it can touch — but those are the wrong requests
- **Misattribution risk:** Low where it applies, but it doesn't apply to poster loads, so it adds no protection there.
- **Cost:** Low.
- **Vs current ladder:** rejected: near-zero coverage of the actual anonymous image requests. This blind spot is precisely why the project chose a cookie over URL/header rewriting in the first place.

## Client-side <img> src marker rewrite at render time (localStorage-driven)
*Lens:* web-client-channels · *Verdict:* **n/a** (feasibility ?/5, value ?/5)

- **Mechanism:** Injected code appends the per-user marker (or a uid param) to each poster URL before the browser fetches it, reading the current uid from localStorage/app state, so the marker rides in ?tag= without a server DTO rewrite.
- **Coverage:** Web + WebView only.
- **Trust tier:** strong disambiguation (same class as the server marker)
- **Misattribution risk:** Rewriting AFTER the browser has begun loading double-fetches every card (native→BlurHash→rewrite→BlurHash) — the exact visible flicker the identity.ts comment documents and forbids. Doing it BEFORE first paint requires hooking Jellyfin's card builder or a body-wide DOM observer, both forbidden by JC perf rules R1–R8.
- **Cost:** Medium, and it violates the no-flicker / no-body-observer rules.
- **Vs current ladder:** dominated by the existing server ?tag= marker (tier 2), which achieves identical per-user URL identity for ALL clients with zero client code and zero flicker (stamped in the authenticated DTO).

## Blob-URL authenticated image loading (nuclear web option)
*Lens:* web-client-channels · *Verdict:* **n/a** (feasibility ?/5, value ?/5)

- **Mechanism:** Replace every poster load: fetch the image with a real Authorization header, convert to a blob URL, and set that as the <img> src. Every image request then carries the token → Jellyfin's auth middleware populates ClaimsPrincipal.
- **Coverage:** Web + WebView only.
- **Trust tier:** authoritative (reaches tier 1, ClaimsPrincipal)
- **Misattribution risk:** None — genuinely authenticated.
- **Cost:** Prohibitive. Reimplements all image loading, defeats browser-native lazy-loading and HTTP image caching, doubles memory (blobs), causes load flicker, and needs a body-wide observer — a direct, severe violation of the R1–R8 perf rules.
- **Vs current ladder:** dominated: it is the only web mechanism that reaches tier-1 authoritative without a server marker, but the jank/perf cost is unacceptable. Listed for completeness as the theoretical ceiling.

## WebSocket side-channel pre-announcing upcoming image fetches
*Lens:* web-client-channels · *Verdict:* **n/a** (feasibility ?/5, value ?/5)

- **Mechanism:** The authenticated client socket announces 'user X (this session) is about to load images for items […]'; the image filter attributes anonymous GETs arriving shortly after from a matching IP to the announcing user.
- **Coverage:** Web + WebView (and could be extended to any client with an authed socket).
- **Trust tier:** weak narrowing (timing correlation)
- **Misattribution risk:** HIGH and disqualifying: behind a shared proxy IP, announcements from concurrent users interleave and there is no field on the anonymous image GET to bind it to a specific announcement. A wrong bind unblurs a guarded user's art — the forbidden failure.
- **Cost:** High.
- **Vs current ladder:** rejected: this is A8 timing correlation in disguise; fail-closed policy forbids guesswork that can misattribute. At best it only re-confirms a user is 'present on this IP', which session-by-IP already does.

## sec-fetch-* request metadata
*Lens:* web-client-channels · *Verdict:* **complement** (feasibility 5/5, value 1/5)

- **Mechanism:** Browsers auto-send Sec-Fetch-Dest: image, Sec-Fetch-Site: same-origin, Sec-Fetch-Mode on image requests.
- **Coverage:** Web + WebView (native clients omit these).
- **Trust tier:** none for identity — carries request context, never a user
- **Misattribution risk:** N/A as an identity source. As a GUARD it lowers risk: requiring Sec-Fetch-Site: same-origin before honoring a cookie/marker rejects cross-site forged image requests.
- **Cost:** Trivial (read a header).
- **Vs current ladder:** complements: not an attribution mechanism, but a cheap anti-forgery/same-origin gate that can wrap the cookie and marker tiers to shrink the (already low) forged-signal surface.
- **Evaluator:** Not an attribution mechanism, and it only guards forged signals the threat model already tolerates (forgery self-spoils), so its value is marginal — and it must be scoped to the web-only cookie tier and never applied to the marker tier, since native TV/Swiftfin/Roku send no Sec-Fetch headers and would lose all attribution.

## High-entropy Client Hints device fingerprinting
*Lens:* web-client-channels · *Verdict:* **reject** (feasibility 2/5, value 0/5)

- **Mechanism:** Opt in via Accept-CH to Sec-CH-UA-* / device-memory / viewport hints and match the fingerprint against SessionInfo to narrow candidates.
- **Coverage:** Web + WebView (limited; many hints gated/coarse).
- **Trust tier:** weak narrowing
- **Misattribution risk:** Two identical browsers/devices are indistinguishable; a confident-but-wrong narrowing would unblur a guarded user. Only safe to WIDEN, never to pick.
- **Cost:** Medium.
- **Vs current ladder:** dominated: same class as A5 UA fingerprinting (already rejected as weak), and the signed cookie / server marker already attribute web precisely without fingerprint guesswork.
- **Evaluator:** Chromium-web-only and coarse (identical devices collide), SessionInfo stores no fingerprint to match against so you'd rebuild a lossy map, and any confident narrowing risks under-blur on a surface the marker+cookie already attribute exactly.

## Referer / Origin header context
*Lens:* web-client-channels · *Verdict:* **reject** (feasibility 5/5, value 0/5)

- **Mechanism:** Web image requests carry a Referer (details page URL) and Origin; parse for same-origin confirmation and item context.
- **Coverage:** Web + WebView (native clients send neither).
- **Trust tier:** none for user identity
- **Misattribution risk:** N/A as identity; useful only as a same-origin guard like sec-fetch.
- **Cost:** Trivial.
- **Vs current ladder:** complements weakly, subsumed by the sec-fetch same-origin guard.
- **Evaluator:** Carries zero user identity (native clients send neither) and its only real use, a same-origin sanity check, is already subsumed by the sec-fetch guard.

## Server ?tag= per-user marker (existing tier 2 — the workhorse)
*Lens:* web-client-channels · *Verdict:* **adopt-candidate** (feasibility 5/5, value 5/5)

- **Mechanism:** SpoilerIdentityTagFilter appends -jeu{12hex} (unkeyed SHA-256 prefix of userId) to every tag-bearing DTO field on authenticated responses, re-keying ImageBlurHashes in lockstep; the resolver decodes ?tag= → user, no IP involved.
- **Coverage:** EVERY client that echoes DTO tags — web, WebView, Android TV, Swiftfin, Roku (all verified to echo verbatim).
- **Trust tier:** strong disambiguation, proxy-proof
- **Misattribution risk:** Collisions dropped at map-build (both users fall back to IP ladder); stale/unknown marker falls back. Forgery only self-spoils.
- **Cost:** Already implemented and verified end-to-end.
- **Vs current ladder:** is the ladder's best tier and the reason most web-specific ideas above are dominated — it already delivers flicker-free per-user URL identity for all clients without client code.
- **Evaluator:** Incumbent load-bearing tier: proxy-proof per-user URL identity echoed verbatim by every client with fail-safe fallback on collision/stale/forged markers, and the reason most web-specific ideas here are dominated.

## ClaimsPrincipal from an authenticated token (existing tier 1)
*Lens:* web-client-channels · *Verdict:* **adopt-candidate** (feasibility 5/5, value 5/5)

- **Mechanism:** JF12 auth middleware populates HttpContext.User from a MediaBrowser Authorization header or ?ApiKey= even on anonymous image routes.
- **Coverage:** Any request that carries credentials — the Android native ImageProvider (launcher tiles) does; the flagship problem clients do NOT.
- **Trust tier:** authoritative
- **Misattribution risk:** None.
- **Cost:** Zero (already in place).
- **Vs current ladder:** baseline top tier; nothing beats it where credentials are present.
- **Evaluator:** Incumbent authoritative top tier with zero misattribution risk; unbeatable wherever credentials are present, though the flagship image-fetch clients send none so it rarely fires on the target gap.

## jc-spoiler-uid cookie validated by session-on-IP (existing tier 3)
*Lens:* web-client-channels · *Verdict:* **adopt-candidate** (feasibility 5/5, value 4/5)

- **Mechanism:** Raw-GUID cookie set by identity.ts, trusted only if that user has a session on the request IP.
- **Coverage:** Web + WebView.
- **Trust tier:** strong disambiguation (gated by IP presence)
- **Misattribution risk:** Low; the IP gate rejects stale/forged cookies naming absent users.
- **Cost:** Implemented.
- **Vs current ladder:** current tier; would be beaten/replaced by the signed-cookie variant (idea 1), which removes its proxy-IP dependency.
- **Evaluator:** Incumbent per-browser web disambiguator whose session-on-IP gate rejects stale/forged cookies naming absent users and stays correct even behind an IP-hiding proxy (the browser's own user always has a session on that proxy IP).

## Session-by-IP candidate set (existing tier 4, fail-closed)
*Lens:* web-client-channels · *Verdict:* **adopt-candidate** (feasibility 5/5, value 3/5)

- **Mechanism:** Every user with a session from the request IP becomes a candidate; consumers blur if ANY candidate guards the item.
- **Coverage:** All clients as a last resort.
- **Trust tier:** weak narrowing (ambiguous behind shared IPs)
- **Misattribution risk:** Over-blur (safe) not under-blur; but a proxy that hides the client IP collapses everyone into one set.
- **Cost:** Implemented.
- **Vs current ladder:** the safe floor; XFF (below) is the main lever to sharpen it for native clients.
- **Evaluator:** Incumbent fail-closed floor that only ever over-blurs (safe); correct but coarse, collapsing everyone into one set behind shared/NAT/proxy IPs, which is the residual gap the other tiers exist to sharpen.

## Plugin-level X-Forwarded-For learned real-IP → user map (A3, under consideration)
*Lens:* web-client-channels · *Verdict:* **narrowing-only** (feasibility 3/5, value 2/5)

- **Mechanism:** Read XFF directly (Jellyfin ignores it without Known Proxies, but Caddy/Traefik send it by default); build a real-IP→user map from authenticated requests' XFF, then match anonymous image requests' XFF against it. Sessions record the proxy IP, so a plugin-owned map is required.
- **Coverage:** Native TV/mobile behind a reverse proxy — the exact gap the marker doesn't already cover when a device holds pre-marker cached URLs.
- **Trust tier:** strong disambiguation when transport RemoteIp is a known/learned proxy; weak/forgeable otherwise
- **Misattribution risk:** XFF is client-forgeable → only use to NARROW, never authenticate; trust only when transport IP is a configured/auto-learned proxy. NAT still shares a real IP among users (residual ambiguity, fail closed).
- **Cost:** Medium (own IP→user map, proxy-trust logic, staleness).
- **Vs current ladder:** complements: the best available sharpener for native-client requests behind IP-hiding proxies, sitting below the marker and cookie tiers.
- **Evaluator:** Reading XFF is trivial but its only value-adding direction (narrowing the fail-closed set) reintroduces stale/reassigned/CGNAT real-IP under-blur risk in exactly its native-behind-proxy target scenario, and the safer supported fix (configure Jellyfin KnownProxies, already advised in the tier-4 warning) largely supersedes it.

## Token / deviceId sniffing off the image request (A1/A6)
*Lens:* web-client-channels · *Verdict:* **reject** (feasibility 4/5, value 0/5)

- **Mechanism:** Read a token or deviceId from the image request and resolve to user via IAuthorizationContext / IDeviceManager.
- **Coverage:** Only clients that send credentials on image fetches.
- **Trust tier:** authoritative if present
- **Misattribution risk:** None when present.
- **Cost:** Low, but moot.
- **Vs current ladder:** rejected/dead for the target clients: source-verified capture shows Android TV, Swiftfin, and Roku send NOTHING on image fetches; the Kotlin SDK image builder has no credential support. Clients that DO send credentials already hit tier 1.
- **Evaluator:** Source-verified that Android TV, Swiftfin and Roku put nothing on image fetches, and any client that does carry credentials already resolves authoritatively via tier-1 ClaimsPrincipal, so it adds nothing over the existing ladder.

## ConnectionId → user correlation (A4)
*Lens:* web-client-channels · *Verdict:* **reject** (feasibility 1/5, value 0/5)

- **Mechanism:** Map HttpContext.Connection.Id → user from an authenticated request; anonymous requests on the same kept-alive TCP connection inherit it.
- **Coverage:** Direct connections only.
- **Trust tier:** none behind a proxy
- **Misattribution risk:** HIGH: proxies pool upstream connections across downstream clients and HTTP/2 multiplexes many users onto few connections — inheriting identity would misattribute across users.
- **Cost:** N/A.
- **Vs current ladder:** rejected: unsafe in exactly the proxied deployment this project targets.
- **Evaluator:** Behind the reverse proxy this project targets, upstream keep-alive connections are pooled and HTTP/2-multiplexed across downstream users, so inheriting identity misattributes across users, and the direct-connection-only case it does cover is already handled by session-by-IP.

## User-Agent / device-header fingerprinting → session (A5)
*Lens:* web-client-channels · *Verdict:* **reject** (feasibility 1/5, value 0/5)

- **Mechanism:** Match request UA/device headers against SessionInfo Client/Device to narrow candidates.
- **Coverage:** All clients (coarsely).
- **Trust tier:** weak narrowing
- **Misattribution risk:** Two identical devices (e.g. two Shield TVs, okhttp/x.y.z) are indistinguishable; okhttp UA carries no per-user signal. Confident-but-wrong narrowing would unblur.
- **Cost:** Low.
- **Vs current ladder:** dominated/rejected as a picker; at most a safe candidate-set WIDENER, which adds nothing over session-by-IP.
- **Evaluator:** Identical devices (two Shield TVs on okhttp) are indistinguishable, and using UA to narrow the fail-closed candidate set can drop the actual guarding user from the set and leak clean bytes, while as a widener it adds nothing over session-by-IP.

## Timing / NowPlaying-browsing correlation (A8)
*Lens:* web-client-channels · *Verdict:* **reject** (feasibility 1/5, value 0/5)

- **Mechanism:** Attribute image bursts to whichever session was active around that time.
- **Coverage:** All clients.
- **Trust tier:** weak (guesswork)
- **Misattribution risk:** HIGH: concurrent users on a shared IP make timing ambiguous; a wrong bind unblurs guarded art.
- **Cost:** N/A.
- **Vs current ladder:** rejected: fail-closed policy forbids accidental misattribution.
- **Evaluator:** Concurrent users on a shared IP make any time-window bind guesswork, and a single wrong bind unblurs guarded art, directly violating the no-accidental-misattribution rule.

## Client-cooperation identity header (A7, Plethorafin/own fork)
*Lens:* web-client-channels · *Verdict:* **complement** (feasibility 5/5, value 2/5)

- **Mechanism:** The user's own Android TV fork (Plethorafin) adds an identifying header (uid or signed token) to its image requests.
- **Coverage:** Only clients the user controls — not stock Android TV/Swiftfin/Roku.
- **Trust tier:** strong/authoritative for cooperating clients
- **Misattribution risk:** None for the cooperating client; none for others (they simply fall through).
- **Cost:** Low on the fork side; server just reads the header (strictly additive).
- **Vs current ladder:** complements as bonus hardening for the user's own fork; not a general fix because stock clients cannot be changed server-side.
- **Evaluator:** Strictly additive and zero-misattribution (non-cooperating clients fall through), but it covers only the fork the user controls and the tag marker already attributes that client's warm-cache image requests, so it buys only the cold-cache and non-tag surfaces (user avatars/splash) for one client.

## Plugin-owned signed image route (own the endpoint, don't borrow ?tag=)
*Lens:* creative-wildcards · *Verdict:* **reject** (feasibility 2/5, value 1/5)

- **Mechanism:** Register a plugin controller at a NEW route (e.g. /JellyfinCanopy/Img/{signedToken}) and rewrite every image URL in authenticated per-user DTOs to point at it, where signedToken = HMAC(userId|itemId|imageType) under a persisted server secret. The client echoes the whole URL verbatim on the anonymous fetch; the plugin controller decodes token->user, decides blur vs clean, then streams bytes (or 302s to the real core endpoint for clean). Same per-user-DTO channel as the marker, but the identity lives in the PATH the plugin fully owns, not a core query param whose survival/filter-ordering the plugin only borrows.
- **Coverage:** Every client that echoes DTO image URLs (web + Android TV + Swiftfin + Roku, all verified to echo verbatim). Only items whose DTOs the plugin rewrote — same reach as the marker.
- **Trust tier:** strong disambiguation (per-user authenticated channel, proxy-proof, no IP)
- **Misattribution risk:** Low. A shared/forged token only opts the sender into another user's policy = self-spoil, acceptable per threat model. Real risk is functional (byte-proxy latency, cache-header/range-request correctness), not misattribution.
- **Cost:** Medium-high: new controller, HMAC mint/verify, image byte proxying or redirect, range/ETag/cache-control parity with core, DTO URL rewrite across every image field.
- **Vs current ladder:** complements — cleaner-ownership successor to the ?tag= marker (Tier 2). Same coverage, removes reliance on core keeping the tag param; costs a byte-proxy. Would sit at the marker's tier, not below it.
- **Evaluator:** Stock clients build item-image URLs from Id+ImageType+tag against the fixed /Items/{id}/Images path and never echo a server-supplied image URL, so there is no DTO lever to route them onto a plugin endpoint; where a token could actually ride (the tag) it is just a cache-hostile, persisted-secret version of the existing unkeyed marker with zero threat-model gain.

## Per-user item-id aliasing in DTOs + de-aliasing middleware
*Lens:* creative-wildcards · *Verdict:* **reject** (feasibility 1/5, value 1/5)

- **Mechanism:** Rewrite item.Id in every authenticated per-user DTO to aliasA(realId)=reversible per-user token; a middleware de-aliases on EVERY inbound route. Because the client builds ALL URLs (image, playback, userdata, deep links) from item.Id, the anonymous image request path GET /Items/{aliasA}/Images/Primary carries the per-user token universally — even when ?tag= is absent/stripped, and for user-image/splash surfaces the tag marker never reaches.
- **Coverage:** Universal across clients AND surfaces (path-based, not tag-based). The broadest theoretical reach of any mechanism.
- **Trust tier:** strong disambiguation (per-user channel in the path)
- **Misattribution risk:** Moderate-operational, low-attribution. Alias is a stable per-user URL token; user B opening user A's shared link is attributed A = self-spoil (acceptable). The severe risk is FUNCTIONAL breakage: any de-alias miss on any route (playback, sync, websocket item refs, cross-device resume, deep links) breaks the app, not just spoiler guard.
- **Cost:** Very high / high blast radius: rewrite the primary key everywhere, de-alias every route incl. websocket messages and client-cached ids, handle collisions and cross-user link sharing.
- **Vs current ladder:** dominated for images by the marker/signed-route (same identity, fraction of the risk). Uniquely covers non-tag surfaces, but the cost/breakage is disproportionate to the spoiler-guard payoff. Reject unless universal path identity is needed for many features.
- **Evaluator:** De-aliasing would have to cover every HTTP route AND websocket item references (which a server plugin cannot intercept) AND ids clients cached before the alias existed, so any miss breaks playback/resume/deep-links app-wide; for images it is strictly dominated by the marker at a fraction of the blast radius.

## Per-user endpoint: distinct Host / base-URL / path-prefix per user at device onboarding
*Lens:* creative-wildcards · *Verdict:* **complement** (feasibility 2/5, value 3/5)

- **Mechanism:** Give each user's device a distinct server URL (userA.jelly.lan, or a QuickConnect/setup-issued base URL with a per-user path prefix or port). Stock clients send the configured base URL's Host (and path prefix) on EVERY request including anonymous images. The plugin maps Host/prefix->user. Identity is baked into the client's server config once, at pairing.
- **Coverage:** All native clients universally (they all send Host and use their configured base URL for image fetches), proxy-proof, all image surfaces.
- **Trust tier:** strong-to-authoritative (set at device config; hard to collide accidentally)
- **Misattribution risk:** Low. Two users genuinely sharing one configured device/URL collapse to one identity = they are actually sharing, acceptable. No silent cross-user leak unless a device is deliberately reconfigured.
- **Cost:** High infra + onboarding friction: per-user DNS vhost or per-user path/port, a QuickConnect-style flow that hands each device the right URL, reverse-proxy routing. Ongoing per-new-device setup.
- **Vs current ladder:** complements — the only mechanism that fully solves the proxy-hides-IP native case WITHOUT needing the client to have received a stamped DTO first (works even on cold cache). Cost gates it to power users; strong where onboarding friction is acceptable.
- **Evaluator:** It is the only mechanism that identifies a native client on a cold cache behind an IP-hiding proxy without a prior stamped DTO, but it is mostly out-of-band DNS/reverse-proxy/onboarding infra rather than a plugin capability, and it misattributes whenever a device configured for one user is used by another logged-in user on the same app install.

## QuickConnect-style 'This TV is me' device/IP claim (user-consented pin)
*Lens:* creative-wildcards · *Verdict:* **narrowing-only** (feasibility 3/5, value 1/5)

- **Mechanism:** Injected web UI lists currently-active sessions / LAN client IPs and offers a 'this device is me' button. On click, plugin persists realIp(or deviceId)->userId. The anonymous image resolver adds a tier: if the request IP matches a claimed pin, attribute that user. User explicitly consents to the mapping.
- **Coverage:** Native clients on distinct LAN IPs (no proxy, or proxy that forwards real IP). Collapses behind an IP-hiding proxy.
- **Trust tier:** strong disambiguation (explicit user consent)
- **Misattribution risk:** Moderate: DHCP reassigns the pinned IP to a different device -> stale pin misattributes. Must expire pins on session-IP change / lease TTL and only pin when a live session from that IP already names the claiming user.
- **Cost:** Medium: injected UI panel, config map, resolver tier, staleness expiry.
- **Vs current ladder:** complements — a consented, higher-confidence layer above blind session-by-IP (Tier 4) for the LAN native case. Doesn't help behind an IP-hiding proxy (where the marker already carries the load).
- **Evaluator:** Its only safe form (trust the pin only while a live session from that IP already names the user) degenerates to session-by-IP, while the cold/uncorroborated form misattributes on DHCP reassignment and pins a shared proxy IP onto one user, and the fail-closed image filter gains nothing a picker could use safely.

## Admin device->user pinning UI (static assignment)
*Lens:* creative-wildcards · *Verdict:* **reject** (feasibility 3/5, value 1/5)

- **Mechanism:** Admin config table statically maps a fixed device (by learned LAN IP, or deviceId observed on that device's authenticated sessions/websocket) to a user — e.g. living-room TV = dad. Resolver consults the pin for anonymous requests from that IP.
- **Coverage:** Fixed-location native devices on stable IPs. deviceId isn't on image requests, so the actual match key is IP.
- **Trust tier:** strong disambiguation (admin-asserted) but only as good as IP stability
- **Misattribution risk:** Moderate, same DHCP-staleness failure as the user claim; worse because admin-set pins are long-lived and less likely to be corrected. Needs lease-aware expiry.
- **Cost:** Low-medium: config table + resolver tier.
- **Vs current ladder:** complements — useful for households with fixed devices and static DHCP reservations; a deliberate, auditable override above session-by-IP. Dominated by the marker wherever the client echoes stamped DTOs.
- **Evaluator:** The real match key is IP, so it is invisible behind the IP-hiding proxy it should help, and as an override it drops the true guarder under DHCP churn or a shared multi-profile TV (daughter guards X on the living-room TV pinned to dad -> her guarded art served clean) — the forbidden leak — while the additive-only safe form adds a candidate rather than disambiguating; the marker already names warm clients precisely.

## Learned realIp->user map from X-Forwarded-For on authenticated requests (A3, adopt)
*Lens:* creative-wildcards · *Verdict:* **complement** (feasibility 4/5, value 2/5)

- **Mechanism:** On every AUTHENTICATED request, record XFF-reported client IP -> userId. On anonymous image requests, read XFF directly (Jellyfin ignores it without KnownProxies, but Caddy/Traefik/nginx send it by default) and look up the learned map. Use additively to narrow, gate trust on the transport RemoteIp equaling a configured/auto-learned proxy address so arbitrary clients can't inject XFF.
- **Coverage:** Native clients behind a proxy that forwards XFF but that Jellyfin isn't configured to trust — exactly the gap where session-by-IP collapses AND the client hasn't yet cached a stamped (marker) URL.
- **Trust tier:** strong when transport-IP-gated to a known proxy; weak narrowing if ungated (XFF is client-forgeable)
- **Misattribution risk:** Low under the threat model: a forged XFF only self-spoils (opts into another present user's policy). Gate on trusted-proxy transport IP to keep it from being a blind override; never use to grant clean bytes to a fail-closed item.
- **Cost:** Low-medium: XFF parse, learned map with TTL, proxy-address config/auto-detect, resolver tier below the marker.
- **Vs current ladder:** complements — directly fills the proxy-hides-IP hole for cold-cache native clients (before they receive a stamped DTO). Sits between marker (Tier 2) and session-by-IP (Tier 4). The single highest-value addition to the current ladder.
- **Evaluator:** It is the only listed mechanism that safely adds NEW coverage (the transient cold-cache window, any DTO route the global tag filter misses, and single-user field-strip behind a proxy), but its blur benefit requires narrowing, which is unsafe because the learned map is a historical approximation that can miss a present user on a stale/changed real IP (leak) — so it must stay additive-for-blur, it only disambiguates when real IPs are distinct (useless for one household behind a single NAT), and it overlaps heavily with the already-shipped marker for all warm traffic, making it a hardening complement, not the headline adopt its framing claims.

## Direct-connection ConnectionId correlation (A4, reframed as LAN-only additive)
*Lens:* creative-wildcards · *Verdict:* **reject** (feasibility 3/5, value 0/5)

- **Mechanism:** When an authenticated request arrives on an ASP.NET connection, remember Connection.Id->user. Anonymous image requests reusing the same kept-alive TCP/HTTP-2 connection inherit that identity. Only trust it when the connection has ever carried exactly one authenticated user and the peer is a direct client (transport RemoteIp not a known proxy).
- **Coverage:** Direct-LAN native clients that pipeline images on their control connection. Useless behind connection-pooling/multiplexing proxies (the deployment we care about).
- **Trust tier:** strong on verified-direct single-user connections; unsafe otherwise
- **Misattribution risk:** High if applied behind a proxy (nginx/Caddy pool upstream connections across downstream users; HTTP/2 multiplexes many users onto few connections) -> cross-user leak. Must hard-gate to non-proxy transport IPs and single-user connections, else reject.
- **Cost:** Low: connection-keyed cache + resolver tier + strict gating.
- **Vs current ladder:** dominated by the marker for images generally; a narrow safe additive ONLY on verified-direct connections. Documented-reject behind proxies (matches A4 finding). Low incremental value given the marker.
- **Evaluator:** Its own safety gate disables it behind the connection-pooling/HTTP2-multiplexing proxies it is meant to fix, and on the only place it stays safe (direct single-user LAN) the client is already named by both the marker and an unshared-IP session lookup, so it contributes zero marginal coverage.

## WebSocket identity bridge (enrich the session-on-IP map)
*Lens:* creative-wildcards · *Verdict:* **reject** (feasibility 3/5, value 1/5)

- **Mechanism:** Native clients (Android TV etc.) open an AUTHENTICATED long-lived websocket carrying token+deviceId. On WS connect, learn (transport IP, deviceId, userId) fresher and more reliably than polling SessionInfo, and keep it live for the connection's lifetime. Feeds the session-by-IP candidate set.
- **Coverage:** Any client with an authenticated WS. Still IP-keyed for the image match, so behind an IP-hiding proxy it yields the SET of present users, not which one.
- **Trust tier:** strong for presence, weak for disambiguation behind shared IP
- **Misattribution risk:** Low: only supplies candidates to the existing fail-closed set; can't drop the guarding user.
- **Cost:** Low-medium: WS connect hook, live map.
- **Vs current ladder:** complements marginally — a freshness/robustness upgrade to Tier 4 session-by-IP (fewer aged-out sessions), not a new disambiguation axis. Dominated by the marker for actually naming the user.
- **Evaluator:** An open authenticated websocket IS a live session that Jellyfin core already keeps in ISessionManager.Sessions, so the bridge is largely redundant with the tier it feeds, its learned deviceId can't be matched against credential-free image requests, and it remains IP-keyed — supplying the same collapsed present-user set behind a proxy, not a new disambiguation axis.

## Header-set fingerprint narrowing within a shared IP (A5)
*Lens:* creative-wildcards · *Verdict:* **reject** (feasibility 2/5, value 0/5)

- **Mechanism:** Snapshot stable headers (User-Agent, Accept-Language, Sec-CH-* , client capability strings) on each user's authenticated requests; match anonymous image requests against them to narrow the shared-IP candidate set. Additive only — never drops a candidate.
- **Coverage:** Web mainly (rich headers); native clients send sparse headers.
- **Trust tier:** weak narrowing
- **Misattribution risk:** High if used to EXCLUDE candidates: two identical Android TVs are byte-identical in headers, so narrowing can wrongly drop the guarding user -> clean-bytes leak. Safe only as additive tie-break that never shrinks the fail-closed set.
- **Cost:** Low.
- **Vs current ladder:** dominated by the marker/cookie. Only value is a display-ordering hint; must not gate protection. Matches the A5 caution.
- **Evaluator:** Narrowing requires dropping candidates, but the problem clients (two identical Android TVs sending only 'okhttp/x.y.z') are header-identical so any drop can remove the true guarder -> clean bytes, and the promised 'never drop' additive form is a mere display-ordering hint that disambiguates nothing; rich headers exist only on web, which already has the cookie and marker.

## Stamp identity into requested image DIMENSIONS (maxWidth/fillWidth) [lens]
*Lens:* creative-wildcards · *Verdict:* **n/a** (feasibility ?/5, value ?/5)

- **Mechanism:** Idea: encode userId into the exact pixel value the client requests (e.g. fillWidth=440 vs 441). Reality: the DTO does NOT dictate image dimensions — the CLIENT picks fillWidth/fillHeight/maxWidth from its own display-grid constants. The plugin has no hook to make a stock client request a per-user width.
- **Coverage:** None on stock clients (client chooses dimensions).
- **Trust tier:** n/a
- **Misattribution risk:** n/a (unbuildable); if attempted by inference, identical devices request identical dimensions -> zero signal.
- **Cost:** n/a
- **Vs current ladder:** rejected — the plugin cannot control the client's requested dimensions; nothing to encode into. Dead end.

## Stamp identity into per-user QUALITY param [lens]
*Lens:* creative-wildcards · *Verdict:* **n/a** (feasibility ?/5, value ?/5)

- **Mechanism:** Same premise as dimensions: encode userId into the quality/format query value. Same defeat: quality is client-chosen, not DTO-driven; the plugin can't make a stock client emit a per-user quality.
- **Coverage:** None on stock clients.
- **Trust tier:** n/a
- **Misattribution risk:** n/a
- **Cost:** n/a
- **Vs current ladder:** rejected — client-controlled param, no plugin hook. Dead end (identical to the dimensions dead end).

## Steganographic markers embedded in served image bytes [lens]
*Lens:* creative-wildcards · *Verdict:* **n/a** (feasibility ?/5, value ?/5)

- **Mechanism:** Embed identity in the poster pixels so a later request can be attributed. Fatal ordering problem: identification must happen at REQUEST time, but stego lives in the RESPONSE. To close the loop the client would have to re-upload the cached image carrying the mark — stock clients never re-upload cached artwork, and there's no endpoint that would read it back.
- **Coverage:** None.
- **Trust tier:** n/a
- **Misattribution risk:** n/a
- **Cost:** n/a
- **Vs current ladder:** rejected — request precedes response; no re-upload path on stock clients. Dead end, as the lens suspected.

## Per-user BlurHash values as a covert channel [lens]
*Lens:* creative-wildcards · *Verdict:* **reject** (feasibility 0/5, value 0/5)

- **Mechanism:** Encode identity into ImageBlurHashes strings. But blurhash is consumed client-side to paint the placeholder and is NEVER sent back on any request, so it can't identify a future fetch. Same request-vs-response dead end as stego (and the tag filter already re-keys blurhash by tag).
- **Coverage:** None.
- **Trust tier:** n/a
- **Misattribution risk:** n/a
- **Cost:** n/a
- **Vs current ladder:** rejected — blurhash is never echoed to the server. Dead end.
- **Evaluator:** BlurHash is consumed client-side to paint a placeholder and is never echoed back on any request, so it cannot identify a future fetch — the same request-vs-response dead end as stego, and the tag filter already re-keys blurhash.

## Time-sliced identity windows [lens]
*Lens:* creative-wildcards · *Verdict:* **reject** (feasibility 1/5, value 0/5)

- **Mechanism:** Assign each active user a time slot and attribute anonymous requests in that window to them.
- **Coverage:** All surfaces in principle, but by guesswork.
- **Trust tier:** weak narrowing at best
- **Misattribution risk:** Forbidden-level. Pure temporal guessing assigns a fetch to the wrong user routinely; and because protection is fail-closed, any window that EXCLUDES the guarding user leaks their clean bytes. Directly violates the no-accidental-misattribution constraint.
- **Cost:** Low to build, unacceptable to ship.
- **Vs current ladder:** rejected — accidental misattribution by construction. Never gate protection on it.
- **Evaluator:** Pure temporal guessing routinely assigns a fetch to the wrong user, and any window excluding the guarding user leaks their clean bytes under fail-closed — a direct, by-construction violation of the no-accidental-misattribution rule, so it can never gate protection.

## Behavioral / collaborative inference from WHICH items are requested
*Lens:* creative-wildcards · *Verdict:* **reject** (feasibility 1/5, value 0/5)

- **Mechanism:** Infer the user from the set of item images being fetched matching a user's recent library view / recommendations.
- **Coverage:** All clients in principle.
- **Trust tier:** weak narrowing (probabilistic)
- **Misattribution risk:** Forbidden-level: overlapping libraries and shared home rows make the inference wrong often; a miss un-blurs a guarded item. Guesswork -> accidental misattribution.
- **Cost:** High (behavioral model), unacceptable to ship as a gate.
- **Vs current ladder:** rejected — same class as timing correlation; cannot fail closed safely.
- **Evaluator:** Inferring a single user from item-fetch patterns narrows/replaces the candidate set by guesswork and can drop the guarding user (overlapping libraries, shared home rows), leaking guarded bytes; it adds nothing safe over Tier 4, which already fail-closes across all IP-session users.

## Referer / Origin correlation for browser image fetches
*Lens:* creative-wildcards · *Verdict:* **reject** (feasibility 2/5, value 0/5)

- **Mechanism:** Browser <img>/CSS-background requests carry Referer (the page) and the jc-spoiler-uid cookie; correlate to the browsing user.
- **Coverage:** Web browsers only; native clients send no Referer.
- **Trust tier:** weak narrowing
- **Misattribution risk:** Low but redundant.
- **Cost:** Low.
- **Vs current ladder:** dominated — the jc-spoiler-uid cookie tier (Tier 3) already covers the browser case better. No incremental value.
- **Evaluator:** Referer names a page/origin, not a user, so it cannot attribute on its own, and the browser case it targets is already handled strictly better by the jc-spoiler-uid cookie tier (which names the user directly and is validated against session-on-IP); native clients send no Referer anyway — strictly dominated.

## Force-auth by proxying images through a plugin route that DEMANDS a token
*Lens:* creative-wildcards · *Verdict:* **reject** (feasibility 2/5, value 0/5)

- **Mechanism:** Rewrite DTO image URLs to a plugin route requiring ?ApiKey=/Authorization. Defeat: native clients building the URL won't attach credentials to it either (same anonymity that started the problem) unless the token is baked into the URL — which is just the signed-route/marker idea.
- **Coverage:** Degenerates to the signed-URL channel.
- **Trust tier:** n/a (reduces to signed route)
- **Misattribution risk:** n/a
- **Cost:** n/a
- **Vs current ladder:** dominated by the plugin-owned signed image route — same idea once you realize stock clients won't add fresh credentials; only a baked-in token works.
- **Evaluator:** Stock clients won't attach fresh credentials to a rewritten URL either, so it only works with a baked-in token — which is exactly the Tier 2 marker but with far worse cost (rewrite every DTO image URL, reimplement/proxy all artwork serving) and no way to intercept stale pre-update cached URLs that still hit core's anonymous endpoint; dominated by the existing tag marker on the existing action filter.

## Token sniffing off the image request (A1)
*Lens:* creative-wildcards · *Verdict:* **reject** (feasibility 5/5, value 0/5)

- **Mechanism:** Read any credential the client happens to attach to the image fetch (Authorization: MediaBrowser Token, ?ApiKey=) and resolve token->user; if JF12's auth handler already populates ClaimsPrincipal on anonymous routes when creds are present, Tier 1 already wins.
- **Coverage:** Verified EMPTY for the 5 tested native clients (they attach nothing to image requests). Covers only clients that do attach creds — already handled by Tier 1.
- **Trust tier:** authoritative when present
- **Misattribution risk:** None (real credential).
- **Cost:** ~zero (Tier 1 already reads ClaimsPrincipal).
- **Vs current ladder:** already covered by Tier 1; verified no-op for native clients per the capture log. Keep as the top tier, expect nothing extra from it for native.
- **Evaluator:** This is literally Tier 1 — the JF12 auth handler already populates ClaimsPrincipal for any attached ?ApiKey=/Authorization credential and RequestIdentityService reads it first — and the capture log confirms the target native clients attach nothing, so it is a verified no-op with zero incremental value over the current ladder.
