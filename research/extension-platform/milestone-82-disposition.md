# Milestone 82 — "User Scripts & Extensibility" — disposition

Tracking issue: [#39 — EP-00](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/39)
Status: **proposed disposition — superseded**. EP-11 closes the milestone
formally; this file records the reasoning so it is not re-litigated.

## What milestone 82 actually is

Open, with **zero issues** under it — a placeholder, never decomposed. Its full
description:

> `[P3] Upstream 239: admin-managed custom JS/CSS snippets injected via the
> plugin — a safe mini extension point.`

carrying its own assessment:

> `🟡 Doable with caveats · Effort S-M — technically trivial but a deliberate
> security footgun; admin-only with loud warnings (X1)`

It originates from `n00bcodr/Jellyfin-Enhanced#239`, a request to bundle five
third-party userscripts.

That self-assessment is honest and correct on both counts. It *is* trivial to
build, and it *is* a footgun. EP-00's job is to decide which of those facts wins.

## Why it is not "a safe mini extension point"

Six reasons, in descending order of severity.

1. **The snippet runs with the viewer's credentials, not the author's.** An
   administrator pastes it; it executes same-origin in *every user's* browser,
   with that user's token, full DOM access and full API access. An administrator
   who wanted to read another user's data could already do so — but this makes it
   an *accident* waiting to happen, and it makes a compromised admin account a
   permanent, invisible backdoor in every session. This is stored XSS with an
   approval workflow.

2. **There is no boundary to scope.** No manifest, no version, no capability
   declaration, no ownership, no lifecycle. Nothing to grant and therefore
   nothing to revoke. There is no smaller version of "arbitrary JavaScript".

3. **CSS is not the safe half.** Custom CSS lands on Jellyfin's shared
   `CustomCss` branding singleton, un-namespaced. A single rule can defeat
   Spoiler Guard's blur — a feature whose entire purpose is to withhold
   information from the person looking at the screen. The repository already
   treats config-derived CSS as a security sink with a build-failing
   injection guard, precisely because this class of bug is real.

4. **It is web-only.** It reaches browsers and WebView clients, and nothing else.
   It cannot deliver the native/TV reach the platform programme exists to make
   possible, so it is not even a partial substitute.

5. **It fights Canopy's own client architecture.** A raw snippet bypasses the
   single multiplexed body `MutationObserver` (a performance rule forbids
   feature-owned observers), the idempotent injection primitive, the three-layer
   teardown model and the feature loader's scope staleness. The predictable
   results are leaks, duplicate injection and jank — all of which the repository
   has machine-enforced rules against.

6. **Two extension systems would coexist.** One versioned, authorized, audited
   and bounded; one unbounded. Extension authors would use the unbounded one,
   because it is easier — and the platform would never be adopted. EP-11 lists
   "never ship two competing extension mechanisms" as a work package for exactly
   this reason.

## The disposition

**Superseded, not adopted as a compatibility consumer.**

EP-00 was asked to decide between two framings: *compatibility consumer* — keep
it, wrap it, treat its scripts as a legacy extension class — or *superseded*.

Compatibility consumer is rejected because there is nothing to wrap. A
compatibility adapter needs a boundary to adapt: an identity, a scope, a
lifecycle. Arbitrary same-origin JavaScript has none, and inventing them after
the fact would mean either breaking every existing snippet or granting the
adapter the same unbounded authority — which is the original problem with an
extra layer.

There is also nothing deployed to be compatible *with*: the milestone has zero
issues, no implementation, and Canopy's user-script history is already documented
as discontinued.

## What replaces it, concretely

The real requests behind those five userscripts are met by declarative slots:

| Typical userscript want | Platform replacement |
|---|---|
| add a button to item detail | C7 slot 4 — item-detail action |
| add a row to home | C7 slot 2 — home / media row |
| show a badge on a poster | C7 slot 3 — item badge |
| add a nav entry | C7 slot 1 — navigation entry |
| restyle something | admin theming and branding, which already exist |
| call an external service | a server-side provider, which also works on native clients |

See [`v1-capability-freeze.md`](v1-capability-freeze.md#c7--declarative-web-slots).

The honest trade-off: **some snippets will not be expressible.** A slot
vocabulary is bounded by construction, which is the entire point. The response to
a gap is to extend the vocabulary deliberately in a later version — not to
reopen an escape hatch.

## Actions

1. EP-11 closes milestone 82 as superseded, linking here.
2. The rejection is recorded in [ADR-0007](adr/0007-declarative-web-contributions.md)
   and in [charter §5](charter.md#5-what-v1-is-explicitly-not) so it is not
   reproposed without new evidence.
3. If a genuine need for arbitrary scripting reappears, it enters as a **new**
   proposal with a threat model, not as a revival of this one.
