'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  HUSK_SESSION_START,
  HUSK_SESSION_END,
  buildGenericDirectives,
  mergeSessionBlock,
  planInjection,
} = require('../../src/lib/agent-inject');

// ─── planInjection: per-agent mechanism ──────────────────────────────────────

test('claude gets a --append-system-prompt arg, no file', () => {
  const plan = planInjection({ agentCommand: 'claude', agentName: 'Husk', recap: true });
  assert.equal(plan.method, 'system-prompt-arg');
  assert.equal(plan.args[0], '--append-system-prompt');
  assert.equal(typeof plan.args[1], 'string');
  assert.ok(plan.args[1].includes('Husk'));
});

test('copilot gets an instructions-file plan at .github/copilot-instructions.md', () => {
  const plan = planInjection({ agentCommand: 'copilot', agentName: 'Husk', recap: true });
  assert.equal(plan.method, 'instructions-file');
  assert.equal(plan.filePath, '.github/copilot-instructions.md');
  assert.ok(plan.body.includes('Husk'));
  // The speech-balloon line the desktop voice reads.
  assert.ok(plan.body.includes('\u{1F5E3}'));
});

test('copilot.exe / full path resolves to the copilot plan', () => {
  assert.equal(planInjection({ agentCommand: '/usr/local/bin/copilot --foo' }).method, 'instructions-file');
});

test('an unknown agent gets no injection', () => {
  assert.equal(planInjection({ agentCommand: 'aider' }).method, 'none');
  assert.equal(planInjection({ agentCommand: 'codex' }).method, 'none');
});

// ─── buildGenericDirectives ──────────────────────────────────────────────────

test('directives name the agent and ask for the speech-balloon line', () => {
  const d = buildGenericDirectives({ agentName: 'Ada', recap: true });
  assert.ok(d.includes('Ada'));
  assert.ok(d.includes('\u{1F5E3}\u{FE0F} Ada:'));
});

test('recap=false adds the suppression line; recap=true does not', () => {
  assert.ok(buildGenericDirectives({ agentName: 'X', recap: false }).includes('Do not add'));
  assert.ok(!buildGenericDirectives({ agentName: 'X', recap: true }).includes('Do not add'));
});

test('an empty or all-stripped name falls back to Husk; unsafe chars removed', () => {
  assert.ok(buildGenericDirectives({ agentName: '' }).includes('Husk'));
  assert.ok(buildGenericDirectives({ agentName: '<<<>>>' }).includes('Husk'));
  const d = buildGenericDirectives({ agentName: '<script>' });
  assert.ok(d.includes('answer as script'));
  assert.ok(!d.includes('<script>'));
});

// ─── mergeSessionBlock: non-destructive ──────────────────────────────────────

test('empty document becomes just the managed block', () => {
  const out = mergeSessionBlock('', 'hello');
  assert.ok(out.includes(HUSK_SESSION_START));
  assert.ok(out.includes(HUSK_SESSION_END));
  assert.ok(out.includes('hello'));
});

test('existing markers are replaced in place; surrounding content preserved', () => {
  const existing = `# My team rules\nKeep PRs small.\n\n${HUSK_SESSION_START}\nOLD\n${HUSK_SESSION_END}\n\n# Footer notes\nbe nice`;
  const out = mergeSessionBlock(existing, 'NEW DIRECTIVE');
  assert.ok(out.includes('# My team rules'));
  assert.ok(out.includes('Keep PRs small.'));
  assert.ok(out.includes('# Footer notes'));
  assert.ok(out.includes('be nice'));
  assert.ok(out.includes('NEW DIRECTIVE'));
  assert.ok(!out.includes('OLD'));
  // exactly one managed block
  assert.equal(out.split(HUSK_SESSION_START).length - 1, 1);
});

test('a document without markers keeps its content and appends the block', () => {
  const existing = '# Existing copilot instructions\nUse tabs.';
  const out = mergeSessionBlock(existing, 'directive');
  assert.ok(out.includes('# Existing copilot instructions'));
  assert.ok(out.includes('Use tabs.'));
  assert.ok(out.includes(HUSK_SESSION_START));
  assert.ok(out.indexOf('Use tabs.') < out.indexOf(HUSK_SESSION_START));
});
