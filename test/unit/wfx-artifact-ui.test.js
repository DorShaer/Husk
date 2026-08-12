'use strict';

// The decisions wfx-artifact-ui.js makes before it draws anything.
//
// Everything in this file is a function that takes a stranger's JSON and
// answers a question the surfaces then render: which of up to eight receipts
// is shown, what the figures in it mean, in what order the prompts a user is
// about to consent to are listed, and whether the consent gate opens at all.
// They are the parts of that file with no DOM in them, and they were the parts
// with no test on them, because the file is a classic script that node --test
// could not reach until test/helpers grew a document.
//
// The trust tier those same functions decide is in wfx-artifact-ui-tiers.test.js.
// Splitting them is not tidiness: the tier is the one output in this module
// that the spec pins datum by datum, and a file that reads as a checklist
// against that table is worth more than the same assertions scattered through
// this one.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { loadRenderer } = require('../helpers/load-renderer');

const { ui, document } = loadRenderer();

// ─── pickReceipt ─────────────────────────────────────────────────────────────

test('pickReceipt: the largest sample wins, because two medians cannot be added', () => {
  const artifact = {
    receipts: [
      { runs: 4, environment: { modelResolved: 'claude-sonnet-5' } },
      { runs: 31, environment: { modelResolved: 'claude-opus-4-8' } },
      { runs: 12, environment: { modelResolved: 'claude-haiku-4-5' } },
    ],
  };

  assert.equal(ui.pickReceipt(artifact).runs, 31);
});

test('pickReceipt: a tie keeps the first, so one file always summarises the same way', () => {
  const first = { runs: 9, id: 'a' };
  const artifact = { receipts: [first, { runs: 9, id: 'b' }] };

  assert.equal(ui.pickReceipt(artifact), first);
});

test('pickReceipt: anything that is not a receipt is skipped rather than counted', () => {
  assert.equal(ui.pickReceipt(null), null);
  assert.equal(ui.pickReceipt({}), null);
  assert.equal(ui.pickReceipt({ receipts: 'many' }), null);
  assert.equal(ui.pickReceipt({ receipts: [] }), null);
  assert.equal(ui.pickReceipt({ receipts: [null, 'x', 7] }), null);

  // A receipt with no runs field counts as zero rather than as unknown, so a
  // real sample beside it always wins.
  const real = { runs: 1 };
  assert.equal(ui.pickReceipt({ receipts: [{}, real] }), real);
});

// ─── recordFromReceipt ───────────────────────────────────────────────────────

test('recordFromReceipt: a published receipt becomes a record with its numbers truncated to integers', () => {
  const record = ui.recordFromReceipt({
    runs: 31.9,
    medianDurationMs: 288000.4,
    durationCensored: 2,
    outcomes: { completed: 29 },
    runsWindowed: true,
    medianTokens: { input: 1200, output: 800 },
    environment: { modelResolved: 'claude-sonnet-5', agentResolved: 'claude' },
    evidence: 'inline',
  });

  assert.equal(record.runs, 31);
  assert.equal(record.durationMs, 288000);
  assert.equal(record.durationCensored, 2);
  assert.equal(record.completed, 29);
  assert.equal(record.runsWindowed, true);
  assert.deepEqual(record.tokens, { input: 1200, output: 800 });
  assert.equal(record.model, 'claude-sonnet-5');
  assert.equal(record.agent, 'claude');
  assert.equal(record.refused, null);
});

test('recordFromReceipt: a wire format that never carried a distribution never grows one', () => {
  // durationRangeMs is deliberately kept off the published receipt, so a
  // record built from a file has no range to draw even at two runs. Only a
  // local aggregate can produce one; see recordFromAggregate below.
  const record = ui.recordFromReceipt({ runs: 2, medianDurationMs: 4000, durationRangeMs: { min: 1, max: 9 } });

  assert.equal(record.durationRange, null);
  assert.equal(record.precision, 'range');
});

