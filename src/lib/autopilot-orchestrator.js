// Collab-mode orchestrator: one headless call to the configured agent CLI
// decomposes a goal into 2..N independent sub-goals, one per parallel worker.
// The planner decides team size; the user never picks a count. A plan that
// cannot be parsed is a hard error surfaced to the user instead of a silent
// solo run; a planner timeout falls back to a local repo-based team split.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { oneShotArgs } = require('./agent-oneshot');
const { classifyTier, normalizeTier } = require('./model-routing');

const PLAN_TIMEOUT_MS = 120000;
const SNAPSHOT_MAX_FILES = 1500;
const SNAPSHOT_MAX_DEPTH = 5;
const SNAPSHOT_MAX_CHARS = 7000;
const IGNORE_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'out', 'coverage',
  '.cache', '.next', '.nuxt', '.turbo', '.vite', 'target', 'vendor',
  '.venv', 'venv', '__pycache__', 'tmp', 'temp',
]);
const EXT_LANG = new Map(Object.entries({
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.swift': 'Swift',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.cs': 'C#',
  '.cpp': 'C++',
  '.cc': 'C++',
  '.cxx': 'C++',
  '.c': 'C',
  '.h': 'C/C++',
  '.hpp': 'C++',
  '.html': 'HTML',
  '.css': 'CSS',
  '.scss': 'CSS',
  '.json': 'JSON',
  '.md': 'Markdown',
  '.yml': 'YAML',
  '.yaml': 'YAML',
  '.toml': 'TOML',
  '.sh': 'Shell',
}));
const TOKEN_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'onto', 'have',
  'has', 'had', 'are', 'was', 'were', 'will', 'would', 'should', 'could',
  'please', 'make', 'fix', 'add', 'remove', 'update', 'change', 'failed',
  'failure', 'error', 'start', 'team', 'mode', 'run', 'runs', 'running',
]);

// Per-CLI one-shot forms live in agent-oneshot.js so the planner and the
// workflow runner can never drift apart.
function plannerArgs(baseCmd, prompt, prefixArgs = []) {
  return [...prefixArgs, ...oneShotArgs(baseCmd, prompt)];
}

function buildPlanPrompt(goal, maxAgents, repoSnapshot = '', planningHint = '') {
  return [
    'You are an orchestrator planning a team of autonomous coding agents that will work IN PARALLEL on one shared goal, each in an isolated copy of THIS repository.',
    '',
    `Shared goal: ${goal}`,
    '',
    'Husk already prepared this bounded repository snapshot. Use it instead of broad live exploration; do not run tests, builds, installs, or modify files while planning.',
    repoSnapshot || 'Repository snapshot unavailable; make the smallest safe plan from the goal text.',
    planningHint ? `\nPlanning hint from repository/task sizing:\n${planningHint}` : '',
    '',
    'Size the team from BOTH the task complexity and repository surface area. A small mechanical change in a small repo may need only 2 agents; the same request in a monorepo with many package roots may need more agents. Do not hardcode team size from task wording alone.',
    'For dependency/update tasks, keep every subgoal tied to the original dependency goal. Split package roots/manifests/lockfiles across agents when the repo has enough independent package surfaces; use a separate validation/config agent only when there is meaningful dependency-related config or verification work. Do not turn a dependency bump into a broad security-workflow review.',
    `Then split the goal into INDEPENDENT, NON-OVERLAPPING sub-tasks mapped to REAL areas of this repo that actually contain relevant work, one agent each, with clear boundaries so no two agents touch the same files. Use as FEW agents as the goal genuinely needs (2 to ${maxAgents}); an agent that would find nothing to do is waste, so do not create it.`,
    'For EACH agent set "tier": "cheap" if its sub-task is mechanical (bumping deps, formatting, renaming, finding TODOs, simple edits) or "smart" if it needs real reasoning (design, debugging, non-trivial implementation). Prefer cheap when the work is genuinely mechanical -- it saves the user money.',
    'Reply with ONLY a JSON object, no prose before or after:',
    '{"agents":[{"role":"short-name-from-a-real-area","tier":"cheap|smart","subgoal":"precise scope and deliverable, naming the actual paths this agent owns"}]}',
  ].join('\n');
}

