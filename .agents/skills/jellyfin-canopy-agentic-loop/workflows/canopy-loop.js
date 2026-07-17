export const meta = {
  name: 'canopy-loop',
  description:
    'Bun-style multi-agent loop for a Jellyfin Canopy change: parallel explore + plan, single-writer implement, adversarial review-until-clean, repo-native verify.',
  phases: [
    { title: 'Explore', detail: 'parallel read-only map of the owning layer, consumers, analogue, helpers, contracts, test seams' },
    { title: 'Plan', detail: 'independent plans judged and synthesised into one canonical plan' },
    { title: 'Implement', detail: 'single writer builds the change at its owner with failing-first tests' },
    { title: 'Review', detail: 'adversarial reviewers (split context) → verify findings → single fixer → repeat until clean' },
    { title: 'Verify', detail: 'repo-native gates for the surface; e2e:local for runtime-relevant work' },
  ],
}

// ── inputs ──────────────────────────────────────────────────────────────────
const a = args || {}
const WORKTREE = a.worktree || '.'
const BRANCH = a.branch || '(current branch)'
const TASK = a.task || 'No task text supplied.'
const BRIEF = a.brief || '(no brief path supplied — read AGENTS.md and the task text)'
const SURFACE = a.surface || 'cross' // client | server | cross | docs
const RUNTIME = a.runtime !== false && SURFACE !== 'docs'
const DEPTH = a.depth || 'standard' // quick | standard | deep
const BASE = a.base || 'origin/main'

const SIZING = {
  quick: { explorers: 2, planners: 2, roundCap: 2, verifyFixCap: 1 },
  standard: { explorers: 4, planners: 3, roundCap: 3, verifyFixCap: 2 },
  deep: { explorers: 6, planners: 3, roundCap: 4, verifyFixCap: 3 },
}[DEPTH] || { explorers: 4, planners: 3, roundCap: 3, verifyFixCap: 2 }

// Review lenses (see references/adversarial-review.md). Docs surface uses a
// narrower set; everything else gets the full standing panel.
const ALL_LENSES = [
  'Correctness & logic',
  'Security & privacy (fail closed)',
  'Lifecycle & concurrency',
  'Bounds & performance / no-jank',
  'Compatibility & platform (JF12/.NET10, MUI + legacy)',
  'Test strength',
  'Product semantics & scope',
  'Docs, locale & generated artifacts',
]
const LENSES =
  SURFACE === 'docs'
    ? ['Correctness & logic', 'Docs, locale & generated artifacts', 'Product semantics & scope']
    : DEPTH === 'quick'
    ? ALL_LENSES.slice(0, 5).concat('Docs, locale & generated artifacts')
    : ALL_LENSES

// Model mix for review (user policy): every review round runs BOTH the Claude
// lens reviewers above (≥1) AND ≥1 gpt-5.6-sol whole-diff reviewer at high
// effort. The Sol reviewer is obtained two ways, selected by args.solVia:
//   'agent'     — request the model directly on the subagent (default). Needs a
//                 Sol-capable route, e.g. the CLIProxyAPI router that exposes
//                 gpt-5.6-sol to Claude Code (vallettasoftware.com/blog/post/run-gpt-5-6-in-claude-code).
//                 No codex dependency.
//   'codex-cli' — a harness subagent shells out to the local `codex` CLI
//                 (-a never -s read-only exec -m gpt-5.6-sol) with the bundled
//                 output schema. Use where the router is not configured.
// The Sol pass is best-effort: if it errors/returns null the loop still runs on
// the Claude reviewers rather than failing.
const SOL_MODEL = a.solModel || 'gpt-5.6-sol'
const SOL_EFFORT = a.solEffort || 'high' // low|medium|high|xhigh|max|ultra
const SOL_REVIEWERS = a.solReviewers == null ? 1 : Math.max(0, a.solReviewers)
const SOL_VIA = a.solVia || 'agent' // 'agent' | 'codex-cli'
const CODEX_SCHEMA = '.agents/skills/jellyfin-canopy-agentic-loop/references/codex-review-schema.json'

