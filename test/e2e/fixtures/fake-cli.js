'use strict';

// E2E fixture standing in for a CLI agent (codex / aider, which are not
// installed here). It records every argv it was launched with and its cwd, so
// the test can assert Husk passed the right flags and ran in the right dir.
// Status-panel version probes may invoke the same fake binary with --version;
// append-only capture keeps those probes from clobbering the actual launch.

const fs = require('node:fs');
try {
  fs.appendFileSync(process.env.CAPTURE, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\n');
} catch (_) {}
setTimeout(() => process.exit(0), 8000);