function isDependencyUpdateGoal(goal) {
  const g = String(goal || '').toLowerCase();
  return (
    /\b(bump|update|upgrade|refresh)\b[\s\S]{0,80}\b(dependencies|dependency|deps|packages?|lockfiles?|package-lock|npm|pnpm|yarn)\b/.test(g)
    || /\b(dependencies|dependency|deps|packages?|lockfiles?|package-lock|npm|pnpm|yarn)\b[\s\S]{0,80}\b(bump|update|upgrade|refresh)\b/.test(g)
  );
}

function dependencySurface(cwd, goal) {
  const p = collectRepoProfile(cwd, goal);
  const packageFiles = p.files.filter((rel) => /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lock|bun\.lockb)$/.test(rel));
  const roots = [];
  for (const rel of packageFiles) {
    const root = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '.';
    if (!roots.includes(root)) roots.push(root);
  }
  const configFiles = p.files.filter((rel) => (
    /^\.github\/dependabot\.ya?ml$/.test(rel)
    || /^\.github\/workflows\/[^/]+\.ya?ml$/.test(rel)
    || /(^|\/)(Dockerfile|compose\.ya?ml|docker-compose\.ya?ml)$/.test(rel)
  ));
  return { profile: p, packageFiles, roots, configFiles };
}

function chunkEvenly(items, count) {
  const n = Math.max(1, Math.min(count, items.length || 1));
  const chunks = Array.from({ length: n }, () => []);
  items.forEach((item, i) => chunks[i % n].push(item));
  return chunks.filter((c) => c.length);
}

function dependencyPlanningHint(goal, cwd, maxAgents) {
  if (!isDependencyUpdateGoal(goal)) return '';
  const upper = Number.isFinite(maxAgents) ? Math.max(2, Math.floor(maxAgents)) : 4;
  const s = dependencySurface(cwd, goal);
  const roots = s.roots.length ? s.roots : ['.'];
  const repoFiles = s.profile.files.length;
  const packageAgents = Math.min(Math.max(1, Math.ceil(roots.length / 2)), Math.max(1, upper - (s.configFiles.length ? 1 : 0)));
  const validationAgent = upper > packageAgents && (s.configFiles.length || repoFiles > 250);
  const suggested = Math.min(upper, packageAgents + (validationAgent ? 1 : 0));
  return [
    `Dependency/update goal detected; suggested team size ${suggested} of max ${upper}, based on ${roots.length} package root${roots.length === 1 ? '' : 's'}, ${s.configFiles.length} dependency-related config file${s.configFiles.length === 1 ? '' : 's'}, and ${repoFiles}${s.profile.fileScanTruncated ? '+' : ''} scanned files.`,
    `Package roots: ${roots.slice(0, 16).join(', ')}${roots.length > 16 ? ', ...' : ''}.`,
    s.configFiles.length ? `Dependency-related config: ${s.configFiles.slice(0, 12).join(', ')}${s.configFiles.length > 12 ? ', ...' : ''}.` : 'No dependency-related config files were prominent in the bounded scan.',
    'Use fewer agents when scopes would be empty; use more agents only when package roots/config areas are genuinely independent.',
  ].join('\n');
}

