'use strict';

// The trust tier table, read back off the rendered surface.
//
// The tier is a field on the validator's return value rather than a class a
// renderer picks, so every assertion here reads the DOM rather than the record
// object: what the spec states is that the reader sees the words beside the
// number.
//
// Three rules, in the order the spec argues them:
//
//   1. Every figure carries a tier.
//   2. A datum the table calls "computed here" renders as computed here, and
//      one it does not, does not.
//   3. Refusal takes the figures out rather than annotating them.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { loadRenderer } = require('../helpers/load-renderer');

const { ui, document } = loadRenderer();

const COMPUTED = 'computed here';
const CONSISTENT = 'matches the shipped log';
const SAID = 'author states';

// A receipt with something in every slot the figures read, so a test can vary
// one field and change nothing else.
function receipt(over) {
  return Object.assign({
    runs: 31,
    medianDurationMs: 288000,
    durationCensored: 0,
    outcomes: { completed: 29 },
    medianTokens: { input: 1200000, output: 400000 },
    environment: { modelResolved: 'claude-sonnet-5', agentResolved: 'claude' },
    evidence: 'inline',
  }, over || {});
}

// The chain check a caller hands in after re-hashing the shipped rows. Passing
// it is the only thing that moves a receipt off "author states".
const CHAIN_HOLDS = Object.freeze({ checked: true, valid: true, agrees: true });

// The chip words under a subtree, in document order. The class picks the ink
// and the word is what the reader is told, so the word is what is read.
function chipWords(node) {
  return node.querySelectorAll('.wfx-claim').map((c) => c.textContent);
}

// Every figure tile paired with the chip inside it, so a tile with no chip
// shows up as a null rather than as a shorter list.
function tilesWithChips(node) {
  return node.querySelectorAll('.wfx-fig').map((tile) => ({
    label: tile.querySelector('.wfx-fig-l').textContent,
    chip: tile.querySelector('.wfx-claim') ? tile.querySelector('.wfx-claim').textContent : null,
  }));
}

function into(node) {
  const host = document.createElement('div');
  host.appendChild(node);
  return host;
}

// ─── Rule 1: no figure without a tier ────────────────────────────────────────

test('every panel tile carries its own chip, whatever the record says', () => {
  const records = [
    ui.recordFromReceipt(receipt()),
    ui.recordFromReceipt(receipt({ runs: 1, medianTokens: null })),
    ui.recordFromReceipt(receipt({ runs: 2, medianDurationMs: null })),
    ui.recordFromReceipt(receipt(), CHAIN_HOLDS),
    ui.recordFromAggregate({ runs: 12, medianDurationN: 12, medianDurationMs: 9000, outcomes: { completed: 12 } }),
    ui.recordFromAggregate({ runs: 2, medianDurationN: 2, durationRangeMs: { min: 1000, max: 9000 }, outcomes: { completed: 2 } }),
  ];

  for (const record of records) {
    for (const billing of [null, { metered: false }, { metered: true }]) {
      const figs = ui.renderFigures(record, { density: 'panel', billing });
      const tiles = tilesWithChips(figs);

      assert.equal(tiles.length, 4);
      for (const tile of tiles) {
        assert.notEqual(tile.chip, null, `${tile.label} rendered with no provenance`);
        assert.ok([COMPUTED, CONSISTENT, SAID].includes(tile.chip), tile.chip);
      }
    }
  }
});

test('the card strip carries one chip for the group rather than none', () => {
  // In the card strip the tier is carried once for the tile group rather than
  // once per figure.
  const record = ui.recordFromReceipt(receipt());
  const host = into(ui.renderFigures(record, { density: 'inline' }));

  assert.equal(host.querySelectorAll('.wfx-fig').length, 3);
  assert.equal(host.querySelectorAll('.wfx-fig .wfx-claim').length, 0);
  assert.deepEqual(chipWords(host), [SAID]);
  // And the group chip sits outside the tiles, as a sibling of the group.
  assert.equal(host.querySelector('.wfx-figs .wfx-claim'), null);
});

