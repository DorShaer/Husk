'use strict';
(function () {
  let overlay = null;
  let restoreFocus = null;
  const node = (tag, cls, text) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text) el.textContent = text;
    return el;
  };
  function close() {
    overlay?.remove();
    overlay = null;
    document.removeEventListener('keydown', key, true);
    const target = restoreFocus?.offsetParent ? restoreFocus : document.getElementById('btn-help');
    target?.focus();
  }
  function key(e) {
    if (!overlay) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); }
    if (e.key !== 'Tab') return;
    const controls = [...overlay.querySelectorAll('button, a[href]')];
    const first = controls[0]; const last = controls[controls.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  async function openReference() {
    try {
      const result = await window.husk.urls.openExternal(window.HuskHelpContent.links.documentation);
      if (result?.ok === false) toast(result.error || 'Could not open the documentation in your browser.', 'error');
    } catch (err) { toast(err.message || 'Could not open your browser.', 'error'); }
  }
  function open(name = 'documentation') {
    const topic = window.HuskHelpContent.topics[name];
    if (!topic) return;
    if (overlay) close();
    restoreFocus = document.activeElement;
    overlay = node('div', 'modal help-overlay');
    overlay.id = 'help-dialog';
    const card = node('section', 'modal-card help-card');
    card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true'); card.setAttribute('aria-labelledby', 'help-dialog-title');
    const header = node('header', 'help-head');
    const title = node('h2', '', topic.title); title.id = 'help-dialog-title';
    const done = node('button', 'ghost-btn', 'Close'); done.type = 'button'; done.addEventListener('click', close);
    header.append(title, done);
    const body = node('div', 'help-body');
    body.append(node('p', 'help-intro', topic.intro));
    for (const section of topic.sections) {
      const block = node('section', 'help-section');
      block.append(node('h3', '', section.title));
      if (section.text) block.append(node('p', '', section.text));
      if (section.rows) {
        const list = node('dl', 'help-keys');
        for (const [keys, description] of section.rows) { const row = node('div', 'help-key'); row.append(node('dt', '', keys), node('dd', '', description)); list.append(row); }
        block.append(list);
      }
      body.append(block);
    }
    const footer = node('footer', 'help-foot');
    footer.append(node('span', '', 'Included with Husk. Available offline.'));
    const reference = node('button', 'ghost-btn', 'More documentation on GitHub'); reference.type = 'button'; reference.addEventListener('click', openReference); footer.append(reference);
    card.append(header, body, footer); overlay.append(card);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.body.append(overlay);
    document.addEventListener('keydown', key, true);
    done.focus();
  }
  window.HuskHelp = { open, close };
})();
