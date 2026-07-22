/**
 * Conduit configuration — lives under USER (config.json). Self-initializing:
 * first read writes defaults so a fresh install is stable with zero setup.
 *
 * Per-source opt-in is a first-class field: privacy is granular by construction.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CONFIG_PATH } from "./paths.ts";

export interface ConduitConfig {
  /** Master switch. When false, capture is a no-op. */
  enabled: boolean;
  /** Seconds between capture polls (launchd StartInterval should match). */
  pollIntervalSec: number;
  /** Per-source opt-in. Disable any source without touching code. */
  sources: {
    appFocus: boolean;
    git: boolean;
    claudeSession: boolean;
  };
  /** Absolute repo paths watched for new commits. Empty by default. */
  repos: string[];
  /** Days of raw event logs retained after rollup. */
  retentionDays: number;
}

export const DEFAULT_CONFIG: ConduitConfig = {
  enabled: true,
  pollIntervalSec: 120,
  sources: { appFocus: true, git: true, claudeSession: true },
  repos: [],
  retentionDays: 30,
};

/**
 * Coerce + clamp a raw (untrusted) config over defaults. Pure. A parseable-but-malformed
 * config (pollIntervalSec 0/negative/"120", negative retention) can otherwise produce
 * NaN/zeroed minutes and an invalid launchd StartInterval — so every field is validated.
 */
export function clampConfig(raw: Partial<ConduitConfig>): ConduitConfig {
  const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    enabled: raw.enabled !== false,
    pollIntervalSec: Math.max(15, Math.floor(num(raw.pollIntervalSec, DEFAULT_CONFIG.pollIntervalSec))),
    sources: {
      appFocus: raw.sources?.appFocus !== false,
      git: raw.sources?.git !== false,
      claudeSession: raw.sources?.claudeSession !== false,
    },
    repos: Array.isArray(raw.repos) ? raw.repos.filter((r) => typeof r === "string") : [],
    retentionDays: Math.max(0, Math.floor(num(raw.retentionDays, DEFAULT_CONFIG.retentionDays))),
  };
}

/** Load config, writing defaults on first run. Never throws — falls back to defaults. */
export function loadConfig(): ConduitConfig {
  try {
    if (!existsSync(CONFIG_PATH)) {
      mkdirSync(dirname(CONFIG_PATH), { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
      return { ...DEFAULT_CONFIG };
    }
    return clampConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