// ── shared prompt preamble ──────────────────────────────────────────────────
const CONTRACTS = `You are working on the Jellyfin Canopy plugin repository in the worktree at:
  ${WORKTREE}
ALWAYS \`cd ${WORKTREE}\` first. The repository documents are the source of truth:
read AGENTS.md, CONTRIBUTING.md, SECURITY.md, the nearest instructions to the
files in scope, and .agents/skills/jellyfin-canopy-engineering/SKILL.md. Obey
every contract there (JF12/.NET10 boundary; MUI + legacy layouts both valid;
fail-closed auth/isolation/escaping/disposal/bounded work; coverage & lint caps
are ratchets; rebuild generated bundles/manifests/snapshots/translations from
source). Only this repository is writable; the Jellyfin-Enhanced repos are
read-only. Never deploy to :8099, release, or mutate an external service.

TASK:
${TASK}

TASK BRIEF: ${BRIEF}
`

const dedupeKey = (f) => `${f.file || '?'}|${f.line || 0}|${String(f.summary || '').slice(0, 60)}`
function dedupe(findings) {
  const seen = new Set()
  const out = []
  for (const f of findings) {
    const k = dedupeKey(f)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(f)
  }
  return out
}

// ── schemas ─────────────────────────────────────────────────────────────────
const EXPLORE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['owningLayer', 'files', 'consumers', 'contracts', 'testSeams'],
  properties: {
    owningLayer: { type: 'string' },
    files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, role: { type: 'string' } }, required: ['path', 'role'], additionalProperties: false } },
    consumers: { type: 'array', items: { type: 'string' } },
    analogue: { type: 'string', description: 'nearest already-implemented analogue to copy the shape of' },
    helpers: { type: 'array', items: { type: 'string' }, description: 'existing cross-cutting helpers to reuse instead of writing new' },
    contracts: { type: 'array', items: { type: 'string' }, description: 'repository/security/runtime contracts this change touches' },
    testSeams: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}
const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'owningLayer', 'steps', 'tests', 'stateModel'],
  properties: {
    summary: { type: 'string' },
    owningLayer: { type: 'string' },
    reuseDecisions: { type: 'array', items: { type: 'string' } },
    stateModel: { type: 'string', description: 'the simplest state/failure model; what NOT to add' },
    steps: { type: 'array', items: { type: 'string' } },
    tests: { type: 'array', items: { type: 'string' }, description: 'failing-first tests incl. admin/non-admin & negative paths' },
    localeDocs: { type: 'array', items: { type: 'string' }, description: 'locale keys and docs to update' },
    risks: { type: 'array', items: { type: 'string' } },
    nonGoals: { type: 'array', items: { type: 'string' } },
  },
}
const IMPLEMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['changedFiles', 'commits', 'selfConfidence'],
  properties: {
    changedFiles: { type: 'array', items: { type: 'string' } },
    commits: { type: 'array', items: { type: 'string' } },
    testsAdded: { type: 'array', items: { type: 'string' } },
    diffStat: { type: 'string' },
    selfConfidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    openTodos: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}
const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'summary', 'failureScenario'],
        properties: {
          lens: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'integer' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          summary: { type: 'string' },
          failureScenario: { type: 'string', description: 'concrete inputs/state → wrong output/crash/leak/contract violation' },
        },
      },
    },
  },
}
const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['real', 'reason'],
  properties: {
    real: { type: 'boolean', description: 'true only if the finding genuinely reproduces / violates a contract' },
    reason: { type: 'string' },
    severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
  },
}
const FIX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['applied', 'commits'],
  properties: {
    applied: { type: 'array', items: { type: 'string' } },
    commits: { type: 'array', items: { type: 'string' } },
    designChange: { type: 'string', description: 'if a fix simplified/deleted state instead of adding a guard, say how' },
    unresolved: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}
const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['gates', 'allBlockingPassed'],
  properties: {
    gates: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'pass'], properties: { name: { type: 'string' }, pass: { type: 'boolean' }, evidence: { type: 'string' } } } },
    allBlockingPassed: { type: 'boolean', description: 'true if every BLOCKING gate passed (lint is advisory, not blocking)' },
    e2e: { type: 'object', additionalProperties: false, properties: { run: { type: 'boolean' }, pass: { type: 'boolean' }, evidence: { type: 'string' } } },
    failures: { type: 'array', items: { type: 'string' } },
  },
}

