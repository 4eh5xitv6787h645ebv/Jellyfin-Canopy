export const meta = {
  name: 'canopy-loop',
  description:
    'Bun-style multi-agent loop for a Jellyfin Canopy change: parallel explore + plan, single-writer implement, adversarial review-until-clean, repo-native verify.',
  phases: [
    { title: 'Explore', detail: 'parallel read-only map of the owning layer, consumers, analogue, helpers, contracts, test seams' },
    { title: 'Plan', detail: 'independent plans judged and synthesised into one canonical plan' },
    { title: 'Implement', detail: 'single writer builds the change at its owner with failing-first tests' },
    { title: 'Review', detail: 'adversarial reviewers (split context) → verify findings → single fixer → repeat until clean' },
    { title: 'Localize', detail: 'cheap low-effort agent fans base-locale keys out to all locales — not reviewed' },
    { title: 'Verify', detail: 'repo-native gates for the surface; e2e:local for runtime-relevant work' },
  ],
}

// ── inputs ──────────────────────────────────────────────────────────────────
// The Workflow harness sometimes delivers `args` as a JSON STRING rather than a
// parsed object (docs: "a stringified object reaches the script as one string").
// If we don't parse it, `a.task`/`a.worktree`/… are all undefined and every
// input silently defaults (worktree ".", "No task text supplied") — which makes
// the loop correctly HALT but on empty input. Parse defensively so real args land.
const a = (() => {
  try {
    if (typeof args === 'string') return JSON.parse(args) || {}
    return args || {}
  } catch (_) {
    return {}
  }
})()
const WORKTREE = a.worktree || '.'
const BRANCH = a.branch || '(current branch)'
const TASK = a.task || 'No task text supplied.'
const BRIEF = a.brief || '(no brief path supplied — read AGENTS.md and the task text)'
// Inlined brief CONTENTS (preferred). The script sandbox cannot read files, so
// the launcher should read the brief and pass its text here — otherwise agents
// may never open the path and will infer the task from weaker signals.
const BRIEF_TEXT = a.briefText || ''
// client | server | cross | docs. An unknown value (e.g. a launcher typo like
// "clinet") must NOT silently skip all surface-specific gates — fail closed to
// 'cross', the superset that runs every surface's verification.
const KNOWN_SURFACES = ['client', 'server', 'cross', 'docs']
const SURFACE_INPUT = a.surface || 'cross'
const SURFACE = KNOWN_SURFACES.includes(SURFACE_INPUT) ? SURFACE_INPUT : 'cross'
const SURFACE_COERCED = SURFACE !== SURFACE_INPUT
const RUNTIME = a.runtime !== false && SURFACE !== 'docs'
const DEPTH = a.depth || 'standard' // quick | standard | deep
const BASE = a.base || 'origin/main'
// User policy: INCLUDE the issue number in commit messages (traceability). Derived
// from the branch (fix/issue-<N>) or args.issue. The main thread additionally puts
// "Closes #<N>" in the PR body so a merge auto-closes the issue + moves the board item.
const ISSUE_REF = (() => {
  const raw = a.issue != null ? String(a.issue) : ((/issue[-/]?(\d+)/i.exec(BRANCH) || [])[1] || '')
  const n = String(raw).replace(/[^0-9]/g, '')
  return n ? '#' + n : ''
})()
const COMMIT_RULE =
  'Commit hygiene: NO `Co-Authored-By` trailers' +
  (ISSUE_REF ? `, and INCLUDE the issue number ${ISSUE_REF} in each commit subject (end the subject with " (${ISSUE_REF})")` : '') +
  '.'

// roundCap here is the MIXED-panel review cap (Claude lenses + gpt-5.6-sol). If
// the loop still isn't clean after it, review CONTINUES with gpt-5.6-sol as the
// ONLY reviewer up to HARD_ROUND_CAP (see the review loop). explorers is the
// TOTAL explorer count; the first EXPLORE_CLAUDE_COUNT run on Claude/Opus and the
// rest on gpt-5.6-sol (see exploreSol).
const SIZING = {
  quick: { explorers: 2, planners: 2, roundCap: 2, verifyFixCap: 1 },
  standard: { explorers: 8, planners: 3, roundCap: 4, verifyFixCap: 2 },
  deep: { explorers: 8, planners: 3, roundCap: 4, verifyFixCap: 3 },
}[DEPTH] || { explorers: 8, planners: 3, roundCap: 4, verifyFixCap: 2 }

