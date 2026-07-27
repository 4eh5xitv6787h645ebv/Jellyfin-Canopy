# Risk register

Tracking issue: [#39 — EP-00](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/39)
Status: **proposed** (EP-00). Reviewed at every milestone exit gate.

Scoring: likelihood and impact are Low / Medium / High. *Exposure* is the
combination. Security risks live in the [threat model](threat-model.md); this
register is about delivery, design and programme risk.

| # | Risk | L | I | Exposure | Mitigation | Owner |
|---|---|---|---|---|---|---|
| R-01 | **Nobody adopts it.** The platform is built and no third party ever writes an extension, so the whole programme is cost without return. | High | High | **High** | EP-10 requires three independently packaged consumers before v1 freezes. Dogfood real Canopy features through the platform so it earns its keep even at zero external adoption. | programme |
| R-02 | **Native clients never adopt**, so the platform is web-only in practice despite designing a portable protocol. | High | Medium | **High** | Keep the native schema deliberately tiny. Publish an adoption guide. Say "unsupported" plainly in the [client matrix](supported-client-matrix.md) rather than implying reach we do not have. | EP-08 |
| R-03 | **Scope explosion.** Twelve milestones with GA-grade acceptance criteria is a multi-year programme for a plugin. | High | High | **High** | The v1 capability freeze is small on purpose. Milestones must close on their exit gate, not on completeness. EP-00's own web-sandbox gap became a child issue rather than expanding this delivery. | programme |
| R-04 | **The web adapter is the real cost.** Slot rendering across modern/legacy/mobile/Web-TV, two extensions coexisting without collisions, a11y, i18n and jank budgets — while ADR-0007 is still unverified. | High | High | **High** | Provision Playwright and run the sandbox spike **first**, before any EP-07 implementation. ADR-0007 stays *provisional* until then. | EP-07 |
| R-05 | **Canopy's own velocity drops.** Kernel work competes with features and the bug inventory for the same maintainer. | Medium | High | **High** | Sequence platform work against the existing boards explicitly. EP-12 is deliberately last so no current feature work depends on an unfinished platform. | programme |
| R-06 | **Jellyfin 12 changes underneath.** Load-order behaviour, plugin loading, auth or the web client shift in a patch release. | Medium | High | **High** | Depend on no undocumented behaviour — lazy binding means load order is never load-bearing. Pin a tested patch matrix. Keep the weekly compatibility probe advisory but watched. | EP-11 |
| R-07 | **The kernel stays fused to Canopy.** The host-adapter seam erodes and extraction becomes impossible. | Medium | Medium | **Medium** | The seam is a build-enforced rule: an architecture test asserting the kernel references no `MediaBrowser.*` type directly, in the same style as the existing `AtomicFile` write guard. | EP-01 |
| R-08 | **Duplicate business logic.** A platform adapter grows its own copy instead of calling the owning service. | Medium | High | **High** | Parity tests proving legacy route and platform route reach the same owner. This is already a repository rule; the platform makes violating it much easier. | EP-06 |
| R-09 | **Public contract frozen too early**, locking in a design flaw for the life of v1. | Medium | High | **High** | Everything is *proposed* until EP-10 pilots run. Additive-only rules with a machine-enforced breaking-change gate. Two majors may coexist. | EP-10 |
| R-10 | **`RequestIdentityService` promoted without tests.** It has **no direct unit-test file** and is covered only indirectly. | Medium | High | **High** | Promotion is blocked until direct tests exist. Confidence tiers stay disambiguation-only. Recorded in [ADR-0011](adr/0011-identity-and-authority.md) and the [capability inventory](capability-inventory.md). | EP-02 |
| R-11 | **The two caller-id resolvers diverge further.** The codebase has two, with different claim fallbacks. | Medium | High | **High** | Converge on the claims-only resolver before v1; the looser one keeps its single legacy call site or is removed. This is the most likely root cause of a cross-user defect (**T-01**). | EP-02 |
| R-12 | **Coverage and warning ratchets block delivery**, tempting someone to weaken a floor. | Medium | Medium | **Medium** | Never weaken a ratchet. Platform code ships with its tests in the same PR. A tolerance requires repeated identical-scope measurements, a written rationale and a negative boundary test. | every milestone |
| R-13 | **Performance regression.** Reflection, JSON round-trips, schema validation and provider fan-out add latency to hot paths. | Medium | Medium | **Medium** | Publish budgets before implementing. Batch and lazily resolve contributions. Measure platform overhead against the direct path in EP-10. Keep the nightly scale tier in view. | EP-10 |
| R-14 | **Silent failures reach production.** The DI-returns-`null` mode is the archetype. | Medium | High | **High** | Every failure maps to a documented machine code; health probes and an explicit `incompatible` state; a "no silent failure" success metric that is actually tested. | EP-04 |
| R-15 | **A hot-disable assumption proves false.** ADRs assume a disabled extension stops working; only restart-based transitions were tested. | Medium | Medium | **Medium** | EP-03 must test hot disable explicitly. Until then, restart-driven discovery is what is claimed. | EP-03 |
| R-16 | **Load and concurrency behaviour unknown.** Every spike probe was sequential. | High | Medium | **High** | EP-05 and EP-11 own load, soak, storm and backpressure testing with published budgets. No concurrency claim is made before then. | EP-05 |
| R-17 | **Documentation drifts from the contract**, so consumers build against prose. | Medium | Medium | **Medium** | Checked-in OpenAPI/JSON Schema as the source of truth; CI rejects drift, stale examples and unverified snippets. This is the specific failure the current 183-route surface represents. | EP-09 |
| R-18 | **Two extension systems emerge** — the platform plus a resurrected user-scripts escape hatch. | Low | High | **Medium** | [Milestone 82 is superseded](milestone-82-disposition.md), with the reasoning recorded so it is not re-litigated. EP-11 closes it explicitly. | EP-11 |
| R-19 | **Registry state corruption** loses grants or approvals. | Low | High | **Medium** | Reuse `AtomicFile` and the quarantine/recovery model rather than inventing a second persistence path. Crash-injection tests. | EP-03 |
| R-20 | **Rebranding drift.** Roadmap issues say `JellyfinElevate`; the code says `JellyfinCanopy`. A contract could ship with the wrong identifier. | Medium | Medium | **Medium** | Corrected once, prominently, in [charter §0](charter.md#0-naming-before-anything-else). Child issues use the real identifiers. | EP-01 |
| R-21 | **Provider responses are unbounded.** No response cap exists today; a 2 MB response passed through the spike untouched. | Medium | Medium | **Medium** | A response cap is an EP-04 acceptance criterion, recorded in [ADR-0004](adr/0004-provider-invocation.md) as new work rather than an existing property. | EP-04 |

## Risks accepted without mitigation

| Risk | Why accepted |
|---|---|
| A malicious installed plugin can do anything a plugin can do | Not containable. Installing a plugin is an administrator trust decision made before the platform is involved. Documented as **T-03**; no programme document may claim otherwise. |
| A runaway provider cannot be terminated | .NET offers no mechanism. The deadline protects the caller only. |
| Jellyfin's permissive CORS | The host's behaviour, not ours. Every request is authorized on its own merits instead. |
