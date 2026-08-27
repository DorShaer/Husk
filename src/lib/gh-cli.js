'use strict';

// Talking to GitHub through the gh CLI.
//
// Husk holds no GitHub credential. It runs `gh`, which is already logged in as
// whoever the user logged it in as, and reads the JSON back. That is the whole
// auth story: no token in config, no keychain entry, no refresh flow, and
// nothing for Husk to leak. Revoking Husk's access is `gh auth logout`.
//
// This module is the pure half. It builds argv, reads stdout, and classifies
// failures. It never spawns anything, touches the filesystem or reads a clock,
// which is what lets every rule here run as an ordinary unit test. main.js owns
// the spawn, its timeout and its output ceiling.
//
// Two rules run through the file.
//
// Arguments are a list, never a string. Every value that came from a user or a
// repository is its own element in an argv array, so a branch called
// `; rm -rf ~` is a branch name and not a second command. Nothing here ever
// produces a shell line, and main.js spawns without a shell.
//
// A field this module did not ask for cannot appear in a row. gh returns what
// the --json list names, and the normalizers below copy named fields across one
// at a time. A future gh that adds a field does not silently widen what reaches
// the renderer.

// ─── the fields ──────────────────────────────────────────────────────────

// Asked for by name, so the payload stays a list of what the surface draws.
// statusCheckRollup is the one expensive field and it is aggregated here rather
// than shipped: a busy PR carries forty check runs and the row shows a count.
const PR_FIELDS = [
  'number', 'title', 'state', 'author', 'headRefName', 'baseRefName',
  'isDraft', 'createdAt', 'updatedAt', 'additions', 'deletions',
  'changedFiles', 'labels', 'reviewDecision', 'mergeable', 'url',
  'statusCheckRollup',
];

const ISSUE_FIELDS = [
  'number', 'title', 'state', 'author', 'createdAt', 'updatedAt',
  'labels', 'assignees', 'comments', 'url',
];

// A page of rows. gh will happily return thousands; a list surface shows a
// screen, and the count is what keeps one repository from stalling the page.
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// gh states, spelled the way gh spells them.
const PR_STATES = ['open', 'closed', 'merged', 'all'];
const ISSUE_STATES = ['open', 'closed', 'all'];

// ─── failures ────────────────────────────────────────────────────────────

// Why a call did not produce rows. Closed, because the page keys its recovery
// copy off these codes: each one has a different thing for the reader to do.
const FAILURE_CODES = [
  'gh-missing',
  'gh-not-authenticated',
  'not-a-repository',
  'no-remote',
  'repo-not-found',
  'rate-limited',
  'gh-failed',
];

// Matched against gh's own stderr. Ordered, because "not a git repository"
// arrives inside a longer sentence that also names git.
const FAILURE_PATTERNS = [
  [/not a git repository/i, 'not-a-repository'],
  [/no git remotes found/i, 'no-remote'],
  [/gh auth login|authentication token|not logged into/i, 'gh-not-authenticated'],
  [/could not resolve to a repository|HTTP 404/i, 'repo-not-found'],
  [/rate limit/i, 'rate-limited'],
];

function fail(code, message, detail) {
  return {
    ok: false,
    code,
    message: String(message),
    detail: (detail === undefined || detail === null) ? null : String(detail).slice(0, 512),
  };
}

const FAILURE_COPY = Object.freeze({
  'gh-missing': 'the GitHub CLI is not on this machine',
  'gh-not-authenticated': 'the GitHub CLI is installed but not logged in',
  'not-a-repository': 'that folder is not inside a git repository',
  'no-remote': 'that repository has no remote, so there is nothing on GitHub to read',
  'repo-not-found': 'GitHub does not show that repository to this account',
  'rate-limited': 'GitHub is rate limiting this account',
  'gh-failed': 'the GitHub CLI could not answer',
});

// Turns a non-zero gh run into one of the codes above. An unrecognised failure
// keeps gh's own words rather than being flattened into a generic sentence: gh
// explains itself well, and inventing a Husk sentence for a message nobody has
// seen would be a worse answer than quoting it.
function classifyFailure(exitCode, stderr) {
  const text = String(stderr || '').trim();
  for (const [re, code] of FAILURE_PATTERNS) {
    if (re.test(text)) return fail(code, FAILURE_COPY[code], text.slice(0, 300));
  }
  return fail('gh-failed', FAILURE_COPY['gh-failed'], text.slice(0, 300) || `gh exited ${exitCode}`);
}


