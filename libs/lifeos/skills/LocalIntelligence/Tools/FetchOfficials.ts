#!/usr/bin/env bun
/**
 * FetchOfficials — movements and news for elected/appointed officials.
 *
 * Universal sources:
 *  - Ballotpedia API (officeholders + recent coverage)
 *  - Google News topic search per official
 *  - City press releases (RSS where present)
 */

import type { FetchResult, Hometown } from "./Types.ts"
import { unavailable } from "./Types.ts"

export async function fetchOfficials(home: Hometown): Promise<FetchResult> {
  return unavailable(
    `officials fetcher not yet implemented — TODO: Ballotpedia API for ${home.city}, ${home.state}`
  )
}

if (import.meta.main) {
  const { readHometown } = await import("./Hometown.ts")
  const home = await readHometown()
  console.log(JSON.stringify(await fetchOfficials(home), null, 2))
}
