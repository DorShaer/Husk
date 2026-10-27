// Terminal: a shell in the same window as the work.
//
// Husk already hosts a PTY per chat, so a shell is the same machinery pointed
// at your login shell instead of an agent. What it adds is the thing you
// otherwise leave the app for: run the test the agent just changed, check what
// git thinks, tail a log, without losing the pane you were reading.
//
// It opens in the active project, because a terminal that starts in your home
// directory is a terminal you have to cd out of every time.
//
// Tabs are independent shells. Closing one kills only its own process; nothing
// here reaches into a chat session's PTY, and a chat tab can never be closed
// from this page.

(function () {
  const byId = (id) => document.getElementById(id);
  const state = { tabs: new Map(), active: null, seq: 0 };

  function shellTheme() {
    const cs = getComputedStyle(document.body);
    const pick = (name, fallback) => (cs.getPropertyValue(name) || '').trim() || fallback;
    return {
      background: pick('--term-bg', '#0c0a09'),
      foreground: pick('--term-fg', '#e6e9ef'),
      cursor: pick('--accent', '#cf4600'),
    };
  }

  function fitAll() {
    for (const t of state.tabs.values()) {
      if (t.id !== state.active) continue;
      try {
        t.fit.fit();
        window.husk.pty.resize({ cols: t.term.cols, rows: t.term.rows }, t.id);
      } catch (_) {}
    }
  }

  function renderStrip() {
    const strip = byId('tm-strip');
    if (!strip) return;
    while (strip.firstChild) strip.removeChild(strip.firstChild);
    for (const t of state.tabs.values()) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tm-tab' + (t.id === state.active ? ' is-active' : '');
      const label = document.createElement('span');
      label.className = 'tm-tab-label';
      label.textContent = t.title;
      b.appendChild(label);
      const x = document.createElement('span');
      x.className = 'tm-tab-x';
      x.textContent = '×';
      x.title = 'Close this shell';
      x.addEventListener('click', (e) => { e.stopPropagation(); closeTab(t.id); });
      b.appendChild(x);
      b.addEventListener('click', () => activate(t.id));
      strip.appendChild(b);
    }
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'tm-tab tm-add';
    add.textContent = '+';
    add.title = 'New shell';
    add.addEventListener('click', () => newTab());
    strip.appendChild(add);
  }

  function activate(id) {
    state.active = id;
    for (const t of state.tabs.values()) t.el.hidden = t.id !== id;
    renderStrip();
    const t = state.tabs.get(id);
    if (t) { fitAll(); try { t.term.focus(); } catch (_) {} }
  }

  async function newTab() {
    const host = byId('tm-panes');
    if (!host || typeof Terminal === 'undefined') return;
    state.seq += 1;
    const id = `tm-${Date.now().toString(36)}-${state.seq}`;

    const el = document.createElement('div');
    el.className = 'tm-pane';
    host.appendChild(el);

    const term = new Terminal({
      cursorBlink: true,
      cursorInactiveStyle: 'none',
      fontFamily: '"Ubuntu Mono", "JetBrains Mono", "Fira Code", "Menlo", "Consolas", monospace',
      fontSize: 13,
      theme: shellTheme(),
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(el);

    const tab = { id, term, fit, el, title: `Shell ${state.seq}` };
    state.tabs.set(id, tab);
    term.onData((d) => window.husk.pty.write(d, id));

    activate(id);
    try { fit.fit(); } catch (_) {}

    // The login shell and the active project, both resolved in the main
    // process: the renderer has no environment of its own to read them from.
    let shell = null;
    let cwd = null;
    try {
      const d = await window.husk.terminal.defaults();
      if (d && d.ok) { shell = d.shell || null; cwd = d.cwd || null; }
    } catch (_) {}

    await window.husk.pty.start({
      cols: term.cols, rows: term.rows, command: shell, cwd, sessionId: id,
    });
  }

  function closeTab(id) {
    const t = state.tabs.get(id);
    if (!t) return;
    try { window.husk.pty.close(id); } catch (_) {}
    try { t.term.dispose(); } catch (_) {}
    if (t.el && t.el.parentNode) t.el.parentNode.removeChild(t.el);
    state.tabs.delete(id);
    const next = [...state.tabs.keys()].pop();
    if (next) activate(next); else { state.active = null; renderStrip(); }
  }

  // Output arrives on the same channel every PTY uses; a shell tab takes only
  // the frames addressed to its own id, so chat panes are never written to.
  function onData(id, chunk) {
    const t = state.tabs.get(id);
    if (!t) return false;
    t.term.write(chunk);
    return true;
  }

  function onExit(id) {
    const t = state.tabs.get(id);
    if (!t) return false;
    t.term.write('\r\n\x1b[0m[husk] shell exited\r\n');
    return true;
  }

  // Two openers in the same tick (the rail click and the router both land
  // here) must share one first tab, not race into two.
  let opening = null;
  async function open() {
    if (opening) return opening;
    if (!state.tabs.size) {
      opening = newTab().finally(() => { opening = null; });
      return opening;
    }
    renderStrip(); fitAll();
  }

  window.addEventListener('resize', () => fitAll());

  window.Tm = { open, newTab, closeTab, onData, onExit, state };
})();
