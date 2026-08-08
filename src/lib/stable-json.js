'use strict';

// Canonical JSON: key-sorted, space-free, recursive.
//
// Two callers share this: the autonomy supervisor hashes an action signature
// with it to detect loops, and the portable workflow artifact fingerprints its
// graph with it. They share one implementation because two copies of a
// "stable" serializer are two things that can drift, and the day they drift is
// the day a published receipt stops matching the graph it was earned on, for a
// reason nobody can see in a diff.
//
// The output is not pretty-printed and is not meant to be read by a person. It
// is hash input. That is also why this function must not be "improved": any
// change to the bytes it emits silently invalidates every graph fingerprint
// ever published and every loop signature ever recorded. When the rule really
// does need to change, the fingerprint gets a new prefix instead, so an older
// file reads as "canonicalised by an older rule set" rather than as a file
// somebody altered.
// See GRAPH_HASH_PREFIX in workflow-artifact.js.
//
// Unlike the rest of src/lib this one returns a bare string rather than an
// { ok, error } pair. A serializer that can return a refusal is a serializer
// every call site has to branch on. Its contract is instead
// held at the call site: pass JSON-representable values only. undefined has no
// JSON text, so JSON.stringify hands back the undefined value rather than a
// string and it would land in the output as the bare word "undefined". Both
// callers build their input objects field by field, which is cheaper and more
// honest than paying for a validation walk on the hot path of every hash.
function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableJson(value[k])).join(',') + '}';
}

module.exports = { stableJson };
