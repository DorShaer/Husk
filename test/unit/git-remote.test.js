'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { webUrlFor } = require('../../src/lib/git-remote');

// The refusals are the point of this module. Anything it returns is a URL the
// app will hand to a browser, so a value it cannot fully account for has to
// come back as null.
const REFUSED = [
  ['https://user:token@github.com/a/b.git', 'a remote carrying a credential'],
  ['https://token@github.com/a/b.git', 'a remote carrying userinfo'],
  ['http://oauth2:secret@gitlab.com/a/b.git', 'a credential on a plain http remote'],
  ['javascript:alert(1)//github.com/a/b', 'a script url wearing a host'],
  ['file:///etc/passwd', 'a local file url'],
  ['data:text/html,<b>x</b>', 'a data url'],
  ['vbscript:msgbox(1)', 'a script url with no host at all'],
  ['https://github.com/a/b\n.git', 'a remote broken by a newline'],
  ['https://github.com/a/b\r\nHost: evil.com', 'a remote carrying a second line'],
  ['https://github.com/a/b\x00.git', 'a remote carrying a null byte'],
  ['https://github.com/a/b\x07.git', 'a remote carrying a control byte'],
  ['https://github.com/a/b .git', 'a remote carrying a space'],
  ['https://github.com/a/../../b.git', 'a remote walking up out of its own path'],
  ['https://github.com/', 'a remote with no repository path'],
  ['https://github.com', 'a host with no path at all'],
  ['https://[::1]/a/b.git', 'a bracketed address'],
  ['https://gith ub.com/a/b.git', 'a host with a space in it'],
  ['https://github.com:notaport/a/b.git', 'a port that is not a number'],
  ['/srv/git/repo.git', 'a local path remote'],
  ['../sibling-repo', 'a relative path remote'],
  ['', 'the empty string'],
];

test('a table of hostile remotes returns null, one case at a time', () => {
  for (const [remote, why] of REFUSED) {
    assert.strictEqual(webUrlFor(remote, { kind: 'repo' }), null, why);
  }
});

test('a hostile remote stays refused for every kind the caller can ask for', () => {
  for (const [remote, why] of REFUSED) {
    assert.strictEqual(webUrlFor(remote, { kind: 'commit', sha: '4a91c02' }), null, why);
    assert.strictEqual(webUrlFor(remote, { kind: 'file', ref: 'main', path: 'a.js', line: 3 }), null, why);
  }
});

test('malformed input returns null rather than throwing', () => {
  for (const value of [null, undefined, 0, 42, {}, [], true, Symbol.iterator]) {
    assert.strictEqual(webUrlFor(value), null, String(typeof value));
  }
  assert.strictEqual(webUrlFor('https://github.com/a/b.git', null), 'https://github.com/a/b');
  assert.strictEqual(webUrlFor('https://github.com/a/b.git', { kind: 'nonsense' }), null);
});

test('the three remote forms of one repository all convert to the same page', () => {
  const expected = 'https://github.com/DorShaer/Husk';
  assert.strictEqual(webUrlFor('https://github.com/DorShaer/Husk.git'), expected);
  assert.strictEqual(webUrlFor('git@github.com:DorShaer/Husk.git'), expected);
  assert.strictEqual(webUrlFor('ssh://git@github.com/DorShaer/Husk.git'), expected);
  assert.strictEqual(webUrlFor('git://github.com/DorShaer/Husk.git'), expected);
  assert.strictEqual(webUrlFor('https://github.com/DorShaer/Husk'), expected);
});

test('every output is https, whatever the remote asked for', () => {
  for (const remote of [
    'http://github.com/a/b.git',
    'git://github.com/a/b.git',
    'ssh://git@github.com/a/b.git',
    'git@github.com:a/b.git',
  ]) {
    const url = webUrlFor(remote);
    assert.strictEqual(new URL(url).protocol, 'https:', remote);
  }
});

test('no output ever carries a host the remote did not name', () => {
  const remotes = [
    'https://github.com/a/b.git',
    'git@gitlab.example.com:a/b.git',
    'ssh://git@bitbucket.org/a/b.git',
    'https://git.corp.example.com:8443/a/b.git',
    'https://github.com@evil.com/a/b.git',
    'git@evil.com:github.com/a/b.git',
  ];
  for (const remote of remotes) {
    const url = webUrlFor(remote, { kind: 'file', ref: 'main', path: 'src/a.js', line: 9 });
    if (url === null) continue;
    const parsed = new URL(url);
    assert.ok(remote.toLowerCase().includes(parsed.hostname), remote);
    assert.strictEqual(parsed.username, '', remote);
    assert.strictEqual(parsed.password, '', remote);
  }
});

