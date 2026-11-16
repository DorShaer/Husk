'use strict';

const path = require('path');

// Binary document formats officeparser can read. Text formats (md, txt, code,
// csv, json) are read as UTF-8 by the caller and never reach here.
const OFFICE_EXTS = new Set(['.pdf', '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp']);

function isOfficeDoc(file) {
  return OFFICE_EXTS.has(path.extname(String(file || '')).toLowerCase());
}

// Plain text pulled from an office or PDF file, trimmed. Throws when the file
// cannot be parsed. officeparser reads the path itself, so no buffer is passed.
async function extractDocText(file) {
  const { parseOffice } = require('officeparser');
  const parsed = await parseOffice(String(file));
  // officeparser v8 returns a structured result; `.to('text')` renders it to a
  // plain-text string under `.value`.
  const rendered = await parsed.to('text');
  return String((rendered && rendered.value) || '').trim();
}

module.exports = { isOfficeDoc, extractDocText, OFFICE_EXTS };
