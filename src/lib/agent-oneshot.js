'use strict';

// One-shot (non-interactive) invocation forms per agent CLI. Single source
// of truth for every place Husk runs an agent headlessly (the collab
// planner, workflow nodes). Forms verified against each CLI's --help:
//   claude   -p <prompt>
//   copilot  -p <prompt>                       (non-interactive prompt mode)
//   codex    exec --skip-git-repo-check <prompt>
//   aider    --message <prompt> --yes-always   (one message, no confirms)
//   gemini   -p <prompt>
//   kiro-cli chat --no-interactive <prompt>
// Unknown CLIs get -p, the most common convention among agent CLIs.

function agentBaseName(agentCommand) {
  return String(agentCommand || 'claude').trim().split(/\s+/)[0]
    .split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/i, '');
}

// opts.untrusted marks a prompt that came out of a file the operator did not
// write. Such a run omits the convenience flags below and takes each CLI's
// own default handling instead.
function oneShotArgs(agentCommand, prompt, opts = {}) {
  const base = agentBaseName(agentCommand);
  const model = Array.isArray(opts.modelArgs) ? opts.modelArgs : [];
  const untrusted = opts.untrusted === true;
  // codex exec runs in a plain directory only when told to skip its own
  // repository check.
  if (base === 'codex') {
    return untrusted
      ? ['exec', ...model, prompt]
      : ['exec', ...model, '--skip-git-repo-check', prompt];
  }
  // aider waits on interactive confirmations without --yes-always, which
  // stalls a headless call.
  if (base === 'aider') {
    return untrusted
      ? [...model, '--message', prompt]
      : [...model, '--message', prompt, '--yes-always'];
  }
  if (base === 'kiro-cli') {
    return ['chat', ...model, '--no-interactive', prompt];
  }
  return [...model, '-p', prompt];
}

module.exports = { agentBaseName, oneShotArgs };
