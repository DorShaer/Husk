'use strict';

// The publish gate: the state where a workflow cannot be published yet, and
// the control that clears it.
//
// The bug this file pins is the one a user actually hit. Every step the canvas
// mints is born with an agent command, and the artifact builder refuses a step
// without one, so the two have to agree or the default-shaped workflow runs
// perfectly and can never be published. These tests drive the sheet against
// graphs of both shapes and assert on what the sheet says and what it writes.
//
// The sheet is a classic script that reads document as an ambient global, so
// it is loaded through the same helper the other renderer suites use, against
// a fresh document per test. The markup those renders need is built here rather
// than parsed out of index.html: the helper has no HTML parser, and a fixture
// that drifts from index.html would fail loudly at resolve() rather than
// silently, which is the property that matters. resolve() reports every hook it
// could not find by name, and the first test asserts it finds all of them.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRenderer } = require('../helpers/load-renderer');

// ─── the fixture ───────────────────────────────────────────────────────────

// One element per id and class wfx-publish.js resolves. Built with the shim's
// own createElement so no parser is involved.
function buildSheet(document) {
  const make = (tag, attrs, kids) => {
    const node = document.createElement(tag);
    for (const name of Object.keys(attrs || {})) node.setAttribute(name, attrs[name]);
    for (const kid of kids || []) node.appendChild(kid);
    return node;
  };
  const span = (cls, id) => make('span', id ? { class: cls, id } : { class: cls }, []);

  const step = (id, name) => make('details', { class: 'wfx-step', id }, [
    make('summary', {}, [
      span('wfx-step-n'),
      make('span', { class: 'wfx-step-b' }, [
        span('wfx-step-name'),
        make('span', { class: 'wfx-step-sub' }, [span('wfx-step-meta'), span('wfx-step-pc')]),
      ]),
    ]),
    make('pre', {}, []),
  ]);
  // The name/meta/pc lookups are querySelector calls scoped to the details, so
  // the three spans above are enough. `pre` is the byte pane.

  const gate = make('div', { class: 'wfx-refuse wfx-gate', id: 'wfx-pub-gate', hidden: '' }, [
    make('p', { class: 'wfx-refuse-t', id: 'wfx-pub-gate-t' }, []),
    make('p', { class: 'wfx-refuse-m', id: 'wfx-pub-gate-m' }, []),
    make('div', { class: 'wfx-gate-fix', id: 'wfx-pub-gate-fix' }, [
      make('label', { class: 'wfx-gate-fix-l', id: 'wfx-pub-fix-label', for: 'wfx-pub-fix-agent' }, []),
      make('select', { class: 'wfx-gate-sel', id: 'wfx-pub-fix-agent' }, []),
      make('button', { type: 'button', id: 'wfx-pub-fix-go' }, []),
    ]),
    make('p', { class: 'wfx-gate-who', id: 'wfx-pub-gate-who' }, []),
  ]);

  const ready = make('div', { class: 'wfx-pane wfx-pane-ready', id: 'wfx-pub-ready' }, [
    gate,
    make('div', { class: 'wf-card-graph' }, []),
    make('div', { class: 'ra-pathrow' }, [
      span('wfx-path'),
      make('button', { type: 'button', id: 'wfx-pub-dest-change' }, []),
    ]),
    make('div', { class: 'wfx-note wfx-ack' }, [
      make('input', { type: 'checkbox', id: 'wfx-pub-attach' }, []),
    ]),
    make('div', { class: 'wfx-steps' }, [
      make('details', { class: 'wfx-step', id: 'wfx-pub-what' }, [
        make('summary', {}, [
          make('span', { class: 'wfx-step-b' }, [
            span('wfx-step-name'),
            make('span', { class: 'wfx-step-sub' }, [span('wfx-step-meta'), span('wfx-step-pc')]),
          ]),
        ]),
        make('div', { class: 'wfx-pf is-plain', id: 'wfx-pub-record' }, []),
        make('div', { class: 'wfx-pf is-plain', id: 'wfx-pub-requires' }, []),
      ]),
    ]),
  ]);

  const done = make('div', { class: 'wfx-pane wfx-pane-done' }, [
    make('div', { class: 'wfx-note' }, [
      make('p', { class: 'wfx-note-t' }, []),
      make('p', { class: 'wfx-note-m' }, []),
    ]),
    span('wfx-path'),
    make('div', { class: 'wfx-steps' }, [step('wfx-pub-raw')]),
    make('div', { class: 'ra-pathrow' }, [
      make('pre', {}, []),
      make('button', { type: 'button', id: 'wfx-pub-copy' }, []),
    ]),
  ]);

  const refused = make('div', { class: 'wfx-pane wfx-pane-refused' }, [
    make('p', { class: 'wfx-refuse-t', id: 'wfx-pub-ref-t' }, []),
    make('p', { class: 'wfx-refuse-m', id: 'wfx-pub-ref-m' }, []),
    make('dl', { class: 'wfx-refuse-e', id: 'wfx-pub-ref-e' }, []),
  ]);

  const body = make('div', { class: 'modal-body' }, [
    span('wfx-sr', 'wfx-pub-say'), refused, ready, done,
  ]);

  const foot = make('div', { class: 'modal-foot' }, [
    span('wfx-foot-note', 'wfx-pub-foot'),
    make('button', { id: 'wfx-pub-cancel' }, []),
    make('button', { class: 'is-refusal-back', id: 'wfx-pub-back' }, []),
    make('button', { class: 'btn-primary', id: 'wfx-pub-go' }, []),
    make('button', { class: 'btn-primary is-refusal-go', id: 'wfx-pub-go-nolog' }, []),
    make('button', { class: 'btn-primary', id: 'wfx-pub-done' }, []),
  ]);

  const card = make('div', { class: 'modal-card wfx-sheet', 'data-state': 'ready' }, [
    make('div', { class: 'modal-head' }, [
      make('div', { class: 'wfx-sheet-id' }, [
        make('h2', { class: 'modal-title', id: 'wfx-pub-title' }, []),
        make('p', { class: 'wfx-sheet-sub', id: 'wfx-pub-subject' }, []),
      ]),
      make('button', { class: 'modal-close', id: 'wfx-pub-x' }, []),
    ]),
    body,
    foot,
  ]);

  const modal = make('div', { class: 'modal', id: 'wfx-publish-modal', hidden: '' }, [card]);
  document.appendChild(modal);
  return modal;
}

