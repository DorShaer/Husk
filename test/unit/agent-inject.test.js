'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  HUSK_SESSION_START,
  HUSK_SESSION_END,
  buildGenericDirectives,
  renderSessionBlock,
  mergeSessionBlock,
  planInjection,
} = require('../../src/lib/agent-inject');

// ─── planInjection: per-agent mechanism ──────────────────────────────────────

test('claude gets a --append-system-prompt arg, no file', () => {
  const plan = planInjection({ agentCommand: 'claude', agentName: 'Husk', recap: true });
  assert.equal(plan.method, 'system-prompt-arg');
  const sp = plan.args.indexOf('--append-system-prompt');
  assert.ok(sp !== -1);
  assert.equal(typeof plan.args[sp + 1], 'string');
  assert.ok(plan.args[sp + 1].includes('Husk'));
});

test('claude injection silences the inline statusline via merged --settings', () => {
  const plan = planInjection({ agentCommand: 'claude', agentName: 'Husk', recap: true });
  const si = plan.args.indexOf('--settings');
  assert.ok(si !== -1, 'expected a --settings arg');
  const override = JSON.parse(plan.args[si + 1]);
  // A no-op command blanks the statusline; null is rejected by the schema.
  assert.equal(override.statusLine.type, 'command');
  assert.ok(override.statusLine.command);
  // Only statusLine is overridden so the merge leaves other user settings intact.
  assert.deepEqual(Object.keys(override), ['statusLine']);
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

test('codex gets an AGENTS.md instructions-file plan', () => {
  const plan = planInjection({ agentCommand: 'codex', agentName: 'Husk', recap: true });
  assert.equal(plan.method, 'instructions-file');
  assert.equal(plan.filePath, 'AGENTS.md');
  assert.ok(plan.body.includes('Husk'));
  assert.ok(plan.body.includes('\u{1F5E3}'));
});

test('aider gets a --read plan pointing at a Husk-owned file', () => {
  const plan = planInjection({ agentCommand: 'aider', agentName: 'Husk', recap: true });
  assert.equal(plan.method, 'read-file');
  assert.equal(plan.filePath, '.husk-aider.md');
  assert.deepEqual(plan.args, ['--read', '.husk-aider.md']);
  assert.ok(plan.body.includes('Husk'));
  assert.ok(plan.body.includes('\u{1F5E3}'));
});

test('gemini gets a GEMINI.md instructions-file plan', () => {
  const plan = planInjection({ agentCommand: 'gemini', agentName: 'Husk', recap: true });
  assert.equal(plan.method, 'instructions-file');
  assert.equal(plan.filePath, 'GEMINI.md');
  assert.ok(plan.body.includes('Husk'));
  assert.ok(plan.body.includes('\u{1F5E3}'));
});

test('a truly unknown agent gets no injection', () => {
  assert.equal(planInjection({ agentCommand: 'mysteryagent' }).method, 'none');
  assert.ok(!planInjection({ agentCommand: 'mysteryagent' }).args);
});

// ─── buildGenericDirectives ──────────────────────────────────────────────────

test('directives name the agent and ask for the speech-balloon line', () => {
  const d = buildGenericDirectives({ agentName: 'Ada', recap: true });
  assert.ok(d.includes('Ada'));
  assert.ok(d.includes('\u{1F5E3}\u{FE0F} Ada:'));
  assert.ok(d.includes('~/.claude/MEMORY/CONTEXT/'));
});

test('recap=false omits the speech-balloon directive; recap=true includes it', () => {
  assert.ok(!buildGenericDirectives({ agentName: 'X', recap: false }).includes('\u{1F5E3}\u{FE0F}'));
  assert.ok(buildGenericDirectives({ agentName: 'X', recap: true }).includes('\u{1F5E3}\u{FE0F}'));
});

test('an empty or all-stripped name falls back to Husk; unsafe chars removed', () => {
  assert.ok(buildGenericDirectives({ agentName: '' }).includes('Husk'));
  assert.ok(buildGenericDirectives({ agentName: '<<<>>>' }).includes('Husk'));
  const d = buildGenericDirectives({ agentName: '<script>' });
  assert.ok(d.includes('answer as script'));
  assert.ok(!d.includes('<script>'));
});

// ─── renderSessionBlock ─────────────────────────────────────────────────────

test('renderSessionBlock wraps trimmed body in the managed marker block', () => {
  const out = renderSessionBlock('\nhello\n');
  assert.ok(out.startsWith(`${HUSK_SESSION_START}\n`));
  assert.ok(out.endsWith(`\n${HUSK_SESSION_END}`));
  assert.ok(out.includes('\nhello\n'));
  assert.equal(out.split(HUSK_SESSION_START).length - 1, 1);
  assert.equal(out.split(HUSK_SESSION_END).length - 1, 1);
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
