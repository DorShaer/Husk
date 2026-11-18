'use strict';

// Shared catalog and presentation for chat, workflow and background-job models.
window.HuskModels = (() => {
  const pending = new Map();
  const bindings = new WeakMap();
  let openMenu = null;
  const text = (value) => value == null ? '' : String(value);
  function rows(items) {
    const seen = new Set();
    return (items || []).map((m) => ({ id: text(m.id || m.value), name: text(m.name || m.label || m.id || m.value), desc: text(m.description || m.desc) }))
      .filter((m) => m.id && !seen.has(m.id) && seen.add(m.id));
  }
  async function load({ command, available = [], current = null, refresh = false } = {}) {
    const live = rows(available);
    if (live.length > 1 && !refresh) return { rows: live, current, sourceLabel: `Listed by ${command}`, models: live.map(m => ({ value: m.id, label: m.name, description: m.desc })) };
    const key = `${command}:${refresh}`;
    if (!pending.has(key)) {
      const request = window.husk.models.list({ command, refresh }).catch(err => ({ models: [], error: err.message || 'Could not load models.' }));
      pending.set(key, request);
      request.finally(() => { if (pending.get(key) === request) pending.delete(key); });
    }
    const catalog = await pending.get(key);
    const merged = rows([...live.map(m => ({ id: m.id, name: m.name, description: m.desc })), ...(catalog.models || [])]);
    return { ...catalog, rows: merged, current };
  }
  function element(tag, cls, content) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (content) node.textContent = content;
    return node;
  }
  function item(model, current, choose) {
    const button = element('button', 'chat-model-item' + (model.id === current ? ' is-current' : ''));
    button.type = 'button';
    button.setAttribute('role', 'menuitemradio');
    button.setAttribute('aria-checked', String(model.id === current));
    button.dataset.model = model.id;
    button.append(element('span', 'chat-model-name', model.name));
    if (model.id !== model.name) button.append(element('span', 'chat-model-id', model.id));
    if (model.desc) button.append(element('span', 'chat-model-desc', model.desc));
    button.addEventListener('click', () => choose(model.id, model.name));
    return button;
  }
  function close(focus = false) {
    if (!openMenu) return;
    const { menu, select } = openMenu;
    openMenu = null;
    menu.remove();
    select.setAttribute('aria-expanded', 'false');
    if (focus && select.isConnected) select.focus();
  }
  async function open(select) {
    const binding = bindings.get(select);
    if (!binding || select.disabled) return;
    if (openMenu?.select === select) { close(true); return; }
    close();
    const command = binding.command();
    const menu = element('div', 'chat-model-menu husk-model-menu');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', select.getAttribute('aria-label') || 'Model');
    const session = { select, menu };
    openMenu = session;
    select.setAttribute('aria-expanded', 'true');
    menu.append(element('div', 'chat-model-note', 'Loading models...'));
    document.body.append(menu);
    const rect = select.getBoundingClientRect();
    const width = Math.min(420, Math.max(300, rect.width), innerWidth - 24);
    menu.style.width = `${width}px`;
    menu.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - width - 12))}px`;
    const below = innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const down = below >= 260 || below >= above;
    menu.style.maxHeight = `${Math.min(380, down ? below - 6 : above - 6)}px`;
    if (down) menu.style.top = `${rect.bottom + 6}px`;
    else menu.style.bottom = `${innerHeight - rect.top + 6}px`;
    const catalog = await load({ command });
    if (openMenu !== session) return;
    if (command !== binding.command() || !select.isConnected) { close(); return; }
    menu.replaceChildren();
    const head = element('div', 'chat-model-head', 'Model');
    head.append(element('span', 'chat-model-source', catalog.sourceLabel || `Listed by ${command}`));
    menu.append(head);
    const choose = (id) => {
      if (![...select.options].some(o => o.value === id)) {
        const option = element('option', '', catalog.rows.find(m => m.id === id)?.name || id);
        option.value = id; select.append(option);
      }
      select.value = id;
      close(true);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const defaultOption = [...select.options].find(o => o.value === '');
    if (defaultOption && !/^(Choose|Loading)/i.test(defaultOption.textContent)) menu.append(item({ id: '', name: defaultOption.textContent, desc: 'Let this CLI or the saved job settings choose the model.' }, select.value, choose));
    for (const model of catalog.rows) menu.append(item(model, select.value, choose));
    if (catalog.error) menu.append(element('div', 'chat-model-note', catalog.error));
    if (!catalog.rows.length && !catalog.error) menu.append(element('div', 'chat-model-note', 'This CLI has not supplied a model list.'));
    const custom = element('form', 'chat-model-custom');
    const input = element('input', 'chat-model-custom-input');
    input.placeholder = 'Other model id...'; input.spellcheck = false; input.setAttribute('aria-label', 'Other model id');
    const use = element('button', 'chat-model-custom-go', 'Use'); use.type = 'submit';
    custom.append(input, use);
    custom.addEventListener('submit', e => { e.preventDefault(); if (input.value.trim()) choose(input.value.trim()); });
    menu.append(custom);
    (menu.querySelector('.is-current') || menu.querySelector('[role="menuitemradio"]'))?.focus({ preventScroll: true });
  }
  function bind(select, command) {
    if (!select) return;
    const first = !bindings.has(select);
    bindings.set(select, { command: typeof command === 'function' ? command : () => command });
    if (!first) return;
    select.setAttribute('aria-haspopup', 'menu');
    select.setAttribute('aria-expanded', 'false');
    select.addEventListener('pointerdown', e => { if (e.button === 0 && !select.disabled) { e.preventDefault(); open(select); } });
    select.addEventListener('keydown', e => {
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key) && !select.disabled) { e.preventDefault(); open(select); }
    });
  }
  document.addEventListener('pointerdown', e => { if (openMenu && !openMenu.menu.contains(e.target) && e.target !== openMenu.select) close(); }, true);
  document.addEventListener('keydown', e => {
    if (!openMenu) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(true); }
    else if (['ArrowDown', 'ArrowUp'].includes(e.key) && openMenu.menu.contains(e.target)) {
      if (e.target.tagName === 'INPUT') return;
      e.preventDefault();
      const buttons = [...openMenu.menu.querySelectorAll('[role="menuitemradio"]')];
      const next = (buttons.indexOf(document.activeElement) + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  }, true);
  document.addEventListener('focusin', e => { if (openMenu && e.target !== openMenu.select && !openMenu.menu.contains(e.target)) close(); });
  document.addEventListener('scroll', e => { if (openMenu && e.target.contains?.(openMenu.select)) close(); }, true);
  window.addEventListener('resize', () => close());
  return { load, rows, item, bind, close };
})();
