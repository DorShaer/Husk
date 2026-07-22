#!/usr/bin/env bun
/**
 * FetchConstruction — building permits and major construction signal.
 *
 * Universal sources:
 *  - US Census Building Permits Survey (monthly, MSA/place-level)
 *  - City open-data portal — best-effort URL discovery
 *  - Planning commission agendas via Granicus/Legistar discovery
 *
 * v1: stubbed — returns source_status="unavailable" with a TODO marker.
 * Implement against the Census BPS API first; that path is the most uniform
 * across the country and yields the best baseline signal.
 */

import type { FetchResult, Hometown } from "./Types.ts"
import { unavailable } from "./Types.ts"

export async function fetchConstruction(home: Hometown): Promise<FetchResult> {
  return unavailable(
    `construction fetcher not yet implemented — TODO: Census BPS for ${home.city}, ${home.state}`
  )
}

if (import.meta.main) {
  const { readHometown } = await import("./Hometown.ts")
  const home = await readHometown()
  console.log(JSON.stringify(await fetchConstruction(home), null, 2))
}
