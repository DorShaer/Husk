'use strict';

// Minimal OpenAI-compatible chat client for Husk's native-chat BYOK path. It
// posts /chat/completions with stream:true and translates the SSE deltas into
// the same claude stream-json event shapes the chat reducer already renders, so
// nothing downstream needs to know the reply came from OpenAI or Ollama.

const https = require('https');
const http = require('http');
const { URL } = require('url');

function pick(baseUrl) {
  const u = new URL(String(baseUrl || '').replace(/\/+$/, '') + '/placeholder');
  return u.protocol === 'http:' ? http : https;
}
function endpoint(baseUrl, path) {
  return new URL(String(baseUrl || '').replace(/\/+$/, '') + path);
}

// openaiModels lists the endpoint's models for the picker. Ollama's native API
// lives at /api/tags; the OpenAI-compatible one at /v1/models. Callers pass the
// /v1 base, so try that and fall back to /api/tags off the host root.
function openaiModels({ baseUrl, apiKey }, done) {
  const url = endpoint(baseUrl, '/models');
  const mod = url.protocol === 'http:' ? http : https;
  const req = mod.request(url, { method: 'GET', headers: apiKey ? { Authorization: 'Bearer ' + apiKey } : {} }, (res) => {
    let raw = '';
    res.on('data', (d) => { raw += d; });
    res.on('end', () => {
      if (res.statusCode >= 400) return done(new Error('HTTP ' + res.statusCode));
      try {
        const j = JSON.parse(raw);
        const list = Array.isArray(j.data) ? j.data.map((m) => String(m && m.id)).filter(Boolean)
          : Array.isArray(j.models) ? j.models.map((m) => String(m && m.name)).filter(Boolean) : [];
        done(null, list);
      } catch (e) { done(e); }
    });
  });
  req.on('error', done);
  req.end();
}

// openaiTurn streams one assistant turn. messages is the OpenAI chat array.
// emit is called with claude-shaped events; done(err, { text }) ends the turn.
function openaiTurn({ baseUrl, apiKey, model, messages, signal }, emit, done) {
  const url = endpoint(baseUrl, '/chat/completions');
  const mod = url.protocol === 'http:' ? http : https;
  const body = JSON.stringify({ model, messages, stream: true, max_completion_tokens: 8192 });
  const mid = 'msg_' + Date.now().toString(36);
  let finished = false;
  const finish = (err, text) => { if (finished) return; finished = true; done(err, { text: text || '' }); };
  const req = mod.request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + String(apiKey || ''),
      Accept: 'text/event-stream',
      'Content-Length': Buffer.byteLength(body),
    },
  }, (res) => {
    if (res.statusCode >= 400) {
      let e = '';
      res.on('data', (d) => { e += d; });
      res.on('end', () => {
        let msg = e.slice(0, 400);
        try { const j = JSON.parse(e); if (j && j.error && j.error.message) msg = j.error.message; } catch (_) {}
        finish(new Error('HTTP ' + res.statusCode + ': ' + msg));
      });
      return;
    }
    emit({ type: 'stream_event', event: { type: 'message_start', message: { id: mid, type: 'message', role: 'assistant', model, content: [], stop_reason: null } } });
    emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
    let buf = '';
    let full = '';
    res.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let j;
        try { j = JSON.parse(data); } catch (_) { continue; }
        const delta = j.choices && j.choices[0] && j.choices[0].delta;
        const txt = delta && typeof delta.content === 'string' ? delta.content : '';
        if (txt) {
          full += txt;
          emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: txt } } });
        }
      }
    });
    res.on('end', () => {
      emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
      emit({ type: 'assistant', message: { id: mid, role: 'assistant', model, content: [{ type: 'text', text: full }], stop_reason: 'end_turn' } });
      emit({ type: 'stream_event', event: { type: 'message_stop' } });
      finish(null, full);
    });
    res.on('error', (e) => finish(e));
  });
  req.on('error', (e) => finish(e));
  if (signal) {
    if (signal.aborted) { try { req.destroy(); } catch (_) {} }
    else signal.addEventListener('abort', () => { try { req.destroy(); } catch (_) {} finish(null, ''); }, { once: true });
  }
  req.end(body);
}

module.exports = { openaiTurn, openaiModels };
