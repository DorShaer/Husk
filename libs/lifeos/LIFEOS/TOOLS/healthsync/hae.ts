/**
 * Health Auto Export (HAE) v2 envelope normalizer — Mac side.
 * Schema: github.com/Lybron/health-auto-export/wiki/API-Export---JSON-Format
 * Envelope: { data: { metrics: [{ name, units, data: [entries] }], ... } }
 * Dates are "YYYY-MM-DD HH:MM:SS +0000" strings (no ISO "T").
 *
 * Pure and total: never throws on any input; malformed entries are skipped.
 */
import { dayKeyLA } from "./store";

type Json = Record<string, unknown>;

/** "2026-06-12 09:30:00 +0000" → epoch ms, or null. Total. */
export function parseHaeDate(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  // Normalize "YYYY-MM-DD HH:MM:SS +ZZZZ" to ISO-8601.
  const iso = value
    .trim()
    .replace(" ", "T")
    .replace(/ ([+-]\d{2}):?(\d{2})$/, "$1:$2");
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function toNum(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Convert a quantity to our canonical unit for the mapped key. */
function convert(key: string, qty: number, units: string): number {
  const u = units.toLowerCase();
  if (key === "active_energy_kcal" && (u === "kj" || u === "kilojoules")) {
    return qty / 4.184;
  }
  if (key === "weight_kg" && (u === "lb" || u === "lbs" || u === "pounds")) {
    return qty * 0.45359237;
  }
  if (key === "exercise_minutes" && (u === "hr" || u === "hours")) {
    return qty * 60;
  }
  return qty;
}

/** HAE metric name → our canonical key + how multiple same-day entries combine. */
const METRIC_MAP: Record<string, { key: string; combine: "sum" | "last" }> = {
  "Step Count": { key: "steps", combine: "sum" },
  "Active Energy": { key: "active_energy_kcal", combine: "sum" },
  "Apple Exercise Time": { key: "exercise_minutes", combine: "sum" },
  "Resting Heart Rate": { key: "resting_hr", combine: "last" },
  "Heart Rate Variability": { key: "hrv_ms", combine: "last" },
  "Weight & Body Mass": { key: "weight_kg", combine: "last" },
};

const SLEEP_HOUR_FIELDS: Array<[haeField: string, ourKey: string]> = [
  ["totalSleep", "sleep_hours"],
  ["asleep", "sleep_hours"],
  ["core", "sleep_core_h"],
  ["deep", "sleep_deep_h"],
  ["rem", "sleep_rem_h"],
  ["inBed", "sleep_inbed_h"],
];

export type HaeDay = { day: string; metrics: Json };

/**
 * Normalize one HAE envelope into per-LA-day metric records.
 * Unknown metrics are ignored; sleep rows fill sleep_* keys (first field wins
 * for sleep_hours: totalSleep beats asleep when both exist).
 */
export function normalizeHae(envelope: unknown): HaeDay[] {
  if (!isObject(envelope)) {
    return [];
  }
  const data = envelope.data;
  if (!isObject(data) || !Array.isArray(data.metrics)) {
    return [];
  }

  const days = new Map<string, Json>();
  const dayOf = (entry: Json): string | null => {
    const ms = parseHaeDate(entry.date);
    return ms === null ? null : dayKeyLA(ms);
  };
  const bucket = (day: string): Json => {
    let b = days.get(day);
    if (b === undefined) {
      b = {};
      days.set(day, b);
    }
    return b;
  };

  for (const metric of data.metrics) {
    if (!isObject(metric) || typeof metric.name !== "string" || !Array.isArray(metric.data)) {
      continue;
    }
    const units = typeof metric.units === "string" ? metric.units : "";
    const mapped = METRIC_MAP[metric.name];
    const isSleep = metric.name === "Sleep Analysis";
    if (mapped === undefined && !isSleep) {
      continue;
    }

    for (const entry of metric.data) {
      if (!isObject(entry)) {
        continue;
      }
      const day = dayOf(entry);
      if (day === null) {
        continue;
      }
      const b = bucket(day);

      if (isSleep) {
        for (const [field, ourKey] of SLEEP_HOUR_FIELDS) {
          const v = toNum(entry[field]);
          if (v === null) {
            continue;
          }
          if (ourKey === "sleep_hours" && typeof b.sleep_hours === "number") {
            continue; // totalSleep already set; don't overwrite with asleep
          }
          b[ourKey] = v;
        }
        continue;
      }

      const qty = toNum(entry.qty);
      if (qty === null || mapped === undefined) {
        continue;
      }
      const value = convert(mapped.key, qty, units);
      if (mapped.combine === "sum" && typeof b[mapped.key] === "number") {
        b[mapped.key] = (b[mapped.key] as number) + value;
      } else {
        b[mapped.key] = value;
      }
    }
  }

  return [...days.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, metrics]) => ({ day, metrics }));
}