function dependencyFallbackPlan(goal, cwd, maxAgents) {
  if (!isDependencyUpdateGoal(goal)) return null;
  const upper = Number.isFinite(maxAgents) ? Math.max(2, Math.floor(maxAgents)) : 4;
  if (upper < 2) return null;
  const s = dependencySurface(cwd, goal);
  const roots = s.roots.length ? s.roots : ['.'];
  const configAgent = s.configFiles.length || s.profile.files.length > 250;
  const packageAgentSlots = Math.max(1, upper - (configAgent ? 1 : 0));
  const rootGroups = chunkEvenly(roots, Math.min(packageAgentSlots, Math.max(1, Math.ceil(roots.length / 2))));
  const agents = rootGroups.map((group, i) => ({
    role: rootGroups.length === 1 ? 'dependency-packages' : `dependency-packages-${i + 1}`,
    tier: 'cheap',
    subgoal: `Complete the shared dependency-update goal only for package root${group.length === 1 ? '' : 's'} ${group.join(', ')}. Update the relevant package manifests and lockfiles under those roots, prefer safe patch/minor versions unless the user asked for majors, and do not edit CI/workflow/config files.`,
  }));
  if (agents.length < upper && configAgent) {
    const scope = s.configFiles.length
      ? s.configFiles.slice(0, 20).join(', ')
      : 'existing dependency-related validation/build configuration';
    agents.push({
      role: 'dependency-validation',
      tier: 'cheap',
      subgoal: `Validate the shared dependency-update goal using ${scope}. Only edit dependency-management or CI config if directly required by the dependency bump; otherwise make no file changes and report that validation/config needed no edits. Do not edit package manifests or lockfiles.`,
    });
  }
  if (agents.length < 2) {
    agents.push({
      role: 'dependency-review',
      tier: 'cheap',
      subgoal: 'Review the shared dependency-update goal for consistency and validation gaps. Do not edit package manifests/lockfiles owned by the package agent; only make directly necessary dependency-related config or test-command updates.',
    });
  }
  return agents.slice(0, upper);
}

function safeReadDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
}

function normalizeRel(p) {
  return String(p || '').split(path.sep).join('/');
}

function topSegment(rel) {
  const clean = normalizeRel(rel);
  return clean.includes('/') ? clean.split('/')[0] : '(root)';
}

function inc(map, key, by = 1) {
  map.set(key, (map.get(key) || 0) + by);
}

function goalTokens(goal) {
  const raw = String(goal || '').toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) || [];
  const out = [];
  for (const token of raw) {
    const parts = token.split(/[-_]+/).filter(Boolean);
    for (const part of parts.length ? parts : [token]) {
      if (part.length < 3 || TOKEN_STOPWORDS.has(part)) continue;
      if (!out.includes(part)) out.push(part);
      if (out.length >= 16) return out;
    }
  }
  return out;
}

