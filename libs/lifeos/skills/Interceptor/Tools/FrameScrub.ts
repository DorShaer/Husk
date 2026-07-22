#!/usr/bin/env bun
/**
 * FrameScrub — the video-verification core mechanism.
 *
 * ScrubFlow records a web flow to <flow>.webm (MediaRecorder on the extension's
 * existing tab MediaStream — screencapture is banned in Interceptor). FrameScrub
 * turns that recording into VIEWABLE evidence in two modes:
 *
 *   survey  — N evenly-spaced frames across the whole clip (overview / gallery).
 *   scrub   — dense frames at F fps in a ±window around a suspect timestamp,
 *             with a per-frame SSIM-to-previous score so sub-second motion
 *             (a stuttering fade, a dropped transition, a flicker) is flagged
 *             NUMERICALLY, not left to the model eyeballing near-identical PNGs.
 *
 * The manifest — frames + timestamps + change scores — is the artifact the
 * verify step consumes and the gate keys on (not the raw video path).
 *
 * Usage:
 *   bun FrameScrub.ts <video> survey [--frames N]
 *   bun FrameScrub.ts <video> scrub  --at <sec> [--window <sec>] [--fps <n>]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";

function arg(flag: string, dflt: string): string {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
function sh(bin: string, args: string[]): string {
  return execFileSync(bin, args, { encoding: "utf8" });
}

const video = process.argv[2];
const mode = (process.argv[3] || "survey").replace(/^--/, "");
if (!video || video.startsWith("--")) {
  console.error("usage: bun FrameScrub.ts <video> <survey|scrub> [...]");
  process.exit(1);
}

const duration = parseFloat(
  sh("ffprobe", ["-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", video]).trim()
);
if (!isFinite(duration) || duration <= 0) { console.error(`bad duration: ${video}`); process.exit(1); }

const outDir = arg("--out", join("frames", `${basename(video).replace(/\.[^.]+$/, "")}-${mode}`));
mkdirSync(outDir, { recursive: true });

// Build the list of sample timestamps for the chosen mode.
let stamps: number[];
if (mode === "scrub") {
  const at = parseFloat(arg("--at", String(duration / 2)));
  const window = parseFloat(arg("--window", "1.5"));
  const fps = parseFloat(arg("--fps", "8"));
  const start = Math.max(0, at - window / 2);
  const end = Math.min(duration, at + window / 2);
  const n = Math.max(2, Math.round((end - start) * fps));
  stamps = Array.from({ length: n }, (_, i) => start + (i * (end - start)) / (n - 1));
} else {
  const frames = Math.max(1, parseInt(arg("--frames", "8"), 10));
  stamps = Array.from({ length: frames }, (_, i) => (duration * (i + 0.5)) / frames);
}

// Extract each frame.
const paths = stamps.map((ts, i) => {
  const p = join(outDir, `frame_${String(i).padStart(3, "0")}.png`);
  sh("ffmpeg", ["-y", "-loglevel", "error", "-ss", ts.toFixed(3), "-i", video,
    "-frames:v", "1", "-vf", "scale=640:-1", p]);
  return p;
});

// SSIM between consecutive frames → change score (1.0 = identical, lower = more motion).
function ssimPrev(a: string, b: string): number | null {
  // ffmpeg prints the SSIM line to STDERR — spawnSync captures both streams.
  const r = spawnSync("ffmpeg", ["-i", a, "-i", b, "-lavfi", "ssim", "-f", "null", "-"], { encoding: "utf8" });
  const m = (r.stderr || "").match(/All:([0-9.]+)/);
  return m ? Number(parseFloat(m[1]).toFixed(4)) : null;
}

const extracted = paths.map((path, i) => ({
  frame: i,
  path,
  timestamp_s: Number(stamps[i].toFixed(3)),
  ssim_to_prev: i === 0 ? null : ssimPrev(paths[i - 1], path),
}));

// Flag the biggest inter-frame change (the candidate motion anomaly).
let flagged: number | null = null, lowest = 1.1;
for (const f of extracted) if (f.ssim_to_prev !== null && f.ssim_to_prev < lowest) { lowest = f.ssim_to_prev; flagged = f.frame; }

const manifest = { video, mode, duration_s: Number(duration.toFixed(3)),
  frame_count: extracted.length, flagged_frame: flagged, min_ssim: flagged === null ? null : lowest, extracted };
const manifestPath = join(outDir, "manifest.json");
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`[${mode}] ${extracted.length} frames from ${video} → ${outDir}`);
if (mode === "scrub") console.log(`biggest change at frame ${flagged} (SSIM ${lowest.toFixed(4)}) — the model looks HERE first`);
console.log(`manifest: ${manifestPath}`);
