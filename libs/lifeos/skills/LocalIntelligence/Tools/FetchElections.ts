#!/usr/bin/env bun
/**
 * FetchElections — upcoming elections, ballot measures, candidate fields.
 *
 * Universal sources:
 *  - Ballotpedia API
 *  - Vote.gov state-by-state registration links
 *  - County registrar of voters (best-effort URL discovery)
 */

import type { FetchResult, Hometown } from "./Types.ts"
import { unavailable } from "./Types.ts"

export async function fetchElections(home: Hometown): Promise<FetchResult> {
  return unavailable(
    `elections fetcher not yet implemented — TODO: Ballotpedia API for ${home.city}, ${home.state}`
  )
}

if (import.meta.main) {
  const { readHometown } = await import("./Hometown.ts")
  const home = await readHometown()
  console.log(JSON.stringify(await fetchElections(home), null, 2))
}
