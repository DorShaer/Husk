'use strict';

// Newline-delimited JSON framing for a child process's stdio. Both the Agent
// Client Protocol (JSON-RPC 2.0) and claude's stream-json mode write one JSON
// document per line, so one framer serves both transports.
//
// createFramer(onMessage, onParseError) returns { push, flush }. push takes
// a chunk (Buffer or string) that may hold part of a line, several lines, or
// a line split across chunks. Each complete line is parsed and handed to
// onMessage. A line that is not JSON goes to onParseError with the raw text
// and never throws, since an agent's stray stderr-ish print must not take the
// chat down. flush parses whatever is left without a trailing newline (used
// at child exit).
function createFramer(onMessage, onParseError) {
  let buf = '';
  const emit = typeof onMessage === 'function' ? onMessage : () => {};
  const fail = typeof onParseError === 'function' ? onParseError : () => {};

  function handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch (_) {
      fail(trimmed);
      return;
    }
    emit(msg);
  }

  function push(chunk) {
    buf += typeof chunk === 'string' ? chunk : String(chunk || '');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      handleLine(line);
    }
  }

  function flush() {
    const rest = buf;
    buf = '';
    if (rest.trim()) handleLine(rest);
  }

  return { push, flush };
}

// encodeLine serializes one message as a newline-terminated JSON line.
function encodeLine(msg) {
  return JSON.stringify(msg) + '\n';
}

module.exports = { createFramer, encodeLine };
