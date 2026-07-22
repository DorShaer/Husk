#!/usr/bin/env bun
/**
 * VerifyImageProbe.ts — standalone proof that the degeneracy probe (shared by
 * Capture.sh's guard and VerificationGate's appearance teeth) classifies a blank
 * frame vs real content correctly. Uses single magick spawns (reliable), so it
 * avoids the empty-stdout resource starvation that makes the same assertion flaky
 * inside a large `bun test` suite.
 *
 * Usage: bun VerifyImageProbe.ts <good-image> <blank-image>
 * Exit 0 = probe classifies both correctly; exit 1 = mismatch; exit 2 = bad args.
 */
import { existsSync } from "fs";

const MIN = Number(process.env.INTERCEPTOR_MIN_STDDEV ?? "0.017");

function magickBin(): string | null {
  const w = Bun.which("magick");
  if (w) return w;
  for (const p of ["/opt/homebrew/bin/magick", "/usr/local/bin/magick", "/usr/bin/magick"]) {
    if (existsSync(p)) return p;
  }
  return null;
}

function stddev(path: string): number | null {
  const bin = magickBin();
  if (!bin) return null;
  const r = Bun.spawnSync([bin, path, "-alpha", "off", "-format", "%[fx:standard_deviation]", "info:"]);
  const sd = parseFloat(r.stdout.toString().trim());
  return Number.isFinite(sd) ? sd : null;
}

const [good, blank] = process.argv.slice(2);
if (!good || !blank) {
  console.error("usage: bun VerifyImageProbe.ts <good-image> <blank-image>");
  process.exit(2);
}

const gsd = stddev(good);
const bsd = stddev(blank);
console.log(`threshold=${MIN}`);
console.log(`good  ${good}  std-dev=${gsd}  → ${gsd !== null && gsd >= MIN ? "content ✓" : "REJECT ✗"}`);
console.log(`blank ${blank}  std-dev=${bsd}  → ${bsd !== null && bsd < MIN ? "rejected ✓" : "PASS ✗"}`);

const ok = gsd !== null && gsd >= MIN && bsd !== null && bsd < MIN;
process.exit(ok ? 0 : 1);
