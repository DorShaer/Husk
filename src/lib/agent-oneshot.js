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

// opts.untrusted marks a prompt that came out of a file somebody else wrote.
//
// Both flags dropped below exist to make a headless call convenient, and both
// give away a check that only matters when the instructions are not yours.
// --yes-always answers aider's confirmations before the operator sees what is
// being confirmed, and --skip-git-repo-check removes the guard that stops codex
// working in a directory nobody vouched for. For a workflow the operator wrote,
// trading those away is their call. For an imported one it is the author making
// that call about the importer's machine, which is not a trade anyone offered.
//
// Dropping them degrades the run rather than blocking it: aider stops and waits
// on a confirmation, which the operator sees as a step that is not progressing.
// A visible stall is the correct failure here. A silent auto-approval is not.
function oneShotArgs(agentCommand, prompt, opts = {}) {
  const base = agentBaseName(agentCommand);
  const model = Array.isArray(opts.modelArgs) ? opts.modelArgs : [];
  const untrusted = opts.untrusted === true;
  // codex exec refuses to run outside a trusted git directory unless told
  // to skip that check.
  if (base === 'codex') {
    return untrusted
      ? ['exec', ...model, prompt]
      : ['exec', ...model, '--skip-git-repo-check', prompt];
  }
  // aider blocks on interactive confirmations without --yes-always, which
  // stalls a headless call forever.
  if (base === 'aider') {
    return untrusted
      ? [...model, '--message', prompt]
      : [...model, '--message', prompt, '--yes-always'];
  }
  return [...model, '-p', prompt];
}

module.exports = { agentBaseName, oneShotArgs };
