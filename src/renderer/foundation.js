'use strict';
(function () {
  const api = window.husk.foundation;
  const el = (tag, text, cls) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  };
  const reviews = [];
  let reviewing = false;
  let lib = { scanner: true, reason: null, items: {} };
  const connect = async () => {
    try {
      const r = await api.chooseScanner();
      if (r?.ok === false) toast(r.error || 'Could not connect the scanner', 'error');
      else if (!r?.canceled) toast('Scanner connected. Husk checks your library in the background.', 'success');
    } catch (err) { toast(err.message, 'error'); }
    loadLibrary();
  };
  function findingList(summary) {
    const list = el('ul', undefined, 'risk-findings');
    for (const f of summary.findings) {
      const li = el('li', undefined, 'risk-finding');
      const head = el('div', undefined, 'risk-finding-head');
      head.append(el('span', f.severity, `risk-sev is-${f.severity.toLowerCase()}`), el('span', f.title, 'risk-finding-title'));
      li.append(head);
      if (f.detail) li.append(el('p', f.detail, 'risk-finding-detail'));
      if (f.evidence) li.append(el('code', f.evidence.split('\n')[0].slice(0, 200), 'risk-finding-evidence'));
      if (f.where) li.append(el('div', f.where, 'risk-finding-where'));
      list.append(li);
    }
    return list;
  }
  async function showReview() {
    if (reviewing || !reviews.length) return;
    reviewing = true;
    const details = reviews.shift();
    const summary = details.summary;
    const kind = details.kindLabel || 'item';
    const using = details.mode === 'use';
    const runs = details.kind === 'workflow';
    const overlay = el('div', undefined, 'modal');
    const card = el('div', undefined, `modal-card install-review risk-${summary.state}`);
    card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-label', 'Security check');
    const title = summary.state === 'blocked' ? `Husk's security scanner blocked this ${kind}`
      : summary.state === 'unchecked' ? `This ${kind} was not checked`
        : `This ${kind} looks risky`;
    card.append(el('h2', title, 'risk-title'));
    card.append(el('p', details.name, 'risk-name'));
    if (details.manifest && details.manifest.publisher && details.manifest.publisher !== 'Not supplied') {
      const signed = details.signature || { state: 'unsigned' };
      card.append(el('p', `Publisher: ${details.manifest.publisher}. Signature: ${signed.state}${signed.publisher ? ` (${signed.publisher})` : ''}`, 'risk-meta'));
    }
    if (summary.state === 'unchecked') {
      const note = el('div', undefined, 'risk-note');
      note.append(el('span', summary.note));
      if (summary.connect) {
        const btn = el('button', 'Connect', 'ghost-btn'); btn.type = 'button';
        btn.addEventListener('click', () => { finish(false); connect(); });
        note.append(btn);
      }
      card.append(note);
      card.append(el('p', 'Read it yourself before an agent uses it.', 'risk-lead'));
    } else {
      const n = summary.findings.length + summary.more;
      card.append(el('p', summary.state === 'blocked'
        ? `It found ${n === 1 ? 'a problem' : `${n} problems`} serious enough that Husk will not ${using ? (runs ? 'run' : 'turn on') : 'add'} it.`
        : `Husk's security scanner found ${n === 1 ? 'one thing' : `${n} things`} to look at${using ? (runs ? ' before this runs' : ' before you turn it on') : ''}. Are you sure you want to use it?`, 'risk-lead'));
      card.append(findingList(summary));
      if (summary.more) card.append(el('p', `And ${summary.more} more.`, 'risk-more'));
      if (summary.reach.length) {
        const reach = el('div', undefined, 'risk-reach');
        reach.append(el('div', 'What it can reach', 'risk-reach-label'));
        for (const line of summary.reach) reach.append(el('div', line));
        card.append(reach);
      }
    }
    if (Array.isArray(details.files) && details.files.length) {
      const files = el('details', undefined, 'install-review-files');
      files.append(el('summary', details.files.length === 1 ? 'Show the file' : `Show the ${details.files.length} files`));
      for (const file of details.files) { files.append(el('div', file.path, 'risk-file-path')); files.append(el('pre', file.text)); }
      card.append(files);
    }
    const actions = el('div', undefined, 'modal-actions');
    const blocked = summary.state === 'blocked';
    const no = el('button', blocked ? 'Close' : "Don't use it", 'btn-primary risk-no');
    no.type = 'button';
    const previous = document.activeElement;
    const finish = async (approved) => {
      if (!overlay.isConnected) return;
      overlay.remove(); document.removeEventListener('keydown', key, true);
      await api.answerReview({ id: details.id, approved });
      previous?.focus?.(); reviewing = false; showReview();
    };
    const key = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false); }
      if (event.key === 'Tab') {
        const buttons = [...card.querySelectorAll('button, summary')];
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    no.addEventListener('click', () => finish(false));
    if (!blocked) {
      const yes = el('button', 'Use it anyway', 'ghost-btn risk-yes');
      yes.type = 'button'; yes.addEventListener('click', () => finish(true)); actions.append(yes);
    }
    actions.append(no);
    card.append(actions); overlay.append(card); document.body.append(overlay);
    document.addEventListener('keydown', key, true); no.focus();
  }
  api.onReview((details) => { reviews.push(details); showReview(); });

  // Badges on flagged library items, and a plain note when nothing was checked.
  const PAGES = [
    { page: 'skills', list: '#skills-list', row: '.sk-row[data-name]', key: (r) => `skill:${r.dataset.name}`, slot: '.sk-row-label' },
    { page: 'agents', list: '#ag-list', row: '.ag-row[data-id]', key: (r) => `agent:${r.dataset.id}`, slot: '.ag-name' },
    { page: 'workflows', list: '#wf-grid', row: '.wf-card[data-id]', key: (r) => `workflow:${r.dataset.id}`, slot: '.wf-card-title' },
    { page: 'mcp', list: '#mcp-installed', row: '.mcp-row[data-id]', key: (r) => `mcp:${r.dataset.id}`, slot: '.mr-name' },
  ];
  function badgeFor(item) {
    const label = item.state === 'blocked' ? 'Blocked' : item.state === 'risky' ? 'Risky' : 'Not checked';
    const badge = el('span', label, `risk-badge is-${item.state}`);
    const lines = item.state === 'unchecked' ? [item.note]
      : item.findings.map((f) => `${f.severity}: ${f.title}${f.where ? ` (${f.where})` : ''}`).concat(item.more ? [`And ${item.more} more`] : []);
    if (item.approved) lines.push('You chose to use it anyway.');
    badge.title = `Husk's security scanner\n${lines.join('\n')}`;
    badge.dataset.riskSig = `${item.state}|${badge.title}`;
    return badge;
  }
  let painting = false;
  function decorate() {
    painting = true;
    try {
      for (const p of PAGES) {
        const root = document.querySelector(`.page-${p.page}`);
        if (!root) continue;
        for (const row of document.querySelectorAll(`${p.list} ${p.row}`)) {
          const item = lib.items[p.key(row)];
          const old = row.querySelector('.risk-badge');
          if (!item) { old?.remove(); continue; }
          const badge = badgeFor(item);
          if (old && old.dataset.riskSig === badge.dataset.riskSig) continue;
          old?.remove();
          row.querySelector(p.slot)?.append(badge);
        }
      }
    } finally { painting = false; }
  }
  let queued = false;
  const schedule = () => { if (painting || queued) return; queued = true; requestAnimationFrame(() => { queued = false; decorate(); }); };
  for (const p of PAGES) {
    const node = document.querySelector(p.list);
    if (node) new MutationObserver(schedule).observe(node, { childList: true, subtree: true });
  }
  async function loadLibrary() {
    try { lib = await api.library(); schedule(); } catch (_) {}
  }
  api.onLibrary((snap) => { lib = snap; schedule(); });
  document.querySelectorAll('.rail-item[data-page="skills"], .rail-item[data-page="agents"], .rail-item[data-page="workflows"], .rail-item[data-page="mcp"]')
    .forEach((item) => item.addEventListener('click', loadLibrary));
  loadLibrary();
})();
