'use strict';

// Pure / fs-only helpers that drive the PAI toggle and the
// install-from-repo flow. Extracted out of main.js so they can be unit-
// tested without spinning up Electron. main.js delegates here.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PARKED_BASENAME = 'CLAUDE.md.husk-disabled';
const HUSK_AGENTS_START = '<!-- HUSK-AGENTS:START -->';
const HUSK_AGENTS_END = '<!-- HUSK-AGENTS:END -->';

// Where the parked CLAUDE.md lives under a given ~/.claude/ root.
// Useful for the test suite and for any future code that needs to know
// the rename target without hard-coding the basename.
function parkedPath(claudeDir) {
  return path.join(claudeDir, PARKED_BASENAME);
}

function digestOf(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// Whether a CLAUDE.md is one Husk put there and the user has left alone.
// A file is ours only while it still matches, byte for byte, a template we
// ship. The moment someone edits it, it is their file and their words, and
// nothing here may move it again.
//
// Matching on content rather than on a recorded flag is what makes this work
// for installs that predate the check: there is no state to migrate, an old
// untouched copy still matches its template.
function isHuskAuthoredClaudeMd(claudeDir, templateDigests) {
  const digests = Array.isArray(templateDigests) ? templateDigests.filter(Boolean) : [];
  if (!digests.length) return false;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path scoped to claudeDir/CLAUDE.md
    const body = fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf8');
    return digests.includes(digestOf(body));
  } catch (_) {
    return false;
  }
}

// Rename ~/.claude/CLAUDE.md to/from the parked sibling based on whether
// the framework is supposed to be active. Renames only; never deletes. All
// four presence combinations are handled deliberately:
//
//   active=false, live present, parked absent  → rename live → parked
//   active=false, live present, parked present → leave both alone
//   active=false, live absent                  → no-op
//   active=true,  parked present, live absent  → rename parked → live
//   active=true,  parked present, live present → leave both alone
//   active=true,  parked absent                → no-op
//
// The "leave both alone" cases protect a user-edited file from being
// silently overwritten. The caller can surface a toast if needed.
//
// Parking is gated on the file being ours. ~/.claude/CLAUDE.md belongs to
// the user: plenty of people wrote one long before they ever installed Husk,
// and a toggle in our Preferences must not move it. Without the gate, turning
// the framework off renamed whatever was there, so someone's hand-written
// config silently disappeared from the path the CLI reads. Pass the digests
// of the templates we ship via opts.templateDigests; anything that does not
// match one of them is left exactly where it is.
//
// Restoring is unconditional: the parked file only exists because we put it
// there, so moving it back is always returning our own file.
function applyPaiState(claudeDir, active, opts = {}) {
  if (typeof claudeDir !== 'string' || !claudeDir) {
    throw new TypeError('applyPaiState: claudeDir must be a non-empty string');
  }
  // live and parked are derived from the caller-supplied claudeDir using
  // path.join + a hard-coded basename, so the targets are bounded to two
  // specific filenames inside the given directory. The eslint-disable
  // lines below acknowledge the dynamic-path warning the security plugin
  // raises: this function intentionally operates on user-supplied paths
  // (the user's ~/.claude/ directory) and the inputs are validated above.
  const live = path.join(claudeDir, 'CLAUDE.md');
  const parked = parkedPath(claudeDir);
  try {
    if (!active) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path scoped to claudeDir/CLAUDE.md, validated input
      if (fs.existsSync(live) && !fs.existsSync(parked)
          && isHuskAuthoredClaudeMd(claudeDir, opts.templateDigests)) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- rename target is the parked sibling, fixed basename
        fs.renameSync(live, parked);
      }
    } else {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path scoped to claudeDir/CLAUDE.md.husk-disabled
      if (fs.existsSync(parked) && !fs.existsSync(live)) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- rename target is the live sibling, fixed basename
        fs.renameSync(parked, live);
      }
    }
  } catch (_) {
    // Swallow: surfacing an exception here would crash startup;
    // the caller logs separately.
  }
}

// Build the --append-system-prompt that the Claude branch of spawnPty
// passes when launching the CLI. Pure function so the test suite can
// hit every branch without spawning anything.
function buildHuskPrompt({ agentName, paiEnabled, recap } = {}) {
  const cleanName = (typeof agentName === 'string' ? agentName : '')
    .replace(/[^A-Za-z0-9 _-]/g, '')
    .slice(0, 40);
  const name = cleanName || 'Husk';
  const parts = [];
  if (paiEnabled === false) {
    parts.push(
      `You are running inside Husk, a desktop wrapper. The user has named this agent ${name}. When asked your name or identity, respond as ${name}, regardless of any other persona named in your memory files or CLAUDE.md. Use "🗣️ ${name}:" if you emit a speech-balloon line. Husk has the assistant framework disabled: do NOT emit its banner ("════ LifeOS ═══", "═══ PAI ═══", "════ PAI | NATIVE MODE ═══", "════ PAI | ALGORITHM ═══", or any similar header), do NOT use Algorithm/ISA/ISC structure, and do NOT produce TASK / CHANGE / VERIFY / MEMORY / SUMMARY sections. Reply naturally, in plain prose, even if any CLAUDE.md or memory file you read tells you to use those formats. This Husk instruction overrides them.`,
    );
  } else {
    parts.push(
      `You are running inside Husk, a desktop wrapper. The user has named this agent ${name}. When asked your name or identity, respond as ${name}, regardless of any other persona named in your memory files or CLAUDE.md. Use "🗣️ ${name}:" if you emit a speech-balloon line. Otherwise follow your normal CLAUDE.md, assistant-framework, and memory-file instructions exactly. Including the full reasoning, banner format, CHANGE/VERIFY structure${recap === false ? '' : ', and recap behavior'}.`,
    );
  }
  if (recap === false) {
    parts.push(`The user has disabled recaps in Husk. Suppress any "* recap:" line, any "🗣️ ${name}:" summary line, and any end-of-response summary footer for this session, even if CLAUDE.md or a memory file asks for one.`);
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

module.exports = {
  PARKED_BASENAME,
  HUSK_AGENTS_START,
  HUSK_AGENTS_END,
  parkedPath,
  digestOf,
  isHuskAuthoredClaudeMd,
  applyPaiState,
  buildHuskPrompt,
  renderHuskAgentsBlock,
  mergeHuskAgentsBlock,
};
