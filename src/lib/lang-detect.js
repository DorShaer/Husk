'use strict';

// Language detection for syntax highlighting.
//
// detectLanguage(filename, firstLine) returns a stable language id string.
// Resolution order:
//   1. File extension (case-insensitive) via EXT_MAP.
//   2. Shebang inference on firstLine (#! interpreter) via SHEBANG_MAP.
//   3. Default 'text'.
//
// Language ids are the canonical set the highlighter understands:
//   javascript, typescript, json, css, html, markdown, python, shell,
//   go, yaml, toml, sql, rust, c, cpp, java, ruby, text.

const EXT_MAP = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  css: 'css',
  html: 'html',
  htm: 'html',
  md: 'markdown',
  py: 'python',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  go: 'go',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  rs: 'rust',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  java: 'java',
  rb: 'ruby',
};

// Interpreter basename (as it appears after #!) → language id.
const SHEBANG_MAP = {
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  dash: 'shell',
  ksh: 'shell',
  fish: 'shell',
  python: 'python',
  python2: 'python',
  python3: 'python',
  node: 'javascript',
  nodejs: 'javascript',
  bun: 'javascript',
  deno: 'typescript',
  ruby: 'ruby',
};

// Extract the lowercased extension from a filename, or '' if none.
function extOf(filename) {
  if (typeof filename !== 'string') return '';
  const base = filename.split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return ''; // no dot, or leading-dot dotfile like `.bashrc`
  return base.slice(dot + 1).toLowerCase();
}

// Infer a language from a shebang line like `#!/usr/bin/env python3`.
function fromShebang(firstLine) {
  if (typeof firstLine !== 'string') return null;
  if (!firstLine.startsWith('#!')) return null;
  // Collect alphabetic-ish tokens after the #!, resolve the interpreter.
  const rest = firstLine.slice(2).trim();
  const parts = rest.split(/\s+/).filter(Boolean);
  for (const part of parts) {
    // Skip the env resolver itself; look at the following token.
    const name = (part.split(/[\\/]/).pop() || '').toLowerCase();
    if (!name || name === 'env') continue;
    // Strip a trailing version tag glued on (e.g. python3.11 -> python3, then python).
    if (SHEBANG_MAP[name]) return SHEBANG_MAP[name];
    const stripped = name.replace(/[0-9.]+$/, '');
    if (SHEBANG_MAP[stripped]) return SHEBANG_MAP[stripped];
  }
  return null;
}

function detectLanguage(filename, firstLine) {
  const ext = extOf(filename);
  if (ext && EXT_MAP[ext]) return EXT_MAP[ext];
  const shebang = fromShebang(firstLine);
  if (shebang) return shebang;
  return 'text';
}

module.exports = {
  detectLanguage,
  EXT_MAP,
  SHEBANG_MAP,
};
