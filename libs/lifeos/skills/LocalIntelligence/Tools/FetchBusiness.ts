#!/usr/bin/env bun
/**
 * FetchBusiness — new business openings, closures, license events.
 *
 * Universal sources:
 *  - City open-data business-license dataset (best-effort URL discovery)
 *  - County clerk DBA / fictitious business name filings
 *  - Local Chamber of Commerce member announcements (RSS where present)
 */

import type { FetchResult, Hometown } from "./Types.ts"
import { unavailable } from "./Types.ts"

export async function fetchBusiness(home: Hometown): Promise<FetchResult> {
  return unavailable(
    `business fetcher not yet implemented — TODO: city open-data discovery for ${home.city}, ${home.state}`
  )
}

if (import.meta.main) {
  const { readHometown } = await import("./Hometown.ts")
  const home = await readHometown()
  console.log(JSON.stringify(await fetchBusiness(home), null, 2))
}
