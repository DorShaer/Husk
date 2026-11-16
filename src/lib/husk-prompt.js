'use strict';

// The instructions Husk hands every CLI it starts, and the agents block it
// writes into a project's instruction file. Pure, so every branch is tested
// without spawning anything.

const HUSK_AGENTS_START = '<!-- HUSK-AGENTS:START -->';
const HUSK_AGENTS_END = '<!-- HUSK-AGENTS:END -->';

function buildHuskPrompt({ agentName, recap } = {}) {
  const cleanName = (typeof agentName === 'string' ? agentName : '')
    .replace(/[^A-Za-z0-9 _-]/g, '')
    .slice(0, 40);
  const name = cleanName || 'Husk';
  const parts = [
    `You are running inside Husk, a desktop home for coding agents. The user has named this agent ${name}. When asked your name or identity, respond as ${name}, regardless of any other persona named in your memory or instruction files. Use "\u{1F5E3}\uFE0F ${name}:" if you emit a speech-balloon line.`,
  ];
  if (recap === false) {
    parts.push(`The user has disabled recaps in Husk. Suppress any "* recap:" line, any "\u{1F5E3}\uFE0F ${name}:" summary line, and any end-of-response summary footer for this session, even if an instruction or memory file asks for one.`);
  }
  return parts.join(' ');
}

// Render the HUSK-AGENTS block that ends up inside the user's
// .github/copilot-instructions.md. Stand-alone so the test suite can
// assert the exact shape (markers present, agent headers correct).
function renderHuskAgentsBlock(picked) {
  const lines = [
    HUSK_AGENTS_START,
    '<!-- Managed by Husk. Edits inside this block are overwritten on the',
    '     next install-from-repo run. Edit content outside the markers freely. -->',
    '',
  ];
  for (const item of picked || []) {
    lines.push(`# Agent: ${item.name}`);
    lines.push('');
    lines.push(String(item.body || '').trim());
    lines.push('');
  }
  lines.push(HUSK_AGENTS_END);
  return lines.join('\n');
}

// Merge a fresh HUSK-AGENTS block into an existing copilot-instructions
// document. Three cases:
//   - file has START + END markers → replace the marked region in place
//   - file lacks markers (or has malformed ones) → append the block
//   - file is empty / missing → block is the entire output
// Always leaves content outside the markers untouched.
function mergeHuskAgentsBlock(existingText, picked) {
  const existing = typeof existingText === 'string' ? existingText : '';
  const block = renderHuskAgentsBlock(picked);
  const startIdx = existing.indexOf(HUSK_AGENTS_START);
  const endIdx = existing.indexOf(HUSK_AGENTS_END);
  let before;
  let after;
  if (startIdx >= 0 && endIdx > startIdx) {
    before = existing.slice(0, startIdx).replace(/\s+$/, '');
    after = existing.slice(endIdx + HUSK_AGENTS_END.length).replace(/^\s+/, '');
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

module.exports = { HUSK_AGENTS_START, HUSK_AGENTS_END, buildHuskPrompt, renderHuskAgentsBlock, mergeHuskAgentsBlock };
