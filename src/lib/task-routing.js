'use strict';

const { agentBaseName } = require('./agent-oneshot');
const { modelArgsFor, isExplicitModelValueUsable, classifyTier } = require('./model-routing');
const VENDORS = Object.freeze(['claude', 'codex', 'gemini', 'copilot', 'kiro-cli', 'aider']);
const MODEL_FLAGS = Object.freeze({ claude: '--model', codex: '--model', copilot: '--model', gemini: '-m', 'kiro-cli': '--model', aider: '--model' });
const ROLES = Object.freeze(['cheap', 'smart', 'planner', 'integrator']);

function migrateTaskRouting(config = {}) {
  if (config.taskRouting && typeof config.taskRouting === 'object') return config.taskRouting;
  const vendor = agentBaseName(config.agentCommand || 'claude');
  const old = config.modelRouting && config.modelRouting[vendor];
  if (!old || typeof old !== 'object') return {};
  const routes = {};
  for (const role of ['cheap', 'smart']) {
    if (isExplicitModelValueUsable(old[role])) routes[role] = { vendor, model: old[role] };
  }
  return routes;
}

function availableRoutes(available) {
  const out = [], seen = new Set();
  for (const a of Array.isArray(available) ? available : []) {
    const command = typeof a === 'string' ? a : a && a.command;
    if (!command) continue;
    const vendor = agentBaseName(command);
    if (!VENDORS.includes(vendor) || seen.has(vendor) || (typeof a === 'object' && a.available === false)) continue;
    seen.add(vendor);
    out.push({ vendor, command: String(command).trim() });
  }
  return out.sort((a, b) => VENDORS.indexOf(a.vendor) - VENDORS.indexOf(b.vendor));
}

function commandWithModel(command, vendor, model) {
  if (!model) return command;
  const words = String(command).trim().split(/\s+/), clean = [];
  for (let i = 0; i < words.length; i++) {
    if (words[i] === '--model' || words[i] === '-m') { i++; continue; }
    if (/^(?:--model|-m)=/.test(words[i])) continue;
    clean.push(words[i]);
  }
  return [...clean, MODEL_FLAGS[vendor], model].join(' ');
}

function resolveTaskRoute({ config = {}, role = 'smart', requested, available = [], index, agentCommand } = {}) {
  const options = availableRoutes(available);
  if (agentCommand && String(agentCommand).trim()) {
    const command = String(agentCommand).trim(), vendor = agentBaseName(command);
    return { ok: true, vendor, command, model: '', role, automatic: false, reason: 'This job has an explicit agent command.' };
  }
  if (!config.taskRouting && (!requested || !requested.vendor || requested.vendor === 'auto') && config.agentCommand && !VENDORS.includes(agentBaseName(config.agentCommand))) {
    return resolveTaskRoute({ role, available, agentCommand: config.agentCommand });
  }
  const routes = migrateTaskRouting(config);
  if (requested?.vendor === 'auto' && requested?.model) return { ok: false, error: 'Choose a vendor before choosing a specific model.' };
  const choice = requested && requested.vendor && requested.vendor !== 'auto' ? requested : (routes[role] || { vendor: 'auto', model: '' });
  const vendor = typeof choice.vendor === 'string' && choice.vendor ? choice.vendor : 'auto';
  const model = typeof choice.model === 'string' ? choice.model.trim() : '';
  if (vendor !== 'auto' && !VENDORS.includes(vendor)) return { ok: false, error: `Unknown job vendor: ${vendor}` };
  if (model && !isExplicitModelValueUsable(model)) return { ok: false, error: 'Choose a model id, not a command or status message.' };
  if (vendor === 'auto' && model) return { ok: false, error: 'Choose a vendor before choosing a specific model.' };
  let selected;
  if (vendor !== 'auto') {
    selected = options.find((a) => a.vendor === vendor);
    if (!selected) return { ok: false, error: `${vendor} is not installed. Choose another job vendor or install its CLI.` };
  } else {
    if (!options.length) return { ok: false, error: 'No installed agent CLI is available for this job.' };
    // Stable vendor order keeps choices reproducible; team indices spread work.
    const slot = Number.isInteger(index) && index >= 0 ? index : (role === 'smart' || role === 'integrator' ? 1 : 0);
    selected = options[slot % options.length];
  }
  let selectedModel = model;
  if (!config.taskRouting && (!requested || requested.vendor === 'auto') && (role === 'cheap' || role === 'smart') && routes[role]) {
    const args = modelArgsFor(selected.vendor, role, config.modelRouting || {});
    selectedModel = args.length ? args.at(-1) : '';
  }
  return {
    ok: true, vendor: selected.vendor, command: commandWithModel(selected.command, selected.vendor, selectedModel),
    model: selectedModel, role, automatic: vendor === 'auto' || !selectedModel,
    reason: vendor === 'auto'
      ? `Automatic selected ${selected.vendor} from ${options.length} installed vendor${options.length === 1 ? '' : 's'}${Number.isInteger(index) ? ' to distribute team jobs' : ''}.`
      : `${selected.vendor} is assigned to ${role === 'cheap' ? 'simple' : role === 'smart' ? 'complex' : role} jobs.`,
  };
}

function resolveCollabRoutes({ config = {}, agents = [], requested, available = [], agentCommand } = {}) {
  const planner = resolveTaskRoute({ config, role: 'planner', available });
  const integrator = resolveTaskRoute({ config, role: 'integrator', available });
  if (!planner.ok) return planner;
  if (!integrator.ok) return integrator;
  const assignments = migrateTaskRouting(config);
  const workers = [];
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    const fixedRole = assignments[a.tier] && assignments[a.tier].vendor !== 'auto';
    const choice = requested && requested.vendor !== 'auto'
      ? requested : (!fixedRole && a.vendor ? { vendor: a.vendor, model: '' } : undefined);
    const route = resolveTaskRoute({ config, role: a.tier, requested: choice, available, index: i, agentCommand });
    if (!route.ok) return { ok: false, error: `${a.role}: ${route.error}` };
    workers.push({ ...a, vendor: route.vendor, agentCommand: route.command, model: route.model || `${route.vendor} (default)`, autoSelected: route.automatic, reason: route.reason, route });
  }
  return { ok: true, planner, integrator, workers };
}

function resolveWorkflowRoutes({ config = {}, nodes = [], available = [] } = {}) {
  const routes = {};
  for (const node of nodes) {
    const role = classifyTier(node.prompt || '');
    const requested = node.agentCommand ? { vendor: agentBaseName(node.agentCommand), model: node.model || '' } : undefined;
    let route = resolveTaskRoute({ config, role, requested, available });
    if (route.ok && node.agentCommand) route = { ...route, command: commandWithModel(node.agentCommand, route.vendor, node.model || '') };
    if (route.ok && !node.agentCommand && node.model) route = resolveTaskRoute({ config, role, requested: { vendor: route.vendor, model: node.model }, available });
    if (!route.ok) return { ok: false, error: `${node.name || node.id}: ${route.error}` };
    routes[node.id] = route;
  }
  return { ok: true, routes };
}

module.exports = { VENDORS, MODEL_FLAGS, ROLES, migrateTaskRouting, availableRoutes, commandWithModel, resolveTaskRoute, resolveCollabRoutes, resolveWorkflowRoutes };
