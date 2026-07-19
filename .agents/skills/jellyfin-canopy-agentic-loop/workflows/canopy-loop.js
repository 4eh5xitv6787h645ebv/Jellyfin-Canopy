export const meta = {
  name: 'canopy-loop',
  description:
    'Bun-style multi-agent loop for a Jellyfin Canopy change: parallel explore + plan, single-writer implement, adversarial review-until-clean, repo-native verify.',
  phases: [
    { title: 'Explore', detail: 'parallel read-only map of the owning layer, consumers, analogue, helpers, contracts, test seams' },
    { title: 'Plan', detail: 'independent plans judged and synthesised into one canonical plan' },
    { title: 'Design Lock', detail: 'bind the ONE architecture (reuse decisions, rejected alternatives, invariants) so no round reinterprets it' },
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
  const useSol = ctl && typeof ctl.slot === 'function' ? ctl.slot(i) : solSlot(i)
  if (useSol) {
    try {
      let r = null
      if (SOL_AGENT_OK) r = await agent(prompt, { ...opts, model: SOL_MODEL, effort: (ctl && ctl.solEffort) || SOL_EFFORT })
      else if (opts && opts.schema)
        r = await codexAgent(prompt, opts.schema, { effort: (ctl && ctl.solLightEffort) || SOL_LIGHT_EFFORT, phase: opts.phase, label: (opts.label || '') + ':sol' })
      if (r != null) return r
    } catch (_) {
      /* Sol failed → Claude fallback below */
    }
  }
  return agent(prompt, opts)
}
// A singleton read-only step we offload to Sol (plan synthesis) to spare Claude
// tokens; falls back to Claude when Sol isn't routable/available.
async function soloSolAgent(prompt, opts, solEffort) {
  if (MODEL_SPLIT) {
    try {
      let r = null
      if (SOL_AGENT_OK) r = await agent(prompt, { ...opts, model: SOL_MODEL, effort: solEffort || SOL_EFFORT })
      else if (opts && opts.schema)
        r = await codexAgent(prompt, opts.schema, { effort: solEffort || SOL_LIGHT_EFFORT, phase: opts.phase, label: (opts.label || '') + ':sol' })
      if (r != null) return r
    } catch (_) {
      /* fall through to Claude */
    }
  }
  return agent(prompt, opts)
}

// Await a CRITICAL singleton agent; on any throw (e.g. a StructuredOutput retry
// cap) return the fallback instead of aborting the whole workflow. Parallel
// phases already null-out throwers; this protects the awaited singletons.
async function safely(makePromise, fallback, what) {
  try {
    const r = await makePromise()
    return r == null ? fallback : r
  } catch (e) {
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

// A STABLE, line-shift-resistant semantic identity for a finding, used to detect
// the same defect being re-confirmed across review rounds (oscillation) even as
// the fixer shifts line numbers. Prefers the structured design-lock fields
// (kind/ownerSymbol/invariantId/decisionId — populated once Design Lock lands)
// and falls back to file + normalized failure scenario / summary. NOT the same as
// dedupeKey (which is within-round and line-sensitive).
const _normalizeText = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[0-9]+/g, '#') // collapse line numbers / counts so a shifted repeat still matches
    .replace(/[^a-z#]+/g, ' ')
    .trim()
    .slice(0, 120)
const findingKey = (f) => {
  const structured = [f.kind, f.ownerSymbol, f.invariantId, f.decisionId].filter(Boolean).join('|')
  if (structured) return structured
  return `${f.file || '?'}|${_normalizeText(f.failureScenario || f.summary)}`
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
          // Structured identity (Design Lock, M2): a stable semantic key for
          // oscillation detection, and the decision/invariant a finding relates to.
          kind: { type: 'string', description: 'defect class, e.g. correctness / lifecycle / security / test-fidelity / design-conflict' },
          ownerSymbol: { type: 'string', description: 'the function/type/symbol that owns the defect (line-independent)' },
          invariantId: { type: 'string', description: 'id of the Design-Lock invariant this violates, if any' },
          decisionId: { type: 'string', description: 'id of the Design-Lock decision this concerns, if any' },
          newDesignEvidence: { type: 'string', description: 'NEW repository evidence (a missed helper/primitive or a proof the locked design violates an invariant) that would justify reopening a locked decision — else empty' },
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
    real: { type: 'boolean', description: 'true only if the finding genuinely reproduces / violates a contract (equivalent to disposition==="confirm")' },
    // M2: a finding that merely PREFERS a Design-Lock rejected alternative is
    // "refute" (out of scope). "reopen-design" is reserved for a finding carrying
    // NEW evidence that the locked design violates an invariant / missed a repo
    // primitive — it triggers a design re-decision, not an ordinary fixer.
    disposition: { type: 'string', enum: ['confirm', 'refute', 'reopen-design'], description: 'confirm = real defect within the locked design; refute = false or prefers a rejected alternative; reopen-design = new evidence invalidates a locked decision' },
    reason: { type: 'string' },
    severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
  },
}
// M2 — the binding architecture decision, produced between Plan and Implement and
// carried into implement / review / verify / fixer prompts so no round can silently
// reinterpret the architecture (the #167 install-once↔teardown thrash).
const DESIGN_LOCK_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['decisionId', 'approach', 'acceptanceCriteria'],
  properties: {
    decisionId: { type: 'string', description: 'short stable id for THIS locked approach' },
    approach: { type: 'string', description: 'the ONE chosen architecture, concretely (which owner, which mechanism)' },
    invariants: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { id: { type: 'string' }, statement: { type: 'string' } } }, description: 'properties the change must preserve; reviewers cite these by id' },
    helperDisposition: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { path: { type: 'string' }, symbol: { type: 'string' }, disposition: { type: 'string', enum: ['reuse', 'not-applicable'] }, reason: { type: 'string' } } }, description: 'EVERY discovered relevant helper with an explicit reuse / not-applicable decision (so a repo primitive like lifecycle.ts cannot silently disappear)' },
    rejectedAlternatives: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { id: { type: 'string' }, description: { type: 'string' }, reason: { type: 'string' }, reopenWhen: { type: 'string' } } }, description: 'approaches explicitly NOT taken; a finding that merely prefers one is out of scope unless its reopenWhen condition is met with new evidence' },
    acceptanceCriteria: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { id: { type: 'string' }, text: { type: 'string' } } }, description: 'stable-id acceptance criteria the change must satisfy' },
    testProofRequirements: { type: 'array', items: { type: 'string' }, description: 'what a regression must exercise (e.g. the REAL production entry point, not an extracted helper)' },
    notes: { type: 'string' },
  },
}
const FIX_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['applied', 'commits'],
  properties: {
    applied: { type: 'array', items: { type: 'string' }, description: 'confirmed findings actually fixed this pass (summaries)' },
    commits: { type: 'array', items: { type: 'string' } },
    designChange: { type: 'string', description: 'if a fix simplified/deleted state instead of adding a guard, say how' },
    unresolved: { type: 'array', items: { type: 'string' }, description: 'confirmed findings you could NOT fix this pass' },
    revertedPriorFix: { type: 'boolean', description: 'true if fixing these findings required undoing a previous rounds fix (an oscillation signal)' },
    head: { type: 'string', description: 'git rev-parse --short HEAD after committing' },
    addedLines: { type: 'integer', description: 'production lines added this pass (git diff --numstat, excluding tests/locales)' },
    deletedLines: { type: 'integer', description: 'production lines deleted this pass' },
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

const explorations = (
  await parallel(
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
).filter(Boolean)

const canonicalPlan = await safely(
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

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 2.5 — DESIGN LOCK (bind the ONE architecture decision) — M2
// Kills the #167 design-thrash: every later phase reads the same binding decision,
// rejected alternatives, and helper dispositions, so no round can silently
// reinterpret the architecture. Helper discovery is preserved PROGRAMMATICALLY so
// a repo primitive can't vanish in the 12k-char truncation chain.
// ═══════════════════════════════════════════════════════════════════════════
phase('Design Lock')
const discoveredHelpers = [...new Set(explorations.flatMap((e) => (e && e.helpers) || []).map(String).filter(Boolean))]
const discoveredAnalogues = [...new Set(explorations.map((e) => e && e.analogue).filter(Boolean).map(String))]
let designLock = await safely(
  () =>
    soloSolAgent(
      `${CONTRACTS}

PHASE: DESIGN LOCK (read-only). Commit to ONE architecture for this change and
record it as a BINDING decision that implement, review, verify and every fixer will
follow. Base it on the canonical plan and the brief; do NOT invent a different
problem.

CANONICAL PLAN (JSON):
${JSON.stringify(canonicalPlan, null, 1).slice(0, 9000)}

EXISTING HELPERS/PRIMITIVES discovered while exploring — you MUST give EACH an
explicit reuse OR not-applicable disposition with a reason, so a repo primitive
(shared lifecycle/dispose/pagination/transport helper) can NEVER silently
disappear (that was a direct cause of #167's hand-rolled registry):
${JSON.stringify(discoveredHelpers, null, 1).slice(0, 4000)}
Nearest analogues: ${JSON.stringify(discoveredAnalogues).slice(0, 1500)}

Output the design lock (schema fields only): a stable decisionId; the ONE chosen
approach concretely (owner + mechanism, PREFERRING reuse of an existing helper over
a hand-rolled parallel mechanism); invariants to preserve (id + statement);
helperDisposition for EVERY discovered helper; rejectedAlternatives (each with a
reason and a reopenWhen condition — the NEW evidence that would justify revisiting
it); stable-id acceptanceCriteria; and testProofRequirements (a regression MUST
exercise the REAL production entry point, not an extracted helper). Choose the
SIMPLEST approach that reuses the most.`,
      { schema: DESIGN_LOCK_SCHEMA, effort: 'high', phase: 'Design Lock', label: 'design-lock' },
      SOL_EXPLORE_PLAN_EFFORT
    ),
  null,
  'Design Lock'
)
// Independent challenge: a different read-only agent hunts for a repository
// primitive the lock failed to dispose (the #167 lifecycle.ts miss) or a missing
// invariant. It can only ADD reuse dispositions / invariants, never weaken the
// decision.
if (designLock) {
  const challenge = await safely(
    () =>
      agent(
        `${CONTRACTS}

PHASE: DESIGN-LOCK CHALLENGE (read-only). Proposed binding design lock:
${JSON.stringify(designLock, null, 1).slice(0, 8000)}

Your ONE job: grep src/core and the owning area for any EXISTING repository
primitive/helper the lock should reuse but did NOT dispose, or any invariant it
omits. Return ONLY additional helperDisposition entries (disposition 'reuse') and/or
additional invariants. If the lock is complete, return empty arrays.`,
        { schema: DESIGN_LOCK_SCHEMA, agentType: 'general-purpose', effort: 'medium', phase: 'Design Lock', label: 'design-lock:challenge' }
      ),
    null,
    'Design Lock challenge'
  )
  if (challenge) {
    const extraHelpers = (challenge.helperDisposition || []).filter((h) => h && h.disposition === 'reuse')
    const extraInv = challenge.invariants || []
    if (extraHelpers.length || extraInv.length) {
      designLock = {
        ...designLock,
        helperDisposition: [...(designLock.helperDisposition || []), ...extraHelpers],
        invariants: [...(designLock.invariants || []), ...extraInv],
      }
      log(`Design Lock: challenge added ${extraHelpers.length} reuse disposition(s), ${extraInv.length} invariant(s)`)
    }
  }
}
log(
  `Design Lock: ${(designLock && designLock.decisionId) || 'n/a'} — ${((designLock && designLock.helperDisposition) || []).length} helper dispositions, ${((designLock && designLock.rejectedAlternatives) || []).length} rejected alternatives`
)
// Compact binding block threaded into implement/review/verify/fixer so no phase can
// silently reinterpret the architecture. A finding that merely PREFERS a
// rejectedAlternative is out of scope (verdict 'refute') unless it carries NEW
// evidence meeting that alternative's reopenWhen.
const DESIGN_LOCK_BLOCK = designLock
  ? `\n\nBINDING DESIGN LOCK (decision "${designLock.decisionId}") — you MUST respect this decision, its invariants, and its helper dispositions. Do NOT re-open a rejectedAlternative without NEW evidence meeting its reopenWhen:\n${JSON.stringify(designLock, null, 1).slice(0, 6000)}`
  : ''

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 3 — IMPLEMENT (single writer)
// ═══════════════════════════════════════════════════════════════════════════
phase('Implement')

const implementPrompt = `${CONTRACTS}

PHASE: IMPLEMENT. You are the SOLE writer in this worktree. Follow this canonical
plan exactly (JSON):
${JSON.stringify(canonicalPlan, null, 1).slice(0, 12000)}
${DESIGN_LOCK_BLOCK}

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
let implemented = await safely(
  () => agent(implementPrompt, { ...implOpts, model: IMPL_MODEL, label: `implement:${IMPL_MODEL}` }),
  null,
  `Implement (${IMPL_MODEL})`
)
if (!implemented) {
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

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 4 — ADVERSARIAL REVIEW LOOP (parallel review → verify → single fixer)
// ═══════════════════════════════════════════════════════════════════════════
phase('Review')

const reviewContext = `${CONTRACTS}

The change is on branch ${BRANCH}. Inspect it with:
  git -C ${WORKTREE} diff ${BASE}...HEAD
  git -C ${WORKTREE} log --oneline ${BASE}..HEAD
  git -C ${WORKTREE} status --porcelain   # MUST be empty — a non-empty result is a finding
The reviewed diff is the COMMITTED range ${BASE}...HEAD; any uncommitted change is
unreviewed and would be lost on push, so treat a dirty worktree as a real finding.
You see ONLY the diff and this brief — never the implementer's reasoning.${DESIGN_LOCK_BLOCK}`

// A Claude adversarial reviewer for a scope: lens set → that lens only; lens null
// → a whole-diff pass. Used both as a first-class reviewer AND as the fallback
// when a Sol slot can't be routed, so no review scope is ever silently lost.
function claudeReview(roundNo, i, lens) {
  const scoped = lens
    ? `PHASE: ADVERSARIAL REVIEW — lens: "${lens}".
Assume the change is WRONG and prove how, THROUGH THIS LENS ONLY.`
    : `PHASE: ADVERSARIAL REVIEW — whole diff.
Assume the change is WRONG and prove how, across correctness, security/privacy
(fail-closed), lifecycle/concurrency, bounds/perf/no-jank, JF12 + MUI/legacy
compatibility, test strength, product scope, and docs/locale/generated-artifact gaps.`
  return agent(
    `${reviewContext}

${scoped}
A finding needs a real file/line and a concrete failure scenario (inputs/state →
wrong output / crash / leak / contract violation). "Looks fine" is not a finding.
Watch for mechanically-similar-but-semantically-different code (side effects
inside asserts/guards, eager vs lazy defaults, odd-length buffer truncation,
bounds checks present in one build only, byte-vs-UTF assumptions, escape/format
passes over the wrong data). Reject any workaround that needs a paragraph-long
comment to justify it. Return only real findings (empty array if none).`,
    { schema: FINDINGS_SCHEMA, agentType: 'code-reviewer', effort: 'medium', phase: 'Review', label: `review-r${roundNo}:${i + 1}${lens ? '' : ':whole'}` }
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
          } catch (_) {
            return null // codex harness threw → Claude fallback below (scope never lost)
          }
        }
      : async () => {
          try {
            const r = await agent(solPrompt, { schema: FINDINGS_SCHEMA, model: SOL_MODEL, effort: SOL_EFFORT, phase: 'Review', label: `sol-r${roundNo}:${i + 1}` })
            return r != null ? r : null
          } catch (_) {
            return null // Sol not routable → Claude fallback below
          }
        }

  return async () => {
    const r = await runSol()
    if (r != null) return r
    return claudeReview(roundNo, i, lens) // scope never lost
  }
}

const confirmedAll = []
let cleanRound = false
// Set only when a round TERMINATES the loop with incomplete coverage — a reviewer
// or a finding-verifier failed to return — so we never certify such a round clean.
let reviewIncomplete = false
// Stateful review (M1): detect design OSCILLATION so a non-converging change HALTS
// instead of grinding to the hard cap. A confirmed finding's stable semantic key
// re-appearing in a LATER round means its fixer's fix did not stick (or was
// reverted) — the #167 install-once↔track-teardown thrash signal. Also keeps the
// resolved-count HONEST: only findings a fixer actually applied are "resolved".
const confirmedKeyRounds = new Map() // findingKey → [rounds it was confirmed in]
let appliedFindingsResolved = 0 // HONEST: findings a fixer actually applied (not just confirmed)
let fixerFailures = 0 // fixer threw / returned null → its confirmed findings are UNRESOLVED
let designRevisions = 0 // times oscillation forced a design re-decision
let haltReason = null // set when the loop stops early for non-convergence
const MAX_DESIGN_REVISIONS = a.maxDesignRevisions == null ? 1 : Math.max(0, a.maxDesignRevisions)
const MIXED_ROUND_CAP = SIZING.roundCap
let round = 0
while (round < HARD_ROUND_CAP && !cleanRound && !haltReason) {
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

PHASE: VERIFY FINDING. Try hard to REFUTE this claimed defect. Return a disposition
(and set real accordingly):
- "confirm" (real=true): it genuinely reproduces or violates a repository contract /
  a Design-Lock invariant on a reachable path, WITHIN the locked architecture.
- "refute" (real=false): false, OR it merely PREFERS a Design-Lock rejectedAlternative
  without new evidence (that is out of scope, not a defect).
- "reopen-design" (real=false): it carries NEW repository evidence that the LOCKED
  design is wrong (a missed primitive it should reuse, or a proof it violates an
  invariant) — reserved for genuine architecture errors, not preference.
Default to "refute" when uncertain.
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

  // A missing verdict (verifier agent failed) is NOT a refutation — the finding
  // is unresolved, not cleared. Only a returned refute/false clears it. (M2)
  const dispositionOf = (v) => (v ? (v.disposition || (v.real ? 'confirm' : 'refute')) : null)
  const unverified = deduped.filter((_, i) => verdicts[i] == null).length
  // reopen-design findings carry NEW evidence the LOCKED architecture is wrong;
  // fold them into confirmed so the fixer addresses them, but count the round as a
  // design revision so persistent reopens halt via the budget (not grind forever).
  const reopened = deduped.filter((_, i) => dispositionOf(verdicts[i]) === 'reopen-design')
  const confirmed = deduped.filter((_, i) => {
    const d = dispositionOf(verdicts[i])
    return d === 'confirm' || d === 'reopen-design'
  })
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

  // OSCILLATION DETECTION: a confirmed key already seen in a PRIOR round means an
  // earlier fixer did not resolve it (or reverted it). Once repeats appear, allow
  // MAX_DESIGN_REVISIONS re-decisions, then HALT with a truthful haltReason rather
  // than grinding every remaining round to the hard cap (the #167 8-hour failure).
  const repeats = confirmed.filter((f) => (confirmedKeyRounds.get(findingKey(f)) || []).length > 0)
  for (const f of confirmed) {
    const k = findingKey(f)
    confirmedKeyRounds.set(k, [...(confirmedKeyRounds.get(k) || []), round])
  }
  if (repeats.length) {
    designRevisions++
    log(`Review round ${round}: ${repeats.length} finding(s) re-confirmed after a prior fix → design revision ${designRevisions}/${MAX_DESIGN_REVISIONS}`)
    if (designRevisions > MAX_DESIGN_REVISIONS) {
      haltReason = 'non-convergent-design'
      log(`Review: oscillation persists after ${MAX_DESIGN_REVISIONS} design revision(s) — HALTING (non-convergent-design) for a design re-decision instead of grinding to round ${HARD_ROUND_CAP}`)
      break
    }
  }
  // A "reopen-design" verdict means a reviewer found NEW evidence the LOCKED design
  // is wrong (a missed primitive / invariant violation). Count it as a design
  // revision on the same budget as oscillation; persistent reopens halt for a real
  // design re-decision rather than the fixer thrashing the architecture. (M2)
  if (reopened.length) {
    designRevisions++
    log(`Review round ${round}: ${reopened.length} finding(s) REOPEN the design lock (new evidence) → design revision ${designRevisions}/${MAX_DESIGN_REVISIONS}`)
    if (designRevisions > MAX_DESIGN_REVISIONS) {
      haltReason = 'design-reopened'
      log(`Review: design reopens persist after ${MAX_DESIGN_REVISIONS} revision(s) — HALTING (design-reopened) for a design re-decision`)
      break
    }
  }

  // A finding whose verifier failed to return is neither confirmed nor refuted:
  // that scope is unresolved even though we DID confirm (and will fix) others in
  // the same batch. Don't let the fixed-confirmed path silently drop it — mark the
  // run's coverage incomplete so a later non-deterministic clean round can't
  // certify the branch behind an unresolved finding (fail closed).
  if (unverified) {
    reviewIncomplete = true
    log(`Review round ${round}: ${confirmed.length} confirmed but ${unverified} finding(s) unverified (verifier failure) → coverage incomplete, run cannot certify clean`)
  }
  log(`Review round ${round}: ${confirmed.length} confirmed → fixing`)

  // The fixer is a REQUIRED writer: capture its result so the resolved-count is
  // HONEST and reverts/oscillation are visible. A throw/null means its confirmed
  // findings are UNRESOLVED — never silently counted as resolved (fixes #167's
  // "even a thrown fixer counts as resolved" telemetry lie). safely() still keeps a
  // throw from aborting the whole workflow so verify can run and report.
  const fixResult = await safely(
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
guard. Do not fix anything not listed. Stay WITHIN the binding design lock — do NOT
switch to a rejectedAlternative architecture. ${COMMIT_RULE}
REPORT which confirmed findings you actually applied vs left unresolved, whether
fixing them required reverting a previous round's fix (revertedPriorFix), the new
short HEAD, and production addedLines/deletedLines (git diff --numstat, excluding
tests/locales).${DESIGN_LOCK_BLOCK}

CONFIRMED FINDINGS:
${JSON.stringify(confirmed, null, 1).slice(0, 10000)}`,
        { schema: FIX_SCHEMA, agentType: 'general-purpose', effort: 'high', phase: 'Review', label: `fix-r${round}` }
      ),
    null,
    `Review fixer (round ${round})`
  )
  const fixerRan = !!(fixResult && Array.isArray(fixResult.commits) && (fixResult.commits.length || (Array.isArray(fixResult.applied) && fixResult.applied.length)))
  if (fixerRan) {
    appliedFindingsResolved += Array.isArray(fixResult.applied) && fixResult.applied.length ? fixResult.applied.length : confirmed.length
    if (fixResult.revertedPriorFix) {
      designRevisions++
      log(`Review round ${round}: fixer reverted a prior fix → design revision ${designRevisions}/${MAX_DESIGN_REVISIONS}`)
      if (designRevisions > MAX_DESIGN_REVISIONS) {
        haltReason = 'non-convergent-design'
        log(`Review: fixer reverts persist after ${MAX_DESIGN_REVISIONS} design revision(s) — HALTING (non-convergent-design)`)
      }
    }
  } else {
    fixerFailures++
    reviewIncomplete = true
    log(`Review round ${round}: fixer failed to return — ${confirmed.length} confirmed finding(s) UNRESOLVED (coverage incomplete)`)
  }
}
if (!cleanRound)
  log(
    haltReason
      ? `Review: HALTED (${haltReason}) after ${round} round(s) — needs a design re-decision; will report as residual risk`
      : reviewIncomplete
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
if (SURFACE !== 'server') {
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
// A VERIFY-FIX writes production code AFTER the adversarial review round that set
// cleanRound. Those commits never appeared in any reviewer's diff, so reusing the
// stale cleanRound to certify them is unsafe. Track whether any verify-fix
// actually committed; if so the final diff is unreviewed and NOT ready for PR.
let verifyFixCommitted = false
while (vround <= SIZING.verifyFixCap) {
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
const result = {
  branch: BRANCH,
  surface: SURFACE,
  depth: DEPTH,
  loopClean: cleanRound,
  reviewRounds: round,
  reviewIncomplete,
  haltReason,
  designRevisions,
  incidentalBugs,
  // HONEST: findings a fixer actually applied (a thrown/absent fixer no longer
  // inflates this). confirmedFindingsTotal keeps the raw confirmed count.
  confirmedFindingsResolved: appliedFindingsResolved,
  confirmedFindingsTotal: confirmedAll.length,
  fixerFailures,
  implement: implemented || null,
  canonicalPlan: canonicalPlan || null,
  designLock: designLock || null,
  verify: verify || null,
  verifyFixCommitted,
  readyForPR: implementationOk && cleanRound && !reviewIncomplete && !haltReason && !verifyFixCommitted && blockingGreen && e2eGreen,
  residualRisks: []
    .concat(implemented ? [] : ['implementation did not complete — both implementer models failed to return a result'])
    .concat(openTodos.length ? ['implementer left open acceptance-criteria TODOs — change is incomplete'] : [])
    .concat(haltReason ? [`review HALTED (${haltReason}): the same defect kept re-appearing after fixes (design oscillation) — needs a design re-decision, not more rounds, before a PR`] : [])
    .concat(reviewIncomplete ? ['adversarial review ended with incomplete coverage (a reviewer, finding-verifier, or fixer failed) — the round could not be certified clean'] : [])
    .concat(cleanRound || reviewIncomplete || haltReason ? [] : ['review loop hit its round cap with unresolved confirmed findings'])
    .concat(verifyFixCommitted ? ['verify-fix committed code AFTER the clean review round — those commits were never adversarially reviewed; re-run the review loop before opening a PR'] : [])
    .concat(blockingGreen ? [] : ['one or more BLOCKING gates are failing'])
    .concat(e2eGreen ? [] : ['e2e:local did not pass'])
    .concat(openTodos),
}
log(
  `canopy-loop done: readyForPR=${result.readyForPR} · impl=${implementationOk} · rounds=${round}${haltReason ? ` · HALTED=${haltReason}` : ''} · findings resolved=${appliedFindingsResolved}/${confirmedAll.length} · blockingGreen=${blockingGreen}${RUNTIME ? ` · e2e=${e2eGreen}` : ''}`
)
return result
