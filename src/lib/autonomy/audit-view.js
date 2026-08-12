'use strict';

// Read-only projection of hash-chained audit rows into the four columns a
// reviewer reads: what happened, which key it touched, the detail, and when.
//
// The audit log stores whole payloads. A table row needs one short key and one
// short sentence, so every kind gets a projection here and anything unknown
// falls back to a generic shape rather than dumping raw JSON into a cell.

const MAX_KEY = 120;
const MAX_DETAILS = 600;

function clip(value, max) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function firstString(obj, keys) {
  if (!obj || typeof obj !== 'object') return '';
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function compactNumber(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  if (Math.abs(v) >= 1000000) return `${Math.round(v / 100000) / 10}M`;
  if (Math.abs(v) >= 1000) return `${Math.round(v / 100) / 10}k`;
  return String(v);
}

// A payload with no dedicated projection reads as its own scalar fields, so an
// unknown kind still shows something a human can act on.
function genericDetails(payload) {
  if (payload == null) return '';
  if (typeof payload !== 'object') return clip(payload, MAX_DETAILS);
  const bits = [];
  for (const [k, v] of Object.entries(payload)) {
    if (v == null) continue;
    if (typeof v === 'string') bits.push(`${k} ${clip(v, 120)}`);
    else if (typeof v === 'number' || typeof v === 'boolean') bits.push(`${k} ${v}`);
    else if (Array.isArray(v)) bits.push(`${k} ${v.length}`);
    if (bits.join(' · ').length > MAX_DETAILS) break;
  }
  return clip(bits.join(' · '), MAX_DETAILS);
}

function projectPayload(kind, payload) {
  const p = (payload && typeof payload === 'object') ? payload : null;
  switch (kind) {
    case 'start_run':
      return { key: 'goal', details: clip(p && p.goal, MAX_DETAILS) };
    case 'run_identity':
      return {
        key: firstString(p, ['role', 'agent']) || 'identity',
        details: clip(firstString(p, ['worktreePath', 'workspaceRoot']), MAX_DETAILS),
      };
    case 'run_status': {
      const key = firstString(p, ['status']) || 'status';
      const parts = [];
      const step = firstString(p, ['summary', 'currentStep']);
      if (step) parts.push(step);
      if (p && Array.isArray(p.blockers) && p.blockers.length) {
        parts.push(`blocked on ${p.blockers.join('; ')}`);
      }
      return { key, details: clip(parts.join(' · '), MAX_DETAILS) };
    }
    case 'agent_output': {
      const chars = Number(p && p.chars);
      return {
        key: 'output',
        details: Number.isFinite(chars) ? `${compactNumber(chars)} characters streamed` : '',
      };
    }
    case 'run_summary': {
      const files = p && Array.isArray(p.diff) ? p.diff.length : 0;
      const meter = (p && p.meter) || {};
      const bits = [`${files} ${files === 1 ? 'file' : 'files'} changed`];
      if (Number.isFinite(Number(meter.totalTokens))) bits.push(`${compactNumber(meter.totalTokens)} tokens`);
      if (Number.isFinite(Number(meter.dollars))) bits.push(`$${(Number(meter.dollars)).toFixed(2)}`);
      if (Number.isFinite(Number(p && p.durationMs))) bits.push(`${Math.round(Number(p.durationMs) / 1000)}s`);
      return {
        key: firstString(p, ['status']) || 'summary',
        details: clip(bits.join(' · '), MAX_DETAILS),
      };
    }
    case 'end_run':
      return { key: firstString(p, ['reason']) || 'end', details: genericDetails(p) };
    default:
      break;
  }
  if (/^halt_/.test(String(kind || ''))) {
    return {
      key: firstString(p, ['cap', 'reason']) || String(kind).slice(5),
      details: genericDetails(p),
    };
  }
  return {
    key: firstString(p, ['path', 'name', 'id', 'status', 'reason', 'cap', 'tool']),
    details: genericDetails(p),
  };
}

// projectAuditRow turns one stored row into the shape a table paints.
function projectAuditRow(row) {
  const r = (row && typeof row === 'object') ? row : {};
  const kind = typeof r.kind === 'string' && r.kind ? r.kind : 'unknown';
  const view = projectPayload(kind, r.payload);
  return {
    seq: Number.isFinite(r.seq) ? r.seq : null,
    ts: typeof r.ts === 'string' ? r.ts : null,
    kind,
    key: clip(view.key || (typeof r.agent === 'string' ? r.agent : ''), MAX_KEY),
    details: clip(view.details, MAX_DETAILS),
    agent: typeof r.agent === 'string' ? r.agent : null,
    turn: Number.isFinite(r.turn) ? r.turn : null,
    spilled: typeof r.blob_ref === 'string' && r.payload === undefined,
  };
}

// auditKindCounts tallies every kind in the log, busiest first, so the filter
// chips carry their own counts.
function auditKindCounts(records) {
  const counts = new Map();
  for (const row of Array.isArray(records) ? records : []) {
    const kind = (row && typeof row.kind === 'string' && row.kind) ? row.kind : 'unknown';
    counts.set(kind, (counts.get(kind) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => (b.count - a.count) || a.kind.localeCompare(b.kind));
}

module.exports = { projectAuditRow, auditKindCounts, _internal: { clip, genericDetails, compactNumber } };
