# Platform support and deprecation policy

Platform versions are promises to independent clients, not labels for the current
server implementation. The version in `/JellyfinCanopy/Platform/v1` is therefore a
literal protocol major. Compatible changes add to `v1`; an incompatible change is a
new route family such as `v2`. There is no mutable `latest` alias.

## Supported protocol window

Canopy supports protocol majors **N and N-1**. When `v2` ships, `v1` continues to
run beside it so clients can upgrade on their own schedules. A later major never
changes the meaning of an earlier route family.

Inside one protocol major, the contract is additive only. Published operations and
required fields remain present even if an operation is deprecated. The
`contracts/platform/v1/frozen.json` drift gate rejects their removal or
incompatible retyping.

The older `/JellyfinCanopy/*` routes are a separate compatibility surface. The
arrival of Platform routes does not deprecate them, and this registry does not
govern them.

## Deprecation registry

`contracts/platform/v1/deprecations.json` is the machine-readable source for
in-band notices. It deliberately ships with an empty
`operations` array: no Platform operation is currently deprecated.

Each future entry must identify one literal method and path and record:

- `deprecatedAtUtc`: the UTC instant announced in `Deprecation`;
- `sunsetAtUtc`: the earliest removal instant announced in `Sunset`;
- `deprecatedInCanopyVersion`: the Canopy release that announces the deprecation;
- `removalNotBeforeCanopyVersion`: the earliest Canopy release that may remove it.

CI rejects duplicate or unknown entries, a sunset less than 90 days after the
announcement, or a removal release less than one Canopy minor later. Removal is
never allowed in a patch release. The time and release windows are both minimums;
the later one wins.

After Jellyfin authorizes a request and MVC selects an operation in the registry,
its responses carry:

- `Deprecation: @<unix-seconds>` — the RFC 9745 structured-field date;
- `Sunset: <HTTP-date>` — the RFC 8594 sunset instant.

The registry is embedded in the plugin and parsed once. Request handling performs
one bounded operation lookup and no file I/O.

Authorization failures produced before MVC selects an operation remain host-owned
responses and do not carry these headers.

## Announcement and removal

A deprecation is complete only when it appears in all three places:

1. the response headers driven by the registry;
2. the release changelog;
3. the supported-client compatibility matrix.

Headers announce a schedule; they do not remove or disable an operation. The
operation must continue to answer throughout its support window, and every frozen
route remains protected by the additive-contract gate whether or not it is listed in
the registry. Security fixes may require a coordinated exception, documented in a
security advisory, the compatibility matrix, and release notes.

See the [Platform v1 contract](platform-contract.md) for wire-format and handshake
details.
