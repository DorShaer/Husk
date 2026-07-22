export const meta = {
  name: 'deep-verified-research',
  description:
    'Claim-level adversarial research: scope, parallel search-and-extract of falsifiable claims with quotes, then a fixed pool of lens-diverse verifiers that each adjudicate the whole claim set (3 votes per claim from 3 agents, not 3 agents per claim), then a confidence-tagged cited synthesis. The deepest, slowest Research tier — does NOT replace Extensive; it adds Anthropic deep-research claim-verification rigor on top, at the cost of one extra serial hop.',
  whenToUse:
    'The deepest and SLOWEST Research tier (measured ~150-190s, roughly one serial hop slower than Extensive by design — claim-level verification cannot start until claims exist). Use Extensive for fast default research; reach for THIS when claims must be bulletproof: every extracted claim is judged by three skeptics from different lenses (quote-support, contradiction, source-strength), survives only on a quorum of non-refuting votes, and all-abstain never survives, then a written synthesis merges and frames the survivors. Pass args as an OBJECT {question, test?} — not a JSON string.',
  phases: [
    { title: 'Scope', detail: 'decompose question into search angles, sentiment-aware' },
    { title: 'Explore', detail: 'parallel search-and-extract: falsifiable claims with quotes' },
    { title: 'Verify', detail: '3 lens-diverse verifiers each adjudicate the whole claim set' },
    { title: 'Synthesize', detail: 'merge dupes, confidence-tag, cite, open questions' },
  ],
}

// DeepVerifiedResearch: Scope -> parallel Explore(search+extract) -> Verify(fixed verifier pool) -> Synthesize.
// Verification rigor is ported from Anthropic's deep-research (falsifiable claims, adversarial refutation,
// quorum-kill, abstention guard) but the TOPOLOGY is LifeOS's fast parallel-explorer shape, not a 5-stage
// per-claim fan-out. The decisive speed/cost fix (2026-06-02): instead of N claims x 3 voter agents
// (~60 agents, ~1M tokens, 5 min, and the voters died on turn-exhaustion), use a FIXED pool of 3
// verifier agents that EACH judge the entire claim list from a distinct lens. Still 3 votes per claim,
// ~20x fewer agents, and verifiers emit reliably because they judge on the quote (bounded search).

// args may arrive as a real object (preferred) or a JSON string (stringified invocation). Normalise.
let INPUT = args
if (typeof INPUT === 'string') {
  try {
    const parsed = JSON.parse(INPUT)
    if (parsed && typeof parsed === 'object') INPUT = parsed
  } catch {
    // Not JSON — treat the bare string as the question (handled at entry).
  }
}

const TEST = !!(INPUT && INPUT.test)
const REFUTATIONS_REQUIRED = (INPUT && INPUT.refutesToKill) || 2
const MAX_VERIFY_CLAIMS = TEST ? 6 : (INPUT && INPUT.maxClaims) || 24
const MAX_ANGLES = TEST ? 2 : 5

// The fixed verifier pool. One agent per lens; each votes on EVERY claim. VOTES_PER_CLAIM == pool size.
const VERIFIER_LENSES = [
  'QUOTE-SUPPORT — for each claim, does the supplied quote actually establish it, or is it an overreach, misread, or cherry-pick?',
  'CONTRADICTION — for the claims that matter most, is there credible evidence that disputes, debunks, or heavily qualifies them? You MAY run a couple of web searches total, but do NOT search every claim — judge mainly on the quote and your own knowledge.',
  'SOURCE-STRENGTH — for each claim, is the source quality and recency sufficient for how strong the claim is? Extraordinary claims need primary sources; marketing/forum/blog sources weakly support strong claims.',
]
const VOTES_PER_CLAIM = VERIFIER_LENSES.length

// ----- Schemas (validated and retried at the tool layer) -----

const SCOPE_SCHEMA = {
  type: 'object',
  required: ['question', 'angles', 'summary'],
  properties: {
    question: { type: 'string' },
    summary: { type: 'string' },
    sentiment: { type: 'boolean' },
    angles: {
      type: 'array',
      minItems: 2,
      maxItems: 6,
      items: {
        type: 'object',
        required: ['label', 'query', 'kind'],
        properties: {
          label: { type: 'string' },
          query: { type: 'string' },
          kind: { type: 'string', enum: ['web', 'community'] },
          rationale: { type: 'string' },
        },
      },
    },
  },
}

