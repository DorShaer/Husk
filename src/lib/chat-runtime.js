'use strict';

// Chat-mode runtime: one headless agent child per tab, driven over ACP or
// claude stream-json, surfacing normalized chat events. Process handling is
// injected (spawn, env, exe resolution, event sink) so the whole thing is unit
// testable with a fake child; main.js supplies the real ones.
//
// Lifecycle per tab: start -> prompt* / permission* / cancel* -> stop (or the
// child exits on its own, which reports chat:exit and clears the slot).

const { createFramer, encodeLine } = require('./jsonrpc-stdio');
const { createAcpClient, textPrompt } = require('./acp-client');
const { transportFor, acpArgs, userFlags } = require('./chat-transport');
const {
  claudeChatArgs, encodeUserMessage, encodePermissionResponse, encodeInterrupt, encodeInitialize, isPermissionRequest,
} = require('./claude-stream');
const {
  normalizeAcpUpdate, normalizeAcpPermission, normalizeAcpSession, normalizeClaudeEvent,
} = require('./chat-events');

const STDERR_KEEP = 2000;
// Replay log bounds. A renderer reload rebuilds each tab's thread from this
// log, so it keeps the shape of the conversation (coalesced text, every tool
// and permission event) without growing without limit on a long session.
const LOG_MAX_EVENTS = 4000;
const LOG_MAX_TEXT = 400000;

const AUTH_HINT = 'Switch this tab to Terminal mode to sign in, then switch back to Chat.';
// An ACP agent answers initialize within a second or two; one that never does
// (an older build, a wrapper that ignores --acp) must fail the start instead
// of leaving the tab on "Starting" forever.
const HANDSHAKE_MS = 20000;

