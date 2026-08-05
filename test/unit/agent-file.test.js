'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { agentFileName, renderAgentMd, isHuskManaged, agentMdBody } = require('../../src/lib/agent-file');

test('agentFileName slugifies and stays traversal-free', () => {
  assert.equal(agentFileName('Security Auditor'), 'security-auditor.md');
  assert.equal(agentFileName('review-agent'), 'review-agent.md');
  assert.equal(agentFileName('../../etc/passwd'), 'etc-passwd.md');
  assert.equal(agentFileName(''), 'agent.md');
  assert.equal(agentFileName('  weird  /\\ name '), 'weird-name.md');
});

test('agentFileName caps long slugs at 64 characters', () => {
  assert.equal(agentFileName('A'.repeat(80)), `${'a'.repeat(64)}.md`);
});

test('renderAgentMd builds frontmatter + body', () => {
  const md = renderAgentMd({ name: 'Sec', description: 'Finds bugs', systemPrompt: 'You are Sec.\nBe careful.' });
  assert.ok(md.startsWith('---\nname: Sec\ndescription: Finds bugs\nhusk: managed\n---\n'));
  assert.ok(md.includes('You are Sec.\nBe careful.'));
});

test('a rendered file is recognizable as one Husk owns', () => {
  assert.equal(isHuskManaged(renderAgentMd({ name: 'Sec', systemPrompt: 'body' })), true);
  // Someone else's agent file, and a body that merely mentions the marker.
  assert.equal(isHuskManaged('---\nname: Sec\n---\n\nbody'), false);
  assert.equal(isHuskManaged('---\nname: Sec\n---\n\nhusk: managed\n'), false);
  assert.equal(isHuskManaged('no frontmatter at all'), false);
});

test('agentMdBody returns the prompt without the frontmatter', () => {
  assert.equal(agentMdBody(renderAgentMd({ name: 'Sec', systemPrompt: 'You are Sec.' })), 'You are Sec.');
  assert.equal(agentMdBody('---\nname: Sec\n---\n\nhand written\n'), 'hand written');
  assert.equal(agentMdBody('bare body'), 'bare body');
});

test('renderAgentMd omits description when empty and collapses newlines in fields', () => {
  const md = renderAgentMd({ name: 'A\nB', description: '', systemPrompt: 'body' });
  assert.ok(md.includes('name: A B'));
  assert.ok(!md.includes('description:'));
});

test('renderAgentMd tolerates missing fields', () => {
  const md = renderAgentMd({});
  assert.ok(md.includes('name: agent'));
});
