'use strict';

// E2E fixture standing in for a CLI agent that is not installed here. It
// appends each argv and cwd it was launched with to the capture file, so a test
// can assert the flags Husk passed and the directory it ran in. Appending keeps
// version probes and the launch itself as separate records.

const fs = require('node:fs');
try {
  fs.appendFileSync(process.env.CAPTURE, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\n');
} catch (_) {}
setTimeout(() => process.exit(0), 8000);
