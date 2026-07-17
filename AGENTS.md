# Jellyfin Canopy agent instructions

For every bug, feature, repository change, review, CI investigation, release,
or Project task, read and follow
[`.agents/skills/jellyfin-canopy-engineering/SKILL.md`](.agents/skills/jellyfin-canopy-engineering/SKILL.md).
Treat it as the canonical workflow; do not copy it into tool-specific files.

Optionally, to carry a change through a Bun-style multi-agent loop (parallel
explore/plan, single-writer implement, and a mixed-model adversarial
review-until-clean loop), use the accelerator at
[`.agents/skills/jellyfin-canopy-agentic-loop/SKILL.md`](.agents/skills/jellyfin-canopy-agentic-loop/SKILL.md).
It changes only *how* the work runs and obeys every contract and invariant here
and in the canonical skill unchanged.

Critical invariants:

- `n00bcodr/Jellyfin-Enhanced` is strictly read-only. Never push, open or edit
  GitHub items, or change its remote configuration.
- Keep this repository's work on
  `https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy`.
- Immediately before every push or merge, run
  `git remote get-url --push <remote>` and stop unless it resolves to that exact
  writable repository.
- Never overwrite unrelated working-tree changes. Use an isolated worktree and
  a dedicated branch for each issue.
- Do not deploy, publish a release, or mutate an external service unless the
  user explicitly authorizes that separate action.
