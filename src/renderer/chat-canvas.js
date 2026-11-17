(function () {
'use strict';

// The canvas beside a chat: what changed in the working tree, the branch's pull
// request, and its checks. It reads through the same bridges the Source and
// GitHub pages use and paints diff rows through window.ScDom, so a line looks
// the same here as it does there. Explain sends a prompt to the chat; repository
// editing stays on Source. Initialize Git explicitly confirms the folder first.

const TABS = [['changes', 'Changes'], ['pr', 'Pull request'], ['checks', 'Checks']];
const MAX_DIFF_LINES = 1500;
const PR_POLL_MS = 60000;

const hooks = { root: () => '', send: () => false, goto: () => {}, onToggle: () => {}, onPr: () => {}, initGit: () => {} };

const st = {
  open: false,
  tab: 'changes',
  root: '',
  branch: '',
  isRepo: true,
  gitAvailable: true,
  canInit: true,
  gitMessage: '',
  entries: [],
  rows: {},
  path: '',
  turnPaths: new Set(),
  changesError: '',
  folderNote: '',
  folderPartial: false,
  diff: null,
  image: null,
  diffError: '',
  pr: null,
  prState: 'idle',
  prMessage: '',
  prReadAt: 0,
  checksUnavailable: false,
  check: '',
  seq: 0,
  diffSeq: 0,
  prSeq: 0,
  timer: 0,
};

function host() { return document.getElementById('chat-canvas'); }

function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  for (let i = 3; i < arguments.length; i++) if (arguments[i]) n.appendChild(arguments[i]);
  return n;
}
function button(cls, label, onClick, title) {
  const b = h('button', cls, label);
  b.type = 'button';
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}
function clock(ms) {
  try { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (_) { return ''; }
}
function stat(adds, dels) {
  const box = h('span', 'cc-stat');
  if (adds > 0) box.appendChild(h('span', 'is-add', '+' + adds));
  if (dels > 0) box.appendChild(h('span', 'is-del', '-' + dels));
  return box;
}
const IMAGE_NAME = /\.(png|jpe?g|gif|webp)$/i;
function pixelsOk(p) {
  return !!p && Number.isInteger(p.width) && Number.isInteger(p.height) && p.width >= 1 && p.height >= 1 && p.width <= 1600 && p.height <= 1600
    && p.data instanceof Uint8Array && p.data.length === p.width * p.height * 4;
}
const LETTER = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', untracked: 'A', conflicted: 'U' };

// ─── Reads ───────────────────────────────────────────────────────────────────

async function loadChanges() {
  const seq = ++st.seq;
  const root = st.root;
  st.changesError = '';
  let repo = null;
  let status = null;
  try {
    [repo, status] = await Promise.all([window.husk.git.repo(root), window.husk.git.status(root)]);
  } catch (_) { status = null; }
  if (seq !== st.seq) return;
  if (!status || status.ok === false) {
    st.entries = []; st.rows = {};
    st.changesError = status && status.error || 'Could not read the working tree.';
  } else {
    st.isRepo = status.isRepo !== false;
    st.gitAvailable = status.gitAvailable !== false;
    st.canInit = status.canInit !== false;
    st.gitMessage = status.gitMessage || '';
    st.branch = repo && repo.ok && repo.branch ? String(repo.branch) : '';
    st.folderNote = ''; st.folderPartial = false;
    if (!st.isRepo) {
      const folder = await window.husk.folderChanges.status(root);
      if (seq !== st.seq) return;
      st.entries = folder.files || [];
      st.folderPartial = !!folder.partial;
      st.rows = Object.fromEntries(st.entries.map(e => [e.path, e]));
      st.folderNote = folder.partial ? 'Some files could not be compared. Large files have no line diff; folder size and read limits apply.' : 'Compared with the start of the last turn. Available until the next turn or app restart.';
      if (!folder.ok) st.changesError = folder.error || 'Could not compare this folder.';
    } else {
      const parsed = window.husk.text.parseGitStatus(status.porcelain || '').filter((e) => e && e.status !== 'ignored');
      st.rows = window.HuskTurnChanges.snapshot(status, parsed);
      // Files from the last turn lead; the rest keep git's order.
      st.entries = parsed.slice().sort((a, b) => (st.turnPaths.has(b.path) ? 1 : 0) - (st.turnPaths.has(a.path) ? 1 : 0));
    }
  }
  if (!st.entries.some((e) => e.path === st.path)) pick(st.entries[0] ? st.entries[0].path : '');
  paint();
  loadDiff();
}

// Selecting another file drops what was read for the last one.
function pick(path) {
  if (path === st.path) return;
  st.path = path; st.diff = null; st.image = null; st.diffError = '';
}

async function loadDiff() {
  const seq = ++st.diffSeq;
  const entry = st.entries.find((e) => e.path === st.path);
  st.diff = null;
  st.image = null;
  st.diffError = '';
  if (!entry) { paintBody(); return; }
  const side = entry.status === 'untracked' ? 'untracked' : entry.unstaged ? 'worktree' : 'index';
  let res = null;
  try { res = st.isRepo ? await window.husk.git.diff(st.root, { rel: entry.path, side }) : await window.husk.folderChanges.diff(st.root, entry.path); } catch (_) { res = null; }
  if (seq !== st.diffSeq) return;
  if (!res || res.ok === false) {
    st.diffError = res && res.error === 'diff too large' ? 'This diff is too large to show here.' : res && res.error || 'Could not read this diff.';
  } else {
    const parsed = res.file ? null : window.husk.text.parseDiff(res.diff || '');
    const diff = res.file || (parsed && Array.isArray(parsed.files) && parsed.files[0] ? parsed.files[0] : { hunks: [] });
    if (!diff.hunks.length && entry.status !== 'deleted' && IMAGE_NAME.test(entry.path)) {
      let img = null;
      try { img = await window.husk.git.image(st.root, entry.path); } catch (_) { img = null; }
      if (seq !== st.diffSeq) return;
      if (img && img.ok && pixelsOk(img.pixels)) st.image = img;
      else if (img && img.note) diff.note = String(img.note);
    }
    st.diff = diff;
  }
  if (st.tab === 'changes') paintBody();
}

// The open pull request whose head is this branch, or null. One call serves
// the canvas, the card in the thread and the mark on the rail.
async function readPr(root) {
  const out = { state: 'none', pr: null, message: '', branch: '', readAt: Date.now() };
  let repo = null;
  try { repo = await window.husk.git.repo(root); } catch (_) { repo = null; }
  if (repo && repo.gitAvailable === false) { out.state = 'no-git'; out.message = repo.gitMessage || 'Git is not available.'; return out; }
  if (repo && !repo.ok) { out.state = 'error'; out.message = repo.error || 'Git could not read this repository.'; return out; }
  if (!repo || !repo.isRepo) { out.state = 'norepo'; return out; }
  out.branch = repo.branch ? String(repo.branch) : '';
  if (!out.branch) { out.state = 'detached'; return out; }
  let avail = null;
  try { avail = await window.husk.github.available(); } catch (_) { avail = null; }
  if (!avail || !avail.available) { out.state = 'nogh'; return out; }
  let res = null;
  try { res = await window.husk.github.pulls({ cwd: root, state: 'open', limit: 50 }); } catch (_) { res = null; }
  out.readAt = Date.now();
  if (!res || res.ok === false) {
    out.state = 'error';
    out.message = String((res && (res.message || res.detail)) || 'Could not reach GitHub.');
    return out;
  }
  const rows = Array.isArray(res.rows) ? res.rows : [];
  out.pr = rows.find((r) => r && r.head === out.branch) || null;
  out.state = out.pr ? 'found' : 'none';
  out.checksUnavailable = !!res.checksUnavailable;
  return out;
}

async function loadPr() {
  const seq = ++st.prSeq;
  if (st.prState === 'idle') { st.prState = 'loading'; paintBody(); }
  const r = await readPr(st.root);
  if (seq !== st.prSeq) return;
  st.pr = r.pr;
  st.prState = r.state;
  st.prMessage = r.message;
  st.prReadAt = r.readAt;
  st.checksUnavailable = !!r.checksUnavailable;
  if (r.branch) st.branch = r.branch;
  const runs = st.pr && Array.isArray(st.pr.checkRuns) ? st.pr.checkRuns : [];
  if (!runs.some((c) => c.name === st.check)) {
    const first = runs.find((c) => c.state === 'failing') || runs[0];
    st.check = first ? first.name : '';
  }
  try { hooks.onPr(r); } catch (_) {}
  paint();
}

function schedule() {
  if (st.timer) { clearInterval(st.timer); st.timer = 0; }
  if (!st.open) return;
  st.timer = setInterval(() => { if (st.open && st.tab !== 'changes') loadPr(); }, PR_POLL_MS);
}

// ─── Paint ───────────────────────────────────────────────────────────────────

function paint() {
  const root = host();
  if (!root) return;
  root.hidden = !st.open;
  if (!st.open) return;
  root.replaceChildren();

  const tabs = h('div', 'cc-tabs');
  tabs.setAttribute('role', 'tablist');
  const failing = st.pr && st.pr.checks ? st.pr.checks.failed : 0;
  for (const [id, label] of TABS) {
    const b = button('cc-tab' + (st.tab === id ? ' is-on' : ''), label, () => setTab(id));
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(st.tab === id));
    b.dataset.tab = id;
    if (id === 'changes' && st.entries.length) b.appendChild(h('span', 'cc-count', st.entries.length));
    if (id === 'checks' && failing) b.appendChild(h('span', 'cc-count is-bad', failing));
    tabs.appendChild(b);
  }
  tabs.appendChild(h('span', 'cc-grow'));
  tabs.appendChild(button('cc-icon-btn', '↻', () => refresh(), 'Read again'));
  const x = button('cc-icon-btn', '✕', () => close(), 'Close');
  x.id = 'cc-close';
  tabs.appendChild(x);
  root.appendChild(tabs);

  root.appendChild(h('div', 'cc-body'));
  root.appendChild(h('div', 'cc-foot'));
  paintBody();
}

function paintBody() {
  const root = host();
  if (!root || !st.open) return;
  const body = root.querySelector('.cc-body');
  const foot = root.querySelector('.cc-foot');
  if (!body || !foot) return;
  body.replaceChildren();
  foot.replaceChildren();
  if (st.tab === 'changes') paintChanges(body, foot);
  else if (st.tab === 'pr') paintPr(body, foot);
  else paintChecks(body, foot);
}

function empty(body, title, msg, action) {
  body.appendChild(h('div', 'cc-empty', null, h('div', 'cc-empty-title', title), msg ? h('div', 'cc-empty-msg', msg) : null, action || null));
}

function gitSetupActions() {
  const actions = h('div', 'cc-setup-actions');
  if (!st.gitAvailable) {
    actions.appendChild(button('cc-btn is-primary', 'Get Git', async () => {
      try { const result = await window.husk.urls.openExternal('https://git-scm.com/install/'); if (!result.ok) throw new Error(result.error); }
      catch (_) { st.changesError = 'Could not open your browser. Visit https://git-scm.com/install/ to install Git.'; paintBody(); }
    }));
    actions.appendChild(button('cc-btn', 'Check again', async () => {
      try { await window.husk.git.available(true); refresh(); } catch (_) { st.changesError = 'Could not check Git. Try again.'; paintBody(); }
    }));
  } else if (!st.canInit) {
    actions.appendChild(h('span', 'cc-note', 'Choose a writable folder to initialize Git.'));
  } else {
    const init = button('cc-btn is-primary', 'Initialize Git', async () => {
      init.disabled = true;
      try { await hooks.initGit(st.root); }
      catch (_) { st.changesError = 'Could not initialize Git. Check the folder and try again.'; paintBody(); }
      finally { init.disabled = false; }
    });
    actions.appendChild(init);
  }
  return actions;
}

function paintChanges(body, foot) {
  if (st.changesError) { empty(body, 'Could not read changes', st.changesError, button('cc-btn', 'Try again', async () => { await window.husk.git.available(true); refresh(); })); return; }
  if (!st.isRepo && !st.entries.length) {
    empty(body, st.folderPartial ? 'Comparison incomplete' : 'Ready to track folder changes', st.folderPartial ? 'Some files could not be compared. Check folder permissions or comparison limits; no complete change count is available.' : st.gitAvailable
      ? 'Files added, edited or deleted during a chat turn appear here, even without a repository.'
      : st.gitMessage + ' File changes still work. Install Git, then check again.', gitSetupActions());
    return;
  }
  if (!st.isRepo && !st.gitAvailable) {
    body.appendChild(h('div', 'cc-note', st.gitMessage + ' File changes are still tracked locally.'));
    body.appendChild(gitSetupActions());
  }
  if (!st.entries.length) { empty(body, 'Working tree is clean', 'Files the agent edits show up here as it works.'); branchFoot(foot); return; }

  const list = h('div', 'cc-files');
  for (const e of st.entries) {
    const r = st.rows[e.path] || { adds: 0, dels: 0 };
    const row = button('cc-file' + (e.path === st.path ? ' is-on' : ''), null, () => { pick(e.path); paintBody(); loadDiff(); });
    row.title = e.path;
    const letter = h('span', 'cc-letter', LETTER[e.status] || 'M');
    letter.dataset.status = e.status;
    row.appendChild(letter);
    row.appendChild(h('span', 'cc-path', e.path));
    if (st.turnPaths.has(e.path)) row.appendChild(h('span', 'cc-turn', 'this turn'));
    row.appendChild(stat(r.adds, r.dels));
    list.appendChild(row);
  }
  body.appendChild(list);

  const entry = st.entries.find((e) => e.path === st.path);
  if (entry) {
    const r = st.rows[entry.path] || { adds: 0, dels: 0 };
    const head = h('div', 'cc-dhead', null, h('span', 'cc-dpath', entry.path), stat(r.adds, r.dels), h('span', 'cc-grow'));
    head.appendChild(button('cc-btn', 'Explain', () => send(`Explain the change to ${entry.path} in the working tree: what it does and why.`)));
    body.appendChild(head);
    const box = h('div', 'cc-diff');
    if (st.diffError) box.appendChild(h('div', 'cc-note', st.diffError));
    else if (!st.diff) box.appendChild(h('div', 'cc-note', 'Reading the diff'));
    else if (st.image) {
      // The picture is painted from plain pixels; this window decodes no image file.
      const { width, height, data } = st.image.pixels;
      const pic = h('canvas'); pic.width = width; pic.height = height;
      pic.setAttribute('role', 'img'); pic.setAttribute('aria-label', entry.path);
      pic.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width, height), 0, 0);
      const size = st.image.bytes < 1048576 ? Math.max(1, Math.round(st.image.bytes / 1024)) + ' KB' : (st.image.bytes / 1048576).toFixed(1) + ' MB';
      box.appendChild(h('div', 'cc-image', null, pic, h('span', 'cc-image-meta', `${st.image.width} × ${st.image.height} · ${size}`)));
    }
    else if (!st.diff.hunks.length) box.appendChild(h('div', 'cc-note', st.diff.note || (st.diff.binary ? 'Binary file.' : 'No line changes to show.')));
    else {
      let n = 0;
      for (const hunk of st.diff.hunks) {
        box.appendChild(h('div', 'cc-hunk', hunk.header));
        for (const line of hunk.lines) {
          if (n++ >= MAX_DIFF_LINES) break;
          box.appendChild(window.ScDom.lineEl(line, {}));
        }
        if (n > MAX_DIFF_LINES) { box.appendChild(h('div', 'cc-note', 'Diff cut here. Open Source for the rest.')); break; }
      }
    }
    body.appendChild(box);
  }
  branchFoot(foot);
}

