'use strict';

// parseAgentMd parses one Claude Code style agent markdown file: optional
// YAML frontmatter delimited by --- lines, followed by the body. Only the
// `name` and `description` fields matter for the profile mapping, so we
// keep the parser tight and dependency-free.
function parseAgentMd(text) {
  const t = String(text || '');
  const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { name: null, description: null, body: t.trim() };
  const fm = m[1];
  const body = m[2].trim();
  const getField = (k) => {
    // k is one of the literal field names supplied by this module
    // ('name', 'description'); never user input.
    // eslint-disable-next-line security/detect-non-literal-regexp
    const re = new RegExp(`^${k}\\s*:\\s*(.*)$`, 'm');
    const mm = fm.match(re);
    if (!mm) return null;
    let v = mm[1].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    return v;
  };
  return { name: getField('name'), description: getField('description'), body };
}

module.exports = { parseAgentMd };
