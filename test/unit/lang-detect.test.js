'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { detectLanguage } = require('../../src/lib/lang-detect');

test('detectLanguage: extension mapping covers the canonical set', () => {
  const cases = {
    'app.js': 'javascript',
    'app.mjs': 'javascript',
    'app.cjs': 'javascript',
    'view.jsx': 'javascript',
    'main.ts': 'typescript',
    'view.tsx': 'typescript',
    'data.json': 'json',
    'style.css': 'css',
    'page.html': 'html',
    'page.htm': 'html',
    'README.md': 'markdown',
    'script.py': 'python',
    'run.sh': 'shell',
    'run.bash': 'shell',
    'run.zsh': 'shell',
    'server.go': 'go',
    'config.yml': 'yaml',
    'config.yaml': 'yaml',
    'Cargo.toml': 'toml',
    'query.sql': 'sql',
    'lib.rs': 'rust',
    'main.c': 'c',
    'header.h': 'c',
    'main.cpp': 'cpp',
    'main.cc': 'cpp',
    'header.hpp': 'cpp',
    'Main.java': 'java',
    'app.rb': 'ruby',
  };
  for (const [name, expected] of Object.entries(cases)) {
    assert.equal(detectLanguage(name, ''), expected, `${name} -> ${expected}`);
  }
});

test('detectLanguage: extension match is case-insensitive', () => {
  assert.equal(detectLanguage('APP.JS', ''), 'javascript');
  assert.equal(detectLanguage('Data.JSON', ''), 'json');
});

test('detectLanguage: full paths resolve by basename extension', () => {
  assert.equal(detectLanguage('/opt/projects/husk/src/main.js', ''), 'javascript');
});

test('detectLanguage: shebang inference when no extension match', () => {
  assert.equal(detectLanguage('runme', '#!/bin/bash'), 'shell');
  assert.equal(detectLanguage('runme', '#!/bin/sh'), 'shell');
  assert.equal(detectLanguage('runme', '#!/usr/bin/env zsh'), 'shell');
  assert.equal(detectLanguage('runme', '#!/usr/bin/env python3'), 'python');
  assert.equal(detectLanguage('runme', '#!/usr/bin/python'), 'python');
  assert.equal(detectLanguage('runme', '#!/usr/bin/env node'), 'javascript');
  assert.equal(detectLanguage('runme', '#!/usr/bin/env ruby'), 'ruby');
});

test('detectLanguage: shebang inference strips glued interpreter versions', () => {
  assert.equal(detectLanguage('runme', '#!/usr/bin/python3.11'), 'python');
});

test('detectLanguage: unknown or incomplete shebang falls back to text', () => {
  assert.equal(detectLanguage('runme', '#!/usr/bin/env perl'), 'text');
  assert.equal(detectLanguage('runme', '#!/usr/bin/env'), 'text');
});

test('detectLanguage: extension wins over shebang', () => {
  assert.equal(detectLanguage('script.py', '#!/bin/bash'), 'python');
});

test('detectLanguage: default is text', () => {
  assert.equal(detectLanguage('unknown.xyz', ''), 'text');
  assert.equal(detectLanguage('noextension', ''), 'text');
  assert.equal(detectLanguage('.bashrc', '# not a shebang'), 'text');
  assert.equal(detectLanguage('plain', 'just a normal first line'), 'text');
  assert.equal(detectLanguage('plain', null), 'text');
  assert.equal(detectLanguage('', ''), 'text');
});

test('detectLanguage: non-string filename still allows shebang inference', () => {
  assert.equal(detectLanguage(null, '#!/usr/bin/env node'), 'javascript');
});