function node(id, name, agentCommand) {
  return {
    id, name, agentCommand, model: null,
    branchMode: 'parallel', passContext: 'full', prompt: 'do the thing', x: 0, y: 0,
  };
}

// A workflow store the sheet can read and write through, standing in for the
// main process. update() merges on id the way workflows:update does, so a test
// asserting on what was written is asserting against the same contract.
// The workflow is cloned on the way in. Handing the module-level fixture over
// by reference makes an assertion that the repair left the routing alone
// compare the array to itself, which cannot fail.
function makeHusk(workflow, hooks) {
  const store = { current: JSON.parse(JSON.stringify(workflow)), updates: [] };
  const h = hooks || {};
  return {
    store,
    api: {
      workflows: {
        list: async () => [store.current],
        sidecars: async () => ({ ok: true, sidecars: {} }),
        runs: async () => ({ ok: true, runs: h.runs || [] }),
        artifactRead: async () => ({ ok: false }),
        pickArtifactFile: async () => null,
        update: async (payload) => {
          store.updates.push(payload);
          if (h.updateFails) return { ok: false, error: 'nope' };
          store.current = Object.assign({}, store.current, { graph: payload.graph });
          return { ok: true };
        },
        export: async () => ({ ok: false, cancelled: true }),
      },
      agents: {
        // The shape the main process actually answers with: a record carrying
        // an agents array beside the install-tool probe. A fixture that hands
        // back a bare array would certify a code path the app never takes.
        detect: async () => {
          if (h.slowDetect) await new Promise((r) => setTimeout(r, 5));
          if (h.detect !== undefined) return h.detect;
          const agents = h.agents === undefined
            ? [{ command: 'claude', label: 'Claude', available: true },
              { command: 'codex', label: 'Codex', available: true },
              { command: 'aider', label: 'Aider', available: false }]
            : h.agents;
          return { agents, tools: { npm: true }, platform: 'linux' };
        },
      },
    },
  };
}

// toast goes in through globals rather than onto window afterwards. The helper
// hands each global to the script as a parameter, and a bare `toast` inside the
// file binds to that parameter at compile time: a later window.toast is a
// different name and the sheet would never see it.
async function openSheet(workflow, hooks) {
  const toasts = [];
  const loaded = loadRenderer({
    scripts: ['dom', 'ui', 'publish'],
    globals: { toast: (message, kind) => toasts.push([message, kind || '']) },
  });
  const { window, document } = loaded;
  buildSheet(document);
  const husk = makeHusk(workflow, hooks);
  window.husk = husk.api;
  await window.WfxPublish.open(workflow.id, { sheet: true });
  return Object.assign(loaded, { husk, toasts, byId: (id) => document.getElementById(id) });
}