function branchFoot(foot) {
  if (!st.isRepo) {
    const note = h('span', 'cc-foot-note', st.folderNote); note.title = st.folderNote;
    foot.appendChild(note);
    if (st.gitAvailable) foot.appendChild(gitSetupActions());
    return;
  }
  if (st.branch) foot.appendChild(h('span', 'cc-foot-note', null, document.createTextNode('on '), h('b', '', st.branch)));
  foot.appendChild(h('span', 'cc-grow'));
  foot.appendChild(button('cc-btn', 'Review and commit', () => hooks.goto('source'), 'Stage, discard and commit on the Source page'));
}

// What the pull request tabs say when there is no pull request to show.
function prGate(body) {
  if (st.prState === 'idle' || st.prState === 'loading') { empty(body, 'Reading GitHub'); return true; }
  if (st.prState === 'no-git') { st.gitAvailable = false; empty(body, 'Git is not available', st.prMessage + ' Install Git to use pull requests and checks.', gitSetupActions()); return true; }
  if (st.prState === 'norepo') { empty(body, 'Not a git repository', 'Initialize Git before creating a branch or pull request.', gitSetupActions()); return true; }
  if (st.prState === 'detached') { empty(body, 'No branch checked out', 'A pull request belongs to a branch, and HEAD is detached.'); return true; }
  if (st.prState === 'nogh') { empty(body, 'GitHub CLI not found', 'Install gh and sign in to see pull requests and checks here.'); return true; }
  if (st.prState === 'error') { empty(body, 'Could not read GitHub', st.prMessage); return true; }
  if (!st.pr) {
    empty(body, 'No open pull request', `Nothing is open for ${st.branch}.`,
      button('cc-btn is-primary', 'Ask the agent to open one', () => send(`Open a pull request for the current branch (${st.branch}).`)));
    return true;
  }
  return false;
}

