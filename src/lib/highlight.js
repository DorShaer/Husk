'use strict';

// XSS-safe syntax highlighter.
//
// SECURITY MODEL (non-negotiable):
//   The input source is first split into an ordered list of segments that
//   cover the ENTIRE input, each tagged with a token kind (or null for plain
//   text). Rendering then escapes every segment's text with escapeHtml and
//   only wraps already-escaped text in <span class="tok-KIND">...</span>.
//   We NEVER run a regex replace over a string that already contains span
//   markup, so there is no path by which raw input (e.g. '<script>') can
//   reach the output unescaped. Token wrapping only ADDS markup around
//   escaped text; it never re-emits raw characters.

// Escape the five HTML-significant characters. `&` must be replaced first so
// the escape sequences we introduce are not themselves re-escaped.
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Build a `\b(?:a|b|c)\b` word-boundary alternation from a keyword list.
function words(list) {
  return '\\b(?:' + list.join('|') + ')\\b';
}

// --- Shared token fragments (each fragment is a bare non-capturing body) ---
const C_LINE = '\\/\\/[^\\n]*';
const C_BLOCK = '\\/\\*[\\s\\S]*?\\*\\/';
const STR_DQ = '"(?:\\\\.|[^"\\\\])*"';
const STR_SQ = "'(?:\\\\.|[^'\\\\])*'";
const STR_TICK = '`(?:\\\\.|[^`\\\\])*`';
const NUMBER = '(?:0[xX][0-9a-fA-F]+|\\d+(?:\\.\\d+)?(?:[eE][+\\-]?\\d+)?)';
const FN_NAME = '[A-Za-z_$][\\w$]*(?=\\s*\\()';
const PROPERTY = '\\.[A-Za-z_$][\\w$]*';

const JS_KEYWORDS = [
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while',
  'do', 'switch', 'case', 'break', 'continue', 'new', 'class', 'extends',
  'super', 'this', 'typeof', 'instanceof', 'in', 'of', 'void', 'delete',
  'try', 'catch', 'finally', 'throw', 'async', 'await', 'yield', 'import',
  'export', 'from', 'as', 'default', 'null', 'undefined', 'true', 'false',
  'static', 'get', 'set',
];

const TS_KEYWORDS = JS_KEYWORDS.concat([
  'interface', 'type', 'enum', 'implements', 'public', 'private', 'protected',
  'readonly', 'namespace', 'declare', 'abstract', 'keyof', 'infer', 'is',
  'unknown', 'never', 'any', 'string', 'number', 'boolean', 'object',
]);

const PY_KEYWORDS = [
  'def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'import',
  'from', 'as', 'with', 'try', 'except', 'finally', 'raise', 'pass', 'break',
  'continue', 'in', 'is', 'not', 'and', 'or', 'lambda', 'yield', 'global',
  'nonlocal', 'del', 'assert', 'async', 'await', 'True', 'False', 'None',
  'self',
];

const SH_KEYWORDS = [
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done',
  'case', 'esac', 'in', 'function', 'return', 'exit', 'export', 'local',
  'source', 'echo', 'cd', 'read', 'set', 'unset', 'shift',
];

const GO_KEYWORDS = [
  'func', 'var', 'const', 'type', 'struct', 'interface', 'package', 'import',
  'return', 'if', 'else', 'for', 'range', 'switch', 'case', 'default',
  'break', 'continue', 'go', 'defer', 'chan', 'map', 'select', 'fallthrough',
  'goto', 'nil', 'true', 'false', 'iota', 'make', 'new', 'len', 'cap',
  'append', 'string', 'int', 'int64', 'int32', 'float64', 'float32', 'bool',
  'byte', 'rune', 'error',
];

