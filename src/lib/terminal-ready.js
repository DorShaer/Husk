(function () {
'use strict';

// Resolves true once a terminal has drawn output after `since` and then gone
// quiet for quietMs, the sign a CLI is waiting at its prompt. Resolves false
// when that does not happen within limitMs, or as soon as gone() says the
// terminal is no longer there.
async function waitForTerminalReady({ lastOutputAt, since = 0, quietMs = 700, limitMs = 20000, pollMs = 100, gone = () => false, now = Date.now, sleep } = {}) {
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const start = now();
  while (now() - start < limitMs) {
    if (gone()) return false;
    const at = Number(lastOutputAt()) || 0;
    if (at > since && now() - at >= quietMs) return true;
    await wait(pollMs);
  }
  return false;
}

(function publish(exports) {
  if (typeof module !== 'undefined' && module.exports) module.exports = exports;
  if (typeof window !== 'undefined') window.HuskTerminalReady = exports;
})({ waitForTerminalReady });
})();
