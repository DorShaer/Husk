'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isOfficeDoc } = require('../../src/lib/doc-extract');

test('isOfficeDoc matches binary document formats, case-insensitive', () => {
  for (const f of ['a.pdf', 'b.DOCX', 'dir/c.xlsx', 'd.pptx', 'e.odt', 'f.ods', 'g.odp']) {
    assert.equal(isOfficeDoc(f), true, f);
  }
});

test('isOfficeDoc leaves text formats to the UTF-8 path', () => {
  for (const f of ['notes.md', 'code.js', 'data.csv', 'conf.json', 'readme.txt', 'noext', '']) {
    assert.equal(isOfficeDoc(f), false, f);
  }
});