// ─── argv ────────────────────────────────────────────────────────────────

function clampLimit(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(v)));
}

function pickState(value, allowed) {
  const s = typeof value === 'string' ? value.toLowerCase() : '';
  return allowed.includes(s) ? s : 'open';
}

// Every value is its own array element. A title, a branch or a search term
// carrying a space, a quote or a semicolon is one argument and stays one.
function prListArgs(opts = {}) {
  const args = [
    'pr', 'list',
    '--state', pickState(opts.state, PR_STATES),
    '--limit', String(clampLimit(opts.limit)),
    '--json', PR_FIELDS.join(','),
  ];
  if (typeof opts.search === 'string' && opts.search.trim()) {
    args.push('--search', opts.search.trim());
  }
  return args;
}

function issueListArgs(opts = {}) {
  const args = [
    'issue', 'list',
    '--state', pickState(opts.state, ISSUE_STATES),
    '--limit', String(clampLimit(opts.limit)),
    '--json', ISSUE_FIELDS.join(','),
  ];
  if (typeof opts.search === 'string' && opts.search.trim()) {
    args.push('--search', opts.search.trim());
  }
  return args;
}

// The repository the current folder points at. Its own call rather than a field
// on the list, because the page names the repository before any list arrives
// and because this is what fails first when a folder has no remote.
function repoViewArgs() {
  return ['repo', 'view', '--json', 'nameWithOwner,url,defaultBranchRef,isPrivate,description'];
}

// ─── normalising ─────────────────────────────────────────────────────────

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function login(actor) {
  return actor && typeof actor === 'object' ? str(actor.login, 60) : '';
}

// Labels keep their colour, which is the one piece of GitHub styling worth
// carrying: a reader recognises their own labels by colour before they read.
function labels(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 12).map((l) => ({
    name: str(l && l.name, 40),
    color: /^[0-9a-fA-F]{6}$/.test(String(l && l.color)) ? String(l.color).toLowerCase() : '',
  })).filter((l) => l.name);
}

// One PR carries a check run per job, and a busy repository runs forty. The row
// shows how many passed, so the array is counted here and dropped: shipping it
// would send tens of kilobytes per row to draw one number.
//
// A check that has not completed is pending whatever its conclusion field says,
// because gh leaves the conclusion of a running job empty rather than absent.
function checks(rollup) {
  const out = { total: 0, passed: 0, failed: 0, pending: 0, state: 'none' };
  if (!Array.isArray(rollup) || !rollup.length) return out;

  for (const c of rollup) {
    if (!c || typeof c !== 'object') continue;
    out.total += 1;
    const status = String(c.status || '').toUpperCase();
    const conclusion = String(c.conclusion || c.state || '').toUpperCase();
    if (status && status !== 'COMPLETED') { out.pending += 1; continue; }
    if (conclusion === 'SUCCESS' || conclusion === 'NEUTRAL' || conclusion === 'SKIPPED') out.passed += 1;
    else if (conclusion === 'FAILURE' || conclusion === 'TIMED_OUT' || conclusion === 'CANCELLED' || conclusion === 'ACTION_REQUIRED' || conclusion === 'STARTUP_FAILURE') out.failed += 1;
    else if (!conclusion) out.pending += 1;
    else out.failed += 1;
  }
  // One word for the row's mark. A failure outranks a pending run: the answer
  // is already known and waiting will not change it.
  if (out.failed) out.state = 'failing';
  else if (out.pending) out.state = 'pending';
  else if (out.passed) out.state = 'passing';
  return out;
}

function prRow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const number = num(raw.number);
  if (!number) return null;
  return {
    number,
    title: str(raw.title, 300),
    state: str(raw.state, 20).toUpperCase(),
    isDraft: raw.isDraft === true,
    author: login(raw.author),
    head: str(raw.headRefName, 200),
    base: str(raw.baseRefName, 200),
    createdAt: str(raw.createdAt, 40),
    updatedAt: str(raw.updatedAt, 40),
    additions: num(raw.additions),
    deletions: num(raw.deletions),
    changedFiles: num(raw.changedFiles),
    labels: labels(raw.labels),
    // '' when nobody has reviewed, which is a different thing from approved.
    reviewDecision: str(raw.reviewDecision, 30).toUpperCase(),
    mergeable: str(raw.mergeable, 20).toUpperCase(),
    url: str(raw.url, 400),
    checks: checks(raw.statusCheckRollup),
  };
}