test('a figure is never built by any path that omits the chip argument', () => {
  // The card is the only density that moves the chip out of the tile. Every
  // other density draws the panel form, chip included.
  const record = ui.recordFromReceipt(receipt());

  for (const density of [undefined, null, 'panel', 'PANEL', 'wide', 42]) {
    const figs = ui.renderFigures(record, { density });
    assert.equal(figs.querySelectorAll('.wfx-fig').length, 4, String(density));
    assert.equal(figs.querySelectorAll('.wfx-fig .wfx-claim').length, 4, String(density));
  }
});

// ─── Rule 2: what is computed here, and what is not ──────────────────────────

test('the dollar estimate is computed here whatever the receipt claims, including when it cannot be priced', () => {
  // This machine did the arithmetic at its own rates, so no receipt and no
  // chain state changes the tier.
  const cases = [
    [ui.recordFromReceipt(receipt()), { metered: true }],
    [ui.recordFromReceipt(receipt()), { metered: false }],
    [ui.recordFromReceipt(receipt()), null],
    [ui.recordFromReceipt(receipt({ medianTokens: null })), { metered: true }],
    [ui.recordFromReceipt(receipt({ environment: { modelResolved: 'llama-4-70b' } })), { metered: true }],
    [ui.recordFromReceipt(receipt({ environment: { agentResolved: 'codex' } })), { metered: true }],
    [ui.recordFromReceipt(receipt(), CHAIN_HOLDS), { metered: true }],
    [ui.recordFromAggregate({ runs: 4, medianDurationN: 4, medianTokens: { input: 10 } }), { metered: true }],
  ];

  for (const [record, billing] of cases) {
    const tiles = tilesWithChips(ui.renderFigures(record, { density: 'panel', billing }));
    const dollars = tiles[tiles.length - 1];

    assert.equal(dollars.label, 'your estimate');
    assert.equal(dollars.chip, COMPUTED);
  }
});

test('the graph fingerprint is computed here and says so in the same breath', () => {
  const host = document.createElement('div');
  const artifact = {
    name: 'Nightly triage',
    graphHash: 'a1b2c3'.padEnd(64, '0'),
    graph: { nodes: [{ id: 'n1', name: 'One', prompt: 'go', agentCommand: 'claude', passContext: 'none' }], edges: [] },
    receipts: [],
  };
  ui.renderInspector({ host, artifact });

  const block = host.querySelector('.ra-status');
  assert.equal(block.querySelector('.wfx-claim').textContent, COMPUTED);
  // The full 64 characters, in a mono block.
  assert.equal(block.querySelector('code').textContent, artifact.graphHash);
  assert.match(block.textContent, /Recomputed from the bytes of this file/);
});

test('the graph, the prompts and the preflight rows are unattributed, not attested', () => {
  // The spec's table calls every one of these computed here with the voice
  // "plain, unattributed", so they carry no chip at all.
  const graph = {
    nodes: [
      { id: 'a', name: 'Read the diff', prompt: 'summarise {{previousOutput}}', agentCommand: 'claude', passContext: 'full' },
      { id: 'b', name: 'Run the suite', prompt: 'bun run test', agentCommand: 'codex', passContext: 'last50' },
    ],
    edges: [{ from: 'a', to: 'b' }],
  };
  const steps = ui.renderSteps(graph, { open: true });
  const preflight = ui.renderPreflight({
    checks: [
      { status: 'ok', name: 'claude', title: 'claude is on your PATH' },
      { status: 'block', name: 'codex', title: 'codex is not on your PATH' },
      { status: 'caution', name: 'package.json', title: 'package.json found in /home/user/code/orbit' },
    ],
  });

  assert.deepEqual(chipWords(steps), []);
  assert.deepEqual(chipWords(preflight), []);
  // They are rendered, in severity order.
  assert.match(steps.textContent, /Read the diff/);
  assert.deepEqual(
    preflight.querySelectorAll('.wfx-pf-n').map((n) => n.textContent),
    ['codex is not on your PATH', 'package.json found in /home/user/code/orbit', 'claude is on your PATH'],
  );
});