function collectRepoProfile(cwd, goal) {
  const profile = {
    root: cwd || '',
    topDirs: [],
    topFiles: [],
    files: [],
    fileScanTruncated: false,
    dirCounts: new Map(),
    langCounts: new Map(),
    packageInfo: null,
    relevantPaths: [],
  };
  if (!cwd || !fs.existsSync(cwd)) return profile;

  const entries = safeReadDir(cwd).sort((a, b) => a.name.localeCompare(b.name));
  const queue = [];
  const addFile = (rel) => {
    if (profile.files.length >= SNAPSHOT_MAX_FILES) {
      profile.fileScanTruncated = true;
      return;
    }
    const clean = normalizeRel(rel);
    profile.files.push(clean);
    inc(profile.dirCounts, topSegment(clean));
    const lang = EXT_LANG.get(path.extname(clean).toLowerCase());
    if (lang) inc(profile.langCounts, lang);
  };

  for (const e of entries) {
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name)) continue;
      profile.topDirs.push({ name: e.name, fileCount: 0 });
      queue.push({ abs: path.join(cwd, e.name), rel: e.name, depth: 1 });
    } else if (e.isFile()) {
      profile.topFiles.push(e.name);
      addFile(e.name);
    }
  }

  for (let qi = 0; qi < queue.length && profile.files.length < SNAPSHOT_MAX_FILES; qi++) {
    const cur = queue[qi];
    for (const e of safeReadDir(cur.abs).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name) || cur.depth >= SNAPSHOT_MAX_DEPTH) continue;
        queue.push({ abs: path.join(cur.abs, e.name), rel: `${cur.rel}/${e.name}`, depth: cur.depth + 1 });
      } else if (e.isFile()) {
        addFile(`${cur.rel}/${e.name}`);
        if (profile.files.length >= SNAPSHOT_MAX_FILES) break;
      }
    }
  }

  for (const d of profile.topDirs) d.fileCount = profile.dirCounts.get(d.name) || 0;
  profile.topDirs.sort((a, b) => (b.fileCount - a.fileCount) || a.name.localeCompare(b.name));

  try {
    const pkgPath = path.join(cwd, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      profile.packageInfo = {
        name: typeof pkg.name === 'string' ? pkg.name : null,
        scripts: pkg && typeof pkg.scripts === 'object' && pkg.scripts
          ? Object.entries(pkg.scripts).slice(0, 10)
          : [],
        deps: [
          ...Object.keys(pkg.dependencies || {}).slice(0, 8),
          ...Object.keys(pkg.devDependencies || {}).slice(0, 8),
        ].slice(0, 12),
      };
    }
  } catch (_) {}

  const tokens = goalTokens(goal);
  if (tokens.length) {
    profile.relevantPaths = profile.files
      .map((file) => {
        const lower = file.toLowerCase();
        let score = 0;
        for (const t of tokens) {
          if (lower.includes(t)) score += lower.endsWith(`${t}.js`) || lower.endsWith(`${t}.ts`) ? 3 : 1;
        }
        return { file, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => (b.score - a.score) || a.file.localeCompare(b.file))
      .slice(0, 60)
      .map((x) => x.file);
  }

  return profile;
}

function formatCountMap(map, limit) {
  return [...map.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
}

function buildRepoSnapshot(cwd, goal) {
  const p = collectRepoProfile(cwd, goal);
  const topDirs = p.topDirs.slice(0, 18).map((d) => `${d.name}/ (${d.fileCount})`).join(', ') || 'none';
  const topFiles = p.topFiles.slice(0, 18).join(', ') || 'none';
  const langs = formatCountMap(p.langCounts, 10) || 'unknown';
  const prominent = p.topDirs.slice(0, 8).map((d) => `- ${d.name}/: ${d.fileCount} scanned files`);
  const relevant = p.relevantPaths.length
    ? p.relevantPaths.slice(0, 40).map((f) => `- ${f}`)
    : ['- No direct filename/path matches for the goal terms. Prefer prominent areas and package metadata.'];
  const lines = [
    'Repository snapshot:',
    `- Root: ${p.root || 'unknown'}`,
    `- Top-level directories: ${topDirs}`,
    `- Top-level files: ${topFiles}`,
    `- Languages by scanned files: ${langs}${p.fileScanTruncated ? ' (scan capped)' : ''}`,
  ];
  if (p.packageInfo) {
    if (p.packageInfo.name) lines.push(`- package.json name: ${p.packageInfo.name}`);
    if (p.packageInfo.scripts.length) {
      lines.push(`- package scripts: ${p.packageInfo.scripts.map(([k, v]) => `${k}=${JSON.stringify(String(v).slice(0, 80))}`).join(', ')}`);
    }
    if (p.packageInfo.deps.length) lines.push(`- package deps/devDeps sample: ${p.packageInfo.deps.join(', ')}`);
  }
  lines.push('- Prominent areas:', ...prominent);
  lines.push('- Goal-relevant paths from filename/path matching:', ...relevant);
  return lines.join('\n').slice(0, SNAPSHOT_MAX_CHARS);
}

function roleFromPath(p) {
  return String(p || 'agent').replace(/^\W+|\W+$/g, '').replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 36) || 'agent';
}

function fallbackPlan(goal, cwd, maxAgents) {
  const upper = Number.isFinite(maxAgents) ? Math.max(2, Math.floor(maxAgents)) : 4;
  const p = collectRepoProfile(cwd, goal);
  const agents = [];
  const usedRoles = new Set();
  const usedScopes = new Set();
  const addAgent = (role, subgoal) => {
    const cleanRole = roleFromPath(role);
    const key = cleanRole.toLowerCase();
    if (usedRoles.has(key) || agents.length >= upper) return;
    usedRoles.add(key);
    agents.push({ role: cleanRole, subgoal, tier: resolveTier({ subgoal }) });
  };

  const relevantGroups = new Map();
  for (const file of p.relevantPaths) {
    const top = topSegment(file);
    if (top === '(root)' || usedScopes.has(top)) continue;
    if (!relevantGroups.has(top)) relevantGroups.set(top, []);
    relevantGroups.get(top).push(file);
  }
  if (relevantGroups.size >= 2) {
    for (const [scope, files] of [...relevantGroups.entries()].sort((a, b) => b[1].length - a[1].length)) {
      usedScopes.add(scope);
      addAgent(scope, `Address the shared goal only under ${scope}/. Start from these goal-relevant paths: ${files.slice(0, 8).join(', ')}. Do not edit files owned by other team members.`);
    }
  }

  const topNames = p.topDirs.map((d) => d.name);
  const hasTop = (name) => topNames.includes(name);
  if (hasTop('src') && !usedScopes.has('src')) {
    usedScopes.add('src');
    const hint = p.relevantPaths.filter((f) => f.startsWith('src/')).slice(0, 8);
    addAgent('implementation', `Implement the shared goal only under src/.${hint.length ? ` Start from: ${hint.join(', ')}.` : ''} Do not edit tests, docs, or unrelated root files.`);
  }
  const testDir = hasTop('test') ? 'test' : (hasTop('tests') ? 'tests' : null);
  if (testDir && !usedScopes.has(testDir)) {
    usedScopes.add(testDir);
    addAgent('tests', `Add or update validation only under ${testDir}/ for the shared goal. Do not edit implementation files owned by other team members.`);
  }
  if (hasTop('docs') && !usedScopes.has('docs')) {
    usedScopes.add('docs');
    addAgent('docs', 'Update documentation only under docs/ or existing README files for the shared goal. Do not edit implementation or tests.');
  }

  for (const d of p.topDirs) {
    if (agents.length >= 2 || usedScopes.has(d.name)) continue;
    usedScopes.add(d.name);
    addAgent(d.name, `Address the shared goal only under ${d.name}/. Do not edit files owned by other team members.`);
  }

  if (agents.length < 2 && p.topFiles.length) {
    addAgent('root-files', `Address only root-level files relevant to the shared goal (${p.topFiles.slice(0, 8).join(', ')}). Do not edit subdirectories owned by other team members.`);
  }
  if (agents.length < 2) {
    addAgent('validation', 'Create or run validation for the shared goal using existing tests or build commands. Only edit tests or docs if needed; do not edit implementation files.');
  }

  return agents.length >= 2 ? agents.slice(0, upper) : null;
}

// Pull the plan out of possibly prose-wrapped output. Returns a cleaned
// agents array (2..maxAgents) or null when no usable plan exists.
function resolveTier(a) {
  if (typeof a.tier === 'string' && (a.tier === 'smart' || a.tier === 'cheap')) {
    return normalizeTier(a.tier);
  }
  return classifyTier(a.subgoal) === 'cheap' ? 'cheap' : 'smart';
}

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');
}

