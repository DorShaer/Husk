#!/usr/bin/env bun
/**
 * Conduit launchd installer. Registers `com.lifeos.conduit` to run `conduit capture`
 * on a fixed interval — the stable pattern (stateless one-shot polls restarted by
 * launchd, no long-lived daemon). Mirrors InstallWorkSweep / InstallDerivedSync.
 *
 *   bun InstallConduit.ts            install + load
 *   bun InstallConduit.ts --uninstall  unload + remove
 *   bun InstallConduit.ts --status     show launchd state
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "./config.ts"
import { DATA_ROOT } from "./paths.ts"

const LABEL = "com.lifeos.conduit"
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`)
const CONDUIT = join(import.meta.dir, "conduit.ts")
const LOG_DIR = join(DATA_ROOT, "logs")
const BUN = process.execPath // the bun binary currently running

/** Escape a string for safe interpolation into a plist XML <string> value. */
function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function plistBody(intervalSec: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(BUN)}</string>
    <string>${escapeXml(CONDUIT)}</string>
    <string>capture</string>
  </array>
  <key>StartInterval</key><integer>${intervalSec}</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>Nice</key><integer>10</integer>
  <key>StandardOutPath</key><string>${escapeXml(join(LOG_DIR, "conduit.out.log"))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(join(LOG_DIR, "conduit.err.log"))}</string>
</dict>
</plist>
`
}

function install(): void {
  mkdirSync(LOG_DIR, { recursive: true })
  const intervalSec = loadConfig().pollIntervalSec
  writeFileSync(PLIST, plistBody(intervalSec))
  try {
    execFileSync("launchctl", ["unload", PLIST], { stdio: "ignore" })
  } catch {
    /* not loaded yet */
  }
  execFileSync("launchctl", ["load", PLIST], { stdio: "inherit" })
  console.log(`Installed ${LABEL} → polls every ${intervalSec}s`)
  console.log(`  plist: ${PLIST}`)
  console.log(`  logs:  ${LOG_DIR}`)
}

function uninstall(): void {
  try {
    execFileSync("launchctl", ["unload", PLIST], { stdio: "ignore" })
  } catch {
    /* ignore */
  }
  if (existsSync(PLIST)) rmSync(PLIST)
  console.log(`Uninstalled ${LABEL}`)
}

function status(): void {
  try {
    const out = execFileSync("launchctl", ["list"], { encoding: "utf8" })
    const line = out.split("\n").find((l) => l.includes(LABEL))
    console.log(line ? `loaded: ${line.trim()}` : `${LABEL} not loaded`)
  } catch {
    console.log("launchctl unavailable")
  }
}

const arg = process.argv[2]
if (arg === "--uninstall") uninstall()
else if (arg === "--status") status()
else install()
