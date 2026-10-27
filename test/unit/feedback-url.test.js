'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { issueUrl, REPO } = require('../../src/lib/feedback-url');

test('bug and feature links point at the repo with the right label, title and environment block', () => {
  const bug = new URL(issueUrl('bug', { huskVersion: '2.12.0', platform: 'linux', arch: 'x64', osVersion: '7.0', electron: '41.10.6', agentCommand: 'claude', agentVersion: '2.1.310', chatView: 'chat' }));
  assert.equal(bug.origin + bug.pathname, REPO + '/issues/new');
  assert.equal(bug.searchParams.get('labels'), 'bug');
  assert.equal(bug.searchParams.get('title'), '[Bug] ');
  const body = bug.searchParams.get('body');
  assert.match(body, /## What happened/);
  assert.match(body, /- Husk 2.12.0/);
  assert.match(body, /- OS linux x64 \(7.0\)/);
  assert.match(body, /- Agent claude 2.1.310/);
  const feat = new URL(issueUrl('feature', {}));
  assert.equal(feat.searchParams.get('labels'), 'enhancement');
  assert.equal(feat.searchParams.get('title'), '[Feature] ');
  assert.match(feat.searchParams.get('body'), /## What you would like/);
  assert.match(feat.searchParams.get('body'), /- Husk unknown/);
});