// One explorer = one web search + claim extraction in a single agent (merges the old Search+Fetch stages).
const EXPLORE_SCHEMA = {
  type: 'object',
  required: ['claims'],
  properties: {
    claims: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        required: ['claim', 'quote', 'importance', 'sourceUrl', 'sourceQuality'],
        properties: {
          claim: { type: 'string' },
          quote: { type: 'string' },
          importance: { type: 'string', enum: ['central', 'supporting', 'tangential'] },
          sourceUrl: { type: 'string' },
          sourceTitle: { type: 'string' },
          sourceQuality: { type: 'string', enum: ['primary', 'secondary', 'blog', 'forum', 'unreliable'] },
        },
      },
    },
  },
}

// One verifier returns a verdict for each claim id it judged. Omitting an id == abstain on that claim.
const VERIFY_BATCH_SCHEMA = {
  type: 'object',
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'refuted', 'confidence'],
        properties: {
          id: { type: 'integer' },
          refuted: { type: 'boolean' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          evidence: { type: 'string' },
        },
      },
    },
  },
}

const REPORT_SCHEMA = {
  type: 'object',
  required: ['summary', 'findings', 'caveats'],
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['claim', 'confidence', 'sources', 'evidence'],
        properties: {
          claim: { type: 'string' },
          confidence: { type: 'string', enum: ['HIGH', 'MED', 'LOW', 'CONFLICT'] },
          sources: { type: 'array', items: { type: 'string' } },
          evidence: { type: 'string' },
          vote: { type: 'string' },
        },
      },
    },
    caveats: { type: 'string' },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
}

// ----- Entry -----
const QUESTION = (INPUT && INPUT.question) || (typeof INPUT === 'string' ? INPUT : '')
if (!QUESTION) {
  return { error: "No research question. Pass args as an object: {question: '...'}." }
}

// ----- Phase 0: Scope -----
phase('Scope')
const scope = await agent(
  'Decompose this research question into complementary web search angles.\n\n## Question\n' +
    QUESTION +
    '\n\n## Task\nGenerate ' +
    MAX_ANGLES +
    ' distinct angles that together cover the question from different sides (broad/primary, academic, recent news, ' +
    'contrarian, practitioner). Make each query specific. Set kind="community" for angles really about what PEOPLE think ' +
    '(sentiment, reactions, ratings) — those route to Reddit/X/YouTube, not recap journalism — and sentiment=true if the ' +
    'overall question is opinion-shaped. Otherwise kind="web". Return question, a one-line strategy as summary, and angles.\n\n' +
    'Structured output only.',
  { label: 'scope', phase: 'Scope', schema: SCOPE_SCHEMA },
)
if (!scope) {
  return { error: 'Scope agent returned nothing — cannot decompose the question.' }
}
const angles = scope.angles.slice(0, MAX_ANGLES)
log(
  (scope.sentiment ? '[sentiment] ' : '') +
    'Q: ' +
    QUESTION.slice(0, 70) +
    ' -> ' +
    angles.length +
    ' angles: ' +
    angles.map((a) => a.label + ':' + a.kind).join(', '),
)

// ----- Phase 1: Explore (parallel search + claim extraction, native agents for reliable structured output) -----
phase('Explore')
const explorePrompt = (angle) =>
  '## Researcher: ' +
  angle.label +
  '\n\nResearch question: "' +
  QUESTION +
  '"\nYour angle: **' +
  angle.label +
  '** — ' +
  (angle.rationale || '') +
  '\nSuggested query: ' +
  angle.query +
  '\n\n## Task\n' +
  (angle.kind === 'community'
    ? 'COMMUNITY-SENTIMENT angle — prioritise what real people said (Reddit: append .json to threads; X; YouTube comments) over recap journalism.\n'
    : 'Use web search; open the 1-3 most relevant results.\n') +
  'Extract 2-6 FALSIFIABLE claims that bear on the question. Each claim must be concrete and checkable, carry a direct ' +
  'quote from its source, name its sourceUrl, and rate sourceQuality (primary/secondary/blog/forum/unreliable) and ' +
  'importance (central/supporting/tangential). Skip SEO spam. If you find nothing usable, return claims: [].\n' +
  'Your FINAL action MUST be the structured output — do not end your turn without emitting it.'

const explored = await parallel(
  angles.map((angle) => () =>
    agent(explorePrompt(angle), { label: 'explore:' + angle.label, phase: 'Explore', schema: EXPLORE_SCHEMA })
      .then((r) => (r && r.claims ? r.claims.map((c) => ({ ...c, angle: angle.label })) : []))
      .catch((e) => {
        log('explore failed: ' + angle.label + ' — ' + (e.message || e))
        return []
      }),
  ),
)

