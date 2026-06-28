#!/usr/bin/env bun
/**
 * BillingPathAssertion — verify which credential path a `claude -p` run actually used.
 *
 * Anthropic's stream-json event feed exposes two forensic signals that prove,
 * unambiguously, which billing path won the credential precedence chain:
 *
 *   - system/init.apiKeySource:
 *       "none"               -> OAuth subscription (CLAUDE_CODE_OAUTH_TOKEN)
 *       "ANTHROPIC_API_KEY"  -> API-key billing (Console)
 *       (other values exist for managed-key / Bedrock / Vertex paths)
 *
 *   - rate_limit_event.rateLimitType:
 *       "five_hour"          -> Pro/Max 5-hour rolling window  (subscription)
 *       (no event emitted)   -> API key  (RPM/TPM tiers, never emits five_hour)
 *
 * The April 2026 $498 incident happened because PAI lacked a check like this:
 * Pulse heartbeats believed they were billing OAuth while ANTHROPIC_API_KEY in
 * env silently won. This tool catches that class of leak at the FIRST run.
 *
 * Reference: https://github.com/disler/max-your-cc-sub  (engineering walkthrough)
 *            https://code.claude.com/docs/en/authentication#authentication-precedence
 *
 * USAGE
 *
 *   Library:
 *     import { assertBillingPath, parseStreamJson } from "./BillingPathAssertion";
 *     const result = parseStreamJson(stdoutString);
 *     assertBillingPath(result, "oauth");  // throws on mismatch
 *
 *   CLI:
 *     bun PAI/TOOLS/BillingPathAssertion.ts oauth /path/to/events.ndjson
 *     bun PAI/TOOLS/BillingPathAssertion.ts api  /path/to/events.ndjson
 *     # Or pipe stdout from a `claude -p ... --output-format stream-json --verbose` run:
 *     claude -p "ping" --verbose --output-format stream-json | \
 *       bun PAI/TOOLS/BillingPathAssertion.ts oauth -
 *
 *   Exit codes:
 *     0 — actual path matches expected
 *     1 — mismatch (the leak case)
 *     2 — usage error / unparseable input
 */

import { readFileSync } from "fs";

export type BillingPath = "oauth" | "api";

export interface BillingSignals {
  apiKeySource: string | null;
  rateLimitType: string | null;
  /** Detected path inferred from signals; null if neither signal was present. */
  detected: BillingPath | null;
  /** Number of newline-delimited JSON events parsed from input. */
  eventCount: number;
}

const OAUTH_API_KEY_SOURCE = "none";
const API_KEY_API_KEY_SOURCE = "ANTHROPIC_API_KEY";
const SUBSCRIPTION_RATE_LIMIT = "five_hour";

/**
 * Parse the stream-json output of `claude -p ... --output-format stream-json --verbose`
 * and extract the two forensic billing signals.
 */
export function parseStreamJson(stdout: string): BillingSignals {
  let apiKeySource: string | null = null;
  let rateLimitType: string | null = null;
  let eventCount = 0;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    eventCount++;

    if (event?.type === "system" && event?.subtype === "init") {
      if (typeof event.apiKeySource === "string") {
        apiKeySource = event.apiKeySource;
      }
    } else if (event?.type === "rate_limit_event") {
      const info = event.rate_limit_info ?? {};
      if (typeof info.rateLimitType === "string" && rateLimitType === null) {
        rateLimitType = info.rateLimitType;
      }
    }
  }

  let detected: BillingPath | null = null;
  if (apiKeySource === OAUTH_API_KEY_SOURCE) {
    detected = "oauth";
  } else if (apiKeySource === API_KEY_API_KEY_SOURCE) {
    detected = "api";
  } else if (rateLimitType === SUBSCRIPTION_RATE_LIMIT) {
    detected = "oauth";
  }

  return { apiKeySource, rateLimitType, detected, eventCount };
}

export class BillingPathMismatchError extends Error {
  constructor(public expected: BillingPath, public signals: BillingSignals) {
    super(
      `Expected billing path "${expected}" but detected "${signals.detected ?? "unknown"}" ` +
        `(apiKeySource=${JSON.stringify(signals.apiKeySource)}, ` +
        `rateLimitType=${JSON.stringify(signals.rateLimitType)})`
    );
    this.name = "BillingPathMismatchError";
  }
}

/**
 * Assert the actual billing path matches the expected one. Throws on mismatch.
 */
export function assertBillingPath(
  signals: BillingSignals,
  expected: BillingPath
): void {
  if (signals.detected !== expected) {
    throw new BillingPathMismatchError(expected, signals);
  }
}

function readStdinSync(): string {
  const chunks: Buffer[] = [];
  let buf: Buffer;
  try {
    buf = readFileSync(0);
  } catch {
    return "";
  }
  chunks.push(buf);
  return Buffer.concat(chunks).toString("utf-8");
}

function printUsage(): void {
  process.stderr.write(
    [
      "Usage:",
      "  bun PAI/TOOLS/BillingPathAssertion.ts <oauth|api> <path-to-events.ndjson | ->",
      "",
      "  Pass `-` to read stream-json from stdin.",
      "",
      "Exit codes:",
      "  0 — actual path matches expected",
      "  1 — mismatch (subscription leak)",
      "  2 — usage error / unparseable input",
      "",
    ].join("\n")
  );
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    printUsage();
    process.exit(2);
  }

  const expected = args[0];
  if (expected !== "oauth" && expected !== "api") {
    process.stderr.write(`expected must be "oauth" or "api", got "${expected}"\n`);
    process.exit(2);
  }

  const source = args[1];
  let stdout: string;
  if (source === "-") {
    stdout = readStdinSync();
  } else {
    try {
      stdout = readFileSync(source, "utf-8");
    } catch (err: any) {
      process.stderr.write(`failed to read ${source}: ${err?.message ?? err}\n`);
      process.exit(2);
    }
  }

  const signals = parseStreamJson(stdout);
  process.stderr.write(
    `parsed ${signals.eventCount} events: ` +
      `apiKeySource=${JSON.stringify(signals.apiKeySource)}, ` +
      `rateLimitType=${JSON.stringify(signals.rateLimitType)}, ` +
      `detected=${signals.detected ?? "unknown"}\n`
  );

  try {
    assertBillingPath(signals, expected as BillingPath);
    process.stderr.write(`OK — billing path is "${expected}" as expected\n`);
    process.exit(0);
  } catch (err) {
    if (err instanceof BillingPathMismatchError) {
      process.stderr.write(`MISMATCH — ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}