function issueRow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const number = num(raw.number);
  if (!number) return null;
  return {
    number,
    title: str(raw.title, 300),
    state: str(raw.state, 20).toUpperCase(),
    author: login(raw.author),
    createdAt: str(raw.createdAt, 40),
    updatedAt: str(raw.updatedAt, 40),
    labels: labels(raw.labels),
    assignees: Array.isArray(raw.assignees) ? raw.assignees.slice(0, 8).map(login).filter(Boolean) : [],
    comments: Array.isArray(raw.comments) ? raw.comments.length : num(raw.comments),
    url: str(raw.url, 400),
  };
}

function repoRow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const nameWithOwner = str(raw.nameWithOwner, 200);
  if (!nameWithOwner) return null;
  const branch = raw.defaultBranchRef && typeof raw.defaultBranchRef === 'object'
    ? str(raw.defaultBranchRef.name, 200)
    : '';
  return {
    nameWithOwner,
    url: str(raw.url, 400),
    defaultBranch: branch,
    isPrivate: raw.isPrivate === true,
    description: str(raw.description, 400),
  };
}

// Reads a gh --json payload. gh writes one JSON document, so anything else is a
// gh that changed under us rather than a row to salvage.
function parseRows(stdout, rowOf) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout || ''));
  } catch (err) {
    return fail('gh-failed', 'the GitHub CLI returned something that is not JSON', err && err.message);
  }
  if (!Array.isArray(parsed)) {
    return fail('gh-failed', 'the GitHub CLI returned a single value where a list was asked for', null);
  }
  const rows = [];
  for (const raw of parsed) {
    const row = rowOf(raw);
    if (row) rows.push(row);
  }
  return { ok: true, rows, skipped: parsed.length - rows.length };
}

const parsePrList = (stdout) => parseRows(stdout, prRow);
const parseIssueList = (stdout) => parseRows(stdout, issueRow);

function parseRepoView(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout || ''));
  } catch (err) {
    return fail('gh-failed', 'the GitHub CLI returned something that is not JSON', err && err.message);
  }
  const repo = repoRow(parsed);
  return repo ? { ok: true, repo } : fail('repo-not-found', FAILURE_COPY['repo-not-found'], null);
}

// ─── browsing ────────────────────────────────────────────────────────────

// Rows matching a query, newest first. Literal matching over the title, the
// author, the branch and the label names: a list is scanned rather than
// recalled, and a gapped match over a long title answers nothing a reader
// would recognise as a match.
function filterRows(rows, query) {
  const list = Array.isArray(rows) ? rows : [];
  const q = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (!q) return list;
  // A bare number is how a pull request is named out loud.
  const asNumber = /^#?\d+$/.test(q) ? Number(q.replace('#', '')) : null;
  return list.filter((r) => {
    if (asNumber !== null && r.number === asNumber) return true;
    const hay = [r.title, r.author, r.head || '', (r.labels || []).map((l) => l.name).join(' ')]
      .join(' ').toLowerCase();
    return hay.includes(q);
  });
}

// Every label in a set of rows with how many carry it, commonest first.
function labelCounts(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const tally = new Map();
  for (const r of list) {
    for (const l of (r.labels || [])) {
      const prev = tally.get(l.name);
      tally.set(l.name, { name: l.name, color: l.color || (prev && prev.color) || '', count: (prev ? prev.count : 0) + 1 });
    }
  }
  return [...tally.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

module.exports = {
  PR_FIELDS,
  ISSUE_FIELDS,
  PR_STATES,
  ISSUE_STATES,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  FAILURE_CODES,
  FAILURE_COPY,
  prListArgs,
  issueListArgs,
  repoViewArgs,
  classifyFailure,
  parsePrList,
  parseIssueList,
  parseRepoView,
  filterRows,
  labelCounts,
  // exported for unit tests; not part of the public API.
  _internal: { checks, labels, prRow, issueRow, repoRow, clampLimit, pickState },
};