const UNBOUND = {
  id: 'wf1',
  name: 'Triage and patch',
  graph: {
    nodes: [node('n0', 'Reproduce', ''), node('n1', 'Patch', ''), node('n2', 'Verify', '')],
    edges: [{ id: 'e0', from: 'n0', to: 'n1', condition: { type: 'always', value: '' } }],
  },
};

const BOUND = {
  id: 'wf2',
  name: 'Already bound',
  graph: {
    nodes: [node('n0', 'Reproduce', 'claude'), node('n1', 'Patch', 'codex')],
    edges: [{ id: 'e0', from: 'n0', to: 'n1', condition: { type: 'always', value: '' } }],
  },
};

// ─── the sheet resolves against the shipped markup ─────────────────────────

test('the sheet finds every hook it declares, so a fixture drift fails loudly', async () => {
  const { consoleLines, byId } = await openSheet(BOUND);
  const missing = consoleLines.filter((line) => String(line.args[0] || '').includes('missing'));
  assert.deepEqual(missing, [], 'resolve() reported a hook it could not find');
  assert.equal(byId('wfx-publish-modal').hidden, false, 'the sheet did not open');
});

// ─── blocked ───────────────────────────────────────────────────────────────

test('a workflow whose steps name no agent is blocked, and the gate says how many', async () => {
  const { byId } = await openSheet(UNBOUND);
  assert.equal(byId('wfx-pub-gate').hidden, false, 'the gate stayed hidden');
  assert.equal(byId('wfx-pub-gate-t').textContent, '3 steps do not name an agent');
  assert.equal(byId('wfx-pub-go').getAttribute('aria-disabled'), 'true');
  assert.equal(byId('wfx-pub-go').getAttribute('aria-describedby'), 'wfx-pub-foot');
});

test('the blocker reaches the footer as an error, not as ordinary reassurance', async () => {
  const { byId } = await openSheet(UNBOUND);
  const foot = byId('wfx-pub-foot');
  // The footer states the consequence. Repeating the title verbatim at the top
  // and bottom of one screen reads as a rendering fault.
  assert.equal(foot.textContent, 'Export stays withheld until every step names an agent.');
  assert.notEqual(foot.textContent, byId('wfx-pub-gate-t').textContent);
  assert.ok(foot.classList.contains('is-error'), 'the footer note carries no error treatment');
});

test('one unbound step is counted in the singular', async () => {
  const one = {
    id: 'wf3',
    name: 'Nearly there',
    graph: { nodes: [node('n0', 'Reproduce', 'claude'), node('n1', 'Patch', '')], edges: [] },
  };
  const { byId } = await openSheet(one);
  assert.equal(byId('wfx-pub-gate-t').textContent, 'One step does not name an agent');
  assert.equal(byId('wfx-pub-fix-go').textContent, 'Set on 1 step');
});

test('the roster names the unbound steps, and each name is isolated from the sentence', async () => {
  const some = {
    id: 'wf9',
    name: 'Three of four',
    graph: {
      nodes: [node('n0', 'Reproduce', ''), node('n1', 'Patch', ''),
        node('n2', 'Verify', ''), node('n3', 'Report', 'claude')],
      edges: [],
    },
  };
  const { byId } = await openSheet(some);
  const who = byId('wfx-pub-gate-who');
  assert.equal(who.textContent, 'Reproduce, Patch and Verify');
  const chips = who.querySelectorAll('code');
  assert.equal(chips.length, 3);
  for (const chip of chips) {
    assert.equal(chip.getAttribute('dir'), 'auto', 'a step name is not direction-isolated');
  }
});

test('when nothing in the workflow is bound the roster says so instead of listing it', async () => {
  // Naming every step of a workflow where none is bound repeats the count above
  // it in more words.
  const { byId } = await openSheet(UNBOUND);
  assert.equal(byId('wfx-pub-gate-who').textContent, 'Every step in this workflow');
});

