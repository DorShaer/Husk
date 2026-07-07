'use strict';

// One-shot (non-interactive) invocation forms per agent CLI. Single source
// of truth for every place Husk runs an agent headlessly (the collab
// planner, workflow nodes). Forms verified against each CLI's --help:
//   claude   -p <prompt>
//   copilot  -p <prompt>                       (non-interactive prompt mode)
//   codex    exec --skip-git-repo-check <prompt>
//   aider    --message <prompt> --yes-always   (one message, no confirms)
//   gemini   -p <prompt>
// Unknown CLIs get -p, the most common convention among agent CLIs.

function agentBaseName(agentCommand) {
  return String(agentCommand || 'claude').trim().split(/\s+/)[0]
    .split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/i, '');
}

function oneShotArgs(agentCommand, prompt, opts = {}) {
  const base = agentBaseName(agentCommand);
  const model = Array.isArray(opts.modelArgs) ? opts.modelArgs : [];
  // codex exec refuses to run outside a trusted git directory unless told
  // to skip that check.
  if (base === 'codex') return ['exec', ...model, '--skip-git-repo-check', prompt];
  // aider blocks on interactive confirmations without --yes-always, which
  // stalls a headless call forever.
  if (base === 'aider') return [...model, '--message', prompt, '--yes-always'];
  return [...model, '-p', prompt];
}

module.exports = { agentBaseName, oneShotArgs };
