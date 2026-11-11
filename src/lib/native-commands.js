'use strict';

// Slash commands a CLI only answers in its own terminal UI. Run headlessly the
// CLI replies with a pointer back to that UI ("use /mcp in the terminal"), so
// Husk runs the CLI's own non-interactive form of the command instead and shows
// what it printed. Nothing here reimplements a command: each entry is the argv
// the same CLI documents for the same answer.
//
// Verified against each CLI's --help on 2026-11-10:
//   claude   mcp list     copilot   mcp list
//   codex    mcp list     kiro-cli  mcp list

const { agentBaseName } = require('./agent-oneshot');

const NATIVE = {
  claude: { mcp: ['mcp', 'list'] },
  codex: { mcp: ['mcp', 'list'] },
  copilot: { mcp: ['mcp', 'list'] },
  'kiro-cli': { mcp: ['mcp', 'list'] },
};

// The command to run for a bare slash command typed in a chat, or null when
// the CLI should take the text itself. Arguments after the name mean the user
// is asking for something more specific than the listing, so those pass through.
function nativeCommand(agentCommand, text) {
  const m = /^\/([a-z][a-z-]*)\s*$/.exec(String(text || '').trim());
  if (!m) return null;
  const program = String(agentCommand || 'claude').trim().split(/\s+/)[0];
  const base = agentBaseName(program);
  // A claude-* alias is claude under another name, and is run under that name.
  const table = NATIVE[(base === 'claude' || /^claude[-_]/.test(base)) ? 'claude' : base];
  const args = table && Object.prototype.hasOwnProperty.call(table, m[1]) ? table[m[1]] : null;
  return args ? { program, args: args.slice(), label: `${base} ${args.join(' ')}` } : null;
}

// What the thread shows: the command that ran, then its output as it printed.
function nativeReply(label, output) {
  const body = String(output || '').replace(/\r\n/g, '\n').trim() || '(no output)';
  return '`' + label + '`\n\n```\n' + body.replace(/```/g, "'''") + '\n```';
}

module.exports = { nativeCommand, nativeReply };