test('recordFromReceipt: fields a hostile file left off or wrote as the wrong type fall back rather than throw', () => {
  const record = ui.recordFromReceipt({
    runs: 'lots',
    medianDurationMs: null,
    outcomes: 'all good',
    medianTokens: 'plenty',
    environment: { modelResolved: 42 },
    runsWindowed: 'true',
    evidence: 'INLINE',
  });

  assert.equal(record.runs, 0);
  assert.equal(record.durationMs, null);
  assert.equal(record.completed, 0);
  assert.equal(record.tokens, null);
  assert.equal(record.model, null);
  // Only the exact boolean and the exact enum value count, so a stringly
  // typed file cannot talk its way into a claim it did not make.
  assert.equal(record.runsWindowed, false);
  assert.equal(record.evidence, 'none');
});

test('recordFromReceipt: nothing at all is nothing, not an empty record', () => {
  for (const bad of [null, undefined, 'receipt', 7, true]) {
    assert.equal(ui.recordFromReceipt(bad), null, String(bad));
  }
});

test('recordFromReceipt: the precision word is decided by the sample size and by nothing else', () => {
  const precisionAt = (runs) => ui.recordFromReceipt({ runs }).precision;

  assert.equal(precisionAt(0), 'none');
  assert.equal(precisionAt(1), 'single');
  assert.equal(precisionAt(2), 'range');
  assert.equal(precisionAt(3), 'median');
  assert.equal(precisionAt(31), 'median');
  // The word "median" does not appear below three runs, which is the whole
  // copy rule: a measurement over a thin sample is exact and is still not a
  // median, so the fix is vocabulary rather than digits.
  assert.notEqual(precisionAt(2), 'median');
});

// ─── recordFromAggregate ─────────────────────────────────────────────────────

test('recordFromAggregate: local history is the one source that can offer a real range', () => {
  const record = ui.recordFromAggregate({
    runs: 2,
    medianDurationN: 2,
    medianDurationMs: 1500,
    durationRangeMs: { min: 1000.9, max: 2000.2 },
    outcomes: { completed: 1 },
  });

  assert.deepEqual(record.durationRange, { min: 1000, max: 2000 });
  assert.equal(record.precision, 'range');
  assert.equal(record.evidence, 'local');
});

test('recordFromAggregate: a range with an end that is not a number is no range at all', () => {
  const record = ui.recordFromAggregate({ runs: 2, medianDurationMs: 1500, durationRangeMs: { min: 1000, max: null } });

  assert.equal(record.durationRange, null);
});

test('recordFromAggregate: the precision word describes the duration sample, not the run count', () => {
  // A run with no usable duration still votes in the outcome tally, so the two
  // counts come apart, and the word that names the duration has to be taken
  // from the smaller one.
  const record = ui.recordFromAggregate({ runs: 9, medianDurationN: 1, medianDurationMs: 4000, outcomes: { completed: 9 } });

  assert.equal(record.runs, 9);
  assert.equal(record.precision, 'single');
});

test('recordFromAggregate: an aggregate names no model or agent, so nothing prices it by hearsay', () => {
  const record = ui.recordFromAggregate({
    runs: 3,
    medianDurationN: 3,
    medianTokens: { input: 100, output: 50 },
    environment: { modelResolved: 'claude-opus-4-8' },
  });

  assert.equal(record.model, null);
  assert.equal(record.agent, null);
  assert.deepEqual(record.tokens, { input: 100, output: 50 });
});

test('recordFromAggregate: nothing at all is nothing', () => {
  for (const bad of [null, undefined, 'aggregate', 0]) {
    assert.equal(ui.recordFromAggregate(bad), null, String(bad));
  }
});

// ─── estimateDollars ─────────────────────────────────────────────────────────

