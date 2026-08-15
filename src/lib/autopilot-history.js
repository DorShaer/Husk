'use strict';

function latestTime(run) {
  return new Date((run && (run.endedAt || run.capturedAt)) || 0).getTime() || 0;
}

function chooseRepresentative(members) {
  const list = Array.isArray(members) ? members.filter(Boolean) : [];
  return list.find((r) => r.isIntegrator && Number(r.fileCount) > 0)
    || list.find((r) => r.isIntegrator)
    || list.slice().sort((a, b) => latestTime(b) - latestTime(a))[0]
    || null;
}

function aggregateFileCount(members, representative) {
  if (representative && representative.isIntegrator && Number(representative.fileCount) > 0) {
    return Number(representative.fileCount) || 0;
  }
  return (Array.isArray(members) ? members : [])
    .filter((r) => !r.isIntegrator)
    .reduce((sum, r) => sum + (Number(r.fileCount) || 0), 0);
}

function groupHistoryRuns(runs) {
  const groups = new Map();
  for (const run of Array.isArray(runs) ? runs : []) {
    if (!run || !run.sessionId) continue;
    const key = run.groupId ? `group:${run.groupId}` : `run:${run.sessionId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
  const out = [];
  for (const [key, members] of groups) {
    members.sort((a, b) => latestTime(b) - latestTime(a));
    const rep = chooseRepresentative(members);
    if (!rep) continue;
    const latest = members[0];
    const earliest = members.slice().sort((a, b) => latestTime(a) - latestTime(b))[0] || rep;
    const fileCount = aggregateFileCount(members, rep);
    out.push({
      ...rep,
      historyId: key,
      sessionIds: members.map((m) => m.sessionId),
      memberCount: members.length,
      members,
      fileCount,
      dollars: members.reduce((sum, m) => sum + (Number(m.dollars) || 0), 0),
      tokens: members.reduce((sum, m) => sum + (Number(m.tokens) || 0), 0),
      endedAt: latest.endedAt || rep.endedAt || null,
      capturedAt: earliest.capturedAt || rep.capturedAt || null,
    });
  }
  out.sort((a, b) => latestTime(b) - latestTime(a));
  return out;
}

module.exports = {
  aggregateFileCount,
  chooseRepresentative,
  groupHistoryRuns,
};
