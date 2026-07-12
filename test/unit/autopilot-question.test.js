'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildQuestionRedirect,
  isAutonomousQuestion,
  isPermissionPrompt,
  permissionPromptChoice,
} = require('../../src/lib/autopilot-question');

test('detects assistant prompts that wait for user input', () => {
  assert.equal(isAutonomousQuestion('Which package manager should I use?'), true);
  assert.equal(isAutonomousQuestion('Please confirm whether I should update major versions.'), true);
  assert.equal(isAutonomousQuestion('I need your approval before changing the lockfile.'), true);
  assert.equal(isAutonomousQuestion('Waiting for confirmation.'), true);
});

test('does not flag ordinary progress statements', () => {
  assert.equal(isAutonomousQuestion('Updated package.json and started npm install.'), false);
  assert.equal(isAutonomousQuestion('Verification passed after running npm test.'), false);
});

test('redirect tells the agent to continue without asking', () => {
  const text = buildQuestionRedirect();
  assert.match(text, /No human is available/);
  assert.match(text, /Choose the safest sensible default/);
});

test('detects Copilot tool permission menus separately from model questions', () => {
  const prompt = [
    'run this command?',
    '1. Yes',
    "2. Yes, and don't ask again for `git -C` in this repo",
    '3. No, and tell Copilot what to do differently',
  ].join('\n');
  assert.equal(isPermissionPrompt(prompt), true);
  assert.equal(permissionPromptChoice(prompt), '2');
  assert.equal(isAutonomousQuestion(prompt), false);
});