test('estimateDollars: four reasons a price cannot be given, each named separately', () => {
  const why = (opts) => ui.estimateDollars(opts).why;

  // On a plan there is no per-token bill to estimate.
  assert.equal(why({}), 'no per-token bill');
  assert.equal(why({ billing: { metered: false }, tokens: { input: 1 }, model: 'claude-sonnet-5' }), 'no per-token bill');
  // Metered, but the run reported no usage at all.
  assert.equal(why({ billing: { metered: true } }), 'no token counts');
  // Metered with usage, and this build has no rate for the model named.
  assert.equal(why({ billing: { metered: true }, tokens: {}, model: 'gpt-9-turbo' }), 'no rate for that model');
  // Metered with usage and a known agent whose billing depends on the account
  // rather than on the CLI, which is a different fact from having no rate.
  assert.equal(why({ billing: { metered: true }, tokens: {}, agent: 'codex' }), 'not priceable here');

  // The four are not interchangeable, and each carries its own sentence.
  const notes = [
    ui.estimateDollars({}),
    ui.estimateDollars({ billing: { metered: true } }),
    ui.estimateDollars({ billing: { metered: true }, tokens: {}, model: 'gpt-9-turbo' }),
    ui.estimateDollars({ billing: { metered: true }, tokens: {}, agent: 'aider' }),
  ].map((r) => r.note);
  assert.equal(new Set(notes).size, 4);
  for (const note of notes) assert.equal(typeof note, 'string');
});

test('estimateDollars: the arithmetic is the meter\'s, at this machine\'s rates', () => {
  const priced = (tokens, model) => ui.estimateDollars({ billing: { metered: true }, tokens, model }).usd;

  // Every figure here is a float built from four divisions, so the comparison
  // is to a hundredth of a cent rather than to the bit. The surface rounds to
  // two decimals at most and the tile below a dollar carries one, so a
  // difference this test would miss is a difference no reader can see.
  const cent = (actual, want) => assert.ok(Math.abs(actual - want) < 1e-4, `${actual} is not ${want}`);

  // sonnet is $3 in and $15 out per million.
  cent(priced({ input: 1e6, output: 1e6 }, 'claude-sonnet-5'), 18);
  // Cache creation is 1.25x the input rate and a cache read is 0.1x, matching
  // budget.js so the imported estimate and the local meter agree.
  cent(priced({ cacheCreate: 1e6 }, 'claude-sonnet-5'), 3.75);
  cent(priced({ cacheRead: 1e6 }, 'claude-sonnet-5'), 0.3);
  cent(priced({ input: 1e6, output: 1e6, cacheCreate: 1e6, cacheRead: 1e6 }, 'claude-sonnet-5'), 22.05);
  // Counts a file wrote as negative or as a string contribute nothing rather
  // than subtracting from the bill.
  assert.equal(priced({ input: -5e6, output: 'many' }, 'claude-sonnet-5'), 0);
});

test('estimateDollars: the model ladder resolves a dated id and a bare tier alias, and stops there', () => {
  const priced = (model) => ui.estimateDollars({ billing: { metered: true }, tokens: { input: 1e6 }, model }).usd;

  assert.equal(priced('claude-sonnet-5'), 3);
  assert.equal(priced('claude-sonnet-4-6-20250101'), 3);
  assert.equal(priced('sonnet'), 3);
  assert.equal(priced('opus'), 5);
  assert.equal(priced('haiku'), 1);
  assert.equal(priced('CLAUDE-OPUS-4-8'), 5);
  // An unrecognised model has no rate here. Pricing it at some other model's
  // rates and putting the result under "your estimate" would be inventing the
  // figure rather than estimating it.
  assert.equal(priced('llama-4-70b'), null);
  assert.equal(priced(''), null);
  assert.equal(priced(null), null);
});

test('estimateDollars: the agent is the fallback for a record that names no model', () => {
  const fromAgent = ui.estimateDollars({ billing: { metered: true }, tokens: { input: 1e6 }, model: null, agent: 'claude-opus-4-8' });

  assert.equal(fromAgent.usd, 5);
});

// ─── formatDuration ──────────────────────────────────────────────────────────