function prFoot(foot) {
  if (st.prReadAt) foot.appendChild(h('span', 'cc-foot-note', `read ${clock(st.prReadAt)}`));
  foot.appendChild(h('span', 'cc-grow'));
  foot.appendChild(button('cc-btn', 'All pull requests', () => hooks.goto('github')));
  if (st.pr && st.pr.url) foot.appendChild(button('cc-btn', 'Open on GitHub', () => window.husk.urls.openExternal(st.pr.url)));
}

function field(label, node) { return h('div', 'cc-field', null, h('span', 'cc-field-k', label), node); }

function paintPr(body, foot) {
  if (prGate(body)) { prFoot(foot); return; }
  const p = st.pr;
  body.appendChild(h('div', 'cc-crumb', `Pull request #${p.number}`));
  body.appendChild(h('h3', 'cc-title', p.title));
  body.appendChild(h('div', 'cc-sub', [p.isDraft ? 'Draft' : 'Open', p.author ? `opened by ${p.author}` : ''].filter(Boolean).join(' · ')));
  const c = p.checks || {};
  const grid = h('div', 'cc-fields');
  grid.appendChild(field('Branches', h('span', '', `${p.head || '?'} into ${p.base || '?'}`)));
  grid.appendChild(field('Changes', h('span', '', null, document.createTextNode(`${p.changedFiles} file${p.changedFiles === 1 ? '' : 's'} `), stat(p.additions, p.deletions))));
  grid.appendChild(field('Checks', h('span', '', st.checksUnavailable ? 'Checks unavailable' : c.total ? `${c.passed} passed, ${c.failed} failed, ${c.pending} running` : 'no checks ran')));
  // An empty review decision is not an approval, and the copy says which.
  grid.appendChild(field('Review', h('span', '', p.reviewDecision ? p.reviewDecision.replace(/_/g, ' ').toLowerCase() : 'nobody has reviewed yet')));
  if (p.mergeable) grid.appendChild(field('Mergeable', h('span', '', p.mergeable.toLowerCase())));
  body.appendChild(grid);
  if (c.failed) body.appendChild(button('cc-btn is-primary cc-inline-cta', c.failed === 1 ? 'See the failing check' : `See ${c.failed} failing checks`, () => setTab('checks')));
  prFoot(foot);
}

