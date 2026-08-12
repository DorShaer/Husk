'use strict';

// Shared renderer for portable-workflow receipts, install evidence, trust
// chips, local cost estimates and first-run consent.
//
// Invariants: every figure carries a provenance tier; contradicted evidence is
// refused rather than downgraded; manifest strings go through WfxDom.el();
// "verified" is intentionally not used for unsigned receipt chains.

(function () {
  const WfxDom = (typeof window !== 'undefined' && window.WfxDom) || null;
  if (!WfxDom) {
    if (typeof console !== 'undefined') {
      console.error('wfx-artifact-ui: wfx-dom.js must load first; no workflow artifact surface will render');
    }
    return;
  }

  const el = WfxDom.el;
  const text = WfxDom.text;
  const frag = WfxDom.frag;

  function doc() {
    return (typeof document !== 'undefined') ? document : null;
  }

  // ─── Vocabulary ────────────────────────────────────────────────────────────

  // Data-driven tiers keep the chip text and styling coupled.
  const TIER = Object.freeze({
    computed: Object.freeze({ tier: 'computed', cls: 'is-computed', word: 'computed here' }),
    consistent: Object.freeze({ tier: 'consistent', cls: 'is-consistent', word: 'matches the shipped log' }),
    said: Object.freeze({ tier: 'said', cls: 'is-said', word: 'author states' }),
  });

  // Reader-facing meaning of each passContext enum.
  const PASS_CONTEXT_COPY = Object.freeze({
    full: 'carries the whole transcript',
    last50: 'carries the last 50 lines',
    none: 'carries nothing forward',
  });

  // Token a prompt uses to interpolate the previous step's output.
  const PREVIOUS_OUTPUT_TOKEN = '{{previousOutput}}';

  // Price tokens locally; zero-rate CLIs render as unpriceable, not free.
  const RATES = Object.freeze({
    'claude-fable-5': Object.freeze({ in: 10, out: 50 }),
    'claude-opus-4-8': Object.freeze({ in: 5, out: 25 }),
    'claude-opus-4-7': Object.freeze({ in: 5, out: 25 }),
    'claude-opus-4-6': Object.freeze({ in: 5, out: 25 }),
    'claude-sonnet-5': Object.freeze({ in: 3, out: 15 }),
    'claude-sonnet-4-7': Object.freeze({ in: 3, out: 15 }),
    'claude-sonnet-4-6': Object.freeze({ in: 3, out: 15 }),
    'claude-haiku-4-5': Object.freeze({ in: 1, out: 5 }),
    copilot: Object.freeze({ in: 0, out: 0 }),
    codex: Object.freeze({ in: 0, out: 0 }),
    aider: Object.freeze({ in: 0, out: 0 }),
    gemini: Object.freeze({ in: 0, out: 0 }),
    'kiro-cli': Object.freeze({ in: 0, out: 0 }),
  });

  // Keep token-cache pricing aligned with autonomy/budget.js.
  const CACHE_CREATE_MULT = 1.25;
  const CACHE_READ_MULT = 0.1;

  // Fixed SVG path data; manifest data never reaches these shapes.
  const ICONS = Object.freeze({
    ok: Object.freeze(['M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0', 'M8 12.2l2.8 2.8L16 9.8']),
    caution: Object.freeze(['M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z', 'M12 9v4M12 17h.01']),
    block: Object.freeze(['M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0', 'M15 9l-6 6M9 9l6 6']),
    chevron: Object.freeze(['M9 6l6 6-6 6']),
  });

  const STATUS_CLASS = Object.freeze({ ok: 'is-ok', caution: 'is-caution', block: 'is-block' });
  const STATUS_ICON = Object.freeze({ ok: 'ok', caution: 'caution', block: 'block' });

  // Show blockers before cautions before passes.
  const SEVERITY_RANK = Object.freeze({ block: 0, caution: 1, ok: 2 });

  // Single identifiers can be highlighted as code inside preflight titles.
  const CODE_NAME_RE = /^[A-Za-z0-9._/-]{1,64}$/;

  // ─── Small DOM helpers ─────────────────────────────────────────────────────

  // SVG is built manually from fixed path data; unknown names render no icon.
  function icon(name) {
    const paths = ICONS[name];
    const d = doc();
    if (!paths || !d) return null;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = d.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    for (const spec of paths) {
      const path = d.createElementNS(NS, 'path');
      path.setAttribute('d', spec);
      svg.appendChild(path);
    }
    return svg;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  // Take the shell's own controls out of a pane before it is emptied, so they
  // can be put back into the rebuilt tree rather than recreated. That keeps
  // their ids and the listeners the install sheet bound at startup.
  //
  // `up` names a wrapper to lift instead of the control itself. A control
  // detached on its own has a null parentNode, so a later closest() call walks
  // out of a tree that has been taken apart: the consent gate's checkbox needs
  // its own <label> for the `for` relationship and its .wfx-ack plate for the
  // decision treatment, and both are ancestors.
  function harvest(host, specs) {
    const found = new Map();
    if (!host || !host.querySelector) return found;
    for (const spec of specs) {
      const id = typeof spec === 'string' ? spec : spec.id;
      const up = (typeof spec === 'object' && spec) ? spec.up : null;
      // Scoped to the host rather than to the document, so a copy of the same
      // id elsewhere on the page stays with the surface that owns it.
      const node = host.querySelector(`[id="${id}"]`);
      if (!node) continue;
      const lift = (up && node.closest) ? (node.closest(up) || node) : node;
      if (lift.parentNode) lift.parentNode.removeChild(lift);
      found.set(id, { control: node, node: lift });
    }
    return found;
  }

  function harvested(map, id) {
    const entry = map.get(id);
    return entry ? entry.node : null;
  }

  function harvestedControl(map, id) {
    const entry = map.get(id);
    return entry ? entry.control : null;
  }

  // A name set on one line, whatever the file put in it.
  //
  // el() leaves the three whitespace controls alone, because a prompt renders
  // in a <pre> where its own newlines and tabs are the shape of the text. A
  // step name is set in a <span> instead, so the controls are replaced with
  // U+FFFD here and the name stays one line. wfx-install.js holds the same two
  // lines; the two files share no scope.
  const NAME_CONTROL_RE = /[\u0000-\u001F\u007F]/g;
  const oneLine = (value) => (typeof value === 'string' ? value.replace(NAME_CONTROL_RE, '\uFFFD') : '');

  // A sentence in a title or a note, with one identifier lifted into a code
  // chip. Every piece is a text node and the split is indexOf on a literal.
  function sentenceWithCode(sentence, name) {
    const s = typeof sentence === 'string' ? sentence : '';
    if (!s) return frag();
    if (typeof name !== 'string' || !CODE_NAME_RE.test(name)) return frag(s);
    const at = s.indexOf(name);
    if (at < 0) return frag(s);
    return frag(
      s.slice(0, at),
      el('code', null, name),
      s.slice(at + name.length),
    );
  }

  // ─── Ordering ──────────────────────────────────────────────────────────────

  // A mirror of graphToOrderedSteps in src/lib/workflow-graph.js, which the
  // renderer cannot require: main is CommonJS behind contextIsolation and this
  // is a classic script. The consent gate is bound to this order, so it is a
  // full breadth-first walk rather than app.js's linear wfGraphOrder.
  //
  // Roots are seeded in wiring order and only then in node order, matching the
  // main-process copy, so two files describing one workflow whose node arrays
  // serialised differently still read in one order under one fingerprint.
  function orderedSteps(graph) {
    const g = (graph && typeof graph === 'object') ? graph : null;
    const nodes = (g && Array.isArray(g.nodes)) ? g.nodes.filter((n) => n && typeof n === 'object') : [];
    const edges = (g && Array.isArray(g.edges)) ? g.edges.filter((e) => e && typeof e === 'object') : [];
    if (!nodes.length) return [];

    const byId = new Map();
    for (const n of nodes) if (!byId.has(n.id)) byId.set(n.id, n);
    const hasIncoming = new Set(edges.map((e) => e.to));
    const out = new Map();
    for (const e of edges) {
      if (!out.has(e.from)) out.set(e.from, []);
      out.get(e.from).push(e.to);
    }

    const rooted = new Set();
    const queue = [];
    const seedRoot = (id) => {
      if (rooted.has(id) || hasIncoming.has(id) || !byId.has(id)) return;
      rooted.add(id);
      queue.push(id);
    };
    for (const e of edges) seedRoot(e.from);
    for (const n of nodes) seedRoot(n.id);
    // A graph that is one pure cycle has no root at all. Seeding the first node
    // keeps the walk terminating while still emitting every step.
    if (!queue.length) queue.push(nodes[0].id);

    const order = [];
    const seen = new Set();
    while (queue.length) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      const node = byId.get(id);
      if (!node) continue;
      seen.add(id);
      order.push(node);
      for (const to of (out.get(id) || [])) {
        if (!seen.has(to)) queue.push(to);
      }
    }
    for (const n of nodes) {
      if (!seen.has(n.id)) { seen.add(n.id); order.push(n); }
    }
    return order;
  }

  // ─── Records ───────────────────────────────────────────────────────────────

  // Everything the figure component draws arrives as one of these, so the strip
  // and the panel cannot disagree about what a receipt says. The two builders
  // below are the only places a tier is decided.
  //
  //   runs            integer >= 0
  //   precision       'none' | 'single' | 'range' | 'median'
  //   durationMs      integer | null
  //   durationRange   { min, max } | null   only ever from a local aggregate
  //   durationCensored integer
  //   completed       integer
  //   runsWindowed    boolean
  //   tokens          { input, output, cacheRead, cacheCreate } | null
  //   model           string | null
  //   agent           string | null
  //   evidence        'none' | 'inline' | 'local'
  //   tier            one of TIER
  //   refused         null | { title, message, detail }

  function precisionFor(n) {
    if (!(n > 0)) return 'none';
    if (n === 1) return 'single';
    if (n === 2) return 'range';
    return 'median';
  }

  function intOr(value, fallback) {
    return (typeof value === 'number' && Number.isFinite(value)) ? Math.trunc(value) : fallback;
  }

  // A published receipt. The tier starts at "author states" and stays there
  // until something re-hashes the chain and hands the result in.
  //
  // chainCheck, when supplied, is { checked, valid, agrees, detail }. `agrees`
  // is the caller's answer to whether the figures recomputed from those rows
  // equal the ones written beside them.
  function recordFromReceipt(receipt, chainCheck) {
    const r = (receipt && typeof receipt === 'object') ? receipt : null;
    if (!r) return null;

    const runs = intOr(r.runs, 0);
    const outcomes = (r.outcomes && typeof r.outcomes === 'object') ? r.outcomes : {};
    const check = (chainCheck && typeof chainCheck === 'object') ? chainCheck : null;

    let tier = TIER.said;
    let refused = null;
    if (check && check.checked === true) {
      if (check.valid !== true) {
        refused = {
          title: 'The shipped log does not check out',
          message: 'This file attaches an audit log for its numbers and the log does not hold together on this machine. The figures are removed rather than annotated: a receipt contradicted by its own evidence is worse than no receipt, because it is the one somebody believes. The graph itself is unaffected and remains installable.',
          detail: typeof check.detail === 'string' ? check.detail : null,
        };
      } else if (check.agrees !== true) {
        refused = {
          title: 'The log does not support the numbers beside it',
          message: 'The audit rows in this file hash together, and the figures recomputed from them are not the figures declared next to them. That is the failure a valid chain hides, so it is treated as the harder one: the record collapses instead of dropping a tier.',
          detail: typeof check.detail === 'string' ? check.detail : null,
        };
      } else if (r.evidence === 'inline') {
        tier = TIER.consistent;
      }
    }

    return {
      runs,
      precision: precisionFor(runs),
      durationMs: intOr(r.medianDurationMs, null),
      durationRange: null,
      durationCensored: intOr(r.durationCensored, 0),
      completed: intOr(outcomes.completed, 0),
      runsWindowed: r.runsWindowed === true,
      tokens: (r.medianTokens && typeof r.medianTokens === 'object') ? r.medianTokens : null,
      model: (r.environment && typeof r.environment.modelResolved === 'string') ? r.environment.modelResolved : null,
      agent: (r.environment && typeof r.environment.agentResolved === 'string') ? r.environment.agentResolved : null,
      evidence: r.evidence === 'inline' ? 'inline' : 'none',
      tier,
      refused,
    };
  }

  // Local run history, aggregated by src/lib/workflow-receipt.js. These runs
  // happened here, on this machine, under this Husk, so the tier is the top one
  // and it is the only place in the feature that earns it for a run figure.
  //
  // The aggregate is the only source that can offer a real range, because the
  // wire format deliberately carries no distribution: aggregateRuns keeps
  // durationRangeMs off the published receipt and hands it to a caller instead.
  // That is why two runs read as a range on a locally authored workflow and as
  // a midpoint on an imported one; see durationFigure.
  function recordFromAggregate(aggregate) {
    const a = (aggregate && typeof aggregate === 'object') ? aggregate : null;
    if (!a) return null;
    const outcomes = (a.outcomes && typeof a.outcomes === 'object') ? a.outcomes : {};
    const range = (a.durationRangeMs && typeof a.durationRangeMs === 'object') ? a.durationRangeMs : null;
    // The aggregate reports the sample that produced the duration separately
    // from the run count, because a run with no usable duration still votes in
    // the outcome tally. The precision word describes the duration, so it is
    // taken from the smaller of the two.
    const durationN = intOr(a.medianDurationN, 0);
    return {
      runs: intOr(a.runs, 0),
      precision: typeof a.precision === 'string' ? a.precision : precisionFor(durationN),
      durationMs: intOr(a.medianDurationMs, null),
      durationRange: (range && Number.isFinite(range.min) && Number.isFinite(range.max))
        ? { min: Math.trunc(range.min), max: Math.trunc(range.max) }
        : null,
      durationCensored: intOr(a.durationCensored, 0),
      completed: intOr(outcomes.completed, 0),
      runsWindowed: a.runsWindowed === true,
      tokens: (a.medianTokens && typeof a.medianTokens === 'object') ? a.medianTokens : null,
      model: null,
      agent: null,
      evidence: 'local',
      tier: TIER.computed,
      refused: null,
    };
  }

  // Which of the two records a surface shows when it holds both: a receipt that
  // travelled in a file, and an aggregate of runs that happened on this
  // machine. Local history wins, because it is the only thing here the reader
  // measured themselves, and it carries the top tier for that reason.
  //
  // The one exception is a shipped receipt its own log contradicts. That is a
  // fact about the file and the reader is told it.
  function pickRecord(receipt, chainCheck, aggregate) {
    const shipped = receipt ? recordFromReceipt(receipt, chainCheck) : null;
    if (shipped && shipped.refused) return shipped;
    const local = recordFromAggregate(aggregate);
    if (local && local.runs > 0) return local;
    return shipped || local;
  }

  // Which of up to eight receipts the surfaces summarise. They are one per
  // environment, and there is no honest way to add two medians together, so the
  // largest sample is shown and the rest are counted in the chip's accessible
  // name rather than averaged into a number that describes nothing.
  function pickReceipt(artifact) {
    const list = (artifact && Array.isArray(artifact.receipts)) ? artifact.receipts : [];
    let best = null;
    for (const r of list) {
      if (!r || typeof r !== 'object') continue;
      if (!best || intOr(r.runs, 0) > intOr(best.runs, 0)) best = r;
    }
    return best;
  }

  // ─── Formatting ────────────────────────────────────────────────────────────

  // Returns [head, unit] because the figure component sets the unit a rank
  // down: a unit is grammar, not measurement, and at the value's own weight the
  // "s" in "4m 48s" reads as another digit.
  function durationParts(ms) {
    const total = (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) ? ms : 0;
    const seconds = Math.round(total / 1000);
    if (seconds < 60) return [String(seconds), 's'];
    if (seconds < 3600) {
      const m = Math.floor(seconds / 60);
      return [`${m}m ${String(seconds % 60).padStart(2, '0')}`, 's'];
    }
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return [`${h}h ${String(m).padStart(2, '0')}`, 'm'];
  }

  function formatDuration(ms) {
    const [head, unit] = durationParts(ms);
    return `${head}${unit}`;
  }

  // The decimals fall with the sample. This is the one extrapolated figure on
  // the surface, and two cents of precision drawn from a single observation is
  // a claim about a distribution the sample cannot describe.
  //
  // Nothing ever renders as $0.00. A run that cost a third of a cent cost
  // something.
  function formatDollars(usd, sampleN) {
    if (!(typeof usd === 'number') || !Number.isFinite(usd) || usd < 0) return null;
    const n = intOr(sampleN, 0);
    if (usd > 0 && usd < 0.01) return 'under $0.01';
    if (n >= 3) return `$${usd.toFixed(2)}`;
    if (n === 2) return `$${usd.toFixed(1)}`;
    // One observation supports one significant digit and no more.
    if (usd >= 1) return `$${String(Math.round(usd))}`;
    return `$${usd.toFixed(1)}`;
  }

  // The same resolution ladder budget.js uses, minus its fallback to a default
  // rate. A meter would rather over-price an unknown model than let it run
  // unbounded; here an unknown model has no rate and the tile says so.
  function resolveRate(modelId) {
    const id = String(modelId || '').trim().toLowerCase();
    if (!id) return null;
    if (RATES[id]) return RATES[id];
    const undated = id.replace(/-\d{8}$/, '');
    if (RATES[undated]) return RATES[undated];
    let best = null;
    for (const key of Object.keys(RATES)) {
      const fam = key.replace(/^claude-/, '');
      if (id.includes(key) || id.includes(fam)) {
        if (!best || fam.length > best.fam.length) best = { key, fam };
      }
    }
    if (best) return RATES[best.key];
    // The bare tier aliases the CLI itself accepts as --model values. They are
    // matched last so a dated or fully qualified id never lands here.
    if (/\bopus\b/.test(id)) return RATES['claude-opus-4-8'];
    if (/\bsonnet\b/.test(id)) return RATES['claude-sonnet-5'];
    if (/\bhaiku\b/.test(id)) return RATES['claude-haiku-4-5'];
    if (/\bfable\b/.test(id)) return RATES['claude-fable-5'];
    return null;
  }

  // Returns { usd, sampleN } or { usd: null, why } where `why` is the sentence
  // the null tile carries. Four reasons a price cannot be given, kept distinct
  // because they are facts about different things.
  function estimateDollars(opts) {
    const o = opts || {};
    const billing = (o.billing && typeof o.billing === 'object') ? o.billing : null;
    if (!billing || billing.metered !== true) {
      return { usd: null, why: 'no per-token bill', note: 'you are on a plan rather than an API key, so these tokens are not billed one by one and there is no figure here that would mean anything' };
    }
    const tokens = (o.tokens && typeof o.tokens === 'object') ? o.tokens : null;
    if (!tokens) {
      return { usd: null, why: 'no token counts', note: 'this record carries no token usage, which is what a run by a CLI that does not report usage looks like' };
    }
    const rate = resolveRate(o.model) || resolveRate(o.agent);
    if (!rate) {
      return { usd: null, why: 'no rate for that model', note: 'this build has no price for the model these runs used, and pricing it at some other model\'s rates would be inventing the figure rather than estimating it' };
    }
    if (!(rate.in > 0) && !(rate.out > 0)) {
      return { usd: null, why: 'not priceable here', note: 'billing for this agent depends on the account rather than on the CLI, and Husk cannot see which account paid, so any figure here would be a guess wearing two decimal places' };
    }
    const input = Math.max(0, intOr(tokens.input, 0));
    const output = Math.max(0, intOr(tokens.output, 0));
    const cacheRead = Math.max(0, intOr(tokens.cacheRead, 0));
    const cacheCreate = Math.max(0, intOr(tokens.cacheCreate, 0));
    const usd = (input / 1e6) * rate.in
      + (output / 1e6) * rate.out
      + (cacheCreate / 1e6) * (rate.in * CACHE_CREATE_MULT)
      + (cacheRead / 1e6) * (rate.in * CACHE_READ_MULT);
    return { usd, why: null, note: null };
  }

  // ─── The trust chip ────────────────────────────────────────────────────────

  // `as` is 'span' on a panel and 'button' on a card, where the chip is also
  // the control that opens the record. Both take the same three classes, so the
  // tier's word, ink and mark shape travel together whatever the element is.
  function renderClaim(opts) {
    const o = opts || {};
    const tier = (o.tier && o.tier.cls) ? o.tier : TIER.said;
    const tag = o.as === 'button' ? 'button' : 'span';
    const attrs = { class: ['wfx-claim', tier.cls] };
    if (tag === 'button') {
      attrs.type = 'button';
      if (o.dataset) attrs.dataset = o.dataset;
      if (typeof o.label === 'string' && o.label) attrs.aria = { label: o.label };
    }
    return el(tag, attrs,
      el('i', { class: 'wfx-claim-m', aria: { hidden: true } }),
      tier.word);
  }

  // Every chip on a sheet is wrapped. .wfx-claim is inline-flex, and a bare
  // flex item stretches on the cross axis into a full width band.
  function wrapClaim(node) {
    return el('span', null, node);
  }

  // ─── Figures ───────────────────────────────────────────────────────────────

  // One tile. `value` is an array of nodes and strings so a unit or a qualifier
  // can ride inside the value slot, which is where the grid reserves a line for
  // them.
  function figure(opts) {
    const o = opts || {};
    const classes = ['wfx-fig'];
    if (o.isNull) classes.push('is-null');
    if (o.isThin) classes.push('is-thin');
    const children = [
      el('span', { class: 'wfx-fig-v' }, o.value || []),
      el('span', { class: 'wfx-fig-l' }, o.label || ''),
    ];
    // The screen reader form of the qualifier, for the card, where there is no
    // room for the visible one. At panel density the caller puts the qualifier
    // in the value instead and this stays empty.
    if (o.srNote) children.push(el('span', { class: 'wfx-sr' }, o.srNote));
    // At panel density the chip is the tile's last child. At card density the
    // tier is carried once for the whole group by renderFigures instead of
    // once per tile, so neither density renders a number without provenance.
    if (o.chip !== false) children.push(wrapClaim(renderClaim({ tier: o.tier })));
    return el('span', { class: classes }, children);
  }

  function unit(s) {
    return el('span', { class: 'wfx-fig-u' }, s);
  }

  function qualifier(s) {
    return el('span', { class: 'wfx-fig-q' }, s);
  }

  // The sample, named. "that one run" rather than "n=1", because the tile is
  // read by somebody deciding whether to run a stranger's code.
  //
  // The phrase and its preposition are separate because the two callers need
  // two prepositions, and both notes are spoken rather than shown.
  function runsPhrase(runs) {
    return runs === 1 ? 'that one run' : `${runs} runs`;
  }

  function sampleNote(runs) {
    return `of ${runsPhrase(runs)}`;
  }

  // The note a screen reader gets in place of the visible qualifier, which the
  // card has no room for.
  function thinNote(runs) {
    return `from ${runsPhrase(runs)}, too few to rate`;
  }

  // The duration tile. Three runs and up is a median and is called one. Two
  // runs is a range when the source can produce both ends, which only a local
  // aggregate can, because the wire format ships no distribution. Two runs
  // from a published receipt is a midpoint and is called that. One run is that
  // run.
  function durationFigure(record, density) {
    const inline = density === 'inline';
    const chip = !inline;
    const thin = record.runs > 0 && record.runs <= 2;
    if (record.durationMs === null && !record.durationRange) {
      return figure({
        isNull: true,
        chip,
        value: ['no duration'],
        label: inline ? 'median' : 'median run',
        tier: record.tier,
      });
    }

    if (record.precision === 'range' && record.durationRange) {
      const [minHead, minUnit] = durationParts(record.durationRange.min);
      const [maxHead, maxUnit] = durationParts(record.durationRange.max);
      const value = [minHead, unit(minUnit), ' – ', maxHead, unit(maxUnit)];
      if (!inline) value.push(qualifier(sampleNote(record.runs)));
      return figure({
        isThin: true,
        chip,
        value,
        label: 'range',
        srNote: inline ? thinNote(record.runs) : '',
        tier: record.tier,
      });
    }

    const [head, tail] = durationParts(record.durationMs);
    const value = [head, unit(tail)];
    let label;
    if (record.precision === 'single') label = 'that run';
    else if (record.precision === 'range') label = 'midpoint';
    else label = inline ? 'median' : 'median run';
    if (thin && !inline) value.push(qualifier(sampleNote(record.runs)));
    return figure({
      isThin: thin,
      chip,
      value,
      label,
      srNote: (thin && inline) ? thinNote(record.runs) : '',
      tier: record.tier,
    });
  }

  // Counts and a denominator, never a percentage, and never the word "pass".
  // A step's status is its process exit code, so the tile says "zero exit" and
  // the sentence under the panel says what that means.
  function outcomeFigure(record, density) {
    const inline = density === 'inline';
    const thin = record.runs > 0 && record.runs <= 2;
    const value = [String(record.completed), unit(`/${record.runs}`)];
    if (thin && !inline) value.push(qualifier(sampleNote(record.runs)));
    return figure({
      isThin: thin,
      chip: !inline,
      value,
      label: 'zero exit',
      srNote: (thin && inline) ? thinNote(record.runs) : '',
      tier: record.tier,
    });
  }

  // The one tile on the surface whose tier is always "computed here", because
  // this machine did the arithmetic, at its own rates, from token counts that
  // are the only quantity that survives the trip from a stranger's disk.
  function dollarFigure(record, billing) {
    const est = estimateDollars({ tokens: record.tokens, model: record.model, agent: record.agent, billing });
    if (est.usd === null) {
      return figure({
        isNull: true,
        value: [est.why],
        label: 'your estimate',
        tier: TIER.computed,
      });
    }
    const shown = formatDollars(est.usd, record.runs);
    if (shown === null) {
      return figure({ isNull: true, value: ['not priceable here'], label: 'your estimate', tier: TIER.computed });
    }
    // "under $0.01" is already a sentence about imprecision, so it does not
    // take the approximation mark as well.
    const display = shown.charAt(0) === '$' ? `≈${shown}` : shown;
    return figure({
      value: [display, ' ', qualifier('at your rates')],
      label: 'your estimate',
      tier: TIER.computed,
    });
  }

  // density 'panel' emits four tiles, each carrying its own chip. density
  // 'inline' emits three and returns a fragment: the tiles group followed by
  // one chip for all of them, which is the shape .wfx-rcp expects and the shape
  // the card templates in index.html declare. The dollar tile is absent from
  // the card, where there is no room for the "at your rates" qualifier that
  // has to travel with it.
  function renderFigures(record, opts) {
    const o = opts || {};
    const panel = o.density !== 'inline';
    const density = panel ? 'panel' : 'inline';
    const tiles = [
      figure({
        chip: panel,
        value: [String(record.runs)],
        label: 'runs',
        tier: record.tier,
      }),
      durationFigure(record, density),
      outcomeFigure(record, density),
    ];
    if (panel) {
      tiles.push(dollarFigure(record, o.billing || null));
      return el('div', { class: 'wfx-figs' }, tiles);
    }
    return frag(
      el('div', { class: ['wfx-figs', 'is-inline'] }, tiles),
      // A button only when pressing it opens something. A workflow whose runs
      // all happened here has no imported record behind the chip, so the tier
      // word renders as a label instead of a control.
      renderClaim({
        tier: record.tier,
        as: o.chipAs === 'span' ? 'span' : 'button',
        dataset: o.chipDataset || null,
        label: o.chipLabel,
      }));
  }

  // ─── Prompts ───────────────────────────────────────────────────────────────

  // Wrap every occurrence of the interpolation token in a <mark>, by surgery on
  // the text node el() already wrote and scrubbed. No text is created here: the
  // existing node is split at the token's boundaries and the middle piece is
  // moved inside the mark, so the characters on screen are the exact characters
  // el() put there.
  function markToken(pre, token) {
    const d = doc();
    if (!pre || !d || !token) return;
    let node = pre.firstChild;
    while (node) {
      const next = node.nextSibling;
      if (node.nodeType === 3 && typeof node.data === 'string') {
        let cursor = node;
        let at = cursor.data.indexOf(token);
        while (at >= 0) {
          // splitText leaves `cursor` holding everything before the match and
          // returns the remainder, so `hit` starts exactly at the token.
          const hit = cursor.splitText(at);
          const rest = hit.splitText(token.length);
          const mark = d.createElement('mark');
          hit.parentNode.replaceChild(mark, hit);
          mark.appendChild(hit);
          cursor = rest;
          at = cursor.data.indexOf(token);
        }
      }
      node = next;
    }
  }

  function stepSummary(node, index) {
    const model = (typeof node.model === 'string' && node.model) ? node.model : null;
    const agent = (typeof node.agentCommand === 'string' && node.agentCommand) ? node.agentCommand : '';
    // The trailing separator belongs to the meta run rather than sitting
    // between the two spans, because a middot in the mono face has a different
    // advance either side of it.
    const meta = model ? `${agent} · ${model} ·` : `${agent} ·`;
    const pass = PASS_CONTEXT_COPY[node.passContext] || PASS_CONTEXT_COPY.none;
    return el('summary', null,
      el('span', { class: 'wfx-step-n' }, String(index + 1).padStart(2, '0')),
      el('span', { class: 'wfx-step-b' },
        el('span', { class: 'wfx-step-name' }, oneLine(node.name)),
        el('span', { class: 'wfx-step-sub' },
          el('span', { class: 'wfx-step-meta' }, meta),
          ' ',
          el('span', { class: 'wfx-step-pc' }, pass))),
      icon('chevron') || el('span', { class: 'wfx-step-c' }));
  }

  // The prompt list, one disclosure per step.
  //
  // Native <details> rather than a hand-rolled disclosure, so Enter and Space
  // toggling and the correct announcement come for free on a page that
  // repaints aggressively. tabindex on the <pre> because a scrollable pre is
  // not keyboard scrollable in Chromium without one, and a prompt is the one
  // block on this surface that has to be read to the end.
  function renderSteps(graph, opts) {
    const o = opts || {};
    const steps = orderedSteps(graph);
    const rows = steps.map((node, i) => {
      const prompt = typeof node.prompt === 'string' ? node.prompt : '';
      const pre = el('pre', { class: 'wfx-prompt', tabindex: 0 }, prompt);
      markToken(pre, PREVIOUS_OUTPUT_TOKEN);
      return el('details', { class: 'wfx-step', open: o.open === true },
        stepSummary(node, i),
        pre);
    });
    return el('div', { class: 'wfx-steps' }, rows);
  }

  // ─── Preflight ─────────────────────────────────────────────────────────────

  function preflightRow(check, onFix) {
    const status = STATUS_CLASS[check.status] ? check.status : 'caution';
    const children = [
      el('span', { class: 'wfx-pf-i' }, icon(STATUS_ICON[status]) || []),
      el('span', { class: 'wfx-pf-n' }, sentenceWithCode(check.title, check.name)),
    ];
    if (typeof check.note === 'string' && check.note) {
      children.push(el('span', { class: 'wfx-pf-note' }, sentenceWithCode(check.note, check.name)));
    }

    // The fingerprint pair, rendered whole rather than as a prefix, because
    // this is the row where a person compares the two strings themselves.
    const detail = (check.detail && typeof check.detail === 'object') ? check.detail : null;
    if (detail && typeof detail.declared === 'string' && typeof detail.local === 'string') {
      // .wfx-pf-note puts the disclosure in the row's second grid column rather
      // than the icon gutter. .wfx-pf-fix on the summary, which is not a grid
      // item, takes only the control treatment the row's other action has.
      children.push(el('details', { class: 'wfx-pf-note' },
        el('summary', { class: 'wfx-pf-fix' }, 'Show both fingerprints'),
        el('dl', { class: 'wfx-refuse-e' },
          el('dt', null, 'the author\'s'),
          el('dd', null, detail.declared),
          el('dt', null, 'yours'),
          el('dd', null, detail.local))));
    }

    const fix = (check.fix && typeof check.fix === 'object') ? check.fix : null;
    if (fix && typeof fix.label === 'string' && fix.label) {
      const button = el('button', { type: 'button', class: ['ghost-link', 'wfx-pf-fix'] }, fix.label);
      if (typeof onFix === 'function') {
        button.addEventListener('click', () => { onFix(fix, check); });
      }
      children.push(button);
    }

    return el('div', { class: ['wfx-pf-row', STATUS_CLASS[status]] }, children);
  }

  // The rows arrive from the main process in the order the artifact declares
  // them and are drawn in severity order, stably, so the reading order within
  // a severity is still the declaration order. See SEVERITY_RANK.
  function renderPreflight(result, opts) {
    const o = opts || {};
    const checks = (result && Array.isArray(result.checks)) ? result.checks.filter((c) => c && typeof c === 'object') : [];
    const sorted = checks
      .map((c, i) => ({ c, i }))
      .sort((a, b) => {
        const ra = SEVERITY_RANK[a.c.status];
        const rb = SEVERITY_RANK[b.c.status];
        const sa = (ra === undefined) ? 1 : ra;
        const sb = (rb === undefined) ? 1 : rb;
        return sa === sb ? a.i - b.i : sa - sb;
      })
      .map((x) => x.c);
    return el('div', { class: 'wfx-pf' },
      el('div', { class: 'wfx-pf-h' }, o.heading || 'Against this machine'),
      sorted.map((c) => preflightRow(c, o.onFix)));
  }

  // ─── Path row ──────────────────────────────────────────────────────────────

  // Two spans, not one string. A single element with direction:rtl resolves
  // LTR on any path beginning with a Latin character, so the ellipsis lands on
  // the filename. The directory truncates and the filename never does, which
  // is why the split happens here rather than in CSS.
  function renderPath(absolutePath) {
    const p = typeof absolutePath === 'string' ? absolutePath : '';
    const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    const dir = cut >= 0 ? p.slice(0, cut + 1) : '';
    const file = cut >= 0 ? p.slice(cut + 1) : p;
    return el('span', { class: 'wfx-path' },
      el('span', { class: 'wfx-path-dir' }, dir),
      el('span', { class: 'wfx-path-file' }, file));
  }

  // ─── Refusal ───────────────────────────────────────────────────────────────

  // detail is the verifier's own words and gets its own monospace slot. An
  // explanation a person can act on and a hash a machine produced are two
  // registers, and mixing them makes both unreadable.
  function renderRefusal(refusal) {
    const r = refusal || {};
    const rows = [];
    const detail = r.detail;
    if (detail && typeof detail === 'object') {
      for (const key of Object.keys(detail)) {
        const value = detail[key];
        if (typeof value !== 'string' && typeof value !== 'number') continue;
        rows.push(el('dt', null, key), el('dd', null, String(value)));
      }
    } else if (typeof detail === 'string' && detail) {
      rows.push(el('dt', null, 'detail'), el('dd', null, detail));
    }
    return el('div', { class: 'wfx-refuse' },
      el('span', { class: 'wfx-refuse-i' }, icon('block') || []),
      el('p', { class: 'wfx-refuse-t' }, r.title || 'This file cannot be read'),
      el('p', { class: 'wfx-refuse-m' }, r.message || ''),
      rows.length ? el('dl', { class: 'wfx-refuse-e' }, rows) : []);
  }

  // ─── Surface 4: the card receipts strip ────────────────────────────────────

  // The chip's accessible name, which is the whole of what a keyboard user gets
  // from this control: the workflow, the sample, the tier, and that a press
  // opens something. The figures beside it are sibling spans and are not part
  // of the button.
  function stripLabel(name, record, otherRecords) {
    const who = (typeof name === 'string' && name) ? name : 'this workflow';
    const runs = record.runs === 1 ? '1 run' : `${record.runs} runs`;
    const more = otherRecords > 0
      ? `, 1 of ${otherRecords + 1} records`
      : '';
    return `Receipts for ${who}: ${runs}${more}, ${record.tier.word}. Open the record.`;
  }

  function emptyStrip() {
    return el('div', { class: ['wfx-rcp', 'is-none'] },
      el('span', null, 'No receipts yet · run it to earn one'));
  }

  // Returns a node for every input, including no input at all, so app.js can
  // append unconditionally and every card carries the same block in the same
  // place.
  //
  // `aggregate` is the shape src/lib/workflow-receipt.js returns, for a
  // workflow whose runs happened here. It arrives over workflows:receipts,
  // aggregated in the main process, so a median has one implementation.
  function renderReceiptStrip(opts) {
    try {
      const o = opts || {};
      const artifact = (o.artifact && typeof o.artifact === 'object') ? o.artifact : null;
      const receipt = artifact ? pickReceipt(artifact) : null;
      const record = pickRecord(receipt, o.chainCheck, o.aggregate);

      if (!record || record.runs <= 0) return emptyStrip();
      if (record.refused) {
        // The strip has no room for a refusal block, and it must not show the
        // figures. It says what happened and hands the reader to the record.
        return el('div', { class: ['wfx-rcp', 'is-none'] },
          el('span', null, 'Receipts withheld · the shipped log contradicts them'));
      }

      const others = artifact && Array.isArray(artifact.receipts) ? Math.max(0, artifact.receipts.length - 1) : 0;
      // The caller withholds onOpen for a workflow with no record behind it,
      // which is every workflow written here rather than imported. There is
      // nothing to open, so the chip is the tier word and not a control.
      const openable = typeof o.onOpen === 'function';
      const strip = el('div', { class: 'wfx-rcp' }, renderFigures(record, {
        density: 'inline',
        chipAs: openable ? 'button' : 'span',
        chipDataset: (openable && typeof o.workflowId === 'string' && o.workflowId) ? { wfxReceipt: o.workflowId } : null,
        chipLabel: openable ? stripLabel(o.workflowName, record, others) : null,
      }));
      const chip = strip.querySelector('.wfx-claim');
      if (chip && openable) {
        chip.addEventListener('click', (e) => {
          // The card itself is a click-only div with its own handler, so a
          // press on the chip has to stop there or it opens the builder behind
          // the record.
          e.stopPropagation();
          o.onOpen(o.workflowId, record);
        });
      }
      return strip;
    } catch (_) {
      // A card that cannot draw its strip still draws its card. This surface
      // renders dozens of times on one paint, so one artifact this builder
      // cannot draw leaves the rest of the grid standing.
      return emptyStrip();
    }
  }

  // ─── Surface 1: the evidence inspector ─────────────────────────────────────

  // Shell controls that live inside the ready pane. They are preserved across a
  // rebuild rather than recreated; see harvest().
  const INSTALL_HOST_CONTROLS = Object.freeze(['wfx-in-fp-copy', 'wfx-in-cwd-change']);

  function fingerprintBlock(artifact, copyButton) {
    return el('div', { class: ['ra-status', 'ra-status-info'] },
      el('div', { class: 'wfx-fp-h' },
        wrapClaim(renderClaim({ tier: TIER.computed })),
        copyButton || []),
      el('code', null, typeof artifact.graphHash === 'string' ? artifact.graphHash : ''),
      el('span', null, 'Recomputed from the bytes of this file, not read out of them. Every receipt below declares the same fingerprint.'));
  }

  function identityBlock(artifact) {
    const name = oneLine(artifact.name);
    const publisher = oneLine(artifact.publisher && artifact.publisher.name);
    const title = publisher ? `${name} · ${publisher}` : name;
    const children = [el('p', { class: 'wfx-note-t' }, title)];
    if (typeof artifact.description === 'string' && artifact.description) {
      children.push(el('p', { class: 'wfx-note-m' }, artifact.description));
    }
    return el('div', { class: 'wfx-note' }, children);
  }

  // The closing argument, and the reason the sheet exists. It is assembled from
  // the record rather than written once, because every clause in it is a fact
  // about this particular file: whether a log came with it, how many runs were
  // cut off at the per-step timeout, whether the history it was drawn from had
  // already been trimmed, and what "zero exit" is actually measuring.
  function worthSentence(record, billing) {
    if (!record) {
      return 'This file ships no run history at all, so there is nothing here to weigh. The graph and every prompt in it are above, recomputed from the file\'s own bytes. Installing writes a file and runs nothing.';
    }
    const parts = [];
    if (record.tier === TIER.said) {
      parts.push('This file ships no log that checks out here, so every figure above is the author\'s own account and nothing on this machine confirmed it.');
    } else if (record.tier === TIER.consistent) {
      parts.push('The log shipped with this file hashes together on this machine and the figures above were recomputed from it. That is consistency, not proof: the chain is anchored at a public constant with no signature, so it says the log is internally well formed and says nothing about whether the runs happened.');
    } else {
      parts.push('These runs happened on this machine, under this Husk, so the figures above were measured here rather than stated.');
    }
    parts.push('Exit code is all that "zero exit" means: a step that answered confidently wrong and exited zero is counted with the ones that worked.');
    if (record.durationCensored > 0) {
      parts.push(record.durationCensored === 1
        ? 'One run hit the five minute per-step limit and was killed there, so the duration above is cut off at the top.'
        : `${record.durationCensored} runs hit the five minute per-step limit and were killed there, so the duration above is cut off at the top.`);
    }
    if (record.runsWindowed) {
      parts.push('The history these came from had already been trimmed, so they describe what survived rather than everything that ran.');
    }
    if (billing && billing.metered === true) {
      parts.push('The dollar figure is our estimate at your rates and not a bill.');
    }
    parts.push('Installing writes a file. It does not run anything.');
    return parts.join(' ');
  }

  // Fills the install sheet's ready pane, in the order the static markup in
  // index.html lays out: fingerprint, identity, graph, figures, bound
  // directory, preflight, prompts, and the closing sentence. The fingerprint
  // leads because every number under it depends on it; the prompts come last
  // because they are the longest block.
  //
  // opts:
  //   host        the pane element, required (#wfx-in-ready)
  //   artifact    a validated artifact, required
  //   preflight   the workflows:preflight result, or null while it resolves
  //   cwd         the bound directory, or null
  //   billing     autopilot:billingMode output, or null
  //   aggregate   local run figures for this workflow, or null (see pickRecord)
  //   chainCheck  a caller's chain verification result, or null
  //   miniGraph   a node for the graph preview, or null (app.js owns wfMiniGraph)
  //   onFix       (fix, check) => void
  //
  // Returns { ok: true, record } or { ok: false, code }. A failure has already
  // rendered the refusal into the host, so the pane ends in a finished refusal
  // rather than a blank.
  function renderInspector(opts) {
    const o = opts || {};
    const host = o.host;
    if (!host || typeof host.appendChild !== 'function') return { ok: false, code: 'no-host' };

    const preserved = harvest(host, INSTALL_HOST_CONTROLS);
    clear(host);

    try {
      const artifact = (o.artifact && typeof o.artifact === 'object') ? o.artifact : null;
      if (!artifact) throw new Error('no artifact');

      const receipt = pickReceipt(artifact);
      // aggregate is null on the install sheet, where nothing has run yet by
      // definition, and carries local history when this pane is opened as the
      // record behind a card's receipts strip. The strip and the record it
      // opens have to agree about what they are describing.
      const record = pickRecord(receipt, o.chainCheck, o.aggregate);

      host.appendChild(fingerprintBlock(artifact, harvested(preserved, 'wfx-in-fp-copy')));
      host.appendChild(identityBlock(artifact));

      // wfMiniGraph lives in app.js and reads a locally sourced lastRun. The
      // install preview passes null for it, so the drawing takes no status
      // from an imported receipt.
      if (o.miniGraph) host.appendChild(o.miniGraph);

      if (record && record.refused) {
        // A refusal never degrades into a lower tier: the figures are removed
        // and the block that would have held them holds the reason. The graph
        // above and the prompts below are untouched.
        host.appendChild(renderRefusal(record.refused));
      } else if (record && record.runs > 0) {
        host.appendChild(renderFigures(record, { density: 'panel', billing: o.billing || null }));
      } else {
        host.appendChild(el('div', { class: 'wfx-empty' },
          el('p', { class: 'wfx-empty-t' }, 'No run history came with this file'),
          el('p', { class: 'wfx-empty-m' }, 'Its author published the graph without receipts, which is what a workflow looks like on the day it is written. Everything above was recomputed here from the file\'s own bytes and does not depend on them.')));
      }

      const changeButton = harvested(preserved, 'wfx-in-cwd-change');
      if (o.cwd || changeButton) {
        host.appendChild(el('div', { class: 'ra-pathrow' },
          o.cwd ? renderPath(o.cwd) : el('span', { class: 'wfx-path' },
            el('span', { class: 'wfx-path-dir' }, 'no directory bound yet')),
          changeButton || []));
      }

      if (o.preflight && o.preflight.ok === true) {
        host.appendChild(renderPreflight(o.preflight, { onFix: o.onFix }));
      }

      host.appendChild(renderSteps(artifact.graph, { open: false }));

      host.appendChild(el('div', { class: 'wfx-note' },
        el('p', { class: 'wfx-note-t' }, 'What the numbers above are worth'),
        el('p', { class: 'wfx-note-m' }, worthSentence(record, o.billing || null))));

      return { ok: true, record };
    } catch (_) {
      clear(host);
      host.appendChild(renderRefusal({
        title: 'This record could not be drawn',
        message: 'Husk read the file and then failed while rendering what it found, so nothing here should be trusted to describe what would run. Nothing was installed and nothing was written.',
        detail: null,
      }));
      return { ok: false, code: 'render-failed' };
    }
  }

  // ─── Surface 3: the first-run consent gate ─────────────────────────────────

  // The gate opens for a workflow that came out of a file and has never been
  // agreed to. consentedAt is a non-empty ISO string or it is nothing, so an
  // incomplete sidecar row asks again.
  function needsConsent(sidecar) {
    if (!sidecar || typeof sidecar !== 'object') return false;
    if (sidecar.origin !== 'imported') return false;
    return !(typeof sidecar.consentedAt === 'string' && sidecar.consentedAt.length > 0);
  }

  // "Steps 01 to 03 spawn claude and step 04 spawns codex." Generated rather
  // than written, because the sentence is about this graph and a generic one
  // ("each step spawns its agent") is a sentence that has stopped saying
  // anything. Contiguous runs are collapsed; a scattered set is listed.
  function agentSentence(steps) {
    const groups = [];
    steps.forEach((node, i) => {
      const agent = (typeof node.agentCommand === 'string' && node.agentCommand) ? node.agentCommand : 'its agent';
      const last = groups[groups.length - 1];
      if (last && last.agent === agent) last.indexes.push(i);
      else groups.push({ agent, indexes: [i] });
    });
    if (!groups.length) return frag();

    const pieces = [];
    groups.forEach((group, gi) => {
      if (gi > 0) pieces.push(gi === groups.length - 1 ? ' and ' : ', ');
      const nums = group.indexes.map((i) => String(i + 1).padStart(2, '0'));
      if (nums.length === 1) pieces.push(`step ${nums[0]} spawns `);
      else if (nums.length === 2) pieces.push(`steps ${nums[0]} and ${nums[1]} spawn `);
      else pieces.push(`steps ${nums[0]} to ${nums[nums.length - 1]} spawn `);
      pieces.push(el('code', null, group.agent));
    });
    return frag(pieces);
  }

  // What an imported workflow's runner does differently, named for the vendors
  // this graph actually uses. Both clauses describe guards that stay on rather
  // than features that come off.
  function untrustedClause(steps) {
    const agents = new Set(steps.map((n) => n.agentCommand).filter((a) => typeof a === 'string' && a));
    const clauses = [];
    if (agents.has('codex')) clauses.push('codex keeps its own refusal to run outside a trusted git directory');
    if (agents.has('aider')) clauses.push('aider runs with auto-commit off and does not approve its own edits');
    if (!clauses.length) return 'Because this workflow was imported, it runs with every auto-approval its agents offer switched off, so no step here can approve itself or write a commit under your name.';
    return `Because this workflow was imported, ${clauses.join(' and ')}, so no step here can approve itself or write a commit under your name.`;
  }

  // The checkbox is lifted with its .wfx-ack plate, so the label, the painted
  // box and the `for` relationship all survive the rebuild together. See
  // harvest().
  const CONSENT_HOST_CONTROLS = Object.freeze([{ id: 'wfx-cs-ack', up: '.wfx-ack' }]);

  // Fills the consent gate's body. Every prompt renders, all open, in
  // orderedSteps order: this is the screen a person reads before agreeing to
  // let a stranger's instructions run against a directory full of their own
  // work.
  //
  // Returns the number of steps rendered, which the caller needs for the
  // checkbox label and the footer note.
  function renderConsent(opts) {
    const o = opts || {};
    const host = o.host;
    if (!host || typeof host.appendChild !== 'function') return 0;

    const preserved = harvest(host, CONSENT_HOST_CONTROLS);
    clear(host);

    const artifact = (o.artifact && typeof o.artifact === 'object') ? o.artifact : null;
    const graph = artifact ? artifact.graph : (o.workflow && o.workflow.graph);
    const steps = orderedSteps(graph);
    const name = oneLine(artifact && artifact.name)
      || oneLine(o.workflow && o.workflow.name);

    const provenance = [];
    const publisherUrl = (artifact && artifact.publisher && typeof artifact.publisher.url === 'string')
      ? artifact.publisher.url
      : '';
    if (publisherUrl) provenance.push(`Installed from ${publisherUrl}.`);
    provenance.push('You have not run it.');
    provenance.push('Husk asks once, on the first run, and never again for this workflow.');

    host.appendChild(el('div', { class: 'wfx-note' },
      el('p', { class: 'wfx-note-t' }, name),
      el('p', { class: 'wfx-note-m' }, provenance.join(' '))));

    if (typeof o.cwd === 'string' && o.cwd) host.appendChild(renderPath(o.cwd));

    host.appendChild(el('p', { class: 'ra-hint' },
      agentSentence(steps),
      steps.length
        ? ', each in that directory, each with the prompt below and the previous step\'s output pasted in where the prompt asks for it. '
        : '',
      untrustedClause(steps)));

    host.appendChild(renderSteps(graph, { open: true }));

    // The checkbox is the shell's, preserved rather than rebuilt: el() owns the
    // "wfxd-" id namespace and cannot mint #wfx-cs-ack, and the label's `for`
    // has to keep pointing at it. Its text is rewritten to the real step count,
    // which is the only part of it that varies.
    const ack = harvestedControl(preserved, 'wfx-cs-ack');
    const ackPlate = harvested(preserved, 'wfx-cs-ack');
    if (ack && ackPlate) {
      const label = ack.closest ? ack.closest('label') : null;
      if (label) {
        // The trailing text node is the label's words; the input and its
        // painted box are the two elements before it. Rewriting that node
        // rather than the label's textContent keeps them both.
        const words = ` I have read ${steps.length === 1 ? 'the prompt' : `all ${steps.length} prompts`}`;
        let last = label.lastChild;
        while (last && last.nodeType !== 3) last = last.previousSibling;
        if (last) last.data = words;
        else label.appendChild(text(words));
      }
      host.appendChild(ackPlate);
    }

    return steps.length;
  }

  // ─── The gate itself ───────────────────────────────────────────────────────

  let consentSession = null;

  function workflowsApi() {
    const husk = (typeof window !== 'undefined') ? window.husk : null;
    return (husk && husk.workflows) ? husk.workflows : null;
  }

  function setSheetDisabled(button, disabled) {
    if (!button) return;
    // aria-disabled and not disabled, matching the shipped footer markup:
    // `disabled` takes a button out of the tab order, so the sentence
    // explaining why the commit is withheld would be unreachable from the
    // control it describes. The click listener holds the state.
    button.setAttribute('aria-disabled', disabled ? 'true' : 'false');
  }

  function say(target, sentence) {
    const node = (typeof target === 'string') ? (doc() && doc().getElementById(target)) : target;
    if (node) node.textContent = typeof sentence === 'string' ? sentence : '';
  }

  // Opens the gate and resolves true only when the reader ticked the box and
  // pressed the primary. Every other exit resolves false, including Escape,
  // which app.js routes here by registering closeConsentGate in MODAL_CLOSERS.
  function openConsentGate(opts) {
    const o = opts || {};
    const d = doc();
    const modal = d && d.getElementById('wfx-consent-modal');
    const ready = d && d.getElementById('wfx-cs-ready');
    if (!modal || !ready) return Promise.resolve(false);

    // One gate at a time: the pending one is answered no and torn down first,
    // so two dialogs never share one set of ids and one checkbox.
    if (consentSession) closeConsentGate();

    const stepCount = renderConsent({
      host: ready,
      artifact: o.artifact,
      workflow: o.workflow,
      cwd: o.cwd,
    });

    const ack = d.getElementById('wfx-cs-ack');
    const go = d.getElementById('wfx-cs-go');
    const cancel = d.getElementById('wfx-cs-cancel');
    const close = d.getElementById('wfx-cs-x');
    const foot = d.getElementById('wfx-cs-foot');

    if (ack) ack.checked = false;
    setSheetDisabled(go, true);

    const agents = new Set(orderedSteps(o.artifact ? o.artifact.graph : (o.workflow && o.workflow.graph))
      .map((n) => n.agentCommand)
      .filter((a) => typeof a === 'string' && a));
    const agentList = Array.from(agents);

    const lockedNote = stepCount === 1
      ? 'Read the prompt, then tick the box at the end to enable Run it.'
      : `Read the ${stepCount} prompts, then tick the box at the end to enable Run it.`;

    // Once the box is ticked the footer stops naming the precondition, which is
    // met, and names the consequence, which is not. Two different sentences for
    // two different moments, rather than one that is wrong half the time.
    function unlockedNote() {
      const where = (typeof o.cwd === 'string' && o.cwd) ? ` from ${o.cwd}` : '';
      if (!agentList.length) return `These prompts will be sent to their agents${where}.`;
      const list = agentList.length === 1
        ? agentList[0]
        : `${agentList.slice(0, -1).join(', ')} and ${agentList[agentList.length - 1]}`;
      return `These prompts will be sent to ${list}${where}.`;
    }

    if (foot) foot.textContent = lockedNote;

    return new Promise((resolve) => {
      const controller = (typeof AbortController === 'function') ? new AbortController() : null;
      const signal = controller ? controller.signal : undefined;
      let settled = false;

      const finish = (agreed) => {
        if (settled) return;
        settled = true;
        if (controller) controller.abort();
        consentSession = null;
        modal.hidden = true;
        resolve(agreed === true);
      };

      consentSession = { finish };

      if (ack) {
        ack.addEventListener('change', () => {
          const ready2 = ack.checked === true;
          setSheetDisabled(go, !ready2);
          if (foot) foot.textContent = ready2 ? unlockedNote() : lockedNote;
        }, { signal });
      }
      if (go) {
        go.addEventListener('click', () => {
          // The listener holds the state. Re-announcing the precondition is
          // the useful thing to do with the press rather than swallowing it.
          if (go.getAttribute('aria-disabled') === 'true') {
            say('wfx-cs-say', lockedNote);
            return;
          }
          finish(true);
        }, { signal });
      }
      if (cancel) cancel.addEventListener('click', () => finish(false), { signal });
      if (close) close.addEventListener('click', () => finish(false), { signal });

      modal.hidden = false;
      say('wfx-cs-say', `${stepCount === 1 ? 'One prompt' : `${stepCount} prompts`} to read before this workflow runs.`);
      // Focus the first prompt's own summary rather than the primary, which is
      // withheld until the box is ticked. Reading the prompts is the task this
      // dialog exists for, so focus starts at the first one.
      const first = ready.querySelector ? ready.querySelector('.wfx-step > summary') : null;
      if (first && first.focus) { try { first.focus({ preventScroll: true }); } catch (_) { /* nothing focusable is not a failure */ } }
    });
  }

  // Registered by app.js in MODAL_CLOSERS so the global Escape handler settles
  // the gate's promise rather than hiding a dialog that is still pending.
  function closeConsentGate() {
    if (consentSession) consentSession.finish(false);
    const d = doc();
    const modal = d && d.getElementById('wfx-consent-modal');
    if (modal) modal.hidden = true;
  }

  // The one call app.js uses to start a workflow: an imported workflow reaches
  // workflows:run only once consentedAt is set. The main process holds the same
  // rule independently and answers code 'consent-required', so this is the
  // affordance and that is the boundary.
  async function runWorkflow(workflowId, opts) {
    const api = workflowsApi();
    if (!api || typeof api.run !== 'function') {
      return { ok: false, error: 'workflows are not available in this window', code: 'no-ipc', message: 'workflows are not available in this window', detail: null, workflowId };
    }
    // Rebuilt rather than forwarded. workflows:run takes { cwd } and nothing
    // else, and this function also accepts a `workflow` record for the gate's
    // copy, which stays on this side of the IPC boundary.
    const given = (opts && typeof opts === 'object') ? opts : {};
    const runOpts = {};
    if (typeof given.cwd === 'string' && given.cwd) runOpts.cwd = given.cwd;

    let sidecar = null;
    try {
      const res = await api.sidecars();
      if (res && res.ok && res.sidecars) sidecar = res.sidecars[workflowId] || null;
    } catch (_) {
      // sidecars() answers ok:true with {} for an unreadable store, so a throw
      // here is the channel itself failing. It is treated as a workflow whose
      // row could not be read, and the run stops.
      return {
        ok: false,
        error: 'Husk could not read this workflow\'s install record, so it will not start it',
        code: 'no-sidecar-read',
        message: 'Husk could not read this workflow\'s install record, so it will not start it',
        detail: null,
        workflowId,
      };
    }

    if (!needsConsent(sidecar)) return api.run(workflowId, runOpts);

    const agreed = await openConsentGate({
      artifact: sidecar ? sidecar.artifact : null,
      workflow: given.workflow || null,
      cwd: (typeof runOpts.cwd === 'string' && runOpts.cwd) ? runOpts.cwd : (sidecar ? sidecar.boundCwd : null),
    });
    if (!agreed) {
      return { ok: false, cancelled: true, error: 'run cancelled', code: 'cancelled', message: 'run cancelled', detail: null, workflowId };
    }

    const consented = await api.consent(workflowId);
    if (!consented || consented.ok !== true) return consented;
    return api.run(workflowId, runOpts);
  }

  window.WfxArtifactUi = {
    TIER,
    PASS_CONTEXT_COPY,
    PREVIOUS_OUTPUT_TOKEN,
    orderedSteps,
    pickReceipt,
    recordFromReceipt,
    recordFromAggregate,
    estimateDollars,
    formatDollars,
    formatDuration,
    renderClaim,
    renderFigures,
    renderSteps,
    renderPreflight,
    renderPath,
    renderRefusal,
    renderReceiptStrip,
    renderInspector,
    renderConsent,
    needsConsent,
    openConsentGate,
    closeConsentGate,
    runWorkflow,
    say,
  };
}());
