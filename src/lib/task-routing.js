'use strict';

const { agentBaseName } = require('./agent-oneshot');
const { resolveModel, isExplicitModelValueUsable, classifyTier } = require('./model-routing');
const VENDORS = Object.freeze(['claude', 'codex', 'gemini', 'copilot', 'kiro-cli', 'aider']);
const MODEL_FLAGS = Object.freeze({ claude: '--model', codex: '--model', copilot: '--model', gemini: '-m', 'kiro-cli': '--model', aider: '--model' });
const ROLES = Object.freeze(['cheap', 'smart', 'planner', 'integrator']);
const ROLE_LABELS = Object.freeze({ cheap: 'simple', smart: 'complex', planner: 'planner', integrator: 'integrator' });

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

function seedTaskRouting(config = {}, available = []) {
  if (config.firstRunDone === false) return config;
  if (config.taskRouting && typeof config.taskRouting === 'object') return config;
  const vendor = agentBaseName(config.agentCommand || '');
  const connected = Array.isArray(config.connectedClis) ? config.connectedClis : [vendor];
  if (!connected.includes(vendor) || !availableRoutes(available).some((a) => a.vendor === vendor)) return config;
  const routes = migrateTaskRouting(config);
  for (const role of ROLES) if (!routes[role]) routes[role] = { vendor, model: '' };
  return { ...config, taskRouting: routes };
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

function resolveTaskRoute({ config = {}, role = 'smart', requested, available = [], agentCommand, catalogs } = {}) {
  const options = availableRoutes(available);
  if (agentCommand && String(agentCommand).trim()) {
    const command = String(agentCommand).trim(), vendor = agentBaseName(command);
    const m = command.match(/(?:^|\s)(?:--model|-m)(?:=|\s+)(\S+)/);
    return { ok: true, vendor, command, model: m ? m[1] : '', role, automatic: false, reason: 'This job has an explicit agent command.' };
  }
  if (!config.taskRouting && (!requested || !requested.vendor || requested.vendor === 'auto') && config.agentCommand && !VENDORS.includes(agentBaseName(config.agentCommand))) {
    return resolveTaskRoute({ role, available, agentCommand: config.agentCommand });
  }
  const routes = migrateTaskRouting(config);
  if ((requested?.vendor === 'auto' || requested?.vendor === 'husk-auto') && requested?.model) return { ok: false, error: 'Choose a vendor before choosing a specific model.' };
  let choice = requested?.vendor === 'husk-auto' ? { vendor: 'auto', model: '' }
    : requested && requested.vendor && requested.vendor !== 'auto' ? requested : routes[role];
  const automatic = choice?.vendor === 'auto';
  if (automatic) {
    if (choice.model) return { ok: false, error: 'Choose a vendor before choosing a specific model.' };
    const tier = role === 'cheap' ? 'cheap' : 'smart';
    // Prefer an installed CLI with a usable model for this tier. Stable vendor
    // ordering breaks ties; chat defaults never affect automatic job choices.
    const selected = options.find((a) => resolveModel(a.vendor, tier, config.modelRouting || {}, catalogs && catalogs[a.vendor]).model) || options[0];
    if (!selected) return { ok: false, needsSetup: true, role, error: 'No supported CLI is installed. Install a CLI before running jobs.' };
    choice = { vendor: selected.vendor, model: '' };
  } else if ((!choice || !choice.vendor) && options.length === 1) {
    choice = { vendor: options[0].vendor, model: '' };
  }
  if (!choice || typeof choice.vendor !== 'string' || !choice.vendor) {
    return { ok: false, needsSetup: true, role, error: `No CLI is set for ${ROLE_LABELS[role] || role} jobs. Choose a vendor or Auto by Husk in Autopilot, Configure models.` };
  }
  const vendor = choice.vendor;
  const model = typeof choice.model === 'string' ? choice.model.trim() : '';
  if (!VENDORS.includes(vendor)) return { ok: false, error: `Unknown job vendor: ${vendor}` };
  if (model && !isExplicitModelValueUsable(model)) return { ok: false, error: 'Choose a model id, not a command or status message.' };
  const selected = options.find((a) => a.vendor === vendor);
  if (!selected) return { ok: false, error: `${vendor} is not installed. Choose another job vendor or install its CLI.` };
  // A legacy route carries only the vendor; its model comes from the CLI's routing.
  let selectedModel = config.taskRouting || requested?.vendor === choice.vendor ? model : '';
  let notice = '';
  if (!selectedModel) {
    const r = resolveModel(selected.vendor, role === 'cheap' ? 'cheap' : 'smart', config.modelRouting || {}, catalogs && catalogs[selected.vendor]);
    selectedModel = r.model;
    notice = r.notice;
  }
  return {
    ok: true, vendor: selected.vendor, command: commandWithModel(selected.command, selected.vendor, selectedModel),
    model: selectedModel, role, automatic, notice,
    reason: automatic ? `Auto by Husk selected ${selected.vendor} for ${ROLE_LABELS[role] || role} jobs.` + (selectedModel ? ` Model: ${selectedModel}.` : ` Using the CLI's default model.`) : `${selected.vendor} is assigned to ${ROLE_LABELS[role] || role} jobs.`
      + (selectedModel ? '' : ` ${selected.vendor} uses its own default model.`),
  };
}

function resolveCollabRoutes({ config = {}, agents = [], requested, available = [], agentCommand, catalogs } = {}) {
  const planner = resolveTaskRoute({ config, role: 'planner', available, catalogs });
  const integrator = resolveTaskRoute({ config, role: 'integrator', available, catalogs });
  if (!planner.ok) return planner;
  if (!integrator.ok) return integrator;
  const workers = [];
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    // A worker runs where its job type is routed, or where the run itself says.
    const choice = requested && requested.vendor && requested.vendor !== 'auto' ? requested : undefined;
    const route = resolveTaskRoute({ config, role: a.tier, requested: choice, available, agentCommand, catalogs });
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

module.exports = { VENDORS, MODEL_FLAGS, ROLES, migrateTaskRouting, seedTaskRouting, availableRoutes, commandWithModel, resolveTaskRoute, resolveCollabRoutes, resolveWorkflowRoutes };
