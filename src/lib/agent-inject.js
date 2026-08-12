'use strict';

// Per-agent instruction injection.
//
// Husk's session directives (the agent's name and, when recaps are enabled,
// the speech-balloon line the desktop app reads aloud) reach each agent
// through that agent's own native instruction channel. AGENT_CHANNELS is the
// registry of those mechanisms; a new CLI is one entry there.
//
//   system-prompt-arg  -> a CLI flag, no files touched (claude)
//   instructions-file  -> a marker-managed block in a project file the CLI
//                         auto-reads (copilot, codex, gemini)
//   read-file          -> a Husk-owned file passed via a CLI flag (aider)
//   none               -> the agent gets no Husk directives
//
// Agent CLIs read each other's instruction files, so every plan carries a
// `refresh` set: the managed instruction files whose HUSK-SESSION blocks are
// rewritten with the current directives on every launch.
//
// planInjection is PURE: it returns a plan. The caller applies it.

const { agentKey } = require('./mcp/common');
const { buildHuskPrompt } = require('./pai-state');

const HUSK_SESSION_START = '<!-- HUSK-SESSION:START -->';
const HUSK_SESSION_END = '<!-- HUSK-SESSION:END -->';

// The per-agent delivery channel registry. planInjection and the cross-file
// refresh list are both derived from it, so one entry adds a new agent CLI.
const AGENT_CHANNELS = {
  // claude takes --append-system-prompt; no files touched.
  claude: { method: 'system-prompt-arg' },
  // copilot auto-reads .github/copilot-instructions.md in the project.
  copilot: { method: 'instructions-file', filePath: '.github/copilot-instructions.md' },
  // codex auto-reads AGENTS.md from the project root.
  codex: { method: 'instructions-file', filePath: 'AGENTS.md' },
  // gemini auto-reads GEMINI.md, the direct analog of codex's AGENTS.md.
  gemini: { method: 'instructions-file', filePath: 'GEMINI.md' },
  // aider loads read-only context via --read <file>; Husk owns that file.
  aider: { method: 'read-file', filePath: '.husk-aider.md', args: (fp) => ['--read', fp] },
};

// Every auto-read instruction file Husk manages a block in. All of them are
// refreshed on every launch, existing files only.
function instructionFilePaths() {
  return Object.values(AGENT_CHANNELS)
    .filter((c) => c.method === 'instructions-file')
    .map((c) => c.filePath);
}

function cleanName(agentName) {
  return (typeof agentName === 'string' ? agentName : '')
    .replace(/[^A-Za-z0-9 _-]/g, '')
    .slice(0, 40) || 'Husk';
}

// Vendor-neutral session directives for any agent that is not claude. Covers
// identity naming and, when the recap preference is on, the speech-balloon
// line Husk's voice reads. Recap off simply omits that directive.
function buildGenericDirectives({ agentName, recap } = {}) {
  const name = cleanName(agentName);
  const lines = [
    `Your name in this session is ${name}. When asked your name or identity, answer as ${name}.`,
    'When the user asks you to read an attached context file, look for that file by name in the session context directory at ~/.claude/MEMORY/CONTEXT/.',
  ];
  if (recap !== false) {
    lines.push(
      `End substantive replies with one line of the form "\u{1F5E3}\u{FE0F} ${name}: <8 to 16 word summary>" so the Husk desktop app can read your reply aloud.`,
    );
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

// Remove every Husk-marked region from a text. Well-formed START..END pairs
// are dropped whole. An unpaired START or END loses only the marker text.
function stripSessionBlocks(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const s = text.indexOf(HUSK_SESSION_START, i);
    if (s < 0) { out.push(text.slice(i)); break; }
    out.push(text.slice(i, s));
    const afterStart = s + HUSK_SESSION_START.length;
    const e = text.indexOf(HUSK_SESSION_END, afterStart);
    const nextS = text.indexOf(HUSK_SESSION_START, afterStart);
    if (e >= 0 && (nextS < 0 || e < nextS)) {
      i = e + HUSK_SESSION_END.length;
    } else {
      i = afterStart;
    }
  }
  return out.join('').split(HUSK_SESSION_END).join('');
}

// Merge the session block into an existing instructions document: replace the
// marked region in place when present, else append. Content outside the
// markers is preserved, and exactly one fresh block comes out.
function mergeSessionBlock(existingText, body) {
  const existing = typeof existingText === 'string' ? existingText : '';
  const block = renderSessionBlock(body);
  const startIdx = existing.indexOf(HUSK_SESSION_START);
  let before;
  let after;
  if (startIdx >= 0) {
    before = existing.slice(0, startIdx);
    after = stripSessionBlocks(existing.slice(startIdx)).replace(/^\s+/, '');
  } else {
    before = existing;
    after = '';
  }
  // An END marker ahead of the first START pairs with nothing; drop it.
  before = before.split(HUSK_SESSION_END).join('').replace(/\s+$/, '');
  const parts = [];
  if (before) parts.push(before);
  parts.push(block);
  if (after) parts.push(after);
  return parts.join('\n\n') + '\n';
}

// Plan how to deliver the directives to a given agent. Every plan carries
// `refresh` (see file header): the managed instruction files whose
// HUSK-SESSION blocks the caller rewrites with the current directives.
//   { method: 'system-prompt-arg', args, refresh }                  (claude)
//   { method: 'instructions-file', filePath, body, refresh }        (copilot, codex, gemini)
//   { method: 'read-file', filePath, body, args, refresh }          (aider)
//   { method: 'none', refresh }                                     (everything else)
function planInjection({ agentCommand, agentName, paiEnabled, recap } = {}) {
  const key = agentKey(agentCommand);
  const channel = AGENT_CHANNELS[key];
  const body = buildGenericDirectives({ agentName, recap });
  const refresh = { filePaths: instructionFilePaths(), body };
  if (!channel) return { method: 'none', refresh };
  if (channel.method === 'system-prompt-arg') {
    const prompt = buildHuskPrompt({ agentName, paiEnabled: paiEnabled !== false, recap });
    // Silence the agent's own inline statusline inside Husk; Husk's right-side
    // STATUS panel is the visual statusline. Delivered as an inline --settings
    // JSON string, which claude merges over the user's settings.json so every
    // other user setting still applies. statusLine cannot be null per the
    // schema, so a no-op command that prints nothing blanks it.
    const settingsOverride = JSON.stringify({ statusLine: { type: 'command', command: '/bin/true' } });
    return { method: 'system-prompt-arg', args: ['--settings', settingsOverride, '--append-system-prompt', prompt], refresh };
  }
  if (channel.method === 'read-file') {
    return { method: 'read-file', filePath: channel.filePath, body, args: channel.args(channel.filePath), refresh };
  }
  return { method: 'instructions-file', filePath: channel.filePath, body, refresh };
}

module.exports = {
  HUSK_SESSION_START,
  HUSK_SESSION_END,
  buildGenericDirectives,
  instructionFilePaths,
  renderSessionBlock,
  mergeSessionBlock,
  planInjection,
};
