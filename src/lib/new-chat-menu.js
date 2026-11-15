(function () {
'use strict';

// The entries of a "new chat" menu, built from the CLIs found on this machine.
// One entry per detected CLI, the one used last first, each naming the folder
// it opens in; then the terminal. Pure, so every menu shows the same list.

// agents: [{ command, label, available }]; lastUsed: { [command]: ms }.
function detectedAgents(agents, lastUsed) {
  const used = lastUsed && typeof lastUsed === 'object' ? lastUsed : {};
  const when = (a) => Number(used[a.command]) || 0;
  return (Array.isArray(agents) ? agents : [])
    .filter((a) => a && a.available && a.command)
    .map((a, i) => ({ a, i }))
    .sort((x, y) => (when(y.a) - when(x.a)) || (x.i - y.i))
    .map(({ a }) => ({ command: String(a.command), label: String(a.label || a.command) }));
}

function newChatEntries({ agents, lastUsed, folder } = {}) {
  const found = detectedAgents(agents, lastUsed);
  const sub = String(folder || '');
  const chats = found.length
    ? found.map((a) => ({ kind: 'chat', command: a.command, label: `New chat with ${a.label}`, sub }))
    // Nothing found yet: offer the configured default.
    : [{ kind: 'chat', command: found.length ? found[0].command : '', label: 'New chat', sub }];
  return chats.concat([{ kind: 'terminal', command: '', label: 'Terminal', sub: '' }]);
}

(function publish(exports) {
  if (typeof module !== 'undefined' && module.exports) module.exports = exports;
  if (typeof window !== 'undefined') window.HuskNewChatMenu = exports;
})({ detectedAgents, newChatEntries });
})();