test('a receipt figure is author states until a caller re-hashes the chain and says it agrees', () => {
  // evidence: "inline" is a field in the imported file, so on its own it
  // leaves the record where it is.
  const said = [
    ui.recordFromReceipt(receipt(), null),
    ui.recordFromReceipt(receipt(), {}),
    ui.recordFromReceipt(receipt(), { checked: false, valid: true, agrees: true }),
    ui.recordFromReceipt(receipt(), { valid: true, agrees: true }),
    // Checked and holding, but the file attached no log to check.
    ui.recordFromReceipt(receipt({ evidence: 'none' }), CHAIN_HOLDS),
    ui.recordFromReceipt(receipt({ evidence: 'local' }), CHAIN_HOLDS),
  ];

  for (const record of said) {
    const tiles = tilesWithChips(ui.renderFigures(record, { density: 'panel', billing: null }));
    assert.deepEqual(tiles.slice(0, 3).map((t) => t.chip), [SAID, SAID, SAID]);
  }
});

test('a re-hashed chain that holds and agrees moves the run figures to the shipped-log tier and no further', () => {
  const record = ui.recordFromReceipt(receipt(), CHAIN_HOLDS);
  const tiles = tilesWithChips(ui.renderFigures(record, { density: 'panel', billing: { metered: true } }));

  assert.deepEqual(tiles.map((t) => [t.label, t.chip]), [
    ['runs', CONSISTENT],
    ['median run', CONSISTENT],
    ['zero exit', CONSISTENT],
    ['your estimate', COMPUTED],
  ]);
});

test('runs that happened on this machine are the only run figures that reach computed here', () => {
  const local = ui.recordFromAggregate({
    runs: 12,
    medianDurationN: 12,
    medianDurationMs: 288000,
    outcomes: { completed: 11 },
  });
  const tiles = tilesWithChips(ui.renderFigures(local, { density: 'panel', billing: null }));

  assert.deepEqual(tiles.map((t) => t.chip), [COMPUTED, COMPUTED, COMPUTED, COMPUTED]);
});

test('the word verified appears on no surface this feature draws', () => {
  const artifact = {
    name: 'Nightly triage',
    description: 'Reads the diff and runs the suite.',
    publisher: { name: 'someone' },
    graphHash: 'f'.repeat(64),
    graph: { nodes: [{ id: 'n1', name: 'One', prompt: 'go {{previousOutput}}', agentCommand: 'claude', passContext: 'full' }], edges: [] },
    receipts: [receipt()],
  };
  const surfaces = [];

  for (const chainCheck of [null, CHAIN_HOLDS, { checked: true, valid: false }, { checked: true, valid: true, agrees: false }]) {
    const host = document.createElement('div');
    ui.renderInspector({ host, artifact, chainCheck, billing: { metered: true }, cwd: '/home/user/code/orbit' });
    surfaces.push(host);
    surfaces.push(ui.renderReceiptStrip({ artifact, chainCheck, workflowId: 'wf-1', workflowName: 'Nightly triage', onOpen: () => {} }));
  }
  const consentHost = document.createElement('div');
  ui.renderConsent({ host: consentHost, artifact, cwd: '/home/user/code/orbit' });
  surfaces.push(consentHost);

  for (const surface of surfaces) {
    assert.doesNotMatch(surface.textContent, /verif/i);
  }
});

// ─── Rule 3: refusal never degrades ──────────────────────────────────────────