// Each rule's `src` MUST use only non-capturing groups (?:...) internally, so
// the outer wrapper added at compile time is the rule's single capture group.
// Order matters: earlier rules win at the same position.
const LANGUAGES = {
  javascript: [
    { kind: 'comment', src: '(?:' + C_LINE + '|' + C_BLOCK + ')' },
    { kind: 'string', src: '(?:' + STR_TICK + '|' + STR_DQ + '|' + STR_SQ + ')' },
    { kind: 'property', src: PROPERTY },
    { kind: 'keyword', src: words(JS_KEYWORDS) },
    { kind: 'number', src: NUMBER },
    { kind: 'function', src: FN_NAME },
    { kind: 'punctuation', src: '[{}()\\[\\];,.]' },
    { kind: 'operator', src: '(?:[+\\-*/%=<>!&|^~?:]+)' },
  ],
  typescript: [
    { kind: 'comment', src: '(?:' + C_LINE + '|' + C_BLOCK + ')' },
    { kind: 'string', src: '(?:' + STR_TICK + '|' + STR_DQ + '|' + STR_SQ + ')' },
    { kind: 'property', src: PROPERTY },
    { kind: 'keyword', src: words(TS_KEYWORDS) },
    { kind: 'number', src: NUMBER },
    { kind: 'function', src: FN_NAME },
    { kind: 'punctuation', src: '[{}()\\[\\];,.]' },
    { kind: 'operator', src: '(?:[+\\-*/%=<>!&|^~?:]+)' },
  ],
  json: [
    { kind: 'property', src: '(?:' + STR_DQ + ')(?=\\s*:)' },
    { kind: 'string', src: '(?:' + STR_DQ + ')' },
    { kind: 'keyword', src: words(['true', 'false', 'null']) },
    { kind: 'number', src: '(?:-?' + NUMBER + ')' },
    { kind: 'punctuation', src: '[{}\\[\\]:,]' },
  ],
  css: [
    { kind: 'comment', src: C_BLOCK },
    { kind: 'string', src: '(?:' + STR_DQ + '|' + STR_SQ + ')' },
    { kind: 'keyword', src: '(?:@[A-Za-z-]+)' },
    { kind: 'property', src: '(?:[A-Za-z-]+(?=\\s*:))' },
    { kind: 'number', src: '(?:#[0-9a-fA-F]{3,8}|\\d+(?:\\.\\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg)?)' },
    { kind: 'punctuation', src: '[{}:;,()]' },
  ],
  html: [
    { kind: 'comment', src: '(?:<!--[\\s\\S]*?-->)' },
    { kind: 'tag', src: '(?:<\\/?[A-Za-z][\\w:-]*|\\/?>)' },
    { kind: 'string', src: '(?:' + STR_DQ + '|' + STR_SQ + ')' },
    { kind: 'attr', src: '(?:[A-Za-z_:][\\w:.-]*(?=\\s*=))' },
  ],
  markdown: [
    { kind: 'comment', src: '(?:<!--[\\s\\S]*?-->)' },
    { kind: 'keyword', src: '(?:^#{1,6}[^\\n]*)' },
    { kind: 'string', src: '(?:`[^`\\n]*`)' },
    { kind: 'keyword', src: '(?:\\*\\*[^*\\n]+\\*\\*)' },
    { kind: 'function', src: '(?:\\[[^\\]\\n]*\\]\\([^)\\n]*\\))' },
  ],
  python: [
    { kind: 'comment', src: '(?:#[^\\n]*)' },
    { kind: 'string', src: '(?:"""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'|' + STR_DQ + '|' + STR_SQ + ')' },
    { kind: 'keyword', src: words(PY_KEYWORDS) },
    { kind: 'number', src: NUMBER },
    { kind: 'function', src: '[A-Za-z_]\\w*(?=\\s*\\()' },
    { kind: 'punctuation', src: '[{}()\\[\\]:;,.]' },
    { kind: 'operator', src: '(?:[+\\-*/%=<>!&|^~]+)' },
  ],
  shell: [
    { kind: 'comment', src: '(?:#[^\\n]*)' },
    { kind: 'string', src: '(?:' + STR_DQ + '|' + STR_SQ + ')' },
    { kind: 'keyword', src: words(SH_KEYWORDS) },
    { kind: 'property', src: '(?:\\$\\{[^}]*\\}|\\$[A-Za-z_]\\w*|\\$[0-9@*#?])' },
    { kind: 'number', src: NUMBER },
    { kind: 'punctuation', src: '[{}()\\[\\];,]' },
    { kind: 'operator', src: '(?:[|&<>=]+)' },
  ],
  go: [
    { kind: 'comment', src: '(?:' + C_LINE + '|' + C_BLOCK + ')' },
    { kind: 'string', src: '(?:' + STR_TICK + '|' + STR_DQ + '|' + STR_SQ + ')' },
    { kind: 'property', src: '\\.[A-Za-z_]\\w*' },
    { kind: 'keyword', src: words(GO_KEYWORDS) },
    { kind: 'number', src: NUMBER },
    { kind: 'function', src: '[A-Za-z_]\\w*(?=\\s*\\()' },
    { kind: 'punctuation', src: '[{}()\\[\\];,.]' },
    { kind: 'operator', src: '(?:[+\\-*/%=<>!&|^~:]+)' },
  ],
};

