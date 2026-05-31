'use strict';

// E2E fixture standing in for a CLI agent (codex / aider, which are not
// installed here). It records the argv it was launched with and its cwd, so
// the test can assert Husk passed the right flags and ran in the right dir.

const fs = require('node:fs');
try {
  fs.writeFileSync(process.env.CAPTURE, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
} catch (_) {}
setTimeout(() => process.exit(0), 8000);
