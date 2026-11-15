'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const Scan = require('../../src/lib/artifact-scan');

const SCANNER = path.resolve(__dirname, '..', 'fixtures', 'fake-scanner.js');

function staged() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-scan-test-'));
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '# sample\n');
  return dir;
}

async function run(mode, extra = {}) {
  const prev = process.env.HUSK_FAKE_SCAN;
  process.env.HUSK_FAKE_SCAN = mode;
  try {
    return await Scan.scanArtifact(Object.assign({
      scanner: SCANNER, dir: staged(), contentHash: 'h-' + mode, fs, execFile, tmpRoot: os.tmpdir(),
    }, extra));
  } finally {
    if (prev === undefined) delete process.env.HUSK_FAKE_SCAN; else process.env.HUSK_FAKE_SCAN = prev;
  }
}

const f = (id, severity) => ({ id, severity });

test('a verdict is derived from the findings when the report has none', () => {
  assert.equal(Scan.deriveVerdict([]), 'clear');
  assert.equal(Scan.deriveVerdict([f('WG101-a', 'CRITICAL')]), 'block');
  assert.equal(Scan.deriveVerdict([f('WG150-a', 'HIGH')]), 'block');
  assert.equal(Scan.deriveVerdict([f('WG101-a', 'MEDIUM')]), 'review');
  assert.equal(Scan.deriveVerdict([f('WG023-a', 'CRITICAL')]), 'review');
  assert.equal(Scan.deriveVerdict([f('WG023-a', 'LOW'), f('WG199-b', 'high')]), 'block');
});

test('a report is read into findings, capabilities and a verdict', () => {
  const r = Scan.readReport({
    vulnerabilities: [{ id: 'WG023-x', title: 'T', severity: 'high', category: 'C', description: 'D', evidence: 'E', location: { nodeId: '', file: 'a.md' }, extra: 1 }],
    capabilities: { commands: ['curl', 7], hosts: ['h.example'], files: 'nope' },
  });
  assert.equal(r.verdict, 'review');
  assert.deepEqual(r.findings, [{ id: 'WG023-x', title: 'T', severity: 'HIGH', category: 'C', description: 'D', evidence: 'E', location: 'file: a.md' }]);
  assert.deepEqual(r.capabilities, { commands: ['curl'], hosts: ['h.example'], files: [] });
});

test('a report with a null list is a report with no findings', () => {
  assert.equal(Scan.readReport({ vulnerabilities: null }).verdict, 'clear');
});

test('a stated verdict is used as given', () => {
  assert.equal(Scan.readReport({ verdict: 'block', vulnerabilities: [] }).verdict, 'block');
  assert.equal(Scan.readReport({ verdict: 'clear', vulnerabilities: [f('WG101-a', 'CRITICAL')] }).verdict, 'clear');
});

test('a report outside the contract is not read', () => {
  assert.equal(Scan.readReport(null), null);
  assert.equal(Scan.readReport([]), null);
  assert.equal(Scan.readReport({}), null);
  assert.equal(Scan.readReport({ vulnerabilities: 'none' }), null);
  assert.equal(Scan.readReport({ vulnerabilities: ['x'] }), null);
  assert.equal(Scan.readReport({ verdict: 'fine', vulnerabilities: [] }), null);
});

test('the verdict counts findings past the display cap', () => {
  const many = Array.from({ length: 250 }, (_, i) => f(`WG023-${i}`, 'LOW'));
  many.push(f('WG101-last', 'CRITICAL'));
  const r = Scan.readReport({ vulnerabilities: many });
  assert.equal(r.verdict, 'block');
  assert.equal(r.findings.length, 200);
  assert.equal(r.findingCount, 251);
});

test('the gate refuses a block, offers one click on clear and asks otherwise', () => {
  assert.equal(Scan.gateDecision({ status: 'scanned', verdict: 'block' }), 'block');
  assert.equal(Scan.gateDecision({ status: 'scanned', verdict: 'clear' }), 'clear');
  assert.equal(Scan.gateDecision({ status: 'scanned', verdict: 'review' }), 'confirm');
  assert.equal(Scan.gateDecision(Scan.unscanned('timeout')), 'confirm');
  assert.equal(Scan.gateDecision({ status: 'unscanned', verdict: 'clear' }), 'confirm');
  assert.equal(Scan.gateDecision(null), 'confirm');
});

test('no scanner configured is unscanned', async () => {
  for (const scanner of [undefined, '', '   ']) {
    const r = await Scan.scanArtifact({ scanner, dir: '/x', fs, execFile, tmpRoot: os.tmpdir() });
    assert.equal(r.status, 'unscanned');
    assert.equal(r.verdict, 'review');
    assert.equal(r.reason, 'no-scanner');
  }
});

