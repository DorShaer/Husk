#!/usr/bin/env bun
/**
 * KVSync.hook.ts — Push work.json to Cloudflare KV at session boundaries
 *
 * TRIGGER: SessionStart, SessionEnd
 *
 * Ensures KV always has fresh work.json data regardless of whether ISASync
 * fires during the session. Prevents the recurring "activity page empty"
 * issue caused by KV going stale between sessions.
 */

import { readFileSync } from 'fs';
import { pushStateToTargets, pushEventsToTargets } from './lib/observability-transport';

// Read stdin (required by hook protocol) but we don't need the input
try { readFileSync(0, 'utf-8'); } catch {}

Promise.all([pushStateToTargets(), pushEventsToTargets()])
  .catch((err) => console.error(`[KVSync] Fatal: ${err.message}`))
  .finally(() => {
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  });