const CHECK_WORD = { failing: 'failed', pending: 'running', passing: 'passed', none: '' };

function paintChecks(body, foot) {
  if (prGate(body)) { prFoot(foot); return; }
  const p = st.pr;
  const runs = Array.isArray(p.checkRuns) ? p.checkRuns : [];
  body.appendChild(h('div', 'cc-crumb', `Pull request #${p.number} / Checks`));
  if (!runs.length && st.checksUnavailable) { empty(body, 'Checks unavailable', 'GitHub did not return the checks in time. They are read again on the next refresh.'); prFoot(foot); return; }
  if (!runs.length) { empty(body, 'No checks ran', 'This pull request has no check runs to list.'); prFoot(foot); return; }
  const sel = runs.find((c) => c.name === st.check) || runs[0];

  const head = h('div', 'cc-chead', null,
    h('h3', 'cc-title', null, document.createTextNode(sel.name + ' '), h('span', 'cc-title-state', CHECK_WORD[sel.state] || '')),
    h('span', 'cc-grow'));
  const where = `the check "${sel.name}" on pull request #${p.number}${sel.url ? ` (${sel.url})` : ''}`;
  if (sel.state === 'failing') head.appendChild(button('cc-btn is-primary', 'Fix', () => send(`${where[0].toUpperCase()}${where.slice(1)} is failing. Read its log, find the cause and fix it.`), 'Send this to the chat'));
  head.appendChild(button('cc-btn', 'Explain', () => send(`Explain where ${where} stands and why. It is currently ${CHECK_WORD[sel.state] || sel.state}.`), 'Send this to the chat'));
  if (sel.url) head.appendChild(button('cc-btn', 'Open log', () => window.husk.urls.openExternal(sel.url)));
  body.appendChild(head);
  if (sel.workflow) body.appendChild(h('div', 'cc-sub', sel.workflow));

  const list = h('div', 'cc-checks');
  for (const c of runs) {
    const row = button('cc-check' + (c.name === sel.name ? ' is-on' : ''), null, () => { st.check = c.name; paintBody(); });
    const dot = h('span', 'cc-dot');
    dot.dataset.state = c.state;
    row.appendChild(dot);
    row.appendChild(h('span', 'cc-check-name', c.name));
    row.appendChild(h('span', 'cc-grow'));
    row.appendChild(h('span', 'cc-check-state', CHECK_WORD[c.state] || ''));
    list.appendChild(row);
  }
  body.appendChild(list);
  body.appendChild(h('div', 'cc-hint', 'Fix and Explain send a prompt to this chat.'));
  prFoot(foot);
}

