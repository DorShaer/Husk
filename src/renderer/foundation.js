'use strict';
(function () {
  const api = window.husk.foundation;
  const byId = (id) => document.getElementById(id);
  const el = (tag, text, cls) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  };
  const reviews = [];
  let reviewing = false;
  async function showReview() {
    if (reviewing || !reviews.length) return;
    reviewing = true;
    const details = reviews.shift();
    const overlay = el('div', undefined, 'modal');
    const card = el('div', undefined, 'modal-card install-review');
    card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-label', 'Review installation');
    card.append(el('h2', 'Review installation'));
    card.append(el('p', `${details.manifest.name} (${details.manifest.kind})`));
    const signed = details.signature;
    card.append(el('p', `Publisher: ${details.manifest.publisher}. Signature: ${signed.state}${signed.publisher ? ` (${signed.publisher})` : ''}`));
    card.append(el('p', 'Declared permissions: ' + (details.manifest.permissions ? JSON.stringify(details.manifest.permissions) : 'Not supplied')));
    const scan = details.scan;
    card.append(el('h3', scan.status === 'unscanned' ? 'Unscanned: review required' : `Scan: ${scan.verdict}`));
    if (scan.reason) card.append(el('p', scan.reason));
    for (const finding of scan.findings) {
      const box = el('details');
      box.append(el('summary', `${finding.severity}: ${finding.title || finding.id}`));
      box.append(el('p', finding.description)); box.append(el('pre', finding.evidence)); box.append(el('p', finding.location));
      card.append(box);
    }
    card.append(el('p', 'Detected capabilities: ' + JSON.stringify(scan.capabilities)));
    const files = el('div', undefined, 'install-review-files');
    for (const file of details.files) {
      const item = el('details'); item.append(el('summary', file.path)); item.append(el('pre', file.text)); files.append(item);
    }
    card.append(files);
    const actions = el('div', undefined, 'modal-actions');
    const close = el('button', scan.verdict === 'block' ? 'Close' : 'Cancel', 'ghost-btn');
    close.type = 'button'; actions.append(close);
    const previous = document.activeElement;
    const finish = async (approved) => {
      overlay.remove(); document.removeEventListener('keydown', key);
      await api.answerReview({ id: details.id, approved });
      previous?.focus(); reviewing = false; showReview();
    };
    const key = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); finish(false); }
      if (event.key === 'Tab') {
        const buttons = [...card.querySelectorAll('button, summary')];
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    close.addEventListener('click', () => finish(false));
    if (scan.verdict !== 'block') {
      const install = el('button', scan.status === 'unscanned' || scan.verdict === 'review' ? 'Install after review' : 'Install', 'btn-primary');
      install.type = 'button'; install.addEventListener('click', () => finish(true)); actions.append(install);
    }
    card.append(actions); overlay.append(card); document.body.append(overlay);
    document.addEventListener('keydown', key); close.focus();
  }
  api.onReview((details) => { reviews.push(details); showReview(); });
  async function refreshItems() {
    const kind = byId('pref-bundle-kind').value;
    const items = await api.bundleItems(kind);
    if (byId('pref-bundle-kind').value !== kind) return;
    const select = byId('pref-bundle-name');
    const previous = select.value;
    select.replaceChildren(...items.map((item) => {
      const option = el('option', item.name);
      option.value = item.id;
      return option;
    }));
    if (!items.length) select.append(el('option', 'No local items available'));
    else if (items.some((item) => item.id === previous)) select.value = previous;
    byId('pref-bundle-export').disabled = !items.length;
  }
  async function refresh() {
    const config = await window.husk.config.get();
    byId('pref-scanner-status').textContent = config.scannerPath || 'No scanner configured';
    await refreshItems();
  }
  const report = async (promise) => {
    try { const result = await promise; if (result?.ok === false) toast(result.error || 'Could not complete that action', 'error'); else if (!result?.canceled) toast('Saved', 'success'); }
    catch (err) { toast(err.message, 'error'); }
    await refresh();
  };
  byId('pref-scanner-choose').addEventListener('click', () => report(api.chooseScanner()));
  byId('pref-scanner-remove').addEventListener('click', () => report(api.removeScanner()));
  byId('pref-bundle-import').addEventListener('click', () => report(api.importBundle()));
  byId('pref-bundle-kind').addEventListener('change', () => refreshItems().catch((err) => toast(err.message, 'error')));
  byId('pref-bundle-export').addEventListener('click', () => report(api.exportBundle({ kind: byId('pref-bundle-kind').value, id: byId('pref-bundle-name').value.trim() })));
  document.querySelector('[data-prefs-section="foundation"]')?.addEventListener('click', refresh);
  refresh().catch((err) => toast(err.message, 'error'));
})();