// Dedup claims (same source + same claim text) and rank by importance then source quality.
const impRank = { central: 0, supporting: 1, tangential: 2 }
const qualRank = { primary: 0, secondary: 1, blog: 2, forum: 3, unreliable: 4 }
const norm = (u) => {
  try {
    const p = new URL(u)
    return (p.hostname.replace(/^www\./, '') + p.pathname.replace(/\/$/, '')).toLowerCase()
  } catch {
    return String(u).toLowerCase()
  }
}
const seenClaim = new Set()
const allClaims = []
for (const c of explored.flat()) {
  if (!c || !c.claim) continue
  const key = norm(c.sourceUrl) + '::' + c.claim.slice(0, 80).toLowerCase()
  if (seenClaim.has(key)) continue
  seenClaim.add(key)
  allClaims.push(c)
}
const rankedClaims = allClaims
  .sort((a, b) => impRank[a.importance] - impRank[b.importance] || qualRank[a.sourceQuality] - qualRank[b.sourceQuality])
  .slice(0, MAX_VERIFY_CLAIMS)
  .map((c, i) => ({ ...c, id: i }))

log('Explored ' + angles.length + ' angles -> ' + allClaims.length + ' claims -> verifying top ' + rankedClaims.length)

if (rankedClaims.length === 0) {
  return {
    question: QUESTION,
    summary: 'No claims extracted across ' + angles.length + ' angles. Sources were empty, blocked, or irrelevant.',
    findings: [],
    refuted: [],
    sources: [],
    stats: { angles: angles.length, claims: 0, confirmed: 0, killed: 0 },
  }
}

// ----- Phase 2: Verify — fixed verifier pool, each judges the WHOLE claim list from one lens -----
phase('Verify')
const claimBlock = rankedClaims
  .map((c) => '[' + c.id + '] "' + c.claim + '"\n    quote: "' + c.quote + '"\n    source: ' + c.sourceUrl + ' (' + c.sourceQuality + ')')
  .join('\n')

const verifyPrompt = (lens) =>
  '## Adversarial Claim Verifier\n\nResearch question: "' +
  QUESTION +
  '"\n\nYour attack lens: ' +
  lens +
  '\n\nBe SKEPTICAL — your job is to REFUTE. For EACH claim below, decide refuted=true or refuted=false and give a ' +
  'one-line specific evidence note. Default to refuted=true when unsure: refute if the quote does not support the claim, ' +
  'if credible evidence contradicts it, if the source is too weak for the claim strength, if it is outdated, or if it is ' +
  'marketing/forum speculation. refuted=false ONLY when the claim is well-supported, current, and sourced to a quality ' +
  'matching its strength.\n\n## Claims\n' +
  claimBlock +
  '\n\nReturn one verdict per claim id. Judge primarily on the quote and your knowledge — bounded web search only. ' +
  'Your FINAL action MUST be the structured verdicts array — do not end your turn without emitting it.'

const verifierResults = await parallel(
  VERIFIER_LENSES.map((lens, k) => () =>
    agent(verifyPrompt(lens), { label: 'verify:lens' + k, phase: 'Verify', schema: VERIFY_BATCH_SCHEMA })
      .then((r) => (r && r.verdicts ? r.verdicts : null))
      .catch(() => null),
  ),
)
const validVerifiers = verifierResults.filter(Boolean)
log('Verify: ' + validVerifiers.length + '/' + VERIFIER_LENSES.length + ' verifiers returned verdicts')

// Tally per-claim votes across the verifier pool. A verifier omitting an id == abstain on that claim.
const voted = rankedClaims.map((c) => {
  const verdicts = validVerifiers.map((vs) => vs.find((v) => v.id === c.id)).filter(Boolean)
  const refutedVotes = verdicts.filter((v) => v.refuted).length
  const valid = verdicts.length
  // Survive only if actually adjudicated: a quorum of valid votes AND fewer than the kill threshold
  // refuting. All-abstain (valid < REFUTATIONS_REQUIRED) must NOT survive — guards the false-survive bug.
  const survives = valid >= REFUTATIONS_REQUIRED && refutedVotes < REFUTATIONS_REQUIRED
  log('"' + c.claim.slice(0, 48) + '…": ' + (valid - refutedVotes) + '-' + refutedVotes + (valid < VOTES_PER_CLAIM ? ' (' + (VOTES_PER_CLAIM - valid) + ' abstain)' : '') + ' ' + (survives ? '✓' : '✗'))
  return { ...c, verdicts, refutedVotes, valid, survives }
})
const confirmed = voted.filter((c) => c.survives)
const killed = voted.filter((c) => !c.survives)
log('Verify done: ' + confirmed.length + ' confirmed, ' + killed.length + ' killed')

