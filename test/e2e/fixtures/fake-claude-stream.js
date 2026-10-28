#!/usr/bin/env node
'use strict';

// A stand-in for claude in stream-json chat mode, close enough to the real one
// to exercise Husk's claude chat transport end to end: it prints an init line,
// answers the host's initialize handshake, replies to each user message with
// streamed text and a result, and STAYS ALIVE across turns (and so across a
// renderer reload, which is the whole point of the reload reproduction).

const fs = require('fs');
const args = process.argv.slice(2);
try { if (process.env.CAPTURE) fs.appendFileSync(process.env.CAPTURE, JSON.stringify({ argv: args }) + '\n'); } catch (_) {}

if (args[0] === 'auth' && args[1] === 'status') { process.stdout.write(JSON.stringify({ loggedIn: true, email: 'tester@example.com', subscriptionType: 'max' })); process.exit(0); }
if (args[0] === 'agents') { process.stdout.write('[]'); process.exit(0); }
if (!args.includes('--input-format')) { process.stdout.write('{}'); process.exit(0); }

const sidIdx = args.indexOf('--session-id');
const sessionId = sidIdx >= 0 ? args[sidIdx + 1] : '00000000-0000-4000-8000-000000000000';
const say = (o) => { try { process.stdout.write(JSON.stringify(o) + '\n'); } catch (_) {} };

say({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-test', slash_commands: ['model', 'help'] });

let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch (_) { continue; }
    if (msg.type === 'control_request' && msg.request && msg.request.subtype === 'initialize') {
      say({ type: 'control_response', response: { request_id: msg.request_id, subtype: 'success', response: {} } });
      continue;
    }
    if (msg.type === 'user') {
      const content = msg.message && msg.message.content;
      const text = typeof content === 'string' ? content : Array.isArray(content) ? (content.find((b) => b.type === 'text') || {}).text || '' : '';
      say({ type: 'assistant', message: { model: 'claude-test', content: [{ type: 'text', text: `Echo: ${text}` }] } });
      say({ type: 'result', subtype: 'success', result: `Echo: ${text}`, usage: { input_tokens: 5, output_tokens: 5 } });
    }
  }
});
process.stdin.resume();
setInterval(() => {}, 1 << 30);
