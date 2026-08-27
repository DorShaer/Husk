'use strict';

// Ranking for the universal search palette.
//
// The palette offers two kinds of row: a command, and a thing the app already
// holds. A query has to be able to find either without being aimed at one
// first, so both are scored the same way and the sections sort by how well they
// answered rather than by a fixed order.
//
// This file decides order and nothing else. What a row is, and what happens
// when it runs, belongs to the renderer; an entry here carries only the two
// strings a query can match against and the section it came from. Results are
// positions back into the caller's own array, so no closure has to cross the
// preload boundary to be ranked.

const { fuzzyMatch } = require('./fuzzy');

// A hit on the name outranks any hit on the line beneath it, and a name the
// query spells from its first letter outranks one it merely threads through.
const LABEL_WEIGHT = 1000;
const PREFIX_WEIGHT = 500;
// The ceiling for a hit on the sub line, kept below LABEL_WEIGHT so that a name
// match always leads a description match however long the description is.
const SUB_WEIGHT = 400;
// Per section, so one crowded surface cannot bury the other six.
const DEFAULT_SECTION_MAX = 5;

// How well one entry answers the query, or null when it does not answer it.
//
// The two strings are matched differently on purpose. A name is short and is
// usually half-remembered, so it is matched letter by letter with gaps allowed.
// The line beneath it is prose, sometimes a paragraph of it, and a gapped match
// there means nothing: almost any short query threads through a long enough
// description, which fills the list with rows that have no visible connection to
// what was typed. So a sub line matches only as a literal run of characters, and
// scores by how early that run starts.
function scoreEntry(query, entry) {
  const q = String(query == null ? '' : query).trim();
  if (!q) return null;
  const label = String((entry && entry.label) || '');
  const sub = String((entry && entry.sub) || '');

  const onLabel = label ? fuzzyMatch(q, label) : null;
  if (onLabel) {
    const prefix = label.toLowerCase().startsWith(q.toLowerCase()) ? PREFIX_WEIGHT : 0;
    return onLabel.score + LABEL_WEIGHT + prefix;
  }
  const at = sub ? sub.toLowerCase().indexOf(q.toLowerCase()) : -1;
  return at === -1 ? null : Math.max(1, SUB_WEIGHT - at);
}

// Ranked positions into `entries`, grouped by section and capped per section.
//
// Sections sort by their own best row, which is what lets a query aimed at one
// surface lead without pinning any surface to the top. Ties fall back to
// `sectionOrder`, so two queries that score the same never shuffle the layout.
function rank(query, entries, opts = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const sectionOrder = Array.isArray(opts.sectionOrder) ? opts.sectionOrder : [];
  const max = Number.isFinite(opts.sectionMax) && opts.sectionMax > 0
    ? Math.floor(opts.sectionMax)
    : DEFAULT_SECTION_MAX;

  const bySection = new Map();
  for (let i = 0; i < list.length; i++) {
    const score = scoreEntry(query, list[i]);
    if (score == null) continue;
    const section = String((list[i] && list[i].section) || '');
    if (!bySection.has(section)) bySection.set(section, []);
    bySection.get(section).push({ index: i, section, score });
  }

  // A section the caller did not list sorts after every one it did, rather than
  // ahead of all of them on an index of -1.
  const rankOf = (name) => {
    const at = sectionOrder.indexOf(name);
    return at === -1 ? sectionOrder.length : at;
  };
  const labelAt = (i) => String((list[i] && list[i].label) || '');

  return [...bySection.values()]
    .map((rows) => {
      rows.sort((a, b) => b.score - a.score
        || labelAt(a.index).localeCompare(labelAt(b.index))
        || a.index - b.index);
      return rows;
    })
    .sort((a, b) => b[0].score - a[0].score || rankOf(a[0].section) - rankOf(b[0].section))
    .flatMap((rows) => rows.slice(0, max));
}

module.exports = { rank, scoreEntry, LABEL_WEIGHT, PREFIX_WEIGHT, SUB_WEIGHT, DEFAULT_SECTION_MAX };