// Review lenses (see references/adversarial-review.md). Docs surface uses a
// narrower set; everything else gets the full standing panel.
const ALL_LENSES = [
  'Requirement fidelity (does it fix the ACTUAL reported defect and satisfy EVERY acceptance criterion — not an easier semantically-different change?)',
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
//   'agent'     — request the model directly on the subagent. Needs a
//                 Sol-capable route, e.g. the CLIProxyAPI router that exposes
//                 gpt-5.6-sol to Claude Code (vallettasoftware.com/blog/post/run-gpt-5-6-in-claude-code).
//                 No codex dependency.
//   'codex-cli' — (default) a harness subagent shells out to the local `codex` CLI
//                 (-a never -s read-only exec -m gpt-5.6-sol) with the bundled
//                 output schema. Use where the router is not configured.
// The Sol pass is best-effort: if it errors/returns null the loop still runs on
// the Claude reviewers rather than failing.
const SOL_MODEL = a.solModel || 'gpt-5.6-sol'
const SOL_EFFORT = a.solEffort || 'high' // low|medium|high|xhigh|max|ultra
const SOL_REVIEWERS = a.solReviewers == null ? 1 : Math.max(0, a.solReviewers)
// Default to the local codex CLI: it works without any router setup. Use 'agent'
// only where Claude Code is routed to a Sol-capable endpoint (CLIProxyAPI). Under
// BOTH routes the 50/50 read-only split (splitAgent/soloSolAgent) offloads the odd
// slots to Sol: the 'agent' route uses the subagent model param, and 'codex-cli'
// runs those slots through the codex harness (codexAgent) at SOL_LIGHT_EFFORT. So
// under the default codex-cli, explore/plan/synthesis DO save Claude budget — the
// review round additionally always gets ≥1 whole-diff Sol reviewer.
const SOL_VIA = a.solVia || 'codex-cli' // 'codex-cli' | 'agent'
// Path to the codex --output-schema. Defaults inside the target worktree, but
// can be overridden (e.g. an absolute path) when the skill files are not yet in
// the worktree — such as running the loop before this skill is merged to main.
const CODEX_SCHEMA_PATH =
  a.codexSchema || `${WORKTREE}/.agents/skills/jellyfin-canopy-agentic-loop/references/codex-review-schema.json`
// Per-run random heredoc delimiter for the codex harness. The reviewer prompt
// embeds launcher-supplied (untrusted) TASK/BRIEF text; a fixed delimiter could
// be closed early by a brief line equal to it, spilling the rest into the shell.
// A random nonce the brief author cannot predict makes that collision infeasible.
// NOTE: Math.random()/Date.now() THROW in the workflow sandbox (and would break
// resume), so the nonce is derived deterministically from the run inputs via a
// tiny FNV-1a hash. It is still unpredictable to a brief author who does not know
// the exact TASK/BRANCH/WORKTREE, so an untrusted brief line cannot guess and
// close the heredoc early.
const _fnv1a = (s) => {
  let h = 0x811c9dc5 >>> 0
  for (let i = 0; i < s.length; i++) {
    h = (h ^ s.charCodeAt(i)) >>> 0
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}
const SOL_HEREDOC = 'SOL_PROMPT_' + _fnv1a(TASK + '|' + BRANCH + '|' + WORKTREE) + _fnv1a(BRIEF + '|' + BRIEF_TEXT)

// ── multi-model split (token offload) ───────────────────────────────────────
// Route ~50% of the READ-ONLY reasoning to gpt-5.6-sol so a run doesn't spend
// all of Claude's budget. The split covers explore, plan, the review lenses,
// finding-verification, and the verify/gate runner. IMPLEMENTATION and every
// code-writing fixer always stay Claude — one writer per worktree, and you don't
// want two models editing the same files. A split-Sol slot runs on Sol under
// BOTH routes: the 'agent' route uses the subagent model param, and 'codex-cli'
// runs the slot through the codex harness (codexAgent, requires opts.schema) — so
// explore/plan/synthesis/finding-verification offload ~50% to Sol on either route,
// and any slot that can't be routed falls back to Claude. Turn it off with
// modelSplit:false.
const MODEL_SPLIT = a.modelSplit !== false
const SOL_AGENT_OK = SOL_VIA === 'agent'
const solSlot = (i) => MODEL_SPLIT && i % 2 === 1 // odd indices → Sol (~50/50)

// Explorers are weighted toward gpt-5.6-sol (user policy): the first
// EXPLORE_CLAUDE_COUNT explorers run on Claude/Opus, every remaining explorer on
// Sol. With the standard 8 explorers that is 2 Opus + 6 Sol. Override the Opus
// count with args.exploreClaudeCount.
const EXPLORE_CLAUDE_COUNT = a.exploreClaudeCount == null ? 2 : Math.max(0, a.exploreClaudeCount)
const exploreSol = (i) => MODEL_SPLIT && i >= EXPLORE_CLAUDE_COUNT
// The hard review-round ceiling: after the mixed roundCap, gpt-5.6-sol-only
// review rounds continue up to here (user policy). Override with args.hardRoundCap.
const HARD_ROUND_CAP = Math.max(1, a.hardRoundCap == null ? 10 : a.hardRoundCap)

// Effort for the non-review Sol phases (explore/plan/finding-verification). High
// codex effort × many calls gets very slow, so these default to medium; the
// review round keeps SOL_EFFORT (high). Override with args.solLightEffort.
const SOL_LIGHT_EFFORT = a.solLightEffort || 'medium'
// The EXPLORE and PLAN phases run their gpt-5.6-sol slots at a HIGHER reasoning
// effort than the review rounds (user policy): default xhigh. Review Sol stays at
// SOL_EFFORT. Override with args.solExplorePlanEffort.
const SOL_EXPLORE_PLAN_EFFORT = a.solExplorePlanEffort || 'xhigh'
// Effort for the LOCALIZE phase — mechanical translation busywork kept cheap/fast
// (gpt or opus on low, inheriting the session model). Override with args.localizeEffort.
const LOCALIZE_EFFORT = a.localizeEffort || 'low'

// ── systemic-failure (quota / usage-limit) circuit breaker ──────────────────
// A TERMINAL provider failure (Anthropic session/usage limit, exhausted quota
// or credits) kills every subsequent agent the same way. Without detection the
// loop keeps spawning doomed reviewers, Localize, Verify, and verify-fix agents
// (run #454 burned 26 agent errors after "You've hit your session limit").
// Two triggers set systemic-failure mode:
//   1. an agent error message matching TERMINAL_FAILURE_RE, or
//   2. an ENTIRE parallel batch returning null (provider/infrastructure outage —
//      a single null is a normal per-agent failure and never trips this).
// Once set, the loop stops spawning agents entirely (no Localize, no Verify, no
// fixers, no Claude fallbacks) and returns early with status:'paused' plus
// resumeFrom, so a later run can resume via startPhase instead of re-burning
// the completed phases. Singleton failures keep the existing fail-closed
// semantics (reviewIncomplete, verifier-null-is-unresolved, etc.) unchanged.
const TERMINAL_FAILURE_RE =
  /session limit|usage limit|quota exceeded|exceeded your (current )?quota|out of credits?|insufficient credits?|credit balance/i
let systemicFailure = false
let systemicFailureDetail = ''
function noteAgentError(e) {
  const msg = String(e && e.message ? e.message : e)
  if (!TERMINAL_FAILURE_RE.test(msg)) return false
  if (!systemicFailure) log(`TERMINAL provider failure ("${msg.slice(0, 90)}") — halting all further agent spawns`)
  systemicFailure = true
  if (!systemicFailureDetail) systemicFailureDetail = msg.slice(0, 160)
  return true
}
// An all-null parallel batch means every agent in it failed — a provider outage,
// not N independent accidents. (results.length === 0 is not a batch at all.)
function batchOutage(results, what) {
  if (results.length && results.every((r) => r == null)) {
    if (!systemicFailure) log(`${what}: ALL ${results.length} parallel agents failed — treating as provider outage`)
    systemicFailure = true
    if (!systemicFailureDetail) systemicFailureDetail = `${what}: all ${results.length} parallel agents returned null`
  }
  return systemicFailure
}
// Await an agent promise, classifying any error before rethrowing. parallel()
// nulls out throwers, which would otherwise DISCARD the error message — this is
// how terminal failures inside parallel batches reach the classifier.
async function classified(makePromise) {
  try {
    return await makePromise()
  } catch (e) {
    noteAgentError(e)
    throw e
  }
}

// codex forwards --output-schema to OpenAI Structured Outputs in STRICT mode,
// which requires every object to set additionalProperties:false and list EVERY
// declared property in `required`. Our workflow schemas are intentionally
// permissive for Claude's StructuredOutput (optional fields, additionalProperties
// true), so passing them verbatim gets a 400 (invalid_json_schema) that silently
// falls the slot back to Claude and defeats the model split. strictSchema returns
// a codex-compatible strict clone; only the copy written for codex is tightened —
// the Claude relay keeps the permissive original.
function strictSchema(s) {
  if (Array.isArray(s)) return s.map(strictSchema)
  if (!s || typeof s !== 'object') return s
  const out = {}
  for (const k of Object.keys(s)) {
    if (k === 'required' || k === 'additionalProperties') continue
    out[k] = strictSchema(s[k])
  }
  if (out.properties && typeof out.properties === 'object') {
    out.required = Object.keys(out.properties)
    out.additionalProperties = false
  }
  return out
}

// Generalized gpt-5.6-sol runner via the local codex CLI, usable for ANY
// read-only phase (explore/plan/finding-verification/synthesis). Spawns a light
// Claude harness that writes the analysis prompt + the phase JSON schema to temp
// files (Write tool — no shell heredoc, so untrusted brief text can't inject) and
// runs `codex ... exec --output-schema`, then RELAYS the structured result.
// Returns null when codex is unavailable/errors so the caller falls back to Claude.
async function codexAgent(prompt, schema, opts) {
  if (systemicFailure) return null // outage: don't spawn the harness agent
  const eff = (opts && opts.effort) || SOL_LIGHT_EFFORT
  const r = await agent(
    `You are a HARNESS that runs an external gpt-5.6-sol analyst via the codex CLI
and RELAYS its structured result. Do the analysis with codex — do NOT analyse
yourself. Work from ${WORKTREE}:
1. Allocate three unique temp paths S, P and R by running \`mktemp\` three times
   (Bash). Do NOT put them under ${WORKTREE}/.git — in a linked worktree (git
   worktree add) .git is a gitdir POINTER FILE, not a directory, so writing under
   .git/ fails with ENOTDIR. mktemp's OS-temp paths are outside the worktree and
   never dirty git status.
2. Write the JSON schema between <<<SCHEMA>>> markers to path S, and the ANALYSIS
   PROMPT between <<<PROMPT>>> markers VERBATIM to path P (Write tool). Do not
   paraphrase or summarise the prompt.
3. Run (Bash), substituting the real S, P and R paths:
     codex -a never -s read-only exec -C "${WORKTREE}" --ephemeral --ignore-user-config \\
       --color never --json -m "${SOL_MODEL}" -c model_reasoning_effort="${eff}" \\
       --output-schema S -o R - < P
4. Read R (JSON conforming to the schema) and RETURN it EXACTLY as your
   structured output. If \`codex\` is missing OR exits non-zero, RETURN a
   schema-valid object with "solUnavailable": true (empty arrays/strings for the
   rest) so the caller falls back to Claude — never fabricate the analysis.
5. ALWAYS delete the temp files before you finish — run \`rm -f\` on the real S, P
   and R paths whether codex succeeded or failed — so no schema, prompt, or result
   files accumulate in the OS temp directory across runs.

<<<SCHEMA>>>
${JSON.stringify(strictSchema(schema))}
<<<SCHEMA>>>

<<<PROMPT>>>
${prompt}
<<<PROMPT>>>`,
    { schema, agentType: 'general-purpose', effort: 'low', phase: opts && opts.phase, label: opts && opts.label }
  )
  return r && !r.solUnavailable ? r : null
}

// A read-only phase agent that runs on Sol for split-Sol slots — via the model
// param ('agent' route) or the codex CLI ('codex-cli') — else Claude. Any Sol
// failure (unroutable / null / throw) FALLS BACK to Claude so the slot is never
// lost. opts carries schema/agentType/effort/phase/label.
// ctl (optional): { slot?: (i)=>bool overrides solSlot for this call; solEffort?:
// gpt-5.6-sol reasoning effort for the 'agent' route (default SOL_EFFORT);
// solLightEffort?: codex-cli effort (default SOL_LIGHT_EFFORT) }.
async function splitAgent(i, prompt, opts, ctl) {
  if (systemicFailure) return null // outage: no Sol attempt, no Claude fallback
  const useSol = ctl && typeof ctl.slot === 'function' ? ctl.slot(i) : solSlot(i)
  if (useSol) {
    try {
      let r = null
      if (SOL_AGENT_OK) r = await agent(prompt, { ...opts, model: SOL_MODEL, effort: (ctl && ctl.solEffort) || SOL_EFFORT })
      else if (opts && opts.schema)
        r = await codexAgent(prompt, opts.schema, { effort: (ctl && ctl.solLightEffort) || SOL_LIGHT_EFFORT, phase: opts.phase, label: (opts.label || '') + ':sol' })
      if (r != null) return r
    } catch (e) {
      noteAgentError(e) /* Sol failed → Claude fallback below (unless terminal) */
    }
    if (systemicFailure) return null // terminal: the fallback would die the same way
  }
  return classified(() => agent(prompt, opts))
}
// A singleton read-only step we offload to Sol (plan synthesis) to spare Claude
// tokens; falls back to Claude when Sol isn't routable/available.
async function soloSolAgent(prompt, opts, solEffort) {
  if (systemicFailure) return null // outage: no Sol attempt, no Claude fallback
  if (MODEL_SPLIT) {
    try {
      let r = null
      if (SOL_AGENT_OK) r = await agent(prompt, { ...opts, model: SOL_MODEL, effort: solEffort || SOL_EFFORT })
      else if (opts && opts.schema)
        r = await codexAgent(prompt, opts.schema, { effort: solEffort || SOL_LIGHT_EFFORT, phase: opts.phase, label: (opts.label || '') + ':sol' })
      if (r != null) return r
    } catch (e) {
      noteAgentError(e) /* fall through to Claude (unless terminal) */
    }
    if (systemicFailure) return null
  }
  return classified(() => agent(prompt, opts))
}

// Await a CRITICAL singleton agent; on any throw (e.g. a StructuredOutput retry
// cap) return the fallback instead of aborting the whole workflow. Parallel
// phases already null-out throwers; this protects the awaited singletons.
async function safely(makePromise, fallback, what) {
  try {
    const r = await makePromise()
    return r == null ? fallback : r
  } catch (e) {
    noteAgentError(e) // classify terminal (quota/limit) failures before falling back
    log(`${what} failed (${String(e && e.message ? e.message : e).slice(0, 90)}) → using fallback`)
    return fallback
  }
}

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

REQUIREMENT FIDELITY (binding): The acceptance criteria in the TASK / TASK BRIEF
below are authoritative. Fix the ACTUAL reported defect and satisfy EVERY
acceptance criterion. Do NOT infer the intended change from the branch name, and
do NOT substitute an easier, semantically-different change that merely looks
related. If a change does not address the reported defect and each acceptance
criterion, that is a blocking problem — say so rather than proceeding.

TASK:
${TASK}

TASK BRIEF${BRIEF_TEXT ? ' (authoritative — read in full)' : ` — read this file in full FIRST: ${BRIEF}`}:
${BRIEF_TEXT || '(brief text not inlined; open the path above before planning)'}
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
  additionalProperties: true,
  required: ['owningLayer', 'files', 'consumers', 'contracts', 'testSeams'],
  properties: {
    owningLayer: { type: 'string' },
    files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, role: { type: 'string' } }, required: ['path', 'role'], additionalProperties: true } },
    consumers: { type: 'array', items: { type: 'string' } },
    analogue: { type: 'string', description: 'nearest already-implemented analogue to copy the shape of' },
    helpers: { type: 'array', items: { type: 'string' }, description: 'existing cross-cutting helpers to reuse instead of writing new' },
    contracts: { type: 'array', items: { type: 'string' }, description: 'repository/security/runtime contracts this change touches' },
    testSeams: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    incidentalBugs: {
      type: 'array',
      description: 'UNRELATED pre-existing bugs noticed while reading code — outside this task. Do NOT fix them; they are surfaced for filing to the bug inventory.',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          title: { type: 'string', description: 'concise imperative defect title' },
          severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
          area: { type: 'string', description: 'subsystem, e.g. Seerr / Bookmarks / Discovery' },
          evidence: { type: 'string', description: 'file:line + why it is a real defect (not this task)' },
        },
      },
    },
    notes: { type: 'string' },
  },
}
const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: true,
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
  additionalProperties: true,
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
  additionalProperties: true,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
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
  additionalProperties: true,
  required: ['real', 'reason'],
  properties: {
    real: { type: 'boolean', description: 'true only if the finding genuinely reproduces / violates a contract' },
    reason: { type: 'string' },
    severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
  },
}
const FIX_SCHEMA = {
  type: 'object',
  additionalProperties: true,
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
  additionalProperties: true,
  required: ['gates', 'allBlockingPassed'],
  properties: {
    gates: { type: 'array', items: { type: 'object', additionalProperties: true, required: ['name', 'pass'], properties: { name: { type: 'string' }, pass: { type: 'boolean' }, evidence: { type: 'string' } } } },
    allBlockingPassed: { type: 'boolean', description: 'true if every BLOCKING gate passed (lint is advisory, not blocking)' },
    e2e: { type: 'object', additionalProperties: true, properties: { run: { type: 'boolean' }, pass: { type: 'boolean' }, evidence: { type: 'string' } } },
    failures: { type: 'array', items: { type: 'string' } },
  },
}