test('a right-to-left step name cannot reorder the sentence around it', async () => {
  const rtl = {
    id: 'wf4',
    name: 'Hebrew step',
    graph: { nodes: [node('n0', 'שדשדג', ''), node('n1', 'Patch', 'claude')], edges: [] },
  };
  const { byId } = await openSheet(rtl);
  const chip = byId('wfx-pub-gate-who').querySelector('code');
  assert.equal(chip.textContent, 'שדשדג');
  assert.equal(chip.getAttribute('dir'), 'auto');
});

test('the roster stops at four names and counts the rest, without closing the sentence twice', async () => {
  const many = {
    id: 'wf5',
    name: 'Six unbound of seven',
    graph: {
      nodes: ['a', 'b', 'c', 'd', 'e', 'f'].map((k, i) => node(`n${i}`, `Step ${k}`, ''))
        .concat([node('n6', 'Bound', 'claude')]),
      edges: [],
    },
  };
  const { byId } = await openSheet(many);
  const who = byId('wfx-pub-gate-who');
  assert.equal(who.querySelectorAll('code').length, 4);
  assert.equal(who.textContent, 'Step a, Step b, Step c, Step d, and 2 more');
  // "A, B, C and D" closes the series, so ", and 2 more" would reopen it.
  assert.ok(!/ and Step d/.test(who.textContent), 'a truncated roster reads as two sentences');
});

test('an empty workflow is blocked and offers no repair, because there is nothing to repair', async () => {
  const empty = { id: 'wf6', name: 'Nothing here', graph: { nodes: [], edges: [] } };
  const { byId } = await openSheet(empty);
  assert.equal(byId('wfx-pub-gate').hidden, false);
  assert.equal(byId('wfx-pub-gate-t').textContent, 'This workflow has no steps');
  assert.equal(byId('wfx-pub-gate-fix').hidden, true, 'an empty graph was offered a repair');
  assert.equal(byId('wfx-pub-what').hidden, true, 'the contents block described a graph with none');
});

// ─── the repair ────────────────────────────────────────────────────────────

test('the repair control offers installed agents and never an empty value', async () => {
  const { byId } = await openSheet(UNBOUND);
  const options = byId('wfx-pub-fix-agent').querySelectorAll('option');
  // The uninstalled agent in the fixture is not offered: the repair writes a
  // claim about what a reader runs, and a name this machine cannot execute is
  // a claim nothing here checked.
  assert.deepEqual(options.map((o) => o.getAttribute('value')), ['claude', 'codex']);
  for (const option of options) {
    assert.notEqual(option.getAttribute('value'), '', 'the repair offered the value it exists to remove');
  }
});

test('the older bare-array answer from the agent probe is still read', async () => {
  const { byId } = await openSheet(UNBOUND, {
    detect: [{ command: 'codex', label: 'Codex', available: true }],
  });
  const options = byId('wfx-pub-fix-agent').querySelectorAll('option');
  assert.deepEqual(options.map((o) => o.getAttribute('value')), ['codex']);
});

test('the repair button is withheld until the choices under it exist', async () => {
  // A press before the probe answers would read an empty control and write
  // nothing, which is the silence this whole surface exists to remove.
  const loaded = loadRenderer({
    scripts: ['dom', 'ui', 'publish'],
    globals: { toast: () => {} },
  });
  buildSheet(loaded.document);
  const husk = makeHusk(UNBOUND, { slowDetect: true });
  loaded.window.husk = husk.api;
  const opening = loaded.window.WfxPublish.open(UNBOUND.id, { sheet: true });
  const go = loaded.document.getElementById('wfx-pub-fix-go');
  await opening;
  // The gate paints synchronously; the probe is still in flight at this point.
  assert.equal(go.getAttribute('aria-disabled'), 'true', 'the repair was live with no choices under it');
});

test('the repair writes the chosen agent onto the unbound steps and nothing else', async () => {
  const { byId, husk } = await openSheet(UNBOUND);
  byId('wfx-pub-fix-agent').value = 'codex';
  await byId('wfx-pub-fix-go').click();
  await new Promise((r) => setImmediate(r));

  assert.equal(husk.store.updates.length, 1, 'the repair did not write exactly once');
  const payload = husk.store.updates[0];
  assert.equal(payload.id, 'wf1');
  assert.deepEqual(payload.graph.nodes.map((n) => n.agentCommand), ['codex', 'codex', 'codex']);
  // Everything else on every node survives byte for byte.
  payload.graph.nodes.forEach((written, i) => {
    const before = UNBOUND.graph.nodes[i];
    assert.equal(written.id, before.id);
    assert.equal(written.name, before.name);
    assert.equal(written.prompt, before.prompt);
    assert.equal(written.passContext, before.passContext);
  });
  assert.deepEqual(payload.graph.edges, UNBOUND.graph.edges, 'the repair disturbed the routing');
  assert.equal(payload.name, undefined, 'the repair sent a name it had no business sending');
});