test('formatDuration: seconds under a minute, minutes with padded seconds, hours with padded minutes', () => {
  assert.equal(ui.formatDuration(0), '0s');
  assert.equal(ui.formatDuration(999), '1s');
  assert.equal(ui.formatDuration(59499), '59s');
  // Rounding to the nearest second is what pushes 59.5s over the boundary,
  // and the minute form pads so a column of durations stays aligned.
  assert.equal(ui.formatDuration(59500), '1m 00s');
  assert.equal(ui.formatDuration(288000), '4m 48s');
  assert.equal(ui.formatDuration(3599000), '59m 59s');
  assert.equal(ui.formatDuration(3600000), '1h 00m');
  assert.equal(ui.formatDuration(3900000), '1h 05m');
});

test('formatDuration: a duration that is not a duration reads as zero rather than as NaN', () => {
  for (const bad of [null, undefined, NaN, -5, 'soon', {}]) {
    assert.equal(ui.formatDuration(bad), '0s', String(bad));
  }
});

// ─── orderedSteps ────────────────────────────────────────────────────────────

test('orderedSteps: every step of a branching graph is listed, not one path through it', () => {
  // The consent gate is contractually bound to this order, and a walk that
  // follows one outgoing edge per node would show three prompts of the five
  // that are about to run.
  const graph = {
    nodes: [{ id: 'd' }, { id: 'a' }, { id: 'b' }, { id: 'c' }],
    edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }, { from: 'b', to: 'd' }, { from: 'c', to: 'd' }],
  };

  assert.deepEqual(ui.orderedSteps(graph).map((n) => n.id), ['a', 'b', 'c', 'd']);
});

test('orderedSteps: roots are seeded in wiring order first and in node order second', () => {
  // Two files describing one workflow whose node arrays serialised differently
  // would otherwise read in two orders under one fingerprint.
  const graph = {
    nodes: [{ id: 'solo' }, { id: 'p' }, { id: 'q' }],
    edges: [{ from: 'p', to: 'q' }],
  };

  assert.deepEqual(ui.orderedSteps(graph).map((n) => n.id), ['p', 'solo', 'q']);
});

test('orderedSteps: a graph that is one pure cycle still emits every step', () => {
  // A prompt that does not render is a prompt nobody consented to, so the walk
  // seeds itself rather than terminating with an empty list.
  const graph = {
    nodes: [{ id: 'x' }, { id: 'y' }, { id: 'z' }],
    edges: [{ from: 'x', to: 'y' }, { from: 'y', to: 'z' }, { from: 'z', to: 'x' }],
  };

  assert.deepEqual(ui.orderedSteps(graph).map((n) => n.id), ['x', 'y', 'z']);
});

test('orderedSteps: a step nothing points at and that points at nothing is still emitted', () => {
  const graph = {
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'orphan' }],
    edges: [{ from: 'a', to: 'b' }, { from: 'ghost', to: 'a' }],
  };
  const order = ui.orderedSteps(graph);

  assert.equal(order.length, 3);
  assert.deepEqual(new Set(order.map((n) => n.id)), new Set(['a', 'b', 'orphan']));
  // An edge naming a node that is not in the graph adds no step of its own.
  assert.equal(order.some((n) => n.id === 'ghost'), false);
});

test('orderedSteps: each node appears exactly once however the edges are written', () => {
  const graph = {
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    edges: [
      { from: 'a', to: 'b' }, { from: 'a', to: 'b' }, { from: 'a', to: 'c' },
      { from: 'b', to: 'c' }, { from: 'c', to: 'b' },
    ],
  };
  const ids = ui.orderedSteps(graph).map((n) => n.id);

  assert.deepEqual(ids, ['a', 'b', 'c']);
  assert.equal(new Set(ids).size, ids.length);
});

test('orderedSteps: a graph that is not a graph is an empty list rather than a throw', () => {
  for (const bad of [null, undefined, 'graph', 42, {}, { nodes: 'two' }, { nodes: [] }]) {
    assert.deepEqual(ui.orderedSteps(bad), [], JSON.stringify(bad));
  }
  // Entries that are not objects are filtered out of both collections, and
  // whatever is left still renders.
  const mixed = ui.orderedSteps({ nodes: [null, 'x', { id: 'a' }], edges: [null, 7, { from: 'a', to: 'a' }] });
  assert.deepEqual(mixed.map((n) => n.id), ['a']);
});