function jsonCandidates(text) {
  const s = stripAnsi(text);
  const out = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch !== '{' && ch !== '[' && ch !== '}' && ch !== ']') continue;
    if (ch === '{' || ch === '[') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        out.push(s.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

function planAgentsFrom(obj) {
  if (Array.isArray(obj)) return obj;
  if (!obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj.agents)) return obj.agents;
  // Common near-misses from LLM planners. Keep this narrow: each entry still
  // has to pass the role+subgoal validation below.
  for (const key of ['team', 'workers', 'tasks']) {
    if (Array.isArray(obj[key])) return obj[key];
  }
  return null;
}

function cleanPlanObject(obj, maxAgents) {
  const agents = planAgentsFrom(obj);
  if (!agents) return null;
  const upper = Number.isFinite(maxAgents) ? Math.max(2, Math.floor(maxAgents)) : 4;
  const clean = agents
    .filter((a) => a && typeof a.role === 'string'
      && (typeof a.subgoal === 'string' || typeof a.goal === 'string' || typeof a.task === 'string'))
    .map((a) => {
      const subgoal = String(a.subgoal || a.goal || a.task).trim().slice(0, 2000);
      return {
        role: (a.role.trim().slice(0, 40) || 'agent').replace(/\s+/g, ' '),
        subgoal,
        tier: resolveTier({ ...a, subgoal }),
      };
    })
    .filter((a) => a.subgoal)
    .slice(0, upper);
  return clean.length >= 2 ? clean : null;
}

