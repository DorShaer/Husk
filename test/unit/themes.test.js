'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('../../src/lib/themes');
test('every registered theme has tokens and a native window colour', () => {
  const css = fs.readFileSync(path.join(__dirname, '../../src/renderer/styles.css'), 'utf8');
  assert.equal(new Set(T.THEME_IDS).size, T.THEMES.length);
  for (const theme of T.THEMES) {
    assert.ok(css.includes(`[data-theme="${theme.id}"]`));
    assert.equal(T.themeBackground(theme.id), theme.bg);
    assert.equal(T.isLightTheme(theme.id), !!theme.light);
  }
});
test('custom accents stay readable for extreme colours in every theme', () => {
  for (const theme of T.THEMES) for (const hex of ['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#818cf8']) {
    const vars = T.deriveAccent(hex, theme.id);
    const floor = theme.highContrast ? 7 : theme.light ? 4.5 : 3;
    assert.ok(T.contrast(T.hexToRgb(vars['--accent']), T.hexToRgb(theme.bg)) >= floor - 0.05, `${hex} on ${theme.id}`);
    assert.ok(T.contrast(T.hexToRgb(vars['--accent']), T.hexToRgb(vars['--on-accent'])) >= 4.5);
  }
});
