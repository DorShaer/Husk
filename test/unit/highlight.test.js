'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { highlight, highlightLines, escapeHtml } = require('../../src/lib/highlight');

// Count occurrences of a substring (non-overlapping).
function count(haystack, needle) {
  if (needle.length === 0) return 0;
  let n = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

test('escapeHtml: escapes the HTML-significant characters', () => {
  assert.equal(escapeHtml('<a href="x">& \'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp; &#39;&lt;/a&gt;');
});

// The safety property is that no raw < or > from input survives to output.
// The tokenizer may split '<script>' across token spans (e.g. '<' as an
// operator), so the escaped substring need not be contiguous; what matters is
// that no literal tag and no raw angle bracket outside a span attribute leaks.
function stripSpanMarkup(html) {
  // Remove the span tags we intentionally emit, leaving only escaped content.
  return html.replace(/<\/?span[^>]*>/g, '');
}
test('highlight XSS: input tags are entity-escaped, never emitted raw', () => {
  const out = highlight('<script>alert(1)</script>', 'javascript');
  assert.ok(!out.includes('<script>'), 'must not contain a literal <script>');
  assert.ok(!out.includes('</script>'), 'must not contain a literal </script>');
  const content = stripSpanMarkup(out);
  assert.ok(!content.includes('<') && !content.includes('>'), 'no raw angle bracket outside span markup');
  assert.ok(content.includes('&lt;') && content.includes('&gt;'), 'angle brackets entity-encoded');
});

test('highlight XSS: escaping holds across every supported language', () => {
  const payload = '<script>alert(1)</script>';
  for (const lang of ['javascript', 'typescript', 'json', 'css', 'html', 'markdown', 'python', 'shell', 'go']) {
    const out = highlight(payload, lang);
    assert.ok(!out.includes('<script>'), `${lang} leaked a raw <script>`);
    const content = stripSpanMarkup(out);
    assert.ok(!content.includes('<script'), `${lang} leaked a raw tag outside markup`);
    assert.ok(content.includes('&lt;'), `${lang} did not escape the tag`);
  }
});

test('highlight: keywords get tok-keyword spans in javascript', () => {
  const out = highlight('const x = 1;', 'javascript');
  assert.ok(out.includes('<span class="tok-keyword">const</span>'), out);
});

test('highlight: strings get tok-string spans', () => {
  const out = highlight('const s = "hello";', 'javascript');
  assert.ok(out.includes('<span class="tok-string">&quot;hello&quot;</span>'), out);
});

test('highlight: comments get tok-comment spans', () => {
  const line = highlight('// a comment', 'javascript');
  assert.ok(line.includes('<span class="tok-comment">// a comment</span>'), line);
  const block = highlight('/* block */', 'javascript');
  assert.ok(block.includes('<span class="tok-comment">/* block */</span>'), block);
});

test('highlight: numbers get tok-number spans', () => {
  const out = highlight('const n = 42;', 'javascript');
  assert.ok(out.includes('<span class="tok-number">42</span>'), out);
});

test("highlight: 'text' lang returns escaped-only output with no spans", () => {
  const out = highlight('const x = 1; // <b>', 'text');
  assert.ok(!out.includes('<span'), 'text output must contain no spans');
  assert.ok(out.includes('&lt;b&gt;'), 'text output must still be escaped');
  assert.equal(out, escapeHtml('const x = 1; // <b>'));
});

test('highlight: unsupported lang falls back to escaped-only, no spans', () => {
  const out = highlight('SELECT * FROM t', 'sql');
  assert.ok(!out.includes('<span'));
  assert.equal(out, escapeHtml('SELECT * FROM t'));
});

test('highlight: newlines are preserved exactly', () => {
  const code = 'const a = 1;\nconst b = 2;\n\nconst c = 3;';
  const expected = count(code, '\n');
  assert.equal(count(highlight(code, 'javascript'), '\n'), expected);
  assert.equal(count(highlight(code, 'text'), '\n'), expected);
});

test('highlightLines: one balanced, self-contained line per source line', () => {
  const lines = highlightLines('/* a\nb */\nconst x = 1;', 'javascript');
  assert.equal(lines.length, 3);
  // Each line must have balanced span tags (open count == close count).
  for (const l of lines) {
    const opens = count(l, '<span');
    const closes = count(l, '</span>');
    assert.equal(opens, closes, `unbalanced spans in line: ${l}`);
  }
  // The block comment keeps its color across the wrap.
  assert.ok(lines[0].includes('tok-comment'), lines[0]);
  assert.ok(lines[1].includes('tok-comment'), lines[1]);
});

test('highlightLines: XSS-safe per line', () => {
  const lines = highlightLines('<img src=x onerror=alert(1)>\n<b>', 'html');
  for (const l of lines) {
    assert.ok(!l.includes('<img'), 'raw <img leaked');
    assert.ok(!/<b>(?!.*tok)/.test(l.replace(/<\/?span[^>]*>/g, '')), 'raw tag leaked');
  }
  assert.ok(lines.join('').includes('&lt;'), 'angle brackets escaped');
});

test('highlightLines: text lang returns escaped plain lines', () => {
  const lines = highlightLines('a < b\nc & d', 'text');
  assert.deepEqual(lines, ['a &lt; b', 'c &amp; d']);
});