test('a userinfo host cannot become the host of the output', () => {
  // The authority here is evil.com; github.com is only the userinfo.
  assert.strictEqual(webUrlFor('https://github.com@evil.com/a/b.git'), null);
  assert.strictEqual(new URL(webUrlFor('ssh://git@evil.com/a/b.git')).hostname, 'evil.com');
});

test('a port is dropped rather than carried into a web url', () => {
  assert.strictEqual(webUrlFor('ssh://git@github.com:22/a/b.git'), 'https://github.com/a/b');
  assert.strictEqual(webUrlFor('https://git.corp.example.com:8443/g/p.git'), 'https://git.corp.example.com/g/p');
});

test('each host family gets its own file and commit shape', () => {
  const file = { kind: 'file', ref: 'main', path: 'src/a.js', line: 12 };
  const commit = { kind: 'commit', sha: '4a91c02' };
  assert.strictEqual(webUrlFor('git@github.com:o/r.git', file), 'https://github.com/o/r/blob/main/src/a.js#L12');
  assert.strictEqual(webUrlFor('git@gitlab.com:o/r.git', file), 'https://gitlab.com/o/r/-/blob/main/src/a.js#L12');
  assert.strictEqual(webUrlFor('git@bitbucket.org:o/r.git', file), 'https://bitbucket.org/o/r/src/main/src/a.js#lines-12');
  assert.strictEqual(webUrlFor('git@git.example.com:o/r.git', file), 'https://git.example.com/o/r/blob/main/src/a.js#L12');
  assert.strictEqual(webUrlFor('git@github.com:o/r.git', commit), 'https://github.com/o/r/commit/4a91c02');
  assert.strictEqual(webUrlFor('git@gitlab.com:o/r.git', commit), 'https://gitlab.com/o/r/-/commit/4a91c02');
  assert.strictEqual(webUrlFor('git@bitbucket.org:o/r.git', commit), 'https://bitbucket.org/o/r/commits/4a91c02');
});

test('a lookalike host is not read as its famous namesake', () => {
  const file = { kind: 'file', ref: 'main', path: 'a.js' };
  assert.strictEqual(webUrlFor('git@github.com.evil.com:o/r.git', file), 'https://github.com.evil.com/o/r/blob/main/a.js');
  assert.strictEqual(webUrlFor('git@notgithub.com:o/r.git', file), 'https://notgithub.com/o/r/blob/main/a.js');
});

test('a path and a ref are encoded part by part, so neither can add a path level', () => {
  const url = webUrlFor('git@github.com:o/r.git', { kind: 'file', ref: 'feature/a b', path: 'src/lib/git ref.js' });
  assert.strictEqual(url, 'https://github.com/o/r/blob/feature/a%20b/src/lib/git%20ref.js');
  const hash = webUrlFor('git@github.com:o/r.git', { kind: 'file', ref: 'main', path: 'a#b.js' });
  assert.strictEqual(hash, 'https://github.com/o/r/blob/main/a%23b.js');
  const q = webUrlFor('https://github.com/o/r.git?x=1');
  assert.strictEqual(new URL(q).search, '');
});

test('a file link needs both a ref and a path, and a commit link needs a commit id', () => {
  assert.strictEqual(webUrlFor('git@github.com:o/r.git', { kind: 'file', ref: 'main' }), null);
  assert.strictEqual(webUrlFor('git@github.com:o/r.git', { kind: 'file', path: 'a.js' }), null);
  assert.strictEqual(webUrlFor('git@github.com:o/r.git', { kind: 'file', ref: 'main', path: '../a.js' }), null);
  assert.strictEqual(webUrlFor('git@github.com:o/r.git', { kind: 'commit' }), null);
  assert.strictEqual(webUrlFor('git@github.com:o/r.git', { kind: 'commit', sha: 'HEAD' }), null);
  assert.strictEqual(webUrlFor('git@github.com:o/r.git', { kind: 'commit', sha: '4a91c02..HEAD' }), null);
});

test('a line number is used only when it is a real position', () => {
  const base = { kind: 'file', ref: 'main', path: 'a.js' };
  assert.strictEqual(webUrlFor('git@github.com:o/r.git', { ...base, line: 0 }), 'https://github.com/o/r/blob/main/a.js');
  assert.strictEqual(webUrlFor('git@github.com:o/r.git', { ...base, line: -4 }), 'https://github.com/o/r/blob/main/a.js');
  assert.strictEqual(webUrlFor('git@github.com:o/r.git', { ...base, line: 1.5 }), 'https://github.com/o/r/blob/main/a.js');
  assert.strictEqual(webUrlFor('git@github.com:o/r.git', { ...base, line: '12' }), 'https://github.com/o/r/blob/main/a.js#L12');
});
