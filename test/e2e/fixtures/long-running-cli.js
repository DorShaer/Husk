'use strict';

// E2E fixture standing in for a long-lived interactive CLI agent. It prints a
// banner, echoes a heartbeat every 2s so idle watchdogs see a live process,
// and never exits on its own. Stdin is consumed and ignored so pasted goals
// and Enter keys do not terminate it.

process.stdin.resume();
process.stdin.on('data', () => {});
console.log('LONG_RUNNING_CLI_READY pid=' + process.pid);
setInterval(() => {
  console.log('heartbeat ' + new Date().toISOString());
}, 2000);