// ── gate command list by surface ────────────────────────────────────────────
function gateCommands() {
  const core = ['npm run check:toolchain', './verify.sh lint   # ADVISORY — findings do not block', 'git diff --check']
  const client = ['npm run typecheck:src', 'npm run typecheck', 'npm run test:client:coverage', 'npm run build:bundle', 'npm run syntax']
  const server = ['dotnet build Jellyfin.Plugin.JellyfinCanopy/JellyfinCanopy.csproj -c Release', 'npm run test:server:coverage']
  const scripts = ['npm run test:scripts']
  const docs = ['npm run check:docs']
  let g = [...core]
  if (SURFACE === 'client' || SURFACE === 'cross') g = g.concat(client)
  if (SURFACE === 'server' || SURFACE === 'cross') g = g.concat(server)
  g = g.concat(scripts) // scripts tests are cheap and catch tooling regressions
  g = g.concat(['npm run validate-translations   # if any locale file changed'])
  if (SURFACE === 'docs' || SURFACE === 'cross') g = g.concat(docs)
  return g
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 1 — EXPLORE (parallel, read-only)
// ═══════════════════════════════════════════════════════════════════════════
phase('Explore')
log(`canopy-loop: ${DEPTH} depth · surface=${SURFACE} · runtime=${RUNTIME} · branch ${BRANCH}`)

const exploreAngles = [
  'the OWNING module and the exact functions/types that must change',
  'every PRODUCER and CONSUMER of the affected behavior (grep the whole tree)',
  'the nearest ALREADY-IMPLEMENTED analogue and the existing cross-cutting helpers to reuse',
  'the CONTRACTS at risk (auth/isolation/escaping/disposal/bounded-work/live-config) and the TEST SEAMS',
  'the CLIENT surface: MUI + legacy layouts, native markup, locale keys, docs impacted',
  'the SERVER surface: controllers/services/scheduled tasks, .NET tests, generated artifacts',
].slice(0, SIZING.explorers)

const explorations = (
  await parallel(
    exploreAngles.map((angle, i) => () =>
      agent(
        `${CONTRACTS}

PHASE: EXPLORE (read-only — do NOT edit any file).
Your angle: ${angle}.
Use rg/ls/Read to trace real code. Return a precise map: where the change lives,
who is affected, the analogue to copy, helpers to reuse (so we don't write new),
the contracts touched, and the test seams. Cite real paths; never guess.`,
        { schema: EXPLORE_SCHEMA, agentType: 'Explore', effort: 'medium', phase: 'Explore', label: `explore:${i + 1}` }
      )
    )
  )
).filter(Boolean)

const exploreDigest = JSON.stringify(explorations, null, 1).slice(0, 12000)
log(`Explore: ${explorations.length} maps returned`)

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 2 — PLAN (independent plans → adversarial synthesis into one)
// ═══════════════════════════════════════════════════════════════════════════
phase('Plan')

const planAngles = [
  'MINIMAL-CHANGE first: the smallest change at the true owner; delete/delegate state before adding any.',
  'RISK first: identify the failure modes and design the state/failure model that fails closed with fewest moving parts.',
  'REUSE first: maximise use of existing helpers/analogue; avoid any parallel implementation of a shared behavior.',
].slice(0, SIZING.planners)

const plans = (
  await parallel(
    planAngles.map((angle, i) => () =>
      agent(
        `${CONTRACTS}

PHASE: PLAN (read-only). Explore maps (JSON):
${exploreDigest}

Produce an implementation plan with this bias: ${angle}
Choose the owning layer, reuse-vs-new decisions, the SIMPLEST state/failure
model (and explicitly what NOT to add — no speculative flag/retry/lock/observer/
polling/migration), the failing-first tests (admin AND non-admin, negative/
fallback, concurrency/cache invalidation where relevant), and the locale keys +
docs to update.`,
        { schema: PLAN_SCHEMA, effort: 'high', phase: 'Plan', label: `plan:${i + 1}` }
      )
    )
  )
).filter(Boolean)

const canonicalPlan = await agent(
  `${CONTRACTS}

PHASE: PLAN SYNTHESIS (read-only). You are the adversarial judge. Here are ${plans.length}
independent plans (JSON):
${JSON.stringify(plans, null, 1).slice(0, 12000)}

Score them against the brief and the repository contracts. Pick the strongest
spine and graft the best ideas from the others. Reject scope creep and any
avoidable new state. Output ONE canonical plan the implementer will follow
exactly. Prefer the plan that adds the least and reuses the most.`,
  { schema: PLAN_SCHEMA, effort: 'high', phase: 'Plan', label: 'plan:synthesis' }
)
log(`Plan: ${plans.length} plans → 1 canonical (${(canonicalPlan && canonicalPlan.owningLayer) || 'n/a'})`)

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 3 — IMPLEMENT (single writer)
// ═══════════════════════════════════════════════════════════════════════════
phase('Implement')

const implemented = await agent(
  `${CONTRACTS}

PHASE: IMPLEMENT. You are the SOLE writer in this worktree. Follow this canonical
plan exactly (JSON):
${JSON.stringify(canonicalPlan, null, 1).slice(0, 12000)}

Rules:
- Build the change at its owning layer and update EVERY affected consumer. Fix
  shared behavior once at its source; do not patch one consumer or copy a helper.
- Add tests that FAIL before the change and pass after: admin AND non-admin,
  negative/fallback, concurrency/cache invalidation where relevant, non-vacuous
  assertions that prove the intended lower tier ran.
- Add every new locale key to ALL locale files with real translations. Update
  affected user/admin/architecture/security docs. Rebuild generated
  bundles/manifests/snapshots from source if the repo expects it.
- Do NOT add live activation, polling, retries, migrations, config, or startup
  work unless the plan requires it. Give each side effect exactly one owner.
- Commit coherent conventional units (feat/fix/chore/docs). NO \`Co-Authored-By\`
  trailers. Keep issue "#N" out of commit messages and comments.
- Run the directly-affected focused tests as you go. Do not run the full gate.
Report the changed files, commits, tests added, a diff stat, and an honest
self-confidence (high/medium/low) with any open TODOs.`,
  { schema: IMPLEMENT_SCHEMA, agentType: 'general-purpose', effort: 'high', phase: 'Implement', label: 'implement' }
)
log(`Implement: ${(implemented && implemented.changedFiles && implemented.changedFiles.length) || 0} files, confidence ${(implemented && implemented.selfConfidence) || '?'}`)

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 4 — ADVERSARIAL REVIEW LOOP (parallel review → verify → single fixer)
// ═══════════════════════════════════════════════════════════════════════════
phase('Review')

const reviewContext = `${CONTRACTS}

The change is on branch ${BRANCH}. Inspect it with:
  git -C ${WORKTREE} diff ${BASE}...HEAD
  git -C ${WORKTREE} log --oneline ${BASE}..HEAD
You see ONLY the diff and this brief — never the implementer's reasoning.`

// gpt-5.6-sol whole-diff adversarial reviewer (high effort). One thunk per Sol
// reviewer; obtained via the subagent model param ('agent') or the codex CLI.
function solThunk(roundNo, i) {
  const solPrompt = `${reviewContext}

PHASE: ADVERSARIAL REVIEW (gpt-5.6-sol, whole diff). Assume the change is WRONG and
prove how. Cover correctness, security/privacy (fail-closed), lifecycle/
concurrency, bounds/perf/no-jank, JF12 + MUI/legacy compatibility, test strength,
product scope, and docs/locale/generated-artifact gaps. Every finding needs a
real file/line and a concrete failure scenario (inputs/state → wrong output /
crash / leak / contract violation). Reject workarounds that need a paragraph-long
comment to justify them. Watch for mechanically-similar-but-semantically-
different code. Return only real findings (empty array if none).`

  if (SOL_VIA === 'codex-cli') {
    return () =>
      agent(
        `${reviewContext}

PHASE: gpt-5.6-sol REVIEW via the local \`codex\` CLI. You are a HARNESS — run the
external reviewer and relay its structured findings; do NOT review yourself.
Run from ${WORKTREE} (HEAD must be committed and clean):
  P=$(mktemp); R=$(mktemp); EV=$(mktemp); ER=$(mktemp)
  cat > "$P" <<'SOL_PROMPT'
${solPrompt}
SOL_PROMPT
  codex -a never -s read-only exec -C "${WORKTREE}" --ephemeral --ignore-user-config \\
    --color never --json -m "${SOL_MODEL}" -c model_reasoning_effort="${SOL_EFFORT}" \\
    --output-schema "${WORKTREE}/${CODEX_SCHEMA}" -o "$R" - < "$P" > "$EV" 2> "$ER"
Then read "$R" (JSON conforming to the schema) and RETURN its findings mapped to
THIS tool's schema (lens="gpt-5.6-sol", file, line, severity, summary,
failureScenario). If \`codex\` is missing or exits non-zero, RETURN
{"findings":[]} — never fail the call.`,
        { schema: FINDINGS_SCHEMA, agentType: 'general-purpose', effort: 'medium', phase: 'Review', label: `sol-cli-r${roundNo}:${i + 1}` }
      )
  }
  return () =>
    agent(solPrompt, { schema: FINDINGS_SCHEMA, model: SOL_MODEL, effort: SOL_EFFORT, phase: 'Review', label: `sol-r${roundNo}:${i + 1}` })
}

const confirmedAll = []
let cleanRound = false
let round = 0
while (round < SIZING.roundCap && !cleanRound) {
  round++
  log(`Review round ${round}/${SIZING.roundCap} — ${LENSES.length} Claude lenses + ${SOL_REVIEWERS}× ${SOL_MODEL} (${SOL_VIA}, ${SOL_EFFORT})`)

  const claudeThunks = LENSES.map((lens, i) => () =>
    agent(
      `${reviewContext}

PHASE: ADVERSARIAL REVIEW — lens: "${lens}".
Assume the change is WRONG and prove how, THROUGH THIS LENS ONLY. A finding needs
a real file/line and a concrete failure scenario (inputs/state → wrong output /
crash / leak / contract violation). "Looks fine" is not a finding. Watch for
mechanically-similar-but-semantically-different code (side effects inside
asserts/guards, eager vs lazy defaults, odd-length buffer truncation, bounds
checks present in one build only, byte-vs-UTF assumptions, escape/format passes
over the wrong data). Reject any workaround that needs a paragraph-long comment
to justify it. Return only real findings (empty array if none this lens).`,
      { schema: FINDINGS_SCHEMA, agentType: 'code-reviewer', effort: 'medium', phase: 'Review', label: `review-r${round}:${i + 1}` }
    )
  )
  const solThunks = Array.from({ length: SOL_REVIEWERS }, (_, i) => solThunk(round, i))

  const raw = (await parallel([...claudeThunks, ...solThunks]))
    .filter(Boolean)
    .flatMap((r) => (r && r.findings) || [])

  const deduped = dedupe(raw)
  if (!deduped.length) {
    cleanRound = true
    log(`Review round ${round}: clean (no findings)`)
    break
  }

  // Adversarially verify each finding — try to REFUTE it; default refuted.
  const verdicts = await parallel(
    deduped.map((f, i) => () =>
      agent(
        `${reviewContext}

PHASE: VERIFY FINDING. Try hard to REFUTE this claimed defect. Default to
real=false when uncertain — only real=true if it genuinely reproduces or truly
violates a repository contract on a reachable path.
FINDING (${f.lens || '?'}) ${f.file}:${f.line || '?'} — ${f.summary}
SCENARIO: ${f.failureScenario}`,
        { schema: VERDICT_SCHEMA, agentType: 'code-reviewer', effort: 'medium', phase: 'Review', label: `verify-r${round}:${i + 1}` }
      )
    )
  )

  const confirmed = deduped.filter((f, i) => verdicts[i] && verdicts[i].real)
  if (!confirmed.length) {
    cleanRound = true
    log(`Review round ${round}: ${deduped.length} findings, all refuted → clean`)
    break
  }
  confirmedAll.push(...confirmed.map((f, i) => ({ ...f, round })))
  log(`Review round ${round}: ${confirmed.length} confirmed → fixing`)

  await agent(
    `${CONTRACTS}

PHASE: FIX. You are the SOLE writer. Apply ONLY these confirmed findings at their
owning layer, add regression evidence for each, and commit coherent units.
Before adding any new state flag/retry/lock/publisher/lifecycle path — or making
a second fix to the same state machine/owner — STOP and try deletion, reuse, or
single ownership first; simpler is required over another guard. Do not fix
anything not listed. NO \`Co-Authored-By\` trailers.

CONFIRMED FINDINGS:
${JSON.stringify(confirmed, null, 1).slice(0, 10000)}`,
    { schema: FIX_SCHEMA, agentType: 'general-purpose', effort: 'high', phase: 'Review', label: `fix-r${round}` }
  )
}
if (!cleanRound) log(`Review: hit round cap (${SIZING.roundCap}) with unresolved findings — will report as residual risk`)

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 5 — VERIFY (single runner; bounded fix-and-reverify)
// ═══════════════════════════════════════════════════════════════════════════
phase('Verify')

const gateList = gateCommands()
const e2eBlock = RUNTIME
  ? `\nRUNTIME PROOF (this change affects runtime): build the Release DLL if not
already built, then run the dockerized E2E:
  dotnet build Jellyfin.Plugin.JellyfinCanopy/JellyfinCanopy.csproj -c Release
  npm run e2e:local        # dockerized jellyfin/jellyfin:unstable, 4 shards / 2 CPUs
Exercise BOTH admin and non-admin. Assert real DOM/server state, ZERO
non-whitelisted console errors, ZERO unexpected plugin 4xx. Tear down only the
Compose projects this run created. Do NOT touch :8099 or any shared/prod server.`
  : `\n(No runtime proof required for this surface.)`

let verify = null
let vround = 0
while (vround <= SIZING.verifyFixCap) {
  verify = await agent(
    `${CONTRACTS}

PHASE: VERIFY. Run the repository-native gates for surface="${SURFACE}", in order,
from ${WORKTREE}. Lint is ADVISORY (findings never block); every other gate is
BLOCKING. Do not pipe wrappers through tail/grep/tee in a way that hides exit
status. Do not run a plain suite right before its coverage variant.

GATES:
${gateList.map((g) => '  ' + g).join('\n')}
${e2eBlock}

Report each gate's pass/fail with short evidence (counts/versions), whether
ALL BLOCKING gates passed, the e2e result if run, and a list of failures.`,
    { schema: VERIFY_SCHEMA, agentType: 'general-purpose', effort: 'medium', phase: 'Verify', label: vround === 0 ? 'verify' : `verify-retry-${vround}` }
  )

  const gatesOk = verify && verify.allBlockingPassed
  const e2eOk = !RUNTIME || (verify && verify.e2e && verify.e2e.pass)
  if (gatesOk && e2eOk) {
    log(`Verify: all blocking gates${RUNTIME ? ' + e2e' : ''} green`)
    break
  }
  vround++
  if (vround > SIZING.verifyFixCap) {
    log(`Verify: still failing after ${SIZING.verifyFixCap} fix attempts — reporting failures`)
    break
  }
  log(`Verify: failures → fix attempt ${vround}/${SIZING.verifyFixCap}`)
  await agent(
    `${CONTRACTS}

PHASE: VERIFY-FIX. You are the SOLE writer. Fix ONLY the real regressions behind
these gate/e2e failures at their owner — never weaken coverage, timeouts,
assertions, security policy, or E2E scope to go green, and never lower a ratchet.
Commit the fix. FAILURES:
${JSON.stringify((verify && verify.failures) || [], null, 1).slice(0, 8000)}`,
    { schema: FIX_SCHEMA, agentType: 'general-purpose', effort: 'high', phase: 'Verify', label: `verify-fix-${vround}` }
  )
}

// ── return structured result for the main thread to relay + act on ──────────
const blockingGreen = !!(verify && verify.allBlockingPassed)
const e2eGreen = !RUNTIME || !!(verify && verify.e2e && verify.e2e.pass)
const result = {
  branch: BRANCH,
  surface: SURFACE,
  depth: DEPTH,
  loopClean: cleanRound,
  reviewRounds: round,
  confirmedFindingsResolved: confirmedAll.length,
  implement: implemented || null,
  canonicalPlan: canonicalPlan || null,
  verify: verify || null,
  readyForPR: cleanRound && blockingGreen && e2eGreen,
  residualRisks: []
    .concat(cleanRound ? [] : ['review loop hit its round cap with unresolved confirmed findings'])
    .concat(blockingGreen ? [] : ['one or more BLOCKING gates are failing'])
    .concat(e2eGreen ? [] : ['e2e:local did not pass'])
    .concat((implemented && implemented.openTodos) || []),
}
log(
  `canopy-loop done: readyForPR=${result.readyForPR} · rounds=${round} · findings resolved=${confirmedAll.length} · blockingGreen=${blockingGreen}${RUNTIME ? ` · e2e=${e2eGreen}` : ''}`
)
return result
