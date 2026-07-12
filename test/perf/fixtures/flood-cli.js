'use strict';

// Perf fixture standing in for a very chatty agent CLI. On demand (any stdin
// line) it floods stdout with a burst of output so the harness can measure how
// the renderer's terminal pipeline holds up under sustained write pressure.
// It never exits on its own.

process.stdin.resume();
console.log('FLOOD_CLI_READY pid=' + process.pid);

const LINE = 'x'.repeat(120);
process.stdin.on('data', () => {
  for (let i = 0; i < 5000; i++) {
    process.stdout.write(`${i} ${LINE}\n`);
  }
  process.stdout.write('FLOOD_DONE\n');
});
