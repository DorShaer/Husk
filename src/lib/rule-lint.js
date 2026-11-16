'use strict';

// Mechanical Brain rules: the ones a string test can enforce, so they never
// ride the prompt and never depend on the model remembering. A rule is
// mechanical when it names a known pattern; the output is transformed on the
// way to the screen instead of being injected as an instruction every turn.

const str = (v) => (v === null || v === undefined ? '' : String(v));

// Each builtin: how to count violations, and how to repair them deterministically.
const BUILTINS = {
  'no-em-dash': {
    label: 'no em dashes',
    re: /—/g,
    fix: (s) => s.replace(/—/g, '-'),
  },
};

// A rule's text, or an explicit tag, names a builtin. Explicit wins.
function detect(text) {
  const t = str(text).toLowerCase();
  if (t.includes('em dash') || t.includes('em-dash') || t.includes('—')) return 'no-em-dash';
  return null;
}

// The builtin a rule node resolves to, or null when it is a judgment rule.
function resolve(rule) {
  if (!rule) return null;
  const id = (rule.check && rule.check.builtin) || detect(rule.text);
  return id && BUILTINS[id] ? { id, ...BUILTINS[id] } : null;
}

const isMechanical = (rule) => resolve(rule) !== null;

// Repair the text against every mechanical rule in the list. Pure.
function applyMechanical(text, rules) {
  let out = str(text);
  for (const r of rules || []) {
    const m = resolve(r);
    if (m) out = m.fix(out);
  }
  return out;
}

// Count what each mechanical rule would catch in the text, without changing it.
function lint(text, rules) {
  const s = str(text);
  const out = [];
  for (const r of rules || []) {
    const m = resolve(r);
    if (!m) continue;
    const count = (s.match(m.re) || []).length;
    if (count) out.push({ id: m.id, label: m.label, count });
  }
  return out;
}

module.exports = { BUILTINS, detect, resolve, isMechanical, applyMechanical, lint };
