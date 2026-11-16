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

// Connected CLIs lead and the rest go under `more`; an unset list keeps every CLI in `main`.
function splitConnected(list, connected) {
  if (!Array.isArray(connected)) return { main: list, more: [] };
  const on = new Set(connected);
  return { main: list.filter((a) => on.has(a.command)), more: list.filter((a) => !on.has(a.command)) };
}

// connected: the commands the user connected, or null for every detected CLI.
function newChatEntries({ agents, lastUsed, folder, connected = null } = {}) {
  const { main, more } = splitConnected(detectedAgents(agents, lastUsed), connected);
  const sub = String(folder || '');
  const chats = main.length
    ? main.map((a) => ({ kind: 'chat', command: a.command, label: `New chat with ${a.label}`, sub }))
    // Nothing found yet: offer the configured default.
    : [{ kind: 'chat', command: '', label: 'New chat', sub }];
  return chats.concat([{ kind: 'terminal', command: '', label: 'Terminal', sub: '' }],
    more.map((a) => ({ kind: 'chat', command: a.command, label: `New chat with ${a.label}`, sub, group: 'more' })));
}

(function publish(exports) {
  if (typeof module !== 'undefined' && module.exports) module.exports = exports;
  if (typeof window !== 'undefined') window.HuskNewChatMenu = exports;
})({ detectedAgents, splitConnected, newChatEntries });
})();
