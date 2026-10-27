export const meta = {
  name: 'midio-pixel-state-audit',
  description: 'Analyze midio-pixel subsystems, adversarially verify findings, and synthesize an improvement plan',
  phases: [
    { title: 'Survey', detail: 'parallel subsystem readers produce evidence-backed findings' },
    { title: 'Verify', detail: 'lens-diverse skeptics try to refute each finding' },
    { title: 'Gaps', detail: 'completeness critic + follow-up surveys' },
    { title: 'Plan', detail: 'synthesize prioritized roadmap' },
  ],
}

const REPO = 'V:\\Development\\midio-pixel'
const RULES = `
Repo: ${REPO} (Node 24 ESM web app "midio-pixel": music-reactive pixel landscapes, three.js, Playwright smokes). Read AGENTS.md first.
STRICT RULES: This is a READ-ONLY analysis. Do NOT edit, create, or delete tracked files; do not commit, checkout, stash, or switch branches.
You MAY run read-only commands and targeted tests (e.g. node --test test/<file>.js, individual tools/*-smoke.mjs). Any output dir must be .smoke/audit-<your-label>-<n>. Keep Chromium headless; never open headed browsers. If you start a server, use a random high port (e.g. 18000-18999) and kill it afterward.
Do NOT run the full "npm test" or "npm run lint" — the orchestrator runs those separately.
Every finding MUST cite concrete evidence: file paths with line numbers, command + relevant output, or git refs. No speculation presented as fact; if unsure, say so in the evidence and lower confidence.
Prefer fewer, high-signal findings over long lists of nits. Include genuine strengths too (in "strengths").`

const FINDINGS = {
  type: 'object',
  properties: {
    area: { type: 'string' },
    summary: { type: 'string', description: '4-8 sentence state-of-the-subsystem summary' },
    strengths: { type: 'array', items: { type: 'string' } },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          category: { type: 'string', description: 'e.g. correctness, performance, maintainability, test-coverage, ci, security, docs, process, ux' },
          evidence: { type: 'string', description: 'file:line refs, commands run and output excerpts' },
          description: { type: 'string' },
          recommendation: { type: 'string' },
          effort: { type: 'string', enum: ['S', 'M', 'L', 'XL'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['title', 'severity', 'category', 'evidence', 'description', 'recommendation', 'effort', 'confidence'],
      },
    },
  },
  required: ['area', 'summary', 'strengths', 'findings'],
}

const VERDICT = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['confirmed', 'refuted', 'uncertain'] },
    corrected_severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'none'] },
    reasoning: { type: 'string', description: 'What you checked (files/lines/commands) and what you found' },
  },
  required: ['verdict', 'corrected_severity', 'reasoning'],
}