test('a chain that does not hold removes the figures rather than annotating them', () => {
  const record = ui.recordFromReceipt(receipt(), { checked: true, valid: false, detail: 'row 3 breaks the chain' });

  assert.equal(record.tier, ui.TIER.said);
  assert.equal(record.refused.title, 'The shipped log does not check out');
  assert.equal(record.refused.detail, 'row 3 breaks the chain');

  const host = document.createElement('div');
  const artifact = {
    name: 'Nightly triage',
    graphHash: 'b'.repeat(64),
    graph: { nodes: [{ id: 'n1', name: 'One', prompt: 'go', agentCommand: 'claude', passContext: 'none' }], edges: [] },
    receipts: [receipt()],
  };
  const out = ui.renderInspector({ host, artifact, chainCheck: { checked: true, valid: false, detail: 'row 3 breaks the chain' } });

  assert.equal(out.ok, true);
  assert.equal(host.querySelectorAll('.wfx-fig').length, 0);
  assert.equal(host.querySelector('.wfx-refuse').textContent.includes(SAID), false);
  assert.match(host.querySelector('.wfx-refuse-t').textContent, /does not check out/);
  // The graph itself is unaffected and remains installable.
  assert.equal(host.querySelectorAll('.wfx-step').length, 1);
});

test('a chain that hashes together under numbers it does not support is the harder failure, not the softer one', () => {
  const record = ui.recordFromReceipt(receipt(), { checked: true, valid: true, agrees: false, detail: 'median 288000 vs 41000' });

  assert.equal(record.refused.title, 'The log does not support the numbers beside it');
  // A chain that holds does not on its own move the record off the said tier.
  assert.equal(record.tier, ui.TIER.said);
  assert.notEqual(record.tier, ui.TIER.consistent);
});

test('the card strip withholds a refused receipt instead of falling back to the author\'s account', () => {
  const artifact = { receipts: [receipt()] };
  const strip = ui.renderReceiptStrip({
    artifact,
    chainCheck: { checked: true, valid: false },
    workflowId: 'wf-1',
    workflowName: 'Nightly triage',
    onOpen: () => {},
  });

  assert.equal(strip.querySelectorAll('.wfx-fig').length, 0);
  assert.deepEqual(chipWords(strip), []);
  assert.match(strip.textContent, /Receipts withheld/);
  assert.equal(strip.textContent.includes(SAID), false);
});

test('local history wins over a shipped receipt, except when the shipped one refused', () => {
  const artifact = { receipts: [receipt()] };
  const aggregate = { runs: 4, medianDurationN: 4, medianDurationMs: 1000, outcomes: { completed: 4 } };

  // Local runs are the only thing here the reader measured themselves.
  const local = ui.renderReceiptStrip({ artifact, aggregate, workflowId: 'wf-1' });
  assert.deepEqual(chipWords(local), [COMPUTED]);

  // The refusal is shown in place of the local numbers.
  const refused = ui.renderReceiptStrip({ artifact, aggregate, chainCheck: { checked: true, valid: false }, workflowId: 'wf-1' });
  assert.match(refused.textContent, /Receipts withheld/);
});

// ─── The chip as a control ───────────────────────────────────────────────────

test('the strip chip is a button only when pressing it opens a record, and it names what it opens', () => {
  const openable = ui.renderReceiptStrip({
    artifact: { receipts: [receipt()] },
    workflowId: 'wf-1',
    workflowName: 'Nightly triage',
    onOpen: () => {},
  });
  const button = openable.querySelector('.wfx-claim');
  assert.equal(button.tagName, 'BUTTON');
  assert.equal(button.getAttribute('data-wfx-receipt'), 'wf-1');
  assert.equal(
    button.getAttribute('aria-label'),
    'Receipts for Nightly triage: 31 runs, author states. Open the record.',
  );

  // A workflow with no imported record behind the chip renders the word as a
  // label rather than a button.
  const plain = ui.renderReceiptStrip({ artifact: null, aggregate: { runs: 3, medianDurationN: 3, medianDurationMs: 500, outcomes: { completed: 3 } } });
  const label = plain.querySelector('.wfx-claim');
  assert.equal(label.tagName, 'SPAN');
  assert.equal(label.hasAttribute('aria-label'), false);
});

test('the other receipts are counted in the chip name rather than averaged into a number', () => {
  const artifact = { receipts: [receipt(), receipt({ runs: 4 }), receipt({ runs: 2 })] };
  const strip = ui.renderReceiptStrip({ artifact, workflowId: 'wf-1', workflowName: 'Nightly triage', onOpen: () => {} });

  assert.match(strip.querySelector('.wfx-claim').getAttribute('aria-label'), /1 of 3 records/);
});