const sources = [...new Set(rankedClaims.map((c) => c.sourceUrl))].map((u) => {
  const c = rankedClaims.find((x) => x.sourceUrl === u)
  return { url: u, quality: c.sourceQuality }
})

if (confirmed.length === 0) {
  return {
    question: QUESTION,
    summary: 'All ' + voted.length + ' claims were refuted or unadjudicated by the verifier pool. Inconclusive — sources weak or claims overstated.',
    findings: [],
    refuted: killed.map((c) => ({ claim: c.claim, vote: c.valid - c.refutedVotes + '-' + c.refutedVotes, source: c.sourceUrl })),
    sources,
    stats: { angles: angles.length, claims: allClaims.length, verified: voted.length, confirmed: 0, killed: killed.length },
  }
}

// ----- Phase 3: Synthesize -----
phase('Synthesize')
const confRank = { high: 0, medium: 1, low: 2 }
const block = confirmed
  .map((c) => {
    const best = c.verdicts.filter((v) => !v.refuted).sort((a, b) => confRank[a.confidence] - confRank[b.confidence])[0]
    return (
      '### [' + c.id + '] ' + c.claim + '\nVote: ' + (c.valid - c.refutedVotes) + '-' + c.refutedVotes + ' · Source: ' +
      c.sourceUrl + ' (' + c.sourceQuality + ')\nQuote: "' + c.quote + '"\nVerifier note (' + (best ? best.confidence : 'n/a') + '): ' + (best && best.evidence ? best.evidence : '') + '\n'
    )
  })
  .join('\n')
const killedBlock =
  killed.length > 0
    ? '\n## Refuted/unverified (transparency)\n' + killed.map((c) => '- "' + c.claim + '" (' + c.sourceUrl + ', vote ' + (c.valid - c.refutedVotes) + '-' + c.refutedVotes + ')').join('\n')
    : ''

const report = await agent(
  '## Synthesis: research report\n\n**Question:** ' +
    QUESTION +
    '\n\n' +
    confirmed.length +
    ' claims survived ' +
    VOTES_PER_CLAIM +
    '-vote adversarial verification. Merge semantic duplicates and synthesize.\n\n## Confirmed claims\n' +
    block +
    '\n' +
    killedBlock +
    '\n\n## Instructions\n1. Merge claims that say the same thing, combining sources.\n2. Group related claims into ' +
    'coherent findings that each address the question.\n3. Tag each finding [HIGH] strong/multi-source, [MED] single ' +
    'decent source, [LOW] survived but thin, [CONFLICT] sources disagree (quote both).\n4. Keep verified source URLs; ' +
    'never restore a refuted claim.\n5. Note caveats: what is uncertain, weak, or time-sensitive.\n6. List 2-4 open ' +
    'questions. Structured output only.',
  { label: 'synthesize', phase: 'Synthesize', schema: REPORT_SCHEMA },
)
if (!report) {
  return {
    question: QUESTION,
    summary: 'Synthesis skipped/failed — returning ' + confirmed.length + ' verified claims unmerged.',
    findings: [],
    confirmed: confirmed.map((c) => ({ claim: c.claim, source: c.sourceUrl, quote: c.quote, vote: c.valid - c.refutedVotes + '-' + c.refutedVotes })),
    refuted: killed.map((c) => ({ claim: c.claim, vote: c.valid - c.refutedVotes + '-' + c.refutedVotes, source: c.sourceUrl })),
    sources,
    stats: { angles: angles.length, claims: allClaims.length, verified: voted.length, confirmed: confirmed.length, killed: killed.length },
  }
}

return {
  question: QUESTION,
  ...report,
  refuted: killed.map((c) => ({ claim: c.claim, vote: c.valid - c.refutedVotes + '-' + c.refutedVotes, source: c.sourceUrl })),
  sources,
  stats: {
    angles: angles.length,
    claimsExtracted: allClaims.length,
    claimsVerified: voted.length,
    confirmed: confirmed.length,
    killed: killed.length,
    afterSynthesis: report.findings.length,
    verifiersReturned: validVerifiers.length,
    // Bounded agent count: scope + explorers + verifier pool + synth. No per-claim fan-out.
    agentCalls: 1 + angles.length + VERIFIER_LENSES.length + 1,
  },
}