const AREAS = [
  { key: 'range-v2-integrity', prompt: `Area: Range v2 scene/terrain assets and the integrity gate. A prior session (2026-10-21) found the Range v2 integrity gate rejecting nc-ross-lake-north (terrain.json hash 836b9d99... vs catalog pin 32ee5822... at src/world/terrain/sceneCatalogData.js:59), widening to all 17 views; CRLF checkout was hypothesized. Since then .gitattributes marks src/assets/range/v2/** -text and the checkout shows LF. VERIFY CURRENT STATE: recompute SHA-256 of the committed asset bytes vs catalog/manifest pins for ALL views (write a throwaway node script under .smoke/audit-range/ or use node -e), find where the gate runs (src/world/terrain/*), and if feasible run tools/range-landscape-smoke.mjs or the relevant test (test/*range*/*catalog*). Also assess whether the gate is robust (e.g. would a fresh Windows clone without -text, or a GitHub Pages deploy, still pass? does stage:site copy bytes verbatim?). Report the scene library structure and health.` },
  { key: 'world-terrain-scenic', prompt: `Area: src/world (terrain, scenic tours, camera paths, landscape cast, forests, water, clouds, sky). Assess architecture, module size/cohesion (find the largest files), coupling, dead code, correctness risks in the recent scenic rebuild / transfer-endings / landscape cast work (see recent git log and docs/scenic-*.md), and open questions the docs leave unresolved.` },
  { key: 'render-perf', prompt: `Area: src/render, src/sim, src/vision and runtime performance. Assess the render loop, GPU/CPU hot paths, allocation churn per frame, shader complexity, pixel-grid modes, automatic performance scaling ("automatic performance" is a product promise), and memory lifetime (recent commit c9c1863 touched placement memory lifetime). Look for per-frame allocations, unbounded caches, redundant work. Use tools/gpu-review.mjs or benchmarks only if cheap.` },
  { key: 'audio-music', prompt: `Area: src/audio, src/core, src/lyrics, src/eval — music analysis (segmentation, beat/section detection, reactivity mapping) and how music drives visuals. Assess algorithm quality, test coverage, performance (tools/benchmark-segmentation.mjs), and opportunities for "intelligent optimization" (offline analysis informing visual parameters). Note any optional LLM-assisted analysis hooks and whether they support user API keys across Ollama/Anthropic/OpenAI/Gemini/OpenRouter (a stated owner requirement) — but only recommend LLM integration where it clearly adds value as a silent background engine.` },
  { key: 'library-net-sources', prompt: `Area: music sourcing and network: src/library, src/net, src/soulseek, slskd/, docker-compose, tools/music-server.mjs, tools/plex-*.mjs, .env examples, src/config. Assess correctness, error handling, security (secrets handling, tokens in client bundles, path traversal in local servers, CORS, input validation in tools/serve.js and music-server), dependency risk (slsk-client 2.0.2 maintenance status), and UX of loading music (URL load, Plex, local files).` },
  { key: 'ui-ux', prompt: `Area: src/ui, start screen, export (tools/export-smoke.mjs, bulk-export), car mode, index/entry HTML, mobile responsiveness, accessibility, and onboarding. The owner prioritizes desktop web first, then mobile web. Assess UX gaps, mobile support, error states, and load time (bundle composition, esbuild usage, vendor/ three.js size).` },
  { key: 'tests-ci', prompt: `Area: test/ (≈518 files), tools/*smoke*.mjs, .github/workflows/*.yml, .github/actions/setup. Assess: what CI runs on PR vs main vs manual, coverage gaps (which src dirs lack tests), flaky/slow tests, test-file sprawl, whether smokes that need GPU/Chromium are gated, duplication between smokes, CI cost/time, and whether CI enforces lint + unit tests on every PR. Check whether test names map to modules that still exist (orphaned tests).` },
  { key: 'repo-process-docs', prompt: `Area: repository hygiene, process and docs. Inspect: remote branches (git branch -r, with last commit dates and whether merged into origin/main: git branch -r --merged origin/main / --no-merged), docs/ sprawl (many dated plan/review docs — is there a current index/roadmap? which are stale?), docs/evidence policy, ridgeview/ (what is it, is it live?), .remember/ and other local tooling dirs vs .gitignore, repo size (git count-objects -vH, large blobs in history), README accuracy vs package.json scripts, CNAME/static deploy. Recommend consolidation.` },
  { key: 'code-health', prompt: `Area: cross-cutting code health across src/ and tools/. Measure: largest files (lines), duplicated logic between src and tools, circular imports, ESLint config strictness (eslint.config.*), TODO/FIXME/HACK density and the most important ones, unused exports/dead modules (spot-check with grep for importers), error handling patterns, and any type-safety story (JSDoc/checkJs). Quantify where possible.` },
]

const surveyPrompt = (a, extra = '') => `${RULES}\n\n${a.prompt}${extra}\n\nReturn your structured findings for this area. Set area="${a.key}".`

const verifyOne = (f, area, lens) => agent(
  `${RULES}\n\nYou are an adversarial verifier using the ${lens} lens. A surveyor of area "${area}" claims:\n\nTITLE: ${f.title}\nSEVERITY: ${f.severity}\nDESCRIPTION: ${f.description}\nEVIDENCE: ${f.evidence}\nRECOMMENDATION: ${f.recommendation}\n\nTry hard to REFUTE this claim by independently checking the cited code/commands in the repo. Lenses: "reproduce" = re-check the exact evidence still holds on current main; "impact" = is the severity/impact overstated or is it actually harmless/intentional (check docs, comments, git log for rationale); "context" = is it already handled elsewhere, already fixed on a branch/PR, or contradicted by other code? If you cannot confirm it from primary evidence, verdict=refuted or uncertain. Give corrected_severity.`,
  { label: `verify:${area}:${lens}`, phase: 'Verify', schema: VERDICT })

const verifyFinding = async (f, area) => {
  const heavy = f.severity === 'critical' || f.severity === 'high'
  const lenses = heavy ? ['reproduce', 'impact', 'context'] : ['reproduce']
  const votes = (await parallel(lenses.map(l => () => verifyOne(f, area, l)))).filter(Boolean)
  const confirmed = votes.filter(v => v.verdict === 'confirmed').length
  const refuted = votes.filter(v => v.verdict === 'refuted').length
  const status = votes.length === 0 ? 'unverified' : (heavy ? (confirmed >= 2 ? 'confirmed' : refuted >= 2 ? 'refuted' : 'contested') : (votes[0].verdict))
  const sevs = votes.map(v => v.corrected_severity).filter(s => s !== 'none')
  return { ...f, area, status, votes, final_severity: sevs[0] ? mostCommon(sevs) : f.severity }
}

