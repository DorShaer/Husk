#!/usr/bin/env node
'use strict';

// Handshake smoke for each chat CLI: starts it in its protocol mode, sends the
// first request Husk sends, and fails when no well-formed answer arrives. Needs
// no sign-in. Usage: node scripts/handshake-smoke.js [cli ...] (default: all).
// HUSK_SMOKE_MS sets the per-CLI limit.

const { spawn } = require('child_process');
const { createFramer, encodeLine } = require('../src/lib/jsonrpc-stdio');
const { acpArgs, transportFor } = require('../src/lib/chat-transport');
const { claudeChatArgs, encodeInitialize } = require('../src/lib/claude-stream');
const { APP_SERVER_ARGS } = require('../src/lib/codex-app-server');

const LIMIT = Number(process.env.HUSK_SMOKE_MS) || 30000;
const ALL = ['claude', 'copilot', 'gemini', 'codex'];

function plan(cli) {
  const t = transportFor(cli);
  if (t === 'acp') return { args: acpArgs(cli), hello: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'husk-canary', version: '0' } } }, answered: (m) => m.id === 1 && !!m.result };
  if (t === 'codex') return { args: APP_SERVER_ARGS.slice(), hello: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'husk-canary', title: 'Husk canary', version: '0' }, capabilities: { experimentalApi: true } } }, answered: (m) => m.id === 1 && !!m.result };
  if (t === 'claude') return { args: claudeChatArgs(), hello: encodeInitialize('canary'), answered: (m) => m.type === 'control_response' && m.response && m.response.request_id === 'canary' };
  return null;
}

function smoke(cli) {
  const p = plan(cli);
  if (!p) return Promise.resolve({ cli, ok: false, why: 'no chat protocol' });
  return new Promise((resolve) => {
    let stderr = '';
    let done = false;
    const child = spawn(cli, p.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const finish = (ok, why) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch (_) {}
      resolve({ cli, ok, why: ok ? '' : `${why}${stderr.trim() ? `\n  stderr: ${stderr.trim().split('\n').slice(-3).join('\n  ')}` : ''}` });
    };
    const timer = setTimeout(() => finish(false, `no answer within ${LIMIT}ms`), LIMIT);
    const framer = createFramer((m) => { if (p.answered(m)) finish(true); });
    child.stdout.on('data', (d) => framer.push(d));
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.on('error', (e) => finish(false, e.message));
    child.on('close', (code) => finish(false, `exited with ${code} before answering`));
    child.stdin.on('error', () => {});
    child.stdin.write(encodeLine(p.hello));
  });
}

async function main() {
  const clis = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
  let failed = 0;
  for (const cli of clis) {
    const r = await smoke(cli);
    console.log(`${r.ok ? 'PASS' : 'FAIL'} ${cli}${r.ok ? '' : `: ${r.why}`}`);
    if (!r.ok) failed++;
  }
  if (failed) { console.error(`${failed} chat handshake(s) broken`); process.exit(1); }
}

if (require.main === module) main();

module.exports = { smoke };
