'use strict';

// E2E fixture standing in for a full-screen agent (like copilot): it turns
// mouse reporting on, then records every byte it receives on stdin to the file
// named by WHEEL_CAPTURE. The wheel-forwarding test drives a wheel over the
// terminal and asserts the SGR scroll sequence lands here.

const fs = require('fs');
const out = process.env.WHEEL_CAPTURE;

// Enable button-event + SGR mouse reporting, like copilot does at startup.
process.stdout.write('\x1b[?1002h\x1b[?1006h ready\r\n');

try { process.stdin.setRawMode(true); } catch (_) {}
process.stdin.resume();
process.stdin.on('data', (d) => { try { fs.appendFileSync(out, d); } catch (_) {} });

setTimeout(() => process.exit(0), 10000);