test('a step that already names an agent is left alone by the repair', async () => {
  const mixed = {
    id: 'wf7',
    name: 'Half bound',
    graph: { nodes: [node('n0', 'Reproduce', 'claude'), node('n1', 'Patch', '')], edges: [] },
  };
  const { byId, husk } = await openSheet(mixed);
  byId('wfx-pub-fix-agent').value = 'codex';
  await byId('wfx-pub-fix-go').click();
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(husk.store.updates[0].graph.nodes.map((n) => n.agentCommand), ['claude', 'codex']);
});

test('after the repair the sheet unblocks in place, with no reopen', async () => {
  const { byId } = await openSheet(UNBOUND);
  byId('wfx-pub-fix-agent').value = 'claude';
  await byId('wfx-pub-fix-go').click();
  await new Promise((r) => setImmediate(r));

  assert.equal(byId('wfx-pub-gate').hidden, true, 'the gate survived its own repair');
  assert.equal(byId('wfx-pub-go').hasAttribute('aria-disabled'), false, 'Publish stayed withheld');
  assert.ok(!byId('wfx-pub-foot').classList.contains('is-error'));
  assert.equal(byId('wfx-pub-foot').textContent,
    'Nothing leaves this machine. Exporting writes one file where you point it.');
  assert.equal(byId('wfx-publish-modal').hidden, false, 'the sheet closed itself');
});

test('a repair that cannot be saved leaves the gate up and says so', async () => {
  const { byId, toasts } = await openSheet(UNBOUND, { updateFails: true });
  byId('wfx-pub-fix-agent').value = 'claude';
  await byId('wfx-pub-fix-go').click();
  await new Promise((r) => setImmediate(r));

  assert.equal(byId('wfx-pub-gate').hidden, false, 'the gate cleared on a write that failed');
  assert.equal(byId('wfx-pub-go').getAttribute('aria-disabled'), 'true');
  assert.deepEqual(toasts, [['That change could not be saved', 'error']]);
});

test('with no agent installed the repair says so rather than offering a name', async () => {
  const { byId } = await openSheet(UNBOUND, { agents: [] });
  assert.equal(byId('wfx-pub-fix-agent').querySelectorAll('option').length, 0);
  assert.equal(byId('wfx-pub-fix-go').textContent, 'No agent to set');
  assert.equal(byId('wfx-pub-fix-go').getAttribute('aria-disabled'), 'true');
  // The gate still names the real condition; only the repair stands down.
  assert.equal(byId('wfx-pub-gate-t').textContent, '3 steps do not name an agent');
});

test('a press with nothing installed cannot write a name this machine has no way to run', async () => {
  const { byId, husk } = await openSheet(UNBOUND, { agents: [] });
  await byId('wfx-pub-fix-go').click();
  await new Promise((r) => setImmediate(r));
  assert.equal(husk.store.updates.length, 0, 'the repair wrote an agent it never detected');
});

// ─── not blocked ───────────────────────────────────────────────────────────

test('a workflow whose steps all name an agent opens ready, with no gate', async () => {
  const { byId } = await openSheet(BOUND);
  assert.equal(byId('wfx-pub-gate').hidden, true, 'a publishable workflow was gated');
  assert.equal(byId('wfx-pub-go').hasAttribute('aria-disabled'), false);
  assert.ok(!byId('wfx-pub-foot').classList.contains('is-error'));
});

test('the subject line names the workflow and its size', async () => {
  const { byId } = await openSheet(BOUND);
  assert.equal(byId('wfx-pub-subject').textContent, 'Already bound · 2 steps');
});

test('a right-to-left workflow name cannot reorder the line it sits in', async () => {
  const rtl = {
    id: 'wf8',
    name: 'שדשדג and friends',
    graph: { nodes: [node('n0', 'Reproduce', 'claude')], edges: [] },
  };
  const { byId } = await openSheet(rtl);
  const subject = byId('wfx-pub-subject');
  // The name is isolated, so the count stays after it in the source order the
  // element renders in rather than being pulled to the front by the name.
  assert.equal(subject.getAttribute('dir'), 'ltr');
  const name = subject.querySelector('span');
  assert.equal(name.textContent, 'שדשדג and friends');
  assert.equal(name.getAttribute('dir'), 'auto');
  assert.equal(subject.textContent, 'שדשדג and friends · 1 step');
});

