'use strict';

// Parser for the human-readable output of `claude mcp list`.
//
// Sample input (Claude Code 2.1.x):
//   Checking MCP server health…
//
//   claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ! Needs authentication
//   memory: npx -y @modelcontextprotocol/server-memory - ✓ Connected
//   opensearch: uvx opensearch-mcp-server-py - ✗ Failed to connect
//   slack-logs: node /path/to/index.js - ✓ Connected
//
// Each line is `<id>: <command-or-url> - <glyph> <Status text>`, where
// <id> may contain spaces. We split on the first colon to extract the
// id and read the lowercased tail for known status words.

const ANSI_STRIP_RE = /\x1B\[[\d;?]*[A-Za-z]|\x1B\][^\x07]*\x07/g;

function stripAnsi(text) {
  return String(text || '').replace(ANSI_STRIP_RE, '');
}

// parseMcpListOutput(stdout) returns a map { id: 'connected' | 'failed'
// | 'auth' | 'disabled' }. Lines that do not match the expected shape
// are silently skipped.
function parseMcpListOutput(stdout) {
  const status = {};
  const clean = stripAnsi(stdout);
  for (const raw of clean.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('Checking') || line.startsWith('Error')) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx < 1) continue;
    const id = line.slice(0, colonIdx).trim();
    if (!id) continue;
    const tail = line.slice(colonIdx + 1).toLowerCase();
    // Order matters: "Failed to connect" contains the substring "connect".
    if (tail.includes('failed to connect') || tail.includes('failed')) status[id] = 'failed';
    else if (tail.includes('needs authentication') || tail.includes('needs auth')) status[id] = 'auth';
    else if (tail.includes('connected')) status[id] = 'connected';
    else if (tail.includes('disabled')) status[id] = 'disabled';
  }
  return status;
}

module.exports = { parseMcpListOutput, stripAnsi };
