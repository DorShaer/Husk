'use strict';

const fs = require('fs');
const path = require('path');

const STATUS_FILE = '.husk-autopilot-status.json';
const VALID_STATUSES = new Set(['running', 'blocked', 'complete', 'failed']);

function cleanText(value, max = 500) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function cleanStringArray(value, maxItems = 20, maxChars = 200) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => cleanText(item, maxChars))
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeVerification(value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    passed: typeof v.passed === 'boolean' ? v.passed : null,
    commands: cleanStringArray(v.commands, 12, 240),
    notes: cleanText(v.notes, 500),
  };
}

function normalizeStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'status must be an object' };
  }
  const status = cleanText(value.status, 40).toLowerCase();
  if (!VALID_STATUSES.has(status)) {
    return { ok: false, error: 'status must be running, blocked, complete, or failed' };
  }
  const progressRaw = Number(value.progress);
  const progress = Number.isFinite(progressRaw)
    ? Math.max(0, Math.min(100, Math.round(progressRaw)))
    : null;
  return {
    ok: true,
    state: {
      status,
      progress,
      currentStep: cleanText(value.currentStep, 300),
      summary: cleanText(value.summary, 800),
      blockers: cleanStringArray(value.blockers, 12, 300),
      files: cleanStringArray(value.files, 50, 240),
      verification: normalizeVerification(value.verification),
      updatedAt: cleanText(value.updatedAt, 80),
    },
  };
}

function statusPath(workspaceRoot) {
  return path.join(workspaceRoot, STATUS_FILE);
}

function readStatus(workspaceRoot) {
  const file = statusPath(workspaceRoot);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: false, missing: true, error: 'missing' };
    return { ok: false, error: (err && err.message) || String(err) };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return { ok: false, error: 'status file is not valid JSON' };
  }
  const normalized = normalizeStatus(parsed);
  if (!normalized.ok) return normalized;
  normalized.path = file;
  normalized.signature = JSON.stringify(normalized.state);
  return normalized;
}

module.exports = {
  STATUS_FILE,
  normalizeStatus,
  readStatus,
  statusPath,
};
