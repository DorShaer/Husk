'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { fallbackModelsFor, isCliStatusLine, isModelValueUsable, modelFlagFor, modelIdFromDisplayLabel, parseModelCatalog, providerLabel, titleFromId, uniqueModels } = require('../../src/lib/model-catalog');
const { modelArgsFor } = require('../../src/lib/model-routing');

test('modelFlagFor knows routed provider flags', () => {
  assert.equal(modelFlagFor('copilot'), '--model');
  assert.equal(modelFlagFor('gemini'), '-m');
  assert.equal(modelFlagFor('unknown'), null);
});

test('parseModelCatalog extracts model ids from picker-style output', () => {
  const out = `
    Select a model
    ❯ GPT-5.5 (gpt-5.5)
      Claude Sonnet 5 (claude-sonnet-5)
      Gemini 3.1 Pro Preview - gemini-3.1-pro-preview
  `;
  assert.deepEqual(parseModelCatalog(out, 'copilot'), [
    { value: 'gpt-5.5', label: 'GPT-5.5' },
    { value: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview: gemini-3.1-pro-preview' },
  ]);
});

test('parseModelCatalog deduplicates noisy ANSI output', () => {
  const out = '\x1b[32m●\x1b[0m Claude Opus (claude-opus-4-8)\n  claude-opus-4-8\n';
  assert.deepEqual(parseModelCatalog(out, 'claude'), [
    { value: 'claude-opus-4-8', label: 'Claude Opus' },
  ]);
});

test('parseModelCatalog extracts multiple models from one TUI-painted line', () => {
  const out = 'Select a model GPT-5.5 (gpt-5.5) Claude Sonnet 5 (claude-sonnet-5) Gemini 3.1 Pro Preview (gemini-3.1-pro-preview)';
  assert.deepEqual(parseModelCatalog(out, 'copilot'), [
    { value: 'gpt-5.5', label: 'GPT-5.5' },
    { value: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview' },
  ]);
});

test('parseModelCatalog treats cursor positioning as row breaks', () => {
  const out = '\x1b[10;3HGPT-5.5 (gpt-5.5)\x1b[11;3HClaude Sonnet 5 (claude-sonnet-5)';
  assert.deepEqual(parseModelCatalog(out, 'copilot'), [
    { value: 'gpt-5.5', label: 'GPT-5.5' },
    { value: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  ]);
});

test('modelIdFromDisplayLabel converts Copilot display rows to ids', () => {
  assert.equal(modelIdFromDisplayLabel('Claude Sonnet 5', 'copilot'), 'claude-sonnet-5');
  assert.equal(modelIdFromDisplayLabel('Claude Opus 4.8 (fast mode) (Preview)', 'copilot'), 'claude-opus-4.8-fast');
  assert.equal(modelIdFromDisplayLabel('GPT-5 mini', 'copilot'), 'gpt-5-mini');
  assert.equal(modelIdFromDisplayLabel('Gemini 3.1 Pro (1M context) (Preview)', 'copilot'), 'gemini-3.1-pro');
  assert.equal(modelIdFromDisplayLabel('Kimi K2.7 Code', 'copilot'), 'kimi-k2.7-code');
  assert.equal(modelIdFromDisplayLabel('MAI-Code-1-Flash', 'copilot'), 'mai-code-1-flash');
});

test('parseModelCatalog extracts Copilot table rows without hidden ids', () => {
  const out = `
    Model                                               Reasoning
  ❯ Auto
  -
    Claude Sonnet 5
  -
    Claude Sonnet 5 (1M context)
  -
    Claude Opus 4.8 (fast mode) (Preview)
  -
    GPT-5.5
  -
    GPT-5.5 (1.1M context) (current)
  Extra High
    GPT-5.4 mini
  -
    GPT-5 mini
  -
    Gemini 3.1 Pro (Preview)
  -
    Kimi K2.7 Code
  -
    MAI-Code-1-Flash
  -
    Search Search models...
  `;
  const values = parseModelCatalog(out, 'copilot').map((m) => m.value);
  assert.deepEqual(values, [
    'claude-sonnet-5',
    'claude-opus-4.8-fast',
    'gpt-5.5',
    'gpt-5.4-mini',
    'gpt-5-mini',
    'gemini-3.1-pro',
    'kimi-k2.7-code',
    'mai-code-1-flash',
  ]);
});

test('parseModelCatalog extracts Copilot table rows with Context column', () => {
  const out = `
    Model                                  Context    Reasoning
  ❯ Auto
  -
    Claude Sonnet 5
  264K
  -
    GPT-5.5 (current)
  1.1M
  Extra High
    gpt-5.6-sol
  -
  -
    gpt-5.6-terra
  -
  -
    Search Search models...
  `;
  assert.deepEqual(parseModelCatalog(out, 'copilot'), [
    { value: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    { value: 'gpt-5.5', label: 'GPT-5.5' },
    { value: 'gpt-5.6-sol', label: 'gpt-5.6-sol' },
    { value: 'gpt-5.6-terra', label: 'gpt-5.6-terra' },
  ]);
});

test('parseModelCatalog ignores Copilot status-line model text', () => {
  const out = 'devuser:~ +0 -0Session: 0 AIC usedPlan: no limit GPT-5.5 · Extra High · 1.1M context (0%)';
  assert.deepEqual(parseModelCatalog(out, 'copilot'), []);
  assert.equal(isCliStatusLine(out), true);
});

test('parseModelCatalog prefers Copilot picker rows over status-line repeats', () => {
  const out = `
    Model                                               Reasoning
    GPT-5.5
    GPT-5 mini
    Search Search models...
    devuser:~/repo Session: 0 AIC used Plan: no limit GPT-5.5 Extra High
  `;
  assert.deepEqual(parseModelCatalog(out, 'copilot'), [
    { value: 'gpt-5.5', label: 'GPT-5.5' },
    { value: 'gpt-5-mini', label: 'GPT-5 mini' },
  ]);
});

test('parseModelCatalog extracts Claude slash-model choices', () => {
  const out = `
    Select model
    1. Default (recommended) - Opus 4.8 with 1M context
    2. (selected) Opus - Opus 4.8 with 1M context
    3. Fable \u2014 Fable 5 · Most capable
    4. Sonnet \u2014 Sonnet 5 · Efficient
    5. Haiku \u2014 Haiku 4.5 · Fastest
  `;
  assert.deepEqual(parseModelCatalog(out, 'claude'), [
    { value: 'opus', label: 'Opus 4.8 with 1M context' },
    { value: 'fable', label: 'Fable 5 · Most capable' },
    { value: 'sonnet', label: 'Sonnet 5 · Efficient' },
    { value: 'haiku', label: 'Haiku 4.5 · Fastest' },
  ]);
});

test('claude long-context row keeps its own id and reads like the other rows', () => {
  const out = `
    Select model
    1. Default (recommended) - Opus 5
    2. (selected) Opus - Opus 5 · Best for everyday use
    3. Opus (1M context) - Opus 5 with 1M context · Best for everyday use
    4. Fable — Fable 5 · Most capable
    5. Haiku — Haiku 4.5 · Fastest
  `;
  assert.deepEqual(parseModelCatalog(out, 'claude'), [
    { value: 'opus', label: 'Opus 5 · Best for everyday use' },
    { value: 'opus[1m]', label: 'Opus 5 With 1M Context · Best for everyday use' },
    { value: 'fable', label: 'Fable 5 · Most capable' },
    { value: 'haiku', label: 'Haiku 4.5 · Fastest' },
  ]);
});

test('the long-context id survives every gate between the picker and --model', () => {
  assert.equal(isModelValueUsable('opus[1m]', 'claude'), true);
  assert.equal(isModelValueUsable('claude-opus-5[1m]', 'claude'), true);
  assert.deepEqual(
    modelArgsFor('claude', 'smart', { claude: { flag: '--model', smart: 'opus[1m]' } }),
    ['--model', 'opus[1m]'],
  );
});

test('claude probe noise (config paths, API references) yields no model candidates', () => {
  const out = [
    'Using Fable 5 (from .claude/settings.json)',
    'claude-api Reference for the Claude API / Anthropic SDK: model ids, pricing, params',
    'Loaded project config from .claude/settings.json',
  ].join('\n');
  assert.deepEqual(parseModelCatalog(out, 'claude'), []);
});

test('fallback catalogs exist for every routed vendor', () => {
  for (const vendor of ['claude', 'copilot', 'codex', 'gemini', 'aider']) {
    assert.ok(fallbackModelsFor(vendor).length > 0, `fallback for ${vendor}`);
  }
});

test('aider --list-models output parses provider-route ids', () => {
  const out = [
    'Models which match "":',
    '- anthropic/claude-sonnet-4-5',
    '- openrouter/z-ai/glm-4.6',
    '- gpt-5.5',
  ].join('\n');
  const values = parseModelCatalog(out, 'aider').map((m) => m.value);
  assert.ok(values.includes('anthropic/claude-sonnet-4-5'));
  assert.ok(values.includes('openrouter/z-ai/glm-4.6'));
  assert.ok(values.includes('gpt-5.5'));
});

test('isModelValueUsable trusts saved aider aliases and routes', () => {
  assert.equal(isModelValueUsable('flash', 'aider'), true);
  assert.equal(isModelValueUsable('r1', 'aider'), true);
  assert.equal(isModelValueUsable('openrouter/z-ai/glm-4.6', 'aider'), true);
  assert.equal(isModelValueUsable('flash', 'copilot'), false);
});

test('provider labels and generated titles are readable', () => {
  assert.equal(providerLabel('copilot'), 'GitHub Copilot');
  assert.equal(titleFromId('claude-sonnet-5'), 'Claude Sonnet 5');
});

test('fallbackModelsFor returns the Copilot provider catalog', () => {
  const models = fallbackModelsFor('copilot');
  assert.ok(models.length >= 18);
  assert.ok(models.some((m) => m.value === 'claude-sonnet-5'));
  assert.ok(models.some((m) => m.value === 'gpt-5.5'));
  assert.ok(models.some((m) => m.value === 'gemini-3.5-flash'));
});

test('uniqueModels keeps a base model when a mini variant is also present', () => {
  assert.deepEqual(uniqueModels([
    { value: 'gpt-5', label: 'GPT-5', source: 'direct' },
    { value: 'gpt-5-mini', label: 'GPT-5 mini', source: 'direct' },
  ]), [
    { value: 'gpt-5', label: 'GPT-5' },
    { value: 'gpt-5-mini', label: 'GPT-5 mini' },
  ]);
});

test('isModelValueUsable rejects CLI status/auth output', () => {
  const bad = 'devuser:~ +0 -0Session: 0 AIC usedYou must be logged in to select a model. Use /login to authenticate.Plan: no limit, 18 agentsGPT-5.5 1.1M Context';
  assert.equal(isModelValueUsable(bad, 'copilot'), false);
  assert.equal(isModelValueUsable('gpt-5.5', 'copilot'), true);
  assert.equal(isModelValueUsable('claude-sonnet-5', 'copilot'), true);
});