function extractPlan(text, maxAgents) {
  for (const cand of jsonCandidates(text)) {
    let obj;
    try { obj = JSON.parse(cand); } catch (_) { continue; }
    const clean = cleanPlanObject(obj, maxAgents);
    if (clean) return clean;
  }
  return null;
}

function planCollab({ goal, agentCommand, cwd, maxAgents, env, onChild, timeoutMs }) {
  return new Promise((resolve) => {
    const tokens = String(agentCommand || 'claude').trim().split(/\s+/).filter(Boolean);
    const cmd = tokens[0] || 'claude';
    const prefixArgs = tokens.slice(1);
    const base = cmd.split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/i, '');
    const prompt = buildPlanPrompt(goal, maxAgents, buildRepoSnapshot(cwd, goal), dependencyPlanningHint(goal, cwd, maxAgents));
    const fallback = () => dependencyFallbackPlan(goal, cwd, maxAgents) || fallbackPlan(goal, cwd, maxAgents);
    const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : PLAN_TIMEOUT_MS;
    let child;
    try {
      child = spawn(cmd, plannerArgs(base, prompt, prefixArgs), { cwd, stdio: ['ignore', 'pipe', 'pipe'], env });
    } catch (err) {
      return resolve({ ok: false, error: `could not launch the planner: ${(err && err.message) || err}` });
    }
    // Hand the child to the caller so the planning phase can be cancelled.
    if (typeof onChild === 'function') { try { onChild(child); } catch (_) {} }
    let out = '';
    let errOut = '';
    let settled = false;
    const done = (res) => { if (!settled) { settled = true; resolve(res); } };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      const agents = extractPlan(out, maxAgents) || extractPlan(`${out}\n${errOut}`, maxAgents);
      if (agents) return done({ ok: true, agents, warning: 'Planner produced a team plan but did not exit; using the emitted plan.' });
      const localAgents = fallback();
      if (localAgents) return done({ ok: true, agents: localAgents, warning: 'Planner timed out; using a local repo-based fallback team plan.' });
      done({ ok: false, error: 'planner timed out' });
    }, effectiveTimeout);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { errOut += d; });
    child.on('error', (err) => { clearTimeout(timer); done({ ok: false, error: (err && err.message) || String(err) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const agents = extractPlan(out, maxAgents) || extractPlan(`${out}\n${errOut}`, maxAgents);
      if (agents) return done({ ok: true, agents });
      done({
        ok: false,
        error: code === 0
          ? 'planner returned no parseable team plan'
          : `planner exited ${code}: ${String(errOut || out).slice(0, 300)}`,
      });
    });
  });
}

module.exports = {
  planCollab,
  extractPlan,
  buildPlanPrompt,
  buildRepoSnapshot,
  dependencyFallbackPlan,
  dependencyPlanningHint,
  fallbackPlan,
  resolveTier,
};
