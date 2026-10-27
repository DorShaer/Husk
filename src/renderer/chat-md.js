// Husk chat markdown renderer.
//
// Agent text is untrusted, so nothing here ever goes through innerHTML: every
// node is built with createElement and every run of text lands as a text node.
// The renderer is a pure function of its input, which is what lets the chat
// pane re-render a streaming block on every frame and get the same DOM for the
// same prefix. An unclosed fence renders as code to the end of the text, so a
// block mid-stream does not flicker between prose and code.
(function () {
  'use strict';

  let linkHandler = null;

  function safeHref(href) {
    const h = String(href || '').trim();
    return /^https?:\/\/[^\s]+$/i.test(h) ? h : null;
  }

  // Only http(s) ever leaves the app. The host page installs a handler that
  // confirms the destination first; without one the same guard still holds.
  function openLink(href) {
    const h = safeHref(href);
    if (!h) return;
    if (typeof linkHandler === 'function') { try { linkHandler(h); } catch (_) {} return; }
    try { window.husk.urls.openExternal(h); } catch (_) {}
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function link(href, parent) {
    const a = el('a', 'cmd-link');
    a.dataset.href = href;
    a.title = href;
    a.setAttribute('role', 'link');
    a.tabIndex = 0;
    const go = (e) => { e.preventDefault(); e.stopPropagation(); openLink(href); };
    a.addEventListener('click', go);
    a.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(e); });
    parent.appendChild(a);
    return a;
  }

  // ─── inline ────────────────────────────────────────────────────────────────

  // One level of balanced parentheses inside the URL, as in wiki links.
  const RE_LINK = /\[([^\]\n]*)\]\(\s*((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"\n]*")?\s*\)/y;
  const RE_AUTO = /https?:\/\/[^\s<>()\[\]]+/y;
  const ESCAPABLE = '\\`*_{}[]()#+-.!|~>';

  function isWordChar(c) { return !!c && /[\p{L}\p{N}]/u.test(c); }

  // Walks the text once. Each special character either opens a construct whose
  // closing delimiter is found, or falls through as plain text, so malformed
  // markup degrades to its literal characters rather than swallowing the rest.
  function inline(text, parent, depth) {
    const s = String(text || '');
    let buf = '';
    const flush = () => { if (buf) { parent.appendChild(document.createTextNode(buf)); buf = ''; } };
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '\\' && i + 1 < s.length && ESCAPABLE.includes(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
      if (c === '`') {
        let n = 1; while (s[i + n] === '`') n++;
        const fence = '`'.repeat(n);
        const end = s.indexOf(fence, i + n);
        if (end !== -1 && end > i + n) {
          flush();
          let code = s.slice(i + n, end);
          if (/^ .* $/.test(code)) code = code.slice(1, -1);
          parent.appendChild(el('code', 'cmd-code', code));
          i = end + n;
          continue;
        }
        buf += fence; i += n; continue;
      }
      if (c === '[' && depth < 3) {
        RE_LINK.lastIndex = i;
        const m = RE_LINK.exec(s);
        if (m) {
          const href = safeHref(m[2]);
          flush();
          if (href) inline(m[1] || href, link(href, parent), depth + 1);
          else inline(m[1], parent, depth + 1);
          i = RE_LINK.lastIndex;
          continue;
        }
      }
      if ((c === 'h' || c === 'H') && !isWordChar(s[i - 1]) && depth < 3) {
        RE_AUTO.lastIndex = i;
        const m = RE_AUTO.exec(s);
        if (m) {
          // Sentence punctuation after a bare URL belongs to the sentence.
          const url = m[0].replace(/[.,;:!?'"]+$/, '');
          const href = safeHref(url);
          if (href) {
            flush();
            link(href, parent).textContent = url;
            i += url.length;
            continue;
          }
        }
      }
      if ((c === '*' || c === '_' || c === '~') && depth < 6) {
        const two = s[i + 1] === c;
        if (c === '~' && !two) { buf += c; i++; continue; }
        const delim = two ? c + c : c;
        const start = i + delim.length;
        // Underscore emphasis only at word edges, so snake_case stays literal.
        const leftOk = c !== '_' || !isWordChar(s[i - 1]);
        if (leftOk && s[start] && s[start] !== ' ' && s[start] !== c) {
          let end = s.indexOf(delim, start + 1);
          while (end !== -1 && (s[end - 1] === ' ' || (!two && s[end + 1] === c) || (c === '_' && isWordChar(s[end + delim.length])))) {
            end = s.indexOf(delim, end + 1);
          }
          if (end !== -1 && !s.slice(start, end).includes('\n\n')) {
            flush();
            const tag = c === '~' ? 'del' : (two ? 'strong' : 'em');
            const node = el(tag);
            inline(s.slice(start, end), node, depth + 1);
            parent.appendChild(node);
            i = end + delim.length;
            continue;
          }
        }
        buf += delim; i += delim.length; continue;
      }
      if (c === '\n') {
        // Two trailing spaces mark a hard break; any other newline is a soft wrap.
        if (buf.endsWith('  ')) { buf = buf.replace(/ +$/, ''); flush(); parent.appendChild(el('br')); }
        else buf += ' ';
        i++;
        continue;
      }
      buf += c; i++;
    }
    flush();
  }

  // ─── blocks ────────────────────────────────────────────────────────────────

  const RE_FENCE = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)?.*$/;
  const RE_HEAD = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  const RE_HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
  const RE_QUOTE = /^ {0,3}>\s?(.*)$/;
  const RE_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const RE_TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

  function isBlockStart(line, next) {
    return RE_FENCE.test(line) || RE_HEAD.test(line) || RE_HR.test(line) || RE_QUOTE.test(line)
      || RE_ITEM.test(line) || (line.includes('|') && next !== undefined && RE_TABLE_SEP.test(next) && next.includes('-'));
  }

  function splitRow(line) {
    let t = line.trim();
    if (t.startsWith('|')) t = t.slice(1);
    if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
    const cells = [];
    let cur = '';
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '\\' && t[i + 1] === '|') { cur += '|'; i++; continue; }
      if (t[i] === '|') { cells.push(cur.trim()); cur = ''; continue; }
      cur += t[i];
    }
    cells.push(cur.trim());
    return cells;
  }

  function copyText(text, btn) {
    const done = () => {
      btn.textContent = 'Copied';
      btn.classList.add('is-done');
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('is-done'); }, 1200);
    };
    try {
      const p = navigator.clipboard && navigator.clipboard.writeText(text);
      if (p && typeof p.then === 'function') p.then(done, () => {}); else done();
    } catch (_) {}
  }

  function codeBlock(lang, code, parent) {
    const wrap = el('div', 'cmd-pre');
    const head = el('div', 'cmd-pre-head');
    head.appendChild(el('span', 'cmd-pre-lang', lang || 'text'));
    const btn = el('button', 'cmd-pre-copy', 'Copy');
    btn.type = 'button';
    btn.addEventListener('click', (e) => { e.stopPropagation(); copyText(code, btn); });
    head.appendChild(btn);
    wrap.appendChild(head);
    const pre = el('pre');
    pre.appendChild(el('code', lang ? 'lang-' + lang.replace(/[^\w+#-]/g, '') : '', code));
    wrap.appendChild(pre);
    parent.appendChild(wrap);
  }

  // Parses a list starting at lines[i] whose markers sit at `indent`. Deeper
  // markers open a nested list inside the current item; continuation lines
  // join the item's text. Returns the index after the list.
  function parseList(lines, i, indent, parent) {
    const first = RE_ITEM.exec(lines[i]);
    const ordered = /\d/.test(first[2]);
    const list = el(ordered ? 'ol' : 'ul', 'cmd-list');
    if (ordered) { const n = parseInt(first[2], 10); if (n !== 1) list.start = n; }
    parent.appendChild(list);
    let li = null;
    let textParts = [];
    // An item's own text goes first; text that follows a nested list lands
    // after it, in the order it was written.
    const closeItem = () => {
      if (!li || !textParts.length) return;
      let body = textParts.join('\n');
      textParts = [];
      const holder = el('span', 'cmd-li-text');
      const firstText = !li.firstChild;
      const task = firstText ? /^\[([ xX])\]\s+/.exec(body) : null;
      if (task) {
        li.classList.add('cmd-task');
        if (task[1] !== ' ') li.classList.add('is-checked');
        li.appendChild(el('span', 'cmd-task-box'));
        body = body.slice(task[0].length);
      }
      inline(body, holder, 0);
      li.appendChild(holder);
    };
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        // A blank line ends the list unless the list carries on after it.
        let j = i + 1; while (j < lines.length && !lines[j].trim()) j++;
        const m = j < lines.length ? RE_ITEM.exec(lines[j]) : null;
        if (m && m[1].length >= indent) { i = j; continue; }
        break;
      }
      const m = RE_ITEM.exec(line);
      if (m) {
        const ind = m[1].length;
        if (ind < indent) break;
        if (ind > indent + 1 && li) {
          closeItem();
          i = parseList(lines, i, ind, li);
          continue;
        }
        if (/\d/.test(m[2]) !== ordered) break;
        closeItem();
        li = el('li');
        list.appendChild(li);
        textParts = [m[3]];
        i++;
        continue;
      }
      if (/^\s/.test(line) || !isBlockStart(line, lines[i + 1])) {
        if (!li) break;
        if (RE_FENCE.test(line.trim())) break;
        textParts.push(line.trim());
        i++;
        continue;
      }
      break;
    }
    closeItem();
    return i;
  }

  function blocks(text, parent, depth) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      let m = RE_FENCE.exec(line);
      if (m) {
        const pad = m[1].length;
        const fence = m[2];
        const body = [];
        i++;
        while (i < lines.length) {
          const t = lines[i].trim();
          if (t.startsWith(fence) && t.split('').every((ch) => ch === fence[0])) { i++; break; }
          // A fence indented under a list item indents its body the same way.
          body.push(pad ? lines[i].replace(new RegExp('^ {0,' + pad + '}'), '') : lines[i]);
          i++;
        }
        codeBlock(m[3] || '', body.join('\n'), parent);
        continue;
      }
      m = RE_HEAD.exec(line);
      if (m) {
        const level = Math.min(m[1].length, 3);
        const h = el('h' + (level + 2), 'cmd-h cmd-h' + level);
        inline(m[2], h, 0);
        parent.appendChild(h);
        i++;
        continue;
      }
      if (RE_HR.test(line)) { parent.appendChild(el('hr', 'cmd-hr')); i++; continue; }
      if (RE_QUOTE.test(line)) {
        const body = [];
        while (i < lines.length && (m = RE_QUOTE.exec(lines[i]))) { body.push(m[1]); i++; }
        const q = el('blockquote', 'cmd-quote');
        if (depth < 4) blocks(body.join('\n'), q, depth + 1); else inline(body.join('\n'), q, 0);
        parent.appendChild(q);
        continue;
      }
      m = RE_ITEM.exec(line);
      if (m) { i = parseList(lines, i, m[1].length, parent); continue; }
      if (line.includes('|') && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        const head = splitRow(line);
        const aligns = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : (/-:$/.test(c) ? 'right' : '')));
        i += 2;
        const wrap = el('div', 'cmd-table-wrap');
        const table = el('table', 'cmd-table');
        const thead = el('thead');
        const htr = el('tr');
        head.forEach((cell, k) => { const th = el('th'); if (aligns[k]) th.style.textAlign = aligns[k]; inline(cell, th, 0); htr.appendChild(th); });
        thead.appendChild(htr);
        table.appendChild(thead);
        const tbody = el('tbody');
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
          const cells = splitRow(lines[i]);
          const tr = el('tr');
          for (let k = 0; k < head.length; k++) {
            const td = el('td');
            if (aligns[k]) td.style.textAlign = aligns[k];
            inline(cells[k] || '', td, 0);
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
          i++;
        }
        table.appendChild(tbody);
        wrap.appendChild(table);
        parent.appendChild(wrap);
        continue;
      }
      const para = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i], lines[i + 1])) { para.push(lines[i]); i++; }
      const p = el('p', 'cmd-p');
      inline(para.join('\n'), p, 0);
      parent.appendChild(p);
    }
  }

  function render(text) {
    const frag = document.createDocumentFragment();
    blocks(text, frag, 0);
    return frag;
  }

  window.HuskChatMd = {
    render,
    renderInline(text) { const f = document.createDocumentFragment(); inline(text, f, 0); return f; },
    setLinkHandler(fn) { linkHandler = typeof fn === 'function' ? fn : null; },
    safeHref,
  };
})();