// ─── needsConsent ────────────────────────────────────────────────────────────

test('needsConsent: only an imported workflow is ever asked about', () => {
  assert.equal(ui.needsConsent({ origin: 'imported' }), true);
  assert.equal(ui.needsConsent({ origin: 'local' }), false);
  assert.equal(ui.needsConsent({ origin: 'IMPORTED' }), false);
  assert.equal(ui.needsConsent({}), false);
});

test('needsConsent: consent is a non-empty ISO string, and anything else asks again', () => {
  assert.equal(ui.needsConsent({ origin: 'imported', consentedAt: '2026-08-06T09:12:00.000Z' }), false);
  // A corrupted or half-written sidecar row fails closed, which is the
  // direction this particular question should fail in.
  for (const bad of ['', null, undefined, 0, 1754467920000, true, {}]) {
    assert.equal(ui.needsConsent({ origin: 'imported', consentedAt: bad }), true, JSON.stringify(bad));
  }
});

test('needsConsent: no sidecar at all is not a reason to gate, because there is nothing to run', () => {
  for (const bad of [null, undefined, 'imported', 7, []]) {
    assert.equal(ui.needsConsent(bad), false, String(bad));
  }
});

// ─── The vocabulary these functions feed ─────────────────────────────────────

test('the three tier words are fixed, and none of them is the word verified', () => {
  assert.deepEqual(
    Object.values(ui.TIER).map((t) => t.word),
    ['computed here', 'matches the shipped log', 'author states'],
  );
  for (const tier of Object.values(ui.TIER)) {
    assert.doesNotMatch(tier.word, /verif/i);
    assert.equal(Object.isFrozen(tier), true);
  }
});

test('the passContext copy names what the next step receives, in the reader\'s language', () => {
  assert.deepEqual(ui.PASS_CONTEXT_COPY, {
    full: 'carries the whole transcript',
    last50: 'carries the last 50 lines',
    none: 'carries nothing forward',
  });
  // An unknown enum value falls back to the most restrictive sentence rather
  // than to a blank, which the step summary depends on.
  const summary = ui.renderSteps({ nodes: [{ id: 'a', name: 'One', prompt: 'p', agentCommand: 'claude', passContext: 'everything' }], edges: [] });
  assert.match(summary.textContent, /carries nothing forward/);
});

test('renderPath splits the directory from the filename so the name is never the part that truncates', () => {
  const row = ui.renderPath('/home/user/code/orbit/workflow.husk.json');

  assert.deepEqual(row.children.map((c) => c.textContent), ['/home/user/code/orbit/', 'workflow.husk.json']);
  assert.deepEqual(ui.renderPath('workflow.husk.json').children.map((c) => c.textContent), ['', 'workflow.husk.json']);
  assert.deepEqual(ui.renderPath('C:\\Users\\user\\orbit\\w.husk.json').children.map((c) => c.textContent), ['C:\\Users\\user\\orbit\\', 'w.husk.json']);
  assert.deepEqual(ui.renderPath(null).children.map((c) => c.textContent), ['', '']);
});

test('a prompt reaches the DOM as text, and the interpolation seam is marked by moving that text', () => {
  const payload = 'read </pre><img src=x onerror=alert(1)> then {{previousOutput}} twice {{previousOutput}}';
  const steps = ui.renderSteps({ nodes: [{ id: 'a', name: 'One', prompt: payload, agentCommand: 'claude', passContext: 'full' }], edges: [] });
  const pre = steps.querySelector('.wfx-prompt');

  // Nothing was parsed: the prompt reads back character for character, and the
  // only elements under the pre are the marks the highlight moved text into.
  assert.equal(pre.textContent, payload);
  assert.deepEqual(pre.children.map((c) => c.tagName), ['MARK', 'MARK']);
  assert.deepEqual(pre.querySelectorAll('mark').map((m) => m.textContent), ['{{previousOutput}}', '{{previousOutput}}']);
  assert.equal(pre.querySelector('img'), null);
  assert.equal(document.querySelector('img'), null);
});