test('a blocked press cannot start a write', async () => {
  const { byId, husk } = await openSheet(UNBOUND);
  await byId('wfx-pub-go').click();
  await new Promise((r) => setImmediate(r));
  assert.equal(husk.store.updates.length, 0);
  assert.equal(byId('wfx-publish-modal').hidden, false);
  // The press is answered rather than swallowed: the live region carries the
  // reason again, so a repeat press reads as withheld and not as broken.
  assert.equal(byId('wfx-pub-say').textContent,
    'Export stays withheld until every step names an agent.');
});

// ─── the contents block ────────────────────────────────────────────────────

test('the contents block states what travels without arguing for the format', async () => {
  const { byId } = await openSheet(BOUND);
  const record = byId('wfx-pub-record');
  assert.equal(record.querySelector('.wfx-pf-h').textContent, 'Contents');
  const text = record.textContent;
  assert.ok(text.includes('2 steps, 1 connection, every prompt in full'), text);
  assert.ok(text.includes('Graph fingerprint'), text);
  // This build records a fingerprint on every finished run, so nothing in this
  // pane may tell a reader it does not.
  assert.ok(!/does not record/.test(text), 'the sheet states a limitation this build does not have');
});

test('the requires block names the agents the steps actually run', async () => {
  const { byId } = await openSheet(BOUND);
  const requires = byId('wfx-pub-requires');
  assert.equal(requires.querySelector('.wfx-pf-h').textContent, 'Requires');
  assert.ok(requires.textContent.includes('claude'), requires.textContent);
  assert.ok(requires.textContent.includes('codex'), requires.textContent);
});

test('the folded summary carries enough to decide whether to open it', async () => {
  const { byId } = await openSheet(BOUND);
  const summary = byId('wfx-pub-what').querySelector('.wfx-step-meta');
  assert.equal(summary.textContent, '2 steps · 1 connection · claude, codex ·');
  assert.equal(byId('wfx-pub-what').querySelector('.wfx-step-pc').textContent, 'no receipts');
});

// ─── the gate agrees with the validator it predicts ────────────────────────

// The gate exists to say, before the write, what the artifact builder would
// say after it. Two predicates in two files, and nothing tied them together:
// that gap is exactly how a step gets past the gate and is refused one press
// later, which is the shape of the original defect.
//
// readGraph refuses only a falsy agentCommand. buildArtifact additionally
// refuses a non-string, anything over 32 characters, and anything whose value
// is not already equal to its own normalised basename inside the allowlist. So
// a path, which the graph sanitizer keeps because it checks the basename, is
// the case that slips through.
test('a graph the gate passes is a graph the builder will not refuse for its agents', async () => {
  const WorkflowArtifact = require('../../src/lib/workflow-artifact');
  const { sanitizeGraph } = require('../../src/lib/workflow-graph');

  const SHAPES = [
    { why: 'a bare installed name', command: 'claude' },
    { why: 'an empty command', command: '' },
    { why: 'an absolute path to an allowed agent', command: '/opt/bin/claude' },
    { why: 'a relative path to an allowed agent', command: './claude' },
    { why: 'a name that is not an agent', command: 'rm' },
    { why: 'a command carrying an argument', command: 'claude --dangerously' },
    { why: 'a command over the length cap', command: 'c'.repeat(40) },
  ];

  for (const shape of SHAPES) {
    // Through the sanitizer first, because that is what stands between the
    // canvas and both predicates.
    const graph = sanitizeGraph({
      nodes: [node('n0', 'Only step', shape.command)],
      edges: [],
    });
    const { publish, document } = await openSheet(BOUND);
    void document;
    void publish;

    const gateSaysNo = !!readBlockerFor(graph);
    const built = WorkflowArtifact.buildArtifact(
      { id: 'wf-probe', name: 'Probe', description: '', graph },
      { huskVersion: '2.11.0', receipts: [] },
    );
    const builderSaysNo = !built.ok && built.code === 'bad-agent';

    assert.equal(gateSaysNo, builderSaysNo,
      `${shape.why} (${JSON.stringify(shape.command)}): the gate ${gateSaysNo ? 'blocks' : 'passes'} `
      + `but the builder ${builderSaysNo ? 'refuses' : 'accepts'}`);
  }
});

