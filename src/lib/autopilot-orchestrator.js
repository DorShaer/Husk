// Collab-mode orchestrator: one headless call to the configured agent CLI
// decomposes a goal into 2..N independent sub-goals, one per parallel worker.
// The planner decides team size; the user never picks a count. A plan that
// cannot be parsed is a hard error surfaced to the user, never a silent solo
// run, so the mode's promise (a coordinated team) is kept or visibly broken.
const { spawn } = require('child_process');
const { oneShotArgs } = require('./agent-oneshot');
const { classifyTier, normalizeTier } = require('./model-routing');

const PLAN_TIMEOUT_MS = 120000;

// Per-CLI one-shot forms live in agent-oneshot.js so the planner and the
// workflow runner can never drift apart.
function plannerArgs(baseCmd, prompt) {
  return oneShotArgs(baseCmd, prompt);
}

function buildPlanPrompt(goal, maxAgents) {
  return [
    'You are an orchestrator planning a team of autonomous coding agents that will work IN PARALLEL on one shared goal, each in an isolated copy of THIS repository.',
    '',
    `Shared goal: ${goal}`,
    '',
    'First INSPECT this actual repository before deciding anything: list the top-level directories, detect the languages and frameworks present, and find where the goal-relevant code actually lives. Do not assume a generic backend/frontend/build split -- if this project has no backend, do not invent a backend agent.',
    '',
    `Then split the goal into INDEPENDENT, NON-OVERLAPPING sub-tasks mapped to REAL areas of this repo that actually contain relevant work, one agent each, with clear boundaries so no two agents touch the same files. Use as FEW agents as the goal genuinely needs (2 to ${maxAgents}); an agent that would find nothing to do is waste, so do not create it.`,
    'For EACH agent set "tier": "cheap" if its sub-task is mechanical (bumping deps, formatting, renaming, finding TODOs, simple edits) or "smart" if it needs real reasoning (design, debugging, non-trivial implementation). Prefer cheap when the work is genuinely mechanical -- it saves the user money.',
    'Reply with ONLY a JSON object, no prose before or after:',
    '{"agents":[{"role":"short-name-from-a-real-area","tier":"cheap|smart","subgoal":"precise scope and deliverable, naming the actual paths this agent owns"}]}',
  ].join('\n');
}

// Pull the plan out of possibly prose-wrapped output. Returns a cleaned
// agents array (2..maxAgents) or null when no usable plan exists.
function extractPlan(text, maxAgents) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj;
  try { obj = JSON.parse(m[0]); } catch (_) { return null; }
  const agents = obj && Array.isArray(obj.agents) ? obj.agents : null;
  if (!agents) return null;
  const clean = agents
    .filter((a) => a && typeof a.role === 'string' && typeof a.subgoal === 'string' && a.subgoal.trim())
    .map((a) => ({
      role: (a.role.trim().slice(0, 40) || 'agent').replace(/\s+/g, ' '),
      subgoal: a.subgoal.trim().slice(0, 2000),
      // Trust the planner's tier; fall back to a keyword classifier on the
      // sub-task so a plan without tiers still routes.
      tier: normalizeTier(typeof a.tier === 'string' ? a.tier : classifyTier(a.subgoal)),
    }))
    .slice(0, Math.max(2, maxAgents));
  return clean.length >= 2 ? clean : null;
}

function planCollab({ goal, agentCommand, cwd, maxAgents, env, onChild }) {
  return new Promise((resolve) => {
    const tokens = String(agentCommand || 'claude').trim().split(/\s+/).filter(Boolean);
    const cmd = tokens[0] || 'claude';
    const base = cmd.split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/i, '');
    const prompt = buildPlanPrompt(goal, maxAgents);
    let child;
    try {
      child = spawn(cmd, plannerArgs(base, prompt), { cwd, stdio: ['ignore', 'pipe', 'pipe'], env });
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
      done({ ok: false, error: 'planner timed out' });
    }, PLAN_TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { errOut += d; });
    child.on('error', (err) => { clearTimeout(timer); done({ ok: false, error: (err && err.message) || String(err) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const agents = extractPlan(out, maxAgents);
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

module.exports = { planCollab, extractPlan, buildPlanPrompt };
