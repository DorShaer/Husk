'use strict';

// Canonical JSON: key-sorted, space-free, recursive.
//
// Shared by the autonomy supervisor, which hashes an action signature with it
// to detect loops, and the portable workflow artifact, which fingerprints its
// graph with it. One implementation keeps both hashing the same bytes.
//
// The output is hash input, not display text. A new canonicalisation rule set
// takes a new fingerprint prefix rather than changing these bytes. See
// GRAPH_HASH_PREFIX in workflow-artifact.js.
//
// Returns a bare string rather than the { ok, error } pair the rest of
// src/lib uses. The contract sits at the call site: pass JSON-representable
// values only. Both callers build their input objects field by field.
function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableJson(value[k])).join(',') + '}';
}

module.exports = { stableJson };
