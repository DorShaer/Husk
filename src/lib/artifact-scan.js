'use strict';

// Runs the user's external scanner over a staged folder and reads its report.
// Husk ships no scanner. Anything short of a readable report is "unscanned",
// which the gate treats as review.

const path = require('node:path');
const { readBoundedFile } = require('./bounded-file');

const SCAN_TIMEOUT_MS = 30000;
const MAX_REPORT_BYTES = 4 * 1024 * 1024;
const MAX_FINDINGS = 200;
const VERDICTS = ['block', 'review', 'clear'];

function text(v, max) {
  if (v === undefined || v === null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return String(s).slice(0, max);
}

function strings(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 100).map((x) => x.slice(0, 300)) : [];
}

// A location is a string or an object of non-empty parts.
function locationText(loc) {
  if (typeof loc === 'string') return loc.slice(0, 300);
  if (!loc || typeof loc !== 'object') return '';
  return Object.entries(loc)
    .filter(([, v]) => v !== '' && v !== null && v !== undefined && typeof v !== 'object')
    .map(([k, v]) => `${k}: ${v}`).join(', ').slice(0, 300);
}

function deriveVerdict(findings) {
  const list = Array.isArray(findings) ? findings : [];
  if (list.some((f) => /^(CRITICAL|HIGH)$/i.test(String(f.severity)) && String(f.id).startsWith('WG1'))) return 'block';
  return list.length ? 'review' : 'clear';
}

// { verdict, findings, capabilities } from a parsed report, or null when the
// report does not follow the contract.
function readReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return null;
  if (!Object.prototype.hasOwnProperty.call(report, 'vulnerabilities')) return null;
  const raw = report.vulnerabilities === null ? [] : report.vulnerabilities;
  if (!Array.isArray(raw)) return null;
  if (raw.some((v) => !v || typeof v !== 'object' || Array.isArray(v))) return null;
  if (report.verdict !== undefined && !VERDICTS.includes(report.verdict)) return null;
  const all = raw.map((v) => ({
    id: text(v.id, 120),
    title: text(v.title, 200),
    severity: text(v.severity, 20).toUpperCase(),
    category: text(v.category, 120),
    description: text(v.description, 1000),
    evidence: text(v.evidence, 2000),
    location: locationText(v.location),
  }));
  const caps = report.capabilities && typeof report.capabilities === 'object' ? report.capabilities : {};
  return {
    // Derived over every finding, shown capped.
    verdict: report.verdict || deriveVerdict(all),
    findings: all.slice(0, MAX_FINDINGS),
    findingCount: all.length,
    capabilities: { commands: strings(caps.commands), hosts: strings(caps.hosts), files: strings(caps.files) },
  };
}

function unscanned(reason) {
  return {
    status: 'unscanned',
    verdict: 'review',
    reason,
    findings: [],
    findingCount: 0,
    capabilities: { commands: [], hosts: [], files: [] },
  };
}

// What the installer does with a scan: refuse, ask, or offer one click.
function gateDecision(scan) {
  if (!scan || scan.status !== 'scanned') return 'confirm';
  if (scan.verdict === 'block') return 'block';
  return scan.verdict === 'clear' ? 'clear' : 'confirm';
}

// opts: { scanner, dir, contentHash, fs, execFile, tmpRoot, cache?, timeoutMs? }
// Resolves a scan result and never rejects.
function scanArtifact(opts = {}) {
  const { scanner, dir, contentHash, fs, execFile, tmpRoot, cache } = opts;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : SCAN_TIMEOUT_MS;
  return new Promise((resolve) => {
    if (typeof scanner !== 'string' || !scanner.trim()) return resolve(unscanned('no-scanner'));
    if (!path.isAbsolute(scanner)) return resolve(unscanned('scanner-not-found'));
    let scannerStat;
    try { scannerStat = fs.statSync(scanner); } catch (_) { return resolve(unscanned('scanner-not-found')); }
    const cacheKey = `${scanner}:${scannerStat.size}:${scannerStat.mtimeMs}\n${contentHash}`;
    if (cache && contentHash && cache.has(cacheKey)) return resolve(Object.assign({}, cache.get(cacheKey), { cached: true }));

    let outDir;
    try {
      if (!fs.statSync(scanner).isFile()) return resolve(unscanned('scanner-not-found'));
      outDir = fs.mkdtempSync(path.join(tmpRoot, 'husk-scan-'));
      fs.chmodSync(outDir, 0o700);
    } catch (_) { return resolve(unscanned('scanner-not-found')); }
    const outFile = path.join(outDir, 'report.json');
    const done = (result) => {
      try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
      resolve(result);
    };

    const args = ['scan', '--artifact', dir, '--format', 'json', '--output', outFile];
    const onExit = (err) => {
      if (err && (err.killed || err.signal)) return done(unscanned(err.killed ? 'timeout' : 'crashed'));
      // A numeric exit code may be how the scanner reports findings, so the report decides.
      if (err && typeof err.code !== 'number') return done(unscanned('crashed'));
      let parsed;
      try {
        let bytes;
        try { bytes = readBoundedFile(outFile, MAX_REPORT_BYTES, fs); } catch (e) {
          if (/byte limit/.test(e.message)) return done(unscanned('unreadable-report'));
          throw e;
        }
        parsed = JSON.parse(bytes.toString('utf8'));
      } catch (_) { return done(unscanned(err ? 'crashed' : 'unreadable-report')); }
      const report = readReport(parsed);
      if (!report) return done(unscanned('unreadable-report'));
      const result = Object.assign({ status: 'scanned', reason: null }, report);
      if (cache && contentHash) {
        if (cache.size >= 256) cache.delete(cache.keys().next().value);
        cache.set(cacheKey, result);
      }
      done(result);
    };
    try {
      execFile(scanner, args, { timeout: timeoutMs, killSignal: 'SIGKILL', shell: false, windowsHide: true, maxBuffer: 1024 * 1024 }, onExit);
    } catch (_) { done(unscanned('crashed')); }
  });
}

module.exports = {
  SCAN_TIMEOUT_MS,
  VERDICTS,
  deriveVerdict,
  readReport,
  unscanned,
  gateDecision,
  scanArtifact,
};
