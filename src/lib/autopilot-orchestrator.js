// Collab-mode orchestrator: one headless call to the configured agent CLI
// decomposes a goal into 2..N independent sub-goals, one per parallel worker.
// The planner decides team size; the user never picks a count. A plan that
// cannot be parsed is a hard error surfaced to the user, never a silent solo
// run, so the mode's promise (a coordinated team) is kept or visibly broken.
const { spawn } = require('child_process');

const PLAN_TIMEOUT_MS = 120000;

function plannerArgs(baseCmd, prompt) {
  if (baseCmd === 'codex') return ['exec', '--skip-git-repo-check', prompt];
  // claude and most agent CLIs accept -p for a one-shot prompt.
  return ['-p', prompt];
}

function buildPlanPrompt(goal, maxAgents) {
  return [
    'You are an orchestrator planning a team of autonomous coding agents that will work IN PARALLEL on one shared goal, each in an isolated copy of the same repository.',
    '',
    `Shared goal: ${goal}`,
    '',
    `Decide how many agents this goal genuinely needs, from 2 to ${maxAgents}; prefer the fewest that truly parallelize. Split the goal into that many INDEPENDENT, NON-OVERLAPPING sub-tasks with clear scope boundaries so no two agents edit the same areas.`,
    'Reply with ONLY a JSON object, no prose before or after, in exactly this shape:',
    '{"agents":[{"role":"short-name","subgoal":"precise scope and deliverable for this agent"}]}',
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
    }))
    .slice(0, Math.max(2, maxAgents));
  return clean.length >= 2 ? clean : null;
}

function planCollab({ goal, agentCommand, cwd, maxAgents, env }) {
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