// ─── Actions ─────────────────────────────────────────────────────────────────

function send(text) {
  let ok = false;
  try { ok = hooks.send(text) !== false; } catch (_) { ok = false; }
  return ok;
}

function setTab(id) {
  if (!TABS.some((t) => t[0] === id)) return;
  st.tab = id;
  paint();
  if (id === 'changes') loadChanges(); else loadPr();
}

function refresh() {
  if (!st.open) return;
  const root = String(hooks.root() || '');
  if (root !== st.root) {
    // Paths noted before the first read belong to the folder about to be read.
    if (st.root) { st.turnPaths = new Set(); st.path = ''; }
    st.root = root; st.entries = []; st.rows = {}; st.diff = null; st.image = null; st.diffSeq++;
    st.pr = null; st.prState = 'idle';
  }
  if (st.tab === 'changes') loadChanges(); else loadPr();
}

function open(req) {
  const r = req || {};
  const was = st.open;
  st.open = true;
  if (r.tab && TABS.some((t) => t[0] === r.tab)) st.tab = r.tab;
  if (r.path) pick(String(r.path));
  paint();
  refresh();
  schedule();
  if (!was) { try { hooks.onToggle(true); } catch (_) {} }
}

function close() {
  if (!st.open) return;
  st.open = false;
  schedule();
  paint();
  try { hooks.onToggle(false); } catch (_) {}
}

window.ChatCanvas = {
  configure(o) { Object.assign(hooks, o || {}); },
  open,
  close,
  toggle() { if (st.open) close(); else open({}); },
  isOpen() { return st.open; },
  refresh,
  readPr,
  // The paths the last turn moved, so the list can lead with them.
  setTurnPaths(paths) { st.turnPaths = new Set(Array.isArray(paths) ? paths : []); if (st.open && st.tab === 'changes') loadChanges(); },
};
})();