function mostCommon(arr) {
  const c = {}; arr.forEach(x => c[x] = (c[x] || 0) + 1)
  return Object.entries(c).sort((a, b) => b[1] - a[1])[0][0]
}

const runArea = (a) => pipeline([a],
  x => agent(surveyPrompt(x), { label: `survey:${x.key}`, phase: 'Survey', schema: FINDINGS }),
  async (report) => {
    if (!report) return null
    const verified = await parallel(report.findings.map(f => () => verifyFinding(f, report.area)))
    return { ...report, findings: verified.filter(Boolean) }
  }).then(r => r[0])

phase('Survey')
const reports = (await parallel(AREAS.map(a => () => runArea(a))))
const missing = AREAS.filter((a, i) => !reports[i]).map(a => a.key)
if (missing.length) log(`WARNING: surveys failed (no result): ${missing.join(', ')}`)
let all = reports.filter(Boolean)

phase('Gaps')
const digest = all.map(r => `## ${r.area}\n${r.summary}\n` + r.findings.map(f => `- [${f.status}/${f.final_severity}] ${f.title}`).join('\n')).join('\n\n')
const GAPS = {
  type: 'object',
  properties: { gaps: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, prompt: { type: 'string' } }, required: ['key', 'prompt'] } } },
  required: ['gaps'],
}
const critic = await agent(`${RULES}\n\nYou are a completeness critic for a state-of-the-project audit of midio-pixel. Below are the area summaries and verified findings so far.${missing.length ? ` These areas FAILED and must be re-covered: ${missing.join(', ')}.` : ''}\n\n${digest}\n\nSkim the repo structure (src/*, tools/, test/, docs/, .github/) and identify up to 4 significant areas or questions NOT yet covered (or failed) that matter for an improvement plan. For each, write a self-contained survey prompt (what to inspect, what to measure). Return an empty list if coverage is genuinely sufficient.`, { label: 'completeness-critic', phase: 'Gaps', schema: GAPS })
if (critic && critic.gaps.length) {
  log(`Critic found ${critic.gaps.length} gap(s): ${critic.gaps.map(g => g.key).join(', ')}`)
  const extra = (await parallel(critic.gaps.slice(0, 4).map(g => () => runArea(g)))).filter(Boolean)
  all = all.concat(extra)
}

phase('Plan')
const survivors = all.flatMap(r => r.findings.filter(f => f.status !== 'refuted').map(f => ({ area: r.area, ...f, votes: undefined, vote_notes: (f.votes || []).map(v => `${v.verdict}: ${v.reasoning}`).join(' | ') })))
const refuted = all.flatMap(r => r.findings.filter(f => f.status === 'refuted').map(f => `${r.area}: ${f.title}`))
log(`${survivors.length} findings survived verification; ${refuted.length} refuted`)

const plan = await agent(`${RULES}\n\nYou are the lead architect writing the final "state of midio-pixel + improvement plan" report for the owner. Owner priorities: performance above all; desktop web first then mobile web; local-first modular logic; AI only as a silent background optimization engine with user-supplied keys (Ollama/Anthropic/OpenAI/Gemini/OpenRouter) where it adds real value.\n\nArea summaries and strengths:\n${JSON.stringify(all.map(r => ({ area: r.area, summary: r.summary, strengths: r.strengths })), null, 1)}\n\nVerified findings (status confirmed/contested/uncertain/unverified; final_severity after verification; vote_notes = verifier reasoning):\n${JSON.stringify(survivors, null, 1)}\n\nRefuted (exclude, but you may mention in an appendix): ${JSON.stringify(refuted)}\n\nYou may spot-check the repo to resolve contested items. Write a Markdown report with: 1) Executive summary (overall health verdict in 5-8 bullets, incl. test/CI health), 2) Strengths to preserve, 3) Key problems ranked (cite file:line evidence, mark contested ones), 4) Improvement plan as phased roadmap: Phase 0 (stabilize, this week), Phase 1 (high-leverage, 2-4 weeks), Phase 2 (strategic) — each item with concrete steps, effort (S/M/L/XL), expected impact, dependencies, and verification method (which test/smoke/visual-eval proves it), 5) Explicit non-goals / things to stop doing, 6) Open questions for the owner, 7) Appendix: refuted claims. Be concrete and specific to this codebase. Return ONLY the markdown.`, { label: 'synthesize-plan', phase: 'Plan' })

return { plan, survivors_count: survivors.length, refuted, missing, areas: all.map(r => r.area), findings: survivors }