// ── gate command list by surface ────────────────────────────────────────────
function gateCommands() {
  const core = [
    'npm run check:toolchain',
    './verify.sh lint   # ADVISORY — findings do not block',
    'git diff --check',
    'git status --porcelain   # BLOCKING: MUST be empty — uncommitted changes are unreviewed and are not pushed',
  ]
  const client = ['npm run typecheck:src', 'npm run typecheck', 'npm run test:client:coverage', 'npm run build:bundle', 'npm run syntax', 'npm run check:performance-rules']
  const server = ['dotnet build Jellyfin.Plugin.JellyfinCanopy/JellyfinCanopy.csproj -c Release', 'npm run test:server:coverage']
  const scripts = ['npm run test:scripts']
  const docs = ['npm run check:docs']
  let g = [...core]
  if (SURFACE === 'client' || SURFACE === 'cross') g = g.concat(client)
  if (SURFACE === 'server' || SURFACE === 'cross') g = g.concat(server)
  g = g.concat(scripts) // scripts tests are cheap and catch tooling regressions
  g = g.concat(['npm run validate-translations   # if any locale file changed'])
  // Docs can be edited on ANY surface (a client/server change often updates
  // user/admin/architecture docs). Validate them regardless of the declared
  // surface — a no-op when docs are untouched, but it catches broken links,
  // invalid examples, or asset-policy violations the declared surface would skip.
  g = g.concat(docs)
  return g
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 1 — EXPLORE (parallel, read-only)
// ═══════════════════════════════════════════════════════════════════════════
phase('Explore')
if (SURFACE_COERCED)
  log(`canopy-loop: unknown surface "${SURFACE_INPUT}" → coerced to "cross" (fail closed: runs all surface gates)`)
log(`canopy-loop: ${DEPTH} depth · surface=${SURFACE} · runtime=${RUNTIME} · branch ${BRANCH}`)

const exploreAngles = [
  'the OWNING module and the exact functions/types that must change',
  'every PRODUCER and CONSUMER of the affected behavior (grep the whole tree)',
  'the nearest ALREADY-IMPLEMENTED analogue and the existing cross-cutting helpers to reuse',
  'the CONTRACTS at risk (auth/isolation/escaping/disposal/bounded-work/live-config) and the TEST SEAMS',
  'the CLIENT surface: MUI + legacy layouts, native markup, locale keys, docs impacted',
  'the SERVER surface: controllers/services/scheduled tasks, .NET tests, generated artifacts',
  'the DATA/STATE/CONCURRENCY surface: persistence, caches, revisions, invalidation, and the races the change can introduce',
  'the PERFORMANCE/BOUNDS surface: allocations, N+1 / manager-call counts, unbounded work, and the measurable budgets to assert',
].slice(0, SIZING.explorers)

const exploreResults = await parallel(
    exploreAngles.map((angle, i) => () =>
      splitAgent(
        i,
        `${CONTRACTS}

PHASE: EXPLORE (read-only — do NOT edit any file).
Your angle: ${angle}.
Use rg/ls/Read to trace real code. Return a precise map: where the change lives,
who is affected, the analogue to copy, helpers to reuse (so we don't write new),
the contracts touched, and the test seams. Cite real paths; never guess.
Also, while reading, note (do NOT fix, do NOT scope-creep) any UNRELATED
pre-existing bug you notice in the code you traverse — a genuine defect outside
this task — in incidentalBugs with a title, severity, area, and file:line
evidence. Only real defects; leave it empty if you see none.`,
        { schema: EXPLORE_SCHEMA, agentType: 'Explore', effort: 'medium', phase: 'Explore', label: `explore:${i + 1}${exploreSol(i) && SOL_AGENT_OK ? ':sol' : ''}` },
        { slot: exploreSol, solEffort: SOL_EXPLORE_PLAN_EFFORT }
      )
    )
  )
batchOutage(exploreResults, 'Explore')
const explorations = exploreResults.filter(Boolean)

const exploreDigest = JSON.stringify(explorations, null, 1).slice(0, 12000)
log(`Explore: ${explorations.length} maps returned`)

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 2 — PLAN (independent plans → adversarial synthesis into one)
// ═══════════════════════════════════════════════════════════════════════════
const planAngles = [
  'MINIMAL-CHANGE first: the smallest change at the true owner; delete/delegate state before adding any.',
  'RISK first: identify the failure modes and design the state/failure model that fails closed with fewest moving parts.',
  'REUSE first: maximise use of existing helpers/analogue; avoid any parallel implementation of a shared behavior.',
].slice(0, SIZING.planners)

let plans = []
let canonicalPlan = null
if (!systemicFailure) {
  phase('Plan')
  const planResults = await parallel(
    planAngles.map((angle, i) => () =>
      splitAgent(
        i,
        `${CONTRACTS}

PHASE: PLAN (read-only). Explore maps (JSON):
${exploreDigest}

Produce an implementation plan with this bias: ${angle}
Choose the owning layer, reuse-vs-new decisions, the SIMPLEST state/failure
model (and explicitly what NOT to add — no speculative flag/retry/lock/observer/
polling/migration), the failing-first tests (admin AND non-admin, negative/
fallback, concurrency/cache invalidation where relevant), and the locale keys +
docs to update.`,
        { schema: PLAN_SCHEMA, effort: 'high', phase: 'Plan', label: `plan:${i + 1}${solSlot(i) && SOL_AGENT_OK ? ':sol' : ''}` },
        { solEffort: SOL_EXPLORE_PLAN_EFFORT }
      )
    )
  )
  batchOutage(planResults, 'Plan')
  plans = planResults.filter(Boolean)
}

if (!systemicFailure) {
  canonicalPlan = await safely(
  () =>
    soloSolAgent(
      `${CONTRACTS}

PHASE: PLAN SYNTHESIS (read-only). You are the adversarial judge. Here are ${plans.length}
independent plans (JSON):
${JSON.stringify(plans, null, 1).slice(0, 12000)}

Score them against the brief and the repository contracts. First (in your own
reasoning, not as an extra output field) confirm every acceptance criterion in
the brief is covered by a step; if any plan fixes something other than the actual
reported defect (e.g. a semantically-different change primed by the branch name),
reject that framing and correct it. Then pick the strongest spine and graft the
best ideas from the others. Reject scope creep and any avoidable new state.
Output ONE canonical plan (matching the schema fields only) the implementer will
follow exactly — it MUST address the real defect and every acceptance criterion,
and add the least while reusing the most.`,
      { schema: PLAN_SCHEMA, effort: 'high', phase: 'Plan', label: 'plan:synthesis' },
      SOL_EXPLORE_PLAN_EFFORT
    ),
  plans[0] || null,
  'Plan synthesis'
  )
  log(`Plan: ${plans.length} plans → 1 canonical (${(canonicalPlan && canonicalPlan.owningLayer) || 'n/a'})`)
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 3 — IMPLEMENT (single writer)
// ═══════════════════════════════════════════════════════════════════════════
const implementPrompt = `${CONTRACTS}

PHASE: IMPLEMENT. You are the SOLE writer in this worktree. Follow this canonical
plan exactly (JSON):
${JSON.stringify(canonicalPlan, null, 1).slice(0, 12000)}

Rules:
- Build the change at its owning layer and update EVERY affected consumer. Fix
  shared behavior once at its source; do not patch one consumer or copy a helper.
- Add tests that FAIL before the change and pass after: admin AND non-admin,
  negative/fallback, concurrency/cache invalidation where relevant, non-vacuous
  assertions that prove the intended lower tier ran.
- Add any NEW i18n key ONLY to the base English locale (js/locales/en.json) and
  reference it in code. Do NOT translate the other locale files — a dedicated
  low-cost Localize phase fans them out afterward, so spend no effort there.
  Update affected user/admin/architecture/security docs. Rebuild generated
  bundles/manifests/snapshots from source if the repo expects it.
- Do NOT add live activation, polling, retries, migrations, config, or startup
  work unless the plan requires it. Give each side effect exactly one owner.
- Commit coherent conventional units (feat/fix/chore/docs). ${COMMIT_RULE}
- Run the directly-affected focused tests as you go. Do not run the full gate.
Report the changed files, commits, tests added, a diff stat, and an honest
self-confidence (high/medium/low) with any open TODOs.`

// Implementer runs on Fable (high) to spare Opus budget; if Fable is exhausted
// or errors (agent returns null), fall back to Opus (high). The single writer is
// never split across models mid-change. Fixers stay on the session model (Opus).
const IMPL_MODEL = a.implementModel || 'fable'
const IMPL_FALLBACK = a.implementFallback || 'opus'
const implOpts = { schema: IMPLEMENT_SCHEMA, agentType: 'general-purpose', effort: 'high', phase: 'Implement' }
let implemented = null
if (!systemicFailure) {
  phase('Implement')
  implemented = await safely(
    () => agent(implementPrompt, { ...implOpts, model: IMPL_MODEL, label: `implement:${IMPL_MODEL}` }),
    null,
    `Implement (${IMPL_MODEL})`
  )
  if (!implemented && !systemicFailure) {
    log(`Implement: ${IMPL_MODEL} unavailable/exhausted → falling back to ${IMPL_FALLBACK} (high)`)
    implemented = await safely(
      () =>
        agent(
          `${implementPrompt}

NOTE: a previous attempt may have left partial changes or commits in the
worktree. Inspect \`git -C ${WORKTREE} status\` and \`git -C ${WORKTREE} log --oneline ${BASE}..HEAD\`
and CONTINUE from there rather than restarting from scratch.`,
          { ...implOpts, model: IMPL_FALLBACK, label: `implement:${IMPL_FALLBACK}-fallback` }
        ),
      null,
      `Implement (${IMPL_FALLBACK})`
    )
  }
  log(`Implement: ${(implemented && implemented.changedFiles && implemented.changedFiles.length) || 0} files, confidence ${(implemented && implemented.selfConfidence) || '?'}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 4 — ADVERSARIAL REVIEW LOOP (parallel review → verify → single fixer)
// ═══════════════════════════════════════════════════════════════════════════
if (!systemicFailure) phase('Review')

const reviewContext = `${CONTRACTS}

The change is on branch ${BRANCH}. Inspect it with:
  git -C ${WORKTREE} diff ${BASE}...HEAD
  git -C ${WORKTREE} log --oneline ${BASE}..HEAD
  git -C ${WORKTREE} status --porcelain   # MUST be empty — a non-empty result is a finding
The reviewed diff is the COMMITTED range ${BASE}...HEAD; any uncommitted change is
unreviewed and would be lost on push, so treat a dirty worktree as a real finding.
You see ONLY the diff and this brief — never the implementer's reasoning.`

// A Claude adversarial reviewer for a scope: lens set → that lens only; lens null
// → a whole-diff pass. Used both as a first-class reviewer AND as the fallback
// when a Sol slot can't be routed, so no review scope is ever silently lost.
function claudeReview(roundNo, i, lens) {
  if (systemicFailure) return null // outage: don't spawn another doomed reviewer
  const scoped = lens
    ? `PHASE: ADVERSARIAL REVIEW — lens: "${lens}".
Assume the change is WRONG and prove how, THROUGH THIS LENS ONLY.`
    : `PHASE: ADVERSARIAL REVIEW — whole diff.
Assume the change is WRONG and prove how, across correctness, security/privacy
(fail-closed), lifecycle/concurrency, bounds/perf/no-jank, JF12 + MUI/legacy
compatibility, test strength, product scope, and docs/locale/generated-artifact gaps.`
  const prompt = `${reviewContext}

${scoped}
A finding needs a real file/line and a concrete failure scenario (inputs/state →
wrong output / crash / leak / contract violation). "Looks fine" is not a finding.
Watch for mechanically-similar-but-semantically-different code (side effects
inside asserts/guards, eager vs lazy defaults, odd-length buffer truncation,
bounds checks present in one build only, byte-vs-UTF assumptions, escape/format
passes over the wrong data). Reject any workaround that needs a paragraph-long
comment to justify it. Return only real findings (empty array if none).`
  return classified(() =>
    agent(prompt, { schema: FINDINGS_SCHEMA, agentType: 'code-reviewer', effort: 'medium', phase: 'Review', label: `review-r${roundNo}:${i + 1}${lens ? '' : ':whole'}` })
  )
}

// gpt-5.6-sol adversarial reviewer (high effort). With a lens the review is
// scoped to that lens (used by the 50/50 split); without one it is a whole-diff
// pass. The Sol side is obtained via the subagent model param ('agent') or the
// codex CLI. If Sol can't be routed / the codex CLI is unavailable / it errors,
// the slot FALLS BACK to the Claude reviewer for the SAME scope — a Sol slot is
// never dropped, so no lens is left unreviewed (fail closed, per the contract).
function solThunk(roundNo, i, lens) {
  const scope = lens
    ? `THROUGH THIS LENS ONLY: "${lens}".`
    : `across correctness, security/privacy (fail-closed), lifecycle/concurrency,
bounds/perf/no-jank, JF12 + MUI/legacy compatibility, test strength, product
scope, and docs/locale/generated-artifact gaps.`
  const solPrompt = `${reviewContext}

PHASE: ADVERSARIAL REVIEW (gpt-5.6-sol). Assume the change is WRONG and prove how,
${scope}
Every finding needs a real file/line and a concrete failure scenario (inputs/
state → wrong output / crash / leak / contract violation). Reject workarounds
that need a paragraph-long comment to justify them. Watch for
mechanically-similar-but-semantically-different code. Return only real findings
(empty array if none).`

  // Runs the Sol side; returns its findings object, or null when Sol is
  // unavailable/errored (so the caller can fall back to Claude for this scope).
  const runSol =
    SOL_VIA === 'codex-cli'
      ? async () => {
          try {
            const r = await agent(
            `${reviewContext}

PHASE: gpt-5.6-sol REVIEW via the local \`codex\` CLI. You are a HARNESS — run the
external reviewer and relay its structured findings; do NOT review yourself.
Run from ${WORKTREE} (HEAD must be committed and clean):
  P=$(mktemp); R=$(mktemp); EV=$(mktemp); ER=$(mktemp)
  trap 'rm -f "$P" "$R" "$EV" "$ER"' EXIT
  cat > "$P" <<'${SOL_HEREDOC}'
${solPrompt}
${SOL_HEREDOC}
  codex -a never -s read-only exec -C "${WORKTREE}" --ephemeral --ignore-user-config \\
    --color never --json -m "${SOL_MODEL}" -c model_reasoning_effort="${SOL_EFFORT}" \\
    --output-schema "${CODEX_SCHEMA_PATH}" -o "$R" - < "$P" > "$EV" 2> "$ER"
Then read "$R" (JSON conforming to the schema) and RETURN its findings mapped to
THIS tool's schema (lens="gpt-5.6-sol", file, line, severity, summary,
failureScenario). The temp files are cleaned up by the trap on shell exit.
If \`codex\` is missing OR exits non-zero, the Sol review did NOT run: RETURN
{"findings": [], "solUnavailable": true} so the loop covers this scope with
Claude instead. Do NOT invent findings and do NOT return a bare empty array on
failure — reserve {"findings": []} for a genuine clean codex run.`,
            { schema: FINDINGS_SCHEMA, agentType: 'general-purpose', effort: 'medium', phase: 'Review', label: `sol-cli-r${roundNo}:${i + 1}` }
            )
            return r && !r.solUnavailable ? r : null
          } catch (e) {
            noteAgentError(e)
            return null // codex harness threw → Claude fallback below (scope never lost)
          }
        }
      : async () => {
          try {
            const r = await agent(solPrompt, { schema: FINDINGS_SCHEMA, model: SOL_MODEL, effort: SOL_EFFORT, phase: 'Review', label: `sol-r${roundNo}:${i + 1}` })
            return r != null ? r : null
          } catch (e) {
            noteAgentError(e)
            return null // Sol not routable → Claude fallback below
          }
        }

  return async () => {
    if (systemicFailure) return null // outage: no Sol attempt, no Claude fallback
    const r = await runSol()
    if (r != null) return r
    if (systemicFailure) return null // terminal: the fallback would die the same way
    return claudeReview(roundNo, i, lens) // scope never lost
  }
}

const confirmedAll = []
let cleanRound = false
// Set only when a round TERMINATES the loop with incomplete coverage — a reviewer
// or a finding-verifier failed to return — so we never certify such a round clean.
let reviewIncomplete = false
const MIXED_ROUND_CAP = SIZING.roundCap
let round = 0
while (round < HARD_ROUND_CAP && !cleanRound && !systemicFailure) {
  round++

  // Rounds 1..MIXED_ROUND_CAP run the mixed panel (Claude lenses + gpt-5.6-sol).
  // If still not clean after that, review CONTINUES with gpt-5.6-sol as the ONLY
  // reviewer (user policy) for every remaining round up to HARD_ROUND_CAP: all
  // lenses run on Sol plus the whole-diff Sol reviewer(s), no Claude lens
  // reviewers. (A Sol slot still falls back to Claude for its scope ONLY if Sol
  // can't be routed at all — fail closed so no lens is left unreviewed.)
  const gptOnly = round > MIXED_ROUND_CAP

  // Split the lenses ~50/50 across models when modelSplit is on (Sol takes the
  // odd slots, lens-scoped) and ALWAYS add ≥1 whole-diff Sol reviewer so the
  // documented "≥1 gpt-5.6-sol whole-diff reviewer per round" contract holds even
  // under the split. With modelSplit off: all Claude lenses + the whole-diff Sol
  // reviewers. In a gpt-only round every lens runs on Sol.
  let roundThunks
  if (gptOnly) {
    roundThunks = [
      ...LENSES.map((lens, i) => solThunk(round, i, lens)),
      ...Array.from({ length: Math.max(1, SOL_REVIEWERS) }, (_, i) => solThunk(round, LENSES.length + i)),
    ]
  } else if (MODEL_SPLIT) {
    roundThunks = [
      ...LENSES.map((lens, i) => (solSlot(i) ? solThunk(round, i, lens) : () => claudeReview(round, i, lens))),
      ...Array.from({ length: Math.max(1, SOL_REVIEWERS) }, (_, i) => solThunk(round, LENSES.length + i)),
    ]
  } else {
    roundThunks = [
      ...LENSES.map((lens, i) => () => claudeReview(round, i, lens)),
      ...Array.from({ length: Math.max(1, SOL_REVIEWERS) }, (_, i) => solThunk(round, LENSES.length + i)),
    ]
  }
  const claudeLensCount = gptOnly ? 0 : (MODEL_SPLIT ? LENSES.filter((_, i) => !solSlot(i)).length : LENSES.length)
  const solCount = roundThunks.length - claudeLensCount
  log(`Review round ${round}/${HARD_ROUND_CAP}${gptOnly ? ' [gpt-only]' : ''} — ${claudeLensCount} Claude lens + ${solCount}× ${SOL_MODEL} (${SOL_VIA}, ${SOL_EFFORT})${MODEL_SPLIT && !gptOnly ? ' [50/50 + whole-diff]' : ''}`)

  const results = await parallel(roundThunks)
  if (batchOutage(results, `Review round ${round}`)) {
    reviewIncomplete = true
    log(`Review round ${round}: provider outage — pausing instead of spawning more agents`)
    break
  }
  const failedWorkers = results.filter((r) => r == null).length
  const raw = results.filter(Boolean).flatMap((r) => (r && r.findings) || [])

  const deduped = dedupe(raw)
  if (!deduped.length) {
    // No findings only certifies clean if EVERY reviewer actually ran. If a
    // worker failed (both Sol and its Claude fallback), that scope is unreviewed
    // — fail closed and stop rather than report a false clean.
    if (failedWorkers) {
      reviewIncomplete = true
      log(`Review round ${round}: 0 findings but ${failedWorkers}/${roundThunks.length} reviewer(s) failed → coverage incomplete, NOT clean`)
      break
    }
    cleanRound = true
    log(`Review round ${round}: clean (no findings)`)
    break
  }

  // Adversarially verify each finding — try to REFUTE it; default refuted.
  const verdicts = await parallel(
    deduped.map((f, i) => () =>
      splitAgent(
        i,
        `${reviewContext}

PHASE: VERIFY FINDING. Try hard to REFUTE this claimed defect. Default to
real=false when uncertain — only real=true if it genuinely reproduces or truly
violates a repository contract on a reachable path.
FINDING (${f.lens || '?'}) ${f.file}:${f.line || '?'} — ${f.summary}
SCENARIO: ${f.failureScenario}`,
        { schema: VERDICT_SCHEMA, agentType: 'code-reviewer', effort: 'medium', phase: 'Review', label: `verify-r${round}:${i + 1}` },
        // In a gpt-only round, finding-verification runs on Sol too (gpt is the
        // sole reviewer once past the mixed cap); Sol still falls back to Claude
        // per finding if unroutable. The code-writing fixer stays Claude/Opus.
        gptOnly ? { slot: () => MODEL_SPLIT } : undefined
      )
    )
  )

  if (batchOutage(verdicts, `Review round ${round} finding-verification`)) {
    reviewIncomplete = true
    log(`Review round ${round}: provider outage during finding-verification — pausing`)
    break
  }

  // A missing verdict (verifier agent failed) is NOT a refutation — the finding
  // is unresolved, not cleared. Only a returned real=false counts as refuted.
  const unverified = deduped.filter((_, i) => verdicts[i] == null).length
  const confirmed = deduped.filter((f, i) => verdicts[i] && verdicts[i].real)
  if (!confirmed.length) {
    if (unverified || failedWorkers) {
      reviewIncomplete = true
      log(`Review round ${round}: ${deduped.length} findings, none confirmed but ${unverified} unverified / ${failedWorkers} reviewer failure(s) → NOT clean`)
      break
    }
    cleanRound = true
    log(`Review round ${round}: ${deduped.length} findings, all refuted → clean`)
    break
  }
  confirmedAll.push(...confirmed.map((f) => ({ ...f, round })))
  // A finding whose verifier failed to return is neither confirmed nor refuted:
  // that scope is unresolved even though we DID confirm (and will fix) others in
  // the same batch. Don't let the fixed-confirmed path silently drop it — mark the
  // run's coverage incomplete so a later non-deterministic clean round can't
  // certify the branch behind an unresolved finding (fail closed).
  if (unverified) {
    reviewIncomplete = true
    log(`Review round ${round}: ${confirmed.length} confirmed but ${unverified} finding(s) unverified (verifier failure) → coverage incomplete, run cannot certify clean`)
  }
  if (systemicFailure) {
    reviewIncomplete = true
    log(`Review round ${round}: provider outage — not spawning the fixer`)
    break
  }
  log(`Review round ${round}: ${confirmed.length} confirmed → fixing`)

  // Wrap the code-writing fixer in safely(): a StructuredOutput retry-cap throw
  // must NOT abort the whole workflow — verify still needs to run and report.
  await safely(
    () =>
      agent(
        `${CONTRACTS}

PHASE: FIX. You are the SOLE writer. Apply ONLY these confirmed findings at their
owning layer, add regression evidence for each, and commit coherent units.
STAY IN SCOPE: touch only files the confirmed findings require. Do NOT expand into
unrelated consistency cleanups, mass locale edits, or refactors that no confirmed
finding demands. Before adding any new state flag/retry/lock/publisher/lifecycle
path — or making a second fix to the same state machine/owner — STOP and try
deletion, reuse, or single ownership first; simpler is required over another
guard. Do not fix anything not listed. ${COMMIT_RULE}

CONFIRMED FINDINGS:
${JSON.stringify(confirmed, null, 1).slice(0, 10000)}`,
        { schema: FIX_SCHEMA, agentType: 'general-purpose', effort: 'high', phase: 'Review', label: `fix-r${round}` }
      ),
    null,
    `Review fixer (round ${round})`
  )
}
if (!cleanRound)
  log(
    reviewIncomplete
      ? `Review: ended without a certified-clean round — coverage incomplete (reviewer/verifier failure); will report as residual risk`
      : `Review: hit round cap (${HARD_ROUND_CAP}) with unresolved findings — will report as residual risk`
  )

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 4.5 — LOCALIZE (cheap, low-effort translation busywork; NOT reviewed)
// Runs AFTER the review loop, so the 25 non-base locale files never consume
// adversarial review, and BEFORE verify, so validate-translations passes at
// parity. Implementer/fixers add new i18n keys only to the base en.json; one
// low-effort agent (gpt/opus on low) fans them out to every locale.
// ═══════════════════════════════════════════════════════════════════════════
if (SURFACE !== 'server' && !systemicFailure) {
  phase('Localize')
  log(`Localize: fanning base-locale keys out to all locales (effort=${LOCALIZE_EFFORT})`)
  await safely(
    () =>
      agent(
        `${CONTRACTS}

PHASE: LOCALIZE — cheap, low-effort TRANSLATION BUSYWORK ONLY. No logic, no code,
no tests. Work from ${WORKTREE}. The implementer/fixers added any NEW i18n keys
ONLY to the base English locale (js/locales/en.json). Propagate every key that is
new or changed in en.json to ALL other locale files so
\`npm run validate-translations\` passes at full parity — REAL translations per each
locale's language, placeholder tokens ({name}, %s, {count}, etc.) kept
byte-identical, and follow the repo's existing English-fallback convention for any
locale file that already uses it. Touch ONLY js/locales/*.json — never code, tests,
docs, or any other file. Then run \`npm run validate-translations\` until green and
commit ONE \`chore(i18n): …\` unit. ${COMMIT_RULE} If en.json has NO new or changed keys versus the other
locales, do NOTHING and report "no locale work needed".`,
        { agentType: 'general-purpose', effort: LOCALIZE_EFFORT, phase: 'Localize', label: 'localize' }
      ),
    null,
    'Localize'
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 5 — VERIFY (single runner; bounded fix-and-reverify)
// ═══════════════════════════════════════════════════════════════════════════
if (!systemicFailure) phase('Verify')

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
// A VERIFY-FIX writes production code AFTER the adversarial review round that set
// cleanRound. Those commits never appeared in any reviewer's diff, so reusing the
// stale cleanRound to certify them is unsafe. Track whether any verify-fix
// actually committed; if so the final diff is unreviewed and NOT ready for PR.
let verifyFixCommitted = false
while (vround <= SIZING.verifyFixCap && !systemicFailure) {
  // FINAL VERIFY stays on Claude (authoritative gate run) — never split to Sol.
  verify = await safely(
    () =>
      agent(
        `${CONTRACTS}

PHASE: VERIFY. Run the repository-native gates for surface="${SURFACE}", in order,
from ${WORKTREE}. Lint is ADVISORY (findings never block); every other gate is
BLOCKING. Do not pipe wrappers through tail/grep/tee in a way that hides exit
status. Do not run a plain suite right before its coverage variant.

HANDOFF: a non-empty \`git status --porcelain\` is a BLOCKING failure. The reviewed
and pushable change is the committed range ${BASE}..HEAD, so any uncommitted edit
was never reviewed and would be lost on push — report it as a failed gate and set
allBlockingPassed=false; do NOT commit it yourself to make the tree clean.

GATES:
${gateList.map((g) => '  ' + g).join('\n')}
${e2eBlock}

Report each gate's pass/fail with short evidence (counts/versions), whether
ALL BLOCKING gates passed, the e2e result if run, and a list of failures.`,
        { schema: VERIFY_SCHEMA, agentType: 'general-purpose', effort: 'medium', phase: 'Verify', label: vround === 0 ? 'verify' : `verify-retry-${vround}` }
      ),
    { gates: [], allBlockingPassed: false, failures: ['verify agent did not return structured output'] },
    'Verify'
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
  if (systemicFailure) {
    log('Verify: provider outage — skipping the verify-fix retry (a code-writing fixer is pointless during an outage)')
    break
  }
  log(`Verify: failures → fix attempt ${vround}/${SIZING.verifyFixCap}`)
  // Wrap the code-writing verify-fixer in safely(): a StructuredOutput retry-cap
  // throw must NOT abort the workflow — the loop must still re-verify and return
  // a structured result (with residual risks) to the main thread.
  const vfix = await safely(
    () =>
      agent(
        `${CONTRACTS}

PHASE: VERIFY-FIX. You are the SOLE writer. Fix ONLY the real regressions behind
these gate/e2e failures at their owner — never weaken coverage, timeouts,
assertions, security policy, or E2E scope to go green, and never lower a ratchet.
Commit the fix. ${COMMIT_RULE} FAILURES:
${JSON.stringify((verify && verify.failures) || [], null, 1).slice(0, 8000)}`,
        { schema: FIX_SCHEMA, agentType: 'general-purpose', effort: 'high', phase: 'Verify', label: `verify-fix-${vround}` }
      ),
    null,
    `Verify fixer (attempt ${vround})`
  )
  if (vfix && Array.isArray(vfix.commits) && vfix.commits.length) verifyFixCommitted = true
}

// ── return structured result for the main thread to relay + act on ──────────
const blockingGreen = !!(verify && verify.allBlockingPassed)
const e2eGreen = !RUNTIME || !!(verify && verify.e2e && verify.e2e.pass)
// Implementation must have actually completed: both implementer models failing
// leaves `implemented` null, and an unresolved acceptance-criteria TODO means the
// requested change is incomplete. Either way the branch is NOT ready for PR.
const openTodos = (implemented && implemented.openTodos) || []
const implementationOk = !!implemented && openTodos.length === 0
// Incidental (unrelated, pre-existing) bugs surfaced while exploring, deduped by
// title. The main thread files the genuinely-new ones to the bug inventory
// (Project 4) after checking they are not already reported.
const incidentalBugs = (() => {
  const seen = new Set()
  const out = []
  for (const e of explorations) {
    for (const b of (e && e.incidentalBugs) || []) {
      const k = String((b && b.title) || '').trim().toLowerCase()
      if (!k || seen.has(k)) continue
      seen.add(k)
      out.push(b)
    }
  }
  return out
})()
// A paused run tells the launcher exactly where to re-enter: the committed
// branch state carries everything the later phases need (they work purely from
// the BASE...HEAD range), so nothing before resumeFrom.phase is re-run.
const PAUSED = systemicFailure
const resumeFrom = !PAUSED
  ? null
  : !implemented
  ? { phase: 'explore' }
  : !cleanRound
  ? { phase: 'review', round }
  : { phase: 'verify' }
const result = {
  status: PAUSED ? 'paused' : 'complete',
  pauseReason: PAUSED ? systemicFailureDetail : null,
  resumeFrom,
  branch: BRANCH,
  surface: SURFACE,
  depth: DEPTH,
  loopClean: cleanRound,
  reviewRounds: round,
  reviewIncomplete,
  incidentalBugs,
  confirmedFindingsResolved: confirmedAll.length,
  implement: implemented || null,
  canonicalPlan: canonicalPlan || null,
  verify: verify || null,
  verifyFixCommitted,
  readyForPR: !PAUSED && implementationOk && cleanRound && !reviewIncomplete && !verifyFixCommitted && blockingGreen && e2eGreen,
  residualRisks: []
    .concat(
      PAUSED
        ? [
            `run PAUSED on a systemic provider failure (${systemicFailureDetail}) — do NOT relaunch a full run; once capacity returns, resume with startPhase:"${resumeFrom.phase}" against the same branch`,
          ]
        : []
    )
    .concat(implemented || PAUSED ? [] : ['implementation did not complete — both implementer models failed to return a result'])
    .concat(openTodos.length ? ['implementer left open acceptance-criteria TODOs — change is incomplete'] : [])
    .concat(reviewIncomplete ? ['adversarial review ended with incomplete coverage (a reviewer or finding-verifier failed) — the round could not be certified clean'] : [])
    .concat(cleanRound || reviewIncomplete ? [] : ['review loop hit its round cap with unresolved confirmed findings'])
    .concat(verifyFixCommitted ? ['verify-fix committed code AFTER the clean review round — those commits were never adversarially reviewed; re-run the review loop before opening a PR'] : [])
    .concat(blockingGreen ? [] : ['one or more BLOCKING gates are failing'])
    .concat(e2eGreen ? [] : ['e2e:local did not pass'])
    .concat(openTodos),
}
log(
  `canopy-loop ${result.status}: readyForPR=${result.readyForPR} · impl=${implementationOk} · rounds=${round} · findings resolved=${confirmedAll.length} · blockingGreen=${blockingGreen}${RUNTIME ? ` · e2e=${e2eGreen}` : ''}${PAUSED ? ` · resumeFrom=${resumeFrom.phase}` : ''}`
)
return result
