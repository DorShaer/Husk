'use strict';

// Preflight for the packaging scripts.
//
// electron-builder 26 pulls in @noble/hashes 2.x, which is pure ESM, and loads
// it with require(). That only works on a Node with require(esm) support:
// 22.12+, backported to 20.19. Below that the build dies deep inside
// app-builder-lib with
//
//   Error [ERR_REQUIRE_ESM]: require() of ES Module .../blake2.js
//
// which says nothing about the actual cause. package.json already declares the
// floor in "engines", but npm only warns unless engine-strict is set, so the
// declaration alone does not stop anyone. This turns the stack trace into one
// sentence naming the version you have and the version you need.

const REQUIRED = require('../package.json').engines.node.replace(/^[^\d]*/, '');

function parse(v) {
  return String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
}

function lower(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

const have = parse(process.versions.node);
const need = parse(REQUIRED);

if (lower(have, need)) {
  const msg = [
    '',
    `  Packaging needs Node >= ${need.join('.')}, this is ${have.join('.')}.`,
    '',
    '  electron-builder loads an ESM-only dependency with require(), which',
    '  needs require(esm) support: Node 22.12+, or 20.19+ on the 20 line.',
    '  On an older Node the build fails inside app-builder-lib with an',
    '  ERR_REQUIRE_ESM trace that does not mention the version.',
    '',
    '    nvm use 22        # or any Node at or above the floor above',
    '',
  ].join('\n');
  process.stderr.write(msg);
  process.exit(1);
}
