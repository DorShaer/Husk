'use strict';

// Per-agent instruction injection.
//
// Husk's session directives (the agent's name, the speech-balloon line the
// desktop app reads aloud, and whether a recap is wanted) are delivered to
// each agent through that agent's OWN native instruction channel. This is
// the single place that knows the per-agent mechanism.
//
//   claude   -> the --append-system-prompt flag (no files touched)
//   copilot  -> a marker-managed block in the project's
//               .github/copilot-instructions.md (the file the copilot CLI
//               reads; it has no system-prompt flag)
//   other    -> none yet (the agent gets no Husk directives)
//
// planInjection is PURE: it returns a plan. The caller applies it (adds the
// args, or reads/merges/writes the instructions file).

const { agentKey } = require('./mcp/common');
const { buildHuskPrompt } = require('./pai-state');

const HUSK_SESSION_START = '<!-- HUSK-SESSION:START -->';
const HUSK_SESSION_END = '<!-- HUSK-SESSION:END -->';

function cleanName(agentName) {
  return (typeof agentName === 'string' ? agentName : '')
    .replace(/[^A-Za-z0-9 _-]/g, '')
    .slice(0, 40) || 'Husk';
}

// Vendor-neutral session directives for any agent that is not claude. Plain
// prose, no claude / CLAUDE.md / PAI references. Covers identity naming, the
// speech-balloon line Husk's voice reads, and optional recap suppression.
function buildGenericDirectives({ agentName, recap } = {}) {
  const name = cleanName(agentName);
  const lines = [
    `Your name in this session is ${name}. When asked your name or identity, answer as ${name}.`,
    `End substantive replies with one line of the form "\u{1F5E3}\u{FE0F} ${name}: <8 to 16 word summary>" so the Husk desktop app can read your reply aloud.`,
  ];
  if (recap === false) {
    lines.push('Do not add any other end-of-response summary or recap line.');
  }
  return lines.join('\n');
}

// The managed block (markers + body) that lands in the instructions file.
function renderSessionBlock(body) {
  return [
    HUSK_SESSION_START,
    '<!-- Managed by Husk. This block is rewritten each time the agent starts.',
    '     Edit content outside the markers freely. -->',
    '',
    String(body || '').trim(),
    '',
    HUSK_SESSION_END,
  ].join('\n');
}

// Merge the session block into an existing instructions document,
// non-destructively: replace the marked region in place when present, else
// append. Content outside the markers is always preserved.
function mergeSessionBlock(existingText, body) {
  const existing = typeof existingText === 'string' ? existingText : '';
  const block = renderSessionBlock(body);
  const startIdx = existing.indexOf(HUSK_SESSION_START);
  const endIdx = existing.indexOf(HUSK_SESSION_END);
  let before;
  let after;
  if (startIdx >= 0 && endIdx > startIdx) {
    before = existing.slice(0, startIdx).replace(/\s+$/, '');
    after = existing.slice(endIdx + HUSK_SESSION_END.length).replace(/^\s+/, '');
  } else {
    before = existing.replace(/\s+$/, '');
    after = '';
  }
  const parts = [];
  if (before) parts.push(before);
  parts.push(block);
  if (after) parts.push(after);
  return parts.join('\n\n') + '\n';
}

// Plan how to deliver the directives to a given agent.
//   { method: 'system-prompt-arg', args: [...] }            (claude)
//   { method: 'instructions-file', filePath, body }         (copilot)
//   { method: 'none' }                                      (everything else)
function planInjection({ agentCommand, agentName, paiEnabled, recap } = {}) {
  const key = agentKey(agentCommand);
  if (key === 'claude') {
    const prompt = buildHuskPrompt({ agentName, paiEnabled: paiEnabled !== false, recap });
    // Silence the agent's own inline statusline inside Husk; Husk's right-side
    // STATUS panel is the visual statusline. Delivered as an inline --settings
    // JSON string, which claude MERGES over the user's settings.json (so every
    // other user setting still applies) and, being a string rather than a temp
    // file, is never written back to, so folder-trust in ~/.claude.json is left
    // intact. statusLine cannot be null per the schema, so a no-op command that
    // prints nothing blanks it.
    const settingsOverride = JSON.stringify({ statusLine: { type: 'command', command: '/bin/true' } });
    return { method: 'system-prompt-arg', args: ['--settings', settingsOverride, '--append-system-prompt', prompt] };
  }
  const body = buildGenericDirectives({ agentName, recap });
  if (key === 'copilot') {
    // copilot auto-reads .github/copilot-instructions.md in the project.
    return { method: 'instructions-file', filePath: '.github/copilot-instructions.md', body };
  }
  if (key === 'codex') {
    // codex auto-reads AGENTS.md from the project root. Merge non-destructively
    // so the user's own AGENTS.md content is preserved.
    return { method: 'instructions-file', filePath: 'AGENTS.md', body };
  }
  if (key === 'aider') {
    // aider loads read-only context via --read <file>. Write a Husk-owned file
    // and point aider at it (relative to the agent's cwd).
    const filePath = '.husk-aider.md';
    return { method: 'read-file', filePath, body, args: ['--read', filePath] };
  }
  return { method: 'none' };
}

module.exports = {
  HUSK_SESSION_START,
  HUSK_SESSION_END,
  buildGenericDirectives,
  renderSessionBlock,
  mergeSessionBlock,
  planInjection,
};