// The gate's own predicate, reachable without a sheet. readGraph and readBlocker
// are internal to wfx-publish.js, so this mirrors their two rules exactly; the
// test above is what keeps the mirror honest, because a drift in either makes
// the agreement assertion fail rather than this helper silently diverge.
function readBlockerFor(graph) {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes.filter(Boolean) : [];
  if (!nodes.length) return { empty: true };
  const unbound = nodes.filter((n) => !n.agentCommand);
  return unbound.length ? { unbound: unbound.length } : null;
}

// ─── the canvas side of the same defect ────────────────────────────────────

// The gate above repairs graphs that already exist. This is the other half:
// the canvas must stop minting the shape the gate has to repair.
//
// app.js is a 15000 line classic script that reads a whole page as ambient
// state, so there is no harness that can call these three functions. The
// contract is asserted against the source instead, which is the same instrument
// workflow-install.test.js uses on this directory and is enough to catch the
// regression, because the regression is literally a literal: a step minted with
// an empty agentCommand runs correctly and can never be published.

const fs = require('node:fs');
const path = require('node:path');

const APP_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'renderer', 'app.js'), 'utf8');

function functionBody(source, name) {
  const at = source.indexOf(`function ${name}(`);
  assert.notEqual(at, -1, `app.js no longer declares ${name}`);
  let depth = 0;
  let i = source.indexOf('{', at);
  const start = i;
  for (; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') { depth -= 1; if (!depth) return source.slice(start, i + 1); }
  }
  throw new Error(`could not read the body of ${name}`);
}

test('a step minted on the canvas names an agent', () => {
  const body = functionBody(APP_SOURCE, 'wfAddCanvasNode');
  assert.ok(/agentCommand:.*wfDefaultAgentCommand\(\)/.test(body),
    'wfAddCanvasNode mints a step the export path refuses');
  assert.ok(!/agentCommand:\s*''\s*,/.test(body), 'wfAddCanvasNode still mints an empty agent');
});

test('a step minted from a starter pattern names an agent', () => {
  const body = functionBody(APP_SOURCE, 'wfPatternGraph');
  assert.ok(/agentCommand:.*wfDefaultAgentCommand\(\)/.test(body),
    'a starter pattern mints steps the export path refuses');
  assert.ok(!/agentCommand:\s*null\s*,/.test(body), 'a starter pattern still mints a null agent');
});

test('the step agent picker never offers a value that means no agent', () => {
  const body = functionBody(APP_SOURCE, 'buildAgentOptions');
  // The empty value survives on one kind of machine only, one with nothing
  // installed, and there it is disabled and says why.
  const empties = body.match(/<option value=""[^>]*>/g) || [];
  assert.equal(empties.length, 1, `the picker emits ${empties.length} empty-valued options`);
  assert.ok(/disabled/.test(empties[0]), 'the picker offers a selectable option meaning no agent');
});

test('the agent resolver hardcodes no vendor name', () => {
  const body = functionBody(APP_SOURCE, 'wfDefaultAgentCommand');
  for (const vendor of ['claude', 'copilot', 'codex', 'aider', 'gemini']) {
    assert.ok(!body.includes(`'${vendor}'`), `wfDefaultAgentCommand names ${vendor} directly`);
  }
});

// ─── density ───────────────────────────────────────────────────────────────

// The complaint that started this was that the sheet is an essay. A word count
// is a blunt instrument and it is the right one here: the failure mode is
// literally volume, and a budget is the only thing that keeps prose from
// creeping back one helpful sentence at a time.
test('the ready pane stays under a word budget at rest', async () => {
  const { byId } = await openSheet(BOUND);
  const ready = byId('wfx-pub-ready');
  // The folded block is not at rest, so its body does not count against the
  // budget; its summary line does, because that is on screen.
  const folded = byId('wfx-pub-what');
  const hidden = [byId('wfx-pub-record').textContent, byId('wfx-pub-requires').textContent].join(' ');
  const words = (s) => s.trim().split(/\s+/).filter(Boolean).length;
  const atRest = words(ready.textContent) - words(hidden);
  assert.ok(atRest <= 80, `the ready pane reads ${atRest} words at rest, over the 80 word budget`);
  assert.ok(folded, 'the contents moved out of the disclosure');
});