test('pressing the chip opens the record and does not open the card behind it', () => {
  const opened = [];
  const cardClicks = [];
  const card = document.createElement('div');
  card.addEventListener('click', () => { cardClicks.push('card'); });

  const strip = ui.renderReceiptStrip({
    artifact: { receipts: [receipt()] },
    workflowId: 'wf-1',
    workflowName: 'Nightly triage',
    onOpen: (id, record) => { opened.push([id, record.runs, record.tier.word]); },
  });
  card.appendChild(strip);
  strip.querySelector('.wfx-claim').click();

  assert.deepEqual(opened, [['wf-1', 31, SAID]]);
  assert.deepEqual(cardClicks, []);
});

test('a card with nothing to show still draws the same block in the same place', () => {
  // The strip returns a node for every input, including no input at all, so
  // app.js appends unconditionally and .wf-card-status never moves.
  for (const opts of [{}, { artifact: null }, { artifact: { receipts: [] } }, { artifact: { receipts: [receipt({ runs: 0 })] } }, { aggregate: { runs: 0 } }]) {
    const strip = ui.renderReceiptStrip(opts);
    assert.equal(strip.getAttribute('class'), 'wfx-rcp is-none');
    assert.match(strip.textContent, /No receipts yet/);
  }
  // Including a stored artifact whose getter throws: the strip still draws.
  const hostile = ui.renderReceiptStrip({ artifact: { receipts: [receipt()] }, get aggregate() { throw new Error('boom'); } });
  assert.match(hostile.textContent, /No receipts yet/);
});

// ─── What the numbers are worth ──────────────────────────────────────────────

test('the closing sentence names the tier it is closing over', () => {
  const artifact = {
    name: 'Nightly triage',
    graphHash: 'c'.repeat(64),
    graph: { nodes: [{ id: 'n1', name: 'One', prompt: 'go', agentCommand: 'claude', passContext: 'none' }], edges: [] },
    receipts: [receipt({ durationCensored: 2, runsWindowed: true })],
  };

  // The closing note is the last .wfx-note on the pane.
  const closingNote = (host) => {
    const notes = host.querySelectorAll('.wfx-note');
    return notes[notes.length - 1].querySelector('.wfx-note-m').textContent;
  };

  const said = document.createElement('div');
  ui.renderInspector({ host: said, artifact, billing: { metered: true } });
  const saidNote = closingNote(said);
  assert.match(saidNote, /no log that checks out here/);
  assert.match(saidNote, /2 runs hit the five minute per-step limit/);
  assert.match(saidNote, /had already been trimmed/);
  assert.match(saidNote, /our estimate at your rates and not a bill/);
  assert.match(saidNote, /Installing writes a file/);

  const consistent = document.createElement('div');
  ui.renderInspector({ host: consistent, artifact, chainCheck: CHAIN_HOLDS });
  const consistentNote = closingNote(consistent);
  assert.match(consistentNote, /That is consistency, not proof/);
  assert.match(consistentNote, /anchored at a public constant with no signature/);
  // The dollar clause is absent when there is no per-token bill to estimate.
  assert.doesNotMatch(consistentNote, /not a bill/);
});

test('a file that shipped no receipts says so instead of drawing an empty figure row', () => {
  const host = document.createElement('div');
  ui.renderInspector({
    host,
    artifact: {
      name: 'Fresh',
      graphHash: 'd'.repeat(64),
      graph: { nodes: [{ id: 'n1', name: 'One', prompt: 'go', agentCommand: 'claude', passContext: 'none' }], edges: [] },
      receipts: [],
    },
  });

  assert.equal(host.querySelectorAll('.wfx-fig').length, 0);
  assert.match(host.querySelector('.wfx-empty-t').textContent, /No run history came with this file/);
  // The fingerprint above it is still computed here, and still the only chip
  // on the pane.
  assert.deepEqual(chipWords(host), [COMPUTED]);
});