function createChatRuntime({ spawn, buildEnv, resolveExe, emit, emitExit, appVersion, platform, comSpec, log, handshakeMs, controlTimeoutMs } = {}) {
  if (typeof spawn !== 'function') throw new TypeError('spawn is required');
  const sessions = new Map();
  const isWin = (platform || process.platform) === 'win32';
  const handshakeLimit = typeof handshakeMs === 'number' && handshakeMs > 0 ? handshakeMs : HANDSHAKE_MS;
  const note = typeof log === 'function' ? log : () => {};
  let permSeq = 0;

  // record appends one event to the session's replay log. Adjacent text or
  // thought chunks merge into one entry; permission cards that were answered
  // are kept as-is since the resolved event follows them in the log.
  function record(s, ev) {
    if (!s || !ev) return;
    const log = s.log;
    const last = log[log.length - 1];
    if ((ev.type === 'text' || ev.type === 'thought') && last && last.type === ev.type) {
      last.text += ev.text;
      s.logText += ev.text.length;
    } else {
      log.push(ev.type === 'text' || ev.type === 'thought' ? { type: ev.type, text: ev.text } : ev);
      if (ev.text) s.logText += String(ev.text).length;
    }
    while (log.length > LOG_MAX_EVENTS || (s.logText > LOG_MAX_TEXT && log.length > 1)) {
      const dropped = log.shift();
      if (dropped && dropped.text) s.logText -= String(dropped.text).length;
      s.logTruncated = true;
    }
  }

  function send(tabId, events) {
    if (!Array.isArray(events)) events = [events];
    const s = sessions.get(tabId);
    for (const ev of events) {
      if (!ev) continue;
      if (s) record(s, ev);
      if (typeof emit === 'function') emit(tabId, ev);
    }
  }

  function tailStderr(s) {
    return String(s.stderr || '').trim().split(/\r?\n/).filter(Boolean).slice(-3).join('\n');
  }

  function spawnChild(exe, args, cwd, env) {
    const opts = {
      cwd: cwd || undefined,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // A process group of its own so stop() can take the agent's helpers
      // (gemini forks workers that outlive a plain kill) down with it.
      detached: !isWin,
      windowsHide: true,
    };
    // npm installs a CLI on Windows as a .cmd shim, which CreateProcess cannot
    // run directly (Node refuses it since the BatBadBut fix). Run it through
    // the command interpreter with the whole line quoted once.
    if (isWin && /\.(cmd|bat)$/i.test(String(exe))) {
      const quote = (a) => (/[\s"&|<>^()]/.test(a) ? '"' + String(a).replace(/"/g, '""') + '"' : String(a));
      const line = [exe].concat(args).map(quote).join(' ');
      const shell = comSpec || (env && env.ComSpec) || process.env.ComSpec || 'cmd.exe';
      return spawn(shell, ['/d', '/s', '/c', '"' + line + '"'], Object.assign({}, opts, { windowsVerbatimArguments: true }));
    }
    return spawn(exe, args, opts);
  }

  function wireChild(s) {
    const child = s.child;
    child.stdout.on('data', (d) => s.framer.push(d));
    child.stderr.on('data', (d) => {
      s.stderr = (s.stderr + String(d)).slice(-STDERR_KEEP);
    });
    child.on('error', (e) => {
      note(`chat child error: ${e && e.message}`);
      send(s.tabId, { type: 'error', text: `Could not start ${s.exe}: ${e && e.message}` });
    });
    child.on('exit', (code, signal) => {
      s.framer.flush();
      if (s.acp) s.acp.close('agent exited');
      for (const r of s.pendingPerms.values()) { try { r(null); } catch (_) {} }
      s.pendingPerms.clear();
      s.exited = true;
      if (sessions.get(s.tabId) === s) sessions.delete(s.tabId);
      // A child Husk stopped or replaced on purpose (stop, restart in place)
      // exits quietly: reporting it would mark the tab dead under its successor.
      if (s.stopped) return;
      const why = tailStderr(s);
      if (code !== 0 && code !== null && why) send(s.tabId, { type: 'error', text: why });
      if (typeof emitExit === 'function') emitExit(s.tabId, code === null ? (signal || -1) : code);
    });
  }

  function writeLine(s, obj) {
    if (!s.child || s.exited) return false;
    try { s.child.stdin.write(encodeLine(obj)); return true; } catch (e) { note(`chat stdin write failed: ${e && e.message}`); return false; }
  }

  // claudeSessionId pins claude's transcript to a known id (the same trick
  // spawnPty uses) so the status panel can find this tab's .jsonl by name.
  async function start({ tabId, command, cwd, claudeSessionId, keepLog } = {}) {
    if (!tabId) return { ok: false, error: 'tabId required' };
    const transport = transportFor(command);
    if (!transport) return { ok: false, error: `${String(command || '').split(/\s+/)[0] || 'agent'} has no chat protocol yet` };
    if (sessions.has(tabId)) await stop({ tabId });

    const env = typeof buildEnv === 'function' ? buildEnv(transport) : Object.assign({}, process.env);
    const tokens = String(command || 'claude').trim().split(/\s+/).filter(Boolean);
    const exeName = tokens[0] || 'claude';
    const exe = typeof resolveExe === 'function' ? resolveExe(exeName, env.PATH) : exeName;
    const flags = userFlags(command);

    const s = {
      tabId, transport, exe, command: String(command || '').trim(), cwd: cwd || null, child: null, framer: null, acp: null,
      sessionId: null, pendingPerms: new Map(), permInputs: new Map(), stderr: '', exited: false, turnOpen: false,
      // keepLog carries the replay log across a restart in place (a model
      // switch), so a reload afterwards still rebuilds the whole thread.
      log: Array.isArray(keepLog) ? keepLog.slice() : [], logText: 0, logTruncated: false, startedAt: Date.now(),
    };
    for (const ev of s.log) if (ev && ev.text) s.logText += String(ev.text).length;

    if (transport === 'acp') {
      const args = acpArgs(command).concat(flags);
      try { s.child = spawnChild(exe, args, cwd, env); } catch (e) { return { ok: false, error: e.message }; }
      s.acp = createAcpClient({
        send: (msg) => writeLine(s, msg),
        onUpdate: ({ update }) => send(tabId, normalizeAcpUpdate(update)),
        onPermission: (params) => new Promise((resolve) => {
          const requestId = 'p' + (++permSeq);
          s.pendingPerms.set(requestId, resolve);
          send(tabId, normalizeAcpPermission(requestId, params));
        }),
      });
      s.framer = createFramer((msg) => s.acp.receive(msg), (raw) => note(`acp non-json line: ${raw.slice(0, 200)}`));
      sessions.set(tabId, s);
      wireChild(s);
      try {
        let timer = null;
        const expiry = new Promise((_, reject) => {
          timer = setTimeout(() => {
            const err = new Error(`${exeName} did not answer the ACP handshake within ${Math.round(handshakeLimit / 1000)}s. It may not support ${transport === 'acp' ? (acpArgs(command) || []).join(' ') : 'this mode'} in this version.`);
            err.code = 'HANDSHAKE_TIMEOUT';
            reject(err);
          }, handshakeLimit);
          if (timer && timer.unref) timer.unref();
        });
        const handshake = (async () => {
          await s.acp.initialize({ name: 'husk', version: String(appVersion || '0.0.0') });
          return s.acp.newSession(cwd || process.cwd(), []);
        })();
        const res = await Promise.race([handshake, expiry]);
        clearTimeout(timer);
        s.sessionId = res && res.sessionId ? String(res.sessionId) : null;
        send(tabId, normalizeAcpSession(res));
      } catch (e) {
        const detail = tailStderr(s) || (e && e.message) || 'ACP handshake failed';
        // An agent that is not signed in refuses the session (auth_required
        // in ACP terms, or its own login error on stderr). The way back is the
        // CLI's interactive login, which lives in Terminal mode.
        const authy = /auth|login|sign in|credential|unauthori|not logged/i.test(detail) || (e && e.code === -32000);
        await stop({ tabId });
        return { ok: false, error: authy ? `${detail}\n${AUTH_HINT}` : detail };
      }
      return { ok: true, transport, sessionId: s.sessionId };
    }

    // claude stream-json
    const userPinned = flags.includes('--session-id') || flags.includes('--resume') || flags.some((f) => /^--(session-id|resume)=/.test(f));
    const pinned = !userPinned && claudeSessionId ? String(claudeSessionId) : null;
    const args = claudeChatArgs({ userFlags: flags, sessionId: pinned });
    if (pinned) s.sessionId = pinned;
    try { s.child = spawnChild(exe, args, cwd, env); } catch (e) { return { ok: false, error: e.message }; }
    s.framer = createFramer((ev) => {
      // Replies to Husk's own control requests. initialize carries claude's own
      // model list, the same one its /model menu shows; set_model answers here.
      if (ev && ev.type === 'control_response' && ev.response) {
        const rid = String(ev.response.request_id || '');
        const body = ev.response.response || {};
        if (rid === s.initId && Array.isArray(body.models) && body.models.length) {
          const available = body.models.filter((m) => m && m.value).map((m) => ({ id: String(m.value), name: String(m.displayName || m.value), description: m.description ? String(m.description) : undefined }));
          send(tabId, { type: 'session', models: { current: null, available } });
        }
        const waiter = s.ctlWaiters && s.ctlWaiters.get(rid);
        if (waiter) { s.ctlWaiters.delete(rid); waiter(ev.response); }
        return;
      }
      if (isPermissionRequest(ev)) {
        const r = ev.request || {};
        s.permInputs.set(String(ev.request_id), { input: r.input || {}, suggestions: Array.isArray(r.permission_suggestions) ? r.permission_suggestions : [] });
      }
      const events = normalizeClaudeEvent(ev);
      for (const ne of events) {
        if (ne.type === 'session' && ne.sessionId) s.sessionId = ne.sessionId;
        if (ne.type === 'turn_end') s.turnOpen = false;
      }
      send(tabId, events);
    }, (raw) => note(`claude non-json line: ${raw.slice(0, 200)}`));
    sessions.set(tabId, s);
    wireChild(s);
    // Without this handshake claude answers its own permission prompts with a
    // config-sourced deny and the chat silently loses every guarded tool.
    s.initId = 'init-' + Date.now().toString(36);
    s.ctlWaiters = new Map();
    writeLine(s, encodeInitialize(s.initId));
    return { ok: true, transport, sessionId: s.sessionId };
  }

  // Pasted images ride along as base64; a handful at most, each bounded, and
  // only their kinds go into the replay log (the bytes would swamp it).
  const IMAGE_MAX = 6;
  const IMAGE_MAX_B64 = 8 * 1024 * 1024;
  function cleanImages(images) {
    if (!Array.isArray(images)) return [];
    const out = [];
    for (const im of images) {
      if (!im || typeof im.data !== 'string' || !im.data) continue;
      if (im.data.length > IMAGE_MAX_B64) continue;
      const mimeType = /^image\/[a-z0-9.+-]+$/i.test(String(im.mimeType || '')) ? String(im.mimeType) : 'image/png';
      out.push({ mimeType, data: im.data });
      if (out.length >= IMAGE_MAX) break;
    }
    return out;
  }

  async function prompt({ tabId, text, images } = {}) {
    const s = sessions.get(tabId);
    if (!s) return { ok: false, error: 'no chat session' };
    const body = String(text || '');
    const pics = cleanImages(images);
    if (!body.trim() && !pics.length) return { ok: false, error: 'empty prompt' };
    // The renderer paints the user's bubble itself before calling here, so the
    // log takes it directly rather than echoing it back.
    record(s, Object.assign({ type: 'user', text: body }, pics.length ? { images: pics.map((p) => ({ mimeType: p.mimeType })) } : {}));
    if (s.transport === 'acp') {
      if (!s.sessionId) return { ok: false, error: 'session not ready' };
      s.turnOpen = true;
      send(tabId, { type: 'turn_start' });
      s.acp.prompt(s.sessionId, textPrompt(body, pics))
        .then((res) => {
          s.turnOpen = false;
          send(tabId, { type: 'turn_end', stopReason: (res && res.stopReason) || 'end_turn' });
        })
        .catch((e) => {
          s.turnOpen = false;
          if (s.exited) return;
          send(tabId, { type: 'turn_end', stopReason: 'error', isError: true, text: (e && e.message) || 'prompt failed' });
        });
      return { ok: true };
    }
    s.turnOpen = true;
    return { ok: writeLine(s, encodeUserMessage(body, pics)) };
  }

  async function cancel({ tabId } = {}) {
    const s = sessions.get(tabId);
    if (!s) return { ok: false };
    if (s.transport === 'acp') {
      if (s.sessionId) s.acp.cancel(s.sessionId);
      return { ok: true };
    }
    return { ok: writeLine(s, encodeInterrupt('i' + Date.now().toString(36))) };
  }

  async function permission({ tabId, requestId, optionId } = {}) {
    const s = sessions.get(tabId);
    if (!s) return { ok: false, error: 'no chat session' };
    const id = String(requestId || '');
    if (s.transport === 'acp') {
      const resolve = s.pendingPerms.get(id);
      if (!resolve) return { ok: false, error: 'unknown permission request' };
      s.pendingPerms.delete(id);
      resolve(optionId === null || optionId === undefined ? null : String(optionId));
    } else {
      const perm = s.permInputs.get(id);
      if (perm === undefined) return { ok: false, error: 'unknown permission request' };
      s.permInputs.delete(id);
      const choice = String(optionId);
      const allow = choice === 'allow' || choice === 'allow-session';
      writeLine(s, encodePermissionResponse(id, allow, perm.input, undefined, choice === 'allow-session' ? perm.suggestions : undefined));
    }
    send(tabId, { type: 'permission_resolved', requestId: id, optionId: String(optionId) });
    return { ok: true };
  }

  // setModel switches the model the tab talks to. ACP agents take it live
  // (session/set_model); claude has no such call, so its child is restarted
  // with --model and --resume on the same session, which keeps the
  // conversation and the replay log.
  async function setModel({ tabId, modelId, modelName } = {}) {
    const s = sessions.get(tabId);
    const id = String(modelId || '').trim();
    if (!s) return { ok: false, error: 'no chat session' };
    if (!id) return { ok: false, error: 'model id required' };
    if (s.transport === 'acp') {
      if (!s.sessionId) return { ok: false, error: 'session not ready' };
      try { await s.acp.setModel(s.sessionId, id); } catch (e) { return { ok: false, error: (e && e.message) || 'the agent refused the model' }; }
      send(tabId, { type: 'session', model: String(modelName || id) });
      return { ok: true, transport: 'acp', model: id };
    }
    // claude takes set_model on its control channel and applies it from the
    // next turn, with no restart (verified on claude 2.1.310).
    const live = await new Promise((resolve) => {
      const rid = 'sm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
      const timer = setTimeout(() => { if (s.ctlWaiters) s.ctlWaiters.delete(rid); resolve(null); }, typeof controlTimeoutMs === 'number' ? controlTimeoutMs : 10000);
      if (timer.unref) timer.unref();
      if (!s.ctlWaiters) s.ctlWaiters = new Map();
      s.ctlWaiters.set(rid, (resp) => { clearTimeout(timer); resolve(resp); });
      if (!writeLine(s, { type: 'control_request', request_id: rid, request: { subtype: 'set_model', model: id } })) { clearTimeout(timer); s.ctlWaiters.delete(rid); resolve(null); }
    });
    if (live && live.subtype === 'success') {
      const applied = String((live.response && live.response.model) || id);
      send(tabId, { type: 'session', model: String(modelName || applied) });
      return { ok: true, transport: 'claude', model: applied };
    }
    if (live && live.subtype === 'error') return { ok: false, error: String(live.error || 'claude refused the model') };
    // No answer at all (an older CLI): restart under the model, same session.
    if (s.turnOpen) return { ok: false, error: 'wait for the current reply to finish, then switch' };
    const flags = userFlags(s.command).filter((f, i, arr) => !(f === '--model' || f.startsWith('--model=') || (i > 0 && arr[i - 1] === '--model')));
    const base = String(s.command || 'claude').trim().split(/\s+/)[0] || 'claude';
    const resume = s.sessionId;
    const withoutResume = flags.filter((f, i, arr) => !(f === '--resume' || f === '--session-id' || /^--(resume|session-id)=/.test(f) || (i > 0 && (arr[i - 1] === '--resume' || arr[i - 1] === '--session-id'))));
    const command = [base, ...withoutResume, '--model', id, ...(resume ? ['--resume', resume] : [])].join(' ');
    const log = s.log;
    const cwd = s.cwd;
    const res = await start({ tabId, command, cwd, keepLog: log });
    if (!res || !res.ok) return res;
    const ns = sessions.get(tabId);
    if (ns && resume) ns.sessionId = resume;
    send(tabId, { type: 'session', model: String(modelName || id) });
    return { ok: true, transport: 'claude', model: id, restarted: true };
  }

  function killTree(s) {
    const child = s.child;
    if (!child || s.exited) return;
    const pid = child.pid;
    try {
      if (!isWin && pid) process.kill(-pid, 'SIGTERM');
      else child.kill();
    } catch (_) {
      try { child.kill(); } catch (_) {}
    }
    setTimeout(() => {
      if (s.exited) return;
      try {
        if (!isWin && pid) process.kill(-pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch (_) {}
    }, 1500).unref && setTimeout(() => {}, 0).unref();
  }

  async function stop({ tabId } = {}) {
    const s = sessions.get(tabId);
    if (!s) return { ok: true };
    s.stopped = true;
    sessions.delete(tabId);
    try { if (s.child && s.child.stdin) s.child.stdin.end(); } catch (_) {}
    killTree(s);
    return { ok: true };
  }

  function stopAll() {
    for (const tabId of Array.from(sessions.keys())) stop({ tabId });
  }

  function info(tabId) {
    const s = sessions.get(tabId);
    return s ? { transport: s.transport, sessionId: s.sessionId, pid: s.child && s.child.pid, turnOpen: s.turnOpen } : null;
  }

  // list describes every live chat child with its replay log, for a reloaded
  // renderer to rebuild its tabs without restarting the agents.
  function list() {
    const out = [];
    for (const s of sessions.values()) {
      if (s.exited) continue;
      out.push({
        tabId: s.tabId, transport: s.transport, sessionId: s.sessionId, command: s.command, cwd: s.cwd,
        turnOpen: !!s.turnOpen, startedAt: s.startedAt, truncated: !!s.logTruncated,
        events: s.log.map((ev) => Object.assign({}, ev)),
      });
    }
    return out;
  }

  return { start, prompt, cancel, permission, setModel, stop, stopAll, info, list, size: () => sessions.size };
}

module.exports = { createChatRuntime };
