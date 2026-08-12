'use strict';

function hasFlag(args, names) {
  return args.some((arg) => names.includes(arg) || names.some((name) => arg.startsWith(name + '=')));
}

function withAutopilotArgs(agentCommand, args = []) {
  const base = String(agentCommand || '').trim().split(/\s+/)[0]
    .split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/i, '');
  const out = Array.isArray(args) ? args.slice() : [];
  const add = (...items) => { out.push(...items); };

  if (base === 'claude') {
    if (!hasFlag(out, ['--permission-mode'])) add('--permission-mode', 'bypassPermissions');
  } else if (base === 'copilot') {
    if (!hasFlag(out, ['--no-ask-user'])) add('--no-ask-user');
    if (!hasFlag(out, ['--allow-all', '--yolo'])) add('--allow-all');
  } else if (base === 'gemini') {
    if (!hasFlag(out, ['--approval-mode'])) add('--approval-mode', 'yolo');
    if (!hasFlag(out, ['--skip-trust'])) add('--skip-trust');
  } else if (base === 'aider') {
    if (!hasFlag(out, ['--yes-always'])) add('--yes-always');
    if (!hasFlag(out, ['--auto-accept-architect', '--no-auto-accept-architect'])) add('--auto-accept-architect');
  } else if (base === 'codex') {
    if (!hasFlag(out, ['--ask-for-approval', '--approval-mode'])) add('--ask-for-approval', 'never');
  } else if (base === 'kiro-cli') {
    if (out.length && !String(out[0]).startsWith('-') && out[0] !== 'chat') return out;
    if (!out.length || String(out[0]).startsWith('-')) out.unshift('chat');
    if (!hasFlag(out, ['--trust-all-tools', '--trust-tools'])) add('--trust-all-tools');
  }

  return out;
}

module.exports = {
  hasFlag,
  withAutopilotArgs,
};