test('a scanner path that is relative, missing or a folder is unscanned', async () => {
  for (const scanner of ['scanner', path.join(os.tmpdir(), 'husk-no-such-scanner'), os.tmpdir()]) {
    const r = await Scan.scanArtifact({ scanner, dir: '/x', fs, execFile, tmpRoot: os.tmpdir() });
    assert.equal(r.status, 'unscanned');
    assert.equal(r.reason, 'scanner-not-found');
  }
});

test('the scanner is run with the contract arguments and no shell', async () => {
  let call = null;
  const fakeExec = (file, args, options, cb) => {
    call = { file, args, options };
    fs.writeFileSync(args[args.indexOf('--output') + 1], '{"vulnerabilities":[]}');
    cb(null);
  };
  const dir = staged();
  const r = await Scan.scanArtifact({ scanner: SCANNER, dir, contentHash: 'x', fs, execFile: fakeExec, tmpRoot: os.tmpdir() });
  assert.equal(r.status, 'scanned');
  assert.equal(call.file, SCANNER);
  assert.deepEqual(call.args.slice(0, 5), ['scan', '--artifact', dir, '--format', 'json']);
  assert.equal(call.args[5], '--output');
  assert.equal(call.options.timeout, 30000);
  assert.equal(call.options.shell, false);
  // The report file is removed with its folder.
  assert.equal(fs.existsSync(path.dirname(call.args[6])), false);
});

test('clear, review and block reports come back as scanned verdicts', async () => {
  const clear = await run('clear');
  assert.deepEqual([clear.status, clear.verdict, clear.findings.length], ['scanned', 'clear', 0]);
  const review = await run('review');
  assert.deepEqual([review.status, review.verdict, review.findings.length], ['scanned', 'review', 1]);
  assert.equal(review.findings[0].evidence, 'Matched: sample evidence');
  assert.equal(review.findings[0].location, 'file: SKILL.md, line: 3');
  const block = await run('block');
  assert.deepEqual([block.status, block.verdict], ['scanned', 'block']);
  assert.deepEqual(block.capabilities, { commands: ['curl'], hosts: ['example.invalid'], files: ['~/.ssh'] });
});

test('a stated verdict from the scanner wins over the derived one', async () => {
  assert.equal((await run('explicit-clear')).verdict, 'clear');
  assert.equal((await run('explicit-block')).verdict, 'block');
});

test('a report written with a non-zero exit code is still read', async () => {
  const r = await run('exit-code');
  assert.deepEqual([r.status, r.verdict], ['scanned', 'review']);
});

test('a timeout is unscanned', async () => {
  const r = await run('timeout', { timeoutMs: 400 });
  assert.deepEqual([r.status, r.verdict, r.reason], ['unscanned', 'review', 'timeout']);
});

test('a scanner that dies is unscanned', async () => {
  const r = await run('crash');
  assert.deepEqual([r.status, r.verdict, r.reason], ['unscanned', 'review', 'crashed']);
});

test('unreadable output is unscanned', async () => {
  for (const mode of ['garbage', 'silent', 'bad-verdict', 'no-list']) {
    const r = await run(mode);
    assert.deepEqual([mode, r.status, r.verdict, r.reason], [mode, 'unscanned', 'review', 'unreadable-report']);
  }
});

test('a result is cached by content hash and an unscanned one is not', async () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'husk-scan-log-')), 'calls');
  process.env.HUSK_FAKE_SCAN_LOG = log;
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').length : 0);
  try {
    const cache = new Map();
    const first = await run('review', { cache, contentHash: 'same' });
    const second = await run('clear', { cache, contentHash: 'same' });
    assert.equal(calls(), 1);
    assert.equal(first.cached, undefined);
    assert.equal(second.cached, true);
    assert.equal(second.verdict, 'review');
    await run('clear', { cache, contentHash: 'other' });
    assert.equal(calls(), 2);
    await run('garbage', { cache, contentHash: 'bad' });
    const retry = await run('clear', { cache, contentHash: 'bad' });
    assert.equal(calls(), 4);
    assert.equal(retry.status, 'scanned');
  } finally { delete process.env.HUSK_FAKE_SCAN_LOG; }
});


test('replacing the scanner invalidates the cached result', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-scanner-version-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const scanner = path.join(dir, 'scanner.js');
  fs.copyFileSync(SCANNER, scanner); fs.chmodSync(scanner, 0o755);
  const cache = new Map();
  assert.equal((await run('clear', { scanner, cache, contentHash: 'same' })).verdict, 'clear');
  const future = Date.now() / 1000 + 2;
  fs.utimesSync(scanner, future, future);
  const result = await run('block', { scanner, cache, contentHash: 'same' });
  assert.equal(result.cached, undefined);
  assert.equal(result.verdict, 'block');
});
