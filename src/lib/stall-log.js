'use strict';

// Records moments the app stops responding: main event-loop stalls, IPC
// handlers whose synchronous part runs long, and renderer long tasks. One
// line each in a small capped file, so a freeze names its cause.

const LOOP_TICK_MS = 50;
const LOOP_STALL_MS = 400;
const IPC_SYNC_MS = 150;
const MAX_BYTES = 256 * 1024;

function createStallLog({ fs, file, now = Date.now, startedAt = Date.now() }) {
  const inFlight = new Map();

  function note(text) {
    const line = `${new Date(now()).toISOString()} +${Math.round((now() - startedAt) / 1000)}s ${text}\n`;
    try {
      const st = fs.statSync(file, { throwIfNoEntry: false });
      if (st && st.size > MAX_BYTES) fs.writeFileSync(file, line);
      else fs.appendFileSync(file, line);
    } catch (_) {
      try { fs.writeFileSync(file, line); } catch (_) {}
    }
  }

  function monitorLoop(setIntervalFn = setInterval) {
    let last = now();
    const t = setIntervalFn(() => {
      const at = now();
      const gap = at - last - LOOP_TICK_MS;
      last = at;
      if (gap >= LOOP_STALL_MS) {
        const busy = [...inFlight.keys()];
        note(`main loop blocked ${gap}ms${busy.length ? ` during ${busy.join(', ')}` : ''}`);
      }
    }, LOOP_TICK_MS);
    if (t && t.unref) t.unref();
    return t;
  }

  // Wraps ipcMain.handle so every handler reports a long synchronous part.
  function wrapIpc(ipcMain) {
    const original = ipcMain.handle.bind(ipcMain);
    ipcMain.handle = (channel, fn) => original(channel, (...args) => {
      const t0 = now();
      inFlight.set(channel, t0);
      let out;
      try { out = fn(...args); } catch (err) { inFlight.delete(channel); throw err; } finally {
        const sync = now() - t0;
        if (sync >= IPC_SYNC_MS) note(`ipc ${channel} blocked main ${sync}ms`);
      }
      Promise.resolve(out).finally(() => inFlight.delete(channel)).catch(() => {});
      return out;
    });
  }

  return { note, monitorLoop, wrapIpc };
}

module.exports = { createStallLog, LOOP_STALL_MS, IPC_SYNC_MS };
