'use strict';

// Render a Husk agent profile as a markdown agent file (YAML frontmatter +
// body), and derive a safe filename for it. Both claude (~/.claude/agents) and
// copilot (~/.copilot/agents) load this same format natively, so writing the
// file into each installed CLI's agents directory makes a Husk agent usable in
// whichever CLI the user runs.

// Slugify the agent name into a filename. The name comes from elsewhere, so the
// slug keeps only lowercase letters, digits and dashes, which keeps the write
// inside the agents directory it is joined to.
function agentFileName(name) {
  const slug = String(name || 'agent')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'agent';
  return `${slug}.md`;
}

// Frontmatter key stamped on files this renders. It is what lets the sync tell
// a file it owns from one the user wrote or another tool installed, so a rewrite
// can never land on somebody else's work.
const MANAGED_KEY = 'husk';
const MANAGED_VALUE = 'managed';

function renderAgentMd({ name, description, systemPrompt } = {}) {
  const oneLine = (s) => String(s == null ? '' : s).replace(/\r?\n/g, ' ').trim();
  const lines = ['---', `name: ${oneLine(name) || 'agent'}`];
  if (oneLine(description)) lines.push(`description: ${oneLine(description)}`);
  lines.push(`${MANAGED_KEY}: ${MANAGED_VALUE}`);
  lines.push('---', '');
  return `${lines.join('\n')}\n${String(systemPrompt || '').trim()}\n`;
}

// True when this file was rendered by Husk. Only the leading frontmatter block
// counts, so the word appearing in a prompt body means nothing.
function isHuskManaged(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
  if (!m) return false;
  return new RegExp(`^${MANAGED_KEY}:\\s*${MANAGED_VALUE}\\s*$`, 'm').test(m[1]);
}

// Body of an agent file, frontmatter removed. Used to compare what is on disk
// against what would replace it.
function agentMdBody(text) {
  const s = String(text || '');
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(s);
  return (m ? s.slice(m[0].length) : s).trim();
}

module.exports = { agentFileName, renderAgentMd, isHuskManaged, agentMdBody };
