'use strict';

// Render a Husk agent profile as a markdown agent file (YAML frontmatter +
// body), and derive a safe filename for it. Both claude (~/.claude/agents) and
// copilot (~/.copilot/agents) load this same format natively, so writing the
// file into each installed CLI's agents directory makes a Husk agent usable in
// whichever CLI the user runs.

// Slugify the agent name into a safe, traversal-free filename.
function agentFileName(name) {
  const slug = String(name || 'agent')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'agent';
  return `${slug}.md`;
}

function renderAgentMd({ name, description, systemPrompt } = {}) {
  const oneLine = (s) => String(s == null ? '' : s).replace(/\r?\n/g, ' ').trim();
  const lines = ['---', `name: ${oneLine(name) || 'agent'}`];
  if (oneLine(description)) lines.push(`description: ${oneLine(description)}`);
  lines.push('---', '');
  return `${lines.join('\n')}\n${String(systemPrompt || '').trim()}\n`;
}

module.exports = { agentFileName, renderAgentMd };