// Split `code` into an ordered array of { text, kind } segments covering the
// whole input. `kind` is null for text matched by no rule.
function tokenize(code, rules) {
  const pattern = rules.map((r) => '(' + r.src + ')').join('|');
  // eslint-disable-next-line security/detect-non-literal-regexp -- pattern is built from the static LANGUAGES rule table, never user input
  const re = new RegExp(pattern, 'gm');
  const segments = [];
  let last = 0;
  let m;
  while ((m = re.exec(code)) !== null) {
    // Guard against a zero-length match stalling the loop.
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    if (m.index > last) {
      segments.push({ text: code.slice(last, m.index), kind: null });
    }
    // Each rule contributes exactly one capture group, so group i+1 maps to
    // rule i. The first defined group is the winning rule.
    let kind = null;
    for (let i = 0; i < rules.length; i++) {
      if (m[i + 1] !== undefined) { kind = rules[i].kind; break; }
    }
    segments.push({ text: m[0], kind });
    last = m.index + m[0].length;
  }
  if (last < code.length) {
    segments.push({ text: code.slice(last), kind: null });
  }
  return segments;
}

// Escape every segment, then wrap kinded segments in a span. This is the only
// place output is assembled, and it always escapes before wrapping.
function render(segments) {
  let out = '';
  for (const seg of segments) {
    const esc = escapeHtml(seg.text);
    out += seg.kind ? '<span class="tok-' + seg.kind + '">' + esc + '</span>' : esc;
  }
  return out;
}

function highlight(code, lang) {
  const src = code == null ? '' : String(code);
  const rules = LANGUAGES[lang];
  if (!rules) {
    // Unsupported language or 'text': fully escaped, no spans.
    return escapeHtml(src);
  }
  return render(tokenize(src, rules));
}

// Per-line highlight for a guttered viewer. Tokenizing the whole source keeps
// multi-line constructs (block comments, template strings) correctly colored,
// but a viewer that renders one DOM element per line needs each line's HTML to
// be self-contained. So a segment that straddles a newline is split at the
// newline and each piece is wrapped in its own span. The result is an array of
// balanced HTML strings, one per source line, each independently XSS-safe.
function highlightLines(code, lang) {
  const src = code == null ? '' : String(code);
  const rules = LANGUAGES[lang];
  const segments = rules ? tokenize(src, rules) : [{ text: src, kind: null }];
  const lines = [''];
  const push = (kind, text) => {
    const esc = escapeHtml(text);
    lines[lines.length - 1] += kind ? '<span class="tok-' + kind + '">' + esc + '</span>' : esc;
  };
  for (const seg of segments) {
    const parts = seg.text.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) lines.push('');
      if (parts[i]) push(seg.kind, parts[i]);
    }
  }
  return lines;
}

module.exports = {
  highlight,
  highlightLines,
  escapeHtml,
  LANGUAGES,
};